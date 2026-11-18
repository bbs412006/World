// 跨模块可选协同桥（WORLD ↔ MEMORY ↔ OUTLINE）
// 设计原则：纯可选、无强依赖、故障绝对隔离；任一引擎关闭或未加载时不影响其余引擎独立工作。
window.STORY_ENGINE_BRIDGE = (function() {
  'use strict';

  const clean = value => String(value == null ? '' : value).trim();
  const normalized = value => clean(value).toLocaleLowerCase();
  const unique = values => Array.from(new Set((Array.isArray(values) ? values : [values]).map(clean).filter(Boolean)));
  const cut = (value, maxChars) => {
    const chars = Array.from(clean(value));
    return chars.length > maxChars ? `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…` : clean(value);
  };

  function context() {
    try { return typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null; }
    catch (_) { return null; }
  }

  function currentChatId() {
    return clean(window.WORLD_ENGINE_CORE?.getChatId?.() || context()?.chatId || 'default');
  }

  function moduleStatus() {
    let worldEnabled = false;
    let memoryEnabled = false;
    let outlineEnabled = false;
    let worldAuto = false;
    let memoryAuto = false;
    let outlineAuto = false;
    try {
      const ws = window.WORLD_ENGINE_API?.getSettings?.(true);
      worldEnabled = Boolean(window.WORLD_ENGINE_CORE && window.WORLD_ENGINE_API && ws?.engineEnabled !== false);
      worldAuto = worldEnabled && ws?.evolveMode !== 'manual';
    } catch (_) {}
    try {
      const ms = window.MEMORY_ENGINE_SETTINGS?.getSettings?.(true);
      memoryEnabled = Boolean(window.MEMORY_ENGINE && ms?.engineEnabled !== false);
      memoryAuto = memoryEnabled && ms?.evolveMode !== 'manual';
    } catch (_) {}
    try {
      const os = window.OUTLINE_ENGINE_SETTINGS?.getSettings?.(true);
      outlineEnabled = Boolean(window.OUTLINE_ENGINE && os?.engineEnabled === true);
      outlineAuto = outlineEnabled && os?.autoCheck !== false;
    } catch (_) {}
    const enabledCount = [worldEnabled, memoryEnabled, outlineEnabled].filter(Boolean).length;
    const autoCount = [worldAuto, memoryAuto, outlineAuto].filter(Boolean).length;
    return { worldEnabled, memoryEnabled, outlineEnabled, worldAuto, memoryAuto, outlineAuto, enabledCount, autoCount };
  }

  function getCoordinationMode() {
    try {
      const mode = window.MEMORY_ENGINE_SETTINGS?.getSettings?.(true)?.coordinationMode;
      if (mode === 'independent' || mode === 'stagger-serial') return mode;
    } catch (_) {}
    return 'stagger-serial';
  }

  function getWorldLinkMode() {
    try {
      const mode = window.MEMORY_ENGINE_SETTINGS?.getSettings?.(true)?.worldLinkMode;
      if (mode === 'llm' || mode === 'lightweight') return mode;
    } catch (_) {}
    return 'lightweight';
  }

  // —— 统一人物与实体别名映射 ——
  function collectSharedRoster() {
    const groups = [];
    const entities = [];
    try {
      const mem = window.MEMORY_ENGINE?.getSnapshotSummaryForBridge?.();
      if (mem) {
        for (const p of mem.peopleRoster || []) groups.push({ source: 'memory', id: p.id, names: unique(p.names) });
        for (const e of mem.entityRoster || []) entities.push({ source: 'memory', type: e.type, name: e.name, aliases: unique(e.aliases) });
      }
    } catch (_) {}
    try {
      const ws = window.WORLD_ENGINE_API?.getSettings?.(true);
      if (ws?.engineEnabled !== false) {
        const rawWorld = window.WORLD_ENGINE_CORE?.loadState?.();
        const world = window.STORY_ENGINE_PROJECTION?.publicWorld?.(rawWorld) || rawWorld;
        if (world && typeof world === 'object') {
          for (const f of world.factions || []) {
            if (clean(f?.name)) entities.push({ source: 'world', type: 'organization', name: clean(f.name), aliases: [] });
            if (clean(f?.core_person)) groups.push({ source: 'world', id: clean(f.id), names: [clean(f.core_person)] });
          }
          for (const e of world.enemies || []) {
            if (clean(e?.name)) entities.push({ source: 'world', type: 'enemy', name: clean(e.name), aliases: [] });
          }
        }
      }
    } catch (_) {}
    try {
      const os = window.OUTLINE_ENGINE_SETTINGS?.getSettings?.(true);
      if (os?.engineEnabled === true) {
        const outline = window.OUTLINE_ENGINE_DATA?.loadState?.();
        for (const node of outline?.plan?.nodes || []) {
          for (const ref of node.entityRefs || []) {
            if (clean(ref?.nameSnapshot)) {
              groups.push({ source: 'outline', id: clean(ref.id), names: [clean(ref.nameSnapshot)] });
            }
          }
        }
      }
    } catch (_) {}
    return { people: groups, entities };
  }

  function resolveCharacterAliases(actorIdOrName) {
    const query = clean(actorIdOrName);
    if (!query) return [];
    const target = normalized(query);
    const { people } = collectSharedRoster();
    const matched = new Set([query]);
    for (const entry of people) {
      const hitId = entry.id && normalized(entry.id) === target;
      const hitName = (entry.names || []).some(name => normalized(name) === target);
      if (hitId || hitName) {
        for (const name of entry.names || []) matched.add(name);
      }
    }
    return [...matched];
  }

  function formatIdentityRosterForPrompt() {
    try {
      const { people, entities } = collectSharedRoster();
      const mergedPeople = new Map();
      for (const entry of people) {
        const list = unique(entry.names);
        if (!list.length) continue;
        const primaryKey = normalized(list[0]);
        const bucket = mergedPeople.get(primaryKey) || new Set();
        list.forEach(n => bucket.add(n));
        mergedPeople.set(primaryKey, bucket);
      }
      const peopleLines = [...mergedPeople.values()].slice(0, 20).map(set => [...set].join(' / '));
      const entityLines = unique(entities.map(e => `${e.name}${e.aliases?.length ? `(${e.aliases[0]})` : ''}`)).slice(0, 20);
      if (!peopleLines.length && !entityLines.length) return '';
      return [
        peopleLines.length ? `已知人物及别名：${peopleLines.join('；')}` : '',
        entityLines.length ? `已知公开势力/实体：${entityLines.join('、')}` : ''
      ].filter(Boolean).join('\n');
    } catch (_) {
      return '';
    }
  }

  // —— 隐私安全的跨模块只读参考组装 ——
  function getPublicWorldSafeSnapshot() {
    try {
      const ws = window.WORLD_ENGINE_API?.getSettings?.(true);
      if (!window.WORLD_ENGINE_CORE || ws?.engineEnabled === false) return null;
      const raw = window.STORY_ENGINE_HISTORY?.isEnabled?.() && window.STORY_ENGINE_HISTORY?.getWorldState?.()
        ? window.STORY_ENGINE_HISTORY.getWorldState()
        : window.WORLD_ENGINE_CORE.loadState?.();
      if (!raw) return null;
      const projected = window.STORY_ENGINE_PROJECTION?.publicWorld?.(raw);
      if (projected) return projected;
      const clone = JSON.parse(JSON.stringify(raw));
      delete clone.blackbox;
      return clone;
    } catch (_) {
      return null;
    }
  }

  function getMemoryExtractionHints() {
    const result = { outlineChapterTitle: '', outlineFocusHint: '', worldContextHint: '' };
    try {
      const os = window.OUTLINE_ENGINE_SETTINGS?.getSettings?.(true);
      if (os?.engineEnabled === true) {
        const outline = window.OUTLINE_ENGINE_DATA?.loadState?.();
        const chapter = (outline?.plan?.chapters || []).find(c => c.id === outline?.currentChapterId);
        if (chapter?.title) result.outlineChapterTitle = clean(chapter.title);
        const focusParts = [];
        if (chapter?.title) focusParts.push(`当前章节：${chapter.title}${chapter.goal ? `（目标：${cut(chapter.goal, 80)}）` : ''}`);
        if (clean(outline?.plan?.publicSynopsis)) focusParts.push(`公开脉络：${cut(outline.plan.publicSynopsis, 160)}`);
        // 严格只读取已激活且 visibility === 'public' 的节点标题，绝不暴露 private/未来节点/privateFacts
        const activePublicNodes = (outline?.plan?.nodes || []).filter(node => {
          if (node.visibility === 'private') return false;
          const st = window.OUTLINE_ENGINE_DATA?.getNodeStatus?.(outline, node.id);
          return st === 'active';
        }).slice(0, 4).map(node => node.title).filter(Boolean);
        if (activePublicNodes.length) focusParts.push(`当前公开活跃焦距：${activePublicNodes.join('、')}`);
        result.outlineFocusHint = focusParts.join('\n');
      }
    } catch (_) {}
    try {
      const world = getPublicWorldSafeSnapshot();
      if (world) {
        const parts = [];
        if (clean(world.worldDigest)) parts.push(`世界近期摘要：${cut(world.worldDigest, 240)}`);
        const activeEvents = (world.events || []).filter(e => e?.name && e?.stage !== '已消散').slice(0, 4)
          .map(e => `${e.name}[${e.stage || ''}]`);
        if (activeEvents.length) parts.push(`活跃世界事件：${activeEvents.join('、')}`);
        const trends = (world.worldTrends || []).filter(t => t?.name && t?.status !== '已结束').slice(0, 3)
          .map(t => `${t.name}(${t.status})`);
        if (trends.length) parts.push(`天下大势：${trends.join('、')}`);
        result.worldContextHint = parts.join('\n');
      }
    } catch (_) {}
    return result;
  }

  function getOutlineActiveActors() {
    try {
      const os = window.OUTLINE_ENGINE_SETTINGS?.getSettings?.(true);
      if (os?.engineEnabled !== true) return [];
      const outline = window.OUTLINE_ENGINE_DATA?.loadState?.();
      if (!outline) return [];
      const names = new Set();
      const validContactClueIds = new Set((outline.clues || []).filter(c => c.validity === 'valid' && c.available).map(c => c.id));
      for (const contact of outline.contacts || []) {
        if (contact.validity === 'valid' && validContactClueIds.has(contact.clueId) && clean(contact.actorId)) {
          for (const alias of resolveCharacterAliases(contact.actorId)) names.add(alias);
        }
      }
      for (const node of outline.plan?.nodes || []) {
        if (node.visibility === 'private') continue;
        const st = window.OUTLINE_ENGINE_DATA?.getNodeStatus?.(outline, node.id);
        if (st === 'active') {
          for (const ref of node.entityRefs || []) {
            if (clean(ref.nameSnapshot)) {
              for (const alias of resolveCharacterAliases(ref.nameSnapshot)) names.add(alias);
            }
          }
        }
      }
      return [...names];
    } catch (_) {
      return [];
    }
  }

  function buildOutlineReferenceContext(outlineState) {
    const parts = [];
    try {
      const world = getPublicWorldSafeSnapshot();
      if (world) {
        const wLines = [];
        if (clean(world.worldDigest)) wLines.push(`摘要：${cut(world.worldDigest, 600)}`);
        const activeTrends = (world.worldTrends || []).filter(t => t?.status !== '已结束').slice(0, 4)
          .map(t => `${t.name}（${t.status}）`);
        if (activeTrends.length) wLines.push(`大势：${activeTrends.join('、')}`);
        const winds = (world.winds || []).slice(-4).map(w => `${w.topic || ''}:${cut(w.content, 60)}`);
        if (winds.length) wLines.push(`风声：${winds.join('；')}`);
        if (wLines.length) parts.push(`世界背景（不是节点完成证据）：\n${wLines.join('\n')}`);
      }
    } catch (_) {}
    try {
      const ms = window.MEMORY_ENGINE_SETTINGS?.getSettings?.(true);
      if (ms?.engineEnabled !== false && window.MEMORY_ENGINE?.getSnapshotSummaryForBridge) {
        const mem = window.MEMORY_ENGINE.getSnapshotSummaryForBridge();
        if (mem) {
          const mLines = [];
          if (mem.ongoingFacts?.length) {
            mLines.push('当前持续事实：' + mem.ongoingFacts.slice(-8).map(f => `[${f.category}·${f.subject}] ${f.fact}`).join('；'));
          }
          const latestBig = mem.recentBigSummaries?.slice(-1) || [];
          if (latestBig.length) mLines.push(`最新总述：${cut(latestBig[0].content, 700)}`);
          const smalls = mem.recentSmallSummaries?.slice(-3) || [];
          if (smalls.length) {
            mLines.push('近期事件纪要：\n' + smalls.map(s => `- [楼层${s.startLayer}-${s.endLayer}] ${cut(s.content, 200)}`).join('\n'));
          }
          if (mem.characterArcs?.length) {
            const activeNames = new Set((outlineState?.plan?.nodes || []).flatMap(n => (n.entityRefs || []).map(r => normalized(r.nameSnapshot))).filter(Boolean));
            const pickedArcs = mem.characterArcs.filter(arc => !activeNames.size || (arc.names || []).some(n => activeNames.has(normalized(n)))).slice(0, 4);
            if (pickedArcs.length) {
              mLines.push('人物近况弧光：' + pickedArcs.map(a => `${a.names?.[0] || a.characterId}(${a.progressPct}% ${a.relationship || ''}:${cut(a.currentStance, 40)})`).join('；'));
            }
          }
          if (mLines.length) parts.push(`记忆背景（不得作为原文证据）：\n${mLines.join('\n')}`);
        }
      }
    } catch (_) {}
    return cut(parts.join('\n\n'), 2800);
  }

  function buildWorldMemorySection(worldState) {
    try {
      const ms = window.MEMORY_ENGINE_SETTINGS?.getSettings?.(true);
      if (!window.MEMORY_ENGINE || ms?.engineEnabled === false) return '';
      if (ms?.injectIntoWorldEngine === true && window.MEMORY_ENGINE.buildWorldEngineContext) {
        return window.MEMORY_ENGINE.buildWorldEngineContext(worldState) || '';
      }
    } catch (_) {}
    return '';
  }

  function getCrossInjectionHints() {
    try {
      const ws = window.WORLD_ENGINE_API?.getSettings?.(true);
      if (!window.WORLD_ENGINE_CORE || ws?.engineEnabled === false || ws?.injectIntoPrompt === false) return {};
      const rawWorld = window.STORY_ENGINE_HISTORY?.isEnabled?.() && window.STORY_ENGINE_HISTORY?.getWorldState?.()
        ? window.STORY_ENGINE_HISTORY.getWorldState()
        : window.WORLD_ENGINE_CORE.loadState?.();
      return {
        worldDigestTrim: clean(rawWorld?.worldDigest)
      };
    } catch (_) {
      return {};
    }
  }

  // —— 严格白名单同步大纲 verified 认知到记忆引擎 ——
  function notifyOutlineCommitted(afterState, beforeState, selection) {
    try {
      const ms = window.MEMORY_ENGINE_SETTINGS?.getSettings?.(true);
      if (!window.MEMORY_ENGINE?.syncVerifiedOutlineKnowledge || ms?.engineEnabled === false) return { changed: 0 };
      const oldContactIds = new Set((beforeState?.contacts || []).filter(c => c.validity === 'valid').map(c => c.id));
      const oldKnowledgeIds = new Set((beforeState?.knowledge || []).filter(k => k.validity === 'valid').map(k => k.id));
      const newContacts = (afterState?.contacts || []).filter(c => c.validity === 'valid' && !oldContactIds.has(c.id));
      const newKnowledge = (afterState?.knowledge || []).filter(k => k.validity === 'valid' && !oldKnowledgeIds.has(k.id));
      const events = [];
      for (const c of newContacts) {
        const clue = (afterState.clues || []).find(item => item.id === c.clueId && item.validity === 'valid');
        if (!clue || !clean(clue.publicHint)) continue;
        events.push({
          outlineEventId: `contact:${c.id}`,
          actorId: c.actorId,
          actorNames: resolveCharacterAliases(c.actorId),
          memory: cut(`${c.actorId}接触并发现线索：${clue.publicHint}`, 50),
          sourceRefs: Array.isArray(c.sourceRefs) && c.sourceRefs.length ? c.sourceRefs : (selection?.refs || []),
          layer: selection?.refs?.at(-1)?.layer
        });
      }
      for (const k of newKnowledge) {
        const fact = (afterState.privateFacts || []).find(item => item.id === k.factId && item.validity === 'valid');
        // 安全铁律：仅在确认为该 actorId 已正式揭露时，写入该角色专属个人记忆，绝不扩写其他无关旁人
        if (!fact || !clean(fact.text) || !(fact.knownBy || []).includes(k.actorId)) continue;
        events.push({
          outlineEventId: `reveal:${k.id}`,
          actorId: k.actorId,
          actorNames: resolveCharacterAliases(k.actorId),
          memory: cut(`${k.actorId}确认真相：${fact.text}`, 50),
          sourceRefs: selection?.refs || [],
          layer: selection?.refs?.at(-1)?.layer
        });
      }
      if (!events.length) return { changed: 0 };
      return window.MEMORY_ENGINE.syncVerifiedOutlineKnowledge(events);
    } catch (error) {
      console.warn('[协同桥] 大纲已验证认知同步记忆失败（已隔离）', error);
      return { changed: 0 };
    }
  }

  // —— 跨模块后台 API 错峰单并发队列（解决 Vertex 等渠道瞬时并发限流） ——
  const ORDER = ['world', 'outline', 'memory'];
  const DEFAULT_WINDOW_MS = 1400;
  let activeTurn = null;
  let turnSequence = 0;

  function shouldCoordinateGeneration() {
    if (getCoordinationMode() !== 'stagger-serial') return false;
    return moduleStatus().autoCount >= 2;
  }

  function cancelTurn() {
    if (!activeTurn) return;
    if (activeTurn.timer) {
      clearTimeout(activeTurn.timer);
      activeTurn.timer = null;
    }
    activeTurn.cancelled = true;
    activeTurn.resolve?.({ cancelled: true });
    activeTurn = null;
  }

  async function drainTurn(turn) {
    if (!turn || turn.cancelled || turn.running) return { skipped: true };
    turn.running = true;
    try {
      for (const scope of ORDER) {
        if (turn.cancelled || activeTurn !== turn) return { cancelled: true };
        const entry = turn.tasks.get(scope);
        if (!entry || entry.done) continue;
        entry.done = true;
        try {
          if (currentChatId() !== turn.chatId) {
            turn.cancelled = true;
            return { cancelled: true };
          }
          await entry.run();
        } catch (error) {
          // 孤立单个引擎错误，保证排在后面的引擎继续工作
          console.warn(`[协同桥] ${scope} 调度任务执行失败（已隔离）`, error);
        }
      }
      return { ok: true };
    } finally {
      turn.running = false;
      if (activeTurn === turn && [...turn.tasks.values()].every(t => t.done)) {
        activeTurn = null;
      }
    }
  }

  function scheduleTurn(entry) {
    const scope = clean(entry?.scope);
    if (!ORDER.includes(scope) || typeof entry?.run !== 'function') return Promise.resolve({ skipped: true });
    const chat = currentChatId();
    const layer = Number.isFinite(Number(entry.layer)) ? Number(entry.layer) : 0;
    const windowMs = Number.isFinite(Number(entry.delayMs)) ? Math.max(20, Number(entry.delayMs)) : DEFAULT_WINDOW_MS;
    if (!activeTurn || activeTurn.cancelled || activeTurn.chatId !== chat || activeTurn.layer !== layer) {
      cancelTurn();
      let resolveTurn = null;
      const promise = new Promise(resolve => { resolveTurn = resolve; });
      activeTurn = {
        id: ++turnSequence,
        chatId: chat,
        layer,
        tasks: new Map(),
        timer: null,
        running: false,
        cancelled: false,
        promise,
        resolve: resolveTurn
      };
    }
    const turn = activeTurn;
    turn.tasks.set(scope, { run: entry.run, key: clean(entry.key), done: false });
    if (turn.running) return turn.promise;
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = setTimeout(() => {
      turn.timer = null;
      drainTurn(turn).then(turn.resolve, turn.resolve);
    }, windowMs);
    return turn.promise;
  }

  // —— 协同保证正文注入在同 depth=1 时的秩序：世界 → 记忆 → 大纲 ——
  function ensureInjectionOrder() {
    try {
      const ctx = context();
      const ep = ctx?.extensionPrompts;
      if (!ep || typeof ep !== 'object' || Array.isArray(ep)) return;
      const keys = ['world-engine-world', 'memory-engine-memory', 'outline-engine-outline'];
      const snapshot = {};
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(ep, k) && ep[k]) {
          snapshot[k] = ep[k];
          delete ep[k];
        }
      }
      for (const k of keys) {
        if (snapshot[k]) ep[k] = snapshot[k];
      }
    } catch (_) {}
  }

  function getStatusSummary() {
    const st = moduleStatus();
    return {
      ...st,
      coordinationMode: getCoordinationMode(),
      worldLinkMode: getWorldLinkMode(),
      queueActive: Boolean(activeTurn && !activeTurn.cancelled),
      queuedScopes: activeTurn ? [...activeTurn.tasks.keys()] : []
    };
  }

  return {
    moduleStatus,
    getCoordinationMode,
    getWorldLinkMode,
    collectSharedRoster,
    resolveCharacterAliases,
    formatIdentityRosterForPrompt,
    getMemoryExtractionHints,
    getOutlineActiveActors,
    buildOutlineReferenceContext,
    buildWorldMemorySection,
    getCrossInjectionHints,
    notifyOutlineCommitted,
    shouldCoordinateGeneration,
    scheduleTurn,
    cancelTurn,
    ensureInjectionOrder,
    getStatusSummary
  };
})();
