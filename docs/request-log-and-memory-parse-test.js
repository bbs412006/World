// node docs/request-log-and-memory-parse-test.js — 三模块统一请求日志与记忆解析增强离线测试
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const store = new Map();
let refreshCount = 0;

const chat = [
  { is_user: false, name: '旁白', mes: '夜风微凉。' },
  { is_user: true, name: '林墨', mes: '夜探城南旧宅。' },
  { is_user: false, name: '旁白', mes: '沈清秋在廊下等你多时，递上一枚铜符。' }
];

function makeSandbox(fetchImpl) {
  const sandbox = {
    window: null,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    Date,
    Math,
    Map,
    Set,
    Array,
    Object,
    JSON,
    RegExp,
    Error,
    fetch: fetchImpl,
    SillyTavern: {
      getContext: () => ({
        chatId: 'reqlog-chat',
        chat,
        setExtensionPrompt() {},
        extensionPrompts: {},
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-csrf' })
      })
    },
    WORLD_ENGINE_STORE: {
      getItem: k => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    WORLD_ENGINE_CORE: {
      getChatId: () => 'reqlog-chat',
      getChatLayer: () => 1,
      filterDialogue: text => text,
      loadState: () => ({ round: 1, worldDigest: '城南夜市冷清' })
    },
    WORLD_ENGINE_UI: {
      refreshRequestLogs() { refreshCount++; },
      setMemoryEvolvingUI() {},
      refresh() {}
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of [
    'world-engine-api.js',
    'memory-engine-settings.js',
    'memory-engine-data.js',
    'memory-engine-timeline.js',
    'memory-engine-prompt.js',
    'memory-engine-small-summary-prompt.js',
    'memory-engine.js'
  ]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

(async () => {
  let mode = 'thought-json';
  const capturedBodies = [];
  const sandbox = makeSandbox(async (url, init) => {
    capturedBodies.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (mode === 'stream-sse-reader') {
      const sseBytes = Buffer.from([
        ': keepalive',
        'data: {"id":"chatcmpl-1","model":"gpt-stream","choices":[{"index":0,"delta":{"role":"assistant"}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{"content":"{\\"events\\":[],"}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{"content":"\\"world_digest\\":\\"夜雨流式推演完成\\"}"}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: {"usage":{"total_tokens":42},"choices":[]}',
        '',
        'data: [DONE]',
        ''
      ].join('\n'), 'utf8');
      // 故意在多字节中文 UTF-8 字符中间劈开字节流，校验 TextDecoder({ stream: true })
      const splitAt = sseBytes.indexOf(Buffer.from('夜雨流式', 'utf8')) + 4;
      const parts = [sseBytes.subarray(0, splitAt), sseBytes.subarray(splitAt)];
      let idx = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: k => String(k).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null },
        body: {
          getReader() {
            return {
              async read() {
                if (idx >= parts.length) return { done: true, value: undefined };
                return { done: false, value: parts[idx++] };
              },
              releaseLock() {}
            };
          }
        }
      };
    }
    if (mode === 'stream-proxy-text') {
      return {
        ok: true,
        status: 200,
        headers: { get: k => String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null },
        async text() {
          return 'data: {"choices":[{"delta":{"content":"{\\"nodeUpdates\\":[],"}}]}\n\ndata: {"choices":[{"delta":{"content":"\\"proposals\\":[]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n';
        }
      };
    }
    if (mode === 'stream-json-fallback') {
      return {
        ok: true,
        status: 200,
        headers: { get: k => String(k).toLowerCase() === 'content-type' ? 'application/json' : null },
        async text() {
          return JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":"fallback-json"}' } }] });
        }
      };
    }
    if (mode === 'stream-sse-error') {
      return {
        ok: true,
        status: 200,
        headers: { get: k => String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null },
        async text() {
          return 'data: {"error":{"message":"upstream stream broken"}}\n\n';
        }
      };
    }
    if (mode === 'stream-idle-stall') {
      let chunkIdx = 0;
      const firstChunk = Buffer.from('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n', 'utf8');
      return {
        ok: true,
        status: 200,
        headers: { get: k => String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null },
        body: {
          getReader() {
            return {
              read() {
                if (chunkIdx++ === 0) {
                  return Promise.resolve({ done: false, value: firstChunk });
                }
                return new Promise((_, reject) => {
                  if (init?.signal?.aborted) {
                    const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return;
                  }
                  init?.signal?.addEventListener('abort', () => {
                    const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
                  }, { once: true });
                });
              },
              cancel() { return Promise.resolve(); },
              releaseLock() {}
            };
          }
        }
      };
    }
    if (mode === 'json-ok') {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });
        }
      };
    }
    if (mode === 'http-401') {
      return {
        ok: false,
        status: 401,
        async text() {
          return JSON.stringify({ error: { message: 'invalid api key' } });
        }
      };
    }
    if (mode === 'thought-json') {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{
              finish_reason: 'stop',
              message: {
                content: '<thought>分析本轮人物与时间：[需检查姓名] 沈清秋递交铜符</thought>\n以下是结构化结果：\n```json\n{"personal_memory":[{"name":["沈清秋"],"known_by":[],"memory":"在城南旧宅廊下等待林墨并递交铜符。","time":""}],"entity_updates":[],"ongoing_fact_updates":[],"character_arc_updates":[],"small_summary":"林墨夜探城南旧宅，沈清秋在廊下迎候并递出铜符作为凭证。","small_summary_keywords":["城南旧宅","铜符"],"small_summary_entities":["林墨","沈清秋"],"small_summary_impact":"normal"}\n```'
              }
            }]
          });
        }
      };
    }
    if (mode === 'parts-array') {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{
              finish_reason: 'stop',
              message: {
                content: [
                  { type: 'text', text: '{"events":[],"factions":[],"worldTrends":[],"winds":[],"world_digest":"局势平缓"}' }
                ]
              }
            }]
          });
        }
      };
    }
    if (mode === 'empty-safety') {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{
              finish_reason: 'SAFETY',
              message: { content: '' }
            }]
          });
        }
      };
    }
    if (mode === 'http-429') {
      return {
        ok: false,
        status: 429,
        async text() {
          return JSON.stringify({ error: { message: 'Vertex quota limit exceeded' } });
        }
      };
    }
    if (mode === 'bad-json') {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{
              finish_reason: 'stop',
              message: { content: '抱歉，本轮我没能输出 JSON，这是一段纯说明文本。' }
            }]
          });
        }
      };
    }
    if (url.includes('/embeddings')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] });
        }
      };
    }
    return { ok: false, status: 500, async text() { return 'unexpected'; } };
  });

  const api = sandbox.WORLD_ENGINE_API;
  sandbox.MEMORY_ENGINE_SETTINGS.saveSettings({
    apiUrl: 'https://proxy.example.com/v1?key=secret-query-123',
    apiKey: 'secret-bearer-key',
    model: 'gemini-2.5-pro',
    evolveMode: 'manual',
    tableFillMaxRetries: 0
  });

  // 1. 记忆提取遇到 <thought> 中夹带 [...] 与说明前缀时，应正常解析成功并记录到日志
  const extractRes = await sandbox.MEMORY_ENGINE.manualExtract();
  assert.ok(extractRes.added >= 1, '带 <thought> 思维链与围栏的 JSON 记忆返回应能成功解析');

  // 2. 世界引擎 multimodal parts 数组响应支持与日志记录
  mode = 'parts-array';
  api.setNextRequestMeta({ module: 'world', purpose: '世界推演' });
  const worldRaw = await api.callApi('测试世界提示词', 1000, 0.7, null, { apiUrl: 'https://proxy.example.com/v1', model: 'gpt-4o' });
  assert.ok(worldRaw.includes('局势平缓'), '应兼容内容分片数组返回');

  // 3. 空内容返错携带 finish_reason，并进入错误日志
  mode = 'empty-safety';
  api.setNextRequestMeta({ module: 'outline', purpose: '检查剧情进度' });
  await assert.rejects(
    api.callApi('测试大纲提示词', 1000, 0.2, null, { apiUrl: 'https://proxy.example.com/v1', model: 'gemini-2.5-flash' }),
    /finish_reason: SAFETY/
  );

  // 4. HTTP 429 限流错误日志
  mode = 'http-429';
  chat.push({ is_user: true, name: '林墨', mes: '追问铜符来历。' }, { is_user: false, name: '旁白', mes: '沈清秋沉默片刻。' });
  await assert.rejects(sandbox.MEMORY_ENGINE.manualExtract(), /HTTP 429/);

  // 5. HTTP 200 但正文无 JSON 时，请求日志应被标记为「解析失败」而非假成功
  mode = 'bad-json';
  await assert.rejects(sandbox.MEMORY_ENGINE.manualExtract(), /没有合法 JSON/);

  // 6. Embedding 端点也会统一记录
  mode = 'embedding';
  await api.callEmbeddingApi(['测试句'], { embeddingApiUrl: 'https://vec.example.com/v1', embeddingModel: 'BAAI/bge-m3' });

  const logs = api.getRequestLogs();
  assert.strictEqual(logs.length, 6, '应统一记录全部 6 次三模块及向量请求');
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes('secret-query-123') && !serialized.includes('secret-bearer-key'), '请求日志绝不能泄露任何 API Key');
  assert.ok(logs.some(l => l.module === 'memory' && l.status === 'success' && l.purpose.includes('填表')), '记忆成功请求应带模块和任务名称');
  assert.ok(logs.some(l => l.module === 'world' && l.status === 'success'), '世界请求应带 world 模块标记');
  assert.ok(logs.some(l => l.module === 'outline' && l.status === 'error' && l.error.includes('SAFETY')), '大纲安全拦截空返回应进失败日志');
  assert.ok(logs.some(l => l.module === 'memory' && l.httpStatus === 429 && l.status === 'error'), '429 错误应保留 HTTP 状态和错误信息');
  assert.ok(logs.some(l => l.module === 'memory' && l.phase === '解析失败' && l.responsePreview.includes('纯说明文本')), 'JSON 解析失败应保留原返回文本并标注解析失败');
  assert.ok(refreshCount > 0, '日志写入与更新应通知顶部 UI 刷新');

  api.clearRequestLogs();
  assert.strictEqual(api.getRequestLogs().length, 0, '清空日志后应归零');

  // 7. 流式传输（stream: true）：直连分块 SSE、酒馆代理流式、JSON 回退及流式错误捕获
  mode = 'stream-sse-reader';
  api.setNextRequestMeta({ module: 'world', purpose: '流式世界推演' });
  const streamDirectRaw = await api.callApi('流式测试', 1000, 0.7, null, {
    apiUrl: 'https://proxy.example.com/v1',
    model: 'gpt-stream',
    stream: true
  });
  assert.strictEqual(JSON.parse(streamDirectRaw).world_digest, '夜雨流式推演完成', 'SSE 分片流式与多字节 UTF-8 拼装应完整还原');
  assert.strictEqual(capturedBodies[capturedBodies.length - 1].body.stream, true, '勾选流式后直连请求体应携带 stream: true');

  mode = 'stream-proxy-text';
  api.setNextRequestMeta({ module: 'outline', purpose: '流式大纲核对' });
  const streamProxyRaw = await api.callApi('代理流式测试', 1000, 0.2, null, {
    apiUrl: 'https://proxy.example.com/v1',
    model: 'gemini-stream',
    connectionMode: 'proxy',
    stream: true
  });
  assert.deepStrictEqual(JSON.parse(streamProxyRaw), { nodeUpdates: [], proposals: [] }, '酒馆代理流式 SSE 应完整拼装');
  assert.strictEqual(capturedBodies[capturedBodies.length - 1].body.stream, true, '经酒馆代理在勾选流式后应转发 stream: true');

  mode = 'stream-json-fallback';
  api.setNextRequestMeta({ module: 'memory', purpose: '流式兼容回退' });
  const streamFallbackRaw = await api.callApi('兼容非流回退', 1000, 0.2, null, {
    apiUrl: 'https://proxy.example.com/v1',
    model: 'gpt-4o',
    stream: true
  });
  assert.strictEqual(JSON.parse(streamFallbackRaw).ok, 'fallback-json', '上游忽略 stream=true 返回普通 JSON 时应自动兼容解析');

  mode = 'stream-sse-error';
  api.setNextRequestMeta({ module: 'world', purpose: '流式错误信息' });
  await assert.rejects(
    api.callApi('流式报错测试', 1000, 0.7, null, { apiUrl: 'https://proxy.example.com/v1', model: 'gpt-stream', stream: true }),
    /upstream stream broken/
  );

  const streamLogs = api.getRequestLogs();
  assert.strictEqual(streamLogs.length, 4, '4 次流式调用应均写入请求日志');
  assert.ok(streamLogs.every(l => l.stream === true), '流式请求日志应准确标记 stream=true');
  assert.ok(streamLogs.some(l => l.module === 'world' && l.status === 'success' && l.finishReason === 'stop'));
  assert.ok(streamLogs.some(l => l.module === 'outline' && l.connectionMode === 'proxy' && l.status === 'success'));
  assert.ok(streamLogs.some(l => l.module === 'world' && l.status === 'error' && l.error.includes('upstream stream broken')));

  // 8. 高级 API 优化：jsonMode / topP / reasoningEffort、流式空闲超时、连接测试与智能重试
  mode = 'json-ok';
  const beforeAdvLen = capturedBodies.length;
  await api.callApi('测试默认不传可选参数', 1000, 0.7, null, {
    apiUrl: 'https://proxy.example.com/v1',
    model: 'claude-sonnet',
    jsonMode: false,
    topP: null,
    reasoningEffort: ''
  });
  const defaultBody = capturedBodies[beforeAdvLen].body;
  assert.strictEqual('response_format' in defaultBody, false, '未勾选 jsonMode 时不得发送 response_format');
  assert.strictEqual('top_p' in defaultBody, false, 'topP 为空时不得发送 top_p（避免与部分渠道冲突）');
  assert.strictEqual('reasoning_effort' in defaultBody, false, 'reasoningEffort 为空时不得发送 reasoning_effort');

  await api.callApi('测试高级参数透传 JSON', 1000, 0.5, null, {
    apiUrl: 'https://proxy.example.com/v1',
    model: 'gpt-5',
    jsonMode: true,
    topP: 0.85,
    reasoningEffort: 'low'
  });
  const advBody = capturedBodies[beforeAdvLen + 1].body;
  assert.deepStrictEqual(advBody.response_format, { type: 'json_object' }, '启用 jsonMode 应传 response_format');
  assert.strictEqual(advBody.top_p, 0.85, '指定 topP 应传 top_p');
  assert.strictEqual(advBody.reasoning_effort, 'low', '指定 reasoningEffort 应传 reasoning_effort');

  // 流式分片空闲超时应独立于长总超时快速中止卡死流
  mode = 'stream-idle-stall';
  await assert.rejects(
    api.callApi('卡死流测试', 1000, 0.7, null, {
      apiUrl: 'https://proxy.example.com/v1',
      model: 'gpt-stream',
      stream: true,
      apiTimeoutMs: 5000,
      streamIdleTimeoutMs: 60
    }),
    /流式接收空闲超时/
  );

  // 连接测试
  mode = 'json-ok';
  const testRes = await api.testConnection({
    apiUrl: 'https://proxy.example.com/v1',
    apiKey: 'k',
    model: 'gpt-4o',
    jsonMode: true
  }, { module: 'memory' });
  assert.strictEqual(testRes.ok, true);
  assert.ok(testRes.preview.includes('"ok":true'));
  assert.ok(api.getRequestLogs().some(l => l.module === 'memory' && l.purpose === '连接测试' && l.jsonMode === true));

  // 智能重试：401 永久错误与 SAFETY 过滤立即失败不重发；429 瞬时限流经退避重试恢复成功
  mode = 'http-401';
  let authAttempts = 0;
  await assert.rejects(
    api.executeWithRetry(async () => {
      authAttempts++;
      return api.callApi('鉴权失败', 500, 0.2, null, { apiUrl: 'https://proxy.example.com/v1', model: 'gpt-4o' });
    }, { retries: 3, baseDelayMs: 5 }),
    /HTTP 401/
  );
  assert.strictEqual(authAttempts, 1, 'HTTP 401 等不可恢复错误不应浪费重试次数');

  let transientAttempts = 0;
  const retryEvents = [];
  const recovered = await api.executeWithRetry(async () => {
    transientAttempts++;
    mode = transientAttempts < 2 ? 'http-429' : 'json-ok';
    return api.callApi('限流恢复', 500, 0.2, null, { apiUrl: 'https://proxy.example.com/v1', model: 'gpt-4o' });
  }, {
    retries: 2,
    baseDelayMs: 10,
    onRetry: info => retryEvents.push(info)
  });
  assert.strictEqual(transientAttempts, 2, 'HTTP 429 限流应在重试后恢复成功');
  assert.strictEqual(retryEvents.length, 1);
  assert.ok(recovered.includes('"ok":true'));

  const uiSrc = fs.readFileSync(path.join(root, 'world-engine-ui.js'), 'utf8');
  assert.ok(uiSrc.includes('id="we-reqlog-dock"') && uiSrc.includes('id="we-reqlog-drawer"') && uiSrc.includes('data-reqlog-filter="error"'), '面板顶部应集成统一请求日志栏与可展开抽屉');

  console.log('request log & memory parse hardening tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
