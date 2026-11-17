// 剧情大纲运行时：未来安排只作指导；节点进度只接受可复核的原文证据。
window.OUTLINE_ENGINE = (function() {
  const INJECTION_NAME = 'outline-engine-outline';
  const clean = value => String(value == null ? '' : value).trim();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const settings = () => window.OUTLINE_ENGINE_SETTINGS.getSettings(true);
  const data = () => window.OUTLINE_ENGINE_DATA;
  const timeline = () => window.MEMORY_ENGINE_TIMELINE;
  const prompts = () => window.OUTLINE_ENGINE_PROMPT;
  let initialized = false, currentChatId = '', sessionToken = 0;
  let request = null, autoTimer = null, generationInProgress = false, generationType = '';
  let lastAutoAttemptKey = '';
  let lastError = '', lastDebug = null;
  const injectionDebug = { narrative: null, world: null };

  function context() { try { return SillyTavern.getContext(); } catch (_) { return null; } }
  function chatId() { return clean(context()?.chatId || window.WORLD_ENGINE_CORE?.getChatId?.() || 'default'); }
  function chat() { return context()?.chat || []; }
  function currentLayer() { return Math.max(0, chat().length - 1); }
  function refresh() {
    try { window.OUTLINE_ENGINE_UI?.refresh?.(); } catch (error) { console.warn('[剧情大纲] 刷新界面失败', error); }
    try { window.WORLD_ENGINE_UI?.refresh?.(true); } catch (_) { /* 界面故障不影响进度。 */ }
  }
  function hash(value) { return timeline().hashText(typeof value === 'string' ? value : JSON.stringify(value)); }
  function chapterOf(state) { return state.plan?.chapters?.find(item => item.id === state.currentChapterId) || null; }
  function nodeStatus(state, id) { return data().getNodeStatus(state, id); }
  function manualOverride(state, id) { return Object.prototype.hasOwnProperty.call(state.manualOverrides || {}, id); }
  function isFinished(state) {
    const chapters = state.plan?.chapters || [], chapter = chapterOf(state);
    const required = chapter?.nodes.filter(node => node.required !== false) || [];
    return chapters[chapters.length - 1]?.id === chapter?.id && required.length > 0 &&
      required.every(node => ['completed', 'skipped'].includes(nodeStatus(state, node.id)));
  }
  function basisDigest(state) {
    return hash({ revision: state.revision, plan: state.plan, chapter: state.currentChapterId,
      manual: state.manualOverrides || {}, events: (state.progressEvents || []).filter(item => item.validity === 'valid') });
  }
  function abort() {
    sessionToken++;
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    const previous = request;
    request = null;
    if (previous) previous.controller.abort();
  }
  function ensureChat() {
    const id = chatId();
    if (id !== currentChatId) {
      abort(); currentChatId = id; generationInProgress = false; generationType = ''; lastAutoAttemptKey = '';
    }
    return id;
  }
  function assistantRefs() {
    const ignoreOpening = settings().firstLayerIsAiOpening !== false;
    return timeline().captureRange(0, Math.max(0, chat().length - 1)).filter(ref => {
      const message = chat()[ref.layer];
      return message && !message.is_user && clean(message.mes) && !(ignoreOpening && ref.layer === 0);
    });
  }
  function activate(state) {
    if (state.tracking?.anchorLayer != null) return state;
    const refs = assistantRefs();
    state.tracking = { ...(state.tracking || {}), anchorLayer: currentLayer(), checkedLayer: currentLayer(),
      anchorMessageId: refs[refs.length - 1]?.messageId || '', seenAssistantIds: refs.map(ref => ref.messageId),
      roundsSinceCheck: 0, lastDigest: '', pendingRecheck: false };
    data().saveState(state);
    return state;
  }
  function clearInjection() {
    try {
      const ctx = context();
      if (typeof ctx?.setExtensionPrompt === 'function') ctx.setExtensionPrompt(INJECTION_NAME, '', 1, 1);
      else if (typeof ctx?.unregisterInjection === 'function') ctx.unregisterInjection(INJECTION_NAME);
      else if (Array.isArray(ctx?.extensionPrompts)) ctx.extensionPrompts = ctx.extensionPrompts.filter(item => item.name !== INJECTION_NAME);
    } catch (error) { console.warn('[剧情大纲] 清除注入失败（已隔离）', error); }
  }
  function registerInjection(content) {
    const ctx = context();
    if (typeof ctx?.setExtensionPrompt === 'function') ctx.setExtensionPrompt(INJECTION_NAME, content, 1, 1);
    else if (typeof ctx?.registerInjection === 'function') {
      ctx.unregisterInjection?.(INJECTION_NAME);
      ctx.registerInjection(INJECTION_NAME, content, { position: 1, depth: 1, role: 'system' });
    } else if (Array.isArray(ctx?.extensionPrompts)) {
      ctx.extensionPrompts = ctx.extensionPrompts.filter(item => item.name !== INJECTION_NAME);
      ctx.extensionPrompts.push({ name: INJECTION_NAME, content, role: 'system', position: 1, depth: 1 });
    }
  }

  function validateSavedSources(record) {
    const refs = Array.isArray(record.sourceRefs) ? record.sourceRefs : [];
    // 记忆时间链允许封存 foreign/synthetic 历史；大纲自动判断不能以它们替代本聊天原文。
    if (!refs.length || refs.some(ref => !ref || ref.synthetic === true || clean(ref.chatId) !== chatId() || !clean(ref.messageId) || !clean(ref.hash))) return false;
    const audit = timeline().auditRefs(refs);
    if (!audit.valid || audit.synthetic || audit.inherited || timeline().digestRefs(refs) !== clean(record.sourceDigest)) return false;
    const current = new Map(audit.refs.map(ref => [ref.messageId, ref]));
    if (!Array.isArray(record.evidence) || !record.evidence.length) return false;
    return record.evidence.every(proof => {
      const ref = current.get(clean(proof?.messageId)), quote = clean(proof?.quote);
      return ref && quote && clean(proof.hash) === clean(ref.hash) && String(chat()[ref.layer]?.mes || '').includes(quote);
    });
  }

  // 全部是本地审计：生成前不启动 API，也不触碰世界事实或人物记忆。
  function auditHistory() {
    ensureChat();
    let state = data().loadState(), changed = false;
    const events = state.progressEvents || [];
    let firstInvalid = -1;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.validity !== 'valid' || Number(event.planRevision) !== Number(state.revision)) continue;
      if (!['active', 'completed', 'blocked'].includes(event.status) || !validateSavedSources(event)) { firstInvalid = i; break; }
    }
    if (firstInvalid !== -1) {
      const first = events[firstInvalid];
      for (let i = firstInvalid; i < events.length; i++) {
        if (events[i].validity === 'valid') { events[i].validity = 'stale'; events[i].staleReason = 'source_changed'; }
      }
      if (state.plan.chapters.some(chapter => chapter.id === first.beforeChapterId)) state.currentChapterId = first.beforeChapterId;
      state.tracking = { ...(state.tracking || {}), pendingRecheck: true, lastDigest: '', roundsSinceCheck: 0,
        checkedLayer: Math.max(-1, Number(first.layer) - 1),
        recheckStartLayer: Math.min(...(first.sourceRefs || []).map(ref => Number(ref.layer) || 0), Number(first.layer) || 0) };
      state = data().advanceChapter(state);
      changed = true;
    }
    for (const proposal of state.proposals || []) {
      if (proposal.status !== 'pending') continue;
      if (Number(proposal.planRevision) !== Number(state.revision) || !validateSavedSources(proposal) ||
          (firstInvalid !== -1 && Number(proposal.createdAt) >= Number(events[firstInvalid].createdAt))) {
        proposal.status = 'stale'; changed = true;
      }
    }
    const advanced = data().advanceChapter(state);
    if (advanced.currentChapterId !== state.currentChapterId) { state = advanced; changed = true; }
    if (changed) { abort(); data().saveState(state); }
    return { state, changed };
  }

  function guidance(target, worldState) {
    ensureChat();
    injectionDebug[target] = { chars: 0 };
    const config = settings();
    if (config.engineEnabled !== true || (target === 'narrative' ? config.injectIntoPrompt === false : config.injectIntoWorldEngine === false)) return '';
    const state = activate(auditHistory().state), chapter = chapterOf(state);
    if (!chapter || isFinished(state)) return '';
    const nodes = (chapter.nodes || []).filter(node => !['completed', 'skipped'].includes(nodeStatus(state, node.id)));
    if (!nodes.length) return '';
    const limit = Math.max(200, Number(config.injectMaxChars) || 2500);
    const head = `【剧情指导】\n这是柔性未来安排，不是已经发生的世界事实或人物知情。尊重既有事实、能力及知情边界；保留主角选择，不预定成败，缺条件先铺垫。\n`;
    const purpose = target === 'world'
      ? '世界继续独立演化；大纲目标不得冒充事实、世界摘要或人物记忆。\n'
      : '自然呈现机会和线索，不复述大纲、不提前揭晓幕后安排。\n';
    const nodeBlock = node => `- ${clean(node.title)}：${clean(node.intent)}${node.completionCriteria ? `；达成条件：${clean(node.completionCriteria)}` : '；条件未指定，仅用户可确认完成'}${node.notes ? `；备注：${clean(node.notes)}` : ''}\n`;
    // 预算约束只裁可选内容；核心作者约束和当前节点必须完整，不能在句中被截掉。
    let result = head + purpose + `当前章节：${clean(chapter.title)}\n`;
    if (state.plan.constraints) result += `作者约束：${clean(state.plan.constraints)}\n`;
    result += '当前节点：\n' + nodeBlock(nodes[0]);
    for (const extra of [chapter.goal ? `章节目标：${clean(chapter.goal)}\n` : '',
      state.plan.synopsis ? `故事方向：${clean(state.plan.synopsis)}\n` : '', ...nodes.slice(1).map(nodeBlock)]) {
      if (result.length + extra.length <= limit) result += extra;
    }
    // worldState 只读，由原有推演路径注入实际状态；此处绝不把它改成大纲结果。
    injectionDebug[target] = { chars: result.length, budget: limit, overBudget: result.length > limit,
      chapterId: chapter.id, revision: state.revision };
    return result;
  }
  function buildNarrativeGuidance() { return guidance('narrative'); }
  function buildWorldGuidance(worldState) { return guidance('world', worldState); }
  function applyInjection() {
    try {
      const content = buildNarrativeGuidance();
      if (content) registerInjection(content); else clearInjection();
      return content;
    } catch (error) {
      clearInjection(); console.warn('[剧情大纲] 注入失败（已隔离）', error); return '';
    }
  }
  async function prepareHistoryForGeneration() {
    if (!settings().engineEnabled) { clearInjection(); return { changed: false }; }
    const result = auditHistory();
    applyInjection();
    return { changed: result.changed };
  }

  function requestSettings() {
    const own = settings();
    if (!['world', 'custom'].includes(own.apiSource)) throw new Error('请选择大纲 API 来源');
    const source = own.apiSource === 'world' ? window.WORLD_ENGINE_API.getSettings(true) : own;
    const result = {};
    for (const key of ['apiUrl', 'apiKey', 'model', 'connectionMode', 'temperature', 'maxTokens', 'apiTimeoutMs']) result[key] = source[key];
    if (!clean(result.apiUrl) || !clean(result.model)) throw new Error(own.apiSource === 'custom' ? '请完整配置大纲自定义 API 地址和模型' : '世界 API 地址或模型尚未配置');
    return result;
  }
  function beginRequest(label, state, refs) {
    if (request) throw new Error('大纲已有任务正在运行');
    if (generationInProgress) throw new Error('正文正在生成，请在回复完成后检查大纲');
    const options = requestSettings();
    const task = { controller: new AbortController(), token: sessionToken, chatId: chatId(),
      revision: state.revision, basis: basisDigest(state), refs: clone(refs || []),
      sourceDigest: timeline().digestRefs(refs || []), apiSource: settings().apiSource, options, label };
    request = task; lastError = ''; refresh();
    return task;
  }
  function isCurrent(task, checkSources) {
    if (request !== task || task.controller.signal.aborted || task.token !== sessionToken || task.chatId !== chatId() || generationInProgress || !settings().engineEnabled) return false;
    const state = data().loadState();
    if (Number(state.revision) !== Number(task.revision) || basisDigest(state) !== task.basis) return false;
    try { if (settings().apiSource !== task.apiSource || hash(requestSettings()) !== hash(task.options)) return false; }
    catch (_) { return false; }
    if (checkSources && (!timeline().auditRefs(task.refs).valid || timeline().digestRefs(timeline().auditRefs(task.refs).refs) !== task.sourceDigest ||
        timeline().digestRefs(selectSources(state).refs) !== task.sourceDigest)) return false;
    return true;
  }
  async function invoke(task, prompt) {
    lastDebug = { kind: task.label, prompt, rawResult: '', sourceDigest: task.sourceDigest, chatId: task.chatId, revision: task.revision };
    const retries = Math.max(0, Number(settings().apiAutoRetries) || 0);
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await window.WORLD_ENGINE_API.callApi(prompt, task.options.maxTokens, task.options.temperature, task.controller.signal, { ...task.options });
        if (request === task) lastDebug.rawResult = raw;
        return raw;
      } catch (error) {
        if (task.controller.signal.aborted || attempt >= retries || !isCurrent(task, task.refs.length > 0)) throw error;
      }
    }
  }
  function finish(task) { if (request === task) { request = null; refresh(); } }
  async function organizeText(text) {
    ensureChat();
    if (!settings().engineEnabled) throw new Error('请先启用剧情大纲');
    if (!clean(text)) throw new Error('请输入需要整理的大纲文本');
    const state = activate(data().loadState()), task = beginRequest('整理大纲', state, []);
    try {
      const raw = await invoke(task, prompts().buildOrganizePrompt(clean(text)));
      if (!isCurrent(task, false)) throw new Error('聊天或大纲已变化，整理结果已丢弃');
      return prompts().parseOrganizeResponse(raw);
    } catch (error) { lastError = clean(error.message || error); throw error; }
    finally { finish(task); }
  }

  function selectSources(state) {
    const refs = assistantRefs(), count = Math.max(1, Number(settings().checkEveryX) || 3);
    if (!refs.length) return { refs: [], messages: [] };
    const selected = refs.slice(-count), first = selected[0].layer;
    let start = first;
    // 一轮包括 AI 回复及其前面的用户输入，但不把上一条 AI 回复混入。
    while (start > 0 && chat()[start - 1]?.is_user) start--;
    if (state.tracking?.pendingRecheck && Number.isFinite(Number(state.tracking.recheckStartLayer))) start = Math.min(start, Math.max(0, Number(state.tracking.recheckStartLayer)));
    const captured = timeline().captureRange(start, refs[refs.length - 1].layer);
    return { refs: captured, messages: captured.map(ref => ({ messageId: ref.messageId, hash: ref.hash, layer: ref.layer,
      role: ref.role, name: clean(chat()[ref.layer]?.name), content: String(chat()[ref.layer]?.mes || '') })) };
  }
  function referenceContext() {
    const parts = [];
    try {
      const world = window.WORLD_ENGINE_CORE?.loadState?.();
      if (world?.worldDigest) parts.push('世界背景（不是节点完成证据）：' + clean(world.worldDigest).slice(0, 1400));
    } catch (_) { /* 参考源可选。 */ }
    try {
      const memory = window.MEMORY_ENGINE_DATA?.loadState?.();
      const summaries = memory?.event_memory?.big_summaries || [];
      const latest = summaries.filter(item => item.status !== 'stale').slice(-1);
      if (latest.length) parts.push('记忆背景（不得作为原文证据）：' + JSON.stringify(latest).slice(0, 1400));
    } catch (_) { /* 不依赖记忆引擎运行。 */ }
    return parts.join('\n');
  }
  function verifiedEvidence(evidence, selection) {
    if (!Array.isArray(evidence) || !evidence.length) return null;
    const messages = new Map(selection.messages.map(item => [item.messageId, item]));
    const refs = new Map(selection.refs.map(item => [item.messageId, item]));
    const result = [];
    for (const proof of evidence) {
      const id = clean(proof?.messageId), quote = clean(proof?.quote), message = messages.get(id), ref = refs.get(id);
      if (!message || !ref || !quote || !message.content.includes(quote) ||
          (proof.hash && clean(proof.hash) !== clean(ref.hash)) || !timeline().auditRefs([ref]).valid) return null;
      result.push({ messageId: id, hash: ref.hash, quote, layer: ref.layer });
    }
    return result;
  }
  function proposalTargetEligible(state, proposal) {
    if (isFinished(state)) return false;
    const chapters = state.plan.chapters;
    const currentIndex = chapters.findIndex(item => item.id === state.currentChapterId);
    const targetIndex = chapters.findIndex(item => item.id === proposal.chapterId);
    if (currentIndex < 0 || targetIndex < currentIndex) return false;
    const chapter = chapters[targetIndex];
    if (proposal.kind === 'update_chapter' || proposal.kind === 'insert_node') return targetIndex > currentIndex;
    if (proposal.kind !== 'replace_node') return false;
    const node = chapter.nodes.find(item => item.id === proposal.nodeId);
    if (!node || ['completed', 'skipped'].includes(nodeStatus(state, node.id))) return false;
    if (targetIndex > currentIndex) return true;
    const executing = chapter.nodes.find(item => !['completed', 'skipped'].includes(nodeStatus(state, item.id)));
    return node.id !== executing?.id && nodeStatus(state, node.id) !== 'active';
  }
  function normalizeProposal(candidate, state, chapter, selection, stamp, index) {
    if (!candidate || !['replace_node', 'insert_node', 'update_chapter'].includes(candidate.kind)) return null;
    if (!proposalTargetEligible(state, candidate)) return null;
    chapter = state.plan.chapters.find(item => item.id === candidate.chapterId);
    if (!chapter) return null;
    const evidence = verifiedEvidence(candidate.evidence, selection);
    if (!evidence || !candidate.after || typeof candidate.after !== 'object' || Array.isArray(candidate.after)) return null;
    let before, after;
    if (candidate.kind === 'update_chapter') {
      before = { title: chapter.title, goal: chapter.goal };
      after = { title: clean(candidate.after.title || chapter.title), goal: clean(candidate.after.goal ?? chapter.goal) };
    } else {
      const original = chapter.nodes.find(node => node.id === candidate.nodeId);
      if (candidate.kind === 'replace_node' && !original) return null;
      before = original ? clone(original) : null;
      const source = { ...(original || {}), ...candidate.after };
      after = { id: original?.id || '', title: clean(source.title), intent: clean(source.intent),
        completionCriteria: clean(source.completionCriteria), notes: clean(source.notes), required: source.required !== false };
      if (!after.title) return null;
    }
    if (JSON.stringify(before) === JSON.stringify(after)) return null;
    return { id: `op_${stamp}_${index}`, kind: candidate.kind, chapterId: chapter.id, nodeId: clean(candidate.nodeId), before, after,
      reason: clean(candidate.reason), evidence, status: 'pending', planRevision: state.revision,
      sourceRefs: clone(selection.refs), sourceDigest: timeline().digestRefs(selection.refs), createdAt: stamp };
  }
  async function runCheck(manual) {
    ensureChat();
    if (!settings().engineEnabled) return { ok: false, reason: 'disabled' };
    if (request) return { ok: false, reason: 'busy' };
    if (generationInProgress) return { ok: false, reason: 'generating' };
    let state = activate(auditHistory().state);
    const chapter = chapterOf(state);
    if (!chapter || !chapter.nodes?.length) return { ok: false, reason: 'no-current-chapter' };
    if (isFinished(state)) return { ok: true, checked: false, reason: 'outline-complete' };
    const selection = selectSources(state);
    if (!selection.refs.length) return { ok: false, reason: 'no-sources' };
    const digest = timeline().digestRefs(selection.refs);
    if (!manual && state.tracking.lastDigest === `${state.revision}:${chapter.id}:${digest}` && !state.tracking.pendingRecheck) return { ok: true, checked: false, reason: 'already-checked' };
    let task;
    try {
      task = beginRequest('检查剧情进度', state, selection.refs);
      const nodes = chapter.nodes.filter(node => !['completed', 'skipped'].includes(nodeStatus(state, node.id)));
      const prompt = prompts().buildCheckPrompt({ state: clone(state), nodes, messages: selection.messages,
        referenceContext: referenceContext(), allowProposals: settings().allowProposals !== false });
      const raw = await invoke(task, prompt);
      if (!isCurrent(task, true)) return { ok: false, reason: 'stale-result' };
      const assessment = prompts().parseCheckResponse(raw, { state, nodes, messages: selection.messages, allowProposals: settings().allowProposals !== false });
      if (!isCurrent(task, true)) return { ok: false, reason: 'stale-result' };
      state = data().loadState();
      const stamp = Date.now(), beforeChapterId = state.currentChapterId, completed = [], updatedIds = new Set();
      for (const candidate of assessment.nodeUpdates || []) {
        const node = chapter.nodes.find(item => item.id === candidate.nodeId);
        if (!node || updatedIds.has(node.id) || manualOverride(state, node.id) ||
            !['active', 'completed', 'blocked'].includes(candidate.status) || ['completed', 'skipped'].includes(nodeStatus(state, node.id))) continue;
        if (candidate.status === 'completed' && !clean(node.completionCriteria)) continue;
        const evidence = verifiedEvidence(candidate.evidence, selection);
        if (!evidence || candidate.status === nodeStatus(state, node.id)) continue;
        updatedIds.add(node.id);
        state.progressEvents.push({ id: `oe_${stamp}_${state.progressEvents.length}`, nodeId: node.id, status: candidate.status,
          planRevision: state.revision, nodeRevision: hash(node), sourceRefs: clone(selection.refs), sourceDigest: digest,
          evidence, validity: 'valid', beforeChapterId, layer: currentLayer(), createdAt: stamp });
        if (candidate.status === 'completed') completed.push(node.id);
      }
      // 先应用真实进度和自动下章，再判断建议是否仍然指向未来，避免同轮完成后改写节点。
      state = data().advanceChapter(state);
      const proposals = [];
      if (settings().allowProposals !== false) {
        for (const [index, candidate] of (assessment.proposals || []).entries()) {
          const proposal = normalizeProposal(candidate, state, chapter, selection, stamp, index);
          if (!proposal) continue;
          const duplicate = state.proposals.some(item => item.status === 'pending' && item.planRevision === state.revision &&
            item.kind === proposal.kind && item.nodeId === proposal.nodeId && JSON.stringify(item.after) === JSON.stringify(proposal.after));
          if (!duplicate) { state.proposals.push(proposal); proposals.push(proposal.id); }
        }
      }
      state.tracking = { ...state.tracking, checkedLayer: currentLayer(), roundsSinceCheck: 0,
        lastDigest: `${state.revision}:${beforeChapterId}:${digest}`, pendingRecheck: false, recheckStartLayer: null };
      data().saveState(state);
      applyInjection(); refresh();
      return { ok: true, checked: true, completed, proposals };
    } catch (error) {
      if (task?.controller.signal.aborted) return { ok: false, reason: 'aborted' };
      lastError = clean(error.message || error); console.warn('[剧情大纲] 检查失败（已隔离）', error);
      return { ok: false, reason: lastError };
    } finally { if (task) finish(task); }
  }
  function checkNow() { return runCheck(true); }

  function applyProposal(id, expectedRevision) {
    ensureChat();
    const state = auditHistory().state, proposal = state.proposals.find(item => item.id === id);
    if (!proposal || proposal.status !== 'pending') throw new Error('建议已处理或失效');
    if (Number(expectedRevision) !== Number(state.revision) || Number(proposal.planRevision) !== Number(state.revision)) throw new Error('大纲已修改，请刷新后重新确认差异');
    if (!proposalTargetEligible(state, proposal)) throw new Error('建议目标已经完成、跳过或进入当前执行阶段，请重新检查差异');
    if (!validateSavedSources(proposal)) throw new Error('建议的原文来源已变化，请重新检查');
    const plan = clone(state.plan), chapter = plan.chapters.find(item => item.id === proposal.chapterId);
    if (!chapter) throw new Error('建议对应的章节已不存在');
    if (proposal.kind === 'update_chapter') {
      if (JSON.stringify({ title: chapter.title, goal: chapter.goal }) !== JSON.stringify(proposal.before)) throw new Error('章节内容已变化，请重新检查');
      chapter.title = proposal.after.title; chapter.goal = proposal.after.goal;
    } else if (proposal.kind === 'replace_node') {
      const index = chapter.nodes.findIndex(item => item.id === proposal.nodeId);
      if (index < 0 || JSON.stringify(chapter.nodes[index]) !== JSON.stringify(proposal.before)) throw new Error('节点内容已变化，请重新检查');
      chapter.nodes[index] = { ...clone(proposal.after), id: proposal.nodeId };
    } else if (proposal.kind === 'insert_node') chapter.nodes.push(clone(proposal.after));
    else throw new Error('不支持此类型的修改建议');
    abort();
    const next = data().commitPlan(plan, Number(expectedRevision));
    const applied = next.proposals.find(item => item.id === id);
    if (applied) applied.status = 'accepted';
    data().saveState(next); applyInjection(); refresh();
    return next;
  }
  function dismissProposal(id) {
    const state = data().loadState(), proposal = state.proposals.find(item => item.id === id);
    if (proposal?.status === 'pending') { proposal.status = 'dismissed'; data().saveState(state); }
    refresh(); return state;
  }

  async function afterGeneration() {
    ensureChat(); generationInProgress = false;
    if (!settings().engineEnabled) { clearInjection(); return; }
    let state = data().loadState();
    if (state.tracking?.anchorLayer == null) { activate(state); applyInjection(); return; }
    state = auditHistory().state;
    const refs = assistantRefs(), latest = refs[refs.length - 1];
    if (!latest) return;
    const key = `${latest.messageId}:${latest.swipeId}:${latest.hash}`;
    const repeated = state.tracking.lastProcessedMessageKey === key;
    const seen = new Set(state.tracking.seenAssistantIds || refs.filter(ref => ref.layer <= Number(state.tracking.anchorLayer)).map(ref => ref.messageId));
    const reroll = ['swipe', 'regenerate'].includes(generationType);
    let added = 0;
    for (const ref of refs) {
      if (!seen.has(ref.messageId) && !reroll) added++;
      seen.add(ref.messageId);
    }
    state.tracking = { ...state.tracking, seenAssistantIds: [...seen], lastProcessedMessageKey: key,
      roundsSinceCheck: isFinished(state) ? 0 : Number(state.tracking.roundsSinceCheck || 0) + (repeated ? 0 : added) };
    data().saveState(state);
    generationType = '';
    applyInjection();
    const attemptKey = `${chatId()}:${sessionToken}:${state.revision}:${key}`;
    if (!isFinished(state) && settings().autoCheck !== false && lastAutoAttemptKey !== attemptKey &&
        (state.tracking.pendingRecheck || (!repeated && state.tracking.roundsSinceCheck >= Math.max(1, Number(settings().checkEveryX) || 3)))) {
      lastAutoAttemptKey = attemptKey;
      await runCheck(false);
    }
  }
  function guard(label, callback) {
    return function(...args) {
      try { const result = callback(...args); if (result?.catch) result.catch(error => console.warn(`[剧情大纲] ${label}失败（已隔离）`, error)); }
      catch (error) { console.warn(`[剧情大纲] ${label}失败（已隔离）`, error); }
    };
  }
  function init() {
    if (initialized) return;
    const ctx = context();
    if (!ctx?.eventSource?.on) { applyInjection(); return; }
    initialized = true; ensureChat();
    const types = ctx.event_types || {};
    ctx.eventSource.on(types.GENERATION_STARTED || 'generation_started', guard('生成开始', (type, _options, dryRun) => {
      if (dryRun) return;
      abort(); ensureChat(); generationType = clean(type); generationInProgress = true;
      if (settings().engineEnabled) { auditHistory(); applyInjection(); }
    }));
    ctx.eventSource.on(types.GENERATION_ENDED || types.MESSAGE_RECEIVED || 'message_received', guard('生成完成', () => {
      generationInProgress = false;
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(guard('自动检查', () => { autoTimer = null; return afterGeneration(); }), 80);
    }));
    const onLoaded = guard('加载聊天', () => {
      abort(); currentChatId = chatId(); generationInProgress = false; generationType = ''; lastAutoAttemptKey = ''; applyInjection(); refresh();
    });
    for (const event of new Set([types.CHAT_CHANGED || 'chat_id_changed', types.CHAT_LOADED || 'chat_loaded'])) ctx.eventSource.on(event, onLoaded);
    for (const [name, fallback] of [['MESSAGE_SWIPED', 'message_swiped'], ['MESSAGE_DELETED', 'message_deleted'], ['MESSAGE_EDITED', 'message_edited']]) {
      ctx.eventSource.on(types[name] || fallback, guard('原文变化', () => {
        abort(); if (name === 'MESSAGE_SWIPED') generationType = 'swipe';
        if (settings().engineEnabled) { auditHistory(); applyInjection(); }
      }));
    }
    applyInjection();
  }
  return { init, applyInjection, buildNarrativeGuidance, buildWorldGuidance, checkNow, organizeText, applyProposal, dismissProposal,
    prepareHistoryForGeneration, abort, isRunning: () => !!request, getRunningLabel: () => request?.label || '',
    getLastDebug: () => ({ ...clone(lastDebug || {}), injection: clone(injectionDebug) }), getLastError: () => lastError };
})();
