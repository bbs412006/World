// 跨模块协同桥独立性与安全联动测试：node docs/story-bridge-coordination-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const store = new Map();
let currentChatId = 'bridge-test';

const chat = [
  { is_user: false, name: '旁白', mes: '夜幕降临。' },
  { is_user: true, name: '林墨', mes: '我在密室角落捡到半块焦黑木牌。' },
  { is_user: false, name: '婉儿', mes: '婉儿认出木牌后低声坦言：“那是太傅当年遗失的密令残片。”' }
];

const memorySettings = {
  engineEnabled: true,
  coordinationMode: 'stagger-serial',
  worldLinkMode: 'lightweight',
  searchDepth: 5,
  injectIntoPrompt: true,
  injectIntoWorldEngine: true
};
const outlineSettings = {
  engineEnabled: true,
  autoCheck: true
};
const worldSettings = {
  engineEnabled: true,
  evolveMode: 'auto',
  injectIntoPrompt: true
};

const extensionPrompts = {};
const refs = (s, e) => chat.slice(s, e + 1).map((m, i) => ({
  chatId: currentChatId,
  messageId: `m_${s + i}`,
  layer: s + i,
  role: m.is_user ? 'user' : 'assistant',
  swipeId: 0,
  hash: `h_${s + i}`
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
      extensionPrompts,
      setExtensionPrompt: (k, v) => { extensionPrompts[k] = { value: v }; }
    })
  },
  WORLD_ENGINE_STORE: {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: key => store.delete(key)
  },
  WORLD_ENGINE_CORE: {
    getChatId: () => currentChatId,
    getChatLayer: () => chat.length - 1,
    filterDialogue: v => v,
    loadState: () => ({
      round: 3,
      worldDigest: '城南近日流民聚集。',
      events: [{ name: '城南戒严', stage: '执行', desc: '官兵查验行囊' }],
      factions: [{ id: 'f1', name: '听潮阁', core_person: '沈清秋', status: '稳固', relation: '中立', currentGoal: '收集情报' }],
      worldTrends: [{ name: '江南旱情', status: '持续中', description: '粮价攀升。' }],
      winds: [{ topic: '夜巡', content: '宵禁提前至亥时。' }],
      enemies: [],
      blackbox: { secretActions: [{ action: '皇室暗杀绝密指令', witnesses: '无' }], secretAssets: [] }
    })
  },
  WORLD_ENGINE_API: { getSettings: () => ({ ...worldSettings }) },
  WORLD_ENGINE_CHATCACHE: { forScope: () => ({ afterEvolution() {} }) },
  WORLD_ENGINE_UI: { setMemoryEvolvingUI() {}, refresh() {} },
  OUTLINE_ENGINE_SETTINGS: { getSettings: () => ({ ...outlineSettings }) },
  OUTLINE_ENGINE: { applyInjection() {} },
  OUTLINE_ENGINE_DATA: {
    getNodeStatus: (_st, id) => id === 'n_public' ? 'active' : 'pending',
    loadState: () => ({
      currentChapterId: 'c1',
      plan: {
        publicSynopsis: '主角追查渡口旧案。',
        synopsis: '绝密幕后真相：主谋其实在皇宫内。',
        chapters: [{ id: 'c1', title: '第一章 雾锁渡口', goal: '打探木牌来历' }],
        tracks: [{ id: 't1', kind: 'main', title: '主线' }, { id: 't2', kind: 'hidden', title: '暗线' }],
        nodes: [
          { id: 'n_public', title: '寻访木牌来历', visibility: 'public', entityRefs: [{ id: 'e1', nameSnapshot: '苏婉' }] },
          { id: 'n_secret', title: '绝密：刺杀太傅幕后交易', visibility: 'private', entityRefs: [] }
        ]
      },
      clues: [
        { id: 'clue_1', publicHint: '焦黑木牌刻着旧印', validity: 'valid', available: true, factIds: ['fact_p1'] }
      ],
      contacts: [
        { id: 'ct_1', clueId: 'clue_1', actorId: '婉儿', sourceRefs: refs(1, 2), validity: 'valid' }
      ],
      privateFacts: [
        { id: 'fact_p1', text: '木牌实为太傅遗失的密令残片', knownBy: ['婉儿'], validity: 'valid' },
        { id: 'fact_unrevealed', text: '绝密：真正的幕后黑手是国师', knownBy: [], validity: 'valid' }
      ],
      knowledge: [
        { id: 'kn_1', factId: 'fact_p1', actorId: '婉儿', contactId: 'ct_1', validity: 'valid' }
      ]
    })
  },
  MEMORY_ENGINE_SETTINGS: { getSettings: () => ({ ...memorySettings }) },
  MEMORY_ENGINE_TIMELINE: {
    captureRange: (s, e) => refs(s, e),
    auditRefs: list => ({ valid: true, refs: JSON.parse(JSON.stringify(list || [])), missing: [], changed: [] }),
    digestRefs: list => (list || []).map(r => `${r.messageId}:${r.hash}`).join('|'),
    unionRefs: groups => groups.flat(),
    hashText: text => `h_${String(text).length}`,
    syncHidden: () => Promise.resolve()
  }
};
sandbox.window = sandbox;

for (const file of [
  'memory-engine-data.js',
  'memory-engine-prompt.js',
  'memory-engine-small-summary-prompt.js',
  'memory-engine.js',
  'story-engine-bridge.js'
]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

(async () => {
  // 先初始化一点 v3 核心 7 表记忆资产
  let memState = sandbox.MEMORY_ENGINE_DATA.defaultState();
  memState.tables.important_characters.push({
    rowId: 1, name: '婉儿', brief_intro: '初识线索人', presence_status: '在场',
    relation_text: '林墨:初识线索人', past_experience: '谨慎试探，关注渡口旧案'
  });
  memState.tables.quests_events.push({
    rowId: 1, quest_name: '焦黑木牌调查', quest_type: '支线任务', issuer: '林墨',
    detail_desc: '随身携带半块焦黑木牌，追查来历', current_progress: '进行中'
  });
  memState.tables.chronicle.push({
    id: 'small_000001', rowId: 1, code_index: 'AM0001', startLayer: 2, endLayer: 2,
    summary: '拣到焦黑木牌', chronicle_text: '林墨拣到焦黑木牌，婉儿认出此物。', status: 'valid', revision: 1
  });
  sandbox.MEMORY_ENGINE_DATA.saveState(memState);

  const bridge = sandbox.STORY_ENGINE_BRIDGE;

  // 1. 隐私防泄露红线检查
  const memHints = bridge.getMemoryExtractionHints();
  assert.ok(memHints.outlineFocusHint.includes('雾锁渡口'), '应提供当前公开章名');
  assert.ok(memHints.outlineFocusHint.includes('寻访木牌来历'), '应提供当前公开活跃节点');
  assert.ok(!memHints.outlineFocusHint.includes('刺杀太傅幕后交易'), '绝不能泄露 private 节点');
  assert.ok(!memHints.worldContextHint.includes('皇室暗杀绝密指令'), '绝不能泄露世界 blackbox 暗箱内容');

  // 2. 角色映射 & 大纲认知参考增强
  const aliases = Array.from(bridge.resolveCharacterAliases('婉儿'));
  assert.ok(aliases.includes('婉儿'), '角色名应正确解析');
  const outlineRef = bridge.buildOutlineReferenceContext(sandbox.OUTLINE_ENGINE_DATA.loadState());
  assert.ok(outlineRef.includes('随身携带半块焦黑木牌'), '大纲参考上下文应自动携带当前任务/持续事实');
  assert.ok(outlineRef.includes('林墨拣到焦黑木牌'), '大纲参考上下文应带近期纪要');
  assert.ok(!outlineRef.includes('皇室暗杀绝密指令'), '大纲参考不得泄露世界 blackbox');

  // 3. 弱联动保护：大纲提交不得向记忆 7 表自动写入任何记录（仅保留只读参考，严防污染记忆表或泄露私密事实）
  const afterOutline = sandbox.OUTLINE_ENGINE_DATA.loadState();
  const beforeOutline = { ...afterOutline, contacts: [], knowledge: [] };
  const beforeMemSnapshot = JSON.stringify(sandbox.MEMORY_ENGINE_DATA.loadState().tables);
  const syncRes = bridge.notifyOutlineCommitted(afterOutline, beforeOutline, { refs: refs(1, 2) });
  assert.strictEqual(syncRes.changed, 0, '弱联动模式下大纲提交不得向记忆表写入任何记录');
  assert.strictEqual(syncRes.readonly, true);
  assert.strictEqual(JSON.stringify(sandbox.MEMORY_ENGINE_DATA.loadState().tables), beforeMemSnapshot, '大纲核对后记忆 7 表必须保持 100% 纯净不被改动');

  // 4. 独立运行降级检查（关闭世界和大纲时，不触发协同排队）
  worldSettings.engineEnabled = false;
  outlineSettings.engineEnabled = false;
  assert.strictEqual(bridge.shouldCoordinateGeneration(), false, '仅单一引擎启用时不应拦截或等待协同队列');
  worldSettings.engineEnabled = true;
  outlineSettings.engineEnabled = true;
  assert.strictEqual(bridge.shouldCoordinateGeneration(), true, '多引擎自动启用且为错峰模式时应开启协同调度');

  // 5. 并发错峰队列：乱序注册（先 outline，再 memory，再 world），必须按 world -> outline -> memory 串行执行且无重叠并发
  const trace = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const makeTask = name => async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    trace.push(`${name}:start`);
    await new Promise(r => setTimeout(r, 15));
    trace.push(`${name}:end`);
    inFlight--;
  };
  const pOutline = bridge.scheduleTurn({ scope: 'outline', layer: 2, delayMs: 30, run: makeTask('outline') });
  const pMemory = bridge.scheduleTurn({ scope: 'memory', layer: 2, delayMs: 30, run: makeTask('memory') });
  const pWorld = bridge.scheduleTurn({ scope: 'world', layer: 2, delayMs: 30, run: makeTask('world') });
  await Promise.all([pOutline, pMemory, pWorld]);
  assert.strictEqual(maxInFlight, 1, 'stagger-serial 模式下同一时刻最多只允许 1 个后台请求，保护 Vertex 并发');
  assert.strictEqual(
    trace.join(','),
    'world:start,world:end,outline:start,outline:end,memory:start,memory:end',
    '多模块联动必须严格按 世界 -> 大纲 -> 记忆 管线顺序推进'
  );

  // 6. 取消机制测试
  const abortedTrace = [];
  bridge.scheduleTurn({ scope: 'world', layer: 3, delayMs: 50, run: async () => abortedTrace.push('world') });
  bridge.scheduleTurn({ scope: 'memory', layer: 3, delayMs: 50, run: async () => abortedTrace.push('memory') });
  bridge.cancelTurn();
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(abortedTrace.length, 0, 'cancelTurn 必须完整中止未启动的排队任务');

  // 7. 正文注入秩序整理：无论先注册大纲还是记忆，最终在 extensionPrompts 顺序为 world -> memory -> outline
  extensionPrompts['outline-engine-outline'] = { value: '【剧情指导】' };
  extensionPrompts['memory-engine-memory'] = { value: '【记忆信息】' };
  extensionPrompts['world-engine-world'] = { value: '【世界信息】' };
  bridge.ensureInjectionOrder();
  assert.deepStrictEqual(
    Object.keys(extensionPrompts),
    ['world-engine-world', 'memory-engine-memory', 'outline-engine-outline'],
    '正文 depth=1 注入顺序应协同为 世界 -> 记忆 -> 大纲'
  );

  // 8. 双向细粒度联动开关与共享调度持久化测试
  memorySettings.engineEnabled = false; // 即使关闭记忆引擎，世界+大纲双开仍可读写共享并发策略
  bridge.setCoordinationMode('independent');
  assert.strictEqual(bridge.getCoordinationMode(), 'independent', '关闭记忆模块时仍可独立保存共享调度策略');
  assert.strictEqual(bridge.shouldCoordinateGeneration(), false, '切换为各自独立并发后不再排队');
  bridge.setCoordinationMode('stagger-serial');
  assert.strictEqual(bridge.getCoordinationMode(), 'stagger-serial');
  memorySettings.engineEnabled = true;

  worldSettings.acceptMemoryContext = false;
  assert.strictEqual(bridge.buildWorldMemorySection({ events: [] }), '', '世界端关闭接收记忆后不得注入记忆上下文');
  worldSettings.acceptMemoryContext = true;

  outlineSettings.useWorldReference = false;
  const noWorldOutlineRef = bridge.buildOutlineReferenceContext({ plan: { nodes: [] } });
  assert.ok(!noWorldOutlineRef.includes('城南近日流民聚集') && noWorldOutlineRef.includes('随身携带半块焦黑木牌'), '仅关闭世界参考时应保留记忆参考并排除世界背景');
  outlineSettings.useWorldReference = true;

  memorySettings.injectIntoOutlineEngine = false;
  const noMemOutlineRef = bridge.buildOutlineReferenceContext({ plan: { nodes: [] } });
  assert.ok(noMemOutlineRef.includes('城南近日流民聚集') && !noMemOutlineRef.includes('随身携带半块焦黑木牌'), '记忆端关闭向大纲提供背景后应只保留世界参考');
  memorySettings.injectIntoOutlineEngine = true;

  assert.ok(Array.from(bridge.getOutlineActiveActors()).length > 0, '大纲启用于记忆同步时应返回公开活跃人物');
  outlineSettings.injectIntoMemoryEngine = false;
  assert.strictEqual(bridge.getMemoryExtractionHints().outlineFocusHint, '', '大纲端关闭同步焦距后不再向记忆提取传递焦距');
  assert.deepStrictEqual(Array.from(bridge.getOutlineActiveActors()), [], '大纲端关闭同步后不再向记忆推送活跃人物');
  const blockedSync = bridge.notifyOutlineCommitted({
    clues: [{ id: 'cl2', validity: 'valid', publicHint: '新线索' }],
    contacts: [{ id: 'ct2', clueId: 'cl2', actorId: '苏婉', validity: 'valid' }],
    privateFacts: [],
    knowledge: []
  }, { contacts: [], knowledge: [] }, { refs: refs(2, 2) });
  assert.strictEqual(blockedSync.changed, 0, '大纲端关闭同步后不得继续向记忆回写 contacts');
  outlineSettings.injectIntoMemoryEngine = true;

  console.log('story bridge coordination tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
