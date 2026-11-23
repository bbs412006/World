// outline-engine.js — 剧情大纲 v3 轻量化运行时（0ms 按楼层回退、无冷却漏检、带错回灌纠错重试、防剧透双轨注入）
window.OUTLINE_ENGINE = (function() {
  'use strict';

  const INJECTION_NAME = 'outline-engine-outline';
  const clean = value => String(value == null ? '' : value).trim();
  const cut = (value, max) => {
    const text = clean(value);
    return !max || text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
  };

  let initialized = false;
  let sessionToken = 0;
  let activeTask = null;
  let autoTimer = null;
  let generationInProgress = false;
  let generationType = '';
  let lastProcessedKey = '';
  let lastAutoAttemptKey = '';
  let lastError = '';
  let lastDebug = null;
  let injectionDebug = { narrative: null, world: null };

  const context = () => { try { return SillyTavern?.getContext?.() || null; } catch (_) { return null; } };
  const settings = () => window.OUTLINE_ENGINE_SETTINGS?.getSettings?.(true) || {};
  const data = () => window.OUTLINE_ENGINE_DATA;
  const promptApi = () => window.OUTLINE_ENGINE_PROMPT;
  const chatId = () => data()?.getChatId?.() || 'default';
  const chat = () => {
    const list = context()?.chat;
    return Array.isArray(list) ? list : [];
  };
  const currentLayer = () => Math.max(0, chat().length - 1);

  function hashText(text) {
    let h = 2166136261;
    for (const ch of String(text || '')) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function isAiMessage(m) {
    return Boolean(m && !m.is_user && !m.is_system && clean(m.mes));
  }

  function firstEligibleLayer(st) {
    return st?.firstLayerIsAiOpening !== false ? 1 : 0;
  }

  function refreshUI() {
    try { window.WORLD_ENGINE_UI?.refresh?.(); } catch (_) {}
    try { window.WORLD_ENGINE_UI?.updateBallControls?.(); } catch (_) {}
  }

  function setStatusText(text, isError) {
    try { window.__WE_SetExternalStatus?.(text, Boolean(isError)); } catch (_) {}
  }

  function abort() {
    sessionToken += 1;
    clearTimeout(autoTimer);
    autoTimer = null;
    if (activeTask?.controller) {
      try { activeTask.controller.abort(); } catch (_) {}
    }
    activeTask = null;
    refreshUI();
  }

  function clearInjection() {
    const ctx = context();
    const st = settings();
    const pos = [0, 1, 2].includes(Number(st.injectPosition)) ? Number(st.injectPosition) : 1;
    const depth = Number.isFinite(Number(st.injectDepth)) ? Math.max(0, Math.min(20, parseInt(st.injectDepth, 10))) : 1;
    if (typeof ctx?.setExtensionPrompt === 'function') {
      ctx.setExtensionPrompt(INJECTION_NAME, '', pos, depth);
    } else if (typeof ctx?.unregisterInjection === 'function') {
      ctx.unregisterInjection(INJECTION_NAME);
    } else if (Array.isArray(ctx?.extensionPrompts)) {
      ctx.extensionPrompts = ctx.extensionPrompts.filter(item => item?.name !== INJECTION_NAME);
    }
  }

  // ==================== 节点选优（无冷却漏检、透明排序） ====================

  const KIND_ORDER = { main: 0, side: 1, hidden: 2 };

  function getUnlockedOpenNodes(state) {
    const d = data();
    if (!d || !state?.plan?.nodes?.length) return [];
    const trackMap = new Map((state.plan.tracks || []).map(t => [t.id, t]));
    return state.plan.nodes
      .map((node, idx) => ({
        node,
        idx,
        kind: trackMap.get(node.trackId)?.kind || 'main',
        status: d.getNodeStatus(state, node.id)
      }))
      .filter(item => !d.isNodeClosed(state, item.node.id) && d.isNodeUnlocked(state, item.node.id))
      .sort((a, b) => {
        const aAct = a.status === 'active' ? 0 : 1;
        const bAct = b.status === 'active' ? 0 : 1;
        if (aAct !== bAct) return aAct - bAct;
        const aKind = KIND_ORDER[a.kind] ?? 1;
        const bKind = KIND_ORDER[b.kind] ?? 1;
        if (aKind !== bKind) return aKind - bKind;
        if (a.node.required !== b.node.required) return a.node.required ? -1 : 1;
        return a.idx - b.idx;
      })
      .map(item => item.node);
  }

  function getNarrativeNodes(state, limit) {
    const trackMap = new Map((state?.plan?.tracks || []).map(t => [t.id, t]));
    const unlocked = getUnlockedOpenNodes(state);
    const visible = unlocked.filter(n => {
      const kind = trackMap.get(n.trackId)?.kind || 'main';
      if (kind !== 'hidden') return true;
      return n.revealPublic === true && Boolean(clean(n.publicHint));
    });
    return visible.slice(0, Math.max(1, parseInt(limit, 10) || 4));
  }

  function getWorldNodes(state, limit) {
    const trackMap = new Map((state?.plan?.tracks || []).map(t => [t.id, t]));
    const unlocked = getUnlockedOpenNodes(state);
    // 世界后台优先参考暗线与主线节点
    const sorted = [...unlocked].sort((a, b) => {
      const ka = trackMap.get(a.trackId)?.kind || 'main';
      const kb = trackMap.get(b.trackId)?.kind || 'main';
      const rank = k => (k === 'hidden' ? 0 : k === 'main' ? 1 : 2);
      return rank(ka) - rank(kb);
    });
    return sorted.slice(0, Math.max(1, parseInt(limit, 10) || 6));
  }

  // ==================== 防剧透双轨注入 ====================

  function buildNarrativeGuidance(stateOverride) {
    const st = settings();
    if (st.engineEnabled !== true || st.injectIntoPrompt === false) {
      injectionDebug.narrative = null;
      return '';
    }
    const d = data();
    const state = stateOverride || d?.loadState?.();
    const chapters = state?.plan?.chapters || [];
    if (!chapters.length || d.isOutlineFinished(state)) {
      injectionDebug.narrative = null;
      return '';
    }
    const curChapter = chapters.find(c => c.id === state.currentChapterId) || chapters[0];
    const trackMap = new Map((state.plan.tracks || []).map(t => [t.id, t]));
    const nodes = getNarrativeNodes(state, st.narrativeLimit || 4);
    const budget = Math.max(200, parseInt(st.injectMaxChars, 10) || 2000);

    const header = '【剧情指导】\n以下为当前阶段的柔性叙事方向，仅供自然铺陈参考；请尊重角色当下选择，不得强行推进或提前剧透未揭示内容。';
    const parts = [header];
    let used = header.length;

    const pushLine = line => {
      const text = clean(line);
      if (!text) return false;
      if (used + text.length + 1 > budget) {
        const remain = budget - used - 3;
        if (remain < 24) return false;
        const trimmed = text.slice(0, remain) + '…';
        parts.push(trimmed);
        used += trimmed.length + 1;
        return false;
      }
      parts.push(text);
      used += text.length + 1;
      return true;
    };

    const chIdx = chapters.findIndex(c => c.id === curChapter.id);
    pushLine(`当前章节：第 ${chIdx + 1}/${chapters.length} 章「${curChapter.title}」${curChapter.goal ? `｜阶段目标：${curChapter.goal}` : ''}`);
    if (clean(state.plan.publicConstraints)) pushLine(`叙事原则：${state.plan.publicConstraints}`);
    if (nodes.length) {
      pushLine('当前可自然铺陈的剧情方向：');
      for (const n of nodes) {
        const kind = trackMap.get(n.trackId)?.kind || 'main';
        const status = d.getNodeStatus(state, n.id);
        const tag = kind === 'hidden'
          ? '表面线索'
          : (status === 'active' ? '进行中' : (kind === 'side' ? '支线' : '主线'));
        // 暗线仅注入公开表面线索，绝不暴露内部标题或幕后备注
        const line = kind === 'hidden'
          ? `- [${tag}] ${n.publicHint}`
          : `- [${tag}] ${n.title}${n.publicHint ? `：${n.publicHint}` : ''}`;
        if (!pushLine(line)) break;
      }
    }
    if (clean(state.plan.publicSynopsis)) {
      pushLine(`公开脉络：${state.plan.publicSynopsis}`);
    }

    const content = parts.length > 1 ? parts.join('\n') : '';
    injectionDebug.narrative = {
      at: Date.now(),
      chars: content.length,
      budget,
      chapterId: curChapter.id,
      chapterTitle: curChapter.title,
      nodeIds: nodes.map(n => n.id),
      content
    };
    return content;
  }

  function applyInjection() {
    const st = settings();
    const content = buildNarrativeGuidance();
    const ctx = context();
    if (!content) {
      clearInjection();
      return '';
    }
    const pos = [0, 1, 2].includes(Number(st.injectPosition)) ? Number(st.injectPosition) : 1;
    const depth = Number.isFinite(Number(st.injectDepth)) ? Math.max(0, Math.min(20, parseInt(st.injectDepth, 10))) : 1;
    if (typeof ctx?.setExtensionPrompt === 'function') {
      ctx.setExtensionPrompt(INJECTION_NAME, content, pos, depth);
    } else if (typeof ctx?.registerInjection === 'function') {
      ctx.unregisterInjection?.(INJECTION_NAME);
      ctx.registerInjection(INJECTION_NAME, content, { position: pos, depth, role: 'system' });
    } else if (Array.isArray(ctx?.extensionPrompts)) {
      ctx.extensionPrompts = ctx.extensionPrompts.filter(item => item?.name !== INJECTION_NAME);
      ctx.extensionPrompts.push({ name: INJECTION_NAME, content, role: 'system', position: pos, depth });
    }
    try { window.WORLD_ENGINE_INJECT_INSPECTOR?.record?.('outline', content, { budget: st.injectMaxChars }); } catch (_) {}
    return content;
  }

  function buildWorldGuidance(_worldState) {
    const st = settings();
    if (st.engineEnabled !== true || st.injectIntoWorldEngine === false) {
      injectionDebug.world = null;
      return '';
    }
    try {
      if (window.WORLD_ENGINE_API?.getSettings?.()?.acceptOutlineGuidance === false) {
        injectionDebug.world = null;
        return '';
      }
    } catch (_) {}

    const d = data();
    const state = d?.loadState?.();
    const chapters = state?.plan?.chapters || [];
    if (!chapters.length) {
      injectionDebug.world = null;
      return '';
    }
    const curChapter = chapters.find(c => c.id === state.currentChapterId) || chapters[0];
    const trackMap = new Map((state.plan.tracks || []).map(t => [t.id, t]));
    const nodes = getWorldNodes(state, 6);
    const budget = Math.max(300, parseInt(st.worldInjectMaxChars, 10) || 2000);

    const header = '【剧情指导：作者后台专用】\n以下为柔性剧情方向与幕后备忘，仅供世界推演自然铺垫背景势态与暗线伏笔；世界仍须按自身因果与知情边界独立演化，严禁代演主角行动。';
    const parts = [header];
    let used = header.length;

    const pushLine = line => {
      const text = clean(line);
      if (!text) return false;
      if (used + text.length + 1 > budget) {
        const remain = budget - used - 3;
        if (remain < 24) return false;
        parts.push(text.slice(0, remain) + '…');
        used += remain + 4;
        return false;
      }
      parts.push(text);
      used += text.length + 1;
      return true;
    };

    pushLine(`当前章节：${curChapter.title}${curChapter.goal ? `（${curChapter.goal}）` : ''}`);
    if (clean(state.plan.authorNotes)) pushLine(`幕后总备忘：${cut(state.plan.authorNotes, 450)}`);
    if (nodes.length) {
      pushLine('当前活跃/暗线节点：');
      for (const n of nodes) {
        const kind = trackMap.get(n.trackId)?.kind || 'main';
        const kindLabel = kind === 'hidden' ? '暗线' : kind === 'side' ? '支线' : '主线';
        const status = d.getNodeStatus(state, n.id);
        const detail = [
          n.publicHint ? `公开方向：${cut(n.publicHint, 120)}` : '',
          n.secretNotes ? `幕后真相：${cut(n.secretNotes, 180)}` : '',
          n.completionCriteria ? `达成条件：${cut(n.completionCriteria, 100)}` : ''
        ].filter(Boolean).join('｜');
        if (!pushLine(`- [${kindLabel}·${status}] ${n.title}${detail ? `（${detail}）` : ''}`)) break;
      }
    }

    const content = parts.length > 1 ? parts.join('\n') : '';
    injectionDebug.world = {
      at: Date.now(),
      chars: content.length,
      budget,
      chapterId: curChapter.id,
      nodeIds: nodes.map(n => n.id),
      content
    };
    return content;
  }

  // ==================== 0ms 按楼层号本地回退 ====================

  function syncRollbackToLayer(maxValidLayer) {
    const d = data();
    if (!d) return false;
    const state = d.loadState();
    const res = d.rollbackAfterLayer(state, maxValidLayer);
    const trackingChanged = state.tracking.checkedLayer !== res.state.tracking.checkedLayer
      || state.tracking.anchorLayer !== res.state.tracking.anchorLayer;
    if (res.removedCount > 0 || res.chapterChanged || trackingChanged) {
      d.saveState(res.state);
      return true;
    }
    return false;
  }

  async function prepareHistoryForGeneration(options = {}) {
    const type = clean(options?.type || generationType);
    const isReroll = type === 'swipe' || type === 'regenerate';
    const maxLayer = isReroll ? Math.max(-1, currentLayer() - 1) : currentLayer();
    syncRollbackToLayer(maxLayer);
    applyInjection();
    return { ok: true, maxLayer };
  }

  // ==================== API 调用 + 带错回灌纠错重试 ====================

  function buildApiConfig(st) {
    const url = clean(st.apiUrl);
    const model = clean(st.model);
    if (!url || !model) {
      throw new Error('请先在「剧情大纲 → 设置 → 常用」中配置大纲 API 地址与模型');
    }
    return {
      apiUrl: url,
      apiKey: clean(st.apiKey),
      model,
      connectionMode: st.connectionMode === 'proxy' ? 'proxy' : 'direct',
      temperature: Number.isFinite(Number(st.temperature)) ? Number(st.temperature) : 0.2,
      maxTokens: Math.max(1, parseInt(st.maxTokens, 10) || 8192),
      apiTimeoutMs: Math.max(0, parseInt(st.apiTimeoutMs, 10) || 120000),
      stream: st.stream === true,
      streamIdleTimeoutMs: Math.max(0, parseInt(st.streamIdleTimeoutMs, 10) || 90000),
      jsonMode: st.jsonMode === true,
      topP: st.topP ?? null,
      reasoningEffort: clean(st.reasoningEffort)
    };
  }

  async function invokeWithFormatRetry({ label, basePrompt, parseFn, controller, token }) {
    const api = window.WORLD_ENGINE_API;
    if (!api?.callApi) throw new Error('API 模块未就绪');
    const st = settings();
    const cfg = buildApiConfig(st);
    const maxFormatRetries = Math.max(0, Math.min(5, parseInt(st.formatMaxRetries ?? 2, 10) || 0));
    const networkRetries = Math.max(0, parseInt(st.apiAutoRetries, 10) || 0);
    const retryHistory = [];
    let lastRaw = '';
    let lastParsed = null;

    for (let attempt = 0; attempt <= maxFormatRetries; attempt++) {
      if (controller.signal.aborted || token !== sessionToken) {
        const err = new Error('已取消');
        err.name = 'AbortError';
        throw err;
      }
      const prompt = retryHistory.length
        ? promptApi().buildRetryCorrectionPrompt(basePrompt, retryHistory)
        : basePrompt;
      const purpose = attempt > 0 ? `${label} · 纠错重试${attempt}` : label;

      const callOnce = async () => {
        let logId = null;
        api.setNextRequestMeta?.({
          module: 'outline',
          purpose,
          attempt: attempt + 1,
          maxAttempts: maxFormatRetries + 1,
          onLogId: id => { logId = id; }
        });
        const raw = await api.callApi(prompt, cfg.maxTokens, cfg.temperature, controller.signal, cfg);
        return { raw, logId };
      };

      const { raw, logId } = typeof api.executeWithRetry === 'function'
        ? await api.executeWithRetry(callOnce, { retries: networkRetries, signal: controller.signal })
        : await callOnce();

      lastRaw = raw;
      const parsed = parseFn(raw);
      lastParsed = parsed;

      lastDebug = {
        at: Date.now(),
        label,
        attempt: attempt + 1,
        prompt,
        rawResult: raw,
        ok: parsed.ok,
        errors: parsed.errors || []
      };

      if (parsed.ok) {
        if (logId) api.updateRequestLog?.(logId, { phase: '完成' });
        return { ...parsed, raw, attempts: attempt + 1 };
      }

      if (logId) {
        api.updateRequestLog?.(logId, {
          status: 'error',
          phase: '解析失败',
          error: (parsed.errors || []).join('；')
        });
      }
      retryHistory.push({ response: raw, errors: parsed.errors });
    }

    throw new Error(`${label}解析失败（已纠错重试 ${maxFormatRetries} 次）：${(lastParsed?.errors || ['返回格式无效']).join('；')}`);
  }

  // ==================== 文本整理建纲 & 剧情进度核对 ====================

  async function organizeText(rawText) {
    const text = clean(rawText);
    if (!text) throw new Error('请输入或导入待整理的大纲文本');
    if (activeTask) throw new Error('当前已有大纲任务运行中，请稍候或先停止');

    const originChat = chatId();
    const token = ++sessionToken;
    const controller = new AbortController();
    activeTask = { label: '整理剧情大纲', controller, token, chatId: originChat };
    lastError = '';
    setStatusText('正在整理剧情大纲…', false);
    refreshUI();

    try {
      const roster = (() => {
        try { return window.STORY_ENGINE_BRIDGE?.formatIdentityRosterForPrompt?.() || ''; }
        catch (_) { return ''; }
      })();
      const basePrompt = promptApi().buildOrganizePrompt({ text, roster });
      const res = await invokeWithFormatRetry({
        label: '整理大纲',
        basePrompt,
        parseFn: raw => promptApi().parseOrganizeResponse(raw),
        controller,
        token
      });
      if (token !== sessionToken || chatId() !== originChat) {
        return { ok: false, cancelled: true };
      }
      setStatusText('大纲整理完成（待预览确认）', false);
      return { ok: true, plan: res.plan, raw: res.raw, attempts: res.attempts };
    } catch (error) {
      if (error?.name !== 'AbortError') {
        lastError = error?.message || String(error);
        setStatusText(`整理大纲失败：${lastError}`, true);
      }
      throw error;
    } finally {
      if (activeTask?.token === token) activeTask = null;
      refreshUI();
    }
  }

  function collectDialogueWindow(state, st) {
    const all = chat();
    const minLayer = firstEligibleLayer(st);
    const aiIndices = [];
    for (let i = minLayer; i < all.length; i++) {
      if (isAiMessage(all[i])) aiIndices.push(i);
    }
    if (!aiIndices.length) return { messages: [], endLayer: -1, digest: '' };

    const checked = state.tracking?.checkedLayer;
    const maxAi = Math.max(parseInt(st.checkEveryX, 10) || 3, 8);
    let targetAi = checked !== null && checked !== undefined
      ? aiIndices.filter(i => i > checked)
      : [];
    if (!targetAi.length) {
      targetAi = aiIndices.slice(-Math.max(1, parseInt(st.checkEveryX, 10) || 3));
    } else if (targetAi.length > maxAi) {
      targetAi = targetAi.slice(-maxAi);
    }

    const startAi = targetAi[0];
    const endLayer = targetAi[targetAi.length - 1];
    const startLayer = startAi > 0 && all[startAi - 1]?.is_user ? startAi - 1 : startAi;
    const messages = [];
    for (let i = startLayer; i <= endLayer; i++) {
      const m = all[i];
      if (!m || m.is_system || !clean(m.mes)) continue;
      const filtered = window.WORLD_ENGINE_CORE?.filterDialogue ? window.WORLD_ENGINE_CORE.filterDialogue(m.mes) : m.mes;
      if (!clean(filtered)) continue;
      messages.push({
        layer: i,
        is_user: Boolean(m.is_user),
        name: clean(m.name) || (m.is_user ? '玩家' : 'AI'),
        mes: clean(filtered)
      });
    }
    const digest = hashText(messages.map(m => `${m.layer}:${m.is_user ? 'u' : 'a'}:${m.mes}`).join('\n'));
    return { messages, endLayer, digest };
  }

  function buildReferenceContext(state, st) {
    try {
      if (window.STORY_ENGINE_BRIDGE?.buildOutlineReferenceContext) {
        return window.STORY_ENGINE_BRIDGE.buildOutlineReferenceContext(state, {
          useWorld: st.useWorldReference !== false,
          useMemory: st.useMemoryReference !== false
        }) || '';
      }
    } catch (_) {}
    return '';
  }

  async function runCheck(manual = false) {
    try { await window.WORLD_ENGINE_CHATCACHE?.forScope?.('outline')?.whenReady?.(); } catch (_) {}
    const st = settings();
    if (st.engineEnabled !== true) return { skipped: true, reason: 'disabled' };
    if (activeTask) return { skipped: true, reason: 'busy' };
    if (generationInProgress) return { skipped: true, reason: 'generating' };

    const d = data();
    const originChat = chatId();
    const state = d.loadState(originChat);
    if (!state.plan.chapters.length || !state.plan.nodes.length) {
      return { skipped: true, reason: 'empty-plan' };
    }
    if (d.isOutlineFinished(state)) {
      return { skipped: true, reason: 'outline-complete' };
    }

    const unlockedNodes = getUnlockedOpenNodes(state).slice(0, 24);
    if (!unlockedNodes.length) {
      return { skipped: true, reason: 'no-unlocked-nodes' };
    }

    const win = collectDialogueWindow(state, st);
    if (!win.messages.length || win.endLayer < 0) {
      return { skipped: true, reason: 'no-messages' };
    }
    const digestKey = `${state.revision}:${state.currentChapterId}:${win.endLayer}:${win.digest}`;
    if (!manual && state.tracking.lastDigest === digestKey) {
      return { skipped: true, reason: 'unchanged' };
    }

    const token = ++sessionToken;
    const controller = new AbortController();
    const startRevision = state.revision;
    activeTask = { label: '核对剧情进度', controller, token, chatId: originChat };
    lastError = '';
    setStatusText('正在核对剧情进度…', false);
    refreshUI();

    try {
      const referenceContext = buildReferenceContext(state, st);
      const basePrompt = promptApi().buildCheckPrompt({
        state,
        unlockedNodes,
        messages: win.messages,
        referenceContext
      });
      const validIds = new Set(unlockedNodes.map(n => n.id));
      const res = await invokeWithFormatRetry({
        label: '核对剧情进度',
        basePrompt,
        parseFn: raw => promptApi().parseCheckResponse(raw, validIds),
        controller,
        token
      });

      if (token !== sessionToken || chatId() !== originChat || generationInProgress) {
        return { skipped: true, reason: 'stale-result' };
      }

      let latest = d.loadState(originChat);
      if (latest.revision !== startRevision) {
        return { skipped: true, reason: 'plan-changed' };
      }

      const trackMap = new Map((latest.plan.tracks || []).map(t => [t.id, t]));
      const applied = [];
      const now = Date.now();
      for (const upd of res.data.nodeUpdates || []) {
        const node = d.getNode(latest, upd.nodeId);
        if (!node) continue;
        if (latest.manualOverrides[node.id]) continue;
        if (d.isNodeClosed(latest, node.id)) continue;
        if (upd.status === 'completed' && !clean(node.completionCriteria)) continue;

        const prevStatus = d.getNodeStatus(latest, node.id);
        const isHidden = trackMap.get(node.trackId)?.kind === 'hidden';
        let revealedNow = false;
        if (isHidden && upd.revealPublic === true && !node.revealPublic) {
          node.revealPublic = true;
          revealedNow = true;
        }
        if (upd.status !== prevStatus || revealedNow) {
          if (upd.status !== prevStatus) {
            latest.progress[node.id] = {
              status: upd.status,
              layer: win.endLayer,
              reason: upd.reason || '',
              updatedAt: now
            };
          }
          applied.push({ nodeId: node.id, title: node.title, status: upd.status, revealedNow });
        }
      }

      const prevChapter = latest.currentChapterId;
      latest = d.advanceChapter(latest);
      latest.tracking = {
        ...latest.tracking,
        anchorLayer: latest.tracking.anchorLayer ?? win.endLayer,
        checkedLayer: win.endLayer,
        roundsSinceCheck: 0,
        lastDigest: digestKey
      };
      d.saveState(latest, originChat);
      applyInjection();

      const chapterAdvanced = latest.currentChapterId !== prevChapter;
      const summary = applied.length || chapterAdvanced
        ? `剧情进度已更新（${applied.length} 项变动${chapterAdvanced ? '，已推进至下一章' : ''}）`
        : '剧情核对完成（暂无新节点变动）';
      setStatusText(summary, false);
      return { ok: true, applied, chapterAdvanced, note: res.data.note || '' };
    } catch (error) {
      if (error?.name !== 'AbortError') {
        lastError = error?.message || String(error);
        setStatusText(`剧情核对失败：${lastError}`, true);
      }
      if (manual) throw error;
      return { ok: false, error: lastError };
    } finally {
      if (activeTask?.token === token) activeTask = null;
      refreshUI();
    }
  }

  function checkNow() {
    return runCheck(true);
  }

  function clearAllOutlineData(options = {}) {
    if (activeTask) abort();
    const d = data();
    const prev = d.loadState();
    const hadData = (prev.plan.chapters?.length || 0) > 0 || (prev.plan.nodes?.length || 0) > 0;
    if (options.backup !== false && hadData) {
      try {
        window.WORLD_ENGINE_CHATCACHE?.forScope?.('outline')?.createSnapshot?.(
          clean(options.backupName) || `清空大纲前自动备份 ${new Date().toLocaleString()}`
        );
      } catch (_) {}
    }
    const fresh = d.clearOutlineData();
    lastError = '';
    lastDebug = null;
    clearInjection();
    refreshUI();
    return { cleared: true, hadData, state: fresh };
  }

  // ==================== 回复后自动计数与事件绑定 ====================

  async function afterGeneration() {
    const st = settings();
    if (st.engineEnabled !== true) return;
    const d = data();
    const all = chat();
    const layer = currentLayer();
    const lastMsg = all[layer];
    if (!isAiMessage(lastMsg) || layer < firstEligibleLayer(st)) return;

    const msgKey = `${chatId()}:${layer}:${lastMsg.swipe_id ?? 0}:${hashText(lastMsg.mes)}`;
    if (msgKey === lastProcessedKey) return;
    lastProcessedKey = msgKey;

    const state = d.loadState();
    if (!state.plan.chapters.length || !state.plan.nodes.length) return;
    if (d.isOutlineFinished(state)) return;

    // 首次启用仅锚定当前楼层，不追溯历史旧楼
    if (state.tracking.anchorLayer === null) {
      state.tracking.anchorLayer = layer;
      state.tracking.checkedLayer = layer;
      state.tracking.roundsSinceCheck = 0;
      d.saveState(state);
      applyInjection();
      return;
    }

    const isReroll = generationType === 'swipe' || generationType === 'regenerate';
    if (!isReroll) {
      state.tracking.roundsSinceCheck = (state.tracking.roundsSinceCheck || 0) + 1;
      d.saveState(state);
    }

    if (st.autoCheck === false) return;
    const everyX = Math.max(1, parseInt(st.checkEveryX, 10) || 3);
    if (state.tracking.roundsSinceCheck < everyX) return;
    if (lastAutoAttemptKey === msgKey) return;
    lastAutoAttemptKey = msgKey;

    await runCheck(false);
  }

  function init() {
    if (initialized) return;
    const ctx = context();
    const es = ctx?.eventSource;
    const et = ctx?.event_types || {};
    if (!es || typeof es.on !== 'function') {
      applyInjection();
      return;
    }
    initialized = true;

    es.on(et.GENERATION_STARTED || 'generation_started', (type, _opts, dryRun) => {
      if (dryRun) return;
      window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
      abort();
      generationInProgress = true;
      generationType = clean(type);
      if (generationType === 'swipe' || generationType === 'regenerate') {
        syncRollbackToLayer(Math.max(-1, currentLayer() - 1));
      } else {
        syncRollbackToLayer(currentLayer());
      }
      applyInjection();
    });

    const onEnded = () => {
      generationInProgress = false;
      const bridge = window.STORY_ENGINE_BRIDGE;
      if (bridge?.shouldCoordinateGeneration?.()) {
        bridge.scheduleTurn({
          scope: 'outline',
          delayMs: 1200,
          run: () => afterGeneration()
        });
      } else {
        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => { afterGeneration(); }, 120);
      }
    };
    es.on(et.GENERATION_ENDED || et.MESSAGE_RECEIVED || 'generation_ended', onEnded);

    es.on(et.GENERATION_STOPPED || 'generation_stopped', () => {
      generationInProgress = false;
      generationType = '';
      window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
      abort();
      syncRollbackToLayer(currentLayer());
      applyInjection();
    });

    const onChatSwitch = () => {
      window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
      abort();
      generationInProgress = false;
      generationType = '';
      lastProcessedKey = '';
      lastAutoAttemptKey = '';
      lastError = '';
      applyInjection();
      refreshUI();
    };
    es.on(et.CHAT_CHANGED || 'chat_id_changed', onChatSwitch);
    es.on(et.CHAT_LOADED || 'chat_loaded', onChatSwitch);

    es.on(et.MESSAGE_DELETED || 'message_deleted', () => {
      window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
      abort();
      lastProcessedKey = '';
      syncRollbackToLayer(currentLayer());
      applyInjection();
      refreshUI();
    });

    es.on(et.MESSAGE_SWIPED || 'message_swiped', () => {
      window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
      abort();
      generationType = 'swipe';
      lastProcessedKey = '';
      syncRollbackToLayer(Math.max(-1, currentLayer() - 1));
      applyInjection();
      refreshUI();
    });

    es.on(et.MESSAGE_EDITED || 'message_edited', layerIdx => {
      window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
      abort();
      const idx = Number.isFinite(Number(layerIdx)) ? parseInt(layerIdx, 10) : currentLayer();
      syncRollbackToLayer(Math.max(-1, idx - 1));
      applyInjection();
      refreshUI();
    });

    applyInjection();
  }

  return {
    INJECTION_NAME,
    init,
    applyInjection,
    buildNarrativeGuidance,
    buildWorldGuidance,
    getUnlockedOpenNodes,
    getNarrativeNodes,
    getWorldNodes,
    checkNow,
    organizeText,
    clearAllOutlineData,
    prepareHistoryForGeneration,
    abort,
    isRunning: () => Boolean(activeTask),
    getRunningLabel: () => activeTask?.label || '',
    getLastDebug: () => ({
      request: lastDebug,
      injection: injectionDebug
    }),
    getLastError: () => lastError
  };
})();
