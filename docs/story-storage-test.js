const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'world-engine-store.js'), 'utf8');
function makeStore(failOn) {
  const disk = new Map([['unrelated', 'keep']]);
  const localStorage = {
    get length() { return disk.size; }, key: index => [...disk.keys()][index],
    getItem: key => disk.get(key) ?? null,
    setItem(key, value) { if (key === failOn && value === 'new') throw new Error('quota'); disk.set(key, String(value)); },
    removeItem: key => disk.delete(key)
  };
  const box = { localStorage, indexedDB: { open() { throw new Error('offline'); } }, console: { log() {}, warn() {}, error() {} } };
  box.window = box; vm.runInNewContext(source, box);
  return { store: box.WORLD_ENGINE_STORE, disk };
}
async function makeIdbStore() {
  const transactions = [], failures = [];
  let throwOn = '';
  const db = { transaction(name, mode) {
    const transaction = { error: null, abort() { this.error = new Error('aborted'); this.onabort?.(); }, objectStore() {
      return { openCursor() { const request = {}; setTimeout(() => { request.result = null; request.onsuccess(); }, 0); return request; },
        put(value, key) { if (key === throwOn) throw new Error('put failed'); }, delete() {} };
    } };
    if (mode === 'readwrite') transactions.push(transaction);
    return transaction;
  } };
  const box = { setTimeout, console: { log() {}, warn() {}, error() {} },
    localStorage: { length: 0, getItem: () => null },
    indexedDB: { open() { const request = {}; setTimeout(() => { request.result = db; request.onsuccess(); }, 0); return request; } },
    WORLD_ENGINE_CORE: { getChatId: () => 'A' }, STORY_ENGINE_HISTORY: { markPersistenceFailure: error => failures.push(error) } };
  box.window = box; vm.runInNewContext(source, box); await box.WORLD_ENGINE_STORE.hydrate();
  return { store: box.WORLD_ENGINE_STORE, transactions, failures, failPut: key => { throwOn = key; } };
}
(async () => {
  const { store, disk } = makeStore(); await store.hydrate();
  store.setItem('world_engine_A', 'old-world'); store.setItem('outline_engine_v2_state_A', 'old-outline');
  const observed = []; store.setSyncSink({ onWrite() { observed.push([store.getItem('world_engine_A'), store.getItem('outline_engine_v2_state_A')]); } });
  store.beginTransaction();
  store.setItem('world_engine_A', 'new-world'); store.setItem('outline_engine_v2_state_A', 'new-outline');
  assert.strictEqual(disk.get('world_engine_A'), 'old-world');
  assert.strictEqual(store.getItem('world_engine_A'), 'new-world');
  assert.strictEqual(observed.length, 0, 'staged values do not trigger cache snapshots');
  await store.commitTransaction();
  assert.ok(observed.every(pair => pair[0] === 'new-world' && pair[1] === 'new-outline'), 'all subscribers see the same version');
  store.beginTransaction(); store.removeItem('world_engine_A'); store.setItem('outline_engine_v2_state_A', 'wrong'); store.rollbackTransaction();
  assert.strictEqual(store.getItem('world_engine_A'), 'new-world'); assert.strictEqual(store.getItem('outline_engine_v2_state_A'), 'new-outline');
  const failing = makeStore('outline_engine_v2_state_A'); await failing.store.hydrate();
  failing.store.setItem('world_engine_A', 'old'); failing.store.setItem('outline_engine_v2_state_A', 'old');
  failing.store.beginTransaction(); failing.store.setItem('world_engine_A', 'new'); failing.store.setItem('outline_engine_v2_state_A', 'new');
  assert.throws(() => failing.store.commitTransaction(), /quota/);
  assert.strictEqual(failing.disk.get('world_engine_A'), 'old');
  assert.strictEqual(failing.store.getItem('outline_engine_v2_state_A'), 'old');
  assert.strictEqual(disk.get('unrelated'), 'keep');
  const idb = await makeIdbStore(), sync = [];
  idb.store.setSyncSink({ onWrite(key) { sync.push(key); } });
  idb.store.beginTransaction(); idb.store.setItem('world_engine_A', 'old'); idb.store.setItem('outline_engine_v2_state_A', 'old');
  let persisted = idb.store.commitTransaction();
  assert.strictEqual(sync.length, 0, 'IDB versions are not synced before durable completion');
  idb.transactions.at(-1).oncomplete(); await persisted;
  assert.strictEqual(sync.length, 2);
  sync.length = 0;
  idb.store.beginTransaction(); idb.store.setItem('world_engine_A', 'new'); idb.store.setItem('outline_engine_v2_state_A', 'new');
  persisted = idb.store.commitTransaction(); idb.transactions.at(-1).abort();
  await assert.rejects(persisted, /aborted/);
  assert.strictEqual(idb.store.getItem('world_engine_A'), 'old');
  assert.strictEqual(idb.store.getItem('outline_engine_v2_state_A'), 'old');
  assert.strictEqual(sync.length, 0, 'failed versions never enter chat metadata');
  assert.strictEqual(idb.failures.length, 1);
  idb.failPut('outline_engine_v2_state_A');
  idb.store.beginTransaction(); idb.store.setItem('world_engine_A', 'new'); idb.store.setItem('outline_engine_v2_state_A', 'new');
  assert.throws(() => idb.store.commitTransaction(), /put failed/);
  assert.strictEqual(idb.store.getItem('world_engine_A'), 'old', 'synchronous put failure aborts the entire batch');
  console.log('story storage transaction tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
