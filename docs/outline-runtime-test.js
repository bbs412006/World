// Run with: node docs/outline-runtime-test.js
// Actual outline settings/data/prompt/timeline modules run against mocked ST events and API.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function plan() {
  return { title: '寻找证据', synopsis: '逐步查明商会的问题', constraints: '尊重人物知情边界', chapters: [
    { id: 'c1', title: '调查', goal: '找到线索', nodes: [
      { id: 'n1', title: '拿到货单', intent: '获得真实货单', completionCriteria: '正文明确拿到货单', required: true },
      { id: 'n0', title: '待定安排', intent: '保留作者尚未明确的方向', completionCriteria: '', required: false }
    ] },
    { id: 'c2', title: '核实', goal: '核实货单', nodes: [
      { id: 'n2', title: '核实印章', intent: '验证印章', completionCriteria: '正文明确核实印章', required: true },
      { id: 'n3', title: '可选询问', intent: '向账房询问', completionCriteria: '正文完成询问', required: false }
    ] }
  ] };
}

function harness(options = {}) {
  const store = new Map(), listeners = new Map(), calls = [], injections = new Map([['world-engine-world', '既有世界事实']]);
  const types = { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', CHAT_CHANGED: 'chat', CHAT_LOADED: 'loaded',
    MESSAGE_SWIPED: 'swipe', MESSAGE_DELETED: 'delete', MESSAGE_EDITED: 'edit' };
  const ctx = { chatId: 'outline-test', chat: options.chat || [{ is_user: false, name: '角色', mes: '开场白' }],
    event_types: types, eventSource: { on(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback);
    } }, setExtensionPrompt(name, content) { injections.set(name, content); }, saveChatConditional() {} };
  const worldConfig = { apiUrl: 'https://world.example/v1', apiKey: 'WORLD-KEY', model: 'world-model',
    connectionMode: 'proxy', temperature: 0.4, maxTokens: 6000, apiTimeoutMs: 1000 };
  const worldState = { worldDigest: '客观背景', lastEvolveResult: { world_digest: '客观背景' }, events: [] };
  const memoryState = { event_memory: { big_summaries: [{ content: '只可参考的总述', status: 'valid' }] } };
  let handler = () => JSON.stringify({ nodeUpdates: [], proposals: [] });
  const warnings = [];
  const sandbox = { window: null, console: { log() {}, warn(...args) { warnings.push(args); }, error(...args) { warnings.push(args); } },
    setTimeout, clearTimeout, AbortController, Date, Math, SillyTavern: { getContext() { return ctx; } },
    WORLD_ENGINE_STORE: { getItem(key) { return store.get(key) ?? null; }, setItem(key, value) { store.set(key, String(value)); } },
    WORLD_ENGINE_CORE: { getChatId() { return ctx.chatId; }, loadState() { return copy(worldState); } },
    WORLD_ENGINE_API: { getSettings() { return copy(worldConfig); }, async callApi(prompt, maxTokens, temperature, signal, settingsOverride) {
      const call = { prompt, maxTokens, temperature, signal, settingsOverride: copy(settingsOverride) }; calls.push(call);
      return handler(call);
    } },
    MEMORY_ENGINE_DATA: { loadState() { return copy(memoryState); } },
    // Runtime must not use memory internals or feed future plans to its ingestion path.
    MEMORY_ENGINE: { get _test() { throw new Error('memory internals accessed'); }, ingestWorldEvolution() { throw new Error('future plan leaked to memory'); } },
    WORLD_ENGINE_UI: { refresh() {} }, OUTLINE_ENGINE_UI: { refresh() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const files = ['memory-engine-timeline.js', 'outline-engine-settings.js', 'outline-engine-data.js',
    ...(options.withScheduler ? ['outline-engine-scheduler.js'] : []), 'outline-engine-prompt.js', 'outline-engine.js'];
  for (const name of files) {
    vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), sandbox, { filename: name });
  }
  const config = sandbox.OUTLINE_ENGINE_SETTINGS, data = sandbox.OUTLINE_ENGINE_DATA, engine = sandbox.OUTLINE_ENGINE;
  config.patchSettings({
    engineEnabled: options.enabled !== false,
    checkEveryX: 3,
    apiUrl: 'https://outline.example/v1',
    apiKey: 'OUTLINE-KEY',
    model: 'outline-model',
    ...options.settings
  });
  if (options.plan !== false) data.commitPlan(options.plan || plan(), 0);
  function emit(name, ...args) { for (const callback of listeners.get(types[name] || name) || []) callback(...args); }
  function proof(index, quote) {
    const ref = sandbox.MEMORY_ENGINE_TIMELINE.sourceRef(ctx.chat[index], index);
    return { messageId: ref.messageId, hash: ref.hash, quote: quote || ctx.chat[index].mes };
  }
  async function reply(text, type = 'normal') {
    emit('GENERATION_STARTED', type, {}, false);
    ctx.chat.push({ is_user: true, name: '用户', mes: '继续调查' });
    ctx.chat.push({ is_user: false, name: '角色', mes: text });
    emit('GENERATION_ENDED'); await pause(120);
  }
  engine.init();
  return { sandbox, ctx, store, calls, injections, worldConfig, worldState, memoryState, warnings, config, data, engine,
    emit, proof, reply, setHandler(value) { handler = value; } };
}

async function testDisabledAndScheduling() {
  const disabled = harness({ enabled: false });
  await disabled.reply('拿到了货单');
  await disabled.reply('核实了印章');
  assert.strictEqual(disabled.calls.length, 0, 'disabled module must not request an API');
  assert.strictEqual(disabled.injections.get('outline-engine-outline'), '');
  assert.strictEqual(disabled.injections.get('world-engine-world'), '既有世界事实');

  const oldChat = [{ is_user: false, mes: '开场白' }, { is_user: true, mes: '旧问题' }, { is_user: false, mes: '旧答案' }];
  const h = harness({ chat: oldChat });
  assert.strictEqual(h.calls.length, 0, 'initial activation must anchor at current layer');
  assert.strictEqual(h.data.loadState().tracking.anchorLayer, 2);
  await h.reply('第一轮新的回答'); await h.reply('第二轮新的回答');
  assert.strictEqual(h.calls.length, 0);
  await h.reply('第三轮新的回答');
  assert.strictEqual(h.calls.length, 1, 'three new assistant rounds trigger one independent check');
  h.emit('GENERATION_ENDED'); h.emit('GENERATION_ENDED'); await pause(120);
  assert.strictEqual(h.calls.length, 1, 'duplicate generation-ended events must not count twice');
  h.emit('GENERATION_STARTED', 'regenerate', {}, false);
  const last = h.ctx.chat[h.ctx.chat.length - 1]; last.mes = '第三轮重新生成的回答'; last.swipe_id = 1;
  h.emit('MESSAGE_SWIPED'); h.emit('GENERATION_ENDED'); await pause(120);
  assert.strictEqual(h.calls.length, 1, 'a reroll does not count as an additional round');
  assert.strictEqual(h.data.loadState().tracking.roundsSinceCheck, 0);
  await h.reply('第四轮回答'); assert.strictEqual(h.data.loadState().tracking.roundsSinceCheck, 1);
  // Deleting below the original numeric anchor must not prevent future rounds from counting.
  h.ctx.chat.splice(1, 6); h.emit('MESSAGE_DELETED');
  await h.reply('删楼以后仍可计数');
  assert.strictEqual(h.data.loadState().tracking.roundsSinceCheck, 2);
}

async function testEvidenceAndEarlyNodes() {
  const customPlan = plan();
  for (let i = 4; i <= 12; i++) customPlan.chapters[0].nodes.push({ id: `n${i}`, title: `后续节点${i}`,
    intent: '不要求按序完成', completionCriteria: `正文完成第${i}项`, required: false });
  const h = harness({ plan: customPlan, settings: { autoCheck: false } });
  await h.reply('我已经拿到了货单，也完成了第12项。');
  h.data.setNodeStatus('n4', 'blocked');
  h.setHandler(() => JSON.stringify({ nodeUpdates: [
    { nodeId: 'n1', status: 'completed', evidence: [{ messageId: 'invented', quote: '我已经拿到了货单' }] },
    { nodeId: 'n0', status: 'completed', evidence: [h.proof(2, '拿到了货单')] },
    { nodeId: 'n4', status: 'completed', evidence: [h.proof(2, '拿到了货单')] },
    { nodeId: 'n12', status: 'completed', evidence: [h.proof(2, '完成了第12项')] },
    { nodeId: 'n2', status: 'completed', evidence: [h.proof(2, '拿到了货单')] }
  ], proposals: [] }));
  let result = await h.engine.checkNow(), state = h.data.loadState();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(h.data.getNodeStatus(state, 'n1'), 'pending', 'invented source identities must be rejected');
  assert.strictEqual(h.data.getNodeStatus(state, 'n0'), 'pending', 'missing completion criteria prevents automatic completion');
  assert.strictEqual(h.data.getNodeStatus(state, 'n4'), 'blocked', 'manual overrides remain authoritative');
  assert.strictEqual(h.data.getNodeStatus(state, 'n12'), 'completed', 'later nodes in the current chapter can finish early');
  assert.strictEqual(h.data.getNodeStatus(state, 'n2'), 'pending', 'future chapters are not checked');
  assert.strictEqual(state.progressEvents.length, 1);
  assert.strictEqual(state.progressEvents[0].evidence[0].hash, h.proof(2).hash);
  h.setHandler(() => JSON.stringify({ nodeUpdates: [{ nodeId: 'n1', status: 'completed', evidence: [h.proof(2, '正文不存在的引文')] }], proposals: [] }));
  result = await h.engine.checkNow(); state = h.data.loadState();
  assert.strictEqual(result.checked, true, 'manual checks may recheck an unchanged range');
  assert.strictEqual(h.data.getNodeStatus(state, 'n1'), 'pending');
}

async function testAdvanceAndRollback() {
  const h = harness({ settings: { checkEveryX: 100 } });
  const originalPlan = copy(h.data.loadState().plan);
  await h.reply('我已经拿到了货单。');
  h.setHandler(() => JSON.stringify({ nodeUpdates: [{ nodeId: 'n1', status: 'completed', evidence: [h.proof(2, '拿到了货单')] }], proposals: [] }));
  await h.engine.checkNow();
  assert.strictEqual(h.data.loadState().currentChapterId, 'c2', 'all required nodes completed advances the chapter');
  await h.reply('我已经核实了印章。');
  h.setHandler(() => JSON.stringify({ nodeUpdates: [{ nodeId: 'n2', status: 'completed', evidence: [h.proof(4, '核实了印章')] }], proposals: [] }));
  await h.engine.checkNow(); h.data.setNodeStatus('n3', 'skipped');
  assert.strictEqual(h.data.loadState().progressEvents.filter(item => item.validity === 'valid').length, 2);
  h.ctx.chat[2].mes = '货单没有拿到，仍在对方手里。'; h.ctx.chat[2].swipe_id = 1;
  const callsBefore = h.calls.length;
  const audited = await h.engine.prepareHistoryForGeneration();
  let state = h.data.loadState();
  assert.strictEqual(audited.changed, true);
  assert.strictEqual(h.calls.length, callsBefore, 'generation preparation is entirely local');
  assert.strictEqual(state.currentChapterId, 'c1');
  assert.strictEqual(state.progressEvents.filter(item => item.validity === 'valid').length, 0, 'later automatic decisions are retracted with an invalid ancestor');
  assert.strictEqual(h.data.getNodeStatus(state, 'n3'), 'skipped', 'rollback preserves explicit manual decisions');
  assert.deepStrictEqual(copy(state.plan), originalPlan, 'source rollback never rewrites authored outline');
  assert.strictEqual(state.tracking.pendingRecheck, true);
  h.setHandler(() => JSON.stringify({ nodeUpdates: [], proposals: [] }));
  h.emit('GENERATION_STARTED', 'regenerate', {}, false); h.emit('GENERATION_ENDED'); await pause(120);
  state = h.data.loadState();
  assert.strictEqual(h.calls.length, callsBefore + 1, 'the next completed generation rechecks invalidated sources regardless of N');
  assert.strictEqual(state.tracking.pendingRecheck, false);
  assert.strictEqual(h.injections.get('world-engine-world'), '既有世界事实');
}

async function testLateResults() {
  const h = harness({ settings: { autoCheck: false } }); await h.reply('拿到了货单。');
  let pending = deferred(); h.setHandler(() => pending.promise);
  const run = h.engine.checkNow(); assert.strictEqual(h.engine.isRunning(), true);
  h.emit('GENERATION_STARTED', 'normal', {}, false);
  assert.strictEqual(h.calls[0].signal.aborted, true, 'generation start actively aborts ongoing checks');
  pending.resolve(JSON.stringify({ nodeUpdates: [{ nodeId: 'n1', status: 'completed', evidence: [h.proof(2)] }], proposals: [] }));
  assert.strictEqual((await run).ok, false);
  assert.strictEqual(h.data.loadState().progressEvents.length, 0);
  h.emit('GENERATION_ENDED'); await pause(120);

  pending = deferred(); h.setHandler(() => pending.promise); const planRun = h.engine.checkNow();
  const edited = h.data.loadState().plan; edited.chapters[0].goal = '用户修改的目标'; h.data.commitPlan(edited, h.data.loadState().revision);
  pending.resolve(JSON.stringify({ nodeUpdates: [{ nodeId: 'n1', status: 'completed', evidence: [h.proof(2)] }], proposals: [] }));
  assert.strictEqual((await planRun).reason, 'stale-result', 'revision changes reject late results');

  pending = deferred(); h.setHandler(() => pending.promise); const sourceRun = h.engine.checkNow();
  h.ctx.chat[2].mes = '正文被直接编辑了。';
  pending.resolve(JSON.stringify({ nodeUpdates: [], proposals: [] }));
  assert.strictEqual((await sourceRun).reason, 'stale-result', 'source hash is checked even when no edit event arrives');

  pending = deferred(); h.setHandler(() => pending.promise); const manualRun = h.engine.checkNow();
  h.data.setNodeStatus('n1', 'blocked');
  pending.resolve(JSON.stringify({ nodeUpdates: [], proposals: [] }));
  assert.strictEqual((await manualRun).reason, 'stale-result', 'manual state changes invalidate the check basis');

  pending = deferred(); h.setHandler(() => pending.promise); const settingsRun = h.engine.checkNow();
  h.config.patchSettings({ apiKey: 'changed-during-request' });
  pending.resolve(JSON.stringify({ nodeUpdates: [], proposals: [] }));
  assert.strictEqual((await settingsRun).reason, 'stale-result', 'effective API configuration changes reject an old request without storing credentials');

  pending = deferred(); h.setHandler(() => pending.promise); const chatRun = h.engine.checkNow();
  h.ctx.chatId = 'another-chat'; h.ctx.chat = [{ is_user: false, mes: '另一个聊天' }]; h.emit('CHAT_CHANGED');
  pending.resolve(JSON.stringify({ nodeUpdates: [], proposals: [] }));
  assert.strictEqual((await chatRun).ok, false);
  assert.strictEqual(h.data.loadState().progressEvents.length, 0, 'late results cannot write into a different chat');

  const independent = harness({ settings: { autoCheck: false } }); await independent.reply('可检查的正文');
  const first = deferred(), second = deferred(); let attempt = 0;
  independent.setHandler(() => (++attempt === 1 ? first.promise : second.promise));
  const oldRun = independent.engine.checkNow(); independent.engine.abort(); const newRun = independent.engine.checkNow();
  first.resolve(JSON.stringify({ nodeUpdates: [], proposals: [] })); await oldRun;
  assert.strictEqual(independent.engine.isRunning(), true, 'the old task finalizer cannot unlock a newer request');
  second.resolve(JSON.stringify({ nodeUpdates: [], proposals: [] })); await newRun;
  assert.strictEqual(independent.engine.isRunning(), false);
}

async function testApiAndPreviewIsolation() {
  const h = harness({ settings: { autoCheck: false } }); await h.reply('可检查的正文。');
  const initialWorld = copy(h.worldConfig), initialFacts = copy(h.worldState), initialMemory = copy(h.memoryState);
  await h.engine.checkNow();
  assert.strictEqual(h.calls[0].settingsOverride.apiKey, 'OUTLINE-KEY');
  assert.strictEqual(h.calls[0].settingsOverride.stream, false);
  h.config.patchSettings({ apiUrl: 'https://outline.example/v1', apiKey: '', model: 'outline-only', stream: true });
  await h.engine.checkNow();
  assert.strictEqual(h.calls[1].settingsOverride.apiKey, '', 'empty outline key never falls back to the world key');
  assert.strictEqual(h.calls[1].settingsOverride.model, 'outline-only');
  assert.strictEqual(h.calls[1].settingsOverride.stream, true);
  assert.strictEqual(h.worldConfig.temperature, initialWorld.temperature);
  assert.deepStrictEqual(h.worldState, initialFacts); assert.deepStrictEqual(h.memoryState, initialMemory);
  const before = copy(h.data.loadState()); h.setHandler(() => JSON.stringify(plan()));
  const preview = await h.engine.organizeText('第一章调查，拿到真实货单。');
  assert.strictEqual(preview.chapters.length, 2);
  assert.deepStrictEqual(copy(h.data.loadState()), before, 'AI organization returns a preview and does not save it');
  assert.ok(h.injections.get('outline-engine-outline').includes('【剧情指导】'));
  assert.ok(!h.injections.get('outline-engine-outline').includes('核实印章'), 'guidance is limited to the current chapter');
  assert.strictEqual(h.injections.get('world-engine-world'), '既有世界事实');
  h.config.patchSettings({ injectIntoWorldEngine: false }); assert.strictEqual(h.engine.buildWorldGuidance(h.worldState), '');
  assert.ok(h.engine.buildNarrativeGuidance().includes('【剧情指导】'));
  h.config.patchSettings({ injectIntoPrompt: false, injectIntoWorldEngine: true }); h.engine.applyInjection();
  assert.strictEqual(h.injections.get('outline-engine-outline'), '');
  assert.ok(h.engine.buildWorldGuidance(h.worldState).includes('不是事实'));
  h.config.patchSettings({ apiUrl: '' });
  const count = h.calls.length, result = await h.engine.checkNow();
  assert.strictEqual(result.ok, false); assert.strictEqual(h.calls.length, count, 'incomplete outline configuration fails locally');
}

async function testProposalReview() {
  const h = harness({ settings: { autoCheck: false } }); await h.reply('印章在火灾中毁掉了，只留下货单编号。');
  const before = copy(h.data.loadState().plan);
  h.setHandler(() => JSON.stringify({ nodeUpdates: [], proposals: [{ kind: 'replace_node', chapterId: 'c2', nodeId: 'n2',
    before: { malicious: 'not the actual original node' }, after: { title: '核实编号', intent: '验证编号', completionCriteria: '正文明确核实编号' },
    reason: '印章已毁', evidence: [h.proof(2, '印章在火灾中毁掉了')] }] }));
  await h.engine.checkNow(); let state = h.data.loadState();
  assert.deepStrictEqual(copy(state.plan), before, 'suggestions never change the plan automatically');
  assert.strictEqual(state.proposals.length, 1);
  const suggestion = state.proposals[0];
  assert.strictEqual(suggestion.before.title, '核实印章', 'review shows the actual old value, not model-supplied before');
  assert.throws(() => h.engine.applyProposal(suggestion.id, state.revision + 1), /大纲已修改/);
  h.engine.applyProposal(suggestion.id, state.revision); state = h.data.loadState();
  assert.strictEqual(state.plan.nodes.find(node => node.id === 'n2').title, '核实编号');
  assert.strictEqual(state.proposals[0].status, 'accepted');
  assert.strictEqual(state.revision, suggestion.planRevision + 1);

  h.setHandler(() => JSON.stringify({ nodeUpdates: [], proposals: [{ kind: 'update_chapter', chapterId: 'c2',
    after: { title: '查证编号', nodes: [{ id: 'evil', title: '不应注入的嵌套替换' }] }, reason: '调整方向', evidence: [h.proof(2, '货单编号')] }] }));
  await h.engine.checkNow(); state = h.data.loadState();
  const next = state.proposals.find(item => item.status === 'pending'); assert.ok(next);
  assert.strictEqual(next.after.nodes, undefined, 'chapter suggestions cannot silently replace node arrays');
  h.ctx.chat[2].mes = '原文已经修改';
  assert.throws(() => h.engine.applyProposal(next.id, state.revision), /建议已处理或失效|原文来源已变化/);
  assert.strictEqual(h.data.loadState().plan.chapters[1].title, '核实');
}

async function testBlockedAndProposalRaces() {
  const h = harness({ settings: { autoCheck: false } }); await h.reply('原定商路被洪水完全阻断，短期无法到达。');
  h.setHandler(() => JSON.stringify({ nodeUpdates: [{ nodeId: 'n1', status: 'blocked', evidence: [h.proof(2, '商路被洪水完全阻断')] }], proposals: [] }));
  await h.engine.checkNow();
  assert.strictEqual(h.data.getNodeStatus(h.data.loadState(), 'n1'), 'blocked', 'real evidence can mark a node blocked');
  h.setHandler(() => JSON.stringify({ nodeUpdates: [], proposals: [{ kind: 'replace_node', chapterId: 'c2', nodeId: 'n2',
    after: { title: '更换查证方式' }, reason: '交通中断', evidence: [h.proof(2)] }] }));
  await h.engine.checkNow(); let state = h.data.loadState(), proposal = state.proposals.find(item => item.status === 'pending');
  assert.ok(proposal);
  h.data.setNodeStatus('n2', 'completed');
  assert.throws(() => h.engine.applyProposal(proposal.id, state.revision), /已经完成|当前执行阶段/, 'progress changes at the same plan revision must be rechecked');

  const chapterRace = harness({ settings: { autoCheck: false } }); await chapterRace.reply('新线索改变了后续安排。');
  chapterRace.setHandler(() => JSON.stringify({ nodeUpdates: [], proposals: [{ kind: 'update_chapter', chapterId: 'c2',
    after: { title: '修改未来章节' }, reason: '新线索', evidence: [chapterRace.proof(2)] }] }));
  await chapterRace.engine.checkNow(); state = chapterRace.data.loadState(); proposal = state.proposals[0];
  chapterRace.data.setNodeStatus('n1', 'skipped'); chapterRace.engine.applyInjection();
  assert.strictEqual(chapterRace.data.loadState().currentChapterId, 'c2', 'manual skip of necessary nodes advances the chapter');
  assert.throws(() => chapterRace.engine.applyProposal(proposal.id, state.revision), /当前执行阶段/, 'a future chapter suggestion becomes ineligible when its chapter starts');

  const sameCheckPlan = plan(); sameCheckPlan.chapters[0].nodes.push({ id: 'later', title: '稍后事项', intent: '后续工作', completionCriteria: '正文完成后续工作', required: false });
  const sameCheck = harness({ plan: sameCheckPlan, settings: { autoCheck: false } }); await sameCheck.reply('后续工作已完成。');
  sameCheck.setHandler(() => JSON.stringify({ nodeUpdates: [{ nodeId: 'later', status: 'completed', evidence: [sameCheck.proof(2)] }],
    proposals: [{ kind: 'replace_node', chapterId: 'c1', nodeId: 'later', after: { title: '不应再修改' }, reason: '同轮结果', evidence: [sameCheck.proof(2)] }] }));
  await sameCheck.engine.checkNow();
  assert.strictEqual(sameCheck.data.loadState().proposals.length, 0, 'a check cannot propose editing a node it just completed');
}

async function testLoadedAndGuidanceBudget() {
  const outline = plan(); outline.constraints = '作者完整约束。'.repeat(70);
  outline.chapters[0].nodes[0].completionCriteria = '必须保留的完成条件。'.repeat(35);
  const h = harness({ plan: outline, settings: { autoCheck: false, injectMaxChars: 200 } });
  const content = h.engine.buildNarrativeGuidance();
  assert.ok(content.includes(outline.constraints), 'a small soft budget cannot truncate mandatory author constraints');
  assert.ok(content.includes(outline.chapters[0].nodes[0].completionCriteria), 'current completion criteria must remain complete');
  assert.ok(h.engine.getLastDebug().injection.narrative.overBudget);
  assert.strictEqual(h.engine.getLastDebug().injection.narrative.chars, content.length);
  await h.reply('拿到了货单。');
  const pending = deferred(); h.setHandler(() => pending.promise); const running = h.engine.checkNow();
  h.emit('CHAT_LOADED');
  assert.strictEqual(h.calls[0].signal.aborted, true, 'same-ID chat reload actively aborts an old session');
  pending.resolve(JSON.stringify({ nodeUpdates: [], proposals: [] }));
  assert.strictEqual((await running).ok, false);
  assert.ok(h.injections.get('outline-engine-outline').includes('【剧情指导】'));

  const failed = harness({ settings: { checkEveryX: 100 } });
  await failed.reply('一些可检查的正文');
  let state = failed.data.loadState(); state.tracking.pendingRecheck = true; failed.data.saveState(state);
  failed.setHandler(() => { throw new Error('offline'); });
  failed.emit('GENERATION_ENDED'); await pause(120);
  const attempts = failed.calls.length; assert.strictEqual(attempts, 1);
  failed.emit('GENERATION_ENDED'); await pause(120);
  assert.strictEqual(failed.calls.length, attempts, 'duplicate end events must not retry the same failed generation check');
}

async function testFinishedAndImportActivation() {
  const h = harness({ enabled: false });
  const edited = h.data.loadState().plan; edited.title = '禁用时仍可手动编辑';
  h.data.commitPlan(edited, h.data.loadState().revision);
  assert.strictEqual(h.data.loadState().plan.title, '禁用时仍可手动编辑');
  assert.strictEqual(h.calls.length, 0);
  h.config.patchSettings({ engineEnabled: true }); h.engine.applyInjection();
  h.data.setNodeStatus('n1', 'skipped'); h.engine.applyInjection();
  h.data.setNodeStatus('n2', 'completed'); h.engine.applyInjection();
  assert.strictEqual(h.data.loadState().currentChapterId, 'c2');
  assert.strictEqual(h.data.getNodeStatus(h.data.loadState(), 'n3'), 'pending');
  assert.strictEqual(h.injections.get('outline-engine-outline'), '', 'optional remainder does not extend a finished last chapter');
  assert.strictEqual((await h.engine.checkNow()).reason, 'outline-complete');
  await h.reply('故事已结束的后续闲聊一'); await h.reply('故事已结束的后续闲聊二'); await h.reply('故事已结束的后续闲聊三');
  assert.strictEqual(h.calls.length, 0, 'a completed final chapter stops both manual and scheduled API checks');
  assert.strictEqual(h.data.loadState().tracking.roundsSinceCheck, 0);

  const imported = harness({ enabled: false, plan: false, chat: [
    { is_user: false, mes: '旧开场' }, { is_user: true, mes: '旧问题' }, { is_user: false, mes: '旧回复' }
  ] });
  imported.data.importData(plan());
  imported.config.patchSettings({ engineEnabled: true }); imported.engine.applyInjection();
  assert.strictEqual(imported.data.loadState().tracking.anchorLayer, 2);
  assert.strictEqual(imported.calls.length, 0, 'importing an initial outline anchors current history without replaying it');
  await imported.reply('启用后的第一轮'); await imported.reply('启用后的第二轮');
  assert.strictEqual(imported.calls.length, 0);
  await imported.reply('启用后的第三轮'); assert.strictEqual(imported.calls.length, 1);
}

async function testImportedSourceAudit() {
  for (const tamper of ['synthetic', 'foreign', 'quote', 'proofHash', 'sourceDigest']) {
    const h = harness({ settings: { autoCheck: false } }); await h.reply('我拿到了货单。');
    h.setHandler(() => JSON.stringify({ nodeUpdates: [{ nodeId: 'n1', status: 'completed', evidence: [h.proof(2, '拿到了货单')] }], proposals: [] }));
    await h.engine.checkNow();
    const backup = h.data.exportData(), event = backup.state.progressEvents[0];
    if (tamper === 'synthetic') event.sourceRefs.forEach(ref => { ref.synthetic = true; });
    if (tamper === 'foreign') event.sourceRefs.forEach(ref => { ref.chatId = 'foreign-chat'; });
    if (tamper === 'quote') event.evidence[0].quote = '当前原文中不存在的所谓证据';
    if (tamper === 'proofHash') event.evidence[0].hash = 'wrong-proof-hash';
    if (tamper === 'sourceDigest') event.sourceDigest = 'wrong-digest';
    h.data.importData(backup, { includeProgress: true });
    const count = h.calls.length;
    await h.engine.prepareHistoryForGeneration();
    const state = h.data.loadState();
    assert.strictEqual(state.progressEvents[0].validity, 'stale', `imported ${tamper} sources must not bypass original-text validation`);
    assert.strictEqual(h.data.getNodeStatus(state, 'n1'), 'pending');
    assert.strictEqual(state.currentChapterId, 'c1');
    assert.strictEqual(h.calls.length, count, 'imported source audit remains local');
  }
}

async function testSchedulerFullEligibleAndUnseenCatchup() {
  // 真实加载 outline-engine-scheduler.js，验证：
  // 1) 当 narrativeLimit=2 时，排在第 5 位的已解锁合格公开支线节点提前完成也能被 checkNow 正常检查命中（不被 2 个注入预算截断）
  // 2) 当自动检查关闭连续聊了 5 轮（超出 checkEveryX=3）再点 checkNow 时，第 1 轮（L2）完成的节点不会因死切最后 3 轮而漏检
  // 3) v2 公开节点同时含 title 与 publicHint 时，注入包含章节名与「标题：公开提示」，且绝不泄露私密 intent
  const customV2 = {
    title: '青州水路',
    synopsis: 'PRIVATE_AUTHOR_SYNOPSIS',
    publicSynopsis: '追查渡口异动',
    chapters: [{ id: 'c1', title: '风起青州渡', goal: '摸清渡口底细', exitNodeIds: ['m1'] }],
    tracks: [
      { id: 't-main', kind: 'main', title: '主线', priority: 10 },
      { id: 't-side', kind: 'side', title: '支线', priority: 1 }
    ],
    nodes: [
      { id: 'm1', trackId: 't-main', chapterIds: ['c1'], title: '询问守门人', intent: 'PRIVATE_INTENT_M1', publicHint: '三号码头守门人似知昨夜船讯', completionCriteria: '得知黑篷船消息', required: true },
      { id: 's1', trackId: 't-side', chapterIds: ['c1'], title: '支线一', intent: '支线1', publicHint: '提示1', completionCriteria: '完成支线一', required: false },
      { id: 's2', trackId: 't-side', chapterIds: ['c1'], title: '支线二', intent: '支线2', publicHint: '提示2', completionCriteria: '完成支线二', required: false },
      { id: 's3', trackId: 't-side', chapterIds: ['c1'], title: '支线三', intent: '支线3', publicHint: '提示3', completionCriteria: '完成支线三', required: false },
      { id: 's4', trackId: 't-side', chapterIds: ['c1'], title: '顺手解围酒肆掌柜', intent: 'PRIVATE_SIDE_4', publicHint: '西市酒肆掌柜被泼皮纠缠', completionCriteria: '替酒肆掌柜解围', required: false }
    ]
  };
  const h = harness({ withScheduler: true, plan: customV2, settings: { autoCheck: false, checkEveryX: 3, narrativeLimit: 2 } });
  const guidanceText = h.engine.buildNarrativeGuidance();
  assert.ok(guidanceText.includes('当前章节：风起青州渡'), 'v2公开节点注入应包含当前章节标题');
  assert.ok(guidanceText.includes('询问守门人：三号码头守门人似知昨夜船讯'), 'v2公开节点应组合节点标题与公开提示');
  assert.ok(!guidanceText.includes('PRIVATE_'), '增强公开引导后仍严禁泄露作者私密 intent 或 synopsis');

  // 第 1 轮（L2）就顺手完成了排在第 5 位的支线节点 s4，随后又聊了 4 轮（共 5 轮未检查，超过 checkEveryX=3）
  await h.reply('路过西市时，主角出手替酒肆掌柜解了泼皮之围。'); // L2
  await h.reply('第二轮闲谈水路行情。'); // L4
  await h.reply('第三轮夜宿客栈。'); // L6
  await h.reply('第四轮清晨买早点。'); // L8
  await h.reply('第五轮前往栈桥观望。'); // L10

  h.setHandler(({ prompt }) => {
    assert.ok(prompt.includes('"nodeId":"s4"'), '即使 narrativeLimit=2，后台检查仍须覆盖全部已解锁合格公开节点');
    assert.ok(prompt.includes('替酒肆掌柜解了泼皮之围'), 'selectSources 应从上次检查锚点追平全部 5 轮未检原文，而非死切最后 3 轮');
    return JSON.stringify({
      nodeUpdates: [{ nodeId: 's4', status: 'completed', evidence: [{ messageId: h.proof(2).messageId, quote: '出手替酒肆掌柜……泼皮之围' }] }],
      proposals: []
    });
  });

  const res = await h.engine.checkNow();
  assert.strictEqual(res.ok, true);
  const afterState = h.data.loadState();
  assert.strictEqual(h.data.getNodeStatus(afterState, 's4'), 'completed', '第1轮提前完成的第5号支线节点应成功核实打勾');
  await h.engine.prepareHistoryForGeneration();
  assert.strictEqual(h.data.getNodeStatus(h.data.loadState(), 's4'), 'completed', '还原为原生子串的证据通过后续本地审计且不失效');
}

(async function() {
  for (const test of [testDisabledAndScheduling, testEvidenceAndEarlyNodes, testAdvanceAndRollback,
    testLateResults, testApiAndPreviewIsolation, testProposalReview, testBlockedAndProposalRaces, testLoadedAndGuidanceBudget,
    testFinishedAndImportActivation, testImportedSourceAudit, testSchedulerFullEligibleAndUnseenCatchup]) {
    await test(); console.log(`${test.name}: passed`);
  }
  console.log('outline-runtime-test: all passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
