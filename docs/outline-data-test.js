// 离线验证：node docs/outline-data-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const storage = new Map();
let currentChat = 'outline-a';
global.window = global;
global.WORLD_ENGINE_STORE = {
  getItem: key => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key)
};
global.WORLD_ENGINE_CORE = { getChatId: () => currentChat };
for (const file of ['outline-engine-settings.js', 'outline-engine-data.js', 'outline-engine-scheduler.js', 'outline-engine-prompt.js']) {
  vm.runInThisContext(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), { filename: file });
}
const data = OUTLINE_ENGINE_DATA, prompts = OUTLINE_ENGINE_PROMPT;
assert.strictEqual(OUTLINE_ENGINE_SETTINGS.getSettings().engineEnabled, false);
assert.strictEqual(OUTLINE_ENGINE_SETTINGS.getSettings().checkEveryX, 3);
OUTLINE_ENGINE_SETTINGS.patchSettings({ checkEveryX: -1, apiSource: 'unexpected', injectMaxChars: 0 });
assert.strictEqual(OUTLINE_ENGINE_SETTINGS.getSettings().checkEveryX, 1);
assert.strictEqual(OUTLINE_ENGINE_SETTINGS.getSettings().apiSource, 'world');
assert.strictEqual(OUTLINE_ENGINE_SETTINGS.getSettings().injectMaxChars, 200);

const sourcePlan = {
  title: '寻钥匙', synopsis: '寻找遗失的钥匙', constraints: ['保留选择', '不预演结局'],
  chapters: [
    { id: 'chapter-a', title: '第一章', goal: '查到去向', nodes: [
      { id: 'n-a', title: '线索', intent: '调查信件', completionCriteria: '正文明确读到信中的仓库地址。' },
      { id: 'n-b', title: '取钥匙', intent: '进入仓库', completionCriteria: '人物已经取得钥匙。', required: false },
      { id: 'n-free', title: '没有条件', intent: '保留自由发挥', completionCriteria: '' }
    ] },
    { id: 'chapter-b', title: '第二章', goal: '前往门前', nodes: [
      { id: 'n-c', title: '抵达', intent: '前往门前', completionCriteria: '已经到达门前。' }
    ] }
  ]
};
const malformed = data.normalizePlan({ chapters: [{ id: 'same', nodes: [{ id: 'same' }, { id: 'same', required: false }] }, {}] });
const ids = [...malformed.chapters, ...malformed.tracks, ...malformed.nodes].map(item => item.id);
assert.strictEqual(new Set(ids).size, ids.length, '重复及缺失 ID 必须补全为全局唯一');
assert.deepStrictEqual(data.normalizePlan(malformed), malformed, '归一化后的 ID 必须稳定');
assert.strictEqual(malformed.nodes[0].completionCriteria, '');
assert.strictEqual(malformed.nodes[1].required, false);

let state = data.commitPlan(sourcePlan, 0);
assert.strictEqual(state.revision, 1);
assert.strictEqual(state.currentChapterId, 'chapter-a');
assert.strictEqual(state.plan.constraints, '保留选择\n不预演结局');
assert.throws(() => data.commitPlan(sourcePlan, 0), /刷新/);
assert.strictEqual(data.commitPlan(state.plan, 1).revision, 1, '无改动不生成修订');

const event = (id, nodeId, status) => ({ id, nodeId, status, validity: 'valid', planRevision: state.revision,
  nodeRevision: 'hash-string', sourceRefs: [{ chatId: currentChat, messageId: id, hash: id, swipeId: 0 }],
  sourceDigest: id, evidence: [{ messageId: id, quote: '证据' }] });
state.progressEvents = [event('e1', 'n-a', 'completed'), event('e2', 'n-b', 'active'), event('e3', 'n-free', 'completed')];
state.proposals = [{ id: 'p1', status: 'pending', planRevision: 1 }];
state.tracking.pendingRecheck = true;
data.saveState(state);
assert.strictEqual(data.getNodeStatus(data.loadState(), 'n-a'), 'completed');
assert.strictEqual(data.getNodeStatus(data.loadState(), 'n-free'), 'pending', '缺完成条件必须阻止自动完成');
assert.strictEqual(data.loadState().tracking.pendingRecheck, true, '运行时附加tracking字段必须保留');
data.setNodeStatus('n-a', 'blocked');
assert.strictEqual(data.getNodeStatus(data.loadState(), 'n-a'), 'blocked', '手动状态优先');
data.setNodeStatus('n-a', 'pending');
assert.strictEqual(data.getNodeStatus(data.loadState(), 'n-a'), 'pending', '手动待开始同样优先');
data.setNodeStatus('n-a', 'auto');
assert.strictEqual(data.getNodeStatus(data.loadState(), 'n-a'), 'completed');

const edit = data.loadState().plan;
edit.nodes[1].completionCriteria = '钥匙已经装入口袋。';
state = data.commitPlan(edit, 1);
assert.strictEqual(state.revision, 2);
assert.strictEqual(data.getNodeStatus(state, 'n-a'), 'completed', '无改动节点应保留自动进度');
assert.strictEqual(data.getNodeStatus(state, 'n-b'), 'pending', '语义变更节点应撤下旧自动判断');
assert.strictEqual(state.progressEvents[0].planRevision, 2);
assert.strictEqual(state.progressEvents[0].nodeRevision, 'hash-string');
assert.strictEqual(state.progressEvents[1].validity, 'stale');
assert.strictEqual(state.proposals[0].status, 'stale');
data.setNodeStatus('n-free', 'completed');
assert.strictEqual(data.advanceChapter(data.loadState()).currentChapterId, 'chapter-b', '必要节点完成后可切章，可选节点不阻止');
assert.strictEqual(data.loadState().currentChapterId, 'chapter-a', 'advanceChapter为纯计算，不隐式落盘');
data.setCurrentChapter('chapter-b');
assert.strictEqual(data.loadState().currentChapterId, 'chapter-b');
assert.throws(() => data.setCurrentChapter('missing'), /不存在/);
assert.throws(() => data.setNodeStatus('missing', 'completed'), /不存在/);
assert.throws(() => data.setNodeStatus('n-a', 'made-up'), /不支持/);

const exported = data.exportData();
const same = data.importData(exported);
assert.strictEqual(same.currentChapterId, 'chapter-b');
assert.strictEqual(data.getNodeStatus(same, 'n-a'), 'completed', '同聊天完整备份保留进度');
assert.deepStrictEqual(same.progressEvents[0].sourceRefs, exported.state.progressEvents[0].sourceRefs, '原始来源必须保留以便重roll审计');
assert(same.revision > exported.state.revision, '导入递增修订，避免旧请求回写');
currentChat = 'outline-b';
assert.strictEqual(data.loadState().plan.chapters.length, 0, '聊天数据隔离');
state = data.importData(exported, { includeProgress: true });
assert.strictEqual(state.currentChapterId, 'chapter-a');
assert.strictEqual(state.progressEvents.length, 0, '跨聊天即使请求带入进度也不得冒充本聊天既成事实');
assert.deepStrictEqual(state.manualOverrides, {});
assert.strictEqual(state.originChatId, 'outline-b');
assert.strictEqual(data.getNodeStatus(state, 'n-a'), 'pending');
assert(data.loadState('outline-a').progressEvents.length > 0, '导入另一聊天不得修改原聊天');
const isolated = data.defaultState('explicit-chat');
isolated.plan = data.normalizePlan(sourcePlan);
data.saveState(isolated, 'explicit-chat');
assert.strictEqual(data.loadState('explicit-chat').originChatId, 'explicit-chat');
assert.strictEqual(data.loadState().originChatId, 'outline-b');
state = data.importData({ __outlineEnginePlan: true, plan: sourcePlan });
assert.strictEqual(state.progressEvents.length, 0);
assert.throws(() => data.importData({}), /章节/);
state = data.importData({ type: 'outline-engine-data', state: exported.state }, { includeProgress: false });
assert.strictEqual(state.progressEvents.length, 0, '显式纯计划导入必须清空进度');

// 旧版本或外部导入误带请求配置时，正式状态与完整备份都只能保留数据白名单。
const dirty = JSON.parse(JSON.stringify(exported.state));
dirty.originChatId = currentChat;
dirty.apiKey = 'secret-top'; dirty.settings = { apiKey: 'secret-settings' };
dirty.tracking.apiKey = 'secret-tracking';
dirty.tracking.seenAssistantIds = ['m1']; dirty.tracking.anchorMessageId = 'm1';
dirty.tracking.lastProcessedMessageKey = 'm1:hash'; dirty.tracking.recheckStartLayer = 2;
dirty.progressEvents[0].apiKey = 'secret-event';
dirty.progressEvents[0].sourceRefs[0].apiKey = 'secret-ref';
dirty.progressEvents[0].evidence[0].apiKey = 'secret-evidence';
dirty.manualOverrides['n-free'].apiKey = 'secret-manual';
dirty.proposals.push({ id: 'safe-proposal', kind: 'replace_node', chapterId: 'chapter-a', nodeId: 'n-b', status: 'pending',
  planRevision: dirty.revision, apiKey: 'secret-proposal',
  before: { ...dirty.plan.nodes[1], apiKey: 'secret-before' },
  after: { ...dirty.plan.nodes[1], intent: '调整方向', apiKey: 'secret-after' },
  sourceRefs: dirty.progressEvents[0].sourceRefs, evidence: dirty.progressEvents[0].evidence });
const sanitized = data.importData({ type: 'outline-engine-data', state: dirty }, { includeProgress: true });
assert(!JSON.stringify(sanitized).includes('secret-'), '导入不得保留任何层级的未知请求配置');
assert(!JSON.stringify(data.exportData()).includes('secret-'), '完整备份不得重新导出误带的密钥');
assert(!storage.get(data.STATE_PREFIX + currentChat).includes('secret-'), '进入缓存的原始状态必须已经过滤');
assert.strictEqual(sanitized.tracking.anchorMessageId, 'm1');
assert.deepStrictEqual(sanitized.tracking.seenAssistantIds, ['m1']);
assert.strictEqual(sanitized.tracking.lastProcessedMessageKey, 'm1:hash');
assert.strictEqual(sanitized.tracking.recheckStartLayer, 2);
assert.strictEqual(sanitized.progressEvents[0].nodeRevision, 'hash-string');
assert.deepStrictEqual(sanitized.proposals.find(item => item.id === 'safe-proposal').before, dirty.plan.nodes[1], '建议diff必须保留完整节点结构及字段顺序');

const messages = [{ messageId: 'm1', role: 'assistant', content: '她读完信，看到了仓库地址。' }];
const checked = prompts.parseCheckResponse(JSON.stringify({
  nodeUpdates: [
    { nodeId: 'n-a', status: 'completed', evidence: [{ messageId: 'm1', quote: '看到了仓库地址' }] },
    { nodeId: 'n-b', status: 'completed', evidence: [{ messageId: 'm1', quote: '取得了钥匙' }] },
    { nodeId: 'n-free', status: 'completed', evidence: [{ messageId: 'm1', quote: '读完信' }] },
    { nodeId: 'n-c', status: 'completed', evidence: [{ messageId: 'm1', quote: '读完信' }] }
  ],
  proposals: [
    { kind: 'replace_node', chapterId: 'chapter-a', nodeId: 'n-a', after: { intent: '篡改当前节点' }, evidence: [{ messageId: 'm1', quote: '读完信' }] },
    { kind: 'update_chapter', chapterId: 'chapter-b', after: { title: '新章名', nodes: [{ title: '不允许嵌套节点' }] }, evidence: [{ messageId: 'm1', quote: '读完信' }] }
  ]
}), { state, messages });
assert.deepStrictEqual(checked.nodeUpdates.map(item => item.nodeId), ['n-a'], '检查排除假引文、无条件完成与越章完成');
assert.strictEqual(checked.proposals.length, 1, '建议不得改写当前节点');
assert.deepStrictEqual(checked.proposals[0].after, { title: '新章名' }, '章调整不能嵌套重写节点');
const prompt = prompts.buildCheckPrompt({ state, messages, allowProposals: false });
assert(prompt.includes('不是历史事实') && prompt.includes('逐字') && prompt.includes('m1'));
const blocked = prompts.parseCheckResponse({ nodeUpdates: [{ nodeId: 'n-a', status: 'blocked',
  evidence: [{ messageId: 'm1', quote: '读完信' }] }], proposals: [] }, { state, messages });
assert.strictEqual(blocked.nodeUpdates[0].status, 'blocked', '有原文证据的受阻判断应保留');
const organized = prompts.parseOrganizeResponse('```json\n' + JSON.stringify(sourcePlan) + '\n```');
assert.strictEqual(organized.nodes[0].id, 'n-a');
assert(prompts.buildOrganizePrompt('第一章：调查信件').includes('不得自行发明'));
console.log('outline data/settings/prompt tests passed');
