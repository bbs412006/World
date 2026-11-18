// Run: node docs/story-history-test.js. Actual v2 modules, deterministic stored world results, no network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
const quiet = { log() {}, warn() {}, error() {} };
function harness(options = {}) {
  const disk = new Map(), events = new Map(), invalidated = [], injections = new Map();
  const ctx = { chatId: 'history-test', name1: '主角', name2: '叙事者', chat: [{ is_user: false, mes: '开场白' }],
    event_types: {}, eventSource: { on(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); } },
    setExtensionPrompt(name, text) { injections.set(name, text); }, saveChatConditional() {} };
  let response = { nodeUpdates: [], contacts: [], reveals: [], proposals: [] }, apiCalls = 0;
  const box = { window: null, console: quiet, setTimeout, clearTimeout, AbortController,
    indexedDB: { open() { throw new Error('test localStorage'); } },
    localStorage: { get length() { return disk.size; }, key: index => [...disk.keys()][index],
      getItem: key => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, String(value)), removeItem: key => disk.delete(key) },
    SillyTavern: { getContext: () => ctx },
    WORLD_ENGINE_API: { getSettings: () => ({ engineEnabled: true, apiUrl: 'https://mock.invalid/v1', apiKey: 'KEY_MUST_NOT_BE_SAVED', model: 'mock', temperature: 0.2, maxTokens: 8192 }),
      async callApi() { apiCalls++; return JSON.stringify(response); } },
    WORLD_ENGINE_UI: { refresh() {} }, OUTLINE_ENGINE_UI: { refresh() {} },
    MEMORY_ENGINE: { invalidateWorldCommits(ids) { invalidated.push(...ids); }, get _test() { throw new Error('private memory test API accessed'); } } };
  box.window = box; vm.createContext(box);
  for (const file of ['world-engine-store.js', 'world-engine-core.js', 'memory-engine-timeline.js', 'outline-engine-settings.js',
    'outline-engine-data.js', 'outline-engine-scheduler.js', 'outline-engine-prompt.js', 'story-engine-projection.js', 'story-engine-history.js', 'outline-engine.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), box, { filename: file });
  }
  const plan = { title: '并行剧情', synopsis: 'SECRET_作者完整简介', constraints: 'SECRET_作者约束', publicSynopsis: '港口调查', publicConstraints: '尊重玩家选择',
    chapters: [{ id: 'c1', title: '调查', exitNodeIds: ['main'] }, { id: 'c2', title: '下一阶段', exitNodeIds: [] }],
    tracks: [{ id: 'm', kind: 'main', title: '主线' }, { id: 'h', kind: 'hidden', title: '暗线' }, { id: 's', kind: 'side', title: '支线' }],
    nodes: [{ id: 'main', trackId: 'm', chapterIds: ['c1'], title: '调查货单', intent: 'SECRET_主线作者安排', notes: 'SECRET_主线作者笔记', publicHint: '留意码头的货单线索', completionCriteria: '主角拿到货单' },
      { id: 'hidden', trackId: 'h', chapterIds: ['c1'], title: 'SECRET_发信节点', intent: 'SECRET_秘密发信', completionCriteria: '反派信已送出',
        actorKind: 'npc', completionSource: 'world', visibility: 'private', publicHint: '码头有可观察的纸屑',
        disclosure: { condition: { type: 'authorFlag', flagId: 'reveal', value: true }, clueText: '有纸屑' } },
      { id: 'side', trackId: 's', chapterIds: ['c1'], title: '访问工人', intent: '与工人交谈', completionCriteria: '工人明确给出信息' }] };
  box.OUTLINE_ENGINE_DATA.commitPlan(plan, 0);
  box.OUTLINE_ENGINE_SETTINGS.patchSettings({ engineEnabled: true, autoCheck: false, cooldownTicks: 0, apiUrl: 'https://mock.invalid/v1', apiKey: 'OUTLINE_KEY_NOT_SAVED', model: 'mock', ...options.settings });
  if (options.legacy) {
    const world = box.WORLD_ENGINE_CORE.getDefaultState(); world.blackbox.secretActions.push({ action: 'LEGACY_PRIVATE_ACTION' });
    box.WORLD_ENGINE_STORE.setItem('world_engine_' + ctx.chatId, JSON.stringify(world));
  }
  box.OUTLINE_ENGINE.init();
  const history = box.STORY_ENGINE_HISTORY, data = box.OUTLINE_ENGINE_DATA, core = box.WORLD_ENGINE_CORE, timeline = box.MEMORY_ENGINE_TIMELINE;
  function addRound(text) { ctx.chat.push({ is_user: true, mes: '继续' }, { is_user: false, mes: text }); return ctx.chat.length - 1; }
  function step(text, payload = {}) {
    const end = addRound(text), sourceRefs = timeline.captureRange(end - 1, end);
    const token = history.captureWorldStep({ mode: 'forward', sourceRefs, beforeWorld: core.loadState() });
    const world = { ...token.beforeWorld, round: token.beforeWorld.round + 1, worldDigest: text,
      regionalIncident: { active: false, cooldown: 27 - token.beforeWorld.round },
      nearEvent: { pending: false, cooldown: 3, requestedRound: token.beforeWorld.round },
      events: [{ id: 'event_1', name: '进展', type: 'progress', level: 2, stage: '执行', stageRound: 4, consecutiveFails: 2, evolveResult: '受挫', stall: false }] };
    const tx = box.WORLD_ENGINE_STORE.beginTransaction();
    try {
      core.saveState(world);
      const result = history.commitWorldStep(token, { worldState: core.loadState(), ...payload });
      box.WORLD_ENGINE_STORE.commitTransaction(tx); return result;
    } catch (error) { box.WORLD_ENGINE_STORE.rollbackTransaction(tx); throw error; }
  }
  function proof(layer, quote) { const ref = timeline.sourceRef(ctx.chat[layer], layer); return { messageId: ref.messageId, hash: ref.hash, quote: quote || ctx.chat[layer].mes }; }
  return { box, ctx, disk, invalidated, injections, history, data, core, timeline, step, addRound, proof,
    apiCalls: () => apiCalls, setResponse(value) { response = value; } };
}

function bulkTailAndFullJournal() {
  const h = harness(), states = [], commits = [];
  for (let i = 0; i < 50; i++) { const commit = h.step(`第${i + 1}轮`); states.push(copy(h.core.loadState())); commits.push(commit); }
  assert.strictEqual(h.ctx.chat.length, 101);
  const beforeRevision = h.history.getStatus().revision, calls = h.apiCalls();
  h.ctx.chat.splice(21); // 100正文楼一次删除80楼，仅保留前10轮。
  h.history.reconcile();
  assert.deepStrictEqual(copy(h.core.loadState()).nearEvent, states[9].nearEvent, 'cooldown/random outcomes replay exactly');
  assert.strictEqual(h.core.loadState().round, 10);
  assert.strictEqual(h.history.listCommits().length, 50, 'full fact journal is retained independently of three rolling backups');
  assert.ok(h.history.getStatus().snapshotCount >= 6);
  assert.ok(h.history.getStatus().revision > beforeRevision, 'rollback publishes a newer synchronization revision');
  assert.strictEqual(h.history.isCommitActive(commits[9].id), true);
  assert.strictEqual(h.history.isCommitActive(commits[49].id), false);
  assert.ok(h.invalidated.includes(commits[49].id));
  assert.strictEqual(h.apiCalls(), calls, 'bulk deletion is entirely local');
  assert.strictEqual(h.history.getStatus().blocked, false);
}

function middleAndPartialBatch() {
  const h = harness(), commits = [];
  for (let i = 0; i < 12; i++) commits.push(h.step(`港口变化${i}`));
  h.ctx.chat.splice(9, 6); // remove middle three rounds, retaining later text.
  const result = h.history.reconcile();
  assert.strictEqual(h.core.loadState().round, 4);
  assert.strictEqual(result.status.phase, 'pending-rebuild');
  assert.strictEqual(result.status.pendingFromLayer, 9);
  assert.strictEqual(h.history.isCommitActive(commits[3].id), true, 'trusted ancestors remain valid while later text awaits rebuilding');
  assert.strictEqual(h.history.isCommitActive(commits[11].id), false);
  assert.throws(() => h.history.captureWorldStep({ beforeWorld: h.core.loadState() }), /重新对账|恢复|基底|重建/);

  const batch = harness();
  const before = batch.core.loadState();
  for (let i = 0; i < 5; i++) batch.addRound(`一个API批次的第${i}段正文`);
  let token = batch.history.captureWorldStep({ sourceRefs: batch.timeline.captureRange(1, 10), beforeWorld: before });
  batch.history.commitWorldStep(token, { worldState: { ...token.beforeWorld, round: 1, worldDigest: '五轮联合结果' } });
  batch.ctx.chat.splice(7); // keep 3 of the original 5 rounds.
  batch.history.reconcile();
  assert.strictEqual(batch.core.loadState().round, 0, 'an LLM batch cannot be split into an invented partial result');
  assert.strictEqual(batch.history.getStatus().phase, 'pending-rebuild');
  assert.strictEqual(batch.history.getStatus().pendingFromLayer, 1);
}

function replaceCancelAndLateToken() {
  const h = harness(), first = h.step('原版本发生过秘密发信', { privateEvents: [{ text: 'SECRET_FACT', nodeId: 'hidden', trackId: 'h' }],
    observations: [{ nodeId: 'hidden', status: 'completed', evidence: [{ privateEventIndex: 0 }] }] });
  assert.strictEqual(h.data.getNodeStatus(h.data.loadState(), 'hidden'), 'completed');
  h.data.setNodeStatus('side', 'skipped');
  const authored = h.data.loadState().plan; authored.publicConstraints = '作者在后台改的公开规则'; h.data.commitPlan(authored, h.data.loadState().revision);
  const beforeRound = h.core.loadState().round, head = h.history.getStatus().currentCommitId;
  h.history.prepareForGeneration({ type: 'regenerate', targetLayer: 2 });
  assert.strictEqual(h.ctx.chat[2].mes, '原版本发生过秘密发信', 'raw text is intentionally still unchanged at generation start');
  assert.strictEqual(h.core.loadState().round, beforeRound - 1);
  assert.strictEqual(h.data.getNodeStatus(h.data.loadState(), 'hidden'), 'pending');
  assert.strictEqual(h.data.getNodeStatus(h.data.loadState(), 'side'), 'skipped', 'manual decisions do not roll back');
  assert.strictEqual(h.data.loadState().plan.publicConstraints, '作者在后台改的公开规则');
  h.history.cancelGeneration();
  assert.strictEqual(h.history.getStatus().currentCommitId, head);
  assert.strictEqual(h.core.loadState().round, beforeRound);
  assert.strictEqual(h.data.getNodeStatus(h.data.loadState(), 'hidden'), 'completed');

  h.history.prepareForGeneration({ type: 'regenerate', targetLayer: 2 });
  h.ctx.chat[2].mes = '替换版本没有发信'; h.ctx.chat[2].swipe_id = 1;
  const token = h.history.captureWorldStep({ sourceRefs: h.timeline.captureRange(1, 2), beforeWorld: h.core.loadState() });
  const replacement = h.history.commitWorldStep(token, { worldState: { ...token.beforeWorld, round: token.beforeWorld.round + 1, worldDigest: '没有发信' } });
  assert.strictEqual(h.core.loadState().round, beforeRound);
  assert.strictEqual(h.history.isCommitActive(first.id), false); assert.strictEqual(h.history.isCommitActive(replacement.id), true);
  assert.ok(!h.data.loadState().privateFacts.some(fact => fact.text === 'SECRET_FACT'));
  assert.ok(h.history.listCommits().some(commit => commit.id === first.id && commit.status === 'archived'));
  const stale = h.history.captureWorldStep({ sourceRefs: h.timeline.captureRange(1, 2), beforeWorld: h.core.loadState() });
  h.history.prepareForGeneration({ type: 'normal' });
  assert.strictEqual(h.history.validateWorldStep(stale), false);
  const dryRevision = h.history.getStatus().revision;
  h.history.prepareForGeneration({ type: 'regenerate', dryRun: true });
  assert.strictEqual(h.history.getStatus().revision, dryRevision, 'dry runs do not select a branch or write history');
}

function limitsCorruptionAndExternalEdit() {
  const h = harness(); h.step('真实世界提交');
  h.ctx.chat[0].mes = '启用之前的历史被替换'; h.history.reconcile();
  assert.strictEqual(h.history.getStatus().phase, 'blocked');
  assert.strictEqual(h.box.OUTLINE_ENGINE.buildNarrativeGuidance(), '', 'invalid pre-root history never injects future state');
  const rebuilding = h.history.beginRebuild();
  assert.strictEqual(rebuilding.fromChatIndex, 0, 'explicit rebuild starts a new world instead of claiming to recover pre-activation randomness');
  assert.strictEqual(rebuilding.worldState.round, 0); h.history.finishRebuild(false);
  assert.strictEqual(h.history.getStatus().phase, 'pending-rebuild');

  const broken = harness(); for (let i = 0; i < 12; i++) broken.step(`提交${i}`);
  const key = broken.history.PREFIX + broken.ctx.chatId, bundle = JSON.parse(broken.box.WORLD_ENGINE_STORE.getItem(key));
  bundle.journal.splice(3, 1); broken.box.WORLD_ENGINE_STORE.setItem(key, JSON.stringify(bundle)); broken.history.reconcile();
  assert.strictEqual(broken.history.getStatus().phase, 'blocked', 'a missing journal segment cannot be bridged by guessing');

  const external = harness(); external.step('联合世界');
  const raw = JSON.parse(external.box.WORLD_ENGINE_STORE.getItem('world_engine_' + external.ctx.chatId)); raw.worldDigest = '旧设备篡改的公共世界';
  external.box.WORLD_ENGINE_STORE.setItem('world_engine_' + external.ctx.chatId, JSON.stringify(raw)); external.history.reconcile();
  assert.strictEqual(external.history.getStatus().phase, 'blocked');

  const future = harness(), futureKey = future.history.PREFIX + future.ctx.chatId;
  const futureBundle = JSON.parse(future.box.WORLD_ENGINE_STORE.getItem(futureKey)); futureBundle.schemaVersion = 3;
  const futureRaw = JSON.stringify(futureBundle); future.box.WORLD_ENGINE_STORE.setItem(futureKey, futureRaw);
  assert.strictEqual(future.history.getStatus().phase, 'blocked');
  assert.throws(() => future.history.ensureBaseline(), /更新版本|不能覆盖/);
  assert.strictEqual(future.history.reconcile().status.blocked, true);
  assert.strictEqual(future.box.WORLD_ENGINE_STORE.getItem(futureKey), futureRaw, 'a future-schema local bundle is preserved byte-for-byte instead of silently reinitialized');

  const failed = harness(), originalChat = failed.ctx.chat;
  failed.history.markPersistenceFailure('A写入失败');
  assert.strictEqual(failed.history.getStatus().blocked, true);
  failed.ctx.chatId = 'healthy-B'; failed.ctx.chat = [{ is_user: false, mes: 'B的开场' }];
  failed.history.ensureBaseline();
  assert.strictEqual(failed.history.getStatus().blocked, false, 'a disk failure belongs to the original chat');
  failed.history.beginRebuild(); failed.history.finishRebuild(true);
  failed.ctx.chatId = 'history-test'; failed.ctx.chat = originalChat;
  assert.strictEqual(failed.history.getStatus().blocked, true, 'recovering B does not clear A failure');
}

function importAndExplicitRebuild() {
  const h = harness(); h.step('第一步'); const backup = copy(h.history.exportBundle()); h.step('第二步');
  const before = h.history.getStatus().revision;
  h.history.importBundle(backup);
  assert.ok(h.history.getStatus().revision > before);
  assert.strictEqual(h.history.getStatus().blocked, false, 'explicit same-chat import restores a coherent earlier canonical bundle');
  assert.strictEqual(h.core.loadState().round, 1);
  const exported = h.history.exportBundle(); assert.ok(!JSON.stringify(exported).includes('KEY_MUST_NOT_BE_SAVED'));
  const secret = copy(exported); secret.bundle.apiKey = 'SHOULD_BE_REJECTED';
  const diskBefore = copy([...h.disk]);
  assert.throws(() => h.history.validateBundle(secret), /密钥|配置/);
  assert.deepStrictEqual(copy([...h.disk]), diskBefore, 'bundle validation is read-only');
  assert.throws(() => h.history.importBundle(secret), /密钥|配置/);
  assert.throws(() => h.history.importBundle({ schemaVersion: 3 }), /版本|格式/);
  const rebuilt = h.history.beginRebuild({ fromBeginning: true }); assert.strictEqual(rebuilt.fromLayer, 0);
  const token = h.history.captureWorldStep({ sourceRefs: h.timeline.captureRange(0, 2), beforeWorld: h.core.loadState() });
  h.history.commitWorldStep(token, { worldState: { ...token.beforeWorld, round: 1, worldDigest: '新基底的第一批' } });
  assert.strictEqual(h.history.listCommits()[0].layer, 2, 'rebuild commits are tied to the processed batch, not all retained chat');
  h.history.finishRebuild(false); assert.strictEqual(h.history.getStatus().pendingFromLayer, 3);
  assert.strictEqual(h.core.loadState().round, 1, 'successful partial rebuild batches survive cancellation');
  const resume = h.history.beginRebuild(); assert.strictEqual(resume.fromChatIndex, 3);
  h.history.finishRebuild(true);
  const foreign = copy(h.history.exportBundle()); h.ctx.chatId = 'other-chat'; h.ctx.chat = [{ is_user: false, mes: '另一个聊天的开场' }];
  const result = h.history.importBundle(foreign);
  assert.strictEqual(result.importedPlanOnly, true); assert.strictEqual(h.history.getStatus().journalCount, 0);
  assert.strictEqual(h.data.loadState().progressEvents.length, 0);
}

async function privateFactsCluesAndKnowledge() {
  const h = harness({ legacy: true });
  assert.ok(h.data.loadState().privateFacts.some(fact => fact.text === 'LEGACY_PRIVATE_ACTION'));
  assert.ok(!JSON.stringify(h.core.loadState()).includes('LEGACY_PRIVATE_ACTION'));
  h.step('主角仍不知情', { privateEvents: [{ text: 'SECRET_反派确实发信了', nodeId: 'hidden', trackId: 'h', knownBy: ['反派'],
    clue: { publicText: '码头上有盖着红蜡的纸屑', condition: { type: 'literal', value: true } } }],
    observations: [{ nodeId: 'hidden', status: 'completed', evidence: [{ privateEventIndex: 0 }] }] });
  let state = h.data.loadState();
  assert.strictEqual(h.data.getNodeStatus(state, 'hidden'), 'completed');
  assert.strictEqual(state.clues[0].id, 'clue:hidden'); assert.strictEqual(state.clues[0].available, false, 'model cannot loosen the author disclosure gate');
  assert.ok(!h.box.OUTLINE_ENGINE.buildNarrativeGuidance().includes('SECRET_'));
  h.addRound('主角继续观察，未接触任何纸屑');
  const flags = h.data.loadState(); flags.authorFlags.reveal = true; h.data.saveState(flags);
  h.step('线索现在有机会被发现'); state = h.data.loadState();
  assert.strictEqual(state.clues[0].available, true); assert.strictEqual(state.contacts.length, 0); assert.strictEqual(state.knowledge.length, 0);
  const clueId = state.clues[0].id, factId = state.clues[0].factIds[0];
  assert.ok(h.box.OUTLINE_ENGINE.buildNarrativeGuidance().includes('码头上有盖着红蜡的纸屑'));
  assert.ok(!h.box.OUTLINE_ENGINE.buildNarrativeGuidance().includes('SECRET_'));
  const layer = h.addRound('主角读了红蜡纸屑上的文字，确认反派确实发信了。');
  h.setResponse({ nodeUpdates: [], contacts: [{ clueId, actorId: '主角', evidence: [h.proof(layer, '主角读了红蜡纸屑上的文字')] }],
    reveals: [{ clueId, factId, actorId: '主角', evidence: [h.proof(layer, '确认反派确实发信了')] }], proposals: [] });
  const checked = await h.box.OUTLINE_ENGINE.checkNow(); assert.strictEqual(checked.ok, true);
  state = h.data.loadState(); assert.strictEqual(state.contacts.length, 1); assert.strictEqual(state.knowledge.length, 1);
  assert.strictEqual(state.clues[0].status, 'known');
  assert.ok(h.history.listCommits().some(commit => commit.kind === 'outline'), 'dialogue-only knowledge updates belong to the joint journal');
  const calls = h.apiCalls(); h.ctx.chat.splice(layer - 1); h.history.reconcile();
  assert.strictEqual(h.data.loadState().knowledge.length, 0, 'removing contact removes its derived knowledge locally');
  assert.strictEqual(h.apiCalls(), calls);

  const deferredReveal = harness(); deferredReveal.step('幕后行动已经完成', { privateEvents: [{ text: 'SECRET_幕后既成事实', nodeId: 'hidden', trackId: 'h' }],
    observations: [{ nodeId: 'hidden', status: 'completed', evidence: [{ privateEventIndex: 0 }] }] });
  const ended = deferredReveal.data.loadState(); ended.authorFlags.reveal = true; ended.manualOverrides.main = { status: 'completed' }; ended.manualOverrides.side = { status: 'skipped' };
  deferredReveal.data.saveState(ended); deferredReveal.box.OUTLINE_ENGINE.applyInjection();
  const callsBefore = deferredReveal.apiCalls(), guidance = deferredReveal.box.OUTLINE_ENGINE.buildWorldGuidance(deferredReveal.core.loadState());
  assert.ok(guidance.includes('SECRET_幕后既成事实'), 'closed nodes do not erase committed private world context');
  assert.ok(guidance.includes('pendingDisclosures'), 'the next existing world call can create an author-authorized discoverable trace');
  assert.strictEqual(deferredReveal.apiCalls(), callsBefore, 'disclosure guidance never introduces an extra API request');
  assert.ok(!deferredReveal.box.OUTLINE_ENGINE.buildNarrativeGuidance().includes('SECRET_'));
}

async function independentRecordsAndTemporalNotice() {
  const h = harness(); h.step('主角拿到了货单。');
  for (let i = 0; i < 3; i++) h.step(`后续世界变化${i}`);
  const before = h.data.loadState(), after = copy(before), proof = h.proof(2, '拿到了货单'), sources = h.timeline.captureRange(1, 2);
  after.progressEvents.push({ id: 'independent-main', nodeId: 'main', trackId: 'm', status: 'completed', planRevision: after.revision,
    nodeRevision: 'node', independent: true, parentEventIds: [], evidence: [proof], sourceRefs: sources, sourceDigest: h.timeline.digestRefs(sources),
    validity: 'valid', beforeChapterId: 'c1', layer: 2, createdAt: Date.now() });
  h.history.recordOutlineCommit(before, h.data.advanceChapter(after), sources);
  h.ctx.chat.splice(3, 2); h.history.reconcile();
  assert.strictEqual(h.core.loadState().round, 1);
  assert.strictEqual(h.data.getNodeStatus(h.data.loadState(), 'main'), 'completed', 'a proved independent original-text record before the gap can survive unrelated later world invalidation');
  assert.ok(h.history.listCommits().some(commit => commit.mode === 'retain-independent'));

  const temporal = harness(); temporal.step('主角梦见自己拿到了货单。');
  temporal.setResponse({ nodeUpdates: [{ nodeId: 'main', status: 'completed', evidence: [temporal.proof(2, '拿到了货单')] }],
    timeAssessment: { kind: 'dream', reason: '梦境不是现实进展', evidence: [temporal.proof(2)] }, contacts: [], reveals: [], proposals: [] });
  await temporal.box.OUTLINE_ENGINE.checkNow();
  assert.strictEqual(temporal.data.getNodeStatus(temporal.data.loadState(), 'main'), 'pending');
  const round = temporal.core.loadState().round, branch = temporal.history.getStatus().branchId;
  const layer = temporal.addRound('时间似乎倒流，但没有真实删楼或切换回复。');
  temporal.setResponse({ nodeUpdates: [], contacts: [], reveals: [], proposals: [], timeAssessment: {
    kind: 'in_world_rewind', reason: '需要作者核对剧情时间', evidence: [temporal.proof(layer)] } });
  await temporal.box.OUTLINE_ENGINE.checkNow();
  assert.strictEqual(temporal.data.loadState().tracking.temporalNotice.kind, 'in_world_rewind');
  assert.strictEqual(temporal.core.loadState().round, round); assert.strictEqual(temporal.history.getStatus().branchId, branch, 'semantic rewind only raises a notice; it never rewinds the actual branch');
}

(async () => {
  for (const test of [bulkTailAndFullJournal, middleAndPartialBatch, replaceCancelAndLateToken, limitsCorruptionAndExternalEdit, importAndExplicitRebuild, privateFactsCluesAndKnowledge, independentRecordsAndTemporalNotice]) {
    await test(); console.log(test.name + ': passed');
  }
  console.log('story-history-test: all passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
