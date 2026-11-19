// 记忆纪要控制与回退重填离线测试：node docs/memory-summary-control-test.js
// 覆盖：当前层不填表、重写与多楼删除自动回退重填、手动指定范围填表、一键追平、以及世界/大纲无总述联动。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const plain = v => JSON.parse(JSON.stringify(v));

function createHarness(initialChat) {
  const store = new Map();
  const listeners = new Map();
  const calls = [];
  let injection = '';
  let hiddenIds = [];
  let chat = initialChat.map(m => ({ ...m }));
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
    chatId: 'summary-ctrl-chat',
    get chat() { return chat; },
    set chat(v) { chat = v; },
    name1: '用户',
    name2: '角色',
    event_types: types,
    eventSource: {
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      }
    },
    setExtensionPrompt(_name, content) { injection = content; },
    saveChatConditional() {}
  };

  const sandbox = {
    window: null,
    console,
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
      filterDialogue: v => v,
      loadState: () => ({ round: 1, worldDigest: '世界平稳。', worldTrends: [], winds: [], events: [], factions: [] })
    },
    WORLD_ENGINE_CHATCACHE: { forScope: () => ({ afterEvolution() {}, createSnapshot() {} }) },
    WORLD_ENGINE_UI: { setMemoryEvolvingUI() {}, refresh() {} },
    OUTLINE_ENGINE_SETTINGS: { getSettings: () => ({ engineEnabled: true, useMemoryReference: true, useWorldReference: true }) },
    WORLD_ENGINE_API: {
      getSettings: () => ({ engineEnabled: true, memoryLinkEnabled: true, syncToOutlineEnabled: true }),
      async callApi(prompt) {
        calls.push(prompt);
        const rangeMatch = /楼层\s*(\d+)\s*至\s*(\d+)/.exec(prompt);
        const label = rangeMatch ? `L${rangeMatch[1]}-${rangeMatch[2]}` : 'L?';
        const snippet = (prompt.match(/【待总结对话】\n([\s\S]*?)(?:\n\n【统一输出要求】|$)/)?.[1] || '').trim().slice(0, 60);
        const res = {};
        if (prompt.includes('"personal_memory":')) {
          res.personal_memory = [{ name: ['角色'], known_by: [], memory: `提取自${label}`, time: '' }];
          res.entity_updates = [];
          res.ongoing_fact_updates = [];
          res.character_arc_updates = [];
        }
        if (prompt.includes('"small_summary": ""')) {
          res.small_summary = `纪要(${label})：${snippet.replace(/\s+/g, ' ')}`;
          res.small_summary_keywords = [label];
          res.small_summary_entities = ['角色'];
          res.small_summary_impact = label === 'L1-2' ? 'key' : 'normal';
        }
        return JSON.stringify(res);
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
    'story-engine-projection.js',
    'story-engine-bridge.js',
    'memory-engine.js'
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  }

  const origSyncHidden = sandbox.MEMORY_ENGINE_TIMELINE.syncHidden;
  sandbox.MEMORY_ENGINE_TIMELINE.syncHidden = async ids => {
    hiddenIds = Array.from(ids || []);
    return origSyncHidden(ids);
  };

  const emit = (name, ...args) => {
    for (const fn of listeners.get(types[name] || name) || []) fn(...args);
  };

  return {
    sandbox,
    ctx,
    getChat: () => chat,
    calls,
    getInjection: () => injection,
    getHiddenIds: () => hiddenIds,
    emit
  };
}

function makeChat(rounds) {
  const list = [{ is_user: false, name: '角色', mes: '开场白（第0层）' }];
  for (let r = 1; r <= rounds; r++) {
    list.push({ is_user: true, name: '用户', mes: `第${r}轮用户发言` });
    list.push({ is_user: false, name: '角色', mes: `第${r}轮角色回复` });
  }
  return list;
}

(async () => {
  // 1. 当前层不填表（skipCurrentFloorSummary: true）
  {
    const h = createHarness(makeChat(1)); // layers: 0(opening), 1(u1), 2(a1)
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: true,
      summaryDelayFloors: 0,
      hideCoveredRawText: true,
      recentRawRounds: 0
    });
    assert.strictEqual(h.sandbox.MEMORY_ENGINE._test.getEffectiveSummaryDelay(), 1, '勾选当前层不填表后实际延迟应至少为 1');
    h.calls.length = 0;
    await h.sandbox.MEMORY_ENGINE._test.autoExtract();
    assert.strictEqual(h.calls.length, 0, '仅有一轮最新回复且开启当前层不填表时，不应自动填表');

    // 新增第2轮（layers 3, 4），第1轮（layers 1, 2）离开当前层成为稳态，应自动填表第1轮且跳过第2轮
    h.getChat().push(
      { is_user: true, name: '用户', mes: '第2轮用户发言' },
      { is_user: false, name: '角色', mes: '第2轮角色回复' }
    );
    await h.sandbox.MEMORY_ENGINE._test.autoExtract();
    assert.strictEqual(h.calls.length, 1, '新增下一轮后应只对稳态的前一轮填表');
    const st = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(st.event_memory.small_summaries.length, 1);
    assert.strictEqual(st.event_memory.small_summaries[0].startLayer, 1);
    assert.strictEqual(st.event_memory.small_summaries[0].endLayer, 2);
    const currentAiId = h.sandbox.MEMORY_ENGINE_TIMELINE.ensureMessageId(h.getChat()[4]);
    assert.ok(!h.getHiddenIds().includes(currentAiId), '开启当前层不填表时最新楼层正文必须保持不隐藏');
  }

  // 2. 删除多楼（尾部部分删除、尾部全删、仅剩孤儿用户楼、中间删多楼）自动回退并重新填表
  {
    const h = createHarness(makeChat(5)); // 0..10 (5 rounds)
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      smallSummaryEveryX: 2,
      skipCurrentFloorSummary: false,
      summaryDelayFloors: 0,
      autoRefillOnHistoryChange: true
    });
    // 用 catchUpToLatest 先把 1..10 按每 2 轮填齐：1-4, 5-8, 9-10
    const cu = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(cu.completedBatches, 3);
    let state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.event_memory.small_summaries.map(s => [s.startLayer, s.endLayer])),
      [[1, 4], [5, 8], [9, 10]]
    );

    // 2A. 尾部删掉 7..10 四层（剩下 0..6）：9-10 应彻底回退删除，5-8 应基于存活的 5-6 重新填表！
    h.getChat().splice(7, 4);
    h.calls.length = 0;
    const prep = await h.sandbox.MEMORY_ENGINE.prepareHistoryForGeneration();
    assert.strictEqual(prep.invalidated, true);
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(state.event_memory.small_summaries.length, 2, '彻底删除的 9-10 纪要应立即回退移除');
    assert.strictEqual(state.event_memory.small_summaries[1].status, 'stale', '部分删除的 5-8 纪要应标为 stale 暂停注入');
    assert.ok(!h.getInjection().includes('L5-8'), 'stale 纪要不得继续注入');

    const rec = await h.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: true });
    assert.strictEqual(rec.repaired, true);
    assert.strictEqual(h.calls.length, 1, '应仅重填受影响且仍存活的 5-6 楼');
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.event_memory.small_summaries.map(s => [s.startLayer, s.endLayer, s.status])),
      [[1, 4, 'valid'], [5, 6, 'valid']]
    );
    assert.strictEqual(state.event_memory.small_summary_layer, 6, '重填后游标应精确落在第 6 层');

    // 2B. 删除第 6 层（AI 回复），使 5-6 仅剩第 5 层孤儿用户消息：5-6 纪要必须彻底回退删除，游标退回第 4 层！
    h.getChat().splice(6, 1);
    h.calls.length = 0;
    await h.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: true });
    assert.strictEqual(h.calls.length, 0, '孤儿用户楼不应触发填表');
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.event_memory.small_summaries.map(s => [s.startLayer, s.endLayer])),
      [[1, 4]]
    );
    assert.strictEqual(state.event_memory.small_summary_layer, 4, '删除 AI 楼后游标必须回退至第 4 层');
  }

  // 3. 中间删除多楼 + 后续楼层号前移自动对齐 + 剩余存活楼层重新填表
  {
    const h = createHarness(makeChat(5)); // 0..10
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ smallSummaryEveryX: 2, skipCurrentFloorSummary: false });
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    // 删除中间第 3..6 楼（原第 7..10 楼前移变成新 3..6 楼）
    // 原 small_1(1-4) 存活 1-2；原 small_2(5-8) 存活新 3-4；原 small_3(9-10) 完整存活并前移至新 5-6！
    h.getChat().splice(3, 4);
    h.calls.length = 0;
    const rec = await h.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: true });
    assert.strictEqual(rec.repaired, true);
    assert.strictEqual(h.calls.length, 2, '完好前移的 5-6 不重算，只重建受删楼影响的 1-2 与 3-4');
    const state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.event_memory.small_summaries.map(s => [s.startLayer, s.endLayer, s.status])),
      [[1, 2, 'valid'], [3, 4, 'valid'], [5, 6, 'valid']]
    );
  }

  // 4. 尾部删楼落入“当前层不填表”延迟区：回退但不提前重填当前层
  {
    const h = createHarness(makeChat(4)); // 0..8
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      smallSummaryEveryX: 2,
      skipCurrentFloorSummary: true,
      summaryDelayFloors: 0
    });
    // 1-4 与 5-6 先追平（含延迟跳过 7-8）
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: false });
    let state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(plain(state.event_memory.small_summaries.map(s => [s.startLayer, s.endLayer])), [[1, 4], [5, 6]]);
    // 删掉 6..8（剩下 0..5，最新 AI 层为 4，稳态上限 stableEnd=2）并修改第 4 层
    // 原 5-6 无存活 AI 层被彻底清理；原 1-4 跨越了延迟层 4，应回退并仅重填稳态的 1-2，不提前填当前层 3-4！
    h.getChat().splice(6, 3);
    h.getChat()[4].mes = '修改后的第2轮角色回复';
    h.calls.length = 0;
    await h.sandbox.MEMORY_ENGINE.reconcileHistory({ respectDelay: true, refillUncovered: true });
    assert.strictEqual(h.calls.length, 1, '跨延迟区的旧批次应回退后仅重填稳态前置楼层 1-2');
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.event_memory.small_summaries.map(s => [s.startLayer, s.endLayer])),
      [[1, 2]],
      '当前最新楼层 3-4 必须保持未填表状态'
    );
    // 再删掉 3..5 并修改第 2 层（现在全聊天仅剩第 2 层这一个当前 AI 层，stableEnd=-1），应彻底回退且 0 API 调用
    h.getChat().splice(3, 3);
    h.getChat()[2].mes = '重写后的第1轮回复';
    h.calls.length = 0;
    await h.sandbox.MEMORY_ENGINE.reconcileHistory({ respectDelay: true, refillUncovered: true });
    assert.strictEqual(h.calls.length, 0, '仅剩当前延迟楼层时应回退清理而不提前重填');
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(state.event_memory.small_summaries.length, 0);
  }

  // 5. 重写（MESSAGE_EDITED）事件触发立即撤旧与防抖重填
  {
    const h = createHarness(makeChat(3)); // 0..6
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: false,
      autoRefillOnHistoryChange: true
    });
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    h.sandbox.MEMORY_ENGINE.init();
    h.calls.length = 0;
    // 编辑第 2 层内容并触发 MESSAGE_EDITED
    h.getChat()[2].mes = '重写后的全新剧情：角色决定前往北境。';
    h.emit('MESSAGE_EDITED');
    // 等待本地撤旧生效（50ms）
    await new Promise(r => setTimeout(r, 120));
    assert.ok(!h.getInjection().includes('第1轮角色回复'), '编辑重写后应立即撤下旧纪要注入');
    // 等待防抖自动重填完成（1200ms）
    await new Promise(r => setTimeout(r, 1400));
    assert.strictEqual(h.calls.length, 1, '重写防抖结束后应自动重填被编辑的楼层纪要');
    const state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.ok(state.event_memory.small_summaries[0].content.includes('前往北境'), '重建后的纪要应反映重写后的新正文');
  }

  // 6. 手动指定范围填表（覆盖 / 不覆盖 / 保留世界联动纪要）+ 一键追平（含/不含当前层）
  {
    const h = createHarness(makeChat(5)); // 0..10
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: true,
      summaryDelayFloors: 0
    });
    // 先写入一条第 4 层的世界引擎轻同步纪要
    h.calls.length = 0;
    const linkRes = await h.sandbox.MEMORY_ENGINE.ingestWorldEvolution({
      lightweight: true,
      layer: 4,
      worldDigest: '世界线变动：北方港口封航。',
      worldCommitId: 'wc_4',
      force: true
    });
    assert.strictEqual(linkRes.lightweight, true);
    assert.strictEqual(h.calls.length, 0, '世界轻同步绝不消耗记忆 LLM API');

    // 手动指定范围 3..6 填表（每批 1 轮，覆盖模式）
    const rangeRes = await h.sandbox.MEMORY_ENGINE.fillSummaryRange({
      startLayer: 3, endLayer: 6, batchSize: 1, overwrite: true
    });
    assert.strictEqual(rangeRes.completedBatches, 2, '楼层 3-6 共 2 个 AI 轮次应分 2 批填表');
    let state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.ok(
      state.event_memory.small_summaries.some(s => s.source === 'world_engine' && s.content.includes('北方港口封航')),
      '手动范围填表覆盖对话纪要时，不得误删世界联动同步纪要'
    );
    assert.deepStrictEqual(
      plain(state.event_memory.small_summaries.filter(s => s.source !== 'world_engine').map(s => [s.startLayer, s.endLayer])),
      [[3, 4], [5, 6]]
    );

    // 再次对 1..6 执行 overwrite:false，应只补未覆盖的 1..2（跳过已覆盖的 3..6）
    h.calls.length = 0;
    const gapRes = await h.sandbox.MEMORY_ENGINE.fillSummaryRange({
      startLayer: 1, endLayer: 6, batchSize: 1, overwrite: false
    });
    assert.strictEqual(gapRes.completedBatches, 1, '非覆盖范围填表应只补未覆盖的 1-2 楼');
    assert.strictEqual(h.calls.length, 1);

    // 一键追平（默认遵守当前层不填表：当前最新 AI 为 10，延迟 1 轮目标为 8，故补 7-8）
    h.calls.length = 0;
    const catchDelay = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: false });
    assert.strictEqual(catchDelay.completedBatches, 1);
    assert.strictEqual(catchDelay.targetEndLayer, 8, '遵守当前层不填表时追平目标应停在第 8 层');
    assert.strictEqual(h.calls.length, 1);

    // 一键追平（强制包含当前层：补齐 9-10）
    h.calls.length = 0;
    const catchAll = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(catchAll.completedBatches, 1);
    assert.strictEqual(catchAll.targetEndLayer, 10, '勾选含当前层后应追平至第 10 层');
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.event_memory.small_summaries.filter(s => s.source !== 'world_engine').map(s => [s.startLayer, s.endLayer])),
      [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]
    );

    // 验证协同桥向大纲输出参考背景时（无总述）：应携带关键历史纪要 + 近期纪要
    const bridgeRef = h.sandbox.STORY_ENGINE_BRIDGE.buildOutlineReferenceContext({ plan: { nodes: [] } });
    assert.ok(bridgeRef.includes('近期事件纪要'), '大纲参考背景应包含近期事件纪要');
    assert.ok(!bridgeRef.includes('最新总述'), '去除总述后大纲参考背景不得再出现最新总述');
  }

  console.log('memory summary control, rollback-refill, range & catch-up tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
