// 记忆模块增强离线测试（持续事实/角色弧光/关键词共振召回/延迟楼层/总结记忆包/轻同步）：node docs/memory-package-recall-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const store = new Map();
let currentChatId = 'pkg-test-a';
let injection = '';
let nextMockMode = 'extract-rich';
let apiCallCount = 0;

const chat = [
  { is_user: false, name: '旁白', mes: '故事开场。' },
  { is_user: true, name: '林墨', mes: '沈清秋在青石渡交给我一枚青铜虎符，嘱咐我务必保密。' },
  { is_user: false, name: '沈清秋', mes: '沈清秋声音冷冽地说道：“虎符半月内不可示人，否则北境暗桩全毁。”' }
];

const settings = {
  engineEnabled: true,
  firstLayerIsAiOpening: true,
  evolveMode: 'auto',
  smallSummaryEveryX: 1,
  bigSummaryEveryX: 1,
  bigSummaryInjectLimit: 2,
  summaryDelayFloors: 0,
  hideCoveredRawText: true,
  recentRawRounds: 1,
  referenceRawRounds: 0,
  referenceSmallSummaryCount: 4,
  referenceBigSummaryCount: 1,
  injectIntoPrompt: true,
  injectIntoWorldEngine: true,
  worldEngineMemoryLimit: 4,
  searchDepth: 4,
  maxPerCharacter: 10,
  memoryInjectMaxChars: 3500,
  recallArchivedSmallLimit: 3,
  injectOngoingFactsLimit: 10,
  injectCharacterArcsLimit: 5,
  enableFactAndArcExtraction: true,
  apiAutoRetries: 0,
  filterRegex: ''
};

const refs = (start, end) => chat.slice(start, end + 1).map((m, idx) => ({
  chatId: currentChatId,
  messageId: `msg_${currentChatId}_${start + idx}`,
  layer: start + idx,
  role: m.is_user ? 'user' : 'assistant',
  swipeId: 0,
  hash: `h_${start + idx}`
}));

const sandbox = {
  window: null,
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  document: { getElementById: () => null },
  SillyTavern: {
    getContext: () => ({
      chat,
      name1: '林墨',
      name2: '沈清秋',
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
    getChatLayer: () => Math.max(0, chat.length - 1),
    filterDialogue: v => v
  },
  WORLD_ENGINE_CHATCACHE: { forScope: () => ({ afterEvolution() {}, createSnapshot() {} }) },
  WORLD_ENGINE_UI: { setMemoryEvolvingUI() {}, refresh() {} },
  MEMORY_ENGINE_TIMELINE: {
    captureRange: (s, e) => refs(s, e),
    auditRefs: list => ({ valid: true, refs: JSON.parse(JSON.stringify(list || [])), missing: [], changed: [] }),
    digestRefs: list => (list || []).map(item => `${item.messageId}:${item.hash}`).join('|'),
    refsToConversation: list => (list || []).map(r => chat[r.layer]?.mes || '').join('\n'),
    unionRefs: groups => groups.flat(),
    hashText: text => `hash_${String(text).length}_${String(text).slice(0, 12)}`,
    syncHidden: () => Promise.resolve()
  },
  WORLD_ENGINE_API: {
    getSettings: () => ({ memoryLinkEnabled: true }),
    async callApi(prompt) {
      apiCallCount++;
      if (prompt.includes('"big_summary": ""')) {
        return JSON.stringify({
          big_summary: '第一阶段总结：主角在江南渡口收下了某样关键信物并承担起保密责任，需要谨慎应对接下来半月内的试探与追查。'.repeat(7).slice(0, 520),
          big_summary_keywords: ['青铜虎符', '北境暗桩', '青石渡']
        });
      }
      if (nextMockMode === 'resolve-fact') {
        return JSON.stringify({
          personal_memory: [],
          entity_updates: [],
          ongoing_fact_updates: [
            { action: 'resolve', category: '契约', subject: '青铜虎符', fact: '半月内不可示人' },
            { action: 'upsert', category: '状态', subject: '沈清秋', fact: '已公开亮明暗桩总管身份并接应林墨。', keywords: ['暗桩总管', '接应'] }
          ],
          character_arc_updates: [
            { name: '沈清秋', current_stance: '完全托付信赖', arc_summary: '放下疑虑转为全力配合', relationship: '托付生死的盟友', progress_pct: 120 }
          ],
          small_summary: '半月期满，沈清秋主动公开身份解除了虎符保密契约。',
          small_summary_keywords: ['半月期满', '公开身份'],
          small_summary_entities: ['沈清秋', '青铜虎符'],
          small_summary_impact: 'key'
        });
      }
      return JSON.stringify({
        personal_memory: [{ name: ['沈清秋', '清秋'], known_by: ['林墨'], memory: '沈清秋在青石渡托付林墨保管青铜虎符。', time: '' }],
        entity_updates: [{ type: 'object', name: '青铜虎符', aliases: ['虎符'], description: '北境暗桩调度信物。', event: '沈清秋将其转交林墨保密。', time: '' }],
        ongoing_fact_updates: [
          { action: 'upsert', category: '契约', subject: '青铜虎符', fact: '半月内不可示人，否则北境暗桩全毁。', keywords: ['青铜虎符', '保密', '北境暗桩'] }
        ],
        character_arc_updates: [
          { name: '沈清秋', current_stance: '谨慎试探但有所托付', arc_summary: '将重要凭证交出以观后效', relationship: '利害同盟', progress_pct: 35 }
        ],
        small_summary: '沈清秋在青石渡把青铜虎符交给林墨，约法半月内绝密。',
        small_summary_keywords: ['青铜虎符', '青石渡', '北境暗桩'],
        small_summary_entities: ['沈清秋', '林墨', '青铜虎符'],
        small_summary_impact: 'key'
      });
    }
  }
};
sandbox.window = sandbox;

for (const file of [
  'memory-engine-settings.js',
  'memory-engine-data.js',
  'memory-engine-prompt.js',
  'memory-engine-small-summary-prompt.js',
  'memory-engine-big-summary-prompt.js',
  'memory-engine.js'
]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}
sandbox.MEMORY_ENGINE_SETTINGS.saveSettings(settings);

(async () => {
  // 1. 提取结构化持续事实、角色弧光与纪要关键词，并自动合并大总述
  await sandbox.MEMORY_ENGINE.manualExtract();
  let state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(state.ongoing_facts.length, 1);
  assert.strictEqual(state.ongoing_facts[0].status, 'active');
  assert.strictEqual(state.ongoing_facts[0].category, '契约');
  assert.strictEqual(state.character_arcs.length, 1);
  assert.strictEqual(state.character_arcs[0].progressPct, 35);
  assert.deepStrictEqual(Array.from(state.event_memory.small_summaries[0].keywords), ['青铜虎符', '青石渡', '北境暗桩']);
  assert.strictEqual(state.event_memory.small_summaries[0].impactLevel, 'key');
  assert.strictEqual(state.event_memory.big_summaries.length, 1);
  assert.ok(injection.includes('【长期持续事实】'), '应注入持续事实区块');
  assert.ok(injection.includes('[角色弧光 35% · 利害同盟]'), '应注入角色弧光定位');

  // 2. 小纪要已归入大总述后，当后续对话提及“青铜虎符”关键词时，应按需从已折叠纪要中精确唤醒细节
  chat.push(
    { is_user: true, name: '林墨', mes: '半月后茶楼碰头，林墨再次提起青铜虎符的下落。' },
    { is_user: false, name: '沈清秋', mes: '沈清秋颔首致意，准备摊牌。' }
  );
  nextMockMode = 'resolve-fact';
  await sandbox.MEMORY_ENGINE.manualExtract();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(state.ongoing_facts[0].status, 'resolved', '旧契约事实应被标记为 resolved');
  assert.strictEqual(state.ongoing_facts[1].status, 'active', '新状态事实应生效');
  assert.strictEqual(state.character_arcs[0].progressPct, 100, '百分比超过 100 应自动钳位到 100');
  assert.ok(injection.includes('【关键词召回历史细节】'), '应凭关键词从已归入总述的早期纪要唤醒青铜虎符细节');
  assert.ok(injection.includes('沈清秋在青石渡把青铜虎符交给林墨'), '唤醒的旧纪要正文应准确命中');

  // 3. 验证字符总预算控制（memoryInjectMaxChars）
  sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ memoryInjectMaxChars: 520 });
  const budgeted = sandbox.MEMORY_ENGINE.applyInjection();
  assert.ok(budgeted.startsWith('【记忆信息】'), '预算裁剪后哨兵头仍须保留');
  assert.ok(budgeted.length <= 540, `预算上限裁剪后总长应接近设定预算，实际=${budgeted.length}`);
  sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ memoryInjectMaxChars: 3500 });

  // 4. 验证总结记忆包导出剥离楼层引用，导入时验证聊天绑定并正确重置末楼基线
  const pkg = sandbox.MEMORY_ENGINE_DATA.exportMemoryPackage();
  assert.strictEqual(pkg.__memoryEnginePackage, true);
  assert.strictEqual(pkg.format, 'memory-summary-package');
  assert.strictEqual(pkg.package.event_memory.small_summaries[0].sourceRefs, undefined, '记忆包不得携带原聊天 sourceRefs');
  assert.strictEqual(pkg.package.ongoing_facts.length, 2);
  assert.strictEqual(pkg.package.character_arcs.length, 1);

  assert.throws(() => sandbox.MEMORY_ENGINE_DATA.importMemoryPackage({ foo: 'bar' }), /格式校验失败/);
  currentChatId = 'pkg-test-b';
  assert.throws(
    () => sandbox.MEMORY_ENGINE_DATA.importMemoryPackage(pkg, { expectedChatId: 'pkg-test-a' }),
    /聊天身份已切换/
  );
  assert.throws(
    () => sandbox.MEMORY_ENGINE_DATA.importMemoryPackage(pkg, { expectedChatId: 'pkg-test-b', isBusy: () => true }),
    /正在运行/
  );
  const imported = sandbox.MEMORY_ENGINE_DATA.importMemoryPackage(pkg, { expectedChatId: 'pkg-test-b' });
  assert.strictEqual(imported.timeline.originChatId, 'pkg-test-b');
  assert.strictEqual(imported.chatLayer, chat.length - 1, '导入后应以目标聊天末楼为新基线');
  assert.strictEqual(imported.character_arcs[0].originChatId, 'pkg-test-b');

  // 5. 验证延迟总结楼层（summaryDelayFloors=1）：仅剩未超出延迟区的新回复时不应提前调用总结 API
  sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ summaryDelayFloors: 1, bigSummaryEveryX: 99 });
  const beforeDelayCalls = apiCallCount;
  chat.push(
    { is_user: true, name: '林墨', mes: '试探一问。' },
    { is_user: false, name: '沈清秋', mes: '尚未定稿的新回复，可能还要 swipe 重 roll。' }
  );
  await sandbox.MEMORY_ENGINE._test.autoExtract();
  assert.strictEqual(apiCallCount, beforeDelayCalls, '处于延迟缓冲楼层内的新回合不应立即触发总结 API');
  chat.push(
    { is_user: true, name: '林墨', mes: '继续推进下一轮。' },
    { is_user: false, name: '沈清秋', mes: '最新一轮回复。' }
  );
  await sandbox.MEMORY_ENGINE._test.autoExtract();
  assert.strictEqual(apiCallCount, beforeDelayCalls + 1, '超出延迟缓冲楼层后应只对已稳态的前轮发起 API');
  sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ summaryDelayFloors: 0 });

  // 6. 验证轻同步模式（ingestWorldEvolution({ lightweight: true })）零大模型调用落库并支持同楼层回滚
  const beforeLightCalls = apiCallCount;
  const lightRes = await sandbox.MEMORY_ENGINE.ingestWorldEvolution({
    lightweight: true,
    layer: chat.length - 1,
    worldDigest: '青石关宣布全面戒严，商旅暂停通行。',
    worldCommitId: 'world_commit_light_1',
    worldUpdate: {
      factions: [{ name: '听潮阁', status: '暗中戒备', relation: '中立', currentGoal: '观望局势' }],
      worldTrends: [{ name: '北境戒严', scope: '北境三州', status: '持续中', description: '全境实施夜间宵禁。' }]
    },
    force: true
  });
  assert.strictEqual(lightRes.lightweight, true);
  assert.strictEqual(apiCallCount, beforeLightCalls, '轻同步模式未满总述阈值时应保持 0 次额外 LLM API 请求');
  assert.ok(sandbox.MEMORY_ENGINE_DATA.loadState().ongoing_facts.some(f => f.subject === '北境戒严'));
  const rolledBack = sandbox.MEMORY_ENGINE._test.rollbackLinkedLayer(chat.length - 1);
  assert.strictEqual(rolledBack, true);
  assert.ok(!sandbox.MEMORY_ENGINE_DATA.loadState().ongoing_facts.some(f => f.subject === '北境戒严'), '世界重 roll 回撤应连同轻同步事实一并撤销');

  console.log('memory package & recall tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
