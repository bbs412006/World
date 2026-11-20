// 核心 7 表 + 单表水位线 + Wave 波次追平 + 带错回灌纠错 + 同步删楼回退 + Epoch 代次锁 + 双层注入专项测试
// 运行：node docs/memory-v3-tables-wave-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const plain = v => JSON.parse(JSON.stringify(v));

function createEnv(initialChat) {
  const store = new Map();
  const listeners = new Map();
  const calls = [];
  let injection = '';
  let apiHandler = null;
  const chat = initialChat.map(m => ({ ...m }));
  const types = {
    GENERATION_STARTED: 'generation_started',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',
    CHAT_LOADED: 'chat_loaded',
    CHAT_CHANGED: 'chat_id_changed',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_DELETED: 'message_deleted'
  };

  const ctx = {
    chatId: 'v3-wave-test-chat',
    chat,
    name1: '林墨',
    name2: '旁白',
    event_types: types,
    eventSource: {
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      },
      async emitAsync(name, ...args) {
        for (const fn of listeners.get(types[name] || name) || []) {
          await fn(...args);
        }
      }
    },
    setExtensionPrompt(_name, content) { injection = content; },
    saveChatConditional() { return Promise.resolve(); }
  };

  const sandbox = {
    window: null,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    Date,
    Math,
    document: { getElementById: () => null },
    SillyTavern: { getContext: () => ctx },
    WORLD_ENGINE_STORE: {
      getItem: k => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    WORLD_ENGINE_CORE: {
      getChatId: () => ctx.chatId,
      getChatLayer: () => Math.max(0, chat.length - 1),
      filterDialogue: v => v
    },
    WORLD_ENGINE_CHATCACHE: { forScope: () => ({ afterEvolution() {}, createSnapshot() {} }) },
    WORLD_ENGINE_UI: { setMemoryEvolvingUI() {}, refresh() {} },
    WORLD_ENGINE_API: {
      getSettings: () => ({ engineEnabled: true }),
      setNextRequestMeta() {},
      updateRequestLog() {},
      async callApi(prompt, maxTokens, temp, signal, cfg) {
        calls.push({ prompt, maxTokens, temp, signal, cfg });
        if (apiHandler) return apiHandler(prompt, { maxTokens, temp, signal, cfg });
        throw new Error('apiHandler not set');
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  for (const file of [
    'memory-engine-settings.js',
    'memory-engine-data.js',
    'memory-engine-timeline.js',
    'memory-engine-prompt.js',
    'memory-engine-small-summary-prompt.js',
    'memory-engine.js'
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  }

  return {
    sandbox,
    ctx,
    chat,
    calls,
    getInjection: () => injection,
    setApiHandler(fn) { apiHandler = fn; }
  };
}

function makeChat(rounds) {
  const list = [{ is_user: false, name: '旁白', mes: '开场白（第0层）' }];
  for (let r = 1; r <= rounds; r++) {
    list.push({ is_user: true, name: '林墨', mes: `第${r}轮行动` });
    list.push({ is_user: false, name: '旁白', mes: `第${r}轮场景进展` });
  }
  return list;
}

(async () => {
  // 1. 核心 7 表强约束（单行表禁删、主键表合并/删除、纪要表 AMXXXX 自动递增）
  {
    const env = createEnv(makeChat(1));
    const data = env.sandbox.MEMORY_ENGINE_DATA;
    assert.deepStrictEqual(Array.from(data.TABLE_KEYS), [
      'global_state', 'protagonist_info', 'important_characters',
      'protagonist_skills', 'inventory', 'quests_events', 'chronicle'
    ]);
    let tables = data.emptyTables();
    tables = data.applyTableOps(tables, [
      { sheet: 'global_state', op: 'upsert', data: { current_location: '青石渡', cur_time: '2026-01-01 08:00' } },
      { sheet: 'global_state', op: 'delete' }, // 单行表禁止删除
      { sheet: 'protagonist_info', op: 'upsert', data: { name: '林墨', identity_text: '密探', current_condition: '清醒' } },
      { sheet: 'protagonist_info', op: 'delete' }, // 单行表禁止删除
      { sheet: 'important_characters', op: 'upsert', key: '沈清秋', data: { name: '沈清秋', brief_intro: '暗桩总管', presence_status: '在场' } },
      { sheet: 'important_characters', op: 'upsert', key: '沈清秋', data: { name: '沈清秋', outfit_text: '青衫', presence_status: '离场' } },
      { sheet: 'protagonist_skills', op: 'upsert', key: '听潮剑意', data: { skill_name: '听潮剑意', skill_type: '主动', skill_level: '初阶', effect_desc: '听声辨位' } },
      { sheet: 'inventory', op: 'upsert', key: '青铜虎符', data: { item_name: '青铜虎符', quantity: '1', category: '关键物品' } },
      { sheet: 'inventory', op: 'upsert', key: '干粮', data: { item_name: '干粮', quantity: '3', category: '消耗品' } },
      { sheet: 'inventory', op: 'delete', key: '干粮' },
      { sheet: 'quests_events', op: 'upsert', key: '查明内鬼', data: { quest_name: '查明内鬼', quest_type: '主线任务', current_progress: '进行中' } },
      { sheet: 'chronicle', op: 'append', data: { chronicle_text: '第一段纪要。' } },
      { sheet: 'chronicle', op: 'append', data: { code_index: 'AM0001', chronicle_text: '碰撞编号应自动递增。' } }
    ]);
    assert.strictEqual(tables.global_state.length, 1);
    assert.strictEqual(tables.global_state[0].story_state, '全局状态');
    assert.strictEqual(tables.protagonist_info.length, 1);
    assert.strictEqual(tables.important_characters.length, 1);
    assert.strictEqual(tables.important_characters[0].brief_intro, '暗桩总管', '主键合并时未变字段必须保留');
    assert.strictEqual(tables.important_characters[0].outfit_text, '青衫');
    assert.strictEqual(tables.important_characters[0].presence_status, '离场');
    assert.strictEqual(tables.protagonist_skills.length, 1);
    assert.deepStrictEqual(Array.from(tables.inventory.map(r => r.item_name)), ['青铜虎符']);
    assert.strictEqual(tables.quests_events.length, 1);
    assert.deepStrictEqual(Array.from(tables.chronicle.map(r => r.code_index)), ['AM0001', 'AM0002'], '碰撞编码必须自动顺延不重号');
    console.log('✓ 1. 核心 7 表 Schema 约束与 AMXXXX 自动递增通过');
  }

  // 2. 旧版 v2 存档与记忆包自动无损迁移至 v3 核心 7 表
  {
    const env = createEnv(makeChat(1));
    const data = env.sandbox.MEMORY_ENGINE_DATA;
    const legacyPkg = {
      __memoryEnginePackage: true,
      format: 'memory-summary-package',
      package: {
        personal_memory: [{ id: 'c1', names: ['苏婉'], profile: { basicInfo: { identity: '掌柜', appearance: '紫衣' }, experiences: '经营城南茶楼' }, memory: {} }],
        entity_memory: {
          ability: [{ id: 'a1', name: '踏雪无痕', description: '高阶轻功' }],
          object: [{ id: 'o1', name: '玉佩', description: '传家玉佩' }]
        },
        ongoing_facts: [
          { id: 'f1', category: '主线', subject: '苏婉', fact: '暗中收集漕运情报', status: 'active' },
          { id: 'f2', category: '状态', subject: '苏婉', fact: '已过期旧事实', status: 'resolved' }
        ],
        event_memory: {
          small_summaries: [{ id: 'small_000001', startLayer: 2, endLayer: 2, content: '旧版纪要记录。' }]
        }
      }
    };
    const migrated = data.importMemoryPackage(legacyPkg);
    assert.strictEqual(migrated.schemaVersion, 3);
    assert.strictEqual(migrated.tables.important_characters[0].name, '苏婉');
    assert.strictEqual(migrated.tables.important_characters[0].brief_intro, '掌柜');
    assert.strictEqual(migrated.tables.protagonist_skills[0].skill_name, '踏雪无痕');
    assert.strictEqual(migrated.tables.inventory[0].item_name, '玉佩');
    assert.strictEqual(migrated.tables.quests_events.length, 1, '已完结的旧事实不应迁入进行中任务表');
    assert.strictEqual(migrated.tables.chronicle[0].code_index, 'AM0001');
    console.log('✓ 2. 旧版 v2 记忆包自动无损迁移至 v3 核心 7 表通过');
  }

  // 3. 单表独立水位线 + Wave 波次扫描线追平规划与执行 + 独立批大小 + 单表独立频率
  {
    const env = createEnv(makeChat(5)); // AI layers: 2, 4, 6, 8, 10
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      catchUpBatchSize: 3, // 与 smallSummaryEveryX=1 解耦！
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: false,
      summaryDelayFloors: 0
    });

    // 预置：chronicle 已覆盖 2, 4, 6，但其余 6 张结构化表均未填！
    const st0 = env.sandbox.MEMORY_ENGINE_DATA.defaultState();
    for (const [idx, layer] of [2, 4, 6].entries()) {
      const r = env.sandbox.MEMORY_ENGINE_TIMELINE.captureRange(layer - 1, layer);
      st0.tables.chronicle.push({
        id: `small_00000${idx + 1}`, rowId: idx + 1, code_index: `AM000${idx + 1}`,
        startLayer: layer, endLayer: layer, summary: `既有纪要${layer}`, chronicle_text: `既有第${layer}层纪要正文。`,
        sourceRefs: r, sourceDigest: env.sandbox.MEMORY_ENGINE_TIMELINE.digestRefs(r), status: 'valid', revision: 1
      });
    }
    env.sandbox.MEMORY_ENGINE_DATA.saveState(env.sandbox.MEMORY_ENGINE.replayTimeline(st0));

    // 零 Token 预检 Wave 计划
    const plan = env.sandbox.MEMORY_ENGINE.prepareCatchUpPlan({ includeCurrentFloor: true });
    assert.strictEqual(env.calls.length, 0, 'prepareCatchUpPlan 必须 0 Token / 0 API 调用');
    assert.strictEqual(plan.batchSize, 3, '默认追平批大小应使用独立 catchUpBatchSize=3');
    assert.strictEqual(plan.waves.length, 2, '水位参差应切分为 2 个精确 Wave');
    assert.deepStrictEqual(plain(plan.waves[0].aiLayers), [2, 4, 6]);
    assert.ok(!plan.waves[0].sheets.includes('chronicle'), 'Wave 1（楼层 2-6）绝不能重填已覆盖的纪要表！');
    assert.strictEqual(plan.waves[0].sheets.length, 6, 'Wave 1 精准补齐缺失的 6 张表');
    assert.deepStrictEqual(plain(plan.waves[1].aiLayers), [8, 10]);
    assert.strictEqual(plan.waves[1].sheets.length, 7, 'Wave 2（楼层 8-10）将全部 7 张表合流进单次请求！');
    assert.strictEqual(plan.totalBatches, 2, '5 层数据在批大小 3 下仅需 2 批（2 次 API 请求）全部追平');

    env.setApiHandler(async prompt => {
      const sheetsMatch = /本次待填表：\[([^\]]+)\]/.exec(prompt);
      const sheets = sheetsMatch ? sheetsMatch[1].split(',').map(s => s.trim()) : [];
      const res = {};
      if (sheets.includes('global_state')) res.global_state = { current_location: '渡口', cur_time: '第5日' };
      if (sheets.includes('protagonist_info')) res.protagonist_info = { name: '林墨', identity_text: '密探' };
      if (sheets.includes('important_characters')) res.important_characters = { upsert: [{ name: '沈清秋', brief_intro: '总管', presence_status: '在场' }], delete: [] };
      if (sheets.includes('protagonist_skills')) res.protagonist_skills = { upsert: [], delete: [] };
      if (sheets.includes('inventory')) res.inventory = { upsert: [{ item_name: '铜符', quantity: '1' }], delete: [] };
      if (sheets.includes('quests_events')) res.quests_events = { upsert: [], delete: [] };
      if (sheets.includes('chronicle')) res.chronicle = { summary: '第8-10层合并纪要', chronicle_text: '第8至10层合并纪要正文。' };
      return JSON.stringify(res);
    });

    const cu = await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(cu.completedBatches, 2);
    assert.strictEqual(env.calls.length, 2, '实际仅发起 2 次 API 请求完成 7 表追平');
    const stAfter = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(stAfter.tables.chronicle.length, 4, '原有 3 条纪要未被重复覆盖 + 新增 1 条合并纪要 = 4 条');
    for (const k of env.sandbox.MEMORY_ENGINE_DATA.TABLE_KEYS) {
      assert.strictEqual(stAfter.tableWatermarks[k], 10, `${k} 水位线应追平至第 10 层`);
    }

    // 单表独立频率测试：将 chronicle 设为每 3 轮、inventory 设为每 1 轮，其余禁用
    const customTableConfigs = {};
    for (const k of env.sandbox.MEMORY_ENGINE_DATA.TABLE_KEYS) customTableConfigs[k] = { enabled: false, updateFrequency: 0 };
    customTableConfigs.inventory = { enabled: true, updateFrequency: 1 };
    customTableConfigs.chronicle = { enabled: true, updateFrequency: 3 };
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ tableConfigs: customTableConfigs });
    env.chat.push({ is_user: true, name: '林墨', mes: '拾取新物品' }, { is_user: false, name: '旁白', mes: '林墨捡起一枚玉简。' });
    env.calls.length = 0;
    await env.sandbox.MEMORY_ENGINE._test.autoExtract();
    assert.strictEqual(env.calls.length, 1);
    assert.ok(env.calls[0].prompt.includes('本次待填表：[inventory]'), '仅到期的背包物品表触发填表，未到频率的纪要表与禁用表均跳过');
    console.log('✓ 3. 单表独立水位线、Wave 波次合流规划执行、独立批大小与单表频率通过');
  }

  // 4. 带错回灌纠错重试（Error-Feedback Retry）
  {
    const env = createEnv(makeChat(1));
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ tableFillMaxRetries: 2, apiAutoRetries: 0 });
    let attempt = 0;
    env.setApiHandler(async prompt => {
      attempt++;
      if (attempt === 1) {
        // 故意缺少 important_characters.upsert[0].name 主键 且 缺少 chronicle
        return JSON.stringify({
          important_characters: { upsert: [{ brief_intro: '忘了写名字的角色' }], delete: [] }
        });
      }
      assert.ok(prompt.includes('【上一次模型输出】'), '第 2 次纠错请求必须回灌上一轮失败输出');
      assert.ok(prompt.includes('【填表纠错】') && prompt.includes('缺少必填主键字段 name'), '第 2 次纠错请求必须指明具体缺主键报错');
      assert.ok(prompt.includes('纪要表 (chronicle) 缺少必填记录对象'), '第 2 次纠错请求必须指明缺少纪要报错');
      return JSON.stringify({
        important_characters: { upsert: [{ name: '修正后角色', brief_intro: '已补齐姓名', presence_status: '在场' }], delete: [] },
        chronicle: { summary: '纠错后纪要', chronicle_text: '纠错后完整纪要正文。' }
      });
    });
    const res = await env.sandbox.MEMORY_ENGINE.manualExtract();
    assert.strictEqual(attempt, 2, '第 1 次校验失败后应自动纠错重试并在第 2 次成功');
    assert.strictEqual(res.attempts, 2);
    assert.strictEqual(env.sandbox.MEMORY_ENGINE_DATA.loadState().tables.important_characters[0].name, '修正后角色');
    console.log('✓ 4. 带错回灌纠错重试（Error-Feedback Retry）通过');
  }

  // 5. 可填表 AI 楼层过滤（跳过 narrator 旁白楼与 tool_invocations 系统工具楼）
  {
    const env = createEnv([
      { is_user: false, name: '旁白', mes: '开场白' },
      { is_user: true, name: '林墨', mes: '进城' },
      { is_user: false, name: '系统旁白', mes: '（旁白转场）', extra: { type: 'narrator' } },
      { is_user: false, is_system: true, name: '工具', mes: '', extra: { tool_invocations: [{ name: 'dice' }] } },
      { is_user: false, name: '角色', mes: '正式 AI 回复正文' }
    ]);
    const aiLayers = env.sandbox.MEMORY_ENGINE._test.collectEligibleAiLayers();
    assert.deepStrictEqual(Array.from(aiLayers), [4], '必须精准过滤 narrator 旁白楼与 tool_invocations 工具楼，仅保留第 4 层');
    console.log('✓ 5. 可填表 AI 楼层过滤（剔除 narrator 与 tool_invocations）通过');
  }

  // 6. 同步 MESSAGE_DELETED 删楼回退（0ms 脏读窗口）+ Epoch 代次锁拦截迟到旧任务
  {
    const env = createEnv(makeChat(2)); // AI: 2, 4
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ catchUpBatchSize: 1, skipCurrentFloorSummary: false, injectIntoPrompt: true });
    env.setApiHandler(async prompt => {
      const m = /楼层范围：楼层\s*(\d+)/.exec(prompt);
      const l = m ? Number(m[1]) : 0;
      return JSON.stringify({
        inventory: { upsert: [{ item_name: `楼层${l}宝物`, quantity: '1' }], delete: [] },
        chronicle: { summary: `第${l}层事件`, chronicle_text: `第${l}层唯一标记_FLOOR_${l}` }
      });
    });
    await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    env.sandbox.MEMORY_ENGINE.init();
    assert.ok(env.getInjection().includes('FLOOR_4') && env.getInjection().includes('楼层4宝物'));

    // 模拟删除第 3-4 层并触发 MESSAGE_DELETED：await 返回瞬间（0ms！）状态、水位与注入必须已同步完成回退！
    env.chat.splice(3, 2);
    const epochBefore = env.sandbox.MEMORY_ENGINE._test.getAutoFillEpoch();
    await env.ctx.eventSource.emitAsync('MESSAGE_DELETED');
    const epochAfter = env.sandbox.MEMORY_ENGINE._test.getAutoFillEpoch();
    assert.ok(epochAfter > epochBefore, '删楼必须推进 autoFillEpoch 代次锁');
    const stSync = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(stSync.tables.chronicle.length, 1, '0ms 同步回退：第 4 层纪要必须立即裁剪');
    assert.strictEqual(stSync.tableWatermarks.chronicle, 2, '0ms 同步回退：水位线必须立即回退至第 2 层');
    assert.ok(!stSync.tables.inventory.some(i => i.item_name === '楼层4宝物'), '0ms 同步回退：第 4 层背包物品必须立即撤销');
    assert.ok(!env.getInjection().includes('FLOOR_4') && !env.getInjection().includes('楼层4宝物'), '0ms 同步回退：注入提示词不得残留任何已删楼层剧透');

    // 验证迟到的旧 Epoch 任务不得写入脏数据
    const staleBatch = env.sandbox.MEMORY_ENGINE._test.buildBatchFromAiLayers([2]);
    const staleRes = await env.sandbox.MEMORY_ENGINE._test.executeTableFillBatch(staleBatch, {
      targetSheets: ['inventory'],
      expectedEpoch: epochBefore,
      purpose: '迟到旧任务'
    });
    assert.strictEqual(staleRes.skipped, true);
    assert.strictEqual(staleRes.reason, 'epoch_stale', 'Epoch 过期的迟到结果必须被拦截丢弃');
    // 清理测试中挂起的 trailing 调度定时器，防止进程等待
    env.sandbox.MEMORY_ENGINE.abort();
    console.log('✓ 6. 同步 MESSAGE_DELETED 0ms 删楼回退 + Epoch 代次锁拦截通过');
  }

  // 7. shujuku 风格双层省 Token 提示词注入（在场/提及角色详情 + 全员索引；近期纪要 + AM 归档概览 + 关键词回溯）
  {
    const env = createEnv([
      { is_user: false, name: '旁白', mes: '开场。' },
      { is_user: true, name: '林墨', mes: '我在茶楼提到赵铁柱和当年玄铁令的旧事。' }
    ]);
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      injectIntoPrompt: true,
      smallSummaryInjectLimit: 1,
      recallArchivedSmallLimit: 2
    });
    const st = env.sandbox.MEMORY_ENGINE_DATA.defaultState();
    st.tables.important_characters = [
      { rowId: 1, name: '沈清秋', brief_intro: '同行总管', presence_status: '在场', appearance: '青衫玉簪', past_experience: '在场角色详实经历' },
      { rowId: 2, name: '赵铁柱', brief_intro: '城东铁匠', presence_status: '离场', appearance: '满脸虬髯', past_experience: '被正文提及的离场角色经历' },
      { rowId: 3, name: '李掌柜', brief_intro: '客栈老板', presence_status: '离场', appearance: '秃顶算盘', past_experience: '完全未提及的离场路人绝密长经历' }
    ];
    st.tables.chronicle = [
      { id: 'small_000001', rowId: 1, code_index: 'AM0001', startLayer: 2, endLayer: 2, summary: '发现玄铁令线索', chronicle_text: '早期归档纪要：林墨在废墟中得到玄铁令线索。', keywords: ['玄铁令'], status: 'valid' },
      { id: 'small_000002', rowId: 2, code_index: 'AM0002', startLayer: 4, endLayer: 4, summary: '暴雨夜路过南门', chronicle_text: '早期无关纪要：暴雨夜路过南门避雨，并无大事。', keywords: ['南门'], status: 'valid' },
      { id: 'small_000003', rowId: 3, code_index: 'AM0003', startLayer: 6, endLayer: 6, summary: '抵达茶楼会谈', chronicle_text: '最新直注纪要：林墨与沈清秋抵达城南茶楼。', key_dialogue: '沈清秋：“坐下细说。”', status: 'valid' }
    ];
    env.sandbox.MEMORY_ENGINE_DATA.saveState(st);
    const inj = env.sandbox.MEMORY_ENGINE.applyInjection();

    assert.ok(inj.includes('<重要角色详情>') && inj.includes('<已登场重要角色索引>'));
    const detailSection = inj.slice(inj.indexOf('<重要角色详情>'), inj.indexOf('</重要角色详情>'));
    const indexSection = inj.slice(inj.indexOf('<已登场重要角色索引>'), inj.indexOf('</已登场重要角色索引>'));
    assert.ok(detailSection.includes('在场角色详实经历'), '在场角色应展开完整详情');
    assert.ok(detailSection.includes('被正文提及的离场角色经历'), '正文提及的离场角色应按需展开详情');
    assert.ok(!detailSection.includes('完全未提及的离场路人绝密长经历'), '未提及的离场角色不得展开详情浪费 Token');
    assert.ok(indexSection.includes('李掌柜'), '所有角色均应出现在极简角色索引中');

    assert.ok(inj.includes('<近期纪要>') && inj.includes('AM0003') && inj.includes('坐下细说'), '最新纪要与重要对话应完整直注');
    assert.ok(inj.includes('<记忆回溯>') && inj.includes('AM0001') && inj.includes('得到玄铁令线索'), '命中关键词的归档纪要应精准回溯');
    const recallSection = inj.slice(inj.indexOf('<记忆回溯>'), inj.indexOf('</记忆回溯>'));
    assert.ok(!recallSection.includes('暴雨夜路过南门避雨'), '未命中的归档纪要正文不得塞入记忆回溯');
    assert.ok(inj.includes('<已发生的事件概览>') && inj.includes('AM0002 | 暴雨夜路过南门'), '归档纪要应以紧凑 AM 索引呈现');
    console.log('✓ 7. shujuku 风格双层省 Token 提示词注入通过');
  }

  // 8. shujuku 原版底层填表 System Prompt + 可自由编辑主提示词/单表 Note 规则 + 缺占位符自动兜底保护
  {
    const env = createEnv(makeChat(1));
    const promptApi = env.sandbox.MEMORY_ENGINE_PROMPT;
    const defaultBuilt = promptApi.buildTableFillSystemPrompt(['important_characters', 'chronicle']);
    assert.ok(defaultBuilt.includes('你是【填表AI】'), '默认主系统提示词必须采用 shujuku 原版【填表AI】身份');
    assert.ok(defaultBuilt.includes('日志与纪要语气校准') && defaultBuilt.includes('权力掌控'), '默认主系统提示词必须保留 shujuku 原版语气校准规范');
    assert.ok(defaultBuilt.includes('relation_text 格式规则') && defaultBuilt.includes('角色名:关系描述'), '默认重要角色表规则必须包含 shujuku 原版 relation_text 格式规则');
    assert.ok(defaultBuilt.includes('故事仍在继续'), '默认纪要表规则必须包含 shujuku 原版反总结性收尾违例规范');

    // 用户自定义主提示词（故意不写占位符）+ 自定义 inventory 单表规则 -> 必须生效且系统自动补全规则与 JSON 模板
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      tableFillSystemPrompt: '你是作者自定义的专属填表引擎，请严格使用古风简明文体。',
      tableFillSheetRules: {
        inventory: '【自定义背包规则】银两与法器必须注明品阶。'
      }
    });
    let capturedCustomPrompt = '';
    env.setApiHandler(async prompt => {
      capturedCustomPrompt = prompt;
      return JSON.stringify({
        inventory: { upsert: [{ item_name: '青云剑', quantity: '1', category: '灵器', description: '三阶飞剑' }], delete: [] },
        chronicle: { summary: '获得青云剑', chronicle_text: '主角于秘境得三阶灵器青云剑。' }
      });
    });
    await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ selectedSheets: ['inventory', 'chronicle'], includeCurrentFloor: true });
    assert.ok(capturedCustomPrompt.includes('作者自定义的专属填表引擎'), '自定义主 System Prompt 必须真正生效进 API 请求');
    assert.ok(capturedCustomPrompt.includes('【自定义背包规则】银两与法器必须注明品阶'), '自定义单表 Note 规则必须覆盖默认规则生效');
    assert.ok(capturedCustomPrompt.includes('"inventory":') && capturedCustomPrompt.includes('"chronicle":'), '即使作者删除了占位符，系统仍必须自动补全严格 JSON 输出模板');
    assert.strictEqual(env.sandbox.MEMORY_ENGINE_DATA.loadState().tables.inventory[0].item_name, '青云剑');
    console.log('✓ 8. shujuku 原版底层 System Prompt 与可编辑自定义提示词/单表规则生效通过');
  }

  console.log('\n🎉 核心 7 表 + Wave 智能追平 + 纠错重试 + 同步删楼回退 + shujuku 可编辑提示词专项测试全部通过！');
})().catch(err => {
  console.error('❌ 专项测试失败:', err);
  process.exit(1);
});
