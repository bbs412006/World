// outline-engine-data.js — 剧情大纲 v3 轻量化数据层（三层模型：章节 → 主/支/暗线 → 节点，按楼层号 0ms 回退，无条件树/无锁死）
window.OUTLINE_ENGINE_DATA = (function() {
  'use strict';

  const SCHEMA_VERSION = 3;
  const STATE_PREFIX = 'outline_engine_v3_state_';
  const V2_STATE_PREFIX = 'outline_engine_v2_state_';
  const LEGACY_STATE_PREFIX = 'outline_engine_state_';
  const STATUSES = Object.freeze(['pending', 'active', 'completed', 'skipped', 'blocked']);
  const TRACK_KINDS = Object.freeze(['main', 'side', 'hidden']);

  const clean = value => String(value == null ? '' : value).trim();
  const clone = value => JSON.parse(JSON.stringify(value));
  const uniqueStrings = list => {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
      const text = clean(item);
      if (text && !seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    }
    return out;
  };

  function hashText(text) {
    let h = 2166136261;
    for (const ch of String(text || '')) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function makeId(prefix, seed, used) {
    const base = `${prefix}_${hashText(seed || `${prefix}_${used.size}`)}`;
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) candidate = `${base}_${n++}`;
    used.add(candidate);
    return candidate;
  }

  function getChatId() {
    try {
      return clean(window.WORLD_ENGINE_CORE?.getChatId?.() || SillyTavern?.getContext?.()?.chatId) || 'default';
    } catch (_) {
      return 'default';
    }
  }

  function storageKey(chatId) {
    return STATE_PREFIX + (clean(chatId) || getChatId());
  }

  function emptyPlan() {
    return {
      title: '',
      publicSynopsis: '',
      publicConstraints: '',
      authorNotes: '',
      chapters: [],
      tracks: [],
      nodes: []
    };
  }

  function defaultState(chatId) {
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      originChatId: clean(chatId) || getChatId(),
      plan: emptyPlan(),
      currentChapterId: null,
      progress: {},
      manualOverrides: {},
      tracking: {
        anchorLayer: null,
        checkedLayer: null,
        roundsSinceCheck: 0,
        lastDigest: ''
      }
    };
  }

  function normalizeTrackKind(kind) {
    return TRACK_KINDS.includes(kind) ? kind : 'main';
  }

  function normalizePlan(rawPlan) {
    const src = rawPlan && typeof rawPlan === 'object' ? rawPlan : {};
    const rawChapters = Array.isArray(src.chapters) ? src.chapters : [];
    const isV1Nested = !Array.isArray(src.nodes) && rawChapters.some(ch => Array.isArray(ch?.nodes));

    // 1. 章节归一化（独立 ID 空间）
    const usedChapterIds = new Set();
    const exitNodeSet = new Set();
    const chapters = rawChapters.map((ch, idx) => {
      const rawId = clean(ch?.id);
      const id = rawId && !usedChapterIds.has(rawId)
        ? (usedChapterIds.add(rawId), rawId)
        : makeId('ch', `${idx}:${clean(ch?.title)}`, usedChapterIds);
      for (const eid of Array.isArray(ch?.exitNodeIds) ? ch.exitNodeIds : []) {
        if (clean(eid)) exitNodeSet.add(clean(eid));
      }
      return {
        id,
        title: clean(ch?.title) || `第 ${idx + 1} 章`,
        goal: clean(ch?.goal)
      };
    });
    const chapterIdSet = new Set(chapters.map(c => c.id));

    // 2. 剧情线归一化（独立 ID 空间）
    const usedTrackIds = new Set();
    const tracks = (Array.isArray(src.tracks) ? src.tracks : []).map((tr, idx) => {
      const rawId = clean(tr?.id);
      const id = rawId && !usedTrackIds.has(rawId)
        ? (usedTrackIds.add(rawId), rawId)
        : makeId('tr', `${idx}:${clean(tr?.title)}`, usedTrackIds);
      return {
        id,
        kind: normalizeTrackKind(tr?.kind),
        title: clean(tr?.title) || (tr?.kind === 'side' ? '支线剧情' : tr?.kind === 'hidden' ? '暗线伏笔' : '主线剧情'),
        goal: clean(tr?.goal),
        paused: tr?.paused === true
      };
    });

    // 收集原始节点（兼容 v1 嵌套章节节点与 v2/v3 平铺节点）
    let rawNodes = [];
    if (isV1Nested) {
      rawChapters.forEach((ch, idx) => {
        const chId = chapters[idx]?.id;
        for (const n of Array.isArray(ch?.nodes) ? ch.nodes : []) {
          rawNodes.push({ ...n, chapterIds: chId ? [chId] : [] });
        }
      });
    } else if (Array.isArray(src.nodes)) {
      rawNodes = src.nodes;
    }

    if (rawNodes.length && !tracks.length) {
      const mainId = usedTrackIds.has('main') ? makeId('tr', 'default-main', usedTrackIds) : (usedTrackIds.add('main'), 'main');
      tracks.push({ id: mainId, kind: 'main', title: '主线剧情', goal: '', paused: false });
    }
    const trackMap = new Map(tracks.map(t => [t.id, t]));
    const fallbackTrackId = (tracks.find(t => t.kind === 'main') || tracks[0])?.id || '';

    // 3. 节点归一化（独立 ID 空间，清理嵌套条件树/实体对象等冗余字段）
    const usedNodeIds = new Set();
    const rawIdToNormId = new Map();
    const draftNodes = rawNodes.map((n, idx) => {
      const rawId = clean(n?.id);
      const id = rawId && !usedNodeIds.has(rawId)
        ? (usedNodeIds.add(rawId), rawId)
        : makeId('nd', `${idx}:${clean(n?.title)}`, usedNodeIds);
      if (rawId && !rawIdToNormId.has(rawId)) rawIdToNormId.set(rawId, id);

      const trackId = trackMap.has(clean(n?.trackId)) ? clean(n.trackId) : fallbackTrackId;
      const trackKind = trackMap.get(trackId)?.kind || 'main';
      const isHidden = trackKind === 'hidden' || n?.visibility === 'private';

      const rawChIds = Array.isArray(n?.chapterIds)
        ? n.chapterIds
        : (clean(n?.chapterId) ? [clean(n.chapterId)] : []);
      const chapterIds = uniqueStrings(rawChIds).filter(cid => chapterIdSet.has(cid));

      // 从 v2 平滑提取公开提示与幕后备注
      const rawPublicHint = clean(n?.publicHint);
      const rawIntent = clean(n?.intent);
      const publicHint = rawPublicHint || (!isHidden ? rawIntent : '');
      const secretParts = uniqueStrings([
        n?.secretNotes,
        n?.notes,
        isHidden && rawIntent && rawIntent !== publicHint ? rawIntent : '',
        n?.disclosure?.clueText
      ]);
      const secretNotes = secretParts.join('\n');

      // 关联角色名（兼容 v2 entityRefs）
      const actorList = [
        ...(Array.isArray(n?.actors) ? n.actors : []),
        ...(Array.isArray(n?.entityRefs) ? n.entityRefs.map(r => r?.nameSnapshot || r?.name) : [])
      ];

      // 前置依赖先暂存原始 ID，待全部节点归一化后映射
      const rawDeps = Array.isArray(n?.dependencies)
        ? n.dependencies.map(d => (typeof d === 'string' ? d : d?.nodeId))
        : [];

      const required = exitNodeSet.has(rawId) || exitNodeSet.has(id)
        ? true
        : (n?.required !== undefined ? n.required !== false : trackKind === 'main');

      const revealPublic = trackKind === 'hidden' ? (n?.revealPublic === true) : true;

      return {
        id,
        trackId,
        chapterIds,
        rawDeps,
        title: clean(n?.title) || `节点 ${idx + 1}`,
        publicHint,
        completionCriteria: clean(n?.completionCriteria),
        secretNotes,
        required,
        revealPublic,
        actors: uniqueStrings(actorList)
      };
    });

    const validNodeIds = new Set(draftNodes.map(n => n.id));
    const nodes = draftNodes.map(({ rawDeps, ...node }) => {
      const deps = uniqueStrings(rawDeps.map(d => rawIdToNormId.get(clean(d)) || clean(d)))
        .filter(depId => depId !== node.id && validNodeIds.has(depId));
      return { ...node, dependencies: deps };
    });

    // 4. 顶层梗概/约束/作者备忘（兼容 v1/v2 字段）
    const publicSynopsis = clean(src.publicSynopsis) || (src.authorNotes === undefined && !clean(src.publicSynopsis) ? clean(src.synopsis) : '');
    const publicConstraints = clean(src.publicConstraints) || (src.authorNotes === undefined && !clean(src.publicConstraints) ? clean(src.constraints) : '');
    const authorParts = uniqueStrings([
      src.authorNotes,
      clean(src.synopsis) && clean(src.synopsis) !== publicSynopsis ? `【完整梗概】${clean(src.synopsis)}` : '',
      clean(src.constraints) && clean(src.constraints) !== publicConstraints ? `【完整约束】${clean(src.constraints)}` : ''
    ]);

    return {
      title: clean(src.title),
      publicSynopsis,
      publicConstraints,
      authorNotes: authorParts.join('\n'),
      chapters,
      tracks,
      nodes
    };
  }

  function validatePlan(rawPlan) {
    const errors = [];
    const warnings = [];
    const src = rawPlan && typeof rawPlan === 'object' ? rawPlan : {};

    const checkDup = (list, label) => {
      const seen = new Set();
      for (const item of Array.isArray(list) ? list : []) {
        const id = clean(item?.id);
        if (!id) continue;
        if (seen.has(id)) errors.push(`${label} ID 重复：${id}`);
        seen.add(id);
      }
    };
    checkDup(src.chapters, '章节');
    checkDup(src.tracks, '剧情线');
    checkDup(src.nodes, '节点');

    const plan = normalizePlan(src);
    const nodeMap = new Map(plan.nodes.map(n => [n.id, n]));
    const color = new Map(); // 0=unvisited, 1=visiting, 2=done

    for (const node of plan.nodes) {
      if (color.get(node.id)) continue;
      // 迭代 DFS 检测依赖环，避免极长依赖链爆栈
      const stack = [{ id: node.id, idx: 0 }];
      color.set(node.id, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const deps = nodeMap.get(top.id)?.dependencies || [];
        if (top.idx < deps.length) {
          const nextId = deps[top.idx++];
          const c = color.get(nextId) || 0;
          if (c === 1) {
            errors.push(`节点依赖存在循环：${top.id} → ${nextId}`);
          } else if (c === 0 && nodeMap.has(nextId)) {
            color.set(nextId, 1);
            stack.push({ id: nextId, idx: 0 });
          }
        } else {
          color.set(top.id, 2);
          stack.pop();
        }
      }
      if (!node.completionCriteria) {
        warnings.push(`节点「${node.title}」未填写达成条件`);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  function normalizeState(rawState, chatIdOverride) {
    const chatId = clean(chatIdOverride) || getChatId();
    const src = rawState && typeof rawState === 'object' ? rawState : {};
    const ver = Number(src.schemaVersion || 1);
    if (ver > SCHEMA_VERSION) {
      throw new Error(`不支持更高版本的大纲存档（schemaVersion=${ver}）`);
    }

    const plan = normalizePlan(src.plan);
    const chapterIds = new Set(plan.chapters.map(c => c.id));
    const nodeIds = new Set(plan.nodes.map(n => n.id));
    const nodeMap = new Map(plan.nodes.map(n => [n.id, n]));
    const trackMap = new Map(plan.tracks.map(t => [t.id, t]));

    // 迁移 v2 已开放线索到暗线节点的 revealPublic
    if (Array.isArray(src.clues)) {
      for (const clue of src.clues) {
        if (!clue || clue.validity !== 'valid' || !clue.available) continue;
        const node = nodeMap.get(clean(clue.nodeId));
        if (node && trackMap.get(node.trackId)?.kind === 'hidden') {
          node.revealPublic = true;
          if (!node.publicHint && clean(clue.publicHint)) node.publicHint = clean(clue.publicHint);
        }
      }
    }

    // 归一化 progress（兼容迁移 v2 progressEvents）
    const progress = {};
    if (src.progress && typeof src.progress === 'object' && !Array.isArray(src.progress)) {
      for (const [nodeId, entry] of Object.entries(src.progress)) {
        if (!nodeIds.has(nodeId) || !entry || typeof entry !== 'object') continue;
        const status = STATUSES.includes(entry.status) ? entry.status : 'pending';
        if (status === 'pending') continue;
        const layer = entry.layer !== null && entry.layer !== undefined && Number.isFinite(Number(entry.layer))
          ? Math.max(0, parseInt(entry.layer, 10))
          : null;
        progress[nodeId] = {
          status,
          layer,
          reason: clean(entry.reason),
          updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : Date.now()
        };
      }
    } else if (Array.isArray(src.progressEvents)) {
      const rev = Number(src.revision) || 0;
      for (const ev of src.progressEvents) {
        if (!ev || ev.validity !== 'valid' || ev.stale === true) continue;
        if (ev.planRevision !== undefined && Number(ev.planRevision) !== rev) continue;
        const nid = clean(ev.nodeId);
        if (!nodeIds.has(nid) || !STATUSES.includes(ev.status) || ev.status === 'pending') continue;
        const layer = ev.layer !== null && ev.layer !== undefined && Number.isFinite(Number(ev.layer))
          ? Math.max(0, parseInt(ev.layer, 10))
          : null;
        progress[nid] = {
          status: ev.status,
          layer,
          reason: clean(ev.reason || ev.evidence?.[0]?.quote),
          updatedAt: Number.isFinite(Number(ev.createdAt)) ? Number(ev.createdAt) : Date.now()
        };
      }
    }

    // 归一化 manualOverrides
    const manualOverrides = {};
    if (src.manualOverrides && typeof src.manualOverrides === 'object') {
      for (const [nodeId, st] of Object.entries(src.manualOverrides)) {
        if (nodeIds.has(nodeId) && STATUSES.includes(st)) {
          manualOverrides[nodeId] = st;
        }
      }
    }

    // 归一化 tracking
    const rawTr = src.tracking && typeof src.tracking === 'object' ? src.tracking : {};
    const toLayer = v => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)))
      ? Math.max(0, parseInt(v, 10))
      : null;
    const tracking = {
      anchorLayer: toLayer(rawTr.anchorLayer),
      checkedLayer: toLayer(rawTr.checkedLayer),
      roundsSinceCheck: Math.max(0, parseInt(rawTr.roundsSinceCheck, 10) || 0),
      lastDigest: clean(rawTr.lastDigest)
    };

    const currentChapterId = chapterIds.has(clean(src.currentChapterId))
      ? clean(src.currentChapterId)
      : (plan.chapters[0]?.id || null);

    return {
      schemaVersion: SCHEMA_VERSION,
      revision: Math.max(0, parseInt(src.revision, 10) || 0),
      originChatId: clean(src.originChatId) || chatId,
      plan,
      currentChapterId,
      progress,
      manualOverrides,
      tracking
    };
  }

  function readRawJson(key) {
    const raw = window.WORLD_ENGINE_STORE?.getItem?.(key);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  function loadState(chatIdOverride) {
    const chatId = clean(chatIdOverride) || getChatId();
    const v3Key = STATE_PREFIX + chatId;
    const v3Raw = readRawJson(v3Key);
    if (v3Raw) return normalizeState(v3Raw, chatId);

    // 尝试从 v2 或 v1 无损迁移并落盘到 v3 键（保留旧键不动）
    for (const legacyPrefix of [V2_STATE_PREFIX, LEGACY_STATE_PREFIX]) {
      try {
        const legacyRaw = readRawJson(legacyPrefix + chatId);
        if (legacyRaw) {
          const migrated = normalizeState(legacyRaw, chatId);
          window.WORLD_ENGINE_STORE?.setItem?.(v3Key, JSON.stringify(migrated));
          return migrated;
        }
      } catch (err) {
        console.warn('[剧情大纲] 旧版存档迁移失败，跳过旧键：', legacyPrefix, err);
      }
    }
    return defaultState(chatId);
  }

  function saveState(state, chatIdOverride) {
    const chatId = clean(chatIdOverride) || getChatId();
    const normalized = normalizeState(state, chatId);
    window.WORLD_ENGINE_STORE?.setItem?.(STATE_PREFIX + chatId, JSON.stringify(normalized));
    return normalized;
  }

  function getNode(state, nodeId) {
    return (state?.plan?.nodes || []).find(n => n.id === nodeId) || null;
  }

  function getTrack(state, trackId) {
    return (state?.plan?.tracks || []).find(t => t.id === trackId) || null;
  }

  function getChapterNodes(state, chapterId) {
    const cid = clean(chapterId);
    return (state?.plan?.nodes || []).filter(n => (n.chapterIds || []).includes(cid));
  }

  function getTrackNodes(state, trackId) {
    const tid = clean(trackId);
    return (state?.plan?.nodes || []).filter(n => n.trackId === tid);
  }

  function getNodeStatus(state, nodeId) {
    if (!state || !nodeId) return 'pending';
    const override = state.manualOverrides?.[nodeId];
    if (STATUSES.includes(override)) return override;
    const autoStatus = state.progress?.[nodeId]?.status;
    if (STATUSES.includes(autoStatus)) return autoStatus;
    return 'pending';
  }

  function isNodeClosed(state, nodeId) {
    const st = getNodeStatus(state, nodeId);
    return st === 'completed' || st === 'skipped';
  }

  function isNodeUnlocked(state, nodeId) {
    const node = getNode(state, nodeId);
    if (!node) return false;
    const track = getTrack(state, node.trackId);
    if (track?.paused) return false;

    const chapters = state?.plan?.chapters || [];
    const curIndex = chapters.findIndex(c => c.id === state?.currentChapterId);
    const nodeChIds = node.chapterIds || [];
    if (nodeChIds.length && curIndex >= 0) {
      if ((track?.kind || 'main') === 'main') {
        if (!nodeChIds.includes(state.currentChapterId)) return false;
      } else {
        const earliest = nodeChIds
          .map(cid => chapters.findIndex(c => c.id === cid))
          .filter(i => i >= 0)
          .reduce((min, i) => Math.min(min, i), Infinity);
        if (earliest !== Infinity && curIndex < earliest) return false;
      }
    }

    for (const depId of node.dependencies || []) {
      if (getNode(state, depId) && !isNodeClosed(state, depId)) return false;
    }
    return true;
  }

  function getChapterProgress(state, chapterId) {
    const chapters = state?.plan?.chapters || [];
    const ch = chapters.find(c => c.id === (chapterId || state?.currentChapterId));
    if (!ch) return { requiredIds: [], doneCount: 0, totalCount: 0, allDone: false };

    const trackMap = new Map((state?.plan?.tracks || []).map(t => [t.id, t]));
    const chNodes = getChapterNodes(state, ch.id);
    const mainNodes = chNodes.filter(n => (trackMap.get(n.trackId)?.kind || 'main') === 'main');

    // 优先取本章必做主线节点；若无标记必做，则回退到本章全部主线节点；再无则取本章必做节点（彻底杜绝空门槛卡章）
    let gateNodes = mainNodes.filter(n => n.required !== false);
    if (!gateNodes.length) gateNodes = mainNodes;
    if (!gateNodes.length) gateNodes = chNodes.filter(n => n.required !== false);
    if (!gateNodes.length) gateNodes = chNodes;

    const requiredIds = gateNodes.map(n => n.id);
    const doneCount = requiredIds.filter(id => isNodeClosed(state, id)).length;
    return {
      requiredIds,
      doneCount,
      totalCount: requiredIds.length,
      allDone: requiredIds.length > 0 && doneCount === requiredIds.length
    };
  }

  function advanceChapter(state) {
    const next = normalizeState(state, state?.originChatId);
    const chapters = next.plan.chapters || [];
    if (!chapters.length) return next;
    let idx = chapters.findIndex(c => c.id === next.currentChapterId);
    if (idx < 0) idx = 0;
    next.currentChapterId = chapters[idx].id;

    let guard = chapters.length;
    while (idx < chapters.length - 1 && guard-- > 0) {
      const prog = getChapterProgress(next, chapters[idx].id);
      if (!prog.allDone) break;
      idx += 1;
      next.currentChapterId = chapters[idx].id;
    }
    return next;
  }

  function isOutlineFinished(state) {
    const chapters = state?.plan?.chapters || [];
    if (!chapters.length) return false;
    const lastChapter = chapters[chapters.length - 1];
    if (state.currentChapterId !== lastChapter.id) return false;
    const lastProg = getChapterProgress(state, lastChapter.id);
    if (!lastProg.allDone) return false;
    // 若非暂停剧情线上还有未关闭的必做节点，则仍未完结
    const trackMap = new Map((state?.plan?.tracks || []).map(t => [t.id, t]));
    const hasOpenRequired = (state?.plan?.nodes || []).some(n => {
      if (n.required !== true) return false;
      if (trackMap.get(n.trackId)?.paused) return false;
      return !isNodeClosed(state, n.id);
    });
    return !hasOpenRequired;
  }

  // 0ms 按楼层号本地回退：删楼/滑动/重Roll 时直接裁剪 layer > maxValidLayer 的自动进度并重算当前章节，永不锁死
  function rollbackAfterLayer(state, maxValidLayer) {
    const next = normalizeState(state, state?.originChatId);
    const limit = Number.isFinite(Number(maxValidLayer)) ? parseInt(maxValidLayer, 10) : -1;
    let removedCount = 0;
    for (const [nodeId, entry] of Object.entries(next.progress || {})) {
      if (entry && entry.layer !== null && entry.layer !== undefined && Number(entry.layer) > limit) {
        delete next.progress[nodeId];
        removedCount += 1;
      }
    }
    if (next.tracking.checkedLayer !== null && next.tracking.checkedLayer > limit) {
      next.tracking.checkedLayer = limit >= 0 ? limit : null;
      next.tracking.roundsSinceCheck = 0;
      next.tracking.lastDigest = '';
    }
    if (next.tracking.anchorLayer !== null && next.tracking.anchorLayer > limit) {
      next.tracking.anchorLayer = limit >= 0 ? limit : null;
    }
    if (removedCount > 0) {
      next.tracking.lastDigest = '';
    }
    const prevCh = next.currentChapterId;
    if (next.plan.chapters.length) {
      next.currentChapterId = next.plan.chapters[0].id;
    }
    const replayed = advanceChapter(next);
    return {
      state: replayed,
      removedCount,
      chapterChanged: replayed.currentChapterId !== prevCh
    };
  }

  function commitPlan(rawPlan, expectedRevision, chatIdOverride) {
    const chatId = clean(chatIdOverride) || getChatId();
    const current = loadState(chatId);
    if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== current.revision) {
      throw new Error(`大纲版本已变更（期望 r${expectedRevision}，当前 r${current.revision}），请刷新后重试`);
    }
    const check = validatePlan(rawPlan);
    if (!check.valid) {
      throw new Error(`大纲校验失败：${check.errors.join('；')}`);
    }
    const nextPlan = normalizePlan(rawPlan);
    const changed = JSON.stringify(nextPlan) !== JSON.stringify(current.plan);
    if (!changed) return current;

    const next = normalizeState({
      ...current,
      revision: current.revision + 1,
      plan: nextPlan,
      tracking: {
        ...current.tracking,
        roundsSinceCheck: 0,
        lastDigest: ''
      }
    }, chatId);
    return saveState(advanceChapter(next), chatId);
  }

  function setNodeStatus(nodeId, status, chatIdOverride) {
    const chatId = clean(chatIdOverride) || getChatId();
    const state = loadState(chatId);
    if (!getNode(state, nodeId)) return state;
    if (!status || status === 'auto') {
      delete state.manualOverrides[nodeId];
    } else if (STATUSES.includes(status)) {
      state.manualOverrides[nodeId] = status;
    }
    return saveState(advanceChapter(state), chatId);
  }

  function setCurrentChapter(chapterId, chatIdOverride) {
    const chatId = clean(chatIdOverride) || getChatId();
    const state = loadState(chatId);
    if (!(state.plan.chapters || []).some(c => c.id === chapterId)) return state;
    state.currentChapterId = chapterId;
    state.tracking.lastDigest = '';
    return saveState(state, chatId);
  }

  function clearOutlineData(chatIdOverride) {
    const chatId = clean(chatIdOverride) || getChatId();
    const fresh = defaultState(chatId);
    return saveState(fresh, chatId);
  }

  function exportData(chatIdOverride) {
    const chatId = clean(chatIdOverride) || getChatId();
    const state = loadState(chatId);
    return {
      __outlineEngineExport: true,
      schemaVersion: SCHEMA_VERSION,
      chatId,
      exportedAt: Date.now(),
      state: clone(state)
    };
  }

  function importData(payload, options = {}, chatIdOverride) {
    const chatId = clean(chatIdOverride) || getChatId();
    const src = payload?.state || payload;
    const rawPlan = src?.plan || (Array.isArray(payload?.chapters) ? payload : null);
    if (!rawPlan || !Array.isArray(rawPlan.chapters)) {
      throw new Error('导入文件格式无效：缺少 plan.chapters 数组');
    }
    const check = validatePlan(rawPlan);
    if (!check.valid) {
      throw new Error(`导入大纲校验失败：${check.errors.join('；')}`);
    }
    const current = loadState(chatId);
    const sameChat = clean(payload?.chatId || src?.originChatId) === chatId;
    const keepProgress = sameChat && options.includeProgress !== false;
    const nextRev = Math.max(current.revision + 1, Number(src?.revision) || 1);
    const nextState = normalizeState({
      schemaVersion: SCHEMA_VERSION,
      revision: nextRev,
      originChatId: chatId,
      plan: rawPlan,
      currentChapterId: keepProgress ? src?.currentChapterId : null,
      progress: keepProgress ? (src?.progress || undefined) : {},
      progressEvents: keepProgress && !src?.progress ? src?.progressEvents : undefined,
      clues: keepProgress ? src?.clues : undefined,
      manualOverrides: keepProgress ? (src?.manualOverrides || {}) : {},
      tracking: keepProgress ? (src?.tracking || {}) : {}
    }, chatId);
    return saveState(advanceChapter(nextState), chatId);
  }

  return {
    SCHEMA_VERSION,
    STATE_PREFIX,
    V2_STATE_PREFIX,
    LEGACY_STATE_PREFIX,
    STATUSES,
    TRACK_KINDS,
    getChatId,
    storageKey,
    emptyPlan,
    defaultState,
    normalizePlan,
    normalizeState,
    validatePlan,
    loadState,
    saveState,
    commitPlan,
    getNode,
    getTrack,
    getChapterNodes,
    getTrackNodes,
    getNodeStatus,
    isNodeClosed,
    isNodeUnlocked,
    getChapterProgress,
    advanceChapter,
    isOutlineFinished,
    rollbackAfterLayer,
    setNodeStatus,
    setCurrentChapter,
    clearOutlineData,
    exportData,
    importData
  };
})();
