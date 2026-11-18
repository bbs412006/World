// world-engine-api.js — 独立 API 调用（支持自定义 OpenAI 兼容 API）
window.WORLD_ENGINE_API = (function() {
  // API 请求实现可以被两个引擎复用，但覆盖配置绝不能以世界引擎设置补缺。
  // 调用方一旦显式传入 settingsOverride，就只叠加无状态默认值。
  const REQUEST_DEFAULTS = Object.freeze({
    apiUrl: '',
    apiKey: '',
    model: 'gpt-3.5-turbo',
    connectionMode: 'direct',
    temperature: 0.7,
    maxTokens: 65000,
    apiTimeoutMs: 120000
  });
  let cachedSettings = null;

  function getSettings(forceRefresh) {
    if (forceRefresh) cachedSettings = null;
    if (cachedSettings) return cachedSettings;
    const defaults = {
      apiUrl: '',
      apiKey: '',
      model: 'gpt-3.5-turbo',
      temperature: 0.7,
      maxTokens: 65000,
      apiAutoRetries: 0,
      engineEnabled: true,
      firstLayerIsAiOpening: true,
      // [FIX] 连接方式：'direct'=浏览器直连（默认，原有行为）；'proxy'=经酒馆服务端转发，绕过第三方 API 的 CORS 限制
      connectionMode: 'direct',
      injectIntoPrompt: true,
      injectMaxChars: 5000,
      // 正文注入等级筛选：false=仅注入高等级信息（兼容旧行为），true=事件链与风声不按等级过滤
      injectAllLevels: false,
      // 世界 API 成功后，把本轮世界信息联动到记忆引擎。
      memoryLinkEnabled: false,
      // 跨模块协同开关（默认保持开启并随单模块运行状态安全降级；关闭后对应模块完全独立）。
      acceptMemoryContext: true,
      acceptOutlineGuidance: true,
      syncToOutlineEnabled: true,
      evolveMode: 'auto',
      // 酒馆缓存：把按聊天隔离的存档镜像进 chat_metadata，实现跨设备同步与防丢失存档（默认关闭）
      syncToChat: false,   // 实时同步：工作区状态持续镜像进聊天，换设备打开同一聊天即可续上
      autoBackup: false,   // 滚动自动备份：每当轮次推进，自动存一条到聊天（保留最近几条）
      worldbookTrigger: false, // 世界书蓝绿灯触发：🔵常驻恒注入 / 🟢关键词命中才注入（默认关闭=全部已选注入）
      // 批量重填世界推演：从第 1 个 AI 楼层分批推到指定楼层（清空重来）
      backfillBatchSize: 5,    // 每批 AI 楼层数（每多少层调一次推演）
      backfillRetries: 2,      // 每批独立重试次数（推演失败时重试上限）
      backfillEndLayer: 0,     // 结束 AI 楼层（0 = 推到最后一个 AI 楼层）
      evolveEveryX: 1,
      evolveReadRounds: 1,
      manualReadRounds: 1,
      evolveFilterRegex: '',
      tonePrompt: '',
      // 按时间推演模式
      evolveTimeFront: 0,
      evolveTimeBack: 80,
      evolveTimeRe1: '', evolveTimeRe2: '', evolveTimeRe3: '',
      evolveTimeRe4: '', evolveTimeRe5: '', evolveTimeRe6: '',
      evolveTimeMul1: 360, evolveTimeMul2: 30, evolveTimeMul3: 1,
      evolveTimeThreshold: 1,
      evolveTimeMaxRounds: 10,
      // Local mechanism tuning. Defaults match the previous hard-coded behavior.
      localRegionalIncidentChancePercent: 3,
      localRegionalIncidentDuration: 5,
      localRegionalIncidentCooldown: 5,
      localDistantEventLedgerThreshold: 10,
      localDistantEventChancePercent: 20,
      localDistantEventCooldown: 5,
      localDistantEventEventPercent: 50,
      localNearEventChancePercent: 20,
      localNearEventCooldown: 5,
      localNearEventEventPercent: 50,
      localEventDiceModifier: 0,
      localEventSetbackRatioPercent: 40,
      localProgressFailBase: 2,
      localConflictFailBase: 6,
      localTerminalBaseKeepRounds: 2,
      localTerminalLevelKeepRounds: 2,
      localInfluenceKeepRounds: 8,
      localEnemyTerminalKeepRounds: 20,
      localLedgerKeepRounds: 20,
      localCapEvents: 16,
      localCapFactions: 15,
      localCapWinds: 12,
      localCapWorldTrends: 4,
      localCapInfluence: 12,
      localCapEnemies: 8,
      localCapEconomySignals: 8,
      localCapBlackbox: 12,
      localWindAnnouncementBase: 10,
      localWindAnnouncementGrace: 4,
      localWindAnnouncementLinear: 3,
      localWindAnnouncementQuadratic: 1,
      localWindReportBase: 20,
      localWindReportGrace: 2,
      localWindReportLinear: 4,
      localWindReportQuadratic: 2,
      localWindRumorBase: 25,
      localWindRumorGrace: 1,
      localWindRumorLinear: 5,
      localWindRumorQuadratic: 3,
      localWindSentimentBase: 8,
      localWindSentimentGrace: 5,
      localWindSentimentLinear: 2,
      localWindSentimentQuadratic: 1,
      // [FIX] API 请求超时（毫秒）。0 = 不超时（旧行为）。默认 120s：
      //   推演请求若落入网络黑洞（代理无响应/上游不返回也不报错），fetch 会永久挂起，
      //   evolve 的 _isRunning 永不复位，此后所有自动推演被 isRunning() 守卫静默跳过，
      //   直到用户切一次聊天才解锁。超时让挂起请求按失败处理，finally 正常复位。
      apiTimeoutMs: 120000
    };
    const raw = window.WORLD_ENGINE_STORE.getItem('world_engine_settings');
    if (raw) {
      try {
        cachedSettings = { ...defaults, ...JSON.parse(raw) };
        if (parseInt(cachedSettings.maxTokens) === 4096) cachedSettings.maxTokens = 65000;
        return cachedSettings;
      } catch(e) {}
    }
    cachedSettings = defaults;
    return cachedSettings;
  }

  // [FIX] 规整 chat/completions URL：只补 /chat/completions，不再替用户塞 /v1 等版本前缀。
  //   火山方舟等 OpenAI 兼容端点用自定义版本前缀（/api/v3、/api/coding/v3），旧逻辑会硬塞
  //   /v1 把 URL 拼成 .../v3/v1/chat/completions 而全部 404。版本前缀由用户在设置里填到完整，
  //   旁边有格式提示。三处调用点（getProxyBase / callApi / fetchModelList）语义一致受益。
  function normalizeEndpointUrl(url, suffix) {
    const raw = String(url || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    const cleaned = raw.replace(/\/(?:chat\/completions|embeddings|rerank)$/i, '');
    if (raw.toLowerCase().endsWith(suffix.toLowerCase())) return raw;
    return cleaned + suffix;
  }

  function normalizeUrl(url) {
    return normalizeEndpointUrl(url, '/chat/completions');
  }

  // [FIX] 经酒馆代理用：从完整的 chat/completions URL 还原出 base（形如 https://host/v1），
  // 交给酒馆后端，由它自己拼 /chat/completions 与 /models。
  function getProxyBase(settings) {
    return normalizeUrl(settings.apiUrl).replace(/\/chat\/completions$/, '');
  }

  // [FIX] 调酒馆自身后端端点需要携带其 CSRF/鉴权头；仅在酒馆环境中可用。
  function tavernHeaders() {
    try {
      const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
      if (ctx && typeof ctx.getRequestHeaders === 'function') {
        const h = ctx.getRequestHeaders();
        if (h && !h['Content-Type'] && !h['content-type']) h['Content-Type'] = 'application/json';
        return h;
      }
    } catch (e) {}
    throw new Error('经酒馆代理需要在酒馆环境中运行（未取到酒馆请求头）');
  }

  function timeoutError(timeoutMs) {
    return new Error('API 请求超时（' + Math.max(1, Math.ceil(timeoutMs / 1000)) + 's 无响应），已中止本次请求');
  }

  function timeoutSeconds(timeoutMs) {
    timeoutMs = Number(timeoutMs) || 0;
    return timeoutMs > 0 ? Math.max(1, Math.ceil(timeoutMs / 1000)) : 0;
  }

  function messageChars(messages) {
    return (messages || []).reduce((total, msg) => total + String(msg && msg.content || '').length, 0);
  }

  function sanitizeLogUrl(rawUrl) {
    return String(rawUrl || '').trim().replace(/([?&](?:key|api_key|token|access_token)=)[^&]+/gi, '$1***');
  }

  function previewLogText(value, maxChars) {
    const str = String(value == null ? '' : value);
    if (!str) return '';
    return str.length > maxChars ? `${str.slice(0, maxChars)}\n...（共 ${str.length} 字符，已截断显示）` : str;
  }

  function extractChoiceContent(choice) {
    const raw = choice?.message?.content ?? choice?.text ?? '';
    if (Array.isArray(raw)) {
      return raw.map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return String(part.text ?? part.content ?? '');
        return '';
      }).join('');
    }
    return raw == null ? '' : String(raw);
  }

  const MAX_REQUEST_LOGS = 120;
  let requestLogSeq = 0;
  const requestLogs = [];
  const requestLogListeners = new Set();
  let pendingRequestMeta = null;

  function setNextRequestMeta(meta) {
    pendingRequestMeta = meta && typeof meta === 'object' ? { ...meta } : null;
  }

  function consumeRequestMeta(settingsOverride) {
    const nextMeta = pendingRequestMeta;
    pendingRequestMeta = null;
    if (nextMeta) return nextMeta;
    if (settingsOverride && typeof settingsOverride === 'object' && settingsOverride.__requestMeta) {
      return settingsOverride.__requestMeta;
    }
    return null;
  }

  function cloneRequestLog(entry) {
    return entry ? { ...entry } : null;
  }

  function notifyRequestLogChange() {
    for (const fn of requestLogListeners) {
      try { fn(getRequestLogs()); } catch (_) {}
    }
    try { window.WORLD_ENGINE_UI?.refreshRequestLogs?.(); } catch (_) {}
  }

  function beginRequestLog(info) {
    const entry = {
      id: `req_${++requestLogSeq}`,
      ts: Date.now(),
      startedAt: Date.now(),
      module: String(info?.module || 'world'),
      purpose: String(info?.purpose || 'API 请求'),
      status: String(info?.status || 'running'),
      phase: String(info?.phase || '请求中'),
      connectionMode: info?.connectionMode === 'proxy' ? 'proxy' : 'direct',
      target: sanitizeLogUrl(info?.target || ''),
      model: String(info?.model || ''),
      temperature: info?.temperature ?? null,
      maxTokens: info?.maxTokens ?? null,
      timeoutSec: info?.timeoutSec ?? null,
      attempt: Math.max(1, Number(info?.attempt) || 1),
      maxAttempts: Math.max(1, Number(info?.maxAttempts) || 1),
      httpStatus: info?.httpStatus ?? null,
      finishReason: String(info?.finishReason || ''),
      durationMs: info?.durationMs ?? null,
      promptChars: Math.max(0, Number(info?.promptChars) || 0),
      responseChars: Math.max(0, Number(info?.responseChars) || 0),
      promptPreview: previewLogText(info?.promptPreview || '', 3000),
      responsePreview: previewLogText(info?.responsePreview || '', 4000),
      error: String(info?.error || '')
    };
    requestLogs.unshift(entry);
    if (requestLogs.length > MAX_REQUEST_LOGS) requestLogs.length = MAX_REQUEST_LOGS;
    try { info?.onLogId?.(entry.id); } catch (_) {}
    notifyRequestLogChange();
    return entry.id;
  }

  function updateRequestLog(id, patch) {
    if (!id || !patch || typeof patch !== 'object') return null;
    const entry = requestLogs.find(item => item.id === id);
    if (!entry) return null;
    if (patch.status !== undefined) entry.status = String(patch.status);
    if (patch.phase !== undefined) entry.phase = String(patch.phase);
    if (patch.httpStatus !== undefined) entry.httpStatus = patch.httpStatus;
    if (patch.finishReason !== undefined) entry.finishReason = String(patch.finishReason || '');
    if (patch.responseChars !== undefined) entry.responseChars = Math.max(0, Number(patch.responseChars) || 0);
    if (patch.responsePreview !== undefined) entry.responsePreview = previewLogText(patch.responsePreview, 4000);
    if (patch.error !== undefined) entry.error = String(patch.error || '');
    if (patch.durationMs !== undefined) entry.durationMs = Number(patch.durationMs);
    else if (['success', 'error', 'aborted'].includes(entry.status) && entry.startedAt) {
      entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
    }
    notifyRequestLogChange();
    return cloneRequestLog(entry);
  }

  function recordRequestLog(info) {
    const id = beginRequestLog(info);
    if (info?.status && info.status !== 'running') updateRequestLog(id, info);
    return id;
  }

  function getRequestLogs() {
    return requestLogs.map(cloneRequestLog);
  }

  function clearRequestLogs() {
    requestLogs.length = 0;
    notifyRequestLogChange();
  }

  function onRequestLogChange(fn) {
    if (typeof fn !== 'function') return () => {};
    requestLogListeners.add(fn);
    return () => requestLogListeners.delete(fn);
  }

  function logRequestParams(label, target, settings, body) {
    console.log('[世界引擎] API 请求参数:', {
      connectionMode: settings.connectionMode === 'proxy' ? 'proxy' : 'direct',
      transport: label,
      target,
      model: body.model,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      timeout_sec: timeoutSeconds(settings.apiTimeoutMs),
      message_count: Array.isArray(body.messages) ? body.messages.length : 0,
      prompt_chars: messageChars(body.messages),
      stream: false
    });
  }

  async function readResponseBody(resp) {
    const text = await resp.text();
    let data = null;
    let parseError = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { parseError = e; }
    }
    return { resp, data, text, parseError };
  }

  function responseDetail(result) {
    const data = result && result.data;
    const text = result && result.text;
    if (data && data.error && data.error.message) return data.error.message;
    if (data) return JSON.stringify(data);
    return text ? String(text).slice(0, 500) : '';
  }

  function requireJson(result, label) {
    if (result.parseError) {
      throw new Error((label || 'API') + ' 返回不是有效 JSON：' + result.parseError.message);
    }
    return result.data || {};
  }

  // 超时覆盖完整请求生命周期：fetch resolve 只代表响应头到达，正文读取仍可能卡住。
  async function fetchResponseWithTimeout(url, options, signal, timeoutMs) {
    timeoutMs = Number(timeoutMs) || 0;
    if (!(timeoutMs > 0)) {
      const resp = await fetch(url, { ...options, signal: signal || null });
      return readResponseBody(resp);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      return await readResponseBody(resp);
    } catch (e) {
      if (timedOut) throw timeoutError(timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }

  // [FIX] 经酒馆服务端转发的推演调用：浏览器 → 同源酒馆后端（无 CORS）→ 服务端代发到第三方 API。
  // 走 OpenAI source + reverse_proxy 路线，这样可把我们自己的 URL/KEY 透传给上游。
  async function executeLoggedChatCall(transportLabel, targetDisplay, doFetch, settings, body, signal, meta) {
    const startedAt = Date.now();
    const logId = beginRequestLog({
      module: meta?.module || 'world',
      purpose: meta?.purpose || 'API 请求',
      status: 'running',
      phase: '请求中',
      connectionMode: settings.connectionMode === 'proxy' ? 'proxy' : 'direct',
      target: targetDisplay,
      model: body.model,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      timeoutSec: timeoutSeconds(settings.apiTimeoutMs),
      attempt: meta?.attempt,
      maxAttempts: meta?.maxAttempts,
      promptChars: messageChars(body.messages),
      promptPreview: (body.messages || []).map(m => String(m?.content || '')).join('\n'),
      onLogId: meta?.onLogId
    });
    logRequestParams(transportLabel, targetDisplay, settings, body);
    try {
      const result = await doFetch();
      const resp = result.resp;
      const rawText = String(result.text || '');
      const durationMs = Math.max(0, Date.now() - startedAt);
      if (!resp.ok) {
        const msg = `HTTP ${resp.status}: ${responseDetail(result)}`;
        updateRequestLog(logId, {
          status: 'error',
          phase: 'HTTP 错误',
          httpStatus: resp.status,
          durationMs,
          responseChars: rawText.length,
          responsePreview: rawText || msg,
          error: msg
        });
        throw new Error(msg);
      }
      const data = requireJson(result, transportLabel === 'tavern-proxy' ? '酒馆代理' : 'API');
      if (data && data.error) {
        const msg = (transportLabel === 'tavern-proxy' ? '酒馆代理返回错误：' : 'API 返回错误：')
          + (data.error.message || JSON.stringify(data.error));
        updateRequestLog(logId, {
          status: 'error',
          phase: '接口错误',
          httpStatus: resp.status,
          durationMs,
          responseChars: rawText.length,
          responsePreview: rawText,
          error: msg
        });
        throw new Error(msg);
      }
      const choice = data.choices?.[0];
      if (!choice) {
        const msg = 'API 返回缺少 choices[0]';
        updateRequestLog(logId, {
          status: 'error',
          phase: '格式异常',
          httpStatus: resp.status,
          durationMs,
          responseChars: rawText.length,
          responsePreview: rawText,
          error: msg
        });
        throw new Error(msg);
      }
      const finishReason = String(choice.finish_reason || '');
      if (finishReason === 'length') {
        console.warn('[世界引擎] API 输出达到长度上限，将读取截断前已完整返回的字段');
      }
      const content = extractChoiceContent(choice);
      if (!String(content || '').trim()) {
        const msg = `API 返回内容为空${finishReason ? `（finish_reason: ${finishReason}）` : ''}`;
        updateRequestLog(logId, {
          status: 'error',
          phase: '空返回',
          httpStatus: resp.status,
          finishReason,
          durationMs,
          responseChars: rawText.length,
          responsePreview: rawText,
          error: msg
        });
        throw new Error(msg);
      }
      updateRequestLog(logId, {
        status: 'success',
        phase: '成功',
        httpStatus: resp.status,
        finishReason,
        durationMs,
        responseChars: content.length,
        responsePreview: content,
        error: ''
      });
      return content;
    } catch (error) {
      const durationMs = Math.max(0, Date.now() - startedAt);
      const aborted = Boolean(signal?.aborted || error?.name === 'AbortError');
      const existing = requestLogs.find(item => item.id === logId);
      if (existing && existing.status === 'running') {
        updateRequestLog(logId, {
          status: aborted ? 'aborted' : 'error',
          phase: aborted ? '已中止' : '请求异常',
          durationMs,
          error: aborted ? '请求已中止' : String(error?.message || error)
        });
      }
      throw error;
    }
  }

  async function callApiViaProxy(settings, body, signal, meta) {
    const base = getProxyBase(settings);
    if (!base) {
      const msg = '未配置 API URL，请在设置中填写';
      recordRequestLog({
        module: meta?.module || 'world',
        purpose: meta?.purpose || 'API 请求',
        status: 'error',
        phase: '配置缺失',
        connectionMode: 'proxy',
        target: '',
        model: body.model,
        attempt: meta?.attempt,
        maxAttempts: meta?.maxAttempts,
        promptChars: messageChars(body.messages),
        error: msg,
        onLogId: meta?.onLogId
      });
      throw new Error(msg);
    }
    const payload = {
      chat_completion_source: 'openai',
      reverse_proxy: base,
      proxy_password: settings.apiKey || '',
      model: body.model,
      messages: body.messages,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      stream: false
    };
    return executeLoggedChatCall('tavern-proxy', base, () => fetchResponseWithTimeout('/api/backends/chat-completions/generate', {
      method: 'POST',
      headers: tavernHeaders(),
      body: JSON.stringify(payload)
    }, signal, settings.apiTimeoutMs), settings, payload, signal, meta);
  }

  /**
   * 调用独立 API（非酒馆自带），OpenAI 兼容格式
   */
  async function callApi(prompt, maxTokens, temperature, signal, settingsOverride) {
    const meta = consumeRequestMeta(settingsOverride);
    let cleanOverride = settingsOverride;
    if (cleanOverride && Object.prototype.hasOwnProperty.call(cleanOverride, '__requestMeta')) {
      cleanOverride = { ...cleanOverride };
      delete cleanOverride.__requestMeta;
    }
    const settings = cleanOverride
      ? { ...REQUEST_DEFAULTS, ...cleanOverride }
      : getSettings();
    const selectedTemperature = temperature ?? settings.temperature;
    const configuredMaxTokens = Math.max(1, parseInt(maxTokens ?? settings.maxTokens) || 65000);
    // 兼容旧设置：曾保存为 4096 的输出上限自动提升到 65000。
    const selectedMaxTokens = configuredMaxTokens === 4096 ? 65000 : configuredMaxTokens;

    const body = {
      model: settings.model || 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: Number.isFinite(Number(selectedTemperature)) ? Math.max(0, Number(selectedTemperature)) : 0.7,
      max_tokens: selectedMaxTokens
    };

    // [FIX] 经酒馆代理：绕过第三方 API 的 CORS 限制，由酒馆 Node 服务端转发
    if (settings.connectionMode === 'proxy') {
      return callApiViaProxy(settings, body, signal, meta);
    }

    const url = normalizeUrl(settings.apiUrl);
    if (!url) {
      const msg = '未配置 API URL，请在设置中填写';
      recordRequestLog({
        module: meta?.module || 'world',
        purpose: meta?.purpose || 'API 请求',
        status: 'error',
        phase: '配置缺失',
        connectionMode: 'direct',
        target: '',
        model: body.model,
        attempt: meta?.attempt,
        maxAttempts: meta?.maxAttempts,
        promptChars: messageChars(body.messages),
        error: msg,
        onLogId: meta?.onLogId
      });
      throw new Error(msg);
    }

    const headers = {
      'Content-Type': 'application/json'
    };
    if (settings.apiKey) {
      headers['Authorization'] = 'Bearer ' + settings.apiKey;
    }

    return executeLoggedChatCall('direct', url, () => fetchResponseWithTimeout(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }, signal, settings.apiTimeoutMs), settings, body, signal, meta);
  }

  function repairTruncatedJSON(content) {
    const rootStart = content.indexOf('{');
    if (rootStart === -1) return null;

    const stack = [];
    const candidates = [];
    let inString = false;
    let escaped = false;

    for (let i = rootStart; i < content.length; i++) {
      const char = content[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        stack.push(char);
      } else if (char === '}' || char === ']') {
        stack.pop();
      } else if (char === ',' && stack.length > 0) {
        candidates.push({
          end: i,
          suffix: stack.slice().reverse().map(open => open === '{' ? '}' : ']').join('')
        });
      }
    }

    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = content.slice(rootStart, candidates[i].end) + candidates[i].suffix;
      try {
        return JSON.parse(candidate);
      } catch(e) {}
    }
    return null;
  }

  /**
   * 解析 API 返回的 JSON（容错处理）
   */
  function parseJSON(text) {
    let content = String(text || '').trim();
    content = content.replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try {
      return JSON.parse(content);
    } catch(e) {}

    // 从夹杂说明、思考文本或多个代码块的返回中提取顶层 JSON；
    // 模型的最终答案通常位于最后，因此采用最后一个有效对象。
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    let result = null;
    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (char === '}' && depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          try {
            result = JSON.parse(content.slice(start, i + 1));
          } catch(e2) {}
          start = -1;
        }
      }
    }
    return result || repairTruncatedJSON(content);
  }

  /**
   * 获取模型列表（OpenAI 兼容格式）
   */
  async function fetchModelList(settingsOverride) {
    const meta = consumeRequestMeta(settingsOverride);
    let cleanOverride = settingsOverride;
    if (cleanOverride && Object.prototype.hasOwnProperty.call(cleanOverride, '__requestMeta')) {
      cleanOverride = { ...cleanOverride };
      delete cleanOverride.__requestMeta;
    }
    const settings = cleanOverride
      ? { ...REQUEST_DEFAULTS, ...cleanOverride }
      : getSettings();
    const baseUrl = normalizeUrl(settings.apiUrl).replace(/\/chat\/completions$/, '');
    const startedAt = Date.now();
    const isProxy = settings.connectionMode === 'proxy';
    const targetUrl = isProxy ? baseUrl : (baseUrl ? baseUrl + '/models' : '');
    const logId = beginRequestLog({
      module: meta?.module || 'world',
      purpose: meta?.purpose || '获取模型列表',
      status: 'running',
      phase: '请求中',
      connectionMode: isProxy ? 'proxy' : 'direct',
      target: targetUrl,
      model: '',
      timeoutSec: timeoutSeconds(settings.apiTimeoutMs),
      onLogId: meta?.onLogId
    });

    try {
      // [FIX] 经酒馆代理：用酒馆 /status 端点拉模型列表，绕过 CORS
      if (isProxy) {
        if (!baseUrl) throw new Error('未配置 API URL，请在设置中填写');
        const result = await fetchResponseWithTimeout('/api/backends/chat-completions/status', {
          method: 'POST',
          headers: tavernHeaders(),
          body: JSON.stringify({
            chat_completion_source: 'openai',
            reverse_proxy: baseUrl,
            proxy_password: settings.apiKey || ''
          })
        }, null, settings.apiTimeoutMs);
        if (!result.resp.ok) throw new Error(`HTTP ${result.resp.status}: ${responseDetail(result)}`);
        const data = requireJson(result, '酒馆代理');
        if (data && data.error) throw new Error('酒馆代理拉取模型失败（请检查 URL/密钥是否正确）');
        if (data.data && Array.isArray(data.data)) {
          const list = data.data.map(m => m.id);
          updateRequestLog(logId, { status: 'success', phase: '成功', httpStatus: result.resp.status, durationMs: Date.now() - startedAt, responsePreview: `获取到 ${list.length} 个模型` });
          return list;
        }
        throw new Error('无法解析模型列表');
      }

      const url = baseUrl + '/models';
      const headers = { 'Content-Type': 'application/json' };
      if (settings.apiKey) headers['Authorization'] = 'Bearer ' + settings.apiKey;

      const result = await fetchResponseWithTimeout(url, { headers }, null, settings.apiTimeoutMs);
      if (!result.resp.ok) throw new Error(`HTTP ${result.resp.status}: ${responseDetail(result)}`);
      const data = requireJson(result, 'API');
      if (data.data && Array.isArray(data.data)) {
        const list = data.data.map(m => m.id);
        updateRequestLog(logId, { status: 'success', phase: '成功', httpStatus: result.resp.status, durationMs: Date.now() - startedAt, responsePreview: `获取到 ${list.length} 个模型` });
        return list;
      }
      throw new Error('无法解析模型列表');
    } catch (error) {
      updateRequestLog(logId, {
        status: 'error',
        phase: '拉取失败',
        durationMs: Date.now() - startedAt,
        error: String(error?.message || error)
      });
      throw error;
    }
  }

  async function postJsonEndpoint(url, apiKey, payload, signal, timeoutMs, label, meta) {
    const startedAt = Date.now();
    const logId = beginRequestLog({
      module: meta?.module || 'memory',
      purpose: meta?.purpose || label,
      status: 'running',
      phase: '请求中',
      connectionMode: 'direct',
      target: url,
      model: String(payload?.model || ''),
      timeoutSec: timeoutSeconds(timeoutMs),
      promptChars: JSON.stringify(payload || {}).length,
      onLogId: meta?.onLogId
    });
    try {
      if (!url) throw new Error(`未配置 ${label} API URL`);
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
      const result = await fetchResponseWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      }, signal, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 60000);
      if (!result.resp.ok) {
        const msg = `${label} HTTP ${result.resp.status}: ${responseDetail(result)}`;
        updateRequestLog(logId, {
          status: 'error',
          phase: 'HTTP 错误',
          httpStatus: result.resp.status,
          durationMs: Date.now() - startedAt,
          responseChars: String(result.text || '').length,
          responsePreview: result.text || msg,
          error: msg
        });
        throw new Error(msg);
      }
      const json = requireJson(result, label);
      updateRequestLog(logId, {
        status: 'success',
        phase: '成功',
        httpStatus: result.resp.status,
        durationMs: Date.now() - startedAt,
        responseChars: String(result.text || '').length,
        responsePreview: meta?.summarize ? meta.summarize(json) : previewLogText(result.text, 600)
      });
      return json;
    } catch (error) {
      const existing = requestLogs.find(item => item.id === logId);
      if (existing && existing.status === 'running') {
        const aborted = Boolean(signal?.aborted || error?.name === 'AbortError');
        updateRequestLog(logId, {
          status: aborted ? 'aborted' : 'error',
          phase: aborted ? '已中止' : '请求异常',
          durationMs: Date.now() - startedAt,
          error: aborted ? '请求已中止' : String(error?.message || error)
        });
      }
      throw error;
    }
  }

  async function callEmbeddingApi(texts, settingsOverride, signal) {
    const input = Array.isArray(texts) ? texts.map(t => String(t ?? '')) : [String(texts ?? '')];
    if (!input.length) return [];
    const cfg = settingsOverride || {};
    const url = normalizeEndpointUrl(cfg.apiUrl || cfg.embeddingApiUrl, '/embeddings');
    const model = String(cfg.model || cfg.embeddingModel || '').trim();
    if (!model) throw new Error('未配置 Embedding 模型名称');
    const data = await postJsonEndpoint(
      url,
      String(cfg.apiKey ?? cfg.embeddingApiKey ?? '').trim(),
      { model, input, encoding_format: 'float' },
      signal,
      cfg.apiTimeoutMs ?? 60000,
      'Embedding API',
      {
        module: 'memory',
        purpose: `Embedding 向量（${input.length} 条）`,
        summarize: json => {
          const count = Array.isArray(json?.data) ? json.data.length : 0;
          const dim = Array.isArray(json?.data?.[0]?.embedding) ? json.data[0].embedding.length : 0;
          return `返回 ${count} 条向量（维度 ${dim}）`;
        }
      }
    );
    const rows = Array.isArray(data.data) ? data.data.slice() : null;
    if (!rows || !rows.length) throw new Error('Embedding API 返回缺少 data 向量数组');
    rows.sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0));
    const vectors = rows.map(row => Array.isArray(row?.embedding) ? row.embedding.map(Number) : null);
    if (vectors.some(v => !v || !v.length)) throw new Error('Embedding API 返回包含无效向量');
    return vectors;
  }

  async function callRerankApi(query, documents, settingsOverride, signal) {
    const docs = Array.isArray(documents) ? documents.map(d => String(d ?? '')) : [];
    if (!docs.length) return [];
    const cfg = settingsOverride || {};
    const url = normalizeEndpointUrl(cfg.apiUrl || cfg.rerankApiUrl, '/rerank');
    const model = String(cfg.model || cfg.rerankModel || '').trim();
    if (!model) throw new Error('未配置 Rerank 模型名称');
    const topN = Math.max(1, Math.min(docs.length, parseInt(cfg.topN || cfg.rerankTopK) || docs.length));
    const data = await postJsonEndpoint(
      url,
      String(cfg.apiKey ?? cfg.rerankApiKey ?? '').trim(),
      { model, query: String(query ?? ''), documents: docs, top_n: topN, return_documents: false },
      signal,
      cfg.apiTimeoutMs ?? 60000,
      'Rerank API',
      {
        module: 'memory',
        purpose: `Rerank 重排（${docs.length} 候选）`,
        summarize: json => {
          const list = Array.isArray(json?.results) ? json.results : (Array.isArray(json?.data) ? json.data : []);
          return `重排返回 ${list.length} 条相关性打分`;
        }
      }
    );
    const list = Array.isArray(data.results) ? data.results : (Array.isArray(data.data) ? data.data : null);
    if (!list) throw new Error('Rerank API 返回缺少 results 数组');
    return list
      .map(item => ({
        index: parseInt(item?.index, 10),
        score: Number(item?.relevance_score ?? item?.score ?? 0)
      }))
      .filter(item => Number.isInteger(item.index) && item.index >= 0 && item.index < docs.length && Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score);
  }

  return {
    callApi, callEmbeddingApi, callRerankApi, parseJSON, getSettings, fetchModelList,
    setNextRequestMeta, getRequestLogs, clearRequestLogs, updateRequestLog, recordRequestLog, onRequestLogChange
  };
})();
