const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
global.window = global;
global.WORLD_ENGINE_STORE = { getItem: () => null, setItem() {} };
global.WORLD_ENGINE_CORE = { getChatId: () => 'scheduler' };
for (const file of ['outline-engine-settings.js', 'outline-engine-data.js', 'outline-engine-scheduler.js']) vm.runInThisContext(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'));
const data = OUTLINE_ENGINE_DATA, scheduler = OUTLINE_ENGINE_SCHEDULER;
const state = data.defaultState();
state.plan = data.normalizePlan({ chapters: [{ id: 'c1' }, { id: 'c2' }], tracks: [
  { id: 'main', kind: 'main', priority: 100 }, { id: 'side', kind: 'side' }, { id: 'hidden', kind: 'hidden' }
], nodes: [
  { id: 'm1', trackId: 'main', chapterIds: ['c1'], completionCriteria: '完成', actorKind: 'npc', completionSource: 'world' },
  { id: 'm2', trackId: 'main', chapterIds: ['c1'], completionCriteria: '完成', actorKind: 'npc', completionSource: 'world' },
  { id: 's1', trackId: 'side', chapterIds: ['c1'], completionCriteria: '完成', actorKind: 'npc', completionSource: 'world' },
  { id: 'h1', trackId: 'hidden', completionCriteria: '完成', publicHint: '安全线索', intent: '秘密真相' },
  { id: 'player', trackId: 'side', chapterIds: ['c1'], completionCriteria: '完成', actorKind: 'player', completionSource: 'either' }
] });
state.currentChapterId = 'c1';
const evaluate = (condition, extra) => scheduler.evaluateConditions(condition, { state, ...(extra || {}) });
assert.strictEqual(evaluate({ all: [false, { type: 'unconfigured', text: '夜晚' }] }).value, 'false');
assert.strictEqual(evaluate({ any: [true, { type: 'unconfigured', text: '夜晚' }] }).value, 'true');
assert.strictEqual(evaluate({ all: [true, '自然语言条件'] }).value, 'unknown');
assert.strictEqual(evaluate('任意代码 global.process.exit()').value, 'unknown');
assert.strictEqual(evaluate({ type: 'authorFlag', flagId: 'flag' }).value, 'unknown');
state.authorFlags.flag = true; assert.strictEqual(evaluate({ type: 'authorFlag', flagId: 'flag' }).value, 'true');
assert.strictEqual(evaluate({ type: 'time', value: '2026-11-17' }).value, 'unknown', '不得拿主机日期冒充故事时间');
assert.strictEqual(evaluate({ type: 'time', value: '2026-11-17', op: 'gte' }, { storyTime: '2026-11-18' }).value, 'true');
assert.strictEqual(evaluate({ type: 'time', value: '2026-11-17' }, { storyTime: { value: '2026-11-18', reliable: false } }).value, 'unknown');
assert.strictEqual(evaluate({ type: 'time', value: '2026-02-30' }, { storyTime: '2026-03-01' }).value, 'unknown');
assert.strictEqual(evaluate({ type: 'time', value: '帝国历三年' }, { storyTime: '帝国历四年' }).value, 'unknown');
assert.strictEqual(evaluate({ type: 'time', basis: 'storyDay', value: 3, op: 'gte' }, { worldState: { time: 4 } }).value, 'true', '已提交world.time可直接调度总故事天数');
assert.strictEqual(evaluate({ type: 'time', basis: 'storyDay', value: 3, op: 'gte' }, { worldState: { time: 2 } }).value, 'false');
assert.strictEqual(evaluate({ type: 'time', basis: 'storyDay', value: 3, op: 'gte' }, { worldState: { time: 3 } }).value, 'true');
assert.strictEqual(evaluate({ type: 'time', basis: 'storyDay', value: 3 }, { worldState: {} }).value, 'unknown', '重放基底缺时间时不得猜当前天数');
assert.strictEqual(evaluate({ type: 'time', basis: 'storyDay', value: null }, { worldState: { time: 4 } }).value, 'unknown');
assert.strictEqual(evaluate({ type: 'time', basis: 'storyDay', value: 3 }, { worldState: { time: '4' } }).value, 'unknown', '未解析的时间字符串不冒充已提交数字');
assert.strictEqual(evaluate({ type: 'time', basis: 'calendar', value: '2026-11-17' }, { worldState: { time: 100 } }).value, 'unknown', '总天数不能冒充日历来源');
assert.strictEqual(data.normalizeCondition({ type: 'time', basis: 'storyDay', value: 3 }).value, 3);
const field = { type: 'worldField', collection: 'factions', entityId: 'f1', field: 'power', op: 'gte', value: 3 };
assert.strictEqual(evaluate(field, { worldState: { factions: [{ id: 'f1', power: 4 }] } }).value, 'true');
assert.strictEqual(evaluate(field, { worldState: { factions: [{ id: 'wrong', name: 'f1', power: 4 }] } }).value, 'unknown', '名字相同不能替代稳定ID');
assert.strictEqual(evaluate({ ...field, field: '__proto__.power' }, { worldState: { factions: [{ id: 'f1' }] } }).value, 'unknown');
assert.strictEqual(evaluate({ type: 'nodeStatus', nodeId: 'lost' }).value, 'unknown');
state.manualOverrides.m1 = { status: 'skipped' };
assert.strictEqual(evaluate({ type: 'nodeStatus', nodeId: 'm1' }).value, 'false');
assert.strictEqual(evaluate({ type: 'nodeStatus', nodeId: 'm1', allowSkipped: true }).value, 'true');
delete state.manualOverrides.m1;
const before = JSON.stringify(state), selection = scheduler.select(state, { channel: 'world', limit: 20 });
assert.strictEqual(JSON.stringify(state), before, '调度不隐式修改运行state');
assert(selection.nodeIds.includes('h1') && selection.nodeIds.includes('s1'));
assert(!selection.nodeIds.includes('player'), '后台不能执行主角行为');
assert.strictEqual(selection.selected.filter(node => node.trackId === 'main').length, 1, '每线每worldtick最多一个节点');
assert(selection.explanations.some(item => item.nodeId === 'm2' && item.reasons.includes('one_node_per_track_tick')));
state.currentChapterId = 'c2';
const later = scheduler.select(state, { channel: 'world', limit: 20 });
assert(later.nodeIds.includes('s1') && later.nodeIds.includes('h1'), '切章后旧支线/暗线持续');
assert(!later.nodeIds.includes('m1'), '主线阶段门仍然有效');
state.plan.tracks.find(track => track.id === 'side').paused = true;
assert(!scheduler.select(state, { channel: 'world', limit: 20 }).nodeIds.includes('s1'));
state.plan.tracks.find(track => track.id === 'side').paused = false;
assert(!scheduler.select(state, { channel: 'narrative', limit: 20 }).nodeIds.includes('h1'), '未开放线索不能因publicHint存在而泄露暗线');
state.clues = [{ id: 'clue', nodeId: 'h1', available: true, publicHint: '一封信', validity: 'valid' }];
assert(scheduler.select(state, { channel: 'narrative', limit: 20 }).nodeIds.includes('h1'));
assert.strictEqual(evaluate({ type: 'clueContact', clueId: 'clue' }).value, 'false', '可发现不等于接触');
state.contacts = [{ id: 'contact', clueId: 'clue', actorId: 'hero', validity: 'valid' }];
assert.strictEqual(evaluate({ type: 'clueContact', clueId: 'clue', actorId: 'hero' }).value, 'true');
assert.strictEqual(evaluate({ type: 'clueContact', clueId: 'clue', actorId: 'npc' }).value, 'false');
state.currentChapterId = 'c1'; OUTLINE_ENGINE_SETTINGS.patchSettings({ cooldownTicks: 0 });
const served = new Set();
for (let i = 0; i < 20; i++) { const result = scheduler.select(state, { channel: 'world', limit: 1, advanceTick: true }); result.nodeIds.forEach(id => served.add(id)); state.scheduler = result.scheduler; }
assert(served.has('s1') && served.has('h1'), '等待轮转防止高优先级主线饿死其他线');
assert(state.scheduler.tick === 20);
state.recovery.status = 'blocked'; assert.strictEqual(scheduler.select(state, { channel: 'world' }).selected.length, 0);
console.log('outline scheduler tests passed');
