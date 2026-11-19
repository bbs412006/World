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
      async callEmbeddingApi(inputs) {
        const list = Array.isArray(inputs) ? inputs : [inputs];
        return list.map(text => {
          const s = String(text || '');
          let h1 = 0, h2 = 0, h3 = 0;
          for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            h1 = (h1 * 31 + c) % 997;
            h2 = (h2 * 37 + c) % 991;
            h3 = (h3 * 41 + c) % 983;
          }
          return [Number((h1 / 997).toFixed(6)), Number((h2 / 991).toFixed(6)), Number((h3 / 983).toFixed(6))];
        });
      },
      async callApi(prompt) {
        calls.push(prompt);
        const rangeMatch = /楼层\s*(\d+)\s*至\s*(\d+)/.exec(prompt);
        const startL = rangeMatch ? Number(rangeMatch[1]) : 0;
        const endL = rangeMatch ? Number(rangeMatch[2]) : 0;
        const label = rangeMatch ? `L${startL}-${endL}` : 'L?';
        const snippet = (prompt.match(/【(?:待总结对话|待提取对话)】\n([\s\S]*?)(?:\n\n(?:请严格按照|【任务说明|【统一输出要求)|$)/)?.[1] || '').trim().slice(0, 80);
        const res = {};
        if (prompt.includes('"personal_memory":')) {
          res.personal_memory = [
            { name: ['角色'], known_by: [], memory: `提取自${label}`, time: '' }
          ];
          if (endL >= 11) {
            res.personal_memory.push({ name: [`新人物_${label}`], known_by: ['角色'], memory: `登场于${label}`, time: '' });
          }
          res.entity_updates = [
            { type: 'location', name: `地点_${label}`, aliases: [], description: `发现于${label}`, event: `抵达${label}`, time: '' }
          ];
          res.ongoing_fact_updates = [
            {
              action: 'upsert',
              id: '',
              category: '状态',
              subject: '角色',
              fact: `事实_${label}`,
              keywords: [label]
            }
          ];
          // 在第 6 个 AI 层（L11-12）完结第 1 层的事实 fact_000001，以测试回退后该事实与向量能否自动恢复激活
          if (endL === 12) {
            res.ongoing_fact_updates.push({
              action: 'resolve',
              id: 'fact_000001',
              category: '状态',
              subject: '角色',
              fact: '事实_L1-2',
              keywords: ['L1-2']
            });
          }
          res.character_arc_updates = [
            {
              name: '角色',
              current_stance: `立场_${label}`,
              arc_summary: `弧光_${label}`,
              relationship: `关系_${label}`,
              progress_pct: Math.min(100, endL * 5)
            }
          ];
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
    'memory-engine-vector.js',
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

  // 7. 进入之前未填过表的 14 楼旧卡（含已自动填了 13-14 的情况），一键追平必须补齐全部 1..7 条填表数据（纪要+人物+实体+事实+弧光+向量）
  {
    // 模拟用户在第 12 楼时首次开启插件（init 将 small_summary_layer 设为 12），随后推进到第 14 楼自动填了 13-14
    const h = createHarness(makeChat(6)); // 0..12
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: false,
      summaryDelayFloors: 0,
      vectorEnabled: true,
      vectorAutoMaintain: true,
      embeddingApiUrl: 'https://mock.embedding/v1/embeddings',
      embeddingModel: 'text-embedding-3-small'
    });
    h.sandbox.MEMORY_ENGINE.init();
    assert.strictEqual(h.sandbox.MEMORY_ENGINE_DATA.loadState().event_memory.small_summary_layer, 12);

    // 推进到第 14 楼（新增 13 用户 + 14 AI），触发自动提取 13-14
    h.getChat().push(
      { is_user: true, name: '用户', mes: '第7轮用户发言：我们去第7层区域。', swipe_id: 0, extra: {} },
      { is_user: false, name: '角色', mes: '第7轮角色回复：已抵达第7层区域。<small>第7日</small>', swipe_id: 0, extra: {} }
    );
    await h.sandbox.MEMORY_ENGINE._test.autoExtract();
    let state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.event_memory.small_summaries.map(s => [s.startLayer, s.endLayer])),
      [[13, 14]],
      '仅自动提取最新一轮时只有 13-14'
    );

    // 此时覆盖率检测必须识别出前 6 个 AI 层（2,4,6,8,10,12）未填表！
    const covBefore = h.sandbox.MEMORY_ENGINE.getSummaryCoverageStatus();
    assert.deepStrictEqual(plain(covBefore.uncoveredCombinedAiLayers), [2, 4, 6, 8, 10, 12]);

    // 点击“一键追平到最新”：应补齐前 6 个 AI 层，最终按 1..7 顺序呈现全部 7 条填表数据
    const cu = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(cu.completedBatches, 6, '应补齐前 6 个缺失的 AI 层');
    await h.sandbox.MEMORY_ENGINE_VECTOR.maintainVectors();
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.event_memory.small_summaries.map(s => [s.startLayer, s.endLayer])),
      [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14]],
      '追平后必须完整呈现 1..7 共 7 条纪要'
    );
    assert.deepStrictEqual(
      plain(state.timeline.nodes.map(n => [n.startLayer, n.endLayer])),
      [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14]],
      '追平后时间线节点必须按 1..7 楼层顺序完整排列并重放'
    );
    assert.strictEqual(state.round, 7, '累计推演轮次应为 7');
  }

  // 8. 14 楼（7 个 AI 层）全要素填表后删除第 6、7 两个 AI 层：纪要/人物/实体/持续事实/角色弧光/向量必须全部精确回退至第 1–5 层填表时的状态
  {
    const h = createHarness(makeChat(5)); // 先到第 10 楼（前 5 个 AI 层：1-2, 3-4, 5-6, 7-8, 9-10）
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: false,
      summaryDelayFloors: 0,
      vectorEnabled: true,
      vectorAutoMaintain: true,
      embeddingApiUrl: 'https://mock.embedding/v1/embeddings',
      embeddingModel: 'text-embedding-3-small'
    });
    // 追平前 5 个 AI 层并维护向量，记录第 1–5 层填表完成时的完整快照
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    await h.sandbox.MEMORY_ENGINE_VECTOR.maintainVectors();

    const stateAt5 = plain(h.sandbox.MEMORY_ENGINE_DATA.loadState());
    const vectorsAt5 = plain(h.sandbox.MEMORY_ENGINE_VECTOR.loadVectorStore().records);
    assert.strictEqual(stateAt5.event_memory.small_summaries.length, 5);
    assert.strictEqual(stateAt5.timeline.nodes.length, 5);
    assert.strictEqual(stateAt5.round, 5);
    assert.strictEqual(stateAt5.chatLayer, 10);
    assert.strictEqual(stateAt5.event_memory.small_summary_layer, 10);
    // 验证第 5 层时：只有 1 个人物（角色，含 5 条记忆）、5 个地点实体、5 条 active 事实（含 fact_000001）、角色弧光进度 50
    assert.strictEqual(stateAt5.personal_memory.length, 1);
    assert.strictEqual((stateAt5.personal_memory[0].memory[''] || []).length, 5);
    assert.strictEqual(stateAt5.entity_memory.location.length, 5);
    assert.strictEqual(stateAt5.ongoing_facts.filter(f => f.status === 'active').length, 5);
    assert.strictEqual(stateAt5.character_arcs[0].progressPct, 50);
    assert.ok(vectorsAt5['fact:fact_000001'], '第 5 层时 fact_000001 处于激活态且拥有向量');

    // 继续推进第 6、7 两个 AI 层（11-12 与 13-14）并填表 + 维护向量
    h.getChat().push(
      { is_user: true, name: '用户', mes: '第6轮用户发言：我们去第6层区域。', swipe_id: 0, extra: {} },
      { is_user: false, name: '角色', mes: '第6轮角色回复：已抵达第6层区域。<small>第6日</small>', swipe_id: 0, extra: {} },
      { is_user: true, name: '用户', mes: '第7轮用户发言：我们去第7层区域。', swipe_id: 0, extra: {} },
      { is_user: false, name: '角色', mes: '第7轮角色回复：已抵达第7层区域。<small>第7日</small>', swipe_id: 0, extra: {} }
    );
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    await h.sandbox.MEMORY_ENGINE_VECTOR.maintainVectors();

    const stateAt7 = plain(h.sandbox.MEMORY_ENGINE_DATA.loadState());
    const vectorsAt7 = plain(h.sandbox.MEMORY_ENGINE_VECTOR.loadVectorStore().records);
    assert.strictEqual(stateAt7.event_memory.small_summaries.length, 7);
    assert.strictEqual(stateAt7.timeline.nodes.length, 7);
    assert.strictEqual(stateAt7.personal_memory.length, 3, '第 6、7 层新增了 2 名新人物');
    assert.strictEqual(stateAt7.entity_memory.location.length, 7, '第 6、7 层新增了 2 个地点实体');
    assert.strictEqual(
      stateAt7.ongoing_facts.find(f => f.id === 'fact_000001')?.status,
      'resolved',
      '第 6 层将 fact_000001 标记为已完结'
    );
    assert.strictEqual(stateAt7.character_arcs[0].progressPct, 70, '第 7 层将角色弧光推进至 70');
    assert.ok(!vectorsAt7['fact:fact_000001'], '第 7 层时已完结的 fact_000001 从活动向量池移除');
    assert.ok(vectorsAt7['small:small_000006'] && vectorsAt7['small:small_000007'], '第 6、7 层纪要向量已生成');

    // 现在删除第 6、7 两个 AI 层（甚至故意留下第 11 层孤儿用户消息，即先删 12..14，再删 11）
    h.getChat().splice(12, 3); // 留下 0..11（第 11 层是孤儿用户楼，第 6、7 两个 AI 层 12 和 14 已被删除）
    h.calls.length = 0;
    await h.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: true });
    assert.strictEqual(h.calls.length, 0, '删除第 6、7 两个 AI 层回退时不应产生多余的 API 请求');

    // 再把第 11 层孤儿用户楼也删掉（完整删掉 11..14）
    h.getChat().splice(11, 1);
    await h.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: true });
    assert.strictEqual(h.calls.length, 0);

    const rolledState = plain(h.sandbox.MEMORY_ENGINE_DATA.loadState());
    const rolledVectors = plain(h.sandbox.MEMORY_ENGINE_VECTOR.loadVectorStore().records);

    // 验证所有结构化数据与第 1–5 层填表时的状态完全一致！
    assert.deepStrictEqual(rolledState.event_memory.small_summaries, stateAt5.event_memory.small_summaries, '纪要必须精确回退至第 1–5 层状态');
    assert.deepStrictEqual(rolledState.timeline.nodes, stateAt5.timeline.nodes, '时间线节点必须精确回退至第 1–5 层状态');
    assert.deepStrictEqual(rolledState.personal_memory, stateAt5.personal_memory, '人物记忆必须精确回退至第 1–5 层状态');
    assert.deepStrictEqual(rolledState.knowledge_index, stateAt5.knowledge_index, '人物知识索引必须精确回退至第 1–5 层状态');
    assert.deepStrictEqual(rolledState.entity_memory, stateAt5.entity_memory, '实体记忆必须精确回退至第 1–5 层状态');
    assert.deepStrictEqual(rolledState.entity_index, stateAt5.entity_index, '实体索引必须精确回退至第 1–5 层状态');
    assert.deepStrictEqual(rolledState.ongoing_facts, stateAt5.ongoing_facts, '持续事实（含第 6 层被完结的 fact_000001 恢复激活）必须精确回退至第 1–5 层状态');
    assert.deepStrictEqual(rolledState.character_arcs, stateAt5.character_arcs, '角色弧光必须精确回退至第 1–5 层状态');
    assert.strictEqual(rolledState.round, stateAt5.round, 'round 必须回退至 5');
    assert.strictEqual(rolledState.chatLayer, stateAt5.chatLayer, 'chatLayer 必须回退至 10');
    assert.strictEqual(rolledState.event_memory.small_summary_layer, stateAt5.event_memory.small_summary_layer, 'small_summary_layer 必须回退至 10');

    // 验证向量库也同步回退至第 1–5 层填表时的状态（移除第 6、7 层向量，且恢复角色第 5 层向量与 fact_000001 向量）
    const stripUpdatedAt = records => Object.fromEntries(
      Object.entries(records).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { textHash: v.textHash, vector: v.vector, meta: v.meta }])
    );
    assert.deepStrictEqual(
      stripUpdatedAt(rolledVectors),
      stripUpdatedAt(vectorsAt5),
      '向量库记录必须精确回退至第 1–5 层填表时的状态'
    );
  }

  // 9. 解析加固、兜底补提、旧空节点修复与单层纪要最低 500 字设定验证
  {
    const h = createHarness(makeChat(2)); // 0..4
    assert.strictEqual(h.sandbox.MEMORY_ENGINE_SETTINGS.getSettings().smallSummaryMinChars, 500, '默认单层纪要最低字数应为 500');

    // 9A. 多 JSON 块合并 + 中文实体 type 归一化 + 别名字段兼容
    const twoBlockRaw = [
      '```json',
      JSON.stringify({
        personal_memory: [{ names: ['沈清秋'], content: '沈清秋与青石商会达成合作协议。', knownBy: ['林墨'], time: '' }],
        entities: [
          { type: '组织', name: '青石商会', description: '掌控北境商路的大商会', event: '与沈清秋签约', time: '' },
          { type: '地点', name: '青石渡', description: '北境渡口', event: '', time: '' },
          { type: '物品', name: '青铜虎符', description: '调兵信物', event: '', time: '' },
          { type: '能力', name: '听潮剑意', description: '高阶剑道能力', event: '', time: '' }
        ],
        ongoing_facts: [{ action: 'upsert', category: '契约', subject: '沈清秋', description: '与青石商会签订保密商约', keywords: ['商约'] }],
        character_arcs: [{ character: '沈清秋', stance: '谨慎合作', summary: '开始信任商会渠道', relationship: '合作伙伴', progress: 35 }]
      }),
      '```',
      '```json',
      JSON.stringify({
        small_summary: '这是一段位于第二个代码块中的详实纪要正文。',
        small_summary_keywords: ['青石商会', '青石渡'],
        small_summary_entities: ['沈清秋', '青石商会'],
        small_summary_impact: 'key'
      }),
      '```'
    ].join('\n');
    const parsedTwo = h.sandbox.MEMORY_ENGINE._test.parseResponse(twoBlockRaw, { memory: true, small: true });
    assert.strictEqual(parsedTwo.hasMemoryPayload, true);
    assert.strictEqual(parsedTwo.personal.length, 1, '双 JSON 块输出时不得丢弃第一个块中的人物记忆');
    assert.strictEqual(parsedTwo.entities.organization.length, 1, '中文实体类型“组织”应正确归一化为 organization');
    assert.strictEqual(parsedTwo.entities.location.length, 1, '中文实体类型“地点”应正确归一化为 location');
    assert.strictEqual(parsedTwo.entities.object.length, 1, '中文实体类型“物品”应正确归一化为 object');
    assert.strictEqual(parsedTwo.entities.ability.length, 1, '中文实体类型“能力”应正确归一化为 ability');
    assert.strictEqual(parsedTwo.factUpdates.length, 1, '别名字段 ongoing_facts/description 应正确解析');
    assert.strictEqual(parsedTwo.arcUpdates.length, 1, '别名字段 character_arcs 应正确解析');
    assert.ok(parsedTwo.smallSummary.includes('第二个代码块'), '第二个块中的纪要正文也应保留');

    // 9B. 联合请求中若模型漏填人物/实体/事实（只返回 small_summary），runTasks 应自动补发独立记忆提取兜底，且 Prompt 包含 500 字下限且不含中部 JSON 截断句
    let combinedCallSeen = false;
    let fallbackMemoryCallSeen = false;
    const origCallApi = h.sandbox.WORLD_ENGINE_API.callApi;
    h.sandbox.WORLD_ENGINE_API.callApi = async prompt => {
      h.calls.push(prompt);
      const isCombined = prompt.includes('"personal_memory":') && prompt.includes('"small_summary": ""');
      if (isCombined) {
        combinedCallSeen = true;
        assert.ok(prompt.includes('最低不少于 500 字'), '单层纪要 Prompt 必须明确要求最低不少于 500 字');
        assert.ok(!prompt.includes('请严格按照系统规则，只返回一个 JSON 对象。\n\n====='), '组合 Prompt 中段不得再出现导致模型拆块的独立 JSON 指令');
        // 模拟偷懒模型只返回了 small_summary 而完全漏掉人物/组织/事实字段
        return JSON.stringify({
          small_summary: '仅返回了纪要字段的偷懒模型输出。'.repeat(25),
          small_summary_keywords: ['测试'],
          small_summary_entities: ['角色'],
          small_summary_impact: 'normal'
        });
      }
      if (prompt.includes('"personal_memory":') && !prompt.includes('"small_summary": ""')) {
        fallbackMemoryCallSeen = true;
        return JSON.stringify({
          personal_memory: [{ name: ['林墨'], known_by: [], memory: '林墨得知黑水帮暗中封锁了渡口。', time: '' }],
          entity_updates: [{ type: '组织', name: '黑水帮', aliases: [], description: '盘踞河道的帮派', event: '封锁渡口', time: '' }],
          ongoing_fact_updates: [{ action: 'upsert', id: '', category: '环境', subject: '黑水帮', fact: '黑水帮正在封锁青石渡口', keywords: ['黑水帮'] }],
          character_arc_updates: [{ name: '林墨', current_stance: '警惕调查', arc_summary: '决定暗查黑水帮动向', relationship: '敌对防备', progress_pct: 25 }]
        });
      }
      return origCallApi(prompt);
    };
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(combinedCallSeen, true);
    assert.strictEqual(fallbackMemoryCallSeen, true, '当联合请求漏掉人物/实体/事实时，必须自动补发独立记忆提取请求');
    let state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(state.event_memory.small_summaries.length, 2);
    assert.ok(state.personal_memory.some(p => p.names.includes('林墨')), '兜底补提应成功写入人物');
    assert.ok(state.entity_memory.organization.some(o => o.name === '黑水帮'), '兜底补提应成功写入组织实体');
    assert.ok(state.ongoing_facts.some(f => f.fact.includes('黑水帮')), '兜底补提应成功写入持续事实');
    assert.ok(state.character_arcs.some(a => a.names.includes('林墨')), '兜底补提应成功写入角色弧光');

    // 9C. 验证若旧存档中存在“仅有纪要、时间线节点全为空且无人物/实体/事实”的残留状态，点击一键追平会自动补齐人物/组织/事实
    const brokenState = plain(state);
    brokenState.personal_memory = [];
    brokenState.knowledge_index = {};
    brokenState.entity_memory = { organization: [], object: [], ability: [], location: [] };
    brokenState.entity_index = {};
    brokenState.ongoing_facts = [];
    brokenState.character_arcs = [];
    brokenState.timeline.nodes = brokenState.timeline.nodes.map(n => ({
      ...n, personal: [], entities: { organization: [], object: [], ability: [], location: [] }, factUpdates: [], arcUpdates: [], memoryExtracted: undefined
    }));
    h.sandbox.MEMORY_ENGINE_DATA.saveState(brokenState);
    const covBroken = h.sandbox.MEMORY_ENGINE.getSummaryCoverageStatus();
    assert.deepStrictEqual(plain(covBroken.uncoveredCombinedAiLayers), [2, 4], '全空旧时间线节点应被识别为待补提');
    const repairCu = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(repairCu.completedBatches, 2, '一键追平应自动为 2 个缺失记忆的 AI 层补提人物/组织/事实');
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.ok(state.personal_memory.some(p => p.names.includes('林墨')) && state.entity_memory.organization.some(o => o.name === '黑水帮'));
  }

  console.log('memory summary control, rollback-refill, range & catch-up tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
