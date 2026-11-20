// 全量生产级多角度端到端仿真测试（覆盖世界引擎 + 记忆引擎 + 剧情大纲 + 协同桥 + 向量 + 缓存同步 + 真实脏 JSON）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const plain = v => JSON.parse(JSON.stringify(v));

function createProductionSandbox(initialChat = []) {
  const storeMap = new Map();
  let syncSink = null;
  const listeners = new Map();
  const extensionPrompts = {};
  let apiHandler = null;
  let fetchHandler = null;

  const ctx = {
    chatId: 'prod-sim-chat-1',
    name1: '林墨',
    name2: '旁白',
    chat: initialChat,
    chatMetadata: {},
    extensionPrompts,
    event_types: {
      CHAT_LOADED: 'chat_loaded',
      CHAT_CHANGED: 'chat_id_changed',
      MESSAGE_DELETED: 'message_deleted',
      MESSAGE_EDITED: 'message_edited',
      MESSAGE_SWIPED: 'message_swiped',
      GENERATION_STARTED: 'generation_started',
      GENERATION_ENDED: 'generation_ended',
      GENERATION_STOPPED: 'generation_stopped',
      MESSAGE_RECEIVED: 'message_received'
    },
    eventSource: {
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      },
      async emitAsync(name, ...args) {
        for (const fn of (listeners.get(name) || [])) {
          await fn(...args);
        }
      }
    },
    setExtensionPrompt(key, value, position, depth, scan, role) {
      extensionPrompts[key] = { value, position, depth, scan, role };
    },
    updateChatMetadata(patch) { Object.assign(this.chatMetadata, patch); },
    saveMetadataDebounced() {},
    saveChatConditional() { return Promise.resolve(); },
    executeSlashCommandsWithOptions: async () => {}
  };

  const sandbox = {
    console: { log() {}, warn() {}, error(...a) { sandbox._errors.push(a.map(String).join(' ')); } },
    _errors: [],
    Math,
    Date,
    JSON,
    Promise,
    Set,
    Map,
    Array,
    Object,
    Number,
    String,
    Boolean,
    RegExp,
    Error,
    TypeError,
    SyntaxError,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }),
      head: { appendChild() {} },
      body: { appendChild() {} },
      readyState: 'complete',
      addEventListener() {}
    },
    fetch: async (url, opts) => {
      if (fetchHandler) return fetchHandler(url, opts);
      throw new Error('unexpected fetch: ' + url);
    },
    SillyTavern: { getContext: () => ctx },
    WORLD_ENGINE_STORE: {
      hydrate: async () => {},
      flush: async () => {},
      getItem: k => (storeMap.has(k) ? storeMap.get(k) : null),
      setItem(k, v) {
        storeMap.set(k, String(v));
        syncSink?.onWrite?.(k, String(v));
      },
      removeItem(k) {
        storeMap.delete(k);
        syncSink?.onRemove?.(k);
      },
      keys: () => Array.from(storeMap.keys()),
      setSyncSink(s) { syncSink = s; },
      beginTransaction() { this._tx = new Map(storeMap); },
      commitTransaction() { this._tx = null; return Promise.resolve(); },
      rollbackTransaction() {
        if (this._tx) {
          storeMap.clear();
          for (const [k, v] of this._tx) storeMap.set(k, v);
          this._tx = null;
        }
      },
      isTransactionActive() { return Boolean(this._tx); }
    },
    WORLD_ENGINE_UI: {
      setEvolvingUI() {},
      setMemoryEvolvingUI() {},
      refresh() {},
      buildPanel() {},
      buildInputButton() {}
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const modules = [
    'world-engine-core.js',
    'world-engine-api.js',
    'world-engine-worldbook.js',
    'world-engine-chatcache.js',
    'world-engine-inject-inspector.js',
    'story-engine-bridge.js',
    'memory-engine-timeline.js',
    'memory-engine-vector.js',
    'world-engine-preset.js',
    'world-engine-rules-loader.js',
    'world-engine-ledger.js',
    'world-engine-evolution.js',
    'world-engine-inject.js',
    'memory-engine-settings.js',
    'memory-engine-data.js',
    'memory-engine-prompt.js',
    'memory-engine-small-summary-prompt.js',
    'memory-engine.js',
    'outline-engine-settings.js',
    'outline-engine-data.js',
    'outline-engine-scheduler.js',
    'outline-engine-prompt.js',
    'story-engine-projection.js',
    'story-engine-history.js',
    'outline-engine-cache.js',
    'outline-engine.js'
  ];

  for (const mod of modules) {
    vm.runInContext(read(mod), sandbox, { filename: mod });
  }

  // Override callApi cleanly for deterministic multi-angle simulation while keeping real parseJSON & request logs
  const origApi = sandbox.WORLD_ENGINE_API;
  const origCallApi = origApi.callApi;
  origApi.callApi = async function(prompt, maxTokens, temp, signal, customSettings) {
    if (apiHandler) return apiHandler(prompt, { maxTokens, temp, signal, customSettings });
    return origCallApi.call(this, prompt, maxTokens, temp, signal, customSettings);
  };
  sandbox.WORLD_ENGINE_RULES.getAllRulesText = () => '【测试规则】';

  return {
    sandbox,
    ctx,
    storeMap,
    extensionPrompts,
    setApiHandler(fn) { apiHandler = fn; },
    setFetchHandler(fn) { fetchHandler = fn; },
    pushRound(userMes, aiMes) {
      ctx.chat.push({ is_user: true, name: ctx.name1, mes: userMes, swipe_id: 0, extra: {} });
      ctx.chat.push({ is_user: false, name: ctx.name2, mes: aiMes, swipe_id: 0, extra: {} });
      return ctx.chat.length - 1;
    }
  };
}

function makeOpeningChat(rounds = 0) {
  const chat = [{ is_user: false, name: '旁白', mes: '序章：大雪封山，青石渡灯火微明。', swipe_id: 0, extra: {} }];
  for (let i = 1; i <= rounds; i++) {
    chat.push({ is_user: true, name: '林墨', mes: `第${i}轮行动：林墨深入渡口探查线索并交涉。`, swipe_id: 0, extra: {} });
    chat.push({ is_user: false, name: '旁白', mes: `第${i}轮回应：风雪渐急，局势出现新的变化。<small>第${i}日</small>`, swipe_id: 0, extra: {} });
  }
  return chat;
}

async function runAll() {
  // ═══════════════════════════════════════════════════════════════════════════
  // 场景 1：真实大模型脏输出压力测试（<think> 块 + 未转义字面换行 + // 注释 + 尾随逗号）
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const env = createProductionSandbox(makeOpeningChat(1));
    await env.sandbox.WORLD_ENGINE_CHATCACHE.init();
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ catchUpBatchSize: 1, smallSummaryEveryX: 1, smallSummaryMinChars: 500 });

    // 故意在 500+ 字字符串内部放入真实未转义换行符、尾随逗号、单行注释、<think> 花括号干扰
    const messyRaw = `<think>让我先思考人物：{沈清秋, 林墨}，准备输出 JSON</think>
\`\`\`json
{
  // 全局与主角状态更新
  "global_state": {
    "current_location": "青石渡",
    "current_minor_region": "江南渡口",
    "current_major_region": "大周南境",
    "cur_time": "第1日 22:00",
  },
  "protagonist_info": {
    "name": "林墨",
    "identity_text": "江湖密探",
    "current_condition": "深夜潜行略带寒意",
    "location_name": "青石渡",
  },
  "important_characters": {
    "upsert": [
      {
        "name": "沈清秋",
        "brief_intro": "北境暗桩总管",
        "appearance": "青衫玉簪，眉目清冷",
        "outfit_text": "青衫长袍，腰悬佩剑",
        "location_name": "青石渡",
        "presence_status": "在场",
        "relation_text": "林墨:初次结盟",
        "past_experience": "早年执掌北境暗桩情报网。
今日在青石渡秘密会见林墨，将关乎十二处暗桩生死的青铜虎符托付于他，并定下半月之约。",
      },
    ],
    "delete": [],
  },
  "inventory": {
    "upsert": [
      {
        "item_name": "青铜虎符",
        "quantity": "1",
        "category": "关键物品",
        "description": "调动北境十二暗桩的唯一铁证信物",
      },
    ],
    "delete": [],
  },
  "quests_events": {
    "upsert": [
      {
        "quest_name": "半月虎符密约",
        "quest_type": "主线任务",
        "issuer": "沈清秋",
        "detail_desc": "半月内不可示人，否则北境暗桩全毁",
        "current_progress": "进行中",
      },
    ],
    "delete": [],
  },
  "chronicle": {
    "code_index": "AM0001",
    "summary": "青石渡密会托付青铜虎符",
    "chronicle_text": "${'青石渡风雪之夜，沈清秋携青铜虎符密会林墨，详述北境暗桩危局并定下半月保密之约。\n双方就南城分舵异动交换情报，敲定次日分头核查漕运账册的行动方案。'.repeat(8)}",
    "key_dialogue": "沈清秋：“半月内绝不可示人。”",
    "keywords": ["青铜虎符", "青石渡", "漕运账册",],
    "entities": ["林墨", "沈清秋", "青铜虎符",],
    "impact": "key",
  },
}
\`\`\``;

    env.setApiHandler(async () => messyRaw);
    const cu = await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(cu.completedBatches, 1);
    const st = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(st.tables.global_state[0].current_location, '青石渡');
    assert.strictEqual(st.tables.protagonist_info[0].name, '林墨');
    const shen = st.tables.important_characters.find(p => p.name === '沈清秋');
    assert.strictEqual(shen.brief_intro, '北境暗桩总管');
    assert.ok(shen.past_experience.includes('青铜虎符托付于他'), '含字面换行的长经历应被无损修复解析');
    assert.strictEqual(st.tables.inventory.length, 1);
    assert.strictEqual(st.tables.quests_events.length, 1);
    assert.strictEqual(st.tables.chronicle.length, 1);
    assert.ok(st.tables.chronicle[0].chronicle_text.length >= 500, '含未转义换行的 500+ 字纪要应完整落表');
    console.log('✓ 场景 1 通过：真实脏 JSON（<think> + 字符串未转义换行 + 注释 + 尾随逗号）核心 7 表无损落表');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 场景 2：20 轮长对话重要角色表防膨胀压力测试（按主键原地精炼合并，绝不重复建行）
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const env = createProductionSandbox(makeOpeningChat(20));
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ catchUpBatchSize: 1, smallSummaryEveryX: 1, smallSummaryMinChars: 500 });

    let roundCounter = 0;
    env.setApiHandler(async () => {
      roundCounter++;
      const isMajorTurn = roundCounter % 4 === 0 || roundCounter === 1;
      return JSON.stringify({
        important_characters: isMajorTurn ? {
          upsert: [{
            name: '沈清秋',
            brief_intro: roundCounter >= 12 ? '北境暗桩总管（已亮明身份）' : '北境暗桩总管',
            appearance: roundCounter === 1 ? '青衫玉簪' : '',
            outfit_text: roundCounter === 8 ? '玄色斗篷' : '',
            presence_status: '在场',
            relation_text: `林墨:第${roundCounter}轮同盟深化`,
            past_experience: `截至第${roundCounter}轮的关键经历整合：历经青石渡托付虎符、南城查账破局与茶楼突围。`
          }],
          delete: []
        } : { upsert: [], delete: [] },
        chronicle: {
          summary: `第${roundCounter}轮推进`,
          chronicle_text: `第${roundCounter}轮阶段纪要详实记录。`.repeat(45)
        }
      });
    });

    await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    const st = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    const shen = st.tables.important_characters.find(p => p.name === '沈清秋');
    assert.strictEqual(st.tables.important_characters.length, 1, '20 轮后同一角色绝不重复建行');
    assert.strictEqual(shen.appearance, '青衫玉簪', '第 1 轮写入且后续返回空串的外貌字段应完好保留');
    assert.strictEqual(shen.outfit_text, '玄色斗篷', '第 8 轮增量补充的穿着字段应保留');
    assert.strictEqual(shen.brief_intro, '北境暗桩总管（已亮明身份）');
    assert.strictEqual(shen.relation_text, '林墨:第20轮同盟深化');
    assert.ok(shen.past_experience.startsWith('截至第20轮的关键经历整合'), '过往经历为原地精炼更新而非无限拼接');
    assert.strictEqual(st.tables.chronicle.length, 20, '20 轮纪要全部连续编号落表');
    assert.strictEqual(st.tables.chronicle[19].code_index, 'AM0020');
    console.log('✓ 场景 2 通过：20 轮长对话重要角色表原地精炼更新不膨胀，纪要连续编号 AM0001~AM0020');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 场景 3：生产陷阱联合回归（手动快照 + 跨表缺口 Wave 智能合流 + 带错回灌纠错重试 + 范围填表）
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const env = createProductionSandbox(makeOpeningChat(4)); // 0..8 (AI: 2, 4, 6, 8)
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ catchUpBatchSize: 1, smallSummaryEveryX: 1, smallSummaryMinChars: 500, tableFillMaxRetries: 2 });

    // 预埋陷阱 A：第 2 层仅填了 chronicle（缺少其余 6 张表），模拟分表水位参差不齐
    const s0 = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    const refs12 = env.sandbox.MEMORY_ENGINE_TIMELINE.captureRange(1, 2);
    s0.tables.chronicle.push({
      id: 'small_000001', rowId: 1, code_index: 'AM0001', startLayer: 2, endLayer: 2,
      summary: '旧2层纪要', chronicle_text: '旧1-2纪要。'.repeat(60),
      sourceRefs: refs12, sourceDigest: env.sandbox.MEMORY_ENGINE_TIMELINE.digestRefs(refs12), status: 'valid'
    });
    // 预埋陷阱 B：用户在第 8 层手动加过 1 条设定任务（产生非空 manual_snapshot）
    const sEdited = plain(s0);
    sEdited.tables.quests_events = [{
      rowId: 1, quest_name: '手动全局铁律', quest_type: '主线任务', issuer: '作者', detail_desc: '手动全局铁律', current_progress: '生效中'
    }];
    env.sandbox.MEMORY_ENGINE.commitManualState(sEdited);

    // 预埋陷阱 C：第 4 层首次响应漏写 chronicle（触发带错回灌纠错重试！）
    let retryCorrectionSeen = false;
    let firstFailDone = false;
    env.setApiHandler(async prompt => {
      const layerMatches = [...prompt.matchAll(/\[楼层 (\d+)\]/g)].map(x => Number(x[1]));
      const maxL = layerMatches.length ? Math.max(...layerMatches) : 0;
      if (maxL === 4 && !firstFailDone) {
        firstFailDone = true;
        return JSON.stringify({ important_characters: { upsert: [{ name: '人物_4', brief_intro: '临时' }], delete: [] } });
      }
      if (prompt.includes('【填表纠错】')) {
        retryCorrectionSeen = true;
      }
      const tag = `L${maxL}`;
      const res = {
        global_state: { current_location: `据点_${tag}` },
        important_characters: {
          upsert: [{ name: `人物_${tag}`, brief_intro: `身份_${tag}`, presence_status: '在场', past_experience: `在阶段 ${tag} 完成关键部署。` }],
          delete: []
        },
        quests_events: {
          upsert: [{ quest_name: `阶段任务_${tag}`, quest_type: '支线任务', issuer: '全局', detail_desc: `阶段_${tag}_持续状态`, current_progress: '进行中' }],
          delete: []
        }
      };
      if (prompt.includes('"chronicle":')) {
        res.chronicle = { summary: `阶段 ${tag}`, chronicle_text: `阶段 ${tag} 详实纪要。`.repeat(55) };
      }
      return JSON.stringify(res);
    });

    // 先跑非覆盖范围填表 1..4，再跑一键追平到 8
    const r14 = await env.sandbox.MEMORY_ENGINE.fillSummaryRange({ startLayer: 1, endLayer: 4, batchSize: 1, overwrite: false });
    assert.strictEqual(r14.completedBatches, 2, '第 2 层仅补 6 表、第 4 层补全 7 表，共 2 批');
    assert.strictEqual(retryCorrectionSeen, true, '第 4 层缺少必填 chronicle 时应触发带错回灌纠错重试并成功修复');

    const cu8 = await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });
    assert.strictEqual(cu8.completedBatches, 2, '剩余第 6 层与第 8 层两批应追平');

    const finalSt = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(finalSt.tables.chronicle.length, 4, '4 段纪要齐全且第 2 层旧纪要未被重复写入');
    assert.ok(finalSt.tables.important_characters.length >= 4, `4 批重要角色均须落表，实际=${finalSt.tables.important_characters.length}`);
    assert.ok(finalSt.tables.quests_events.some(q => q.quest_name === '手动全局铁律'), '用户之前的手动任务必须保留');
    assert.strictEqual(finalSt.tables.quests_events.length, 5, '1 条手动 + 4 批新增 = 5 条任务全部在表');
    console.log('✓ 场景 3 通过：手动快照 + 分表水位参差 Wave 补漏 + 带错回灌纠错重试全部 100% 落表');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 场景 4：独立模式（世界 + 记忆 + 世界轻同步 + 向量开启，大纲关闭）推进、跨设备同步与删楼全回退
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const env = createProductionSandbox(makeOpeningChat(0));
    await env.sandbox.WORLD_ENGINE_CHATCACHE.init();
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({
      smallSummaryEveryX: 1,
      vectorEnabled: true,
      embeddingApiUrl: 'https://mock-embed.local/v1/embeddings',
      embeddingApiKey: 'sk-test',
      embeddingModel: 'bge-m3',
      syncToChat: true
    });
    env.setFetchHandler(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: inputs.map((t, idx) => ({ index: idx, embedding: [t.length % 7 + 1, (idx + 1) * 0.5, 0.25, 0.75] }))
        })
      };
    });

    const core = env.sandbox.WORLD_ENGINE_CORE;
    const evolution = env.sandbox.WORLD_ENGINE_EVOLUTION;
    const ledger = env.sandbox.WORLD_ENGINE_LEDGER;
    const memEngine = env.sandbox.MEMORY_ENGINE;
    const memVector = env.sandbox.MEMORY_ENGINE_VECTOR;

    for (let r = 1; r <= 4; r++) {
      const layer = env.pushRound(`第${r}轮玩家推进`, `第${r}轮AI剧情<small>第${r * 2}日</small>`);
      // 1) 世界引擎推演（含故事时间与账本）
      env.setApiHandler(async () => JSON.stringify({
        world_digest: `第${r}轮世界摘要`,
        events: [{ id: null, name: `世界事件_${r}`, type: 'conflict', level: 3, stage: '萌芽', stageRound: 2, desc: `描述_${r}` }],
        factions: [{ id: null, name: `势力_${r}`, scope: '北境', status: '稳固', relation: '中立', currentGoal: '守御', core_person: `首领_${r}` }],
        worldTrends: [{ id: null, name: `大势_${r}`, description: `第${r}轮天下大势`, scope: '北境', status: '酝酿' }]
      }));
      const ws = core.loadState();
      const refs = env.sandbox.MEMORY_ENGINE_TIMELINE.captureRange(layer - 1, layer);
      assert.strictEqual(await evolution.evolve(ws, '', env.ctx.chat[layer].mes, { dialogueText: '测试', sourceRefs: refs }), true);
      ws.time = r * 2;
      core.saveState(ws);
      core.setLastStoryDay(r * 2);
      ledger.recordChanges(ws);
      core.updateCurrentHistorySnapshot(ws);

      // 2) 弱联动校验：世界推演后不得往记忆 7 表写入任何世界同步记录
      const linkRes = await memEngine.ingestWorldEvolution({
        layer,
        worldRound: ws.round,
        worldDigest: ws.worldDigest,
        worldUpdate: ws.lastEvolveResult,
        lightweight: true,
        force: true
      });
      assert.strictEqual(linkRes.skipped, true, '弱联动模式下世界不得向记忆写入记录');

      // 3) 记忆引擎提取本层对话 + 向量维护
      env.setApiHandler(async () => JSON.stringify({
        important_characters: {
          upsert: [{ name: '林墨', brief_intro: `第${r}阶密探`, presence_status: '在场', past_experience: `截至第${r}轮的关键经历。` }],
          delete: []
        },
        quests_events: {
          upsert: [{ quest_name: `第${r}轮状态任务`, quest_type: '支线任务', issuer: '林墨', detail_desc: `第${r}轮状态事实`, current_progress: '进行中' }],
          delete: []
        },
        chronicle: {
          summary: `第${r}轮对话纪要`,
          chronicle_text: `第${r}轮对话纪要。`.repeat(55)
        }
      }));
      await memEngine.catchUpToLatest({ includeCurrentFloor: true });
      await memVector.maintainVectors();
    }

    assert.strictEqual(core.loadState().round, 4);
    assert.strictEqual(core.loadState().time, 8);
    assert.strictEqual(core.getLastStoryDay(), 8);
    assert.strictEqual(env.sandbox.MEMORY_ENGINE_DATA.loadState().tables.chronicle.length, 4, '弱联动下记忆纪要表保持纯净：4 轮 = 4 条对话纪要（零世界掺水）');

    // 删除第 3、4 轮（保留 0..4，即前 2 轮）
    env.ctx.chat.splice(5);
    const rbWorld = core.rollbackToLayer();
    await memEngine.reconcileHistory({ refillUncovered: false });

    assert.strictEqual(rbWorld.rolledBack, true);
    assert.strictEqual(core.loadState().round, 2);
    assert.strictEqual(core.loadState().time, 4, '世界故事天数随删楼回退至第 4 日');
    assert.strictEqual(core.getLastStoryDay(), 4, 'getLastStoryDay 同步回退至第 4 日');
    assert.deepStrictEqual(plain(core.loadState().events.map(e => e.name)).sort(), ['世界事件_1', '世界事件_2']);

    const memRolled = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(memRolled.tables.chronicle.length, 2, '第 3、4 轮的对话纪要已回退，保留前 2 轮');
    assert.strictEqual(memRolled.tables.quests_events.length, 2, '第 3、4 轮任务已同步回退');
    assert.strictEqual(memRolled.tables.important_characters[0].brief_intro, '第2阶密探', '重要角色信息回退至第 2 轮');
    const vecKeys = Object.keys(memVector.loadVectorStore().records);
    assert.ok(!vecKeys.some(k => k.includes('small_000003') || k.includes('small_000004')), '已删楼层的向量同步清理');

    // 再彻底清空整个聊天（chat.length = 0），验证无任何残留
    env.ctx.chat.length = 0;
    core.rollbackToLayer();
    await memEngine.reconcileHistory({ refillUncovered: false });
    const memEmpty = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(memEmpty.tables.chronicle.length, 0, '清空聊天后纪要清零');
    assert.strictEqual(memEmpty.timeline.nodes.length, 0, '清空聊天后时间线节点清零');
    console.log('✓ 场景 4 通过：弱联动独立模式下世界（含时间/账本）+ 纯净记忆 7 表 + 向量删楼与清空全链路回退零残留');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 场景 5：三模块全开（世界 + 记忆 + 剧情大纲 + 协同桥）推进、隐私隔离与联合删楼回退
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const env = createProductionSandbox(makeOpeningChat(0));
    await env.sandbox.WORLD_ENGINE_CHATCACHE.init();
    env.sandbox.OUTLINE_ENGINE_SETTINGS.patchSettings({ engineEnabled: true, autoCheck: true });
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ smallSummaryEveryX: 1, injectIntoOutlineEngine: true, acceptOutlineSync: true });

    // 提交一份包含公开节点与私密真相的大纲计划
    env.sandbox.OUTLINE_ENGINE_DATA.commitPlan({
      title: '北境暗桩篇',
      publicSynopsis: '林墨与沈清秋追查漕运内鬼',
      chapters: [{
        id: 'ch_1',
        title: '第一章：风雪渡口',
        goal: '护送虎符并查明分舵底细',
        nodes: [
          {
            id: 'node_pub',
            title: '青石渡交接',
            visibility: 'public',
            completionCriteria: '完成虎符交接',
            entityRefs: [{ id: 'char_shen', nameSnapshot: '沈清秋' }]
          },
          {
            id: 'node_priv',
            title: '幕后黑手实为二皇子',
            visibility: 'private',
            privateFacts: '二皇子暗中收买了南城舵主',
            completionCriteria: '揭穿二皇子'
          }
        ]
      }]
    }, 0);

    // 第 1 轮推进（楼层 1-2）
    const l2 = env.pushRound('林墨接过青铜虎符', '沈清秋叮嘱半月之约');
    const refs2 = env.sandbox.MEMORY_ENGINE_TIMELINE.captureRange(1, l2);
    env.setApiHandler(async () => JSON.stringify({
      world_digest: '第1轮联合世界摘要',
      events: [{ id: null, name: '漕运暗流', type: 'conflict', level: 3, stage: '萌芽', stageRound: 2, desc: '暗流涌动' }]
    }));
    const wState1 = env.sandbox.WORLD_ENGINE_CORE.loadState();
    assert.strictEqual(await env.sandbox.WORLD_ENGINE_EVOLUTION.evolve(wState1, '', env.ctx.chat[l2].mes, {
      dialogueText: '联合推进1', sourceRefs: refs2
    }), true);
    const commit1 = env.sandbox.WORLD_ENGINE_EVOLUTION.getLastWorldCommitId();
    assert.ok(commit1, '联合模式应生成 worldCommitId');

    // 验证协同桥给记忆提取的提示绝不泄露 private 节点或 privateFacts
    const hints = env.sandbox.STORY_ENGINE_BRIDGE.getMemoryExtractionHints();
    assert.ok(!hints.outlineFocusHint.includes('二皇子'), '私密大纲信息严禁泄露进记忆提取提示词');

    env.setApiHandler(async () => JSON.stringify({
      character_profile_updates: [{
        name: ['沈清秋'],
        basic_info: { identity: '暗桩总管', appearance: '', personality: '', abilities: '', relations: '盟友' },
        experiences: '在青石渡向林墨交付虎符。'
      }],
      personal_memory: [],
      entity_updates: [],
      ongoing_fact_updates: [{ action: 'upsert', id: '', category: '契约', subject: '虎符', fact: '虎符已交由林墨保管', keywords: ['虎符'] }],
      character_arc_updates: [{ name: '沈清秋', current_stance: '合作', arc_summary: '建立合作', relationship: '同盟', progress_pct: 40 }],
      small_summary: '第1轮联合纪要。'.repeat(60)
    }));
    await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true, includeMemory: true });

    // 验证协同桥反向给大纲提供的参考背景包含新增的「人物档案履历」
    const outlineRef = env.sandbox.STORY_ENGINE_BRIDGE.buildOutlineReferenceContext(env.sandbox.OUTLINE_ENGINE_DATA.loadState());
    assert.ok(outlineRef.includes('人物档案履历') && outlineRef.includes('暗桩总管'), '大纲参考上下文应包含统一人物档案履历');

    // 第 2 轮推进（楼层 3-4）
    const l4 = env.pushRound('前往南城查账', '茶楼遭遇伏击');
    const refs4 = env.sandbox.MEMORY_ENGINE_TIMELINE.captureRange(3, l4);
    env.setApiHandler(async () => JSON.stringify({
      world_digest: '第2轮联合世界摘要',
      events: [{ id: null, name: '茶楼伏击', type: 'conflict', level: 3, stage: '发酵', stageRound: 3, desc: '伏击爆发' }]
    }));
    const wState2 = env.sandbox.WORLD_ENGINE_CORE.loadState();
    assert.strictEqual(await env.sandbox.WORLD_ENGINE_EVOLUTION.evolve(wState2, '', env.ctx.chat[l4].mes, {
      dialogueText: '联合推进2', sourceRefs: refs4
    }), true);
    env.setApiHandler(async () => JSON.stringify({
      character_profile_updates: [{
        name: ['沈清秋'],
        basic_info: { identity: '', appearance: '', personality: '', abilities: '', relations: '生死之交' },
        experiences: '青石渡交接后，在南城茶楼替林墨挡下伏击。'
      }],
      personal_memory: [],
      entity_updates: [],
      ongoing_fact_updates: [],
      character_arc_updates: [],
      small_summary: '第2轮联合纪要。'.repeat(60)
    }));
    await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true, includeMemory: true });
    assert.strictEqual(env.sandbox.WORLD_ENGINE_CORE.loadState().round, 2);

    // 删掉第 2 轮（楼层 3-4），触发联合历史与记忆同步回退
    env.ctx.chat.splice(3);
    env.sandbox.STORY_ENGINE_HISTORY.reconcile();
    await env.sandbox.MEMORY_ENGINE.reconcileHistory({ refillUncovered: false });

    assert.strictEqual(env.sandbox.WORLD_ENGINE_CORE.loadState().round, 1, '联合世界回退至第 1 轮');
    assert.strictEqual(env.sandbox.WORLD_ENGINE_CORE.loadState().worldDigest, '第1轮联合世界摘要');
    const shenBack = env.sandbox.MEMORY_ENGINE_DATA.loadState().tables.important_characters.find(p => p.name === '沈清秋');
    assert.strictEqual(shenBack.relation_text, '盟友', '联合模式下重要角色关系同步回退至第 1 轮');
    console.log('✓ 场景 5 通过：三模块全开协同、私密大纲零泄露、人物履历桥接与联合删楼同步回退全部正常');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 场景 6：设置页重填清理完整性 + 记忆包导出/导入往返 + 严格注入预算控制
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const env = createProductionSandbox(makeOpeningChat(2));
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ catchUpBatchSize: 1, smallSummaryEveryX: 1, memoryInjectMaxChars: 900 });

    env.setApiHandler(async () => JSON.stringify({
      important_characters: {
        upsert: [{
          name: '苏晚',
          brief_intro: '漕帮少主',
          appearance: '红衣短刃',
          presence_status: '在场',
          relation_text: '林墨:合作者',
          past_experience: '接管南城码头后协助林墨核查黑水帮私盐船队。'
        }],
        delete: []
      },
      quests_events: {
        upsert: [{ quest_name: '封查南城私盐', quest_type: '支线任务', issuer: '漕帮', detail_desc: '正在封锁南城水路盘查私盐', current_progress: '进行中' }],
        delete: []
      },
      chronicle: {
        summary: '苏晚协助封查水路',
        chronicle_text: '苏晚协助林墨封查南城水路。'.repeat(50)
      }
    }));

    await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true });

    // 1) 验证总结记忆包导出 -> 在新聊天导入后核心 7 表 100% 保留
    const pkg = env.sandbox.MEMORY_ENGINE_DATA.exportMemoryPackage();
    env.ctx.chatId = 'prod-sim-imported-chat';
    env.sandbox.MEMORY_ENGINE_DATA.importMemoryPackage(pkg);
    const importedSt = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    const su = importedSt.tables.important_characters.find(p => p.name === '苏晚');
    assert.ok(su, '导入后角色存在');
    assert.strictEqual(su.brief_intro, '漕帮少主', '记忆包导入后角色简介完好保留');
    assert.strictEqual(su.appearance, '红衣短刃');
    assert.ok(su.past_experience.includes('协助林墨核查黑水帮'), '记忆包导入后过往经历完好保留');

    // 2) 验证紧预算下正文注入格式完整且不超预算
    env.ctx.chat.push({ is_user: true, name: '林墨', mes: '苏晚在漕帮那边查得如何了？', swipe_id: 0, extra: {} });
    const inj = env.sandbox.MEMORY_ENGINE.applyInjection();
    assert.ok(inj.includes('【长期记忆数据库'));
    assert.ok(inj.includes('漕帮少主') && inj.includes('红衣短刃'));
    assert.ok(inj.includes('接管南城码头后'));
    assert.ok(inj.length <= 930, `注入总长度必须遵守预算控制，实际=${inj.length}`);

    // 3) 验证设置页 backfill() 重填结构化 6 表前彻底清空旧任务等非纪要表，绝不残留进 root.base
    env.ctx.chatId = 'prod-sim-chat-1';
    env.setApiHandler(async () => JSON.stringify({
      important_characters: {
        upsert: [{ name: '全新人物', brief_intro: '重填后新身份', presence_status: '在场', past_experience: '重填后全新经历。' }],
        delete: []
      },
      quests_events: { upsert: [], delete: [] }
    }));
    await env.sandbox.MEMORY_ENGINE.backfill();
    const afterBackfill = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(afterBackfill.tables.quests_events.length, 0, 'backfill 重填必须彻底清空旧任务，不能残留进 root.base');
    assert.strictEqual(afterBackfill.tables.important_characters.length, 1);
    assert.strictEqual(afterBackfill.tables.important_characters[0].name, '全新人物');

    // 4) 验证旧默认预算 3500 自动迁移至 8000，而用户自定义预算原样保留
    env.sandbox.WORLD_ENGINE_STORE.setItem('memory_engine_settings', JSON.stringify({ memoryInjectMaxChars: 3500 }));
    assert.strictEqual(env.sandbox.MEMORY_ENGINE_SETTINGS.getSettings(true).memoryInjectMaxChars, 8000, '旧默认 3500 应平滑升级至 8000');
    env.sandbox.WORLD_ENGINE_STORE.setItem('memory_engine_settings', JSON.stringify({ memoryInjectMaxChars: 5200 }));
    assert.strictEqual(env.sandbox.MEMORY_ENGINE_SETTINGS.getSettings(true).memoryInjectMaxChars, 5200, '用户自定义预算 5200 应原样保留');
    console.log('✓ 场景 6 通过：记忆包 7 表往返无损、注入预算公平控制、backfill 重填清理彻底无旧残留');
  }

  console.log('\n🎉 全量生产级多角度端到端仿真测试 6 大综合场景全部通过！');
}

runAll().catch(err => {
  console.error('❌ 生产仿真测试失败:', err);
  process.exit(1);
});
