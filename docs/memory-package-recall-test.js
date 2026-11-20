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
  smallSummaryInjectLimit: 1,
  summaryDelayFloors: 0,
  hideCoveredRawText: true,
  recentRawRounds: 1,
  referenceRawRounds: 0,
  referenceSmallSummaryCount: 4,
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
          important_characters: {
            upsert: [{
              name: '沈清秋',
              brief_intro: '北境暗桩总管',
              presence_status: '在场',
              relation_text: '林墨:托付生死的盟友',
              past_experience: '放下疑虑转为全力配合，公开亮明暗桩总管身份并接应林墨。'
            }],
            delete: []
          },
          quests_events: {
            upsert: [{
              quest_name: '接应林墨行动',
              quest_type: '主线任务',
              issuer: '沈清秋',
              detail_desc: '已公开亮明暗桩总管身份并接应林墨。',
              current_progress: '进行中'
            }],
            delete: ['青铜虎符保密契约']
          },
          chronicle: {
            code_index: 'AM0002',
            summary: '半月期满公开身份',
            chronicle_text: '半月期满，沈清秋主动公开身份解除了虎符保密契约。',
            keywords: ['半月期满', '公开身份'],
            entities: ['沈清秋', '青铜虎符'],
            impact: 'key'
          }
        });
      }
      return JSON.stringify({
        important_characters: {
          upsert: [{
            name: '沈清秋',
            brief_intro: '青石渡神秘接头人',
            presence_status: '在场',
            relation_text: '林墨:利害同盟',
            past_experience: '在青石渡托付林墨保管青铜虎符。'
          }],
          delete: []
        },
        inventory: {
          upsert: [{
            item_name: '青铜虎符',
            quantity: '1',
            category: '关键物品',
            description: '北境暗桩调度信物，由沈清秋转交林墨保密。'
          }],
          delete: []
        },
        quests_events: {
          upsert: [{
            quest_name: '青铜虎符保密契约',
            quest_type: '主线任务',
            issuer: '沈清秋',
            detail_desc: '半月内不可示人，否则北境暗桩全毁。',
            current_progress: '进行中',
            time_limit: '半月内'
          }],
          delete: []
        },
        chronicle: {
          code_index: 'AM0001',
          summary: '青石渡托付青铜虎符',
          chronicle_text: '沈清秋在青石渡把青铜虎符交给林墨，约法半月内绝密。',
          keywords: ['青铜虎符', '青石渡', '北境暗桩'],
          entities: ['沈清秋', '林墨', '青铜虎符'],
          impact: 'key'
        }
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
  'memory-engine.js'
]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}
sandbox.MEMORY_ENGINE_SETTINGS.saveSettings(settings);

(async () => {
  // 1. 提取核心 7 表数据（重要角色、背包物品、任务事件、纪要）
  await sandbox.MEMORY_ENGINE.manualExtract();
  let state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(state.tables.quests_events.length, 1);
  assert.strictEqual(state.tables.quests_events[0].quest_name, '青铜虎符保密契约');
  assert.strictEqual(state.tables.inventory.length, 1);
  assert.strictEqual(state.tables.important_characters.length, 1);
  assert.deepStrictEqual(Array.from(state.tables.chronicle[0].keywords), ['青铜虎符', '青石渡', '北境暗桩']);
  assert.strictEqual(state.tables.chronicle[0].impactLevel, 'key');
  assert.strictEqual(state.event_memory.big_summaries, undefined, '去除总述后不应生成 big_summaries');
  assert.ok(injection.includes('<当前任务与事件>'), '应注入任务与事件区块');
  assert.ok(injection.includes('<重要角色详情>'), '应注入在场重要角色详情');

  // 2. 早期纪要退出直注窗口（smallSummaryInjectLimit=1）后，后续对话提及“青铜虎符”应按关键词精准唤醒
  chat.push(
    { is_user: true, name: '林墨', mes: '半月后茶楼碰头，林墨再次提起青铜虎符的下落。' },
    { is_user: false, name: '沈清秋', mes: '沈清秋颔首致意，准备摊牌。' }
  );
  nextMockMode = 'resolve-fact';
  await sandbox.MEMORY_ENGINE.manualExtract();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.ok(!state.tables.quests_events.some(q => q.quest_name === '青铜虎符保密契约'), '旧契约任务应被删除结案');
  assert.ok(state.tables.quests_events.some(q => q.quest_name === '接应林墨行动'), '新任务应生效');
  assert.ok(injection.includes('<记忆回溯>'), '应凭关键词从超出直注窗口的早期纪要唤醒青铜虎符细节');
  assert.ok(injection.includes('沈清秋在青石渡把青铜虎符交给林墨'), '唤醒的旧纪要正文应准确命中');

  // 3. 验证字符总预算控制（memoryInjectMaxChars）
  sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ memoryInjectMaxChars: 520 });
  const budgeted = sandbox.MEMORY_ENGINE.applyInjection();
  assert.ok(budgeted.startsWith('【长期记忆数据库'), '预算裁剪后哨兵头仍须保留');
  assert.ok(budgeted.length <= 540, `预算上限裁剪后总长应接近设定预算，实际=${budgeted.length}`);
  sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ memoryInjectMaxChars: 3500 });

  // 4. 验证总结记忆包导出剥离楼层引用，导入时验证聊天绑定并正确重置末楼基线
  const pkg = sandbox.MEMORY_ENGINE_DATA.exportMemoryPackage();
  assert.strictEqual(pkg.__memoryEnginePackage, true);
  assert.strictEqual(pkg.format, 'memory-summary-package');
  assert.strictEqual(pkg.package.event_memory.small_summaries[0].sourceRefs, undefined, '记忆包不得携带原聊天 sourceRefs');
  assert.strictEqual(pkg.package.tables.quests_events.length, 1);
  assert.strictEqual(pkg.package.tables.important_characters.length, 1);

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
  assert.strictEqual(imported.tables.important_characters[0].name, '沈清秋');

  // 5. 验证延迟总结楼层（summaryDelayFloors=1）：仅剩未超出延迟区的新回复时不应提前调用总结 API
  sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ summaryDelayFloors: 1 });
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

  // 6. 验证弱联动模式：世界引擎调用 ingestWorldEvolution 不再向记忆 7 表写入任何记录（0 API 调用、0 行污染）
  const beforeLightCalls = apiCallCount;
  const beforeLightState = JSON.stringify(sandbox.MEMORY_ENGINE_DATA.loadState().tables);
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
  assert.strictEqual(lightRes.skipped, true, '弱联动模式下世界推演不得向记忆写入记录');
  assert.strictEqual(lightRes.reason, 'readonly_weak_coupling');
  assert.strictEqual(apiCallCount, beforeLightCalls, '弱联动模式下应保持 0 次额外 LLM API 请求');
  assert.strictEqual(JSON.stringify(sandbox.MEMORY_ENGINE_DATA.loadState().tables), beforeLightState, '世界推演不得往记忆 7 表塞入任何任务或纪要');

  console.log('memory package & recall tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
