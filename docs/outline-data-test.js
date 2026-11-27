// 剧情大纲 v3 数据层与设置层测试：node docs/outline-data-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const storeMap = new Map();
let currentChat = 'chat-a';

const sandbox = {
  window: null,
  console,
  SillyTavern: { getContext: () => ({ chatId: currentChat }) },
  WORLD_ENGINE_CORE: { getChatId: () => currentChat },
  WORLD_ENGINE_STORE: {
    getItem: k => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => storeMap.set(k, String(v)),
    removeItem: k => storeMap.delete(k)
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const file of ['outline-engine-settings.js', 'outline-engine-data.js', 'outline-engine-prompt.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

const data = sandbox.OUTLINE_ENGINE_DATA;
const settings = sandbox.OUTLINE_ENGINE_SETTINGS;

// 1. 设置归一化：空温度回退 0.2，空 topP 回退 null，默认 8192，默认前置出文注入（injectPosition=0）与旧版一次性迁移
{
  // 模拟旧版默认配置（聊天内深度 1）在升级后平滑迁移至主提示词内（IN_PROMPT=0）
  storeMap.set('outline_engine_settings', JSON.stringify({ engineEnabled: true, injectPosition: 1, injectDepth: 1 }));
  const migrated = settings.getSettings(true);
  assert.strictEqual(migrated.injectPosition, 0, '旧版默认 injectPosition=1/depth=1 应一次性迁移至主提示词内（0）作为前置出文指导');
  // 迁移完成后用户手动改回 position=1 不应再被覆盖
  settings.patchSettings({ injectPosition: 1, injectDepth: 1 });
  assert.strictEqual(settings.getSettings(true).injectPosition, 1, '迁移标记落盘后应尊重用户手动切回的位置');

  const s = settings.saveSettings({ temperature: '', maxTokens: '', topP: '', checkEveryX: 0, injectDepth: 99 });
  assert.strictEqual(s.temperature, 0.2, '空温度应回退默认 0.2 而非 0');
  assert.strictEqual(s.maxTokens, 8192, '空 maxTokens 应回退默认 8192');
  assert.strictEqual(s.topP, null, '空 topP 应保持 null');
  assert.strictEqual(s.injectPosition, 0, '默认注入位置应为主提示词内（0）');
  assert.strictEqual(s.checkEveryX, 1, 'checkEveryX 下限 1');
  assert.strictEqual(s.injectDepth, 20, 'injectDepth 上限 20');
  assert.strictEqual(s.engineEnabled, false, '默认关闭大纲模块');
}

// 2. v3 计划归一化幂等、独立 ID 空间、循环依赖校验
{
  const plan = data.normalizePlan({
    title: '青石镇奇案',
    publicSynopsis: '少年入镇查案',
    authorNotes: '幕后黑手是镇长',
    chapters: [
      { id: 'c1', title: '第一章 初抵', goal: '打听线索' },
      { id: 'c2', title: '第二章 破局', goal: '揭穿阴谋' }
    ],
    tracks: [
      { id: 't1', kind: 'main', title: '主线' },
      { id: 't2', kind: 'hidden', title: '镇长暗线' }
    ],
    nodes: [
      { id: 'n1', trackId: 't1', chapterIds: ['c1'], title: '查验水源', publicHint: '镇外古井发臭', completionCriteria: '采集水样', required: true, actors: ['沈清秋'] },
      { id: 'n2', trackId: 't1', chapterIds: ['c2'], dependencies: ['n1'], title: '对质镇长', publicHint: '前往镇公所', completionCriteria: '当众揭穿', required: true },
      { id: 'n3', trackId: 't2', chapterIds: ['c1'], title: '镇长密会', publicHint: '深夜书房灯火未熄', secretNotes: '与北境密使交易', required: false }
    ]
  });
  assert.deepStrictEqual(data.normalizePlan(plan), plan, 'normalizePlan 必须幂等');
  assert.strictEqual(plan.nodes.find(n => n.id === 'n3').revealPublic, false, '暗线节点默认不向台前显露');

  const cyclic = data.validatePlan({
    chapters: [{ id: 'c1', title: '一' }],
    tracks: [{ id: 't1', kind: 'main', title: '主' }],
    nodes: [
      { id: 'a', trackId: 't1', chapterIds: ['c1'], dependencies: ['b'], title: 'A' },
      { id: 'b', trackId: 't1', chapterIds: ['c1'], dependencies: ['a'], title: 'B' }
    ]
  });
  assert.strictEqual(cyclic.valid, false, '必须拦截依赖环');
  assert.ok(cyclic.errors.some(e => e.includes('循环')));
}

// 3. 自动推进章节（无 exitNodeIds 也不会卡死）与手动状态优先
{
  let st = data.commitPlan({
    title: '测试卷',
    chapters: [
      { id: 'c1', title: '第一章', goal: '起步' },
      { id: 'c2', title: '第二章', goal: '收尾' }
    ],
    tracks: [
      { id: 'm', kind: 'main', title: '主线' },
      { id: 's', kind: 'side', title: '支线' }
    ],
    nodes: [
      { id: 'n1', trackId: 'm', chapterIds: ['c1'], title: '必做一', completionCriteria: '达成1', required: true },
      { id: 'n2', trackId: 'm', chapterIds: ['c2'], dependencies: ['n1'], title: '必做二', completionCriteria: '达成2', required: true },
      { id: 's1', trackId: 's', chapterIds: ['c1'], title: '支线一', completionCriteria: '支线达成', required: false }
    ]
  }, 0);
  assert.strictEqual(st.currentChapterId, 'c1');
  assert.strictEqual(data.isNodeUnlocked(st, 'n1'), true);
  assert.strictEqual(data.isNodeUnlocked(st, 'n2'), false, '第二章主线节点在第一章未解锁');
  assert.strictEqual(data.isNodeUnlocked(st, 's1'), true, '支线在起始章已解锁');

  // 完成 n1（楼层 4），自动推进至 c2，且不因缺少 exitNodeIds 卡章
  st.progress.n1 = { status: 'completed', layer: 4, reason: '已完成', updatedAt: Date.now() };
  st = data.saveState(data.advanceChapter(st));
  assert.strictEqual(st.currentChapterId, 'c2', '完成本章必做主线后应自动推进至第二章');
  assert.strictEqual(data.isNodeUnlocked(st, 'n2'), true, '进入第二章且前置完成后 n2 解锁');
  assert.strictEqual(data.isNodeUnlocked(st, 's1'), true, '支线跨章后仍保持有效');
  assert.strictEqual(data.isOutlineFinished(st), false);

  // 手动覆盖优先于自动状态
  st = data.setNodeStatus('n2', 'completed');
  assert.strictEqual(data.getNodeStatus(st, 'n2'), 'completed');
  assert.strictEqual(data.isOutlineFinished(st), true, '末章必做全部完成后应判为完结');

  // 4. 0ms 按楼层号本地回退：删楼至第 2 层，n1 的自动进度撤回，章节回退至 c1，但手动覆盖保留
  const rb = data.rollbackAfterLayer(st, 2);
  assert.strictEqual(rb.removedCount, 1, '应撤回 layer=4 的自动进度');
  assert.strictEqual(rb.chapterChanged, true, '撤回 n1 后当前章应自动回退至 c1');
  assert.strictEqual(rb.state.currentChapterId, 'c1');
  assert.strictEqual(data.getNodeStatus(rb.state, 'n1'), 'pending');
  assert.strictEqual(data.getNodeStatus(rb.state, 'n2'), 'completed', '作者手动状态覆盖不受自动楼层回退影响');
}

// 5. v2 存档无损自动迁移到 v3（保留 v2 原键不覆盖）
{
  currentChat = 'chat-v2-migrate';
  const legacyV2 = {
    schemaVersion: 2,
    revision: 3,
    originChatId: 'chat-v2-migrate',
    currentChapterId: 'ch_1',
    plan: {
      title: '旧版江湖卷',
      synopsis: '完整幕后梗概',
      publicSynopsis: '公开江湖梗概',
      chapters: [{ id: 'ch_1', title: '序幕', goal: '启程', exitNodeIds: ['nd_1'] }],
      tracks: [
        { id: 'tr_m', kind: 'main', title: '主线' },
        { id: 'tr_h', kind: 'hidden', title: '暗线' }
      ],
      nodes: [
        { id: 'nd_1', trackId: 'tr_m', chapterIds: ['ch_1'], title: '初遇', intent: '结识同伴', completionCriteria: '同行', entityRefs: [{ nameSnapshot: '林墨' }] },
        { id: 'nd_2', trackId: 'tr_h', chapterIds: ['ch_1'], title: '暗桩', intent: '内鬼传递消息', notes: '密信暗号', visibility: 'private' }
      ]
    },
    progressEvents: [
      { id: 'ev1', nodeId: 'nd_1', status: 'active', planRevision: 3, validity: 'valid', layer: 2 }
    ],
    clues: [
      { id: 'clue:nd_2', nodeId: 'nd_2', available: true, validity: 'valid', publicHint: '客栈后窗闪过暗号' }
    ]
  };
  storeMap.set(data.V2_STATE_PREFIX + currentChat, JSON.stringify(legacyV2));
  const migrated = data.loadState();
  assert.strictEqual(migrated.schemaVersion, 3);
  assert.strictEqual(migrated.plan.title, '旧版江湖卷');
  assert.strictEqual(migrated.plan.publicSynopsis, '公开江湖梗概');
  assert.ok(migrated.plan.authorNotes.includes('完整幕后梗概'));
  assert.strictEqual(data.getNodeStatus(migrated, 'nd_1'), 'active', 'v2 有效进度应迁移至 v3 progress');
  assert.strictEqual(migrated.progress.nd_1.layer, 2);
  assert.deepStrictEqual([...data.getNode(migrated, 'nd_1').actors], ['林墨']);
  const hiddenMigrated = data.getNode(migrated, 'nd_2');
  assert.strictEqual(hiddenMigrated.revealPublic, true, 'v2 已开放线索应迁移为暗线节点 revealPublic=true');
  assert.strictEqual(hiddenMigrated.publicHint, '客栈后窗闪过暗号');
  assert.ok(hiddenMigrated.secretNotes.includes('密信暗号'));
  assert.ok(storeMap.has(data.V2_STATE_PREFIX + currentChat), '迁移后必须保留原 v2 键作为安全副本');
}

// 6. 跨聊天导入不带入进度，同聊天可保留进度
{
  const exported = data.exportData('chat-v2-migrate');
  currentChat = 'chat-other';
  const cross = data.importData(exported, { includeProgress: true });
  assert.strictEqual(data.getNodeStatus(cross, 'nd_1'), 'pending', '跨聊天导入必须清空运行进度');
  currentChat = 'chat-v2-migrate';
  const same = data.importData(exported, { includeProgress: true });
  assert.strictEqual(data.getNodeStatus(same, 'nd_1'), 'active', '同聊天导入可保留原进度');
}

console.log('outline v3 data & settings tests passed');
