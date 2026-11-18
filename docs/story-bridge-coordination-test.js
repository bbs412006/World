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
  'story-engine-projection.js',
  'memory-engine-data.js',
  'memory-engine-prompt.js',
  'memory-engine-small-summary-prompt.js',
  'memory-engine-big-summary-prompt.js',
  'memory-engine.js',
  'story-engine-bridge.js'
]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

(async () => {
  // 先初始化一点记忆资产（含别名）
  let memState = sandbox.MEMORY_ENGINE_DATA.defaultState();
  memState.personal_memory.push({ id: 'char_000001', names: ['苏婉', '婉儿'], memory: {} });
  memState.ongoing_facts.push({ id: 'fact_000001', category: '持有', subject: '林墨', fact: '随身携带半块焦黑木牌', status: 'active' });
  memState.character_arcs.push({ id: 'arc_000001', characterId: 'char_000001', names: ['苏婉', '婉儿'], currentStance: '谨慎试探', relationship: '初识线索人', progressPct: 25 });
  memState.event_memory.small_summaries.push({ id: 'small_000001', startLayer: 1, endLayer: 2, content: '林墨拣到焦黑木牌，苏婉认出此物。', status: 'valid', revision: 1 });
  sandbox.MEMORY_ENGINE_DATA.saveState(memState);

  const bridge = sandbox.STORY_ENGINE_BRIDGE;

  // 1. 隐私防泄露红线检查
  const memHints = bridge.getMemoryExtractionHints();
  assert.ok(memHints.outlineFocusHint.includes('雾锁渡口'), '应提供当前公开章名');
  assert.ok(memHints.outlineFocusHint.includes('寻访木牌来历'), '应提供当前公开活跃节点');
  assert.ok(!memHints.outlineFocusHint.includes('刺杀太傅幕后交易'), '绝不能泄露 private 节点');
  assert.ok(!memHints.worldContextHint.includes('皇室暗杀绝密指令'), '绝不能泄露世界 blackbox 暗箱内容');

  // 2. 别名归并 & 大纲认知参考增强
  const aliases = Array.from(bridge.resolveCharacterAliases('婉儿'));
  assert.ok(aliases.includes('苏婉') && aliases.includes('婉儿'), '别名应正确归并');
  const outlineRef = bridge.buildOutlineReferenceContext(sandbox.OUTLINE_ENGINE_DATA.loadState());
  assert.ok(outlineRef.includes('随身携带半块焦黑木牌'), '大纲参考上下文应自动携带持续事实');
  assert.ok(outlineRef.includes('林墨拣到焦黑木牌'), '大纲参考上下文应带近期小纪要而非只看大总述');
  assert.ok(!outlineRef.includes('皇室暗杀绝密指令'), '大纲参考不得泄露世界 blackbox');

  // 3. 大纲 verified contacts / reveals 精准回流记忆（严防泄露未揭露私密事实）
  const afterOutline = sandbox.OUTLINE_ENGINE_DATA.loadState();
  const beforeOutline = { ...afterOutline, contacts: [], knowledge: [] };
  const syncRes = bridge.notifyOutlineCommitted(afterOutline, beforeOutline, { refs: refs(1, 2) });
  assert.ok(syncRes.changed >= 2, 'verified 接触与揭露应同步进人物记忆');
  const afterMem = sandbox.MEMORY_ENGINE_DATA.loadState();
  const suWan = afterMem.personal_memory.find(p => p.names.includes('苏婉'));
  const memJoined = JSON.stringify(suWan.memory);
  assert.ok(memJoined.includes('焦黑木牌刻着旧印') && memJoined.includes('太傅遗失的密令残片'), '已核实接触与揭露应入库至苏婉主观记忆');
  assert.ok(!memJoined.includes('真正的幕后黑手是国师'), '未揭露的私密事实绝不允许混入记忆');
  // 回放测试：把 outline_verified 节点标 stale 后 replayTimeline 应能撤回
  afterMem.timeline.nodes.filter(n => n.kind === 'outline_verified').forEach(n => { n.status = 'stale'; });
  const replayed = sandbox.MEMORY_ENGINE.replayTimeline(afterMem);
  const suWanAfterRollback = replayed.personal_memory.find(p => p.names.includes('苏婉'));
  assert.ok(!JSON.stringify(suWanAfterRollback.memory).includes('太傅遗失的密令残片'), 'timeline 撤回后 outline_verified 记忆应随之回滚');

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

  console.log('story bridge coordination tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
