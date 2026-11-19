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
  // 场景 1：真实大模型脏输出压力测试（<think> 块 + 未转义字面换行 + // 注释 + 尾随逗号 + 双代码块拆分）
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const env = createProductionSandbox(makeOpeningChat(1));
    await env.sandbox.WORLD_ENGINE_CHATCACHE.init();
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ smallSummaryEveryX: 1, smallSummaryMinChars: 500 });

    // 故意在 500+ 字字符串内部放入真实未转义换行符、尾随逗号、单行注释、<think> 花括号干扰
    const messyRaw = `<think>让我先思考人物：{沈清秋, 林墨}，准备输出 JSON</think>
\`\`\`json
{
  // 人物统一档案更新
  "character_profile_updates": [
    {
      "name": ["沈清秋", "清秋"],
      "basic_info": {
        "identity": "北境暗桩总管",
        "appearance": "青衫玉簪，眉目清冷",
        "personality": "外冷内韧，极重然诺",
        "abilities": "惊鸿剑法、暗桩密语",
        "relations": "与林墨初次结盟",
      },
      "experiences": "早年执掌北境暗桩情报网。
今日在青石渡秘密会见林墨，将关乎十二处暗桩生死的青铜虎符托付于他，并定下半月之约。",
    },
  ],
  "personal_memory": [
    {
      "name": ["沈清秋"],
      "known_by": ["林墨"],
      "memory": "沈清秋暗中怀疑内鬼就在南城分舵。",
      "time": "第1日",
    },
  ],
  "entity_updates": [
    {
      "type": "object",
      "name": "青铜虎符",
      "aliases": ["北境虎符"],
      "description": "调动北境十二暗桩的唯一铁证信物",
      "event": "由沈清秋秘密移交林墨保管",
      "time": "第1日",
    },
  ],
  "ongoing_fact_updates": [
    {
      "action": "upsert",
      "id": "",
      "category": "契约",
      "subject": "青铜虎符",
      "fact": "半月内不可示人，否则北境暗桩全毁",
      "keywords": ["青铜虎符", "半月之约"],
    },
  ],
  "character_arc_updates": [
    {
      "name": "沈清秋",
      "current_stance": "审慎托付",
      "arc_summary": "在绝境中将关键信物托付林墨",
      "relationship": "密约同盟",
      "progress_pct": 35,
    },
  ],
  "small_summary": "${'青石渡风雪之夜，沈清秋携青铜虎符密会林墨，详述北境暗桩危局并定下半月保密之约。\n双方就南城分舵异动交换情报，敲定次日分头核查漕运账册的行动方案。'.repeat(8)}",
  "small_summary_keywords": ["青铜虎符", "青石渡", "漕运账册",],
}
\`\`\``;

    env.setApiHandler(async () => messyRaw);
    const cu = await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true, includeMemory: true });
    assert.strictEqual(cu.completedBatches, 1);
    const st = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(st.personal_memory.length, 2, '沈清秋与知情人林墨均应建档');
    const shen = st.personal_memory.find(p => p.names.includes('沈清秋'));
    assert.strictEqual(shen.profile.basicInfo.identity, '北境暗桩总管');
    assert.ok(shen.profile.experiences.includes('青铜虎符托付于他'), '含字面换行的长经历应被无损修复解析');
    assert.strictEqual(st.entity_memory.object.length, 1);
    assert.strictEqual(st.ongoing_facts.length, 1);
    assert.strictEqual(st.character_arcs.length, 1);
    assert.strictEqual(st.event_memory.small_summaries.length, 1);
    assert.ok(st.event_memory.small_summaries[0].content.length >= 500, '含未转义换行的 500+ 字纪要应完整落表');
    console.log('✓ 场景 1 通过：真实脏 JSON（<think> + 字符串未转义换行 + 注释 + 尾随逗号）全要素无损落表');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 场景 2：20 轮长对话人物防膨胀压力测试（统一五项基本信息 + 详实迄今经历整合 + 碎记忆上限裁剪）
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const env = createProductionSandbox(makeOpeningChat(20));
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ smallSummaryEveryX: 1, smallSummaryMinChars: 500 });

    let roundCounter = 0;
    env.setApiHandler(async () => {
      roundCounter++;
      const isMajorTurn = roundCounter % 4 === 0 || roundCounter === 1;
      return JSON.stringify({
        character_profile_updates: isMajorTurn ? [{
          name: ['沈清秋'],
          basic_info: {
            identity: roundCounter >= 12 ? '北境暗桩总管（已公开亮明身份）' : '北境暗桩总管',
            appearance: roundCounter === 1 ? '青衫玉簪' : '',
            personality: roundCounter === 1 ? '冷静果决' : '',
            abilities: roundCounter === 8 ? '惊鸿剑法大成、暗桩调度' : '',
            relations: `第${roundCounter}轮同盟深化`
          },
          experiences: `截至第${roundCounter}轮的关键经历整合：历经青石渡托付虎符、南城查账破局与茶楼突围（已忽略日常寒暄琐事）。`
        }] : [],
        // 故意每轮塞 3 条碎记忆（共 60 条），验证本地自动防膨胀上限 30 条
        personal_memory: [1, 2, 3].map(k => ({
          name: ['沈清秋'],
          known_by: [],
          memory: `第${roundCounter}轮认知片段_${k}`,
          time: `第${roundCounter}日`
        })),
        entity_updates: [],
        ongoing_fact_updates: [],
        character_arc_updates: [],
        small_summary: `第${roundCounter}轮阶段纪要详实记录。`.repeat(45)
      });
    });

    await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true, includeMemory: true });
    const st = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    const shen = st.personal_memory.find(p => p.names.includes('沈清秋'));
    assert.strictEqual(st.personal_memory.length, 1, '20 轮后同一人物绝不重复建卡');
    assert.strictEqual(shen.profile.basicInfo.appearance, '青衫玉簪', '第 1 轮写入且后续返回空串的外貌字段应完好保留');
    assert.strictEqual(shen.profile.basicInfo.abilities, '惊鸿剑法大成、暗桩调度', '第 8 轮增量补充的能力字段应保留');
    assert.strictEqual(shen.profile.basicInfo.identity, '北境暗桩总管（已公开亮明身份）');
    assert.strictEqual(shen.profile.basicInfo.relations, '第20轮同盟深化');
    assert.ok(shen.profile.experiences.startsWith('截至第20轮的关键经历整合'), '迄今经历为整合更新而非无限拼接');
    const totalStoredFragments = Object.values(shen.memory).reduce((s, arr) => s + arr.length, 0);
    assert.strictEqual(totalStoredFragments, 30, `60 条碎记忆应被防膨胀上限稳定控制在 30 条，实际=${totalStoredFragments}`);
    console.log('✓ 场景 2 通过：20 轮长对话人物统一档案原地精炼更新，碎记忆严格受控不膨胀');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 场景 3：所有「只落纪要不落其他表」生产陷阱联合回归（非空快照 + 旧空壳节点 + 短对话兜底重试 + 范围填表）
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const env = createProductionSandbox(makeOpeningChat(4)); // 0..8 (AI: 2, 4, 6, 8)
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ smallSummaryEveryX: 1, smallSummaryMinChars: 500 });

    // 预埋陷阱 A：第 1-2 层存在旧版遗留的“空壳节点”（memoryExtracted: false 或空内容）+ 已有纪要
    const s0 = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    const refs12 = env.sandbox.MEMORY_ENGINE_TIMELINE.captureRange(1, 2);
    s0.timeline.nodes.push({
      id: 'memory_000001', kind: 'memory', startLayer: 1, endLayer: 2, sourceRefs: refs12,
      sourceDigest: env.sandbox.MEMORY_ENGINE_TIMELINE.digestRefs(refs12),
      personal: [], profileUpdates: [], entities: { organization: [], object: [], ability: [], location: [] },
      factUpdates: [], arcUpdates: [], memoryExtracted: false, status: 'valid'
    });
    s0.event_memory.small_summaries.push({
      id: 'small_000001', startLayer: 1, endLayer: 2, content: '旧1-2纪要。'.repeat(60),
      sourceRefs: refs12, sourceDigest: env.sandbox.MEMORY_ENGINE_TIMELINE.digestRefs(refs12), status: 'valid'
    });
    // 预埋陷阱 B：用户在第 8 层手动加过 1 条设定事实（产生 endLayer=8 的非空 manual_snapshot！）
    const sEdited = plain(s0);
    sEdited.ongoing_facts = [{
      id: 'fact_000001', category: '设定', subject: '全局', fact: '手动全局铁律', keywords: [], status: 'active', startLayer: 0, updatedLayer: 8
    }];
    env.sandbox.MEMORY_ENGINE.commitManualState(sEdited, s0);
    env.sandbox.MEMORY_ENGINE_DATA.saveState(sEdited);

    // 预埋陷阱 C：第 3-4 层的联合请求中模型“偷懒”只写了 small_summary，漏写了人物/实体/事实，触发独立补提！
    let fallbackTriggeredFor34 = false;
    env.setApiHandler(async prompt => {
      if ((prompt.includes('【总结范围】\n楼层 4\n') || prompt.includes('楼层 3 至 4')) && prompt.includes('"small_summary": ""')) {
        return JSON.stringify({ small_summary: '第3-4层模型偷懒只返回了纪要。'.repeat(50) });
      }
      if (!prompt.includes('"small_summary": ""')) {
        fallbackTriggeredFor34 = true;
      }
      const layerMatches = [...prompt.matchAll(/\[楼层 (\d+)\]/g)].map(x => Number(x[1]));
      const maxL = layerMatches.length ? Math.max(...layerMatches) : 0;
      const tag = maxL ? `${maxL - 1}-${maxL}` : '未知';
      return JSON.stringify({
        character_profile_updates: [{
          name: [`人物_${tag}`],
          basic_info: { identity: `身份_${tag}`, appearance: '', personality: '', abilities: '', relations: '' },
          experiences: `在阶段 ${tag} 完成了关键部署。`
        }],
        personal_memory: [],
        entity_updates: [{ type: 'location', name: `据点_${tag}`, aliases: [], description: '关键据点', event: '完成布防', time: '' }],
        ongoing_fact_updates: [{ action: 'upsert', id: '', category: '状态', subject: '全局', fact: `阶段_${tag}_持续状态`, keywords: [] }],
        character_arc_updates: [{ name: `人物_${tag}`, current_stance: '坚定', arc_summary: '推进部署', relationship: '盟友', progress_pct: 50 }],
        small_summary: `阶段 ${tag} 详实纪要。`.repeat(55)
      });
    });

    // 先跑非覆盖范围填表 1..4，再跑一键追平到 8
    const r14 = await env.sandbox.MEMORY_ENGINE.fillSummaryRange({ startLayer: 1, endLayer: 4, batchSize: 1, overwrite: false });
    assert.strictEqual(r14.completedBatches, 2, '1-2 缺记忆、3-4 全缺，均应执行补填');
    assert.strictEqual(fallbackTriggeredFor34, true, '3-4 联合请求漏填结构化字段时应自动触发独立补提');

    const cu8 = await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true, includeMemory: true });
    assert.strictEqual(cu8.completedBatches, 2, '剩余 5-6 与 7-8 两批应追平');

    const finalSt = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(finalSt.event_memory.small_summaries.length, 4, '4 段纪要齐全');
    assert.ok(finalSt.personal_memory.length >= 4, `4 批新人物档案均须落表，实际=${finalSt.personal_memory.length}`);
    assert.strictEqual(finalSt.entity_memory.location.length, 4, '4 批地点实体均须落表');
    assert.ok(finalSt.ongoing_facts.some(f => f.fact === '手动全局铁律'), '用户之前的手动事实必须保留');
    assert.strictEqual(finalSt.ongoing_facts.length, 5, '1 条手动 + 4 批新增 = 5 条持续事实全部在表');
    assert.strictEqual(finalSt.character_arcs.length, 4, '4 批角色弧光全部在表');
    console.log('✓ 场景 3 通过：非空手动快照 + 空壳旧节点 + 模型偷懒漏字段兜底补提下，范围填表与一键追平全要素 100% 落表');
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

      // 2) 世界 -> 记忆轻同步（产生 synthetic world_link 节点 + world_engine 纪要）
      await memEngine.ingestWorldEvolution({
        layer,
        worldRound: ws.round,
        worldDigest: ws.worldDigest,
        worldUpdate: ws.lastEvolveResult,
        lightweight: true,
        force: true
      });

      // 3) 记忆引擎提取本层对话 + 向量维护
      env.setApiHandler(async () => JSON.stringify({
        character_profile_updates: [{
          name: ['林墨'],
          basic_info: { identity: `第${r}阶密探`, appearance: '', personality: '', abilities: '', relations: '' },
          experiences: `截至第${r}轮的关键经历。`
        }],
        personal_memory: [],
        entity_updates: [],
        ongoing_fact_updates: [{ action: 'upsert', id: '', category: '状态', subject: '林墨', fact: `第${r}轮状态事实`, keywords: [`状态${r}`] }],
        character_arc_updates: [],
        small_summary: `第${r}轮对话纪要。`.repeat(55)
      }));
      await memEngine.catchUpToLatest({ includeCurrentFloor: true, includeMemory: true });
      await memVector.maintainVectors();
    }

    assert.strictEqual(core.loadState().round, 4);
    assert.strictEqual(core.loadState().time, 8);
    assert.strictEqual(core.getLastStoryDay(), 8);
    assert.strictEqual(env.sandbox.MEMORY_ENGINE_DATA.loadState().event_memory.small_summaries.length, 8, '4 对话纪要 + 4 世界同步纪要');

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
    assert.strictEqual(memRolled.event_memory.small_summaries.length, 4, '第 3、4 轮的对话纪要与世界同步纪要均已回退');
    assert.ok(!memRolled.ongoing_facts.some(f => f.fact.includes('大势_3') || f.fact.includes('大势_4')),
      '第 3、4 轮世界轻同步产生的 synthetic world_link 持续事实必须随删楼一并清理，不得残留');
    assert.strictEqual(memRolled.personal_memory[0].profile.basicInfo.identity, '第2阶密探', '人物统一档案回退至第 2 轮');
    const vecKeys = Object.keys(memVector.loadVectorStore().records);
    assert.ok(!vecKeys.some(k => k.includes('small_000007') || k.includes('small_000008')), '已删楼层的向量同步清理');

    // 再彻底清空整个聊天（chat.length = 0），验证无任何 synthetic 残留
    env.ctx.chat.length = 0;
    core.rollbackToLayer();
    await memEngine.reconcileHistory({ refillUncovered: false });
    const memEmpty = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(memEmpty.event_memory.small_summaries.length, 0, '清空聊天后世界同步纪要也必须清零');
    assert.strictEqual(memEmpty.timeline.nodes.length, 0, '清空聊天后 synthetic 节点也必须清零');
    console.log('✓ 场景 4 通过：独立模式世界（含时间/账本）+ 记忆（含世界轻同步 synthetic 节点/档案/向量）删楼与清空全链路回退零残留');
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
    const shenBack = env.sandbox.MEMORY_ENGINE_DATA.loadState().personal_memory.find(p => p.names.includes('沈清秋'));
    assert.strictEqual(shenBack.profile.basicInfo.relations, '盟友', '联合模式下人物档案同步回退至第 1 轮');
    console.log('✓ 场景 5 通过：三模块全开协同、私密大纲零泄露、人物履历桥接与联合删楼同步回退全部正常');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 场景 6：设置页重填清理完整性 + 记忆包导出/导入往返 + 严格注入预算控制
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const env = createProductionSandbox(makeOpeningChat(2));
    env.sandbox.MEMORY_ENGINE_SETTINGS.patchSettings({ smallSummaryEveryX: 1, memoryInjectMaxChars: 900 });

    env.setApiHandler(async () => JSON.stringify({
      character_profile_updates: [{
        name: ['苏晚'],
        basic_info: { identity: '漕帮少主', appearance: '红衣短刃', personality: '爽利直率', abilities: '水上功夫', relations: '合作者' },
        experiences: '接管南城码头后协助林墨核查黑水帮私盐船队。'
      }],
      personal_memory: [{ name: ['苏晚'], known_by: ['林墨'], memory: '苏晚知晓私盐船暗舱位置。', time: '第1日' }],
      entity_updates: [{ type: 'organization', name: '漕帮', aliases: [], description: '掌控南城水路', event: '封查私盐船', time: '第1日' }],
      ongoing_fact_updates: [{ action: 'upsert', id: '', category: '状态', subject: '漕帮', fact: '正在封锁南城水路盘查私盐', keywords: ['私盐'] }],
      character_arc_updates: [{ name: '苏晚', current_stance: '积极助拳', arc_summary: '主动借出水路耳目', relationship: '盟友', progress_pct: 60 }],
      small_summary: '苏晚协助林墨封查南城水路。'.repeat(50)
    }));

    await env.sandbox.MEMORY_ENGINE.catchUpToLatest({ includeCurrentFloor: true, includeMemory: true });

    // 1) 验证总结记忆包导出 -> 在新聊天导入后人物统一档案（basicInfo + experiences）100% 保留
    const pkg = env.sandbox.MEMORY_ENGINE_DATA.exportMemoryPackage();
    env.ctx.chatId = 'prod-sim-imported-chat';
    env.sandbox.MEMORY_ENGINE_DATA.importMemoryPackage(pkg);
    const importedSt = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    const su = importedSt.personal_memory.find(p => p.names.includes('苏晚'));
    assert.ok(su, '导入后人物存在');
    assert.strictEqual(su.profile.basicInfo.identity, '漕帮少主', '记忆包导入后人物统一基本信息完好保留');
    assert.strictEqual(su.profile.basicInfo.appearance, '红衣短刃');
    assert.ok(su.profile.experiences.includes('协助林墨核查黑水帮'), '记忆包导入后人物迄今经历完好保留');

    // 2) 验证紧预算下正文注入格式完整且不超预算
    env.ctx.chat.push({ is_user: true, name: '林墨', mes: '苏晚在漕帮那边查得如何了？', swipe_id: 0, extra: {} });
    const inj = env.sandbox.MEMORY_ENGINE.applyInjection();
    assert.ok(inj.includes('【记忆信息】'));
    assert.ok(inj.includes('[基本信息] 身份：漕帮少主｜外貌：红衣短刃'));
    assert.ok(inj.includes('[迄今经历] 接管南城码头后'));
    assert.ok(inj.length <= 930, `注入总长度必须遵守预算控制，实际=${inj.length}`);

    // 3) 验证设置页 backfill() 重填前彻底清空旧 ongoing_facts 与 character_arcs，绝不残留进 root.base
    env.ctx.chatId = 'prod-sim-chat-1';
    env.setApiHandler(async () => JSON.stringify({
      character_profile_updates: [{
        name: ['全新人物'],
        basic_info: { identity: '重填后新身份', appearance: '', personality: '', abilities: '', relations: '' },
        experiences: '重填后全新经历。'
      }],
      personal_memory: [],
      entity_updates: [],
      ongoing_fact_updates: [],
      character_arc_updates: []
    }));
    await env.sandbox.MEMORY_ENGINE.backfill();
    const afterBackfill = env.sandbox.MEMORY_ENGINE_DATA.loadState();
    assert.strictEqual(afterBackfill.ongoing_facts.length, 0, 'backfill 重填必须彻底清空旧持续事实，不能残留进 root.base');
    assert.strictEqual(afterBackfill.character_arcs.length, 0, 'backfill 重填必须彻底清空旧角色弧光，不能残留进 root.base');
    assert.strictEqual(afterBackfill.personal_memory.length, 1);
    assert.strictEqual(afterBackfill.personal_memory[0].names[0], '全新人物');

    // 4) 验证旧默认预算 3500 自动迁移至 8000，而用户自定义预算原样保留
    env.sandbox.WORLD_ENGINE_STORE.setItem('memory_engine_settings', JSON.stringify({ memoryInjectMaxChars: 3500 }));
    assert.strictEqual(env.sandbox.MEMORY_ENGINE_SETTINGS.getSettings(true).memoryInjectMaxChars, 8000, '旧默认 3500 应平滑升级至 8000');
    env.sandbox.WORLD_ENGINE_STORE.setItem('memory_engine_settings', JSON.stringify({ memoryInjectMaxChars: 5200 }));
    assert.strictEqual(env.sandbox.MEMORY_ENGINE_SETTINGS.getSettings(true).memoryInjectMaxChars, 5200, '用户自定义预算 5200 应原样保留');
    console.log('✓ 场景 6 通过：记忆包档案往返无损、注入预算公平分配与旧预算平滑迁移、backfill 重填清理彻底无旧残留');
  }

  console.log('\n🎉 全量生产级多角度端到端仿真测试 6 大综合场景全部通过！');
}

runAll().catch(err => {
  console.error('❌ 生产仿真测试失败:', err);
  process.exit(1);
});
