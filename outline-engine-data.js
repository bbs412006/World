// 计划与已发生事实分开存储；进度仅是带来源的判断及用户的明确覆盖。
window.OUTLINE_ENGINE_DATA = (function() {
  const SCHEMA_VERSION = 1;
  const STATE_PREFIX = 'outline_engine_state_';
  const STATUSES = Object.freeze(['pending', 'active', 'completed', 'skipped', 'blocked']);
  const clean = value => String(value == null ? '' : value).trim();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const text = value => Array.isArray(value) ? value.map(clean).filter(Boolean).join('\n') : clean(value);
  let sequence = 0;
  function getChatId() {
    const fromCore = window.WORLD_ENGINE_CORE?.getChatId?.();
    if (fromCore) return clean(fromCore);
    try { return clean(SillyTavern.getContext()?.chatId) || 'default'; }
    catch (_) { return 'default'; }
  }
  function newId(prefix, used) {
    let id;
    do { id = `${prefix}_${Date.now().toString(36)}_${(++sequence).toString(36)}`; } while (used.has(id));
    return id;
  }
  function normalizePlan(value) {
    const source = object(value) ? value : {};
    const used = new Set();
    const id = (value, prefix) => {
      let result = clean(value);
      if (!result || used.has(result)) result = newId(prefix, used);
      used.add(result);
      return result;
    };
    return {
      title: text(source.title), synopsis: text(source.synopsis), constraints: text(source.constraints),
      chapters: (Array.isArray(source.chapters) ? source.chapters : []).filter(object).map(chapter => ({
        id: id(chapter.id, 'chapter'), title: text(chapter.title), goal: text(chapter.goal),
        nodes: (Array.isArray(chapter.nodes) ? chapter.nodes : []).filter(object).map(node => ({
          id: id(node.id, 'node'), title: text(node.title), intent: text(node.intent),
          completionCriteria: text(node.completionCriteria), notes: text(node.notes), required: node.required !== false
        }))
      }))
    };
  }
  function defaultState(chatId) {
    return {
      schemaVersion: SCHEMA_VERSION, revision: 0, originChatId: clean(chatId || getChatId()),
      plan: normalizePlan({}), currentChapterId: '', progressEvents: [], manualOverrides: {}, proposals: [],
      tracking: { anchorLayer: null, checkedLayer: null, roundsSinceCheck: 0, lastDigest: '' }
    };
  }
  function nodesById(plan) {
    return new Map(plan.chapters.flatMap(chapter => chapter.nodes.map(node => [node.id, { chapter, node }])));
  }
  function normalizedRefs(values) {
    return (Array.isArray(values) ? values : []).filter(object).map(ref => ({
      chatId: clean(ref.chatId), messageId: clean(ref.messageId),
      layer: Number.isFinite(Number(ref.layer)) ? Number(ref.layer) : 0,
      role: clean(ref.role), swipeId: Math.max(0, parseInt(ref.swipeId, 10) || 0), hash: clean(ref.hash),
      ...(ref.synthetic === true ? { synthetic: true } : {})
    }));
  }
  function normalizedEvidence(values) {
    return (Array.isArray(values) ? values : []).filter(object).map(item => ({
      messageId: clean(item.messageId), quote: clean(item.quote),
      ...(item.hash != null ? { hash: clean(item.hash) } : {}),
      ...(Number.isFinite(Number(item.layer)) ? { layer: Number(item.layer) } : {})
    }));
  }
  function normalizedNodeSnapshot(value) {
    if (!object(value)) return null;
    return { id: clean(value.id), title: text(value.title), intent: text(value.intent),
      completionCriteria: text(value.completionCriteria), notes: text(value.notes), required: value.required !== false };
  }
  function normalizedRecord(source, proposal) {
    const result = {
      id: clean(source.id), nodeId: clean(source.nodeId),
      status: clean(source.status || source.result),
      planRevision: Math.max(0, parseInt(source.planRevision, 10) || 0),
      sourceRefs: normalizedRefs(source.sourceRefs), sourceDigest: clean(source.sourceDigest),
      evidence: normalizedEvidence(source.evidence), createdAt: Math.max(0, Number(source.createdAt) || 0)
    };
    for (const key of ['staleReason', 'invalidationReason']) if (source[key] != null) result[key] = clean(source[key]);
    if (proposal) {
      result.kind = clean(source.kind);
      result.chapterId = clean(source.chapterId);
      result.reason = clean(source.reason);
      result.status = ['pending', 'stale', 'accepted', 'dismissed', 'rejected'].includes(source.status) ? source.status : 'stale';
      if (source.kind === 'update_chapter') {
        const snapshot = value => object(value) ? { title: text(value.title), goal: text(value.goal) } : null;
        result.before = snapshot(source.before);
        result.after = snapshot(source.after);
      } else {
        result.before = normalizedNodeSnapshot(source.before);
        result.after = normalizedNodeSnapshot(source.after);
      }
    } else {
      result.nodeRevision = clean(source.nodeRevision);
      result.validity = source.validity === 'valid' && source.stale !== true && source.valid !== false ? 'valid' : 'stale';
      result.beforeChapterId = clean(source.beforeChapterId);
      result.layer = Number.isFinite(Number(source.layer)) ? Number(source.layer) : 0;
    }
    return result;
  }
  function normalizeState(value, chatId) {
    const source = object(value) ? value : {};
    const base = defaultState(chatId);
    // 只保存正式数据字段，导入中的旧 API 配置、调试结果或其他未知字段不能进入聊天缓存。
    const next = { ...base };
    next.revision = Math.max(0, parseInt(source.revision, 10) || 0);
    next.originChatId = clean(source.originChatId || chatId || getChatId());
    next.plan = normalizePlan(source.plan);
    next.currentChapterId = next.plan.chapters.some(chapter => chapter.id === source.currentChapterId)
      ? source.currentChapterId : (next.plan.chapters[0]?.id || '');
    next.progressEvents = (Array.isArray(source.progressEvents) ? source.progressEvents : []).filter(object).map(item => normalizedRecord(item, false));
    next.proposals = (Array.isArray(source.proposals) ? source.proposals : []).filter(object).map(item => normalizedRecord(item, true));
    const ids = nodesById(next.plan);
    next.manualOverrides = {};
    for (const [id, value] of Object.entries(object(source.manualOverrides) ? source.manualOverrides : {})) {
      const status = typeof value === 'string' ? value : value?.status;
      if (ids.has(id) && STATUSES.includes(status)) next.manualOverrides[id] = {
        status, ...(object(value) && value.updatedAt != null ? { updatedAt: Math.max(0, Number(value.updatedAt) || 0) } : {}),
        ...(object(value) && value.planRevision != null ? { planRevision: Math.max(0, parseInt(value.planRevision, 10) || 0) } : {})
      };
    }
    const tracking = object(source.tracking) ? source.tracking : {};
    next.tracking = { ...base.tracking };
    for (const key of ['anchorLayer', 'checkedLayer', 'roundsSinceCheck', 'lastDigest']) if (tracking[key] != null) next.tracking[key] = tracking[key];
    for (const key of ['anchorMessageId', 'lastProcessedMessageKey']) if (tracking[key] != null) next.tracking[key] = clean(tracking[key]);
    if (Array.isArray(tracking.seenAssistantIds)) next.tracking.seenAssistantIds = [...new Set(tracking.seenAssistantIds.map(clean).filter(Boolean))];
    if (tracking.pendingRecheck != null) next.tracking.pendingRecheck = tracking.pendingRecheck === true;
    if (tracking.recheckStartLayer != null) next.tracking.recheckStartLayer = Number.isFinite(Number(tracking.recheckStartLayer)) ? Number(tracking.recheckStartLayer) : null;
    for (const key of ['anchorLayer', 'checkedLayer']) {
      const value = next.tracking[key];
      next.tracking[key] = value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
    }
    next.tracking.roundsSinceCheck = Math.max(0, parseInt(next.tracking.roundsSinceCheck, 10) || 0);
    next.tracking.lastDigest = clean(next.tracking.lastDigest);
    return next;
  }
  function loadState(chatId) {
    const id = clean(chatId || getChatId());
    let value;
    try { value = JSON.parse(window.WORLD_ENGINE_STORE?.getItem(STATE_PREFIX + id) || 'null'); }
    catch (_) { value = null; }
    return normalizeState(value, id);
  }
  function saveState(state, chatId) {
    const id = clean(chatId || getChatId());
    const next = normalizeState(state, id);
    window.WORLD_ENGINE_STORE?.setItem(STATE_PREFIX + id, JSON.stringify(next));
    return clone(next);
  }
  function getNodeStatus(state, nodeId) {
    const found = nodesById(state?.plan || { chapters: [] }).get(nodeId);
    if (!found) return 'pending';
    const override = state.manualOverrides?.[nodeId];
    const manual = typeof override === 'string' ? override : override?.status;
    if (STATUSES.includes(manual)) return manual;
    let status = 'pending';
    for (const event of state.progressEvents || []) {
      if (event.nodeId !== nodeId || event.validity === 'stale' || event.validity === 'invalid' || event.stale === true || event.valid === false) continue;
      if (event.planRevision != null && Number(event.planRevision) !== Number(state.revision)) continue;
      const candidate = event.status || event.result;
      if (!STATUSES.includes(candidate)) continue;
      // 没有可验证完成条件的节点，只能由用户明确完成。
      if (candidate === 'completed' && !clean(found.node.completionCriteria)) continue;
      status = candidate;
    }
    return status;
  }
  function semanticSignature(entry) {
    return JSON.stringify({ node: entry.node, chapterGoal: entry.chapter.goal });
  }
  function commitPlan(plan, expectedRevision) {
    const chatId = getChatId(), before = loadState(chatId);
    if (expectedRevision != null && Number(expectedRevision) !== before.revision) throw new Error('大纲已在其他操作中修改，请刷新后重试');
    const nextPlan = normalizePlan(plan);
    if (JSON.stringify(nextPlan) === JSON.stringify(before.plan)) return before;
    const oldNodes = nodesById(before.plan), newNodes = nodesById(nextPlan);
    const unchanged = new Set([...newNodes].filter(([id, entry]) => oldNodes.has(id)
      && semanticSignature(entry) === semanticSignature(oldNodes.get(id))).map(([id]) => id));
    const next = { ...before, revision: before.revision + 1, plan: nextPlan };
    next.progressEvents = before.progressEvents.map(event => unchanged.has(event.nodeId) && event.validity !== 'stale'
      ? { ...event, planRevision: next.revision }
      : { ...event, validity: 'stale', invalidationReason: 'plan_changed' });
    // 人工完成是用户的明确决定；保留仍存在节点的人工覆盖，不让模型或标题编辑撤销它。
    next.manualOverrides = Object.fromEntries(Object.entries(before.manualOverrides).filter(([id]) => newNodes.has(id)));
    next.proposals = before.proposals.map(proposal => proposal.status === 'pending' || !proposal.status
      ? { ...proposal, status: 'stale', invalidationReason: 'plan_changed' } : proposal);
    if (!nextPlan.chapters.some(chapter => chapter.id === next.currentChapterId)) next.currentChapterId = nextPlan.chapters[0]?.id || '';
    next.tracking = { ...next.tracking, lastDigest: '', roundsSinceCheck: 0, pendingRecheck: true };
    return saveState(next, chatId);
  }
  function setNodeStatus(nodeId, status) {
    const state = loadState();
    if (!nodesById(state.plan).has(nodeId)) throw new Error('剧情节点不存在');
    if (status == null || status === 'auto') delete state.manualOverrides[nodeId];
    else {
      if (!STATUSES.includes(status)) throw new Error('不支持的剧情节点状态');
      state.manualOverrides[nodeId] = { status, updatedAt: Date.now(), planRevision: state.revision };
    }
    return saveState(state);
  }
  function setCurrentChapter(id) {
    const state = loadState();
    if (!state.plan.chapters.some(chapter => chapter.id === id)) throw new Error('章节不存在');
    state.currentChapterId = id;
    return saveState(state);
  }
  function advanceChapter(state) {
    const next = normalizeState(state);
    const index = next.plan.chapters.findIndex(chapter => chapter.id === next.currentChapterId);
    const chapter = next.plan.chapters[index];
    const required = chapter?.nodes.filter(node => node.required !== false) || [];
    // 空章与只有可选节点的章节不自动跳过，用户可以手动选章。
    if (required.length && required.every(node => ['completed', 'skipped'].includes(getNodeStatus(next, node.id)))) {
      next.currentChapterId = next.plan.chapters[index + 1]?.id || next.currentChapterId;
    }
    return next;
  }
  function exportData() {
    return { __outlineEngineData: true, format: 'outline-full-backup', schemaVersion: SCHEMA_VERSION,
      chatId: getChatId(), exportedAt: new Date().toISOString(), state: loadState() };
  }
  function importData(payload, options) {
    if (!object(payload)) throw new Error('不是有效的大纲文件');
    const full = object(payload.state) ? payload.state : null;
    const plan = full?.plan || payload.plan || payload;
    if (!object(plan) || !Array.isArray(plan.chapters)) throw new Error('大纲文件缺少章节列表');
    const chatId = getChatId(), current = loadState(chatId);
    const sourceChatId = clean(payload.chatId || full?.originChatId);
    const keepProgress = Boolean(full && sourceChatId === chatId && options?.includeProgress !== false);
    const next = keepProgress ? normalizeState(full, chatId) : defaultState(chatId);
    next.plan = normalizePlan(plan);
    next.revision = Math.max(current.revision + 1, next.revision);
    next.originChatId = chatId;
    if (keepProgress) {
      next.progressEvents = next.progressEvents.map(event => ({ ...event, planRevision: next.revision }));
      next.proposals = next.proposals.map(proposal => ({ ...proposal, planRevision: next.revision }));
    } else {
      // 跨聊天的剧情不能把旧聊天的完成结论当作本聊天已经发生的事实。
      next.currentChapterId = next.plan.chapters[0]?.id || '';
    }
    return saveState(next, chatId);
  }
  return { SCHEMA_VERSION, STATE_PREFIX, STATUSES, getChatId, defaultState, normalizePlan, normalizeState,
    loadState, saveState, commitPlan, getNodeStatus, setNodeStatus, setCurrentChapter, advanceChapter, exportData, importData };
})();
