// memory-engine-data.js — 记忆引擎按聊天隔离的状态与存档点
window.MEMORY_ENGINE_DATA = (function() {
  const STATE_PREFIX = 'memory_engine_state_';
  const CHECKPOINT_PREFIX = 'memory_engine_checkpoint_';
  const LINK_CHECKPOINT_PREFIX = 'memory_engine_link_checkpoint_';
  const VERSION = '2.0.0';
  const TIMELINE_VERSION = 1;
  const ENTITY_TYPES = ['organization', 'object', 'ability', 'location'];

  function getChatId() {
    return window.WORLD_ENGINE_CORE?.getChatId?.() || 'default';
  }

  function key(prefix) { return prefix + getChatId(); }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  const clean = value => String(value == null ? '' : value).trim();
  const normalized = value => clean(value).toLocaleLowerCase();
  const unique = values => Array.from(new Set((Array.isArray(values) ? values : [values]).map(clean).filter(Boolean)));
  function parse(raw, fallback) {
    if (!raw) return clone(fallback);
    try { return JSON.parse(raw); } catch (error) { return clone(fallback); }
  }

  function emptyEntityMemory() {
    return { organization: [], object: [], ability: [], location: [] };
  }

  function memoryBaseFrom(state) {
    return {
      personal_memory: clone(state?.personal_memory || []),
      knowledge_index: clone(state?.knowledge_index || {}),
      entity_memory: clone(state?.entity_memory || emptyEntityMemory()),
      entity_index: clone(state?.entity_index || {}),
      ongoing_facts: clone(state?.ongoing_facts || []),
      character_arcs: clone(state?.character_arcs || []),
      round: Math.max(0, parseInt(state?.round) || 0),
      chatLayer: state?.chatLayer !== null && Number.isFinite(Number(state?.chatLayer)) ? Number(state.chatLayer) : null
    };
  }

  function newTimeline(state, options) {
    const sourceChatId = clean(options?.originChatId || getChatId()) || 'default';
    return {
      version: TIMELINE_VERSION,
      originChatId: sourceChatId,
      root: {
        id: `root:${sourceChatId}`,
        originChatId: sourceChatId,
        createdAt: Date.now(),
        base: memoryBaseFrom(state)
      },
      nodes: [],
      migratedFromLegacy: options?.migratedFromLegacy === true
    };
  }

  function defaultState() {
    return {
      personal_memory: [],
      knowledge_index: {},
      entity_memory: emptyEntityMemory(),
      entity_index: {},
      ongoing_facts: [],
      character_arcs: [],
      event_memory: {
        small_summaries: [],
        big_summaries: [],
        small_summary_layer: null,
        big_summary_cursor: 0
      },
      round: 0,
      chatLayer: null,
      timeline: null
    };
  }
  function normalizeOngoingFacts(items) {
    return (Array.isArray(items) ? items : []).map((item, index) => {
      const status = ['active', 'resolved', 'superseded'].includes(item?.status) ? item.status : 'active';
      const fact = clean(item?.fact || item?.content);
      if (!fact) return null;
      return {
        id: clean(item?.id) || `fact_${String(index + 1).padStart(6, '0')}`,
        category: clean(item?.category) || '状态',
        subject: clean(item?.subject) || '全局',
        fact,
        keywords: unique(item?.keywords),
        status,
        startLayer: Number.isFinite(Number(item?.startLayer)) ? Number(item.startLayer) : 0,
        updatedLayer: Number.isFinite(Number(item?.updatedLayer)) ? Number(item.updatedLayer) : 0,
        ...(clean(item?.source) ? { source: clean(item.source) } : {}),
        ...(clean(item?.worldCommitId) ? { worldCommitId: clean(item.worldCommitId) } : {}),
        sourceRefs: Array.isArray(item?.sourceRefs) ? clone(item.sourceRefs) : [],
        originChatId: clean(item?.originChatId)
      };
    }).filter(Boolean);
  }
  function normalizeCharacterArcs(items) {
    return (Array.isArray(items) ? items : []).map((item, index) => {
      const names = unique(item?.names || item?.name);
      const characterId = clean(item?.characterId || item?.id);
      if (!names.length && !characterId) return null;
      const pctRaw = Number(item?.progressPct ?? item?.progress_pct);
      const progressPct = Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, Math.round(pctRaw))) : 0;
      return {
        id: clean(item?.id) || `arc_${String(index + 1).padStart(6, '0')}`,
        characterId,
        names,
        currentStance: clean(item?.currentStance),
        arcSummary: clean(item?.arcSummary),
        relationship: clean(item?.relationship),
        progressPct,
        updatedLayer: Number.isFinite(Number(item?.updatedLayer)) ? Number(item.updatedLayer) : 0,
        originChatId: clean(item?.originChatId)
      };
    }).filter(Boolean);
  }
  function normalizeState(state) {
    const next = state && typeof state === 'object' && !Array.isArray(state) ? clone(state) : defaultState();
    if (!Array.isArray(next.personal_memory)) next.personal_memory = [];
    if (!next.knowledge_index || typeof next.knowledge_index !== 'object' || Array.isArray(next.knowledge_index)) next.knowledge_index = {};
    // 兼容开发期曾使用的 world_memory/item 结构；对外稳定结构只保留 entity_memory/object。
    if (!next.entity_memory || typeof next.entity_memory !== 'object' || Array.isArray(next.entity_memory)) {
      const legacy = next.world_memory && typeof next.world_memory === 'object' && !Array.isArray(next.world_memory)
        ? next.world_memory : {};
      next.entity_memory = {
        organization: legacy.organization,
        object: legacy.object || legacy.item,
        ability: legacy.ability,
        location: legacy.location
      };
    }
    if (!Array.isArray(next.entity_memory.object) && Array.isArray(next.entity_memory.item)) {
      next.entity_memory.object = next.entity_memory.item;
    }
    delete next.entity_memory.item;
    for (const type of ENTITY_TYPES) {
      if (!Array.isArray(next.entity_memory[type])) next.entity_memory[type] = [];
      next.entity_memory[type] = next.entity_memory[type].map(entity => {
        const item = entity && typeof entity === 'object' && !Array.isArray(entity) ? entity : {};
        const name = clean(item.name);
        item.aliases = unique(item.aliases).filter(alias => normalized(alias) !== normalized(name));
        return item;
      });
    }
    delete next.world_memory;
    next.entity_index = {};
    for (const type of ENTITY_TYPES) {
      for (const entity of next.entity_memory[type]) {
        if (!clean(entity?.id)) continue;
        for (const name of unique([entity.name, ...(entity.aliases || [])])) {
          next.entity_index[`${type}:${normalized(name)}`] = entity.id;
        }
      }
    }
    next.ongoing_facts = normalizeOngoingFacts(next.ongoing_facts);
    next.character_arcs = normalizeCharacterArcs(next.character_arcs);
    if (!next.event_memory || typeof next.event_memory !== 'object' || Array.isArray(next.event_memory)) next.event_memory = {};
    if (!Array.isArray(next.event_memory.small_summaries)) next.event_memory.small_summaries = [];
    next.event_memory.small_summaries = next.event_memory.small_summaries.map((item, index) => {
      const normalizedItem = {
        id: String(item?.id || `small_${String(index + 1).padStart(6, '0')}`),
        startLayer: Number.isFinite(Number(item?.startLayer)) ? Number(item.startLayer) : 0,
        endLayer: Number.isFinite(Number(item?.endLayer)) ? Number(item.endLayer) : 0,
        content: String(item?.content || '').trim(),
        keywords: unique(item?.keywords),
        entityNames: unique(item?.entityNames),
        impactLevel: item?.impactLevel === 'key' ? 'key' : 'normal',
        ...(clean(item?.outlineChapterTitle) ? { outlineChapterTitle: clean(item.outlineChapterTitle) } : {}),
        sourceRefs: Array.isArray(item?.sourceRefs) ? clone(item.sourceRefs) : [],
        sourceDigest: clean(item?.sourceDigest),
        originChatId: clean(item?.originChatId),
        status: ['valid', 'stale', 'pending', 'failed'].includes(item?.status) ? item.status : 'valid',
        revision: Math.max(1, parseInt(item?.revision) || 1)
      };
      // 联动来源只用于同楼层重 roll 识别；普通纪要不携带这些字段。
      if (item?.source === 'world_engine') normalizedItem.source = 'world_engine';
      if (item?.sourceKey) normalizedItem.sourceKey = String(item.sourceKey);
      if (item?.worldCommitId) normalizedItem.worldCommitId = clean(item.worldCommitId);
      return normalizedItem;
    }).filter(item => item.content);
    // 0.4.x 只有一条滚动 big_summary；升级后迁移成可追加的 big_summaries。
    const legacyBig = next.event_memory.big_summary;
    const bigSource = Array.isArray(next.event_memory.big_summaries)
      ? next.event_memory.big_summaries
      : (legacyBig && typeof legacyBig === 'object' ? [legacyBig] : []);
    next.event_memory.big_summaries = bigSource.map((item, index) => ({
      id: String(item?.id || `big_${String(index + 1).padStart(6, '0')}`),
      startLayer: Number.isFinite(Number(item?.startLayer)) ? Number(item.startLayer) : 0,
      endLayer: Number.isFinite(Number(item?.endLayer)) ? Number(item.endLayer) : 0,
      content: String(item?.content || '').trim(),
      keywords: unique(item?.keywords),
      childIds: Array.isArray(item?.childIds) ? item.childIds.map(String) : [],
      childDigest: clean(item?.childDigest),
      sourceRefs: Array.isArray(item?.sourceRefs) ? clone(item.sourceRefs) : [],
      originChatId: clean(item?.originChatId),
      status: ['valid', 'stale', 'pending', 'failed'].includes(item?.status) ? item.status : 'valid',
      revision: Math.max(1, parseInt(item?.revision) || 1)
    })).filter(item => item.content);
    delete next.event_memory.big_summary;
    next.event_memory.small_summary_layer = next.event_memory.small_summary_layer !== null
      && next.event_memory.small_summary_layer !== ''
      && Number.isFinite(Number(next.event_memory.small_summary_layer))
      ? Number(next.event_memory.small_summary_layer) : null;
    next.event_memory.big_summary_cursor = Math.min(
      next.event_memory.small_summaries.length,
      Math.max(0, parseInt(next.event_memory.big_summary_cursor) || 0)
    );
    next.round = Math.max(0, parseInt(next.round) || 0);
    next.chatLayer = next.chatLayer !== null && next.chatLayer !== '' && Number.isFinite(Number(next.chatLayer))
      ? Number(next.chatLayer) : null;
    if (!next.timeline || typeof next.timeline !== 'object' || Array.isArray(next.timeline)) {
      // 旧数据没有事件链：把当时的完整最终状态封存为 Root，后续更新才进入节点链。
      next.timeline = newTimeline(next, { migratedFromLegacy: true });
    } else {
      const timeline = next.timeline;
      const originChatId = clean(timeline.originChatId || timeline.root?.originChatId || getChatId()) || 'default';
      const rootBase = timeline.root?.base && typeof timeline.root.base === 'object'
        ? memoryBaseFrom(timeline.root.base) : memoryBaseFrom(next);
      next.timeline = {
        version: TIMELINE_VERSION,
        originChatId,
        root: {
          id: clean(timeline.root?.id) || `root:${originChatId}`,
          originChatId: clean(timeline.root?.originChatId || originChatId),
          createdAt: Number(timeline.root?.createdAt) || Date.now(),
          base: rootBase
        },
        nodes: (Array.isArray(timeline.nodes) ? timeline.nodes : []).map((node, index) => ({
          id: clean(node?.id) || `memory_${String(index + 1).padStart(6, '0')}`,
          kind: clean(node?.kind) || 'memory',
          ...(node?.source === 'world_engine' ? { source: 'world_engine' } : {}),
          ...(clean(node?.sourceKey) ? { sourceKey: clean(node.sourceKey) } : {}),
          ...(clean(node?.worldCommitId) ? { worldCommitId: clean(node.worldCommitId) } : {}),
          originChatId: clean(node?.originChatId || originChatId),
          startLayer: Number.isFinite(Number(node?.startLayer)) ? Number(node.startLayer) : 0,
          endLayer: Number.isFinite(Number(node?.endLayer)) ? Number(node.endLayer) : 0,
          sourceRefs: Array.isArray(node?.sourceRefs) ? clone(node.sourceRefs) : [],
          sourceDigest: clean(node?.sourceDigest),
          personal: Array.isArray(node?.personal) ? clone(node.personal) : [],
          entities: node?.entities && typeof node.entities === 'object' ? clone(node.entities) : emptyEntityMemory(),
          factUpdates: Array.isArray(node?.factUpdates) ? clone(node.factUpdates) : [],
          arcUpdates: Array.isArray(node?.arcUpdates) ? clone(node.arcUpdates) : [],
          snapshot: node?.snapshot && typeof node.snapshot === 'object' ? memoryBaseFrom(node.snapshot) : null,
          status: ['valid', 'stale', 'pending', 'failed'].includes(node?.status) ? node.status : 'valid',
          revision: Math.max(1, parseInt(node?.revision) || 1),
          createdAt: Number(node?.createdAt) || Date.now(),
          updatedAt: Number(node?.updatedAt) || Number(node?.createdAt) || Date.now()
        })),
        migratedFromLegacy: timeline.migratedFromLegacy === true
      };
    }
    return next;
  }
  function hasState() { return window.WORLD_ENGINE_STORE?.getItem(key(STATE_PREFIX)) !== null; }
  function loadState() { return normalizeState(parse(window.WORLD_ENGINE_STORE?.getItem(key(STATE_PREFIX)), defaultState())); }
  function saveState(state) {
    const next = normalizeState(state);
    window.WORLD_ENGINE_STORE?.setItem(key(STATE_PREFIX), JSON.stringify(next));
    return clone(next);
  }

  function loadCheckpoint() {
    const checkpoint = parse(window.WORLD_ENGINE_STORE?.getItem(key(CHECKPOINT_PREFIX)), null);
    return checkpoint ? normalizeState(checkpoint) : null;
  }
  function saveCheckpoint(state) {
    const next = state === undefined ? loadState() : state;
    window.WORLD_ENGINE_STORE?.setItem(key(CHECKPOINT_PREFIX), JSON.stringify(clone(next)));
    return clone(next);
  }
  function clearCheckpoint() { window.WORLD_ENGINE_STORE?.removeItem(key(CHECKPOINT_PREFIX)); }

  // 与普通“重新提取”checkpoint 分离：这里只保存当前世界联动楼层第一次写入前的记忆基底。
  function loadLinkCheckpoint() {
    const value = parse(window.WORLD_ENGINE_STORE?.getItem(key(LINK_CHECKPOINT_PREFIX)), null);
    if (!value || typeof value !== 'object' || !value.baseState) return null;
    return {
      layer: Number.isFinite(Number(value.layer)) ? Number(value.layer) : null,
      rolledBack: value.rolledBack === true,
      baseState: normalizeState(value.baseState)
    };
  }
  function saveLinkCheckpoint(value) {
    if (!value || !value.baseState) return null;
    const next = {
      layer: Number(value.layer),
      rolledBack: value.rolledBack === true,
      baseState: normalizeState(value.baseState)
    };
    window.WORLD_ENGINE_STORE?.setItem(key(LINK_CHECKPOINT_PREFIX), JSON.stringify(next));
    return clone(next);
  }
  function clearLinkCheckpoint() { window.WORLD_ENGINE_STORE?.removeItem(key(LINK_CHECKPOINT_PREFIX)); }

  function recordMatches(record, ownerId, time, memory) {
    return record?.ownerId === ownerId && clean(record?.time) === clean(time) && clean(record?.memory) === clean(memory);
  }
  function portableState(state) {
    const current = normalizeState(state);
    const people = current.personal_memory || [];
    return {
      personal_memory: people.map(person => ({
        id: person.id,
        names: clone(person.names || []),
        memories: Object.entries(person.memory || {}).flatMap(([time, memories]) =>
          (Array.isArray(memories) ? memories : []).map(memory => ({
            time,
            memory,
            known_by: people.filter(knower => knower.id !== person.id && (knower.names || []).some(name =>
              (current.knowledge_index?.[normalized(name)] || []).some(record => recordMatches(record, person.id, time, memory))
            )).map(knower => knower.names?.[0] || knower.id)
          }))
        )
      })),
      entity_memory: clone(current.entity_memory),
      ongoing_facts: clone(current.ongoing_facts || []),
      character_arcs: clone(current.character_arcs || []),
      timeline: clone(current.timeline),
      event_memory: clone(current.event_memory),
      round: current.round,
      chatLayer: current.chatLayer
    };
  }
  function portableCounts(state) {
    if (!state) return null;
    return {
      people: state.personal_memory?.length || 0,
      entities: ENTITY_TYPES.reduce((sum, type) => sum + (state.entity_memory?.[type]?.length || 0), 0),
      facts: (state.ongoing_facts || []).filter(item => item.status !== 'resolved').length,
      arcs: state.character_arcs?.length || 0,
      minutes: state.event_memory?.small_summaries?.length || 0,
      overviews: state.event_memory?.big_summaries?.length || 0
    };
  }
  function exportMemoryPackage() {
    const portable = portableState(loadState());
    const validSmall = (portable.event_memory?.small_summaries || []).filter(item => item.status !== 'stale' && item.status !== 'failed');
    const validBig = (portable.event_memory?.big_summaries || []).filter(item => item.status !== 'stale' && item.status !== 'failed');
    const smallIdMap = new Map();
    const cleanSmall = validSmall.map((item, idx) => {
      const nextId = `small_${String(idx + 1).padStart(6, '0')}`;
      smallIdMap.set(item.id, nextId);
      return {
        id: nextId,
        startLayer: 0,
        endLayer: 0,
        content: item.content,
        keywords: unique(item.keywords),
        entityNames: unique(item.entityNames),
        impactLevel: item.impactLevel === 'key' ? 'key' : 'normal',
        ...(clean(item.outlineChapterTitle) ? { outlineChapterTitle: clean(item.outlineChapterTitle) } : {}),
        status: 'valid',
        revision: 1
      };
    });
    const cleanBig = validBig.map((item, idx) => ({
      id: `big_${String(idx + 1).padStart(6, '0')}`,
      startLayer: 0,
      endLayer: 0,
      content: item.content,
      keywords: unique(item.keywords),
      childIds: (item.childIds || []).map(id => smallIdMap.get(id)).filter(Boolean),
      status: 'valid',
      revision: 1
    }));
    const pkg = {
      personal_memory: portable.personal_memory,
      entity_memory: portable.entity_memory,
      ongoing_facts: (portable.ongoing_facts || []).map(({ sourceRefs, originChatId, worldCommitId, ...rest }) => rest),
      character_arcs: (portable.character_arcs || []).map(({ originChatId, ...rest }) => rest),
      event_memory: {
        small_summaries: cleanSmall,
        big_summaries: cleanBig,
        big_summary_cursor: Math.min(cleanSmall.length, cleanBig.reduce((acc, item) => acc + item.childIds.length, 0))
      }
    };
    return {
      __memoryEnginePackage: true,
      format: 'memory-summary-package',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      chatId: getChatId(),
      counts: portableCounts(pkg),
      package: pkg
    };
  }
  function importMemoryPackage(payload, options) {
    if (options?.isBusy?.() === true) throw new Error('记忆任务正在运行中，无法导入记忆包');
    const targetChatId = clean(options?.expectedChatId);
    if (targetChatId && targetChatId !== clean(getChatId())) {
      throw new Error('导入前聊天身份已切换，已取消写入以防串台');
    }
    if (!payload || typeof payload !== 'object' || payload.__memoryEnginePackage !== true || payload.format !== 'memory-summary-package' || !payload.package || typeof payload.package !== 'object') {
      throw new Error('总结记忆包格式校验失败：仅接受标准 memory-summary-package JSON');
    }
    const pkg = payload.package;
    if (!Array.isArray(pkg.personal_memory) && (!pkg.entity_memory || typeof pkg.entity_memory !== 'object') && (!pkg.event_memory || typeof pkg.event_memory !== 'object')) {
      throw new Error('总结记忆包缺少有效的剧情记忆内容');
    }
    const internalized = internalizePortableState(pkg);
    const rebased = rebaseImportedState({
      ...defaultState(),
      personal_memory: internalized.personal_memory || [],
      knowledge_index: internalized.knowledge_index || {},
      entity_memory: internalized.entity_memory || emptyEntityMemory(),
      ongoing_facts: Array.isArray(pkg.ongoing_facts) ? pkg.ongoing_facts : [],
      character_arcs: Array.isArray(pkg.character_arcs) ? pkg.character_arcs : [],
      event_memory: pkg.event_memory || defaultState().event_memory
    });
    rebased.event_memory.small_summaries = (rebased.event_memory.small_summaries || []).map(item => ({
      ...item,
      sourceRefs: [],
      sourceDigest: '',
      originChatId: getChatId(),
      status: 'valid'
    }));
    const smallMap = new Map(rebased.event_memory.small_summaries.map(item => [item.id, item]));
    const hashFn = window.MEMORY_ENGINE_TIMELINE?.hashText;
    rebased.event_memory.big_summaries = (rebased.event_memory.big_summaries || []).map(item => {
      const children = (item.childIds || []).map(id => smallMap.get(id)).filter(Boolean);
      const validIds = children.length === (item.childIds || []).length ? children.map(c => c.id) : [];
      const childDigest = validIds.length && typeof hashFn === 'function'
        ? hashFn(children.map(c => `${c.id}:${c.revision || 1}:${c.sourceDigest || ''}`).join('|'))
        : '';
      return {
        ...item,
        childIds: validIds,
        childDigest,
        sourceRefs: [],
        originChatId: getChatId(),
        status: 'valid'
      };
    });
    const covered = new Set((rebased.event_memory.big_summaries || []).flatMap(item => item.childIds || []));
    let cursor = 0;
    while (cursor < rebased.event_memory.small_summaries.length && covered.has(rebased.event_memory.small_summaries[cursor].id)) cursor++;
    rebased.event_memory.big_summary_cursor = cursor;
    rebased.ongoing_facts = (rebased.ongoing_facts || []).map(item => ({
      ...item,
      startLayer: rebased.chatLayer,
      updatedLayer: rebased.chatLayer,
      sourceRefs: [],
      originChatId: getChatId()
    }));
    rebased.character_arcs = (rebased.character_arcs || []).map(arc => ({
      ...arc,
      updatedLayer: rebased.chatLayer,
      originChatId: getChatId()
    }));
    rebased.timeline = newTimeline(rebased, { originChatId: getChatId(), migratedFromLegacy: false });
    clearCheckpoint();
    clearLinkCheckpoint();
    return saveState(rebased);
  }
  function exportData() {
    const state = portableState(loadState());
    const rawCheckpoint = loadCheckpoint();
    const checkpoint = rawCheckpoint ? portableState(rawCheckpoint) : null;
    return {
      __memoryEngineData: true,
      format: 'portable-full-backup',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      chatId: getChatId(),
      counts: {
        state: portableCounts(state),
        checkpoint: portableCounts(checkpoint)
      },
      state,
      checkpoint
    };
  }
  function currentChatLayer() {
    const fromCore = window.WORLD_ENGINE_CORE?.getChatLayer?.();
    if (Number.isFinite(Number(fromCore))) return Math.max(0, Number(fromCore));
    try { return Math.max(0, (SillyTavern.getContext()?.chat || []).length - 1); }
    catch (_) { return 0; }
  }
  function rebaseImportedState(state) {
    const next = normalizeState(state);
    const layer = currentChatLayer();
    // 导入是把既有记忆接到当前聊天；楼层游标必须从当前聊天重新起步。
    next.chatLayer = layer;
    next.event_memory.small_summary_layer = layer;
    // 跨聊天导入时，把来源于旧聊天的可重放链压成目标聊天的 Root。
    // 这样新聊天只处理之后的新楼层，不会把相同数字楼层误认为旧节点来源。
    next.timeline = newTimeline(next, { originChatId: getChatId(), migratedFromLegacy: false });
    return next;
  }
  function rebaseToCurrentChat(state) { return rebaseImportedState(state); }
  function nextImportedCharacterId(people) {
    const max = (people || []).reduce((number, person) => {
      const match = /^char_(\d+)$/.exec(clean(person?.id));
      return Math.max(number, match ? Number(match[1]) : 0);
    }, 0);
    return `char_${String(max + 1).padStart(6, '0')}`;
  }
  function internalizePortableState(input) {
    const raw = clone(input);
    const source = Array.isArray(raw?.personal_memory) ? raw.personal_memory : [];
    if (!source.some(person => Array.isArray(person?.memories))) return raw;
    const people = source.map(person => ({
      id: clean(person?.id),
      names: unique(person?.names),
      memory: Array.isArray(person?.memories) ? {} : clone(person?.memory || {})
    }));
    for (const person of people) if (!person.id) person.id = nextImportedCharacterId(people);
    const index = {};
    const addIndex = (names, record) => {
      for (const name of unique(names)) {
        const keyName = normalized(name);
        if (!Array.isArray(index[keyName])) index[keyName] = [];
        if (!index[keyName].some(old => recordMatches(old, record.ownerId, record.time, record.memory))) index[keyName].push(clone(record));
      }
    };
    const findOrCreateKnower = name => {
      const wanted = normalized(name);
      let person = people.find(candidate => (candidate.names || []).some(alias => normalized(alias) === wanted));
      if (!person) {
        person = { id: nextImportedCharacterId(people), names: [clean(name)], memory: {} };
        people.push(person);
      }
      return person;
    };
    source.forEach((sourcePerson, personIndex) => {
      const owner = people[personIndex];
      const records = Array.isArray(sourcePerson?.memories) ? sourcePerson.memories : [];
      for (const item of records) {
        const time = clean(item?.time), memory = clean(item?.memory ?? item?.content);
        if (!memory) continue;
        if (!Array.isArray(owner.memory[time])) owner.memory[time] = [];
        if (!owner.memory[time].includes(memory)) owner.memory[time].push(memory);
        const record = { ownerId: owner.id, time, memory };
        addIndex(owner.names, record);
        for (const knowerName of unique(item?.known_by)) addIndex(findOrCreateKnower(knowerName).names, record);
      }
    });
    raw.personal_memory = people;
    raw.knowledge_index = index;
    return raw;
  }
  function importData(payload) {
    const selected = payload?.__memoryEngineData ? (payload.state || payload.current_state || payload.data || payload) : (payload?.state || payload);
    const state = internalizePortableState(selected);
    const hasPersonal = Array.isArray(state?.personal_memory);
    const hasWorld = (state?.entity_memory && typeof state.entity_memory === 'object' && !Array.isArray(state.entity_memory))
      || (state?.world_memory && typeof state.world_memory === 'object' && !Array.isArray(state.world_memory));
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || (!hasPersonal && !hasWorld)) {
      throw new Error('缺少合法的记忆数据');
    }
    const sourceChatId = clean(payload?.chatId || state?.timeline?.originChatId);
    const sameChat = sourceChatId && sourceChatId === clean(getChatId());
    const prepare = value => sameChat ? normalizeState(value) : rebaseImportedState(value);
    saveState(prepare(state));
    if (payload?.format === 'portable-current-state') {
      clearCheckpoint();
    } else if (payload?.__memoryEngineData || Object.prototype.hasOwnProperty.call(payload || {}, 'checkpoint')) {
      if (payload.checkpoint) saveCheckpoint(prepare(internalizePortableState(payload.checkpoint))); else clearCheckpoint();
    }
    return loadState();
  }

  return {
    VERSION, getChatId, defaultState, hasState, loadState, saveState,
    loadCheckpoint, saveCheckpoint, clearCheckpoint,
    loadLinkCheckpoint, saveLinkCheckpoint, clearLinkCheckpoint,
    exportData, importData, exportMemoryPackage, importMemoryPackage, rebaseToCurrentChat
  };
})();
