const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
function sandbox(extra = {}) {
  const box = { console: quiet, setTimeout, clearTimeout, ...extra };
  box.window = box; vm.createContext(box);
  box.run = name => vm.runInContext(read(name), box, { filename: name });
  return box;
}
async function testScopedStorageAndSync() {
  let sink;
  const values = new Map(), listeners = new Map();
  const chats = new Map();
  const context = {
    chatId: 'A', chat: [], chatMetadata: { unrelated: { keep: true } },
    eventSource: { on(name, handler) { listeners.set(name, handler); } },
    event_types: { CHAT_LOADED: 'loaded' },
    updateChatMetadata(value) { Object.assign(this.chatMetadata, value); },
    saveMetadataDebounced() {}
  };
  const box = sandbox({
    SillyTavern: { getContext: () => context },
    WORLD_ENGINE_CORE: { getChatId: () => context.chatId },
    WORLD_ENGINE_API: { getSettings: () => ({ syncToChat: true }) },
    WORLD_ENGINE_STORE: {
      getItem: key => values.get(key) ?? null,
      setItem(key, value) { values.set(key, String(value)); sink?.onWrite(key, value); },
      removeItem(key) { values.delete(key); sink?.onRemove(key); },
      setSyncSink(value) { assert.ok(!sink, 'only chatcache owns the shared sink'); sink = value; }
    },
    OUTLINE_ENGINE: { abort() {}, prepareHistoryForGeneration() {}, applyInjection() {} }
  });
  for (const file of ['outline-engine-settings.js', 'outline-engine-data.js', 'world-engine-chatcache.js', 'outline-engine-cache.js']) box.run(file);
  const settings = box.OUTLINE_ENGINE_SETTINGS, data = box.OUTLINE_ENGINE_DATA;
  await box.WORLD_ENGINE_CHATCACHE.init();
  const cache = box.WORLD_ENGINE_CHATCACHE.forScope('outline');
  const plan = { title: '计划', chapters: [{ id: 'chapter', title: '第一章', nodes: [{ id: 'node', title: '发现线索', completionCriteria: '找到货单' }] }] };
  data.commitPlan(plan, 0);
  data.setNodeStatus('node', 'completed');
  assert.strictEqual(settings.getSettings().syncToChat, false);
  const snapshot = cache.createSnapshot('A 的剧情');
  assert.ok(snapshot);
  const exported = cache.exportSnapshot(snapshot.id);
  assert.strictEqual(exported.type, 'outline-engine-chat-snapshot');
  assert.ok(!JSON.stringify(exported).includes('apiKey'));
  assert.ok(context.chatMetadata.unrelated.keep);
  const unsafeSnapshot = JSON.parse(JSON.stringify(exported));
  const unsafeState = JSON.parse(unsafeSnapshot.data.state);
  unsafeState.apiKey = 'not-to-be-saved'; unsafeState.tracking.apiKey = 'not-to-be-saved';
  unsafeSnapshot.data.state = JSON.stringify(unsafeState);
  const safeImportedSnapshot = cache.importSnapshot(unsafeSnapshot);
  assert.ok(!JSON.stringify(safeImportedSnapshot).includes('not-to-be-saved'), 'foreign snapshot payloads are normalized before saving');
  const aRevision = data.loadState().revision;
  settings.patchSettings({ syncToChat: true, apiKey: 'never-in-chat' });
  assert.ok(cache.pushLiveNow());
  const remote = JSON.parse(JSON.stringify(context.chatMetadata));
  assert.ok(!JSON.stringify(remote).includes('never-in-chat'));
  const remoteRev = remote.outline_engine_v2.live.rev;
  // Simulate a second device opening the same server-side chat: no local outline.
  values.delete('outline_engine_v2_state_A'); values.delete('outline_engine_v2_A_syncrev');
  context.chatMetadata = remote;
  await cache.onChatLoaded();
  assert.strictEqual(data.loadState().revision, aRevision, 'sync must not create a new plan revision');
  assert.strictEqual(data.getNodeStatus(data.loadState(), 'node'), 'completed');
  cache.pushLiveNow();
  assert.strictEqual(context.chatMetadata.outline_engine_v2.live.rev, remoteRev, 'unchanged sync must converge');
  values.set('outline_engine_v2_A_syncrev', String(remoteRev + 5));
  await cache.onChatLoaded();
  assert.strictEqual(Number(values.get('outline_engine_v2_A_syncrev')), context.chatMetadata.outline_engine_v2.live.rev,
    'identical data with unequal clocks must converge before another device edits');
  const convergedRevision = context.chatMetadata.outline_engine_v2.live.rev;
  chats.set('A', context.chatMetadata);
  context.chatId = 'B'; context.chatMetadata = { unrelated: { keep: true } };
  box.WORLD_ENGINE_CHATCACHE.onChatLoaded();
  await box.WORLD_ENGINE_CHATCACHE.whenReady();
  assert.strictEqual(data.loadState().plan.chapters.length, 0, 'chat B must not inherit A');
  const imported = cache.importSnapshot(exported);
  assert.ok(await cache.restoreSnapshot(imported.id));
  assert.strictEqual(data.getNodeStatus(data.loadState(), 'node'), 'pending', 'foreign snapshots reset progress');
  assert.strictEqual(data.loadState().originChatId, 'B');
  assert.ok(context.chatMetadata.unrelated.keep);
  assert.throws(() => cache.importSnapshot({ type: exported.type, v: 1, data: { state: 'broken' } }), /有效/);
  // Main world and outline scopes keep independent revision numbers.
  assert.ok(values.has('world_engine_B_syncrev') || !context.chatMetadata.world_engine);
  assert.strictEqual(values.get('outline_engine_v2_A_syncrev'), String(convergedRevision));
  settings.patchSettings({ syncToChat: false, autoBackup: false });
  await cache.onChatLoaded(); // clear pending write timers so the test has no stray work.
}
function testActualPromptInspector() {
  const events = new Map();
  const context = {
    chatId: 'A', event_types: {},
    extensionPrompts: { 'outline-engine-outline': { value: '【剧情指导】目标：调查' } },
    eventSource: { on(name, fn) { events.set(name, fn); } }
  };
  const box = sandbox({
    SillyTavern: { getContext: () => context },
    WORLD_ENGINE_API: { getSettings: () => ({}) },
    WORLD_ENGINE_CORE: { loadState: () => ({ round: 1 }) },
    OUTLINE_ENGINE_SETTINGS: { getSettings: () => ({ engineEnabled: true, injectIntoPrompt: true }) },
    OUTLINE_ENGINE_DATA: { loadState: () => ({ tracking: { checkedLayer: 2 } }) }
  });
  box.run('world-engine-inject-inspector.js');
  const inspector = box.WORLD_ENGINE_INJECT_INSPECTOR; inspector.init();
  const event = { chat: [{ role: 'system', content: '【剧情指导】目标：调查' }] };
  const before = JSON.stringify(event);
  events.get('chat_completion_prompt_ready')(event);
  assert.strictEqual(inspector.getLastSnapshot('outline').status, 'SUCCESS');
  assert.strictEqual(JSON.stringify(event), before, 'prompt inspection must be read only');
  events.get('generate_after_combine_prompts')({ prompt: '没有大纲' });
  assert.strictEqual(inspector.getLastSnapshot('outline').status, 'MISSING');
  context.extensionPrompts = [{ name: 'outline-engine-outline', content: '【剧情指导】' }];
  events.get('generate_after_combine_prompts')({ prompt: '【剧情指导】' });
  assert.strictEqual(inspector.getLastSnapshot('outline').status, 'SUCCESS');
  events.get('chat_loaded')();
  assert.strictEqual(inspector.getLastSnapshot('outline'), null);
}
async function testFallbackMigration() {
  const local = new Map([['outline_engine_state_A', 'outline'], ['memory_engine_settings', 'memory'], ['unrelated', 'keep']]);
  const localStorage = {
    get length() { return local.size; }, key(index) { return [...local.keys()][index]; },
    getItem(key) { return local.get(key) ?? null; }, setItem(key, value) { local.set(key, value); }, removeItem(key) { local.delete(key); }
  };
  const fallback = sandbox({ localStorage, indexedDB: { open() { throw new Error('temporarily unavailable'); } } });
  fallback.run('world-engine-store.js'); await fallback.WORLD_ENGINE_STORE.hydrate();
  assert.ok(fallback.WORLD_ENGINE_STORE.keys().includes('outline_engine_state_A'));
  fallback.WORLD_ENGINE_STORE.setItem('outline_engine_state_A', 'latest');
  assert.strictEqual(local.get('outline_engine_state_A'), 'latest');
  const persisted = new Map();
  const db = {
    transaction() { return { objectStore() { return {
      put(value, key) { persisted.set(key, value); },
      openCursor() { const request = {}; queueMicrotask(() => request.onsuccess({ target: { result: null } })); return request; }
    }; } }; }
  };
  const recovered = sandbox({ localStorage, indexedDB: { open() { const request = { result: db }; queueMicrotask(() => request.onsuccess()); return request; } } });
  recovered.run('world-engine-store.js'); await recovered.WORLD_ENGINE_STORE.hydrate();
  assert.strictEqual(persisted.get('outline_engine_state_A'), 'latest');
  assert.strictEqual(persisted.get('memory_engine_settings'), 'memory');
  assert.strictEqual(local.get('unrelated'), 'keep');
}
async function testIndependentOutlineStartup() {
  const called = [];
  const box = sandbox({ fetch: async () => ({ ok: false }) });
  const apis = {
    'world-engine-store.js': ['WORLD_ENGINE_STORE', { hydrate: async () => called.push('hydrate'), getItem() {}, setItem() {} }],
    'world-engine-core.js': ['WORLD_ENGINE_CORE', { getChatId() {}, loadState() {} }],
    'world-engine-api.js': ['WORLD_ENGINE_API', { callApi() {} }],
    'memory-engine-timeline.js': ['MEMORY_ENGINE_TIMELINE', { captureRange() {}, auditRefs() {}, syncHidden() {}, digestRefs() {}, hashText() {} }],
    'world-engine-worldbook.js': ['WORLD_ENGINE_WORLDBOOK', { buildPromptSection() {} }],
    'world-engine-chatcache.js': ['WORLD_ENGINE_CHATCACHE', { init() { called.push('cache'); } }],
    'world-engine-inject-inspector.js': ['WORLD_ENGINE_INJECT_INSPECTOR', { init() {} }],
    'outline-engine-settings.js': ['OUTLINE_ENGINE_SETTINGS', { getSettings() {}, patchSettings() {} }],
    'outline-engine-data.js': ['OUTLINE_ENGINE_DATA', { loadState() {}, saveState() {}, commitPlan() {} }],
    'outline-engine-scheduler.js': ['OUTLINE_ENGINE_SCHEDULER', { select() {}, evaluateConditions() {} }],
    'story-engine-history.js': ['STORY_ENGINE_HISTORY', { captureWorldStep() {}, commitWorldStep() {}, reconcile() {} }],
    'outline-engine-cache.js': null,
    'outline-engine-prompt.js': ['OUTLINE_ENGINE_PROMPT', { buildCheckPrompt() {}, buildOrganizePrompt() {} }],
    'outline-engine.js': ['OUTLINE_ENGINE', { init() { called.push('outline'); }, applyInjection() {}, checkNow() {}, abort() {}, isRunning() {} }],
    'outline-engine-ui.js': ['OUTLINE_ENGINE_UI', { init() { called.push('outline-ui'); } }],
    'world-engine-diag.js': ['WORLD_ENGINE_DIAG', { collect() {}, download() {} }],
    'world-engine-ui.js': ['WORLD_ENGINE_UI', { buildPanel() {}, buildInputButton() { throw new Error('world UI unavailable'); }, refresh() {} }]
  };
  box.document = {
    getElementsByTagName: () => [{ src: 'https://example.test/world-engine.js' }],
    createElement: tag => ({ tag }),
    head: { appendChild(element) {
      if (element.tag === 'link') return;
      const entry = apis[element.src.split('/').pop()];
      if (entry) box[entry[0]] = entry[1];
      queueMicrotask(() => element.onload());
    } }
  };
  box.run('world-engine.js');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(called.includes('outline'), 'world and memory failure must not prevent outline startup');
  assert.ok(called.indexOf('outline') > called.indexOf('cache'), 'restore synchronized outline before first injection');
  assert.ok(called.includes('outline-ui'));
}
(async () => {
  await testScopedStorageAndSync(); testActualPromptInspector(); await testFallbackMigration(); await testIndependentOutlineStartup();
  console.log('outline integration tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
