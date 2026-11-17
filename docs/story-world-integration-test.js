const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };
function makeHarness() {
  const listeners = new Map(), disk = new Map();
  const context = { chatId: 'world-v2', name1: '主角', chat: [{ is_user: false, mes: '开场' }],
    eventSource: { on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } }, event_types: {},
    extensionPrompts: {}, setExtensionPrompt(name, value) { this.extensionPrompts[name] = { value }; }, saveChatConditional() {}, saveChat() {} };
  let calls = 0, answer = { world_digest: '港口照常营业', privateEvents: [], observations: [] };
  const box = { console: quiet, setTimeout, clearTimeout, AbortController,
    document: { getElementById: () => null },
    indexedDB: { open() { throw new Error('fallback'); } },
    localStorage: { get length() { return disk.size; }, key: index => [...disk.keys()][index], getItem: key => disk.get(key) ?? null,
      setItem: (key, value) => disk.set(key, String(value)), removeItem: key => disk.delete(key) },
    SillyTavern: { getContext: () => context },
    WORLD_ENGINE_API: { getSettings: () => ({ apiUrl: 'https://mock.invalid/v1', model: 'mock', temperature: 0.2, maxTokens: 8192,
      engineEnabled: true, apiAutoRetries: 0, localRegionalIncidentChancePercent: 0, localDistantEventChancePercent: 0, localNearEventChancePercent: 0 }),
      parseJSON: value => JSON.parse(value), async callApi() { calls++; return JSON.stringify(answer); } },
    WORLD_ENGINE_RULES: { getAllRulesText: () => '', getCoreRulesSummary: () => '' },
    WORLD_ENGINE_UI: { refresh() {}, setEvolvingUI() {} }
  };
  box.window = box; vm.createContext(box);
  for (const file of ['world-engine-store.js', 'world-engine-core.js', 'memory-engine-timeline.js', 'outline-engine-settings.js',
    'outline-engine-data.js', 'outline-engine-scheduler.js', 'outline-engine-prompt.js', 'story-engine-projection.js',
    'story-engine-history.js', 'outline-engine.js', 'world-engine-ledger.js', 'world-engine-inject.js', 'world-engine-evolution.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), box, { filename: file });
  }
  const plan = { title: '多线测试', publicSynopsis: '调查港口', chapters: [{ id: 'c1', title: '调查', exitNodeIds: ['m1'] }],
    tracks: [{ id: 'main', kind: 'main', title: '主线' }, { id: 'hidden', kind: 'hidden', title: '暗线' }],
    nodes: [{ id: 'm1', trackId: 'main', chapterIds: ['c1'], title: '调查', intent: '玩家决定调查方式', publicHint: '留意港口变化', completionCriteria: '主角取得货单' },
      { id: 'h1', trackId: 'hidden', chapterIds: ['c1'], title: '暗中发信', intent: '绝密幕后计划', completionCriteria: '信已送出', completionSource: 'world', actorKind: 'npc', visibility: 'private',
        disclosure: { condition: { type: 'authorFlag', flagId: 'allow-clue', value: true }, clueText: '地上有信封纸屑' } }] };
  box.OUTLINE_ENGINE_DATA.commitPlan(plan, 0);
  box.OUTLINE_ENGINE_SETTINGS.patchSettings({ engineEnabled: true, autoCheck: false });
  box.OUTLINE_ENGINE.init();
  async function world(text, result) {
    context.chat.push({ is_user: true, mes: '继续调查' }, { is_user: false, mes: text });
    answer = result || { world_digest: text, privateEvents: [], observations: [] };
    const end = context.chat.length - 1;
    const ok = await box.WORLD_ENGINE_EVOLUTION.evolve(box.WORLD_ENGINE_CORE.loadState(), '', text, { mode: 'forward',
      sourceRefs: box.MEMORY_ENGINE_TIMELINE.captureRange(end - 1, end), dialogueText: text });
    return ok;
  }
  return { box, context, world, setAnswer: value => { answer = value; }, calls: () => calls };
}
(async () => {
  const h = makeHarness(), { box, context } = h;
  const secret = 'SECRET_反派信已送出';
  assert.strictEqual(await h.world('主角继续观察码头。', { world_digest: '码头工人开始工作',
    privateEvents: [{ text: secret, nodeId: 'h1', trackId: 'hidden', knownBy: ['反派'] }],
    observations: [{ nodeId: 'h1', status: 'completed', evidence: [{ privateEventIndex: 0 }], reason: '信已实际送出' }] }), true);
  let state = box.OUTLINE_ENGINE_DATA.loadState();
  assert.strictEqual(box.OUTLINE_ENGINE_DATA.getNodeStatus(state, 'h1'), 'completed');
  assert.ok(state.privateFacts.some(fact => fact.text === secret));
  assert.ok(!JSON.stringify(box.WORLD_ENGINE_CORE.loadState()).includes(secret));
  assert.ok(!box.WORLD_ENGINE_INJECT.buildContext(box.WORLD_ENGINE_CORE.loadState(), []).includes(secret));
  assert.ok(!box.OUTLINE_ENGINE.buildNarrativeGuidance().includes(secret));
  const oldCommit = box.WORLD_ENGINE_EVOLUTION.getLastWorldCommitId();
  assert.ok(box.STORY_ENGINE_HISTORY.isCommitActive(oldCommit));
  const round = box.WORLD_ENGINE_CORE.loadState().round;
  // Re-generation must select the old pre-message baseline even before raw text is replaced.
  box.STORY_ENGINE_HISTORY.prepareForGeneration({ type: 'regenerate', targetLayer: context.chat.length - 1 });
  assert.strictEqual(box.WORLD_ENGINE_CORE.loadState().round, round - 1);
  box.STORY_ENGINE_HISTORY.cancelGeneration();
  assert.strictEqual(box.WORLD_ENGINE_CORE.loadState().round, round);
  assert.ok(box.STORY_ENGINE_HISTORY.isCommitActive(oldCommit));
  box.STORY_ENGINE_HISTORY.prepareForGeneration({ type: 'regenerate', targetLayer: context.chat.length - 1 });
  context.chat[context.chat.length - 1].mes = '这一版本中没有发信。'; context.chat[context.chat.length - 1].swipe_id = 1;
  h.setAnswer({ world_digest: '港口平静', privateEvents: [], observations: [] });
  let ok = await box.WORLD_ENGINE_EVOLUTION.evolve(box.WORLD_ENGINE_CORE.loadState(), '', '这一版本中没有发信。', {
    sourceRefs: box.MEMORY_ENGINE_TIMELINE.captureRange(context.chat.length - 2, context.chat.length - 1) });
  assert.strictEqual(ok, true);
  assert.strictEqual(box.WORLD_ENGINE_CORE.loadState().round, round, 'same-floor replacement does not add an extra world step');
  assert.ok(!box.STORY_ENGINE_HISTORY.isCommitActive(oldCommit));
  assert.ok(!box.OUTLINE_ENGINE_DATA.loadState().privateFacts.some(fact => fact.text === secret));
  const versions = [];
  for (let index = 0; index < 30; index++) {
    assert.strictEqual(await h.world('第' + index + '次港口变化'), true);
    versions.push({ length: context.chat.length, round: box.WORLD_ENGINE_CORE.loadState().round });
  }
  const calls = h.calls(), target = versions[7];
  context.chat.splice(target.length); // bulk delete 44 messages in one operation.
  box.STORY_ENGINE_HISTORY.reconcile();
  assert.strictEqual(h.calls(), calls, 'local rollback must not call the model');
  assert.strictEqual(box.WORLD_ENGINE_CORE.loadState().round, target.round);
  assert.ok(box.STORY_ENGINE_HISTORY.getStatus().snapshotCount >= 2, 'periodic history snapshots survive independently of rolling backups');
  assert.ok(!box.STORY_ENGINE_HISTORY.getStatus().blocked);
  context.chat.splice(0); // before activation baseline: cannot manufacture exact history.
  box.STORY_ENGINE_HISTORY.reconcile();
  assert.strictEqual(box.STORY_ENGINE_HISTORY.getStatus().blocked, true);
  assert.strictEqual(box.WORLD_ENGINE_INJECT.buildContext(box.WORLD_ENGINE_CORE.loadState(), []), '');
  console.log('story actual world pipeline tests passed: private facts, same-floor replacement/cancel, bulk deletion, recovery boundary');
})().catch(error => { console.error(error); process.exitCode = 1; });
