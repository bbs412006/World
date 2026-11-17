const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const storage = new Map(); let chatId = 'migration';
global.window = global;
global.WORLD_ENGINE_STORE = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
global.WORLD_ENGINE_CORE = { getChatId: () => chatId };
vm.runInThisContext(fs.readFileSync(path.resolve(__dirname, '..', 'outline-engine-data.js'), 'utf8'));
const data = OUTLINE_ENGINE_DATA;
const old = { schemaVersion: 1, revision: 7, originChatId: chatId, currentChapterId: 'c1',
  plan: { title: '旧长篇', synopsis: '原简介', constraints: '原约束', chapters: [{ id: 'c1', title: '旧章', goal: '离开', nodes: [
    { id: 'old-a', title: '取钥匙', completionCriteria: '已经取得钥匙' }, { id: 'old-b', title: '可选拜访', required: false }
  ] }] }, progressEvents: [{ id: 'e', nodeId: 'old-a', status: 'completed', planRevision: 7, validity: 'valid', sourceRefs: [{ chatId, messageId: 'm1', hash: 'h1' }] }],
  proposals: [{ id: 'p', kind: 'replace_node', status: 'pending', before: {}, after: {} }], manualOverrides: {} };
const oldRaw = JSON.stringify(old); storage.set(data.LEGACY_STATE_PREFIX + chatId, oldRaw);
let state = data.loadState();
assert.strictEqual(state.schemaVersion, 2); assert.strictEqual(state.revision, 7);
assert.strictEqual(storage.get(data.LEGACY_STATE_PREFIX + chatId), oldRaw, 'v1原始存档完全保留');
assert(storage.has(data.STATE_PREFIX + chatId));
assert.deepStrictEqual(state.plan.nodes.map(node => node.id), ['old-a', 'old-b']);
assert.deepStrictEqual(state.plan.chapters[0].exitNodeIds, ['old-a']);
assert.strictEqual(state.plan.tracks[0].id, 'legacy-main');
assert.deepStrictEqual(state.plan.nodes[1].dependencies, [], '旧顺序不虚构依赖');
assert.strictEqual(state.plan.nodes[0].completionSource, 'dialogue');
assert.strictEqual(state.plan.publicSynopsis, '原简介');
assert.strictEqual(data.getNodeStatus(state, 'old-a'), 'completed');
assert.strictEqual(state.proposals[0].status, 'stale');
const collision = data.normalizeState({ ...old, plan: { chapters: [{ id: 'chapter', nodes: [{ id: 'legacy-main', completionCriteria: '条件' }] }] } });
assert.strictEqual(collision.plan.nodes[0].id, 'legacy-main', '迁移新增线ID不能抢占旧节点ID');
storage.set(data.LEGACY_STATE_PREFIX + chatId, JSON.stringify({ ...old, revision: 999 }));
assert.strictEqual(data.loadState().revision, 7, '只首次迁移，不让旧设备数据覆盖v2');
assert.throws(() => data.normalizeState({ schemaVersion: 3 }), /更新版本/);
assert.throws(() => data.importData({ schemaVersion: 99, plan: old.plan }), /更新版本/);

chatId = 'multi';
const plan = { title: '多线', synopsis: '私密总纲', constraints: '私密约束', publicSynopsis: '公开方向', chapters: [
  { id: 'c1', title: '阶段一', exitNodeIds: ['a'] }, { id: 'c2', title: '阶段二', exitNodeIds: [] }
], tracks: [{ id: 'main', kind: 'main' }, { id: 'side', kind: 'side' }, { id: 'secret', kind: 'hidden' }], nodes: [
  { id: 'a', trackId: 'main', chapterIds: ['c1'], completionCriteria: '得到信件' },
  { id: 'b', trackId: 'side', chapterIds: ['c1', 'c2'], dependencies: [{ nodeId: 'a' }], completionCriteria: '送达信件' },
  { id: 'c', trackId: 'secret', chapterIds: [], intent: '幕后伪造', completionCriteria: '已经伪造' }
] };
state = data.commitPlan(plan, 0);
assert.deepStrictEqual(data.getChapterNodes(state.plan, 'c2').map(node => node.id), ['b']);
assert.deepStrictEqual(data.getTrackNodes(state.plan, 'secret').map(node => node.id), ['c']);
assert.strictEqual(state.plan.nodes[2].visibility, 'private');
assert.strictEqual(state.plan.nodes[2].actorKind, 'npc');
assert.strictEqual(state.plan.nodes[2].disclosure.condition.type, 'unconfigured', '未配揭露条件不能默认公开');
assert(!('nodes' in state.plan.chapters[0]), '节点仅有一个canonical来源');
state.progressEvents = state.plan.nodes.map(node => ({ id: 'event-' + node.id, nodeId: node.id, status: 'completed', validity: 'valid', planRevision: state.revision,
  evidence: [{ kind: node.id === 'c' ? 'world_fact' : 'dialogue', commitId: 'commit', factId: 'fact', hash: 'h', messageId: 'msg', quote: '原文' }] }));
state.privateFacts = [{ id: 'fact', commitId: 'commit', factHash: 'hash', nodeId: 'c', trackId: 'secret', text: '真正幕后事实', knownBy: [], validity: 'valid', apiKey: 'DROP-ME' }];
state.clues = [{ id: 'clue', factIds: ['fact'], nodeId: 'c', publicHint: '一封封口信', available: true, validity: 'valid' }];
state.contacts = [{ id: 'contact', clueId: 'clue', actorId: 'hero', quote: '看见封口信', validity: 'valid' }];
state.knowledge = [{ id: 'knowledge', factId: 'fact', actorId: 'hero', contactId: 'contact', commitId: 'commit', validity: 'valid' }];
state.authorFlags = { authored: true }; data.saveState(state);
const snapshot = data.captureAutomaticState(state);
assert(!('plan' in snapshot) && !('manualOverrides' in snapshot) && !('authorFlags' in snapshot));
assert(!JSON.stringify(snapshot._nodeSignatures).includes('幕后伪造'), '基底只存计划摘要哈希，不暗存作者计划');
data.setNodeStatus('b', 'blocked');
const changed = data.loadState().plan; changed.nodes[0].completionCriteria = '得到原件信件';
state = data.commitPlan(changed, state.revision);
assert.strictEqual(data.getNodeStatus(state, 'a'), 'pending');
assert.strictEqual(data.getNodeStatus(state, 'b'), 'blocked');
assert.strictEqual(state.progressEvents[1].validity, 'stale', '仅沿依赖撤回');
assert.strictEqual(data.getNodeStatus(state, 'c'), 'completed', '无关暗线保留进度');
const restored = data.restoreAutomaticState(state, snapshot);
assert.strictEqual(restored.plan.nodes[0].completionCriteria, '得到原件信件', '恢复自动态不覆盖作者修改');
assert.strictEqual(restored.manualOverrides.b.status, 'blocked');
assert.strictEqual(restored.authorFlags.authored, true);
assert.strictEqual(data.getNodeStatus(restored, 'a'), 'pending');
assert.strictEqual(restored.progressEvents[1].validity, 'stale', '恢复旧自动基底同样沿作者改动的依赖撤回');
assert.strictEqual(data.getNodeStatus(restored, 'c'), 'completed');
assert.strictEqual(restored.privateFacts[0].text, '真正幕后事实');
assert(!JSON.stringify(data.exportData()).includes('DROP-ME'));
const full = data.exportData(); chatId = 'foreign'; state = data.importData(full, { includeProgress: true });
for (const key of ['progressEvents', 'privateFacts', 'clues', 'contacts', 'knowledge']) assert.strictEqual(state[key].length, 0, '跨chat清空运行态：' + key);
assert.strictEqual(state.plan.nodes.length, 3);
const dangling = data.normalizePlan({ ...plan, nodes: [{ ...plan.nodes[0], trackId: 'missing', chapterIds: ['missing'], dependencies: ['lost'] }] });
const validation = data.validatePlan(dangling); assert(validation.valid && validation.warnings.length >= 3, '缺引用明确报告，不能假装条件满足');
assert.strictEqual(data.validatePlan({ ...plan, nodes: [plan.nodes[0], plan.nodes[0]] }).valid, false, '重复ID不得悄悄改引用');
const cycle = clone => ({ ...clone, nodes: [{ ...clone.nodes[0], dependencies: ['b'] }, { ...clone.nodes[1], dependencies: ['a'] }] });
assert.strictEqual(data.validatePlan(cycle(plan)).valid, false);
console.log('outline v2 migration/data tests passed');
