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
        extensionPrompts: {}
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
    'memory-engine-big-summary-prompt.js',
    'memory-engine.js'
  ]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

(async () => {
  let mode = 'thought-json';
  const sandbox = makeSandbox(async (url) => {
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
    evolveMode: 'manual'
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
  assert.ok(logs.some(l => l.module === 'memory' && l.status === 'success' && l.purpose.includes('人物')), '记忆成功请求应带模块和任务名称');
  assert.ok(logs.some(l => l.module === 'world' && l.status === 'success'), '世界请求应带 world 模块标记');
  assert.ok(logs.some(l => l.module === 'outline' && l.status === 'error' && l.error.includes('SAFETY')), '大纲安全拦截空返回应进失败日志');
  assert.ok(logs.some(l => l.module === 'memory' && l.httpStatus === 429 && l.status === 'error'), '429 错误应保留 HTTP 状态和错误信息');
  assert.ok(logs.some(l => l.module === 'memory' && l.phase === '解析失败' && l.responsePreview.includes('纯说明文本')), 'JSON 解析失败应保留原返回文本并标注解析失败');
  assert.ok(refreshCount > 0, '日志写入与更新应通知顶部 UI 刷新');

  api.clearRequestLogs();
  assert.strictEqual(api.getRequestLogs().length, 0, '清空日志后应归零');

  const uiSrc = fs.readFileSync(path.join(root, 'world-engine-ui.js'), 'utf8');
  assert.ok(uiSrc.includes('id="we-reqlog-dock"') && uiSrc.includes('id="we-reqlog-drawer"') && uiSrc.includes('data-reqlog-filter="error"'), '面板顶部应集成统一请求日志栏与可展开抽屉');

  console.log('request log & memory parse hardening tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
