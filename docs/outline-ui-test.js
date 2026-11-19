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
const downloads=[];
const sandbox = {
  console, setTimeout, clearTimeout, Date, Math, Map, Set, Blob,
  localStorage: { getItem() { return null; } },
  document: { querySelector() { return fakeRoot; }, createElement() { return { click() {} }; } },
  URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:offline-test'; }, revokeObjectURL() {} },
  WORLD_ENGINE_STORE: {
    getItem: key => storage.get(key) ?? null,
    setItem(key, value) { storage.set(key, value); writes.push(key); },
    removeItem: key => storage.delete(key)
  },
  WORLD_ENGINE_CORE: { getChatId: () => activeChat, loadState: () => ({ events:[{id:'ev-stable',name:'封城',level:2}] }) },
  MEMORY_ENGINE_DATA: { loadState: () => ({ personal_memory:[{id:'person-stable',names:['守门人']}],entity_memory:{} }) },
  WORLD_ENGINE_UI: {
    registerEngineFace(value) { face = value; },
    refresh() { refreshes++; }
  },
  SillyTavern: { getContext: () => ({ chatId: activeChat }) },
  confirm: () => true
};
sandbox.window = sandbox;
for (const file of ['outline-engine-settings.js', 'outline-engine-data.js', 'outline-engine-scheduler.js', 'outline-engine-ui.js']) {
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
sandbox.OUTLINE_ENGINE.getSchedule=channel=>sandbox.OUTLINE_ENGINE_SCHEDULER.select(data.loadState(),{channel,worldState:sandbox.WORLD_ENGINE_CORE.loadState()});
sandbox.OUTLINE_ENGINE.buildNarrativeGuidance=()=> '只包含已允许的公开提示';
sandbox.OUTLINE_ENGINE.buildWorldGuidance=()=> '后台作者指导：保留幕后安排';

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
  const settingsPanelHtml = ui.render();
  assert.ok(settingsPanelHtml.includes('we-outline-stream') && !settingsPanelHtml.includes('API 来源'), '剧情大纲 API 应提供流式勾选框并移除 API 来源');
  ui._test.captureInput({ dataset: { outlineSetting: 'stream' }, checked: true, type: 'checkbox' });
  ui._test.captureInput({ dataset: { outlineSetting: 'apiKey' }, value: 'outline-secret', type: 'password' });
  ui._test.captureInput({ dataset: { outlineSetting: 'checkEveryX' }, value: '7', type: 'number' });
  ui._test.captureInput({ dataset: { outlineSetting: 'apiTimeoutSeconds' }, value: '45', type: 'number' });
  const beforeApiAbort = abortCalls;
  await ui._test.handleAction('save-settings');
  assert.ok(abortCalls > beforeApiAbort, 'API设置变化时必须中止旧请求');
  assert.strictEqual(settings.getSettings(true).apiKey, 'outline-secret');
  assert.strictEqual(settings.getSettings().stream, true);
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
  hostilePlan.nodes[0].completionCriteria = hostile;
  data.commitPlan(hostilePlan, data.loadState().revision);
  let current = data.loadState();
  current.progressEvents.push({ nodeId: 'n1', planRevision: current.revision, status: 'active', validity: 'valid', evidence: [{ messageId: '<5>', quote: hostile }] });
  current.proposals.push({ id: 'p1', status: 'pending', planRevision: current.revision, before: { title: hostile }, after: { title: '新标题' }, reason: hostile });
  data.saveState(current);
  // 当前位置与 AI 建议已从首页下沉到「进度」分页
  await ui._test.handleAction('view-progress');
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

  // 完整多线编辑流程使用 canonical nodes、真实条件解释器和数据校验。
  await ui._test.handleAction('edit-plan');
  await ui._test.handleAction('track-add');
  let draft=ui._test.draftFor();
  const ti=draft.plan.tracks.length-1;
  ui._test.captureInput({dataset:{outlineTrackField:'title',outlineTi:String(ti)},value:'幕后支援',type:'text'});
  ui._test.captureInput({dataset:{outlineTrackField:'kind',outlineTi:String(ti)},value:'hidden',type:'select-one'});
  ui._test.captureInput({dataset:{outlineTrackField:'priority',outlineTi:String(ti)},value:'8',type:'number'});
  const trackId=draft.plan.tracks[ti].id;
  await ui._test.handleAction('node-add',{dataset:{outlineTrack:trackId}});
  const added=draft.plan.nodes[draft.plan.nodes.length-1],nodeId=added.id;
  assert.strictEqual(added.visibility,'private');
  assert.strictEqual(added.completionSource,'world');
  ui._test.captureInput({dataset:{outlineNodeField:'title',outlineNid:nodeId},value:'安排安全屋',type:'text'});
  ui._test.captureInput({dataset:{outlineNodeField:'completionCriteria',outlineNid:nodeId},value:'世界账本记载安全屋完成布置',type:'text'});
  ui._test.captureInput({dataset:{outlineNodeList:'chapterIds',outlineNid:nodeId},value:'c2',checked:true,type:'checkbox'});
  ui._test.captureInput({dataset:{outlineNodeList:'dependencies',outlineNid:nodeId},value:'n1',checked:true,type:'checkbox'});
  ui._test.captureInput({dataset:{outlineDependencySkip:'n1',outlineNid:nodeId},checked:true,type:'checkbox'});
  const conditionDS={outlineNid:nodeId,outlineConditionSlot:'trigger',outlineConditionPath:'[]'};
  ui._test.captureInput({dataset:{...conditionDS,outlineConditionType:'true'},value:'all',type:'select-one'});
  await ui._test.handleAction('condition-add',{dataset:conditionDS});
  ui._test.captureInput({dataset:{...conditionDS,outlineConditionPath:'[0]',outlineConditionType:'true'},value:'nodeStatus',type:'select-one'});
  ui._test.captureInput({dataset:{...conditionDS,outlineConditionPath:'[0]',outlineConditionField:'nodeId'},value:'n1',type:'select-one'});
  await ui._test.handleAction('condition-add',{dataset:conditionDS});
  ui._test.captureInput({dataset:{...conditionDS,outlineConditionPath:'[1]',outlineConditionType:'true'},value:'authorFlag',type:'select-one'});
  ui._test.captureInput({dataset:{...conditionDS,outlineConditionPath:'[1]',outlineConditionField:'flagId'},value:'open-safehouse',type:'text'});
  ui._test.captureInput({dataset:{outlineDisclosureText:'true',outlineNid:nodeId},value:'门边有一枚新的月牙印记',type:'textarea'});
  ui._test.captureInput({dataset:{outlineChapterList:'exitNodeIds',outlineCi:'1'},value:nodeId,checked:true,type:'checkbox'});
  ui._test.captureInput({dataset:{outlineEntityPick:'true',outlineNid:nodeId},value:JSON.stringify({source:'world',originChatId:activeChat,type:'events',id:'ev-stable',nameSnapshot:'封城'}),type:'select-one'});
  await ui._test.handleAction('entity-add',{dataset:{outlineNid:nodeId}});
  assert.strictEqual(added.entityRefs[0].id,'ev-stable');
  assert.strictEqual(added.dependencies[0].allowSkipped,true);
  assert.ok(ui.render().includes('以下全部满足'));
  const beforeSave=abortCalls;
  await ui._test.handleAction('save-plan');
  assert.ok(abortCalls>beforeSave,'保存计划会取消旧请求');
  const canonical=data.loadState().plan;
  assert.strictEqual(canonical.nodes.find(node=>node.id===nodeId).trigger.all[1].flagId,'open-safehouse');
  assert.ok(canonical.chapters[1].exitNodeIds.includes(nodeId));
  assert.ok(!Object.prototype.hasOwnProperty.call(canonical.chapters[0],'nodes'),'章节不复制canonical节点');
  await ui._test.handleAction('view-tracks');
  assert.ok(ui.render().includes('幕后支援')&&ui.render().includes('作者私密内容'));
  await ui._test.handleAction('track-pause',{dataset:{outlineTrack:trackId}});
  assert.strictEqual(data.loadState().plan.tracks.find(track=>track.id===trackId).paused,true);
  assert.ok(ui.render().includes('作者暂停'));
  await ui._test.handleAction('view-schedule');
  const scheduleHtml=ui.render();
  assert.ok(scheduleHtml.includes('正文实际会收到的指导')&&scheduleHtml.includes('世界后台实际会收到的指导'));
  assert.ok(scheduleHtml.includes('只包含已允许的公开提示'));
  assert.ok(!scheduleHtml.includes('track_paused'),'调度机器原因码应被翻译');

  await ui._test.handleAction('view-facts');
  ui._test.captureInput({id:'we-outline-flag-name',dataset:{},value:'open-safehouse',type:'text'});
  await ui._test.handleAction('author-flag-add');
  assert.strictEqual(data.loadState().authorFlags['open-safehouse'],true);
  let factState=data.loadState();
  factState.privateFacts=[{id:'f1',text:'幕后事实 <script>不可执行</script>',commitId:'j1',validity:'valid',knownBy:[]}];
  factState.clues=[{id:'cl1',nodeId,publicHint:'月牙印记',available:true,status:'available',validity:'valid',contacts:[],knownBy:[]}];
  factState.tracking.temporalNotice={kind:'dream',reason:'正文明确是梦境',evidence:[{messageId:'m1',quote:'他从梦中醒来'}]};
  data.saveState(factState);
  const factsHtml=ui.render();
  assert.ok(factsHtml.includes('后台私密事实')&&factsHtml.includes('可发现')&&factsHtml.includes('实际接触记录 0'));
  assert.ok(factsHtml.includes('&lt;script&gt;不可执行&lt;/script&gt;'));
  assert.ok(factsHtml.includes('梦境片段'));

  let restores=0,rebuilds=0,audits=0,bundleImports=0;
  const bundle={type:'story-engine-bundle',schemaVersion:2,bundle:{schemaVersion:2,chatId:activeChat,baseline:{id:'baseline'},journal:[{id:'j1'}]},outline:{plan:clone(data.loadState().plan)}};
  sandbox.STORY_ENGINE_HISTORY={
    getStatus:()=>({phase:'pending-rebuild',baselineLayer:0,recoverableFromLayer:0,lastValidLayer:2,pendingFromLayer:3,currentCommitId:'j1',branchId:'b1',journalCount:1,snapshotCount:1}),
    listCommits:()=>[{id:'j1',branchId:'b1',kind:'world',layer:2,status:'valid'}],
    reconcile(){audits++;},restoreCommit(id){assert.strictEqual(id,'j1');restores++;},rebuild:async()=>{rebuilds++;},
    exportBundle:()=>clone(bundle),importBundle:()=>{bundleImports++;}
  };
  await ui._test.handleAction('view-recovery');
  assert.ok(ui.render().includes('等待显式重建')&&ui.render().includes('完整 journal'));
  assert.strictEqual(restores+rebuilds+audits,0,'查看恢复页不能自动恢复或调用重建');
  await ui._test.handleAction('history-audit');
  await ui._test.handleAction('history-restore',{dataset:{outlineCommit:'j1'}});
  await ui._test.handleAction('history-rebuild');
  assert.strictEqual(audits,1);assert.strictEqual(restores,1);assert.strictEqual(rebuilds,1);
  await ui._test.handleAction('export-full');
  const exported=JSON.parse(await downloads[downloads.length-1].text());
  assert.strictEqual(exported.schemaVersion,2);
  assert.strictEqual(exported.bundle.type,'story-engine-bundle','完整联动JSON必须包含journal');
  await ui._test.handleAction('export-plan');
  const exportedPlan=JSON.parse(await downloads[downloads.length-1].text());
  assert.strictEqual(exportedPlan.schemaVersion,2);assert.ok(!exportedPlan.state&&!exportedPlan.bundle);
  await ui._test.importFile({name:'linked.json',text:async()=>JSON.stringify(exported)},'json');
  assert.strictEqual(bundleImports,0,'选择联合文件不能直接恢复');
  ui._test.captureInput({id:'we-outline-import-progress',dataset:{},checked:true,type:'checkbox'});
  await ui._test.handleAction('confirm-json-import');
  assert.strictEqual(bundleImports,1,'同聊天明确选择进度才恢复联合journal');
  await assert.rejects(ui._test.importFile({name:'future.json',text:async()=>JSON.stringify({...exported,schemaVersion:99})},'json'),/更新的数据版本/);
  await ui._test.importFile({name:'history.json',text:async()=>JSON.stringify(bundle)},'json');
  assert.strictEqual(ui._test.draftFor().pendingJson.kind,'history');
  assert.ok(ui.render().includes('确认联合历史恢复'));
  await ui._test.handleAction('confirm-json-import');
  assert.strictEqual(bundleImports,2);
  const foreignCombined={...exported,chatId:'foreign',state:{...exported.state,originChatId:'foreign'}};
  await ui._test.importFile({name:'foreign-linked.json',text:async()=>JSON.stringify(foreignCombined)},'json');
  ui._test.draftFor().pendingJson.includeProgress=true;
  await ui._test.handleAction('confirm-json-import');
  assert.strictEqual(bundleImports,2,'跨聊天即使勾选进度也不能恢复来源journal');
  assert.strictEqual(data.loadState().privateFacts.length,0);

  let quarantine=null;
  sandbox.MEMORY_ENGINE={getQuarantineBackup:()=>quarantine};
  await ui._test.handleAction('view-recovery');
  assert.ok(!ui.render().includes('data-outline-action="memory-quarantine-export"'),'没有隔离备份时不显示导出按钮');
  quarantine={type:'memory-engine-quarantine-backup',version:1,chatId:activeChat,reason:'从头重建保留的旧资料',state:{personal_memory:[{names:['旧人物'],memory:{旧日:['完整旧资料']}}]}};
  assert.ok(ui.render().includes('旧记忆资料待作者复核'));
  assert.ok(ui.render().includes('data-outline-action="memory-quarantine-export"'));
  await ui._test.handleAction('memory-quarantine-export');
  assert.strictEqual(JSON.parse(await downloads[downloads.length-1].text()).state.personal_memory[0].memory.旧日[0],'完整旧资料');

  let releaseRestore;
  sandbox.WORLD_ENGINE_CHATCACHE={forScope:()=>({restoreSnapshot:()=>new Promise(resolve=>{releaseRestore=resolve;})})};
  ui._test.draftFor().message='恢复尚未完成';
  const restoring=ui._test.handleAction('snapshot-restore',{dataset:{outlineSnapshot:'saved'}});
  assert.strictEqual(ui._test.draftFor().message,'恢复尚未完成','异步保存点恢复完成前不能提示成功');
  releaseRestore(true);await restoring;
  assert.strictEqual(ui._test.draftFor().message,'剧情存档已恢复。');
  sandbox.WORLD_ENGINE_CHATCACHE={forScope:()=>({restoreSnapshot:async()=>{throw new Error('IDB 写入失败');}})};
  ui._test.draftFor().message='准备恢复';
  await assert.rejects(ui._test.handleAction('snapshot-restore',{dataset:{outlineSnapshot:'saved'}}),/IDB 写入失败/);
  assert.strictEqual(ui._test.draftFor().message,'准备恢复','持久化失败不能出现成功提示');

  let releaseFlush;
  sandbox.WORLD_ENGINE_STORE.flush=()=>new Promise(resolve=>{releaseFlush=resolve;});
  await ui._test.importFile({name:'plan.json',text:async()=>JSON.stringify(exportedPlan)},'json');
  const importing=ui._test.handleAction('confirm-json-import');
  assert.ok(ui._test.draftFor().pendingJson,'落盘未完成前保留导入预览');
  assert.notStrictEqual(ui._test.draftFor().message,'已按确认范围完成导入。');
  releaseFlush();await importing;
  assert.strictEqual(ui._test.draftFor().pendingJson,null);
  sandbox.WORLD_ENGINE_STORE.flush=async()=>{throw new Error('flush 写入失败');};
  await ui._test.importFile({name:'plan.json',text:async()=>JSON.stringify(exportedPlan)},'json');
  await assert.rejects(ui._test.handleAction('confirm-json-import'),/flush 写入失败/);
  assert.ok(ui._test.draftFor().pendingJson,'落盘失败保留待确认文件供重试');
  assert.notStrictEqual(ui._test.draftFor().message,'已按确认范围完成导入。');

  let releaseHistoryFlush;
  sandbox.WORLD_ENGINE_STORE.flush=()=>new Promise(resolve=>{releaseHistoryFlush=resolve;});
  const restoringHistory=ui._test.handleAction('history-restore',{dataset:{outlineCommit:'j1'}});
  await Promise.resolve();
  assert.notStrictEqual(ui._test.draftFor().message,'已恢复联合提交，后续原文需显式批量重建。','联合历史也必须等待IDB落盘');
  releaseHistoryFlush();await restoringHistory;
  assert.strictEqual(ui._test.draftFor().message,'已恢复联合提交，后续原文需显式批量重建。');
  sandbox.WORLD_ENGINE_STORE.flush=async()=>{throw new Error('历史 IDB 写入失败');};
  await ui._test.handleAction('history-restore',{dataset:{outlineCommit:'j1'}});
  assert.ok(ui._test.draftFor().error&&ui._test.draftFor().message.includes('历史 IDB 写入失败'));
  let stoppedLinked=0;
  const originalHistoryStatus=sandbox.STORY_ENGINE_HISTORY.getStatus;
  sandbox.STORY_ENGINE_HISTORY.getStatus=()=>({phase:'rebuilding'});
  sandbox.WORLD_ENGINE={abortLinkedRebuild(){stoppedLinked++;}};
  assert.strictEqual(face.isRunning(),true);
  assert.strictEqual(face.getRunningLabel(),'联合历史重建');
  await ui._test.handleAction('abort');
  assert.strictEqual(stoppedLinked,1,'重建期间停止按钮必须中止世界重建循环');
  sandbox.STORY_ENGINE_HISTORY.getStatus=originalHistoryStatus;
  assert.ok(ui.render().includes('世界与剧情自动状态，并撤下失效的来源记忆'));
  let baselineResets=0,timelineFlushes=0,releaseResetFlush;
  sandbox.STORY_ENGINE_HISTORY.getStatus=()=>({phase:'blocked',blocked:true,reason:'正文早于启用基底或稳定消息身份已丢失',baselineLayer:2,recoverableFromLayer:2,lastValidLayer:2});
  sandbox.STORY_ENGINE_HISTORY.resetBaseline=()=>{baselineResets++;};
  sandbox.MEMORY_ENGINE_TIMELINE={...(sandbox.MEMORY_ENGINE_TIMELINE||{}),flushSave:async()=>{timelineFlushes++;}};
  sandbox.WORLD_ENGINE_STORE.flush=()=>new Promise(resolve=>{releaseResetFlush=resolve;});
  const blockedRecoveryHtml=ui.render();
  assert.ok(blockedRecoveryHtml.includes('data-outline-action="history-reset-baseline"')&&blockedRecoveryHtml.includes('保留当前世界重设基线'),'受阻时必须展示「保留当前世界重设基线」按钮与恢复指引');
  const resettingBaseline=ui._test.handleAction('history-reset-baseline');
  for(let i=0;i<20&&!releaseResetFlush;i++)await Promise.resolve();
  assert.strictEqual(typeof releaseResetFlush,'function','重设基线必须等待 store.flush 落盘');
  assert.notStrictEqual(ui._test.draftFor().message,'已保留当前世界并重设联合历史基线（消息身份与存档已固化保存）。','重设基线未等待存档落盘前不得先提示完成');
  releaseResetFlush();await resettingBaseline;
  assert.strictEqual(baselineResets,1);
  assert.strictEqual(timelineFlushes,1,'重设基线必须立即刷新并保存每层消息稳定身份 ID');
  assert.strictEqual(ui._test.draftFor().message,'已保留当前世界并重设联合历史基线（消息身份与存档已固化保存）。');
  sandbox.STORY_ENGINE_HISTORY.getStatus=originalHistoryStatus;
  await ui._test.handleAction('edit-plan');
  const timeNode=ui._test.draftFor().plan.nodes[0];
  const timeDS={outlineNid:timeNode.id,outlineConditionSlot:'trigger',outlineConditionPath:'[]'};
  ui._test.captureInput({dataset:{...timeDS,outlineConditionType:'true'},value:'time',type:'select-one'});
  assert.strictEqual(timeNode.trigger.basis,'storyDay');
  assert.strictEqual(typeof timeNode.trigger.value,'number');
  ui._test.captureInput({dataset:{...timeDS,outlineConditionField:'value',outlineNumeric:'true'},value:'360.5',type:'number'});
  assert.strictEqual(timeNode.trigger.value,360.5);
  ui._test.captureInput({dataset:{...timeDS,outlineConditionField:'basis'},value:'calendar',type:'select-one'});
  assert.strictEqual(timeNode.trigger.value,'','切换到日历不得沿用总天数数字');
  assert.ok(ui.render().includes('不会使用电脑日期推测'));
  ui._test.captureInput({dataset:{...timeDS,outlineConditionField:'value'},value:'2026-11-17',type:'text'});
  ui._test.captureInput({dataset:{...timeDS,outlineConditionField:'basis'},value:'storyDay',type:'select-one'});
  assert.strictEqual(timeNode.trigger.value,0,'切回总天数不得沿用ISO字符串');
  assert.ok(ui.render().includes('剧情总天数阈值'));
  assert.ok(refreshes > 0);
  console.log('outline UI tests passed: canonical multi-track editing, condition controls, stable references, scheduling projections, author visibility, journal recovery and confirmed v2 imports; v1 draft/API/escaping checks retained');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
