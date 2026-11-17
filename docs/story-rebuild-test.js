const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'world-engine.js'), 'utf8');
const entry = source.slice(source.indexOf('      async function rebuildLinkedHistory'), source.indexOf('      // 设置页「本轮对话时间」'));
function harness(options = {}) {
  const context = { chatId: 'A', chat: [{ is_user: false, mes: '开场' }] };
  for (let index = 0; index < 3; index++) context.chat.push({ is_user: true, mes: '行动' + index }, { is_user: false, mes: '结果' + index });
  const calls = [], writes = [], finished = [], disk = new Map();
  let quarantines = 0, resolveBackup, rejectBackup;
  const backup = new Promise((resolve, reject) => { resolveBackup = resolve; rejectBackup = reject; });
  const history = { beginRebuild: () => ({ fromChatIndex: options.from ?? 0 }), finishRebuild(success) { finished.push(success); } };
  const box = { console, Promise, SillyTavern: { getContext: () => context },
    core: { getChatId: () => context.chatId, loadState: () => ({}), filterDialogue: value => value },
    api: { getSettings: () => ({ firstLayerIsAiOpening: true }) },
    evolution: { isRunning: () => false, abort() {}, async evolve(state, user, ai, evolveOptions) { calls.push(evolveOptions); return true; } },
    ui: { refresh() {}, setEvolvingUI() {} }, setStatus() {}, applyInjectionForCurrentRound() {},
    STORY_ENGINE_HISTORY: history, STORY_ENGINE_PROJECTION: { active: () => true },
    WORLD_ENGINE_CHATCACHE: { whenReady: async () => {} },
    WORLD_ENGINE_STORE: { getItem: key => disk.get(key), setItem(key, value) { writes.push(key); disk.set(key, value); }, flush: async () => {} },
    MEMORY_ENGINE_TIMELINE: { captureRange: (start, end) => [{ start, end }] },
    MEMORY_ENGINE: { abort() {}, quarantineUnprovenancedHistory() { quarantines++; return { persistence: backup }; } },
    OUTLINE_ENGINE: { applyInjection() {} }
  };
  box.window = box;
  vm.createContext(box);
  const api = vm.runInContext(`(function(){let rebuildingLinkedHistory=false,isEvolving=false,cancelLinkedRebuild=false;${entry};return {run:rebuildLinkedHistory,abort:abortLinkedRebuild};})()`, box);
  return { ...api, context, calls, writes, finished, resolveBackup, rejectBackup, quarantines: () => quarantines, disk };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function testEvolutionWaitIsolation() {
  const functionText = source.slice(source.indexOf('      async function performEvolution'), source.indexOf('      async function manualEvolve'));
  for (const change of ['chat', 'reply']) {
    const context = { chatId: 'A', chat: [{ is_user: false, mes: 'A的正文' }] };
    let resume, stateReads = 0;
    const ready = new Promise(resolve => { resume = resolve; });
    const box = { console, SillyTavern: { getContext: () => context },
      core: { getChatId: () => context.chatId, loadState() { stateReads++; throw new Error('must not read another chat state'); } },
      WORLD_ENGINE_CHATCACHE: { whenReady: () => ready }, ui: { refresh() {}, setEvolvingUI() {} }, setStatus() {} };
    box.window = box; vm.createContext(box);
    const run = vm.runInContext(`(function(){let isEvolving=false;${functionText};return performEvolution;})()`, box);
    const pending = run('A的正文', context.chat);
    if (change === 'chat') { context.chatId = 'B'; context.chat = [{ is_user: false, mes: 'B的正文' }]; }
    else context.chat[0].mes = '原文已修改';
    resume(); assert.strictEqual(await pending, false); assert.strictEqual(stateReads, 0);
  }
}
(async () => {
  await testEvolutionWaitIsolation();
  const first = harness(), pending = first.run({ batchSize: 2 });
  await tick(); assert.strictEqual(first.quarantines(), 1); assert.strictEqual(first.calls.length, 0, 'no paid request before backup is durable');
  first.resolveBackup(); const result = await pending;
  assert.strictEqual(result.done, true); assert.strictEqual(result.completed, 2);
  assert.deepStrictEqual(first.calls.map(call => [call.sourceRefs[0].start, call.sourceRefs[0].end]), [[1, 4], [5, 6]]);
  assert.ok(first.calls.every(call => call.rebuild === true && call.mode === 'forward'));
  assert.deepStrictEqual(first.finished, [true]);
  const failed = harness(), failure = failed.run(); await tick(); failed.rejectBackup(new Error('disk-full'));
  assert.strictEqual((await failure).done, false); assert.strictEqual(failed.calls.length, 0); assert.deepStrictEqual(failed.finished, [false]);
  const partial = harness({ from: 3 });
  assert.strictEqual((await partial.run({ batchSize: 1, onProgress: () => partial.abort() })).done, false);
  assert.strictEqual(partial.quarantines(), 0, 'trusted boundary rebuild preserves sourced memory');
  assert.strictEqual(partial.calls.length, 1); assert.deepStrictEqual(partial.finished, [false]);
  const reloaded = harness({ from: 1 });
  const reload = await reloaded.run({ batchSize: 1, onProgress() { reloaded.context.chat = [...reloaded.context.chat]; } });
  assert.strictEqual(reload.done, false); assert.match(reload.reason, /重新加载/);
  assert.strictEqual(reloaded.calls.length, 1, 'same-chat reload cannot combine old dialogue with new source references');
  const switched = harness();
  switched.disk.set('outline_engine_v2_bundle_A', JSON.stringify({ rebuilding: true, revision: 1 }));
  const switching = switched.run(); await tick(); switched.context.chatId = 'B'; switched.resolveBackup();
  assert.strictEqual((await switching).reason, 'chat-changed'); assert.strictEqual(switched.calls.length, 0);
  assert.ok(switched.writes.every(key => key === 'outline_engine_v2_bundle_A'), 'late cleanup writes only the original chat');
  console.log('story rebuild orchestration tests passed: durable quarantine, exact batches, abort and chat isolation');
})().catch(error => { console.error(error); process.exitCode = 1; });
