// 记忆引擎核心 7 表控制、Wave 追平、删改楼回退重填离线测试：node docs/memory-summary-control-test.js
// 覆盖：当前层不填表、重写与多楼删除自动回退重填、中间删楼前移对齐、手动指定范围填表、一键追平、纯 AI 楼层记录与跨模块联动。
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
        const rangeMatch = /楼层范围：楼层\s*(\d+)(?:\s*至\s*(\d+))?/.exec(prompt);
        const startL = rangeMatch ? Number(rangeMatch[1]) : 0;
        const endL = rangeMatch ? Number(rangeMatch[2] || rangeMatch[1]) : 0;
        const label = rangeMatch ? (startL === endL ? `L${endL}` : `L${startL}-${endL}`) : 'L?';
        const sheetsMatch = /本次待填表：\[([^\]]+)\]/.exec(prompt);
        const sheets = sheetsMatch ? sheetsMatch[1].split(',').map(s => s.trim()) : [];
        const snippet = (prompt.match(/【待提取对话】\n([\s\S]*?)(?:\n\n请严格按照|$)/)?.[1] || '').trim().slice(0, 80);
        const res = {};
        if (sheets.includes('global_state')) {
          res.global_state = { current_location: `地点_${label}`, cur_time: `第${endL}日 12:00` };
        }
        if (sheets.includes('protagonist_info')) {
          res.protagonist_info = { name: '主角', identity_text: '行者', current_condition: `推进至${label}`, location_name: `地点_${label}` };
        }
        if (sheets.includes('important_characters')) {
          const upsert = [{
            name: '角色', brief_intro: '同行角色', presence_status: '在场',
            location_name: `地点_${label}`, relation_text: `主角:关系_${label}`, past_experience: `经历更新至${label}`
          }];
          if (endL >= 11) {
            upsert.push({ name: `新人物_${label}`, brief_intro: '新登场角色', presence_status: '在场', past_experience: `登场于${label}` });
          }
          res.important_characters = { upsert, delete: [] };
        }
        if (sheets.includes('protagonist_skills')) {
          res.protagonist_skills = { upsert: [], delete: [] };
        }
        if (sheets.includes('inventory')) {
          res.inventory = { upsert: [{ item_name: `物件_${label}`, quantity: '1', category: '物品', description: `获得于${label}` }], delete: [] };
        }
        if (sheets.includes('quests_events')) {
          const del = endL === 12 ? ['任务_L2'] : [];
          res.quests_events = {
            upsert: [{ quest_name: `任务_${label}`, quest_type: '支线任务', issuer: '角色', detail_desc: `任务内容_${label}`, current_progress: '进行中' }],
            delete: del
          };
        }
        if (sheets.includes('chronicle')) {
          res.chronicle = {
            summary: `概览(${label})`,
            chronicle_text: `纪要(${label})：${snippet.replace(/\s+/g, ' ')}`,
            keywords: [label],
            entities: ['角色'],
            impact: label === 'L2' ? 'key' : 'normal'
          };
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

    // 新增第2轮（layers 3, 4），第1轮（AI 层 2）离开当前层成为稳态，应自动填表第2层且跳过第4层
    h.getChat().push(
      { is_user: true, name: '用户', mes: '第2轮用户发言' },
      { is_user: false, name: '角色', mes: '第2轮角色回复' }
    );
    await h.sandbox.MEMORY_ENGINE._test.autoExtract();
    assert.strictEqual(h.calls.length, 1, '新增下一轮后应只对稳态的前一轮填表');
    const st = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(st.tables.chronicle.length, 1);
    assert.strictEqual(st.tables.chronicle[0].startLayer, 2);
    assert.strictEqual(st.tables.chronicle[0].endLayer, 2);
    const currentAiId = h.sandbox.MEMORY_ENGINE_TIMELINE.ensureMessageId(h.getChat()[4]);
    assert.ok(!h.getHiddenIds().includes(currentAiId), '开启当前层不填表时最新楼层正文必须保持不隐藏');
  }

  // 2. 删除多楼（尾部部分删除、尾部全删、仅剩孤儿用户楼）自动回退并重新填表
  {
    const h = createHarness(makeChat(5)); // 0..10 (AI: 2, 4, 6, 8, 10)
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      catchUpBatchSize: 2,
      smallSummaryEveryX: 2,
      skipCurrentFloorSummary: false,
      summaryDelayFloors: 0,
      autoRefillOnHistoryChange: true
    });
    const cu = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(cu.completedBatches, 3);
    let state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.tables.chronicle.map(s => [s.startLayer, s.endLayer])),
      [[2, 4], [6, 8], [10, 10]]
    );

    // 2A. 尾部删掉 7..10 四层（剩下 0..6）：10 彻底回退删除，6-8 标 stale 后仅修复存活的第 6 层
    h.getChat().splice(7, 4);
    h.calls.length = 0;
    const prep = await h.sandbox.MEMORY_ENGINE.prepareHistoryForGeneration();
    assert.strictEqual(prep.invalidated, true);
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(state.tables.chronicle.length, 2, '彻底删除的第 10 层纪要应立即回退移除');
    assert.strictEqual(state.tables.chronicle[1].status, 'stale', '部分删除的 6-8 纪要应标为 stale 暂停注入');
    assert.ok(!h.getInjection().includes('L6-8'), 'stale 纪要不得继续注入');

    const rec = await h.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: true });
    assert.strictEqual(rec.repaired, true);
    assert.strictEqual(h.calls.length, 1, '应仅重填受影响且仍存活的第 6 层 AI');
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.tables.chronicle.map(s => [s.startLayer, s.endLayer, s.status])),
      [[2, 4, 'valid'], [6, 6, 'valid']]
    );
    assert.strictEqual(state.tableWatermarks.chronicle, 6, '重填后水位线应精确落在第 6 层');

    // 2B. 删除第 6 层（AI 回复），仅剩第 5 层孤儿用户消息：第 6 层纪要彻底回退删除，水位线退回第 4 层！
    h.getChat().splice(6, 1);
    h.calls.length = 0;
    await h.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: true });
    assert.strictEqual(h.calls.length, 0, '孤儿用户楼不应触发填表');
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(plain(state.tables.chronicle.map(s => [s.startLayer, s.endLayer])), [[2, 4]]);
    assert.strictEqual(state.tableWatermarks.chronicle, 4, '删除 AI 楼后水位线必须回退至第 4 层');
  }

  // 3. 中间删除多楼 + 后续楼层号前移自动对齐 + 剩余受影响楼层 Wave 合并修复
  {
    const h = createHarness(makeChat(5)); // 0..10
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ catchUpBatchSize: 2, smallSummaryEveryX: 2, skipCurrentFloorSummary: false });
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    // 删除中间第 3..6 楼（原第 7..10 楼前移变成新 3..6 楼）
    h.getChat().splice(3, 4);
    h.calls.length = 0;
    const rec = await h.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: true });
    assert.strictEqual(rec.repaired, true);
    assert.strictEqual(h.calls.length, 1, '完好前移的第 6 层不重算，受影响的第 2 层与第 4 层合并 1 波修复');
    const state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.tables.chronicle.map(s => [s.startLayer, s.endLayer, s.status])),
      [[2, 4, 'valid'], [6, 6, 'valid']]
    );
  }

  // 4. 尾部删楼落入“当前层不填表”延迟区：回退但不提前重填当前层
  {
    const h = createHarness(makeChat(4)); // 0..8
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      catchUpBatchSize: 2,
      smallSummaryEveryX: 2,
      skipCurrentFloorSummary: true,
      summaryDelayFloors: 0
    });
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: false });
    let state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(plain(state.tables.chronicle.map(s => [s.startLayer, s.endLayer])), [[2, 4], [6, 6]]);
    // 删掉 6..8（剩下 0..5，最新 AI 层为 4，稳态上限 stableEnd=2）并修改第 4 层
    h.getChat().splice(6, 3);
    h.getChat()[4].mes = '修改后的第2轮角色回复';
    h.calls.length = 0;
    await h.sandbox.MEMORY_ENGINE.reconcileHistory({ respectDelay: true, refillUncovered: true });
    assert.strictEqual(h.calls.length, 1, '跨延迟区的旧批次应回退后仅重填稳态前置第 2 层');
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.tables.chronicle.map(s => [s.startLayer, s.endLayer])),
      [[2, 2]],
      '当前最新第 4 层必须保持未填表状态'
    );
    // 再删掉 3..5 并修改第 2 层（全聊天仅剩第 2 层这一个当前 AI 层，stableEnd=-1），应彻底回退且 0 API 调用
    h.getChat().splice(3, 3);
    h.getChat()[2].mes = '重写后的第1轮回复';
    h.calls.length = 0;
    await h.sandbox.MEMORY_ENGINE.reconcileHistory({ respectDelay: true, refillUncovered: true });
    assert.strictEqual(h.calls.length, 0, '仅剩当前延迟楼层时应回退清理而不提前重填');
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(state.tables.chronicle.length, 0);
  }

  // 5. 重写（MESSAGE_EDITED）事件触发立即撤旧与 Trailing 防抖重填
  {
    const h = createHarness(makeChat(3)); // 0..6
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      catchUpBatchSize: 1,
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: false,
      autoRefillOnHistoryChange: true
    });
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    h.sandbox.MEMORY_ENGINE.init();
    h.calls.length = 0;
    h.getChat()[2].mes = '重写后的全新剧情：角色决定前往北境。';
    h.emit('MESSAGE_EDITED');
    // 同步撤旧立即可见（0ms 脏读窗口）
    assert.ok(!h.getInjection().includes('第1轮角色回复'), '编辑重写后应立即撤下旧纪要注入');
    await new Promise(r => setTimeout(r, 1500));
    assert.strictEqual(h.calls.length, 1, '重写防抖结束后应自动重填被编辑的楼层');
    const state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.ok(state.tables.chronicle[0].chronicle_text.includes('前往北境'), '重建后的纪要应反映重写后的新正文');
  }

  // 6. 手动指定范围填表（覆盖 / 不覆盖 / 保留世界联动纪要）+ 一键追平（含/不含当前层）
  {
    const h = createHarness(makeChat(5)); // 0..10
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      catchUpBatchSize: 1,
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: true,
      summaryDelayFloors: 0
    });
    // 验证弱联动：ingestWorldEvolution 不写入新记录；同时预置一条旧存档遗留的 world_engine 纪要，确保范围覆盖填表不误删它
    h.calls.length = 0;
    const linkRes = await h.sandbox.MEMORY_ENGINE.ingestWorldEvolution({
      lightweight: true,
      layer: 4,
      worldDigest: '世界线变动：北方港口封航。',
      worldCommitId: 'wc_4',
      force: true
    });
    assert.strictEqual(linkRes.skipped, true, '弱联动模式不得再往记忆表写入世界纪要');
    assert.strictEqual(h.calls.length, 0, '弱联动绝不消耗记忆 LLM API');
    const seededWorld = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    seededWorld.tables.chronicle.push({
      id: 'small_legacy_world', rowId: 1, code_index: 'AM0001', startLayer: 4, endLayer: 4,
      summary: '旧世界同步纪要', chronicle_text: '世界线变动：北方港口封航。',
      source: 'world_engine', sourceKey: 'summary-ctrl-chat:4', worldCommitId: 'wc_4', status: 'valid', revision: 1
    });
    h.sandbox.MEMORY_ENGINE_DATA.saveState(seededWorld);

    const rangeRes = await h.sandbox.MEMORY_ENGINE.fillSummaryRange({
      startLayer: 3, endLayer: 6, batchSize: 1, overwrite: true
    });
    assert.strictEqual(rangeRes.completedBatches, 2, '楼层 3-6 共 2 个 AI 轮次应分 2 批填表');
    let state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.ok(
      state.tables.chronicle.some(s => s.source === 'world_engine' && s.chronicle_text.includes('北方港口封航')),
      '手动范围填表覆盖对话纪要时，不得误删世界联动同步纪要'
    );
    assert.deepStrictEqual(
      plain(state.tables.chronicle.filter(s => s.source !== 'world_engine').map(s => [s.startLayer, s.endLayer])),
      [[4, 4], [6, 6]]
    );

    h.calls.length = 0;
    const gapRes = await h.sandbox.MEMORY_ENGINE.fillSummaryRange({
      startLayer: 1, endLayer: 6, batchSize: 1, overwrite: false
    });
    assert.strictEqual(gapRes.completedBatches, 1, '非覆盖范围填表应只补未覆盖的第 2 层');
    assert.strictEqual(h.calls.length, 1);

    h.calls.length = 0;
    const catchDelay = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: false });
    assert.strictEqual(catchDelay.completedBatches, 1);
    assert.strictEqual(catchDelay.targetEndLayer, 8, '遵守当前层不填表时追平目标应停在第 8 层');
    assert.strictEqual(h.calls.length, 1);

    h.calls.length = 0;
    const catchAll = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(catchAll.completedBatches, 1);
    assert.strictEqual(catchAll.targetEndLayer, 10, '勾选含当前层后应追平至第 10 层');
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.tables.chronicle.filter(s => s.source !== 'world_engine').map(s => [s.startLayer, s.endLayer])),
      [[2, 2], [4, 4], [6, 6], [8, 8], [10, 10]]
    );

    const bridgeRef = h.sandbox.STORY_ENGINE_BRIDGE.buildOutlineReferenceContext({ plan: { nodes: [] } });
    assert.ok(bridgeRef.includes('近期事件纪要'), '大纲参考背景应包含近期事件纪要');
    assert.ok(!bridgeRef.includes('最新总述'), '去除总述后大纲参考背景不得再出现最新总述');
  }

  // 7. 进入已有 12 楼旧卡：init 记基线不自动回填旧史，autoExtract 仅填 14 层，一键追平补齐 2..12 并按时间序重放
  {
    const h = createHarness(makeChat(6)); // 0..12
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      catchUpBatchSize: 1,
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: false,
      summaryDelayFloors: 0,
      vectorEnabled: true,
      vectorAutoMaintain: true,
      embeddingApiUrl: 'https://mock.embedding/v1/embeddings',
      embeddingModel: 'text-embedding-3-small'
    });
    h.sandbox.MEMORY_ENGINE.init();
    assert.strictEqual(h.sandbox.MEMORY_ENGINE_DATA.loadState().autoBaselineLayer, 12);

    h.getChat().push(
      { is_user: true, name: '用户', mes: '第7轮用户发言：我们去第7层区域。', swipe_id: 0, extra: {} },
      { is_user: false, name: '角色', mes: '第7轮角色回复：已抵达第7层区域。<small>第7日</small>', swipe_id: 0, extra: {} }
    );
    await h.sandbox.MEMORY_ENGINE._test.autoExtract();
    let state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.tables.chronicle.map(s => [s.startLayer, s.endLayer])),
      [[14, 14]],
      '首次进入旧卡后自动填表仅填新产生的第 14 层'
    );

    const covBefore = h.sandbox.MEMORY_ENGINE.getSummaryCoverageStatus();
    assert.deepStrictEqual(plain(covBefore.uncoveredCombinedAiLayers), [2, 4, 6, 8, 10, 12]);

    const cu = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(cu.completedBatches, 6, '一键追平应补齐前 6 个缺失 AI 层');
    await h.sandbox.MEMORY_ENGINE_VECTOR.maintainVectors();
    state = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.deepStrictEqual(
      plain(state.tables.chronicle.map(s => [s.startLayer, s.endLayer])),
      [[2, 2], [4, 4], [6, 6], [8, 8], [10, 10], [12, 12], [14, 14]],
      '追平后纪要必须按 AI 实际楼层顺序完整呈现'
    );
    assert.deepStrictEqual(
      plain(state.timeline.nodes.map(n => [n.startLayer, n.endLayer])),
      [[2, 2], [4, 4], [6, 6], [8, 8], [10, 10], [12, 12], [14, 14]],
      '追平后时间线节点必须按时间序排列重放'
    );
    assert.strictEqual(state.tables.global_state[0].current_location, '地点_L14', '重放后最终全局地点应为最新第 14 层而非被旧楼覆盖');
    assert.strictEqual(state.round, 7);
  }

  // 8. 7 个 AI 层全表填齐后删除第 6、7 两个 AI 层：7 张表、水位线与向量库必须全部精确回退至第 1–5 层状态
  {
    const h = createHarness(makeChat(5)); // 0..10
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      catchUpBatchSize: 1,
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: false,
      summaryDelayFloors: 0,
      vectorEnabled: true,
      vectorAutoMaintain: true,
      embeddingApiUrl: 'https://mock.embedding/v1/embeddings',
      embeddingModel: 'text-embedding-3-small'
    });
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    await h.sandbox.MEMORY_ENGINE_VECTOR.maintainVectors();

    const stateAt5 = plain(h.sandbox.MEMORY_ENGINE_DATA.loadState());
    const vectorsAt5 = plain(h.sandbox.MEMORY_ENGINE_VECTOR.loadVectorStore().records);
    assert.strictEqual(stateAt5.tables.chronicle.length, 5);
    assert.strictEqual(stateAt5.tables.important_characters.length, 1);
    assert.strictEqual(stateAt5.tables.inventory.length, 5);
    assert.strictEqual(stateAt5.tables.quests_events.length, 5);
    assert.ok(stateAt5.tables.quests_events.some(q => q.quest_name === '任务_L2'));
    assert.strictEqual(stateAt5.tableWatermarks.chronicle, 10);

    h.getChat().push(
      { is_user: true, name: '用户', mes: '第6轮用户发言：我们去第6层区域。', swipe_id: 0, extra: {} },
      { is_user: false, name: '角色', mes: '第6轮角色回复：已抵达第6层区域。<small>第6日</small>', swipe_id: 0, extra: {} },
      { is_user: true, name: '用户', mes: '第7轮用户发言：我们去第7层区域。', swipe_id: 0, extra: {} },
      { is_user: false, name: '角色', mes: '第7轮角色回复：已抵达第7层区域。<small>第7日</small>', swipe_id: 0, extra: {} }
    );
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    await h.sandbox.MEMORY_ENGINE_VECTOR.maintainVectors();

    const stateAt7 = plain(h.sandbox.MEMORY_ENGINE_DATA.loadState());
    assert.strictEqual(stateAt7.tables.chronicle.length, 7);
    assert.strictEqual(stateAt7.tables.important_characters.length, 3, '第 6、7 层新增 2 名新人物');
    assert.ok(!stateAt7.tables.quests_events.some(q => q.quest_name === '任务_L2'), '第 6 层（L12）删掉了任务_L2');

    // 先删 12..14（留下第 11 层孤儿用户消息），再删 11
    h.getChat().splice(12, 3);
    h.calls.length = 0;
    await h.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: true });
    assert.strictEqual(h.calls.length, 0, '删楼回退不应发起多余 API 请求');
    h.getChat().splice(11, 1);
    await h.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: true });
    assert.strictEqual(h.calls.length, 0);

    const rolledState = plain(h.sandbox.MEMORY_ENGINE_DATA.loadState());
    const rolledVectors = plain(h.sandbox.MEMORY_ENGINE_VECTOR.loadVectorStore().records);
    assert.deepStrictEqual(rolledState.tables, stateAt5.tables, '全部 7 张表（含恢复第 6 层删掉的任务_L2）必须精确回退至第 1–5 层状态');
    assert.deepStrictEqual(rolledState.tableWatermarks, stateAt5.tableWatermarks, '7 表独立水位线必须精确回退至第 10 层');
    assert.strictEqual(rolledState.round, stateAt5.round);

    const stripUpdatedAt = records => Object.fromEntries(
      Object.entries(records).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { textHash: v.textHash, vector: v.vector }])
    );
    assert.deepStrictEqual(stripUpdatedAt(rolledVectors), stripUpdatedAt(vectorsAt5), '向量库必须同步精确回退至第 1–5 层状态');
  }

  // 9. 单层纪要最低 500 字设定 + 手动编辑 manual_snapshot 后一键追平与范围填表正常落表
  {
    const h = createHarness(makeChat(3)); // 0..6
    assert.strictEqual(h.sandbox.MEMORY_ENGINE_SETTINGS.getSettings().smallSummaryMinChars, 500, '默认单层纪要最低字数应为 500');
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ catchUpBatchSize: 1, smallSummaryEveryX: 1, skipCurrentFloorSummary: false });

    // 用户先手工添加 1 条任务（产生末尾 manual_snapshot）
    const s0 = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    const edited = plain(s0);
    edited.tables.quests_events = [{ rowId: 1, quest_name: '手动全局铁律', quest_type: '主线任务', issuer: '系统', detail_desc: '不可遗忘的手动设定', current_progress: '生效中' }];
    h.sandbox.MEMORY_ENGINE.commitManualState(edited);

    const cu = await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(cu.completedBatches, 3);
    assert.ok(h.calls[0].includes('最低不少于 500 字'), 'Prompt 必须携带单层最低 500 字纪要要求');
    const stAfter = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(stAfter.tables.chronicle.length, 3);
    assert.ok(stAfter.tables.quests_events.some(q => q.quest_name === '手动全局铁律'), '用户之前的手动条目必须保留');
    assert.ok(stAfter.tables.quests_events.length >= 4, '新提取的 3 批任务必须全部落表');
    assert.strictEqual(stAfter.tables.inventory.length, 3, '新提取的 3 批物品必须全部落表');
  }

  // 10. 覆盖范围 3..6 不误杀跨区间 2..4 旧节点，且默认范围填表（overwrite 缺省 false）只纯增量补漏
  {
    const h = createHarness(makeChat(3)); // 0..6 (AI: 2, 4, 6)
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ catchUpBatchSize: 1, smallSummaryEveryX: 1, skipCurrentFloorSummary: false });
    const stInit = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    const refs14 = h.sandbox.MEMORY_ENGINE_TIMELINE.captureRange(1, 4);
    stInit.timeline.nodes.push({
      id: 'memory_000001', kind: 'table_ops', startLayer: 2, endLayer: 4,
      sourceRefs: refs14, sourceDigest: h.sandbox.MEMORY_ENGINE_TIMELINE.digestRefs(refs14),
      targetSheets: ['quests_events'],
      tableOps: [{ sheet: 'quests_events', op: 'upsert', key: '跨区旧任务', data: { quest_name: '跨区旧任务', detail_desc: '2-4跨区保留' } }],
      status: 'valid'
    });
    h.sandbox.MEMORY_ENGINE_DATA.saveState(h.sandbox.MEMORY_ENGINE.replayTimeline(stInit));

    await h.sandbox.MEMORY_ENGINE.fillSummaryRange({ startLayer: 3, endLayer: 6, batchSize: 1, overwrite: true });
    const afterOverwrite = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.ok(afterOverwrite.timeline.nodes.some(n => n.startLayer === 2 && n.endLayer === 4), '覆盖 3-6 时不得误杀包含范围外第 2 层的 2-4 旧节点');
    assert.ok(afterOverwrite.tables.quests_events.some(q => q.quest_name === '跨区旧任务'), '跨区旧任务必须完好保留');

    const h2 = createHarness(makeChat(2));
    h2.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ catchUpBatchSize: 1, smallSummaryEveryX: 1, skipCurrentFloorSummary: false });
    await h2.sandbox.MEMORY_ENGINE.fillSummaryRange({ startLayer: 0, endLayer: 2, batchSize: 1 });
    assert.strictEqual(h2.calls.length, 1);
    h2.calls.length = 0;
    const incRes = await h2.sandbox.MEMORY_ENGINE.fillSummaryRange({ startLayer: 0, endLayer: 4, batchSize: 1 });
    assert.strictEqual(incRes.completedBatches, 1, '默认范围填表（非覆盖）应跳过已填的第 2 层，仅补填第 4 层');
    assert.strictEqual(h2.calls.length, 1);
  }

  // 11. 楼层记录与统计仅看 AI 实际楼层号与 AI 总层数（例如第 13 层为 AI 回复时直接记为 13 层，绝不写成 12-13 或 13-13）
  {
    const customChat = [{ is_user: false, name: '角色', mes: 'AI开场白', swipe_id: 0, extra: {} }];
    for (let i = 1; i <= 5; i++) {
      customChat.push(
        { is_user: true, name: '用户', mes: `第${i}轮用户发言`, swipe_id: 0, extra: {} },
        { is_user: false, name: '角色', mes: `第${i}轮角色回复`, swipe_id: 0, extra: {} }
      );
    }
    customChat.push(
      { is_user: true, name: '用户', mes: '补充前置动作（11层）', swipe_id: 0, extra: {} },
      { is_user: true, name: '用户', mes: '正式提问（12层）', swipe_id: 0, extra: {} },
      { is_user: false, name: '角色', mes: '第13层AI正式回复正文。', swipe_id: 0, extra: {} }
    );
    assert.strictEqual(customChat.length - 1, 13);

    const h = createHarness(customChat);
    h.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      evolveMode: 'auto',
      catchUpBatchSize: 1,
      smallSummaryEveryX: 1,
      skipCurrentFloorSummary: false,
      summaryDelayFloors: 0
    });
    await h.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    const st13 = h.sandbox.MEMORY_ENGINE_DATA.loadState();
    const lastSum = st13.tables.chronicle.at(-1);
    const lastNode = st13.timeline.nodes.at(-1);
    assert.strictEqual(lastSum.startLayer, 13, '第 13 层 AI 回复的纪要 startLayer 必须直接为 13');
    assert.strictEqual(lastSum.endLayer, 13, '第 13 层 AI 回复的纪要 endLayer 必须为 13');
    assert.strictEqual(lastNode.startLayer, 13, '第 13 层时间线节点 startLayer 必须直接为 13');
    assert.strictEqual(lastNode.endLayer, 13, '第 13 层时间线节点 endLayer 必须为 13');

    assert.ok(h.calls.at(-1).includes('正式提问（12层）') && h.calls.at(-1).includes('第13层AI正式回复正文'), '提取上下文仍应包含紧邻用户输入');

    const inj13 = h.getInjection();
    assert.ok(inj13.includes('楼层 13'), '注入正文应显示楼层 13');
    assert.ok(!inj13.includes('12-13') && !inj13.includes('13-13'), '注入正文不得出现 12-13 或 13-13');
    const bridge13 = h.sandbox.STORY_ENGINE_BRIDGE.buildOutlineReferenceContext({ plan: { nodes: [] } });
    assert.ok(bridge13.includes('[楼层13]') && !bridge13.includes('13-13'), '桥接参考应显示 [楼层13]');

    h.getChat().push({ is_user: true, name: '用户', mes: '第14层刚发出的未回复消息', swipe_id: 0, extra: {} });
    const cov14 = h.sandbox.MEMORY_ENGINE.getSummaryCoverageStatus();
    assert.strictEqual(cov14.latestAiLayer, 13, '末尾存在未回复用户层时，最新 AI 实际楼层仍须为 13');
    assert.strictEqual(cov14.totalAiCount, 6, 'AI 实际总层数只计 AI 层（2,4,6,8,10,13 共 6 层）');
  }

  console.log('memory summary control, rollback-refill, range & catch-up tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
