// 剧情大纲 v3 UI CRUD 与备份清空测试：node docs/outline-crud-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

async function main() {
  const store = new Map();
  const snapshots = [];
  const injections = new Map();
  let registeredFace = null;

  const sandbox = {
    window: null,
    console,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    document: { documentElement: { setAttribute() {}, removeAttribute() {} }, getElementById: () => null },
    SillyTavern: { getContext: () => ({ chatId: 'crud-v3', chat: [{ is_user: false, mes: '开场' }], setExtensionPrompt(k, v) { injections.set(k, v); } }) },
    WORLD_ENGINE_STORE: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    WORLD_ENGINE_CORE: { getChatId: () => 'crud-v3' },
    WORLD_ENGINE_CHATCACHE: {
      forScope: () => ({
        listSnapshots: () => snapshots,
        createSnapshot: name => { const s = { id: `snap_${snapshots.length + 1}`, name, createdAt: Date.now() }; snapshots.push(s); return s; }
      })
    },
    WORLD_ENGINE_UI: {
      registerEngineFace: face => { registeredFace = face; },
      refresh() {},
      showToast() {},
      updateBallControls() {}
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['outline-engine-settings.js', 'outline-engine-data.js', 'outline-engine-prompt.js', 'outline-engine.js', 'outline-engine-ui.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  }

  const data = sandbox.OUTLINE_ENGINE_DATA;
  const ui = sandbox.OUTLINE_ENGINE_UI;
  ui.init();
  assert.ok(registeredFace && registeredFace.id === 'outline');

  // 1. 新增章节、剧情线、节点
  await ui._test.handleAction('view-tracks');
  await ui._test.handleAction('add-chapter');
  ui._test.captureInput({ dataset: { inlineField: 'title' }, value: '第一章 启程' });
  ui._test.captureInput({ dataset: { inlineField: 'goal' }, value: '走出山村' });
  await ui._test.handleAction('save-inline');
  assert.strictEqual(data.loadState().plan.chapters.length, 1);

  await ui._test.handleAction('add-track');
  ui._test.captureInput({ dataset: { inlineField: 'title' }, value: '主线' });
  ui._test.captureInput({ dataset: { inlineField: 'kind' }, value: 'main' });
  await ui._test.handleAction('save-inline');
  const mainTrackId = data.loadState().plan.tracks[0].id;
  const chId = data.loadState().plan.chapters[0].id;

  await ui._test.handleAction('add-node', { dataset: { track: mainTrackId, chapter: chId } });
  ui._test.captureInput({ dataset: { inlineField: 'title' }, value: '收拾行囊' });
  ui._test.captureInput({ dataset: { inlineField: 'publicHint' }, value: '临行前整备物资' });
  ui._test.captureInput({ dataset: { inlineField: 'completionCriteria' }, value: '背起行囊离开家门' });
  ui._test.captureInput({ dataset: { inlineField: 'actorsText' }, value: '林墨, 老村长' });
  await ui._test.handleAction('save-inline');
  const node1 = data.loadState().plan.nodes[0];
  assert.strictEqual(node1.title, '收拾行囊');
  assert.deepStrictEqual([...node1.actors], ['林墨', '老村长']);

  // 新增第二个依赖 node1 的节点
  await ui._test.handleAction('add-node', { dataset: { track: mainTrackId, chapter: chId } });
  ui._test.captureInput({ dataset: { inlineField: 'title' }, value: '告别村口' });
  ui._test.captureInput({ dataset: { inlineDeps: node1.id }, checked: true });
  await ui._test.handleAction('save-inline');
  const node2 = data.loadState().plan.nodes[1];
  assert.deepStrictEqual([...node2.dependencies], [node1.id]);

  // 2. 删除 node1 自动清理 node2 的前置依赖
  await ui._test.handleAction('remove-node', { dataset: { id: node1.id } });
  const afterDel = data.loadState();
  assert.strictEqual(afterDel.plan.nodes.length, 1);
  assert.deepStrictEqual([...afterDel.plan.nodes[0].dependencies], [], '删除前置节点必须同步清理下游依赖');

  // 3. 清空大纲自动留存备份快照
  await ui._test.handleAction('clear-outline');
  assert.strictEqual(data.loadState().plan.chapters.length, 0);
  assert.strictEqual(data.loadState().plan.nodes.length, 0);
  assert.strictEqual(snapshots.length, 1, '清空大纲前应自动创建保存点快照');

  console.log('outline v3 CRUD tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
