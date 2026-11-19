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

  // 10. 复现并验证：用户曾在末尾楼层手工删除过人物/实体/事实（留下空 manual_snapshot）后，范围填表与一键追平都必须让人物/实体/事实/弧光真正落表，且一键追平绝不退化成仅请求阶段纪要
  {
    const h = createHarness(makeChat(3)); // 0..6 (3 个 AI 层)
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: false,
      summaryDelayFloors: 0
    });
    // 先跑一次范围填表，然后在第 6 层手工删除所有人物/实体/事实（模拟用户在面板手动清空表 -> 触发 commitManualState 生成末尾 manual_snapshot）
    await h.sandbox.MEMORY_ENGINE.fillSummaryRange({ startLayer: 1, endLayer: 6, batchSize: 1, overwrite: true, includeMemory: true });
    const prev = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    const cleared = plain(prev);
    cleared.personal_memory = [];
    cleared.knowledge_index = {};
    cleared.entity_memory = { organization: [], object: [], ability: [], location: [] };
    cleared.entity_index = {};
    cleared.ongoing_facts = [];
    cleared.character_arcs = [];
    h.sandbox.MEMORY_ENGINE.commitManualState(cleared, prev);
    h.sandbox.MEMORY_ENGINE_DATA.saveState(cleared);
    assert.ok(
      h.sandbox.MEMORY_ENGINE_DATA.loadState().timeline.nodes.some(n => n.kind === 'manual_snapshot'),
      '手工清空后时间线应包含末尾 manual_snapshot'
    );

    // 10A. 此时删掉纪要再点击一键追平：必须同时请求人物/实体/事实/弧光与纪要（不能只请求阶段纪要），且数据必须真正落表！
    const beforeCu = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    beforeCu.event_memory.small_summaries = [];
    h.sandbox.MEMORY_ENGINE_DATA.saveState(beforeCu);
    h.calls.length = 0;
    const cu = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true, includeMemory: true });
    assert.strictEqual(cu.completedBatches, 3);
    assert.ok(h.calls.every(p => p.includes('"personal_memory":') && p.includes('"small_summary": ""')),
      '一键追平每一批都必须同时包含人物/实体/事实/弧光与纪要请求，绝不能退化成仅请求阶段纪要');
    let afterCu = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.ok(afterCu.personal_memory.length > 0, '一键追平后人物表必须真正落表');
    assert.ok(afterCu.entity_memory.location.length === 3, '一键追平后实体表必须真正落表');
    assert.ok(afterCu.ongoing_facts.length === 3, '一键追平后持续事实表必须真正落表');
    assert.ok(afterCu.character_arcs.length > 0, '一键追平后角色弧光必须真正落表');

    // 10B. 再次模拟末尾出现空 manual_snapshot，然后执行范围填表（overwrite: true）：数据也必须真正落表，不能被旧 manual_snapshot 抹空！
    const prev2 = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    const cleared2 = plain(prev2);
    cleared2.personal_memory = [];
    cleared2.knowledge_index = {};
    cleared2.entity_memory = { organization: [], object: [], ability: [], location: [] };
    cleared2.entity_index = {};
    cleared2.ongoing_facts = [];
    cleared2.character_arcs = [];
    h.sandbox.MEMORY_ENGINE.commitManualState(cleared2, prev2);
    h.sandbox.MEMORY_ENGINE_DATA.saveState(cleared2);
    await h.sandbox.MEMORY_ENGINE.fillSummaryRange({ startLayer: 1, endLayer: 6, batchSize: 1, overwrite: true, includeMemory: true });
    const afterRange = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.ok(afterRange.personal_memory.length > 0, '范围填表后人物表必须真正落表，不能被末尾旧 manual_snapshot 清空');
    assert.strictEqual(afterRange.entity_memory.location.length, 3, '范围填表后实体表必须真正落表');
    assert.strictEqual(afterRange.ongoing_facts.length, 3, '范围填表后持续事实表必须真正落表');
    assert.ok(afterRange.character_arcs.length > 0, '范围填表后角色弧光必须真正落表');

    // 10C. 兼容嵌套 memory 对象与带括号中文实体类型（如 "organization (组织)"）
    const nestedRaw = JSON.stringify({
      memory: {
        personal_memory: [{ character_name: '苏明', memories: ['苏明发现了密道入口。'], time: '' }],
        entity_updates: [{ type: 'organization (组织)', name: '玄机阁', description: '隐秘情报组织', event: '启动暗哨', time: '' }],
        ongoing_facts: [{ subject: '苏明', category: '持有', detail: '持有玄机阁密令', keywords: ['密令'] }]
      },
      small_summary: '嵌套结构返回的详实纪要。'
    });
    const parsedNested = h.sandbox.MEMORY_ENGINE._test.parseResponse(nestedRaw, { memory: true, small: true });
    assert.strictEqual(parsedNested.personal.length, 1, '应展开 memories 数组并解析 character_name');
    assert.strictEqual(parsedNested.entities.organization.length, 1, '应解析带括号的中英文混合实体类型 organization (组织)');
    assert.strictEqual(parsedNested.factUpdates.length, 1, '应拍平嵌套 memory 对象并解析 detail 事实字段');
  }

  // 11. 统一逐层自动填表增量内核：一键追平与默认范围填表绝不删除跨楼旧节点，显式覆盖不误杀跨区间旧节点，且无 ID resolve 不通配误杀多条事实
  {
    const h = createHarness(makeChat(3)); // 0..6 (AI: 2, 4, 6)
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: false,
      summaryDelayFloors: 0
    });

    // 11A. 构造一个覆盖 1..4 的跨多楼旧记忆节点（含 7 条持续事实），纪要仅覆盖 1..2；执行一键追平补齐 3..4 和 5..6
    const stInit = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    const refs14 = h.sandbox.MEMORY_ENGINE_TIMELINE.captureRange(1, 4);
    const refs12 = h.sandbox.MEMORY_ENGINE_TIMELINE.captureRange(1, 2);
    stInit.timeline.nodes.push({
      id: 'memory_000001',
      kind: 'memory',
      startLayer: 1,
      endLayer: 4,
      sourceRefs: refs14,
      sourceDigest: h.sandbox.MEMORY_ENGINE_TIMELINE.digestRefs(refs14),
      personal: [{ name: ['林墨'], known_by: [], memory: '第2层确立的关键认知', time: '' }],
      entities: { organization: [], object: [], ability: [], location: [] },
      factUpdates: [1, 2, 3, 4, 5, 6, 7].map(i => ({
        action: 'upsert', id: '', category: '状态', subject: '林墨', fact: `第2层重要持续事实_${i}`, keywords: [`k${i}`]
      })),
      arcUpdates: [],
      memoryExtracted: true,
      status: 'valid'
    });
    stInit.event_memory.small_summaries.push({
      id: 'small_000001',
      startLayer: 1,
      endLayer: 2,
      content: '第1-2层已有阶段纪要。'.repeat(60),
      sourceRefs: refs12,
      sourceDigest: h.sandbox.MEMORY_ENGINE_TIMELINE.digestRefs(refs12),
      status: 'valid'
    });
    stInit.event_memory.small_summary_layer = 2;
    h.sandbox.MEMORY_ENGINE_DATA.saveState(h.sandbox.MEMORY_ENGINE.replayTimeline(stInit));
    assert.strictEqual(h.sandbox.MEMORY_ENGINE_DATA.loadState().ongoing_facts.length, 7);

    // 模拟第 4 层返回 1 条无 ID 空 fact 的 resolve（不应通配误杀）+ 1 条精准 resolve + 1 条新增
    const origApi11 = h.sandbox.WORLD_ENGINE_API.callApi;
    h.sandbox.WORLD_ENGINE_API.callApi = async prompt => {
      if (prompt.includes('楼层 3 至 4')) {
        return JSON.stringify({
          personal_memory: [{ name: ['林墨'], known_by: [], memory: '第4层新增认知', time: '' }],
          entity_updates: [],
          ongoing_fact_updates: [
            { action: 'resolve', id: '', category: '状态', subject: '林墨', fact: '' },
            { action: 'resolve', id: '', category: '状态', subject: '林墨', fact: '第2层重要持续事实_1' },
            { action: 'upsert', id: '', category: '状态', subject: '林墨', fact: '第4层新增持续事实', keywords: ['k8'] }
          ],
          character_arc_updates: [],
          small_summary: '第3-4层详实纪要。'.repeat(60)
        });
      }
      return origApi11(prompt);
    };

    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true, includeMemory: true });
    const afterCatchup = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.ok(
      afterCatchup.timeline.nodes.some(n => n.startLayer === 1 && n.endLayer === 4),
      '一键追平补填 3-4 时绝不能整块删除跨楼旧记忆节点 1-4'
    );
    assert.ok(
      afterCatchup.ongoing_facts.length >= 8,
      `第2层的7条事实必须全部保留并叠加第4/6层增量，实际=${afterCatchup.ongoing_facts.length}`
    );
    assert.strictEqual(
      afterCatchup.ongoing_facts.filter(f => f.status === 'resolved').length,
      1,
      '空 fact 的无 ID resolve 不得通配误杀多条事实，仅精准匹配的第1条应标为已完结'
    );

    // 11B. 显式指定范围覆盖 3..6 时，不得误删起点在范围外（1..4）的跨区间旧节点
    await h.sandbox.MEMORY_ENGINE.fillSummaryRange({
      startLayer: 3, endLayer: 6, batchSize: 1, overwrite: true, includeMemory: true
    });
    const afterOverwrite36 = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.ok(
      afterOverwrite36.timeline.nodes.some(n => n.startLayer === 1 && n.endLayer === 4),
      '覆盖 3-6 时不得误杀包含第 2 层（在范围外）的 1-4 旧节点'
    );
    assert.ok(
      afterOverwrite36.ongoing_facts.some(f => f.fact === '第2层重要持续事实_7'),
      '第 2 层的既有持续事实必须完好保留'
    );

    // 11C. 范围填表默认不覆盖（overwrite 缺省为 false）：已覆盖区间跳过，只纯增量补漏
    const h2 = createHarness(makeChat(2)); // 0..4 (AI: 2, 4)
    h2.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ smallSummaryEveryX: 1, skipCurrentFloorSummary: false, summaryDelayFloors: 0 });
    await h2.sandbox.MEMORY_ENGINE.fillSummaryRange({ startLayer: 0, endLayer: 2, batchSize: 1 });
    assert.strictEqual(h2.calls.length, 1);
    h2.calls.length = 0;
    const incRes = await h2.sandbox.MEMORY_ENGINE.fillSummaryRange({ startLayer: 0, endLayer: 4, batchSize: 1 });
    assert.strictEqual(incRes.completedBatches, 1, '默认范围填表（非覆盖）应跳过已填的第 2 层，仅纯增量补填第 4 层');
    assert.strictEqual(h2.calls.length, 1);
  }

  // 12. 复现并验证：(1) 末尾存在非空 manual_snapshot 或同源旧节点时，一键追平与非覆盖范围填表必须让人物/档案/实体/事实/弧光全部落表，不再只落纪要；
  //                 (2) 统一人物档案格式（基本信息 5 项 + 迄今详细经历）原地整合更新防膨胀、完整注入、删楼可精准回退。
  {
    const h = createHarness(makeChat(3)); // 0..6 (AI: 2, 4, 6)
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: false,
      summaryDelayFloors: 0
    });

    // 12A. 模拟用户在第 6 层手工编辑过表格（留下“非空” manual_snapshot，表里只有 1 条手工事实）+ 第 2 层已有旧同源节点（仅 1 条旧数据）但无纪要
    const st0 = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    const edited = plain(st0);
    edited.ongoing_facts = [{
      id: 'fact_000001', category: '设定', subject: '全局', fact: '用户手工添加的基础设定', keywords: ['设定'], status: 'active', startLayer: 0, updatedLayer: 6
    }];
    h.sandbox.MEMORY_ENGINE.commitManualState(edited, st0);
    // 再给 1-2 层放一个仅有 1 条旧人物记忆的同源节点（但没有纪要），确保一键追平请求 1-2 后不会因 memoryAlreadyStored 丢弃新数据
    const refs12 = h.sandbox.MEMORY_ENGINE_TIMELINE.captureRange(1, 2);
    edited.timeline.nodes.unshift({
      id: 'memory_000001',
      kind: 'memory',
      startLayer: 1,
      endLayer: 2,
      sourceRefs: refs12,
      sourceDigest: h.sandbox.MEMORY_ENGINE_TIMELINE.digestRefs(refs12),
      personal: [{ name: ['旧路人'], known_by: [], memory: '旧路人目睹了开端。', time: '' }],
      profileUpdates: [],
      entities: { organization: [], object: [], ability: [], location: [] },
      factUpdates: [],
      arcUpdates: [],
      memoryExtracted: true,
      status: 'valid'
    });
    h.sandbox.MEMORY_ENGINE_DATA.saveState(edited);

    let lastPromptAt4 = '';
    h.sandbox.WORLD_ENGINE_API.callApi = async prompt => {
      if (prompt.includes('楼层 1 至 2')) {
        return JSON.stringify({
          character_profile_updates: [{
            name: ['沈清秋', '清秋'],
            basic_info: {
              identity: '北境暗桩总管',
              appearance: '青衫玉簪，左腕有旧剑疤',
              personality: '沉稳克制、心思缜密',
              abilities: '精于情报布局与轻功',
              relations: '与主角初建利害合作'
            },
            experiences: '在青石渡秘密约见主角并交付青铜虎符，约定半月内不得示人以保全北境暗桩。'
          }],
          personal_memory: [],
          entity_updates: [{ type: 'organization', name: '北境暗桩', aliases: [], description: '隐秘情报网络', event: '启动青石渡联络线', time: '' }],
          ongoing_fact_updates: [{ action: 'upsert', id: '', category: '契约', subject: '青铜虎符', fact: '半月内不可示人', keywords: ['虎符'] }],
          character_arc_updates: [{ name: '沈清秋', current_stance: '审慎试探', arc_summary: '以虎符试探主角底线', relationship: '利害同盟', progress_pct: 30 }],
          small_summary: '第1-2层详实纪要。'.repeat(60)
        });
      }
      if (prompt.includes('楼层 3 至 4')) {
        lastPromptAt4 = prompt;
        return JSON.stringify({
          character_profile_updates: [{
            name: ['沈清秋'],
            basic_info: {
              identity: '',
              appearance: '',
              personality: '',
              abilities: '',
              relations: '与主角升级为生死托付盟友'
            },
            experiences: '在青石渡托付虎符后，于第四层城西茶楼识破黑水帮埋伏并掩护主角突围，正式向主角亮明暗桩总管真身。'
          }],
          personal_memory: [],
          entity_updates: [{ type: 'location', name: '城西茶楼', aliases: [], description: '暗桩接头据点', event: '爆发埋伏战', time: '' }],
          ongoing_fact_updates: [{ action: 'upsert', id: '', category: '状态', subject: '沈清秋', fact: '已公开暗桩总管身份并联合主角反查黑水帮', keywords: ['暗桩总管'] }],
          character_arc_updates: [{ name: '沈清秋', current_stance: '全力信任', arc_summary: '并肩突围后彻底托付信任', relationship: '生死盟友', progress_pct: 75 }],
          small_summary: '第3-4层详实纪要。'.repeat(60)
        });
      }
      return JSON.stringify({
        character_profile_updates: [],
        personal_memory: [],
        entity_updates: [],
        ongoing_fact_updates: [],
        character_arc_updates: [],
        small_summary: '第5-6层详实纪要。'.repeat(60)
      });
    };

    const cu = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true, includeMemory: true });
    assert.strictEqual(cu.completedBatches, 3);
    const stAfter = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(stAfter.event_memory.small_summaries.length, 3, '3 层纪要应全部落表');
    const shen = stAfter.personal_memory.find(p => p.names.includes('沈清秋'));
    assert.ok(shen, '即使末尾存在非空 manual_snapshot 且 1-2 已有旧同源节点，一键追平提取的新人物仍必须落表');
    assert.ok(stAfter.entity_memory.organization.some(o => o.name === '北境暗桩'), '组织实体必须落表');
    assert.ok(stAfter.entity_memory.location.some(l => l.name === '城西茶楼'), '地点实体必须落表');
    assert.ok(stAfter.ongoing_facts.some(f => f.fact.includes('用户手工添加的基础设定')), '用户原有非空手动编辑不得丢失');
    assert.ok(stAfter.ongoing_facts.some(f => f.fact.includes('半月内不可示人')), '第2层持续事实必须落表');
    assert.ok(stAfter.ongoing_facts.some(f => f.fact.includes('已公开暗桩总管身份')), '第4层持续事实必须落表');
    assert.ok(stAfter.character_arcs.some(a => a.names.includes('沈清秋') && a.progressPct === 75), '角色弧光必须落表');

    // 12B. 验证统一人物档案原地整合更新（未变字段保留，已变字段与迄今经历更新，不膨胀）+ 请求上下文携带已知档案
    assert.ok(lastPromptAt4.includes('基本信息：身份：北境暗桩总管'), '第 4 层请求应携带第 2 层已建立的统一人物基本信息');
    assert.ok(lastPromptAt4.includes('迄今经历：在青石渡秘密约见主角'), '第 4 层请求应携带已有迄今经历供模型整合');
    assert.strictEqual(shen.profile.basicInfo.identity, '北境暗桩总管', '未改动的基本信息字段必须保留');
    assert.strictEqual(shen.profile.basicInfo.appearance, '青衫玉簪，左腕有旧剑疤', '未改动的外貌字段必须保留');
    assert.strictEqual(shen.profile.basicInfo.relations, '与主角升级为生死托付盟友', '更新的关系字段应原地覆盖');
    assert.ok(shen.profile.experiences.includes('城西茶楼识破黑水帮埋伏'), '迄今经历应原地更新为整合后的详实履历');

    // 验证注入正文包含统一格式 [基本信息] 与 [迄今经历]
    h.getChat().push({ is_user: true, name: '用户', mes: '沈清秋现在怎么样了？', swipe_id: 0, extra: {} });
    const injected = h.sandbox.MEMORY_ENGINE.applyInjection();
    assert.ok(injected.includes('[基本信息] 身份：北境暗桩总管'), '注入正文应包含统一格式的人物基本信息');
    assert.ok(injected.includes('[迄今经历] 在青石渡托付虎符后'), '注入正文应包含整合后的迄今经历');

    // 验证删除第 4-6 层后，人物档案中的关系与迄今经历同步回退至第 2 层状态
    h.getChat().splice(3); // 保留 0..2
    await h.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: false });
    const stRolled = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    const shenRolled = stRolled.personal_memory.find(p => p.names.includes('沈清秋'));
    assert.ok(shenRolled, '回退到第 2 层后人物应保留');
    assert.strictEqual(shenRolled.profile.basicInfo.relations, '与主角初建利害合作', '删楼后人物基本信息应回退到第 2 层');
    assert.ok(!shenRolled.profile.experiences.includes('城西茶楼'), '删楼后人物迄今经历应回退，不含已删楼层剧透');

    // 12C. 验证中文别名与字符串格式 basic_info 的容错解析
    const cnProfileRaw = JSON.stringify({
      人物档案: [{
        姓名: '陆离',
        基本信息: '身份：江湖游医｜性格：外冷内热｜能力：金针渡穴',
        迄今经历: '孤身入青州疫区施药救人，意外查获毒源线索。'
      }],
      small_summary: '测试中文档案解析。'
    });
    const parsedCn = h.sandbox.MEMORY_ENGINE._test.parseResponse(cnProfileRaw, { memory: true, small: true });
    assert.strictEqual(parsedCn.profileUpdates.length, 1);
    assert.strictEqual(parsedCn.profileUpdates[0].basicInfo.identity, '江湖游医');
    assert.strictEqual(parsedCn.profileUpdates[0].basicInfo.personality, '外冷内热');
    assert.strictEqual(parsedCn.profileUpdates[0].basicInfo.abilities, '金针渡穴');
    assert.ok(parsedCn.profileUpdates[0].experiences.includes('孤身入青州疫区'));
  }

  console.log('memory summary control, rollback-refill, range & catch-up tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
