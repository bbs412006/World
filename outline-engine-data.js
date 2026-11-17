// v2 独立命名空间：作者计划不与自动进度、后台事实互相覆盖。
window.OUTLINE_ENGINE_DATA = (function() {
  const SCHEMA_VERSION = 2, STATE_PREFIX = 'outline_engine_v2_state_', LEGACY_STATE_PREFIX = 'outline_engine_state_';
  const STATUSES = Object.freeze(['pending', 'active', 'completed', 'skipped', 'blocked']);
  const AUTOMATIC_FIELDS = Object.freeze(['currentChapterId', 'progressEvents', 'proposals', 'tracking', 'scheduler', 'privateFacts', 'clues', 'contacts', 'knowledge', 'recovery']);
  const clean = value => String(value == null ? '' : value).trim();
  const text = value => Array.isArray(value) ? value.map(clean).filter(Boolean).join('\n') : clean(value);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const list = value => (Array.isArray(value) ? value : []).filter(object);
  const names = value => [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))];
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const integer = value => Math.max(0, parseInt(value, 10) || 0);
  const strings = (value, keys) => Object.fromEntries(keys.map(key => [key, clean(value?.[key])]));
  const primitive = value => value == null || ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
  function digest(value) { let n = 2166136261; for (const c of String(value)) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0; return n.toString(16); }
  function getChatId() {
    const id = window.WORLD_ENGINE_CORE?.getChatId?.(); if (id) return clean(id);
    try { return clean(SillyTavern.getContext()?.chatId) || 'default'; } catch (_) { return 'default'; }
  }
  function normalizeCondition(value, depth = 0) {
    if (value == null || value === '') return null;
    if (depth > 12) return { type: 'unconfigured', text: '条件嵌套超过上限' };
    if (typeof value === 'boolean') return { type: 'literal', value };
    if (typeof value === 'string') return { type: 'unconfigured', text: value.trim() };
    if (!object(value)) return { type: 'unconfigured', text: '不支持的条件' };
    if (Array.isArray(value.all)) return { all: value.all.map(item => normalizeCondition(item, depth + 1)) };
    if (Array.isArray(value.any)) return { any: value.any.map(item => normalizeCondition(item, depth + 1)) };
    switch (value.type) {
      case 'literal': return { type: 'literal', value: value.value === true };
      case 'nodeStatus': return { type: 'nodeStatus', nodeId: clean(value.nodeId), status: STATUSES.includes(value.status) ? value.status : 'completed', allowSkipped: value.allowSkipped === true };
      case 'chapter': return { type: 'chapter', chapterIds: names(value.chapterIds), fromChapterId: clean(value.fromChapterId), toChapterId: clean(value.toChapterId) };
      case 'worldField': return { type: 'worldField', ...strings(value, ['collection', 'entityId', 'field', 'op']), value: primitive(value.value) };
      case 'clueContact': return { type: 'clueContact', clueId: clean(value.clueId), actorId: clean(value.actorId) };
      case 'time': {
        if (value.basis === 'storyDay') return { type: 'time', basis: 'storyDay', op: clean(value.op), value: typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : null };
        if (value.basis && value.basis !== 'calendar') return { type: 'unconfigured', text: '不支持的时间基准' };
        return { type: 'time', ...(value.basis === 'calendar' ? { basis: 'calendar' } : {}), op: clean(value.op), value: clean(value.value) };
      }
      case 'authorFlag': return { type: 'authorFlag', flagId: clean(value.flagId), value: value.value !== false };
      default: return { type: 'unconfigured', text: text(value.text || value.condition || '待配置条件') };
    }
  }
  function normalizeEntityRefs(values) { return list(values).map(value => strings(value, ['source', 'originChatId', 'type', 'id', 'nameSnapshot'])); }
  function normalizeDependencies(values) {
    return (Array.isArray(values) ? values : []).map(value => typeof value === 'string' ? { nodeId: value } : value).filter(object)
      .map(value => ({ nodeId: clean(value.nodeId), allowSkipped: value.allowSkipped === true || value.acceptSkipped === true })).filter(value => value.nodeId);
  }
  function normalizedNode(value, defaults) {
    const s = object(value) ? value : {}, d = defaults || {};
    return { id: clean(s.id), trackId: clean(s.trackId || d.trackId), chapterIds: names(s.chapterIds || d.chapterIds), dependencies: normalizeDependencies(s.dependencies),
      title: text(s.title), intent: text(s.intent), completionCriteria: text(s.completionCriteria), notes: text(s.notes), required: s.required !== false,
      trigger: normalizeCondition(s.trigger), publicHint: text(s.publicHint), disclosure: { condition: normalizeCondition(s.disclosure?.condition ?? s.revealWhen ?? (d.hidden ? { type: 'unconfigured', text: '待配置揭露条件' } : null)), clueText: text(s.disclosure?.clueText) },
      entityRefs: normalizeEntityRefs(s.entityRefs), completionSource: ['dialogue', 'world', 'either'].includes(s.completionSource) ? s.completionSource : (d.hidden ? 'world' : 'dialogue'),
      actorKind: s.actorKind === 'npc' ? 'npc' : s.actorKind === 'player' ? 'player' : (d.hidden ? 'npc' : 'player'),
      visibility: s.visibility === 'private' || (s.visibility !== 'public' && d.hidden) ? 'private' : 'public' };
  }
  function normalizePlan(value) {
    const s = object(value) ? value : {}, used = new Set();
    const id = (candidate, prefix, seed) => { let result = clean(candidate); if (!result || used.has(result)) { const base = `${prefix}_${digest(seed)}`; result = base; let n = 1; while (used.has(result)) result = `${base}_${++n}`; } used.add(result); return result; };
    const chapters = list(s.chapters).map((chapter, i) => ({ id: id(chapter.id, 'chapter', `chapter:${i}:${chapter.title || ''}`), title: text(chapter.title), goal: text(chapter.goal), exitNodeIds: names(chapter.exitNodeIds) }));
    const legacy = !Array.isArray(s.nodes) && list(s.chapters).some(chapter => Array.isArray(chapter.nodes));
    const trackSources = list(s.tracks);
    if (legacy && !trackSources.length) {
      const reserved = new Set(list(s.chapters).flatMap(chapter => [clean(chapter.id), ...list(chapter.nodes).map(node => clean(node.id))]));
      let trackId = 'legacy-main', suffix = 1; while (reserved.has(trackId)) trackId = 'legacy-main-' + ++suffix;
      trackSources.push({ id: trackId, kind: 'main', title: s.title || '主线' });
    }
    if (!legacy && Array.isArray(s.nodes) && s.nodes.length && !trackSources.length) trackSources.push({ id: 'default-main', kind: 'main', title: '主线' });
    const tracks = trackSources.map((track, i) => ({ id: id(track.id, 'track', `track:${i}:${track.title || ''}`), kind: ['main', 'side', 'hidden'].includes(track.kind) ? track.kind : 'main',
      title: text(track.title), goal: text(track.goal), priority: Math.max(-100, Math.min(100, number(track.priority))), paused: track.paused === true }));
    const inputs = legacy ? list(s.chapters).flatMap((chapter, i) => list(chapter.nodes).map(node => ({ ...node, _chapterIndex: i }))) : list(s.nodes);
    const nodes = inputs.map((node, i) => {
      const track = tracks.find(item => item.id === node.trackId) || tracks[0];
      const result = normalizedNode({ ...node, id: id(node.id, 'node', `node:${i}:${node.title || ''}`) }, { trackId: track?.id, hidden: !legacy && track?.kind === 'hidden', chapterIds: legacy ? [chapters[node._chapterIndex]?.id].filter(Boolean) : [] });
      if (legacy && result.required && chapters[node._chapterIndex]) chapters[node._chapterIndex].exitNodeIds.push(result.id);
      return result;
    });
    return { title: text(s.title), synopsis: text(s.synopsis), constraints: text(s.constraints), publicSynopsis: text(s.publicSynopsis ?? (legacy ? s.synopsis : '')), publicConstraints: text(s.publicConstraints ?? (legacy ? s.constraints : '')), chapters, tracks, nodes };
  }
  function getChapterNodes(plan, id) { return (plan?.nodes || []).filter(node => node.chapterIds?.includes(id)); }
  function getTrackNodes(plan, id) { return (plan?.nodes || []).filter(node => node.trackId === id); }
  function getNode(state, id) { return state?.plan?.nodes?.find(node => node.id === id) || null; }
  function normalizedRefs(values) { return list(values).map(ref => ({ ...strings(ref, ['chatId', 'messageId', 'role', 'hash']), layer: number(ref.layer), swipeId: integer(ref.swipeId), ...(ref.synthetic === true ? { synthetic: true } : {}) })); }
  function normalizedEvidence(values) {
    return list(values).map(item => ({ ...strings(item, ['messageId', 'quote']), ...(item.kind ? { kind: ['world_fact', 'dialogue'].includes(item.kind) ? item.kind : 'dialogue' } : {}),
      ...(item.commitId != null ? { commitId: clean(item.commitId) } : {}), ...(item.factId != null ? { factId: clean(item.factId) } : {}), ...(item.hash != null ? { hash: clean(item.hash) } : {}), ...(item.layer != null ? { layer: number(item.layer) } : {}) }));
  }
  function normalizedRecord(s, proposal) {
    const result = { ...strings(s, ['id', 'nodeId', 'trackId']), status: clean(s.status || s.result), planRevision: integer(s.planRevision), sourceRefs: normalizedRefs(s.sourceRefs), sourceDigest: clean(s.sourceDigest), evidence: normalizedEvidence(s.evidence), createdAt: integer(s.createdAt) };
    for (const key of ['staleReason', 'invalidationReason', 'worldCommitId', 'turnId', 'commitId']) if (s[key] != null) result[key] = clean(s[key]);
    result.parentEventIds = names(s.parentEventIds || s.dependsOnEventIds);
    if (proposal) {
      Object.assign(result, strings(s, ['kind', 'chapterId', 'reason'])); result.status = ['pending', 'stale', 'accepted', 'dismissed', 'rejected'].includes(s.status) ? s.status : 'stale';
      if (s.kind === 'update_chapter') { const snap = value => object(value) ? strings(value, ['title', 'goal']) : null; result.before = snap(s.before); result.after = snap(s.after); }
      else { result.before = object(s.before) ? normalizedNode(s.before) : null; result.after = object(s.after) ? normalizedNode(s.after) : null; }
    } else { result.nodeRevision = clean(s.nodeRevision); result.validity = s.validity === 'valid' && s.stale !== true && s.valid !== false ? 'valid' : 'stale'; result.beforeChapterId = clean(s.beforeChapterId); result.layer = number(s.layer); if (s.independent != null) result.independent = s.independent === true; }
    return result;
  }
  const validity = s => s.validity === 'valid' ? 'valid' : 'stale';
  function normalizeFact(s) { return { ...strings(s, ['id', 'commitId', 'factHash', 'nodeId', 'trackId', 'text']), entityRefs: normalizeEntityRefs(s.entityRefs), visibility: 'private', knownBy: names(s.knownBy), validity: validity(s), parentEventIds: names(s.parentEventIds) }; }
  function normalizeClue(s) { return { ...strings(s, ['id', 'nodeId', 'trackId', 'publicHint', 'commitId']), factIds: names(s.factIds), available: s.available === true, availabilityCondition: normalizeCondition(s.availabilityCondition),
    status: ['available', 'contacted', 'known'].includes(s.status) ? s.status : 'available', sourceRefs: normalizedRefs(s.sourceRefs), contacts: names(s.contacts), knownBy: names(s.knownBy), validity: validity(s), parentEventIds: names(s.parentEventIds) }; }
  function normalizeContact(s) { return { ...strings(s, ['id', 'clueId', 'actorId', 'messageId', 'hash', 'quote', 'commitId']), sourceRefs: normalizedRefs(s.sourceRefs), createdAt: integer(s.createdAt), validity: validity(s), parentEventIds: names(s.parentEventIds) }; }
  function normalizeKnowledge(s) { return { ...strings(s, ['id', 'factId', 'actorId', 'contactId', 'commitId']), validity: validity(s), parentEventIds: names(s.parentEventIds) }; }
  function normalizeScheduler(value) {
    const s = object(value) ? value : {}, counts = input => Object.fromEntries(Object.entries(object(input) ? input : {}).filter(([key]) => !/api.?key|settings/i.test(key)).map(([key, n]) => [key, integer(n)]));
    return { tick: integer(s.tick), waiting: counts(s.waiting), lastServed: counts(s.lastServed), cooldowns: counts(s.cooldowns), lastSelected: { narrative: names(s.lastSelected?.narrative), world: names(s.lastSelected?.world) },
      explanations: list(s.explanations).map(item => ({ ...strings(item, ['nodeId', 'trackId', 'channel']), eligible: item.eligible == null ? null : item.eligible === true, selected: item.selected === true, reasons: names(item.reasons), score: number(item.score), waitTurns: integer(item.waitTurns) })) };
  }
  function defaultState(chatId) { return { schemaVersion: SCHEMA_VERSION, revision: 0, originChatId: clean(chatId || getChatId()), plan: normalizePlan({}), currentChapterId: '', progressEvents: [], manualOverrides: {}, authorFlags: {}, proposals: [],
    tracking: { anchorLayer: null, checkedLayer: null, roundsSinceCheck: 0, lastDigest: '' }, privateFacts: [], clues: [], contacts: [], knowledge: [], scheduler: normalizeScheduler(), recovery: { status: 'ready', boundary: '', reason: '', pendingFromLayer: null, pendingMessageIds: [] } }; }
  function normalizeState(value, chatId) {
    const s = object(value) ? value : {}; if (number(s.schemaVersion, 1) > 2) throw new Error('此大纲存档来自更新版本，当前版本不能读取');
    const next = defaultState(chatId); next.revision = integer(s.revision); next.originChatId = clean(s.originChatId || chatId || getChatId()); next.plan = normalizePlan(s.plan);
    next.currentChapterId = next.plan.chapters.some(chapter => chapter.id === s.currentChapterId) ? s.currentChapterId : (next.plan.chapters[0]?.id || '');
    next.progressEvents = list(s.progressEvents).map(item => normalizedRecord(item, false)); next.proposals = list(s.proposals).map(item => normalizedRecord(item, true));
    const ids = new Set(next.plan.nodes.map(node => node.id));
    for (const [id, item] of Object.entries(object(s.manualOverrides) ? s.manualOverrides : {})) { const status = typeof item === 'string' ? item : item?.status; if (ids.has(id) && STATUSES.includes(status)) next.manualOverrides[id] = { status, ...(object(item) && item.updatedAt != null ? { updatedAt: integer(item.updatedAt) } : {}), ...(object(item) && item.planRevision != null ? { planRevision: integer(item.planRevision) } : {}) }; }
    for (const [id, flag] of Object.entries(object(s.authorFlags) ? s.authorFlags : {})) if (typeof flag === 'boolean' && !/api.?key|settings/i.test(id)) next.authorFlags[id] = flag;
    const t = object(s.tracking) ? s.tracking : {};
    for (const key of ['anchorLayer', 'checkedLayer', 'recheckStartLayer']) if (t[key] != null && t[key] !== '') next.tracking[key] = number(t[key], null);
    next.tracking.roundsSinceCheck = integer(t.roundsSinceCheck); next.tracking.lastDigest = clean(t.lastDigest);
    for (const key of ['anchorMessageId', 'lastProcessedMessageKey']) if (t[key] != null) next.tracking[key] = clean(t[key]);
    if (Array.isArray(t.seenAssistantIds)) next.tracking.seenAssistantIds = names(t.seenAssistantIds); if (t.pendingRecheck != null) next.tracking.pendingRecheck = t.pendingRecheck === true;
    if (object(t.temporalNotice) && ['normal', 'flashback', 'dream', 'return_scene', 'contradiction', 'in_world_rewind'].includes(t.temporalNotice.kind)) next.tracking.temporalNotice = {
      kind: t.temporalNotice.kind, reason: clean(t.temporalNotice.reason), evidence: normalizedEvidence(t.temporalNotice.evidence)
    };
    next.privateFacts = list(s.privateFacts).map(normalizeFact); next.clues = list(s.clues).map(normalizeClue); next.contacts = list(s.contacts).map(normalizeContact); next.knowledge = list(s.knowledge).map(normalizeKnowledge); next.scheduler = normalizeScheduler(s.scheduler);
    const r = object(s.recovery) ? s.recovery : {}; next.recovery = { ...strings(r, ['status', 'boundary', 'reason']), pendingFromLayer: r.pendingFromLayer == null ? null : number(r.pendingFromLayer, null), pendingMessageIds: names(r.pendingMessageIds) }; if (!next.recovery.status) next.recovery.status = 'ready';
    if (number(s.schemaVersion, 1) < 2) next.proposals = next.proposals.map(item => item.status === 'pending' ? { ...item, status: 'stale', invalidationReason: 'schema_migrated' } : item);
    return next;
  }
  function readStored(key) { const raw = window.WORLD_ENGINE_STORE?.getItem(key); if (raw == null) return null; try { return JSON.parse(raw); } catch (_) { throw new Error('大纲存档损坏，已保留原始存档，请导入备份恢复'); } }
  function loadState(chatId) {
    const id = clean(chatId || getChatId()), current = readStored(STATE_PREFIX + id); if (current != null) return normalizeState(current, id);
    const legacy = readStored(LEGACY_STATE_PREFIX + id); if (legacy == null) return defaultState(id);
    const migrated = normalizeState(legacy, id); window.WORLD_ENGINE_STORE?.setItem(STATE_PREFIX + id, JSON.stringify(migrated)); return migrated;
  }
  function saveState(state, chatId) { const id = clean(chatId || getChatId()), next = normalizeState(state, id); window.WORLD_ENGINE_STORE?.setItem(STATE_PREFIX + id, JSON.stringify(next)); return clone(next); }
  function getNodeStatus(state, id) {
    const node = getNode(state, id); if (!node) return 'pending'; const override = state.manualOverrides?.[id], manual = typeof override === 'string' ? override : override?.status; if (STATUSES.includes(manual)) return manual;
    let result = 'pending'; for (const event of state.progressEvents || []) if (event.nodeId === id && event.validity === 'valid' && Number(event.planRevision) === Number(state.revision)) { const candidate = event.status || event.result; if (STATUSES.includes(candidate) && (candidate !== 'completed' || clean(node.completionCriteria))) result = candidate; } return result;
  }
  function nodeSignature(node) { return digest(JSON.stringify(node)); }
  function validatePlan(plan) {
    const raw = plan || {}, normalized = normalizePlan(raw), nodes = new Map(normalized.nodes.map(node => [node.id, node])), errors = [], warnings = [], visiting = new Set(), done = new Set();
    const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : list(raw.chapters).flatMap(chapter => list(chapter.nodes));
    const suppliedIds = [...list(raw.chapters), ...list(raw.tracks), ...rawNodes].map(item => clean(item.id)).filter(Boolean), seen = new Set();
    for (const id of suppliedIds) { if (seen.has(id)) errors.push('ID重复，引用无法唯一解析：' + id); seen.add(id); }
    const chapterIds = new Set(normalized.chapters.map(item => item.id)), trackIds = new Set(normalized.tracks.map(item => item.id));
    function checkCondition(condition, owner) {
      if (!condition) return;
      if (condition.all || condition.any) { for (const item of condition.all || condition.any) checkCondition(item, owner); return; }
      if (condition.type === 'nodeStatus' && !nodes.has(condition.nodeId)) warnings.push(owner + '引用的条件节点不存在：' + condition.nodeId);
      if (condition.type === 'chapter') for (const id of [...condition.chapterIds, condition.fromChapterId, condition.toChapterId].filter(Boolean)) if (!chapterIds.has(id)) warnings.push(owner + '引用的条件章节不存在：' + id);
      if (condition.type === 'unconfigured') warnings.push(owner + '条件待配置');
    }
    for (const node of normalized.nodes) {
      if (!trackIds.has(node.trackId)) warnings.push('节点所属剧情线不存在：' + node.id + ' → ' + node.trackId);
      for (const id of node.chapterIds) if (!chapterIds.has(id)) warnings.push('节点章节引用不存在：' + node.id + ' → ' + id);
      for (const dep of node.dependencies) if (!nodes.has(dep.nodeId)) warnings.push('前置节点不存在：' + node.id + ' → ' + dep.nodeId);
      checkCondition(node.trigger, node.id); checkCondition(node.disclosure.condition, node.id + '揭露');
    }
    for (const chapter of normalized.chapters) for (const id of chapter.exitNodeIds) if (!nodes.has(id)) warnings.push('章节退出节点不存在：' + chapter.id + ' → ' + id);
    function visit(id) { if (visiting.has(id)) { errors.push('剧情节点依赖存在循环：' + id); return; } if (done.has(id) || !nodes.has(id)) return; visiting.add(id); for (const dep of nodes.get(id).dependencies) visit(dep.nodeId); visiting.delete(id); done.add(id); }
    for (const id of nodes.keys()) visit(id); return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
  }
  function commitPlan(plan, expectedRevision) {
    const chatId = getChatId(), before = loadState(chatId); if (expectedRevision != null && Number(expectedRevision) !== before.revision) throw new Error('大纲已在其他操作中修改，请刷新后重试');
    const validation = validatePlan(plan), normalized = normalizePlan(plan); if (!validation.valid) throw new Error(validation.errors.join('\n')); if (JSON.stringify(normalized) === JSON.stringify(before.plan)) return before;
    const old = new Map(before.plan.nodes.map(node => [node.id, node])), unchanged = new Set(normalized.nodes.filter(node => old.has(node.id) && nodeSignature(node) === nodeSignature(old.get(node.id))).map(node => node.id));
    let changed = true; while (changed) { changed = false; for (const node of normalized.nodes) if (unchanged.has(node.id) && node.dependencies.some(dep => !unchanged.has(dep.nodeId))) { unchanged.delete(node.id); changed = true; } }
    const next = { ...before, revision: before.revision + 1, plan: normalized };
    next.progressEvents = before.progressEvents.map(event => unchanged.has(event.nodeId) && event.validity === 'valid' ? { ...event, planRevision: next.revision } : { ...event, validity: 'stale', invalidationReason: 'plan_changed' });
    const invalid = new Set(next.progressEvents.filter(event => event.validity !== 'valid').map(event => event.id)); changed = true;
    while (changed) { changed = false; for (const event of next.progressEvents) if (event.validity === 'valid' && event.parentEventIds.some(id => invalid.has(id))) { event.validity = 'stale'; invalid.add(event.id); changed = true; } }
    const ids = new Set(normalized.nodes.map(node => node.id)); next.manualOverrides = Object.fromEntries(Object.entries(before.manualOverrides).filter(([id]) => ids.has(id)));
    next.proposals = before.proposals.map(item => item.status === 'pending' ? { ...item, status: 'stale', invalidationReason: 'plan_changed' } : item);
    if (!normalized.chapters.some(chapter => chapter.id === next.currentChapterId)) next.currentChapterId = normalized.chapters[0]?.id || ''; next.tracking = { ...next.tracking, lastDigest: '', roundsSinceCheck: 0, pendingRecheck: true }; return saveState(next, chatId);
  }
  function setNodeStatus(id, status) { const state = loadState(); if (!getNode(state, id)) throw new Error('剧情节点不存在'); if (status == null || status === 'auto') delete state.manualOverrides[id]; else { if (!STATUSES.includes(status)) throw new Error('不支持的剧情节点状态'); state.manualOverrides[id] = { status, updatedAt: Date.now(), planRevision: state.revision }; } return saveState(state); }
  function setCurrentChapter(id) { const state = loadState(); if (!state.plan.chapters.some(chapter => chapter.id === id)) throw new Error('章节不存在'); state.currentChapterId = id; return saveState(state); }
  function advanceChapter(state) { const next = normalizeState(state), index = next.plan.chapters.findIndex(chapter => chapter.id === next.currentChapterId), exits = next.plan.chapters[index]?.exitNodeIds || []; if (exits.length && exits.every(id => ['completed', 'skipped'].includes(getNodeStatus(next, id)))) next.currentChapterId = next.plan.chapters[index + 1]?.id || next.currentChapterId; return next; }
  function captureAutomaticState(state) { const source = normalizeState(state); return { ...Object.fromEntries(AUTOMATIC_FIELDS.map(key => [key, clone(source[key])])), _planRevision: source.revision, _nodeSignatures: Object.fromEntries(source.plan.nodes.map(node => [node.id, nodeSignature(node)])) }; }
  function restoreAutomaticState(state, snapshot) {
    const current = normalizeState(state), auto = object(snapshot) ? snapshot : {}, next = normalizeState({ ...current, ...Object.fromEntries(AUTOMATIC_FIELDS.filter(key => Object.prototype.hasOwnProperty.call(auto, key)).map(key => [key, clone(auto[key])])), plan: current.plan, revision: current.revision, manualOverrides: current.manualOverrides, authorFlags: current.authorFlags });
    if (auto._planRevision != null && Number(auto._planRevision) !== current.revision) {
      const unchanged = new Set(current.plan.nodes.filter(node => auto._nodeSignatures?.[node.id] === nodeSignature(node)).map(node => node.id));
      let changed = true;
      while (changed) { changed = false; for (const node of current.plan.nodes) if (unchanged.has(node.id) && node.dependencies.some(dep => !unchanged.has(dep.nodeId))) { unchanged.delete(node.id); changed = true; } }
      next.progressEvents = next.progressEvents.map(event => unchanged.has(event.nodeId) ? { ...event, planRevision: current.revision } : { ...event, validity: 'stale', invalidationReason: 'plan_changed' });
      const invalid = new Set(next.progressEvents.filter(event => event.validity !== 'valid').map(event => event.id)); changed = true;
      while (changed) { changed = false; for (const event of next.progressEvents) if (event.validity === 'valid' && event.parentEventIds.some(id => invalid.has(id))) { event.validity = 'stale'; invalid.add(event.id); changed = true; } }
      next.proposals = next.proposals.map(item => item.status === 'pending' ? { ...item, status: 'stale' } : item);
    }
    return next;
  }
  function exportData() { return { __outlineEngineData: true, format: 'outline-full-backup', schemaVersion: SCHEMA_VERSION, chatId: getChatId(), exportedAt: new Date().toISOString(), state: loadState() }; }
  function importData(payload, options) {
    if (!object(payload)) throw new Error('不是有效的大纲文件'); if (number(payload.schemaVersion, 1) > 2 || number(payload.state?.schemaVersion, 1) > 2) throw new Error('此大纲存档来自更新版本，当前版本不能读取');
    const full = object(payload.state) ? payload.state : null, plan = full?.plan || payload.plan || payload; if (!object(plan) || !Array.isArray(plan.chapters)) throw new Error('大纲文件缺少章节列表');
    const chatId = getChatId(), current = loadState(chatId), keep = Boolean(full && clean(payload.chatId || full.originChatId) === chatId && options?.includeProgress !== false), next = keep ? normalizeState(full, chatId) : defaultState(chatId);
    next.plan = normalizePlan(plan); next.revision = Math.max(current.revision + 1, next.revision); next.originChatId = chatId; if (keep) { next.progressEvents.forEach(item => { item.planRevision = next.revision; }); next.proposals.forEach(item => { item.planRevision = next.revision; }); } else next.currentChapterId = next.plan.chapters[0]?.id || ''; return saveState(next, chatId);
  }
  return { SCHEMA_VERSION, STATE_PREFIX, LEGACY_STATE_PREFIX, STATUSES, AUTOMATIC_FIELDS, getChatId, defaultState, normalizePlan, normalizeState, normalizeCondition, normalizeEntityRefs, getChapterNodes, getTrackNodes, getNode, nodeSignature, validatePlan,
    loadState, saveState, commitPlan, getNodeStatus, setNodeStatus, setCurrentChapter, advanceChapter, captureAutomaticState, restoreAutomaticState, exportData, importData };
})();
