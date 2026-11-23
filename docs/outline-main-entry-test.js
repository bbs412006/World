// 剧情大纲 v3 主界面入口、悬浮球与统一主题联动测试：node docs/outline-main-entry-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootPath = path.resolve(__dirname, '..');

function makeElement(tagName = 'div', byId = null) {
  const attrs = new Map();
  const children = [];
  let innerHTML = '';
  const el = {
    tagName: tagName.toUpperCase(),
    id: '',
    className: '',
    dataset: {},
    style: {},
    textContent: '',
    scrollTop: 0,
    parentElement: null,
    classList: {
      add(...names) { const set = new Set((el.className || '').split(/\s+/).filter(Boolean)); names.forEach(n => set.add(n)); el.className = [...set].join(' '); },
      remove(...names) { const set = new Set((el.className || '').split(/\s+/).filter(Boolean)); names.forEach(n => set.delete(n)); el.className = [...set].join(' '); },
      toggle(name, force) { const has = el.classList.contains(name); const next = force === undefined ? !has : Boolean(force); if (next) el.classList.add(name); else el.classList.remove(name); return next; },
      contains(name) { return (el.className || '').split(/\s+/).includes(name); }
    },
    setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') { el.id = String(v); if (byId) byId.set(el.id, el); } },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    appendChild(child) { child.parentElement = el; children.push(child); if (child.id && byId) byId.set(child.id, child); return child; },
    addEventListener() {},
    querySelector(sel) {
      if (sel.startsWith('#')) {
        const target = sel.slice(1);
        for (const c of children) {
          if (c.id === target) return c;
          const found = c.querySelector?.(sel);
          if (found) return found;
        }
        return null;
      }
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        for (const c of children) {
          if (c.classList.contains(cls)) return c;
          const found = c.querySelector?.(sel);
          if (found) return found;
        }
        const stub = makeElement('div', byId);
        stub.classList.add(cls);
        children.push(stub);
        return stub;
      }
      return null;
    },
    querySelectorAll() { return []; },
    get innerHTML() { return innerHTML; },
    set innerHTML(html) {
      innerHTML = String(html || '');
      children.length = 0;
      const re = /<[a-zA-Z]([^>]*?)>/g;
      let m;
      while ((m = re.exec(innerHTML))) {
        const attrsStr = m[1];
        const idM = /\sid="([^"]+)"/.exec(attrsStr);
        const clsM = /\sclass="([^"]+)"/.exec(attrsStr);
        if (!idM && !clsM) continue;
        const child = makeElement('div', byId);
        if (idM) { child.id = idM[1]; if (byId) byId.set(child.id, child); }
        if (clsM) child.className = clsM[1];
        children.push(child);
      }
    }
  };
  return el;
}

async function run() {
  const storage = new Map();
  const byId = new Map();
  const bodyEl = makeElement('body', byId);
  const docEl = makeElement('html', byId);

  const sandbox = {
    window: null,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener() {},
    removeEventListener() {},
    MutationObserver: class { observe() {} disconnect() {} },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    document: {
      documentElement: docEl,
      head: makeElement('head'),
      body: bodyEl,
      getElementById: id => byId.get(id) || bodyEl.querySelector('#' + id) || null,
      querySelector: sel => (sel.startsWith('#') ? byId.get(sel.slice(1)) || null : null),
      querySelectorAll: () => [],
      createElement: tag => makeElement(tag, byId),
      addEventListener() {}
    },
    SillyTavern: { getContext: () => ({ chatId: 'main-entry-v3', chat: [] }) },
    WORLD_ENGINE_STORE: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    WORLD_ENGINE_CORE: {
      getChatId: () => 'main-entry-v3',
      getChatLayer: () => 0,
      restoreCheckpoint: () => null,
      loadState: () => ({ round: 0, time: 1, events: [], factions: [], worldTrends: [], winds: [], economy: { climate: '平稳', signals: [] }, reputation: {}, enemies: [], influenceChain: [], regionalIncident: null, blackbox: {} }),
      renderUserName: t => String(t || '')
    },
    WORLD_ENGINE_API: {
      getSettings: () => ({ engineEnabled: true, displayMode: 'mask', connectionMode: 'proxy', apiUrl: 'https://world.sync/v1', apiKey: 'w-secret' }),
      fetchModelList: async () => ['gpt-4o-mini'],
      testConnection: async () => ({ ok: true, latencyMs: 32 })
    },
    WORLD_ENGINE_EVOLUTION: { isRunning: () => false, abort() {} },
    WORLD_ENGINE_CHATCACHE: { forScope: () => ({ listSnapshots: () => [], createSnapshot: () => null }) },
    MEMORY_ENGINE_SETTINGS: { VERSION: '2.0.0', getSettings: () => ({ engineEnabled: true }) },
    MEMORY_ENGINE_DATA: { loadState: () => ({ tables: {} }), tableRowCounts: () => ({ totalRows: 0 }) }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  for (const file of ['outline-engine-settings.js', 'outline-engine-data.js', 'outline-engine-prompt.js', 'outline-engine.js', 'world-engine-ui.js', 'outline-engine-ui.js']) {
    vm.runInContext(fs.readFileSync(path.join(rootPath, file), 'utf8'), sandbox, { filename: file });
  }

  // 1. 未注册 outline 时隔离
  sandbox.WORLD_ENGINE_UI.buildInputButton();
  sandbox.WORLD_ENGINE_UI.showPanel();
  const ball = byId.get('we-input-btn');
  const ballOutlineSwitch = ball.querySelector('#we-sat-outline-switch');
  assert.strictEqual(ballOutlineSwitch.style.display, 'none', '未注册剧情大纲时悬浮球不应显示大纲切换钮');

  // 2. 注册 outline 后，顺序固定为 world · memory · outline，且悬浮球与主界面入口齐全
  sandbox.OUTLINE_ENGINE_UI.init();
  sandbox.WORLD_ENGINE_UI.refresh();
  assert.strictEqual(ballOutlineSwitch.style.display, '', '注册剧情大纲后悬浮球左下角切换钮必须可见');
  const faces = sandbox.WORLD_ENGINE_UI.listEngineFaces();
  assert.deepStrictEqual([...faces.map(f => f.id)], ['world', 'memory', 'outline'], '顶部切换栏顺序固定为 世界 · 记忆 · 剧情大纲');

  const outlineFace = faces.find(f => f.id === 'outline');
  assert.strictEqual(outlineFace.getHeaderText(), '尚未建纲');
  assert.strictEqual(outlineFace.getHeaderMood().text, '未启用');

  // 启用后空大纲 mood 显示「尚未设置剧情大纲」
  outlineFace.setEnabled(true);
  assert.strictEqual(outlineFace.getHeaderMood().text, '尚未设置剧情大纲');

  // 3. 独立主题保存、复制世界 API、拉取模型、测试连接与设置保存
  await sandbox.OUTLINE_ENGINE_UI._test.handleAction('toggle-settings');
  await sandbox.OUTLINE_ENGINE_UI._test.handleAction('copy-world-api');
  await sandbox.OUTLINE_ENGINE_UI._test.handleAction('fetch-models');
  sandbox.OUTLINE_ENGINE_UI._test.captureInput({ id: 'we-outline-model-list', value: 'gpt-4o-mini', dataset: {} });
  await sandbox.OUTLINE_ENGINE_UI._test.handleAction('test-api');
  assert.ok(sandbox.OUTLINE_ENGINE_UI.render().includes('连接正常（32ms）'));
  sandbox.OUTLINE_ENGINE_UI._test.captureInput({ id: 'we-outline-theme-select', value: 'deepsea', dataset: {} });
  assert.strictEqual(outlineFace.getTheme(), 'deepsea', '大纲独立主题应生效');
  await sandbox.OUTLINE_ENGINE_UI._test.handleAction('save-settings');
  const saved = sandbox.OUTLINE_ENGINE_SETTINGS.getSettings(true);
  assert.strictEqual(saved.apiUrl, 'https://world.sync/v1');
  assert.strictEqual(saved.model, 'gpt-4o-mini');

  console.log('outline v3 main entry & UI tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
