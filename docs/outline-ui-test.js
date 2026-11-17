// node docs/outline-ui-test.js — 独立界面使用真实 settings/data 与最小 DOM，API 完全离线。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rootPath = path.resolve(__dirname, '..');
let activeChat = 'chat-a', face, refreshes = 0, organizeCalls = 0, commits = 0, abortCalls = 0;
const storage = new Map([
  ['world_engine_settings', JSON.stringify({ apiKey: 'world-secret', model: 'world-model' })],
  ['memory_engine_settings', JSON.stringify({ apiKey: 'memory-secret' })]
]);
const writes = [];
const clone = value => JSON.parse(JSON.stringify(value));
const fakeRoot = { contains: () => true };
const sandbox = {
  console, setTimeout, clearTimeout, Date, Math, Map, Set, Blob,
  localStorage: { getItem() { return null; } },
  document: { querySelector() { return fakeRoot; } },
  WORLD_ENGINE_STORE: {
    getItem: key => storage.get(key) ?? null,
    setItem(key, value) { storage.set(key, value); writes.push(key); },
    removeItem: key => storage.delete(key)
  },
  WORLD_ENGINE_CORE: { getChatId: () => activeChat },
  WORLD_ENGINE_UI: {
    registerEngineFace(value) { face = value; },
    refresh() { refreshes++; }
  },
  SillyTavern: { getContext: () => ({ chatId: activeChat }) },
  confirm: () => true
};
sandbox.window = sandbox;
for (const file of ['outline-engine-settings.js', 'outline-engine-data.js', 'outline-engine-ui.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(rootPath, file), 'utf8'), sandbox, { filename: file });
}
const ui = sandbox.OUTLINE_ENGINE_UI, data = sandbox.OUTLINE_ENGINE_DATA, settings = sandbox.OUTLINE_ENGINE_SETTINGS;
const realCommit = data.commitPlan;
data.commitPlan = (...args) => { commits++; return realCommit(...args); };
const fixture = (title = '失落的信件') => data.normalizePlan({ title, synopsis: '寻找真相', constraints: '不提前揭露凶手', chapters: [
  { id: 'c1', title: '第一章', goal: '取得信任', nodes: [{ id: 'n1', title: '见证人', intent: '取得证词', completionCriteria: '证人明确给出证词', notes: '保持悬念', required: true }] },
  { id: 'c2', title: '第二章', goal: '查明线索', nodes: [{ id: 'n2', title: '找信', completionCriteria: '找到信件', required: false }] },
  { id: 'c3', title: '第三章', goal: '结局', nodes: [] }
] });
sandbox.OUTLINE_ENGINE = {
  organizeText: async text => { organizeCalls++; return fixture(text); },
  checkNow: async () => ({ ok: true, checked: true }),
  applyInjection() {}, isRunning: () => false, getRunningLabel: () => '',
  abort() { abortCalls++; }, getLastDebug: () => ({}), getLastError: () => '',
  applyProposal: () => data.loadState(), dismissProposal: () => data.loadState()
};

async function main() {
  ui.init();
  const registered = face;
  ui.init();
  assert.strictEqual(face, registered, '重复初始化不应重复注册');
  assert.strictEqual(face.id, 'outline');
  assert.strictEqual(face.showRedo, false);
  assert.strictEqual(settings.getSettings().engineEnabled, false);
  const initialWrites = writes.length;
  assert.ok(ui.render().includes('剧情模块当前关闭'));
  assert.strictEqual(writes.length, initialWrites, '只读渲染不写状态');
  assert.ok(!/id="we-(?:api|model|fetch-models|save-settings)/.test(ui.render()), '界面不得使用旧设置控件 ID');

  data.commitPlan(fixture(), 0);
  await ui._test.handleAction('edit-plan');
  ui._test.captureInput({ dataset: { outlinePlanField: 'title' }, value: '尚未保存的标题', type: 'text' });
  assert.strictEqual(data.loadState().plan.title, '失落的信件');
  assert.strictEqual(face.isEditing(), true);
  await ui._test.handleAction('close-editor');
  ui.render(); ui.render();
  await ui._test.handleAction('edit-plan');
  assert.ok(ui.render().includes('尚未保存的标题'), '收起、重绘后草稿仍然存在');
  activeChat = 'chat-b';
  assert.ok(!ui.render().includes('尚未保存的标题'), '聊天之间隔离草稿');
  activeChat = 'chat-a';
  assert.ok(ui.render().includes('尚未保存的标题'));
  await ui._test.handleAction('save-plan');
  assert.strictEqual(data.loadState().plan.title, '尚未保存的标题');

  await ui._test.handleAction('edit-plan');
  ui._test.captureInput({ dataset: { outlinePlanField: 'title' }, value: '有冲突的草稿', type: 'text' });
  const newer = fixture('新版本');
  data.commitPlan(newer, data.loadState().revision);
  await assert.rejects(ui._test.handleAction('save-plan'), /大纲已变化|大纲已在其他操作中修改/);
  assert.strictEqual(data.loadState().plan.title, '新版本');
  assert.ok(ui.render().includes('有冲突的草稿'), '版本冲突必须保留待处理草稿');
  await ui._test.handleAction('discard-editor');

  await ui._test.handleAction('edit-plan');
  const sameRevisionDifferentPlan = data.loadState();
  sameRevisionDifferentPlan.plan.title = '同修订号恢复的另一份存档';
  data.saveState(sameRevisionDifferentPlan);
  await assert.rejects(ui._test.handleAction('save-plan'), /大纲已变化/);
  assert.ok(ui.render().includes('查看当前版本'));
  await ui._test.handleAction('rebase-editor');
  await ui._test.handleAction('save-plan');
  assert.strictEqual(data.loadState().plan.title, '新版本', '用户核对后可继续保存保留的草稿');
  await ui._test.handleAction('discard-editor');
  data.commitPlan(newer, data.loadState().revision);

  await ui._test.handleAction('open-text');
  ui._test.captureInput({ id: 'we-outline-source-text', dataset: {}, value: 'AI整理的候选', type: 'textarea' });
  const commitBeforePreview = commits;
  await ui._test.handleAction('organize-text');
  assert.strictEqual(organizeCalls, 1);
  assert.strictEqual(commits, commitBeforePreview, 'API整理只能产生预览');
  assert.strictEqual(data.loadState().plan.title, '新版本');
  assert.ok(ui.render().includes('确认采用整理结果'));
  await ui._test.handleAction('adopt-preview');
  assert.strictEqual(data.loadState().plan.title, 'AI整理的候选');

  const originalWorld = storage.get('world_engine_settings'), originalMemory = storage.get('memory_engine_settings');
  await ui._test.handleAction('toggle-settings');
  ui._test.captureInput({ dataset: { outlineSetting: 'apiSource' }, value: 'custom', type: 'select-one' });
  ui._test.captureInput({ dataset: { outlineSetting: 'apiKey' }, value: 'outline-secret', type: 'password' });
  ui._test.captureInput({ dataset: { outlineSetting: 'checkEveryX' }, value: '7', type: 'number' });
  ui._test.captureInput({ dataset: { outlineSetting: 'apiTimeoutSeconds' }, value: '45', type: 'number' });
  const beforeApiAbort = abortCalls;
  await ui._test.handleAction('save-settings');
  assert.ok(abortCalls > beforeApiAbort, 'API设置变化时必须中止旧请求');
  assert.strictEqual(settings.getSettings(true).apiKey, 'outline-secret');
  assert.strictEqual(settings.getSettings().checkEveryX, 7);
  assert.strictEqual(settings.getSettings().apiTimeoutMs, 45000);
  assert.strictEqual(storage.get('world_engine_settings'), originalWorld, '保存剧情API不改写世界配置');
  assert.strictEqual(storage.get('memory_engine_settings'), originalMemory, '保存剧情API不改写记忆配置');
  await ui._test.handleAction('close-settings');
  face.setEnabled(true);
  const beforePowerAbort = abortCalls;
  face.setEnabled(false);
  assert.ok(abortCalls > beforePowerAbort, '关闭剧情模块必须中止旧请求与自动定时器');
  sandbox.OUTLINE_ENGINE.checkNow = async () => ({ ok: false, reason: 'no-sources' });
  await ui._test.handleAction('check-now');
  assert.ok(ui._test.draftFor().message.includes('新增正文'));
  assert.ok(!ui._test.draftFor().message.includes('no-sources'), '检查原因应显示中文');
  sandbox.OUTLINE_ENGINE.checkNow = async () => ({ ok: false, reason: 'busy' });
  await ui._test.handleAction('check-now');
  assert.ok(ui._test.draftFor().message.includes('任务正在运行'));
  sandbox.OUTLINE_ENGINE.checkNow = async () => ({ ok: true, reason: 'final-chapter-complete' });
  await ui._test.handleAction('check-now');
  assert.ok(ui._test.draftFor().message.includes('全部必要剧情已完成'));

  const hostile = '<img src=x onerror="alert(1)"><script>evil()</script>';
  const hostilePlan = fixture(hostile);
  hostilePlan.chapters[0].nodes[0].completionCriteria = hostile;
  data.commitPlan(hostilePlan, data.loadState().revision);
  let current = data.loadState();
  current.progressEvents.push({ nodeId: 'n1', planRevision: current.revision, status: 'active', validity: 'valid', evidence: [{ messageId: '<5>', quote: hostile }] });
  current.proposals.push({ id: 'p1', status: 'pending', planRevision: current.revision, before: { title: hostile }, after: { title: '新标题' }, reason: hostile });
  data.saveState(current);
  const html = ui.render();
  assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('原内容') && html.includes('建议内容'), '建议必须展示修改前后的差异');
  assert.ok(html.includes('选择手动状态'), '选择相同于自动状态的值仍能显式固定状态');

  ui.bind({ querySelector: () => fakeRoot });
  await fakeRoot.onchange({ target: { dataset: { outlineStatus: 'n1' }, value: 'pending', id: '', type: 'select-one' } });
  assert.strictEqual(data.getNodeStatus(data.loadState(), 'n1'), 'pending');
  assert.strictEqual(data.loadState().manualOverrides.n1.status, 'pending');
  await fakeRoot.onchange({ target: { dataset: { outlineStatus: 'n1' }, value: 'auto', id: '', type: 'select-one' } });
  assert.strictEqual(data.getNodeStatus(data.loadState(), 'n1'), 'active');
  data.setCurrentChapter('c1');
  ui.render();
  await ui._test.handleAction('select-chapter', { dataset: { outlineChapter: 'c1' } });
  await fakeRoot.onchange({ target: { dataset: { outlineStatus: 'n1' }, value: 'completed', id: '', type: 'select-one' } });
  assert.strictEqual(data.loadState().currentChapterId, 'c2', '手动完成全部必要节点，即使注入关闭也应自动下章');
  assert.ok(ui.render().includes('data-outline-node="n2"'), '未主动浏览历史章节时，页面跟随当前章');
  await ui._test.handleAction('select-chapter', { dataset: { outlineChapter: 'c1' } });
  data.setCurrentChapter('c3');
  assert.ok(ui.render().includes('data-outline-node="n1"'), '主动浏览的历史章在自动推进后保持不变');
  await ui._test.handleAction('set-current-chapter', { dataset: { outlineChapter: 'c2' } });
  assert.strictEqual(data.loadState().currentChapterId, 'c2');
  assert.ok(ui.render().includes('data-outline-node="n2"'));

  await assert.rejects(ui._test.importFile({ name: 'bad.html', text: async () => hostile }, 'text'), /仅支持/);
  await assert.rejects(ui._test.importFile({ name: 'bad.json', text: async () => '{' }, 'json'), /JSON 格式无效/);
  await ui._test.importFile({ name: 'draft.md', text: async () => '# 文本导入草稿' }, 'text');
  assert.strictEqual(ui._test.draftFor().sourceText, '# 文本导入草稿');
  let releaseRead;
  const slowRead = ui._test.importFile({ name: 'slow.txt', text: () => new Promise(resolve => { releaseRead = resolve; }) }, 'text');
  activeChat = 'chat-b'; releaseRead('旧聊天迟到的文本');
  await assert.rejects(slowRead, /切换聊天/);
  assert.strictEqual(ui._test.draftFor().sourceText, '');
  activeChat = 'chat-a';
  const foreign = { __outlineEngineData: true, chatId: 'other-chat', state: { ...data.loadState(), plan: fixture('外来计划') } };
  const beforeImport = JSON.stringify(data.loadState());
  await ui._test.importFile({ name: 'foreign.json', text: async () => JSON.stringify(foreign) }, 'json');
  assert.strictEqual(JSON.stringify(data.loadState()), beforeImport, '选择JSON文件后不得立即覆盖');
  assert.strictEqual(ui._test.draftFor().pendingJson.includeProgress, false);
  await ui._test.handleAction('confirm-json-import');
  assert.strictEqual(data.loadState().plan.title, '外来计划');
  assert.strictEqual(Object.keys(data.loadState().manualOverrides).length, 0);
  assert.strictEqual(data.loadState().progressEvents.length, 0);
  assert.ok(refreshes > 0);
  console.log('outline UI tests passed: registration, draft retention, preview confirmation, revision conflict, API isolation, escaping, manual overrides, file validation and cross-chat import');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
