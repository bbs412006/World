// Embedding + Rerank 语义召回与向量缓存维护测试：node docs/memory-vector-recall-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const store = new Map();
let currentChatId = 'vec-chat-1';
let injection = '';
let embeddingRequests = 0;
let rerankRequests = 0;
let failRerank = false;
const fetchCalls = [];

const chat = [
  { is_user: false, name: '旁白', mes: '开场白。' },
  { is_user: true, name: '主角', mes: '夜深了，我们正在寻找打开皇陵地下金库的信物。' }
];

// 模拟 4 维简易语义向量，使零字面词重合的文本也能按设计余弦相似度召回
function mockVecFor(text) {
  const t = String(text || '');
  if (t.includes('皇陵地下金库') || t.includes('玄铁令') || t.includes('秘库')) return [0.95, 0.2, 0.1, 0];
  if (t.includes('海图') || t.includes('航海')) return [0.75, 0.65, 0, 0];
  if (t.includes('药草')) return [0, 0, 0.2, 0.98];
  return [0.5, 0.1, 0, 0];
}

const sandbox = {
  window: null,
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  document: { getElementById: () => null },
  fetch: async (url, init) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    if (String(url).endsWith('/embeddings')) {
      embeddingRequests++;
      const inputs = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: inputs.map((txt, index) => ({ index, embedding: mockVecFor(txt) }))
          });
        }
      };
    }
    if (String(url).endsWith('/rerank')) {
      rerankRequests++;
      if (failRerank) {
        return { ok: false, status: 500, async text() { return '{"error":{"message":"rerank offline"}}'; } };
      }
      const docs = JSON.parse(init.body).documents;
      // 模拟交叉编码精排：命中“玄铁令/秘库”得高分 0.92，仅有普通“海图”伪相关低分 0.15（低于阈值 0.2 被过滤）
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            results: docs.map((d, index) => ({
              index,
              relevance_score: d.includes('玄铁令') || d.includes('秘库') ? 0.92 : (d.includes('海图') ? 0.12 : 0.45)
            }))
          });
        }
      };
    }
    throw new Error('Unexpected fetch url: ' + url);
  },
  SillyTavern: {
    getContext: () => ({
      chat,
      setExtensionPrompt: (_name, content) => { injection = content; }
    })
  },
  WORLD_ENGINE_STORE: {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: key => store.delete(key)
  },
  WORLD_ENGINE_CORE: {
    getChatId: () => currentChatId,
    getChatLayer: () => chat.length - 1,
    filterDialogue: v => v
  },
  WORLD_ENGINE_CHATCACHE: { forScope: () => ({ afterEvolution() {} }) },
  WORLD_ENGINE_UI: { setMemoryEvolvingUI() {}, refresh() {} }
};
sandbox.window = sandbox;

for (const file of [
  'world-engine-api.js',
  'memory-engine-settings.js',
  'memory-engine-data.js',
  'memory-engine-prompt.js',
  'memory-engine-small-summary-prompt.js',
  'memory-engine-big-summary-prompt.js',
  'memory-engine-vector.js',
  'memory-engine.js'
]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

sandbox.MEMORY_ENGINE_SETTINGS.saveSettings({
  engineEnabled: true,
  injectIntoPrompt: true,
  searchDepth: 5,
  recallArchivedSmallLimit: 3,
  vectorEnabled: true,
  vectorAutoMaintain: true,
  embeddingApiUrl: 'https://api.siliconflow.cn/v1',
  embeddingApiKey: 'sk-test-emb',
  embeddingModel: 'BAAI/bge-m3',
  rerankEnabled: true,
  rerankApiUrl: '',
  rerankApiKey: '',
  rerankModel: 'BAAI/bge-reranker-v2-m3',
  vectorTopK: 10,
  vectorThreshold: 0.35,
  rerankTopK: 4,
  rerankThreshold: 0.2
});

(async () => {
  // 预置 2 条已被大总述折叠的早期纪要 + 1 个未在当前正文直接点名的实体，且故意让字面关键词与当前对话零重合
  const state = sandbox.MEMORY_ENGINE_DATA.defaultState();
  state.event_memory.small_summaries = [
    {
      id: 'small_000001',
      startLayer: 1,
      endLayer: 2,
      content: '先帝遗诏指定以乌金玄铁令开启南郊秘库。',
      keywords: ['乌金', '秘库'],
      status: 'valid',
      revision: 1
    },
    {
      id: 'small_000002',
      startLayer: 3,
      endLayer: 4,
      content: '船老大送来一份旧海图与远洋补给清单。',
      keywords: ['海图'],
      status: 'valid',
      revision: 1
    }
  ];
  state.event_memory.big_summaries = [
    {
      id: 'big_000001',
      startLayer: 1,
      endLayer: 4,
      content: '早年众人在江南与海港各自收集过若干杂项物件。',
      childIds: ['small_000001', 'small_000002'],
      status: 'valid',
      revision: 1
    }
  ];
  state.entity_memory.object = [
    {
      id: 'obj_000001',
      name: '乌金玄铁令',
      aliases: ['秘库令'],
      description: '重约二斤的玄铁信物，乃皇室秘库唯一匙钥。',
      history: [{ time: '', event: '由太傅密藏多年。' }]
    }
  ];
  sandbox.MEMORY_ENGINE_DATA.saveState(state);

  const vec = sandbox.MEMORY_ENGINE_VECTOR;

  // 1. 维护向量索引，并检验第二次调用因哈希匹配完全跳过重复计费
  const m1 = await vec.maintainVectors();
  assert.strictEqual(m1.updated, 3, '首次应算齐 2 条纪要 + 1 条实体共 3 项向量');
  const callsAfterFirst = embeddingRequests;
  const m2 = await vec.maintainVectors();
  assert.strictEqual(m2.updated, 0);
  assert.strictEqual(m2.skipped, true);
  assert.strictEqual(embeddingRequests, callsAfterFirst, '内容与模型未变时不得发起重复 Embedding 请求');

  // 2. 运行 Embedding + Rerank 语义召回：当前正文零出现“玄铁令/秘库”字面词，仍应精准唤醒且通过 Rerank 过滤伪相关的“海图”
  const recallRes = await vec.recallForQuery(chat[1].mes, { autoMaintain: false });
  assert.strictEqual(recallRes.method, 'embedding+rerank');
  assert.ok(rerankRequests === 1, '启用 Rerank 时应自动复用 Embedding URL/Key 调用 /rerank');
  assert.ok(recallRes.smallScores.small_000001 > 0.9, '秘库纪要应在 Rerank 中拿到高分');
  assert.ok(recallRes.entityScores['object:obj_000001'] > 0.9, '实体应在 Rerank 中拿到高分');
  assert.strictEqual(recallRes.smallScores.small_000002, undefined, '低于 rerankThreshold 的海图伪相关结果应被过滤');
  assert.ok(injection.includes('【语义与关键词召回历史细节】'), '注入正文应出现语义召回的历史折叠细节');
  assert.ok(injection.includes('乌金玄铁令开启南郊秘库'), '命中的旧纪要正文应成功注入');
  assert.ok(!injection.includes('旧海图'), '被 Rerank 排除的伪相关纪要不应注入');
  assert.ok(injection.includes('【物件：乌金玄铁令】'), '即便是对话未直呼其名的实体也应凭借语义高分破盲区唤醒');

  // 3. Rerank API 故障降级：平滑退回仅 Embedding 余弦排序，绝不报错崩断
  failRerank = true;
  const fallbackRecall = await vec.recallForQuery('继续追查金库下落与相关物品', { autoMaintain: false });
  assert.strictEqual(fallbackRecall.method, 'embedding', 'Rerank 故障应优雅降级为 Embedding 余弦排序');
  assert.ok(fallbackRecall.smallScores.small_000001 > 0 && fallbackRecall.smallScores.small_000002 > 0, '降级回纯余弦时海图因高余弦也会安全保留');
  failRerank = false;

  // 4. 独立向量导出导入 & 与记忆包分离校验
  const exportedVec = vec.exportVectorData();
  assert.strictEqual(exportedVec.__memoryVectorData, true);
  assert.strictEqual(exportedVec.format, 'memory-vector-index');

  const pkg = sandbox.MEMORY_ENGINE_DATA.exportMemoryPackage();
  currentChatId = 'vec-chat-2';
  // 导入记忆包会自动清理并重构基线
  sandbox.MEMORY_ENGINE_DATA.importMemoryPackage(pkg, { expectedChatId: 'vec-chat-2' });
  assert.strictEqual(vec.getStats().indexed, 0, '导入记忆包后旧向量库应为空，避免与记忆包混淆');

  // 模型不一致的向量导入拦截；chatId 切换拦截
  sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ embeddingModel: 'another-model' });
  assert.throws(() => vec.importVectorData(exportedVec), /模型.*不匹配/);
  sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ embeddingModel: 'BAAI/bge-m3' });
  assert.throws(() => vec.importVectorData(exportedVec, { expectedChatId: 'vec-chat-1' }), /聊天身份已切换/);

  const importedVec = vec.importVectorData(exportedVec, { expectedChatId: 'vec-chat-2' });
  assert.strictEqual(Object.keys(importedVec.records).length, 3, '独立的向量 JSON 应可准确导入绑定到目标聊天');

  console.log('memory vector embedding & rerank tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
