// 事件记忆与核心 7 表纪要离线测试：node docs/memory-event-summary-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const storeMap = new Map();
const calls = [];
const listeners = new Map();
const runningLabels = [];
let memoryRefreshes = 0;
let injectionContent = '';
const settings = {
  engineEnabled: true,
  firstLayerIsAiOpening: true,
  evolveMode: 'auto',
  evolveEveryX: 2,
  smallSummaryEveryX: 2,
  smallSummaryInjectLimit: 8,
  hideCoveredRawText: true,
  recentRawRounds: 3,
  referenceRawRounds: 0,
  referenceSmallSummaryCount: 4,
  injectIntoWorldEngine: false,
  worldEngineMemoryLimit: 3,
  injectIntoPrompt: true,
  searchDepth: 5,
  maxTokens: 2000,
  temperature: 0.2,
  nameBlacklist: '',
  apiAutoRetries: 0,
  tableFillMaxRetries: 0,
  backfillBatchSize: 2,
  summaryBackfillSmallEveryX: 2,
  backfillRetries: 0,
  backfillEndLayer: 0,
  filterRegex: ''
};
const chat = [
  { is_user: false, name: '角色', mes: '这是角色卡的开场白，不应进入纪要或批量重填。' },
  { is_user: true, name: '用户', mes: '进入城镇。' },
  { is_user: false, name: '角色', mes: '发现城门已经关闭。' },
  { is_user: true, name: '用户', mes: '询问守卫。' },
  { is_user: false, name: '角色', mes: '守卫说明北方发生叛乱。' }
];
const context = {
  chat,
  name1: '用户',
  name2: '角色',
  setExtensionPrompt(_name, content) { injectionContent = content; },
  eventSource: { on(name, handler) { listeners.set(name, handler); } },
  event_types: { GENERATION_ENDED: 'generation_ended' }
};
const sandbox = {
  window: null,
  __WE_SetExternalStatus() {},
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  document: { getElementById() { return null; } },
  SillyTavern: { getContext() { return context; } },
  WORLD_ENGINE_STORE: {
    getItem(key) { return storeMap.has(key) ? storeMap.get(key) : null; },
    setItem(key, value) { storeMap.set(key, String(value)); },
    removeItem(key) { storeMap.delete(key); }
  },
  WORLD_ENGINE_CORE: {
    getChatId() { return 'summary-test'; },
    getChatLayer() { return chat.length - 1; },
    filterDialogue(value) { return value; }
  },
  WORLD_ENGINE_WORLDBOOK: { async buildPromptSection() { return ''; } },
  WORLD_ENGINE_CHATCACHE: { forScope() { return { afterEvolution() {}, createSnapshot() {} }; } },
  WORLD_ENGINE_UI: {
    setMemoryEvolvingUI(active, label) { if (active) runningLabels.push(label); },
    refresh() { memoryRefreshes++; }
  },
  MEMORY_ENGINE_SETTINGS: { getSettings() { return { ...settings }; } },
  WORLD_ENGINE_API: {
    async callApi(prompt) {
      calls.push(prompt);
      const result = {};
      if (prompt.includes('"important_characters":')) {
        result.important_characters = {
          upsert: [{ name: '角色', brief_intro: '同行者', presence_status: '在场', past_experience: '角色得知北方发生叛乱。' }],
          delete: []
        };
      }
      if (prompt.includes('"chronicle":')) {
        result.chronicle = {
          summary: '城门关闭且北方叛乱',
          chronicle_text: '角色发现城门关闭，并从守卫处得知北方发生叛乱。',
          keywords: ['城门', '北方叛乱'],
          entities: ['角色', '守卫'],
          impact: 'normal'
        };
      }
      return JSON.stringify(result);
    }
  }
};
sandbox.window = sandbox;

for (const filename of [
  'memory-engine-data.js',
  'memory-engine-prompt.js',
  'memory-engine-small-summary-prompt.js',
  'memory-engine.js'
]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, filename), 'utf8'), sandbox, { filename });
}

// 1. 7 表动态 Prompt 结构校验
{
  const allPrompt = sandbox.MEMORY_ENGINE_PROMPT.buildTableFillSystemPrompt();
  for (const key of ['global_state', 'protagonist_info', 'important_characters', 'protagonist_skills', 'inventory', 'quests_events', 'chronicle']) {
    assert.ok(allPrompt.includes(`"${key}":`), `完整填表系统提示词必须包含核心表：${key}`);
  }
  const chronOnlyPrompt = sandbox.MEMORY_ENGINE_PROMPT.buildTableFillSystemPrompt(['chronicle']);
  assert.ok(chronOnlyPrompt.includes('"chronicle":'), '单表纪要提示词应包含 chronicle');
  assert.ok(!chronOnlyPrompt.includes('"inventory":'), '单表纪要提示词不应混入未要求的表');

  const retryMsgs = sandbox.MEMORY_ENGINE_PROMPT.buildRetryCorrectionMessages(
    sandbox.MEMORY_ENGINE_PROMPT.buildMessages({ targetSheets: ['important_characters'], conversation: '测试对话' }),
    [{ response: '{"important_characters":{"upsert":[{}]}}', errors: ['重要角色表 (important_characters).upsert[0] 缺少必填主键字段 name'] }],
    ['important_characters']
  );
  const retryStr = sandbox.MEMORY_ENGINE_PROMPT.messagesToPromptString(retryMsgs);
  assert.ok(retryStr.includes('【填表纠错】') && retryStr.includes('缺少必填主键字段 name'), '带错纠错重试必须回灌具体错误');
}

// 2. 超长纪要完整接受 + 黑名单过滤
{
  const longText = '纪'.repeat(600);
  const parsedLong = sandbox.MEMORY_ENGINE._test.parseAndValidateTableResponse(
    JSON.stringify({ chronicle: { chronicle_text: longText } }),
    ['chronicle']
  );
  assert.strictEqual(parsedLong.ok, true);
  assert.strictEqual(parsedLong.chronicleRows[0].chronicle_text, longText, '超长纪要必须完整接受不截断');

  settings.nameBlacklist = '忽略人物\n禁用物品';
  const parsedBl = sandbox.MEMORY_ENGINE._test.parseAndValidateTableResponse(JSON.stringify({
    important_characters: {
      upsert: [
        { name: '忽略人物', brief_intro: '不应入库' },
        { name: '保留人物', brief_intro: '应当入库' }
      ],
      delete: []
    },
    inventory: {
      upsert: [
        { item_name: ' 禁用物品 ', quantity: '1' },
        { item_name: '保留物件', quantity: '1' }
      ],
      delete: []
    }
  }), ['important_characters', 'inventory']);
  assert.strictEqual(parsedBl.ok, true);
  assert.deepStrictEqual(Array.from(parsedBl.tableOps.map(op => op.key)), ['保留人物', '保留物件'], '命中黑名单的角色/物品应被单独忽略');
  settings.nameBlacklist = '';
}

// 3. 正文保留轮数与隐藏楼层计算
{
  const messages = [
    { id: 'opening', is_user: false },
    { id: 'user-1', is_user: true }, { id: 'ai-1', is_user: false },
    { id: 'user-2', is_user: true }, { id: 'ai-2', is_user: false },
    { id: 'user-3', is_user: true }, { id: 'ai-3', is_user: false },
    { id: 'user-4', is_user: true }, { id: 'ai-4', is_user: false }
  ];
  const recent = sandbox.MEMORY_ENGINE._test.recentRawRoundMessageIds(
    messages,
    3,
    { firstLayerIsAiOpening: true },
    { ensureMessageId: message => message.id }
  );
  assert.deepStrictEqual([...recent], ['user-2', 'ai-2', 'user-3', 'ai-3', 'user-4', 'ai-4'],
    '最近三轮必须保留每轮的用户输入和 AI 回复');
  const covered = messages.slice(1).map(message => ({ chatId: 'summary-test', messageId: message.id }));
  covered.push({ chatId: 'other-chat', messageId: 'foreign-message' });
  const hidden = sandbox.MEMORY_ENGINE._test.selectHiddenMessageIds(covered, 'summary-test', recent);
  assert.deepStrictEqual([...hidden], ['user-1', 'ai-1'], '有效摘要覆盖正文时只能隐藏最近三轮之外的当前聊天消息');
}

(async () => {
  // 4. 改写失效撤旧与历史对账修复
  {
    let hiddenWanted = null;
    sandbox.MEMORY_ENGINE_TIMELINE = {
      captureRange(s, e) {
        return chat.slice(s, e + 1).map((m, i) => ({
          chatId: 'summary-test', messageId: `floor-${s + i}`, layer: s + i, role: m.is_user ? 'user' : 'assistant', hash: 'edited'
        }));
      },
      auditRefs(refs) {
        const changed = refs.some(ref => ref.hash !== 'edited');
        const updated = refs.map(ref => ({ ...ref, hash: 'edited' }));
        return {
          valid: !changed,
          changed: changed ? [{ before: refs[0], after: updated[0] }] : [],
          missing: [],
          refs: updated
        };
      },
      digestRefs() { return 'edited-digest'; },
      unionRefs(groups) { return groups.flat(); },
      syncHidden(ids) { hiddenWanted = [...ids]; return Promise.resolve(); }
    };
    const editedState = sandbox.MEMORY_ENGINE_DATA.defaultState();
    editedState.tables.chronicle = [{
      id: 'small_000001', rowId: 1, code_index: 'AM0001', startLayer: 4, endLayer: 4,
      summary: '修改前纪要', chronicle_text: '修改前纪要', status: 'valid',
      sourceRefs: [
        { chatId: 'summary-test', messageId: 'floor-3', layer: 3, role: 'user', hash: 'old-3' },
        { chatId: 'summary-test', messageId: 'floor-4', layer: 4, role: 'assistant', hash: 'old-4' }
      ]
    }];
    sandbox.MEMORY_ENGINE_DATA.saveState(editedState);
    settings.hideCoveredRawText = false;
    sandbox.MEMORY_ENGINE.applyInjection();
    assert.deepStrictEqual(hiddenWanted, [], '关闭隐藏正文后必须恢复并保留全部正文');
    settings.hideCoveredRawText = true;
    calls.length = 0;
    await sandbox.MEMORY_ENGINE.prepareHistoryForGeneration();
    assert.strictEqual(calls.length, 0, '生成前只能撤下失效摘要，不得调用后台 API');
    assert.strictEqual(sandbox.MEMORY_ENGINE_DATA.loadState().tables.chronicle[0].status, 'stale');
    assert.deepStrictEqual(hiddenWanted, [], '生成前必须恢复失效纪要覆盖的楼层正文');
    const animationStates = [];
    const originalSetMemoryEvolvingUI = sandbox.WORLD_ENGINE_UI.setMemoryEvolvingUI;
    sandbox.WORLD_ENGINE_UI.setMemoryEvolvingUI = (active, label) => {
      animationStates.push({ active, label, running: sandbox.MEMORY_ENGINE.isRunning() });
    };
    await sandbox.MEMORY_ENGINE.reconcileHistory();
    sandbox.WORLD_ENGINE_UI.setMemoryEvolvingUI = originalSetMemoryEvolvingUI;
    assert.strictEqual(calls.length, 1, '历史修复应调用一次纪要修复 API');
    assert.deepStrictEqual(animationStates, [
      { active: true, label: '历史记忆对账', running: true },
      { active: false, label: '', running: false }
    ], '历史修复期间 isRunning 必须保持为 true');
    calls.length = 0;
    sandbox.MEMORY_ENGINE_TIMELINE = undefined;
    sandbox.MEMORY_ENGINE_DATA.saveState(sandbox.MEMORY_ENGINE_DATA.defaultState());
  }

  // 5. 手动纪要、忽略首楼开场白开关、独立重填纪要与重填结构化 6 表互不误伤
  const refreshesBefore = memoryRefreshes;
  const combined = await sandbox.MEMORY_ENGINE.manualSmallSummary();
  assert.strictEqual(calls.length, 1, '手动纪要只应请求一次纪要 API');
  assert.ok(!calls[0].includes('这是角色卡的开场白'), '初始化纪要必须忽略第 0 层 AI 开场白');
  assert.ok(calls[0].includes('守卫说明北方发生叛乱'), '忽略开场白后仍应读取窗口内最新的 AI 回复');
  assert.ok(!calls[0].includes('"important_characters":'), '仅填纪要时不应携带其他表输出字段');
  assert.strictEqual(combined.addedSmall, 1);
  assert.ok(memoryRefreshes > refreshesBefore, '纪要完成后必须刷新记忆面板');
  let state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(state.tables.chronicle.length, 1);
  assert.strictEqual(state.event_memory.big_summaries, undefined);

  settings.firstLayerIsAiOpening = false;
  sandbox.MEMORY_ENGINE_DATA.saveState(sandbox.MEMORY_ENGINE_DATA.defaultState());
  calls.length = 0;
  await sandbox.MEMORY_ENGINE.manualSmallSummary();
  assert.ok(calls[0].includes('这是角色卡的开场白'), '取消“首楼为 AI 开场白”后第 0 层必须正常参与纪要');
  settings.firstLayerIsAiOpening = true;

  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  state.tables.important_characters = [{ rowId: 1, name: '保留人物', brief_intro: '重要角色', presence_status: '在场' }];
  sandbox.MEMORY_ENGINE.commitManualState(state);
  calls.length = 0;
  await sandbox.MEMORY_ENGINE.backfillSummaries();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(state.tables.important_characters[0].name, '保留人物', '纪要回填不得清理重要角色表');
  assert.ok(state.tables.chronicle.length > 0);

  const chronBeforeBackfill = JSON.stringify(state.tables.chronicle);
  calls.length = 0;
  await sandbox.MEMORY_ENGINE.backfill();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(JSON.stringify(state.tables.chronicle), chronBeforeBackfill, '结构化 6 表回填不得清理纪要表');
  assert.ok(state.tables.important_characters.some(c => c.name === '角色'));

  // 6. 旧存档迁移 + 跨聊天导入重定位 + 完整备份导入导出 + 跨引擎上下文开关
  const legacy = {
    event_memory: {
      small_summaries: [{ id: 'small_000001', startLayer: 2, endLayer: 2, content: '旧纪要保留' }],
      big_summary: { startLayer: 1, endLayer: 4, content: '旧版滚动总述' },
      big_summaries: [{ startLayer: 1, endLayer: 4, content: '旧版总述列表' }]
    }
  };
  sandbox.MEMORY_ENGINE_DATA.saveState(legacy);
  const loadedLegacy = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(loadedLegacy.tables.chronicle[0].chronicle_text, '旧纪要保留');
  assert.strictEqual(loadedLegacy.event_memory.big_summaries, undefined);

  const portable = sandbox.MEMORY_ENGINE_DATA.defaultState();
  portable.chatLayer = 99;
  const importedLongSmall = '用户手工合并：' + '长'.repeat(700);
  portable.tables.chronicle = [
    { id: 'small_000001', rowId: 1, code_index: 'AM0001', startLayer: 2, endLayer: 2, chronicle_text: '旧纪要一' },
    { id: 'small_000002', rowId: 2, code_index: 'AM0002', startLayer: 4, endLayer: 4, chronicle_text: '旧纪要二' },
    { id: 'small_000003', rowId: 3, code_index: 'AM0003', startLayer: 6, endLayer: 6, chronicle_text: importedLongSmall }
  ];
  const imported = sandbox.MEMORY_ENGINE_DATA.importData({
    __memoryEngineData: true,
    chatId: 'another-chat',
    state: portable,
    checkpoint: portable
  });
  assert.strictEqual(imported.chatLayer, chat.length - 1, '跨聊天导入进度必须衔接当前最后一层');
  assert.strictEqual(imported.tableWatermarks.chronicle, chat.length - 1, '跨聊天导入的纪要水位线必须衔接当前最后一层');
  assert.strictEqual(imported.tables.chronicle[2].chronicle_text, importedLongSmall, 'JSON 导入的超长纪要不得截断');

  settings.smallSummaryInjectLimit = 1;
  settings.recallArchivedSmallLimit = 0;
  sandbox.MEMORY_ENGINE.applyInjection();
  const recentBlock = injectionContent.slice(injectionContent.indexOf('<近期纪要>'), injectionContent.indexOf('</近期纪要>'));
  assert.ok(recentBlock.includes(importedLongSmall), '近期纪要区块应完整注入最新纪要');
  assert.ok(!recentBlock.includes('旧纪要一'), '超过直注上限且关闭召回时旧纪要正文不应进入近期纪要');
  assert.ok(injectionContent.includes('<已发生的事件概览>') && injectionContent.includes('AM0001'), '归档旧纪要应仅以单行 AM 概览索引呈现');
  settings.smallSummaryInjectLimit = 8;
  settings.recallArchivedSmallLimit = 3;

  settings.injectIntoWorldEngine = true;
  const exported = sandbox.MEMORY_ENGINE_DATA.exportData();
  assert.strictEqual(exported.counts.state.minutes, 3);
  const roundTripped = sandbox.MEMORY_ENGINE_DATA.importData(exported);
  assert.strictEqual(roundTripped.tables.chronicle.length, 3);
  assert.ok(sandbox.MEMORY_ENGINE.buildWorldEngineContext().includes('AM0003'));
  settings.injectIntoWorldEngine = false;
  assert.strictEqual(sandbox.MEMORY_ENGINE.buildWorldEngineContext(), '', '关闭跨引擎注入后必须返回空内容');

  // 7. 首次进入已有聊天时记录 autoBaselineLayer，不自动补历史，仅在新增满 X 轮后触发自动填表
  sandbox.MEMORY_ENGINE_DATA.saveState(sandbox.MEMORY_ENGINE_DATA.defaultState());
  calls.length = 0;
  runningLabels.length = 0;
  settings.evolveEveryX = 999;
  sandbox.MEMORY_ENGINE.init();
  const initializedState = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(initializedState.autoBaselineLayer, chat.length - 1, '首次进入已有聊天必须记录自动填表基线，不自动回填旧历史');

  chat.push(
    { is_user: true, name: '用户', mes: '继续询问城内情况。' },
    { is_user: false, name: '角色', mes: '守卫表示暂时没有更多消息。' }
  );
  listeners.get('generation_ended')();
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.strictEqual(calls.length, 0, '进入已有聊天后新增不足 X 轮时不得自动补历史纪要');

  chat.push(
    { is_user: true, name: '用户', mes: '准备返回旅店。' },
    { is_user: false, name: '角色', mes: '角色离开城门并返回旅店。' }
  );
  listeners.get('generation_ended')();
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.strictEqual(calls.length, 1, '从基线起新增满 2 轮后应仅对纪要发起 1 次自动填表');
  assert.ok(calls[0].includes('"chronicle":'));
  assert.ok(!calls[0].includes('"important_characters":'));

  console.log('✓ 事件记忆纪要测试通过');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
