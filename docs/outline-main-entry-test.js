// node docs/outline-main-entry-test.js — 主界面剧情大纲入口与重设计页面离线回归测试
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootPath = path.resolve(__dirname, '..');

function makeElement(tag = 'div', id = '') {
  const listeners = {};
  const attrs = {};
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(),
    id,
    dataset: {},
    style: {},
    children: [],
    parentElement: null,
    _innerHTML: '',
    _textContent: '',
    classList: {
      add(...names) { names.forEach(n => classes.add(n)); },
      remove(...names) { names.forEach(n => classes.delete(n)); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
      contains: name => classes.has(name)
    },
    set className(v) {
      classes.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach(n => classes.add(n));
    },
    get className() { return [...classes].join(' '); },
    setAttribute(k, v) {
      attrs[k] = String(v);
      if (k === 'id') el.id = String(v);
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.dataset[camel] = String(v);
      }
    },
    getAttribute(k) { return attrs[k] ?? null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    appendChild(child) { child.parentElement = el; el.children.push(child); return child; },
    set innerHTML(val) { el._innerHTML = String(val || ''); },
    get innerHTML() { return el._innerHTML; },
    set textContent(val) { el._textContent = String(val ?? ''); },
    get textContent() { return el._textContent; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 600 }),
    querySelector(sel) {
      if (sel === '#we-panel-body') return el._body || (el._body = makeElement('div', 'we-panel-body'));
      if (sel === '#we-panel-version') return el._ver || (el._ver = makeElement('span', 'we-panel-version'));
      if (sel === '.we-panel-close') return el._close || (el._close = makeElement('button'));
      if (sel === '.we-engine-face-toggle') return el._title || (el._title = makeElement('button'));
      if (sel === '#we-btn-settings-open') return el._settings || (el._settings = makeElement('button', 'we-btn-settings-open'));
      if (sel === '#we-face-switcher') return el._switcher || (el._switcher = makeElement('div', 'we-face-switcher'));
      if (sel === '.we-panel-header') return el._header || (el._header = makeElement('div'));
      if (sel === '.we-header-dot') return el._dot || (el._dot = makeElement('span'));
      if (sel === '.we-header-mood-text') return el._moodText || (el._moodText = makeElement('span'));
      if (sel === '.we-outline-root') return el;
      return null;
    },
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => true,
    scrollIntoView() {}
  };
  return el;
}

function runMainEntrySuite() {
  const storage = new Map();
  const bodyEl = makeElement('body');
  const byId = new Map();
  const docEl = makeElement('html');
  docEl.removeAttribute = () => {};

  const sandbox = {
    console, setTimeout: (fn) => { return setTimeout(fn, 0); }, clearTimeout, Date, Math, Map, Set, Blob,
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      documentElement: docEl,
      body: bodyEl,
      activeElement: null,
      createElement: tag => makeElement(tag),
      getElementById(id) {
        if (byId.has(id)) return byId.get(id);
        const panel = byId.get('we-panel');
        if (panel) {
          if (id === 'we-panel-body') return panel.querySelector('#we-panel-body');
          if (id === 'we-header-round') return byId.get('we-header-round') || (byId.set('we-header-round', makeElement('span', 'we-header-round')), byId.get('we-header-round'));
          if (id === 'we-header-mood') return byId.get('we-header-mood') || (byId.set('we-header-mood', makeElement('div', 'we-header-mood')), byId.get('we-header-mood'));
        }
        return null;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    SillyTavern: { getContext: () => ({ chatId: 'chat-main-test', chat: [] }) },
    WORLD_ENGINE_STORE: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: k => storage.delete(k)
    },
    WORLD_ENGINE_CORE: {
      getChatId: () => 'chat-main-test',
      getChatLayer: () => 0,
      loadState: () => ({ round: 1, events: [], factions: [], winds: [], worldTrends: [], memories: [], worldDigest: '世界摘要文本' }),
      restoreCheckpoint: () => null,
      renderUserName: t => String(t || '')
    },
    WORLD_ENGINE_EVOLUTION: { isRunning: () => false, abort() {} },
    WORLD_ENGINE_API: {
      getSettings: () => JSON.parse(storage.get('world_engine_settings') || '{}')
    },
    MEMORY_ENGINE_SETTINGS: {
      VERSION: '1.1.2',
      getSettings: () => ({ engineEnabled: true })
    },
    MEMORY_ENGINE_DATA: {
      loadState: () => ({ personal_memory: [], entity_memory: {}, event_memory: { small_summaries: [], big_summaries: [] } })
    },
    confirm: () => true
  };
  sandbox.window = sandbox;
  const origAppend = bodyEl.appendChild.bind(bodyEl);
  bodyEl.appendChild = (el) => {
    if (el.id) byId.set(el.id, el);
    return origAppend(el);
  };

  for (const file of ['outline-engine-settings.js', 'outline-engine-data.js', 'outline-engine-scheduler.js', 'world-engine-ui.js', 'outline-engine-ui.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(rootPath, file), 'utf8'), sandbox, { filename: file });
  }

  // 1. 未注册 outline 时，主界面不显示大纲入口（故障隔离）
  sandbox.WORLD_ENGINE_UI.showPanel();
  const panel = byId.get('we-panel');
  const panelBody = panel.querySelector('#we-panel-body');
  assert.ok(!panelBody.innerHTML.includes('data-face="outline"'), '未注册剧情大纲时主界面不应渲染大纲入口');
  const switcher = panel.querySelector('#we-face-switcher');
  assert.ok(!switcher.innerHTML.includes('data-switch-face="outline"'), '未注册剧情大纲时切换栏不应包含大纲');

  // 2. 注册 outline 后，主界面遮蔽模式 & 展开模式 & 顶部切换栏均展示剧情大纲入口
  sandbox.OUTLINE_ENGINE_UI.init();
  sandbox.WORLD_ENGINE_UI.refresh();
  assert.ok(switcher.innerHTML.includes('data-switch-face="outline"'), '顶部切换栏必须包含剧情大纲入口');
  assert.ok(switcher.innerHTML.includes('世界引擎') && switcher.innerHTML.includes('记忆引擎') && switcher.innerHTML.includes('剧情大纲'));
  assert.ok(panelBody.innerHTML.includes('data-face="outline"'), '主界面导航必须展示大纲入口');
  assert.ok(panelBody.innerHTML.includes('草蛇灰线，伏脉千里'), '主界面大纲入口应遵循同款古文句式');

  storage.set('world_engine_settings', JSON.stringify({ displayMode: 'expand' }));
  sandbox.WORLD_ENGINE_UI.refresh();
  assert.ok(panelBody.innerHTML.includes('id="we-sec-outline-entry"'), '展开模式主界面也必须展示剧情大纲入口卡片');
  assert.ok(panelBody.innerHTML.includes('data-switch-face="outline"'), '展开模式应提供直接打开剧情大纲按钮');

  // 3. 剧情大纲首页与分页结构检查（统一视觉语言）
  const outlineHtml = sandbox.OUTLINE_ENGINE_UI.render();
  assert.ok(outlineHtml.includes('we-outline-core-section') && outlineHtml.includes('剧情脉络'), '剧情大纲首页应包含核心环形仪表盘');
  assert.ok(outlineHtml.includes('we-outline-nav-list') && outlineHtml.includes('data-outline-nav="tracks"'), '剧情大纲首页应包含纵轴时间线导航');
  assert.ok(outlineHtml.includes('we-outline-home-chapter') && outlineHtml.includes('章节与进度'), '剧情大纲首页应包含章节与进度区块');

  // 4. 二级分页、设置选项卡与编辑器均使用统一的 we-sub-topbar 与 we-settings-tabs-shell
  return (async () => {
    for (const view of ['tracks', 'schedule', 'facts', 'recovery', 'transfer', 'debug']) {
      await sandbox.OUTLINE_ENGINE_UI._test.handleAction('view-' + view);
      const subHtml = sandbox.OUTLINE_ENGINE_UI.render();
      assert.ok(subHtml.includes('we-sub-topbar') && subHtml.includes('data-outline-action="view-home"'), `${view} 分页必须使用统一返回顶栏`);
    }

    await sandbox.OUTLINE_ENGINE_UI._test.handleAction('toggle-settings');
    const settingsHtml = sandbox.OUTLINE_ENGINE_UI.render();
    assert.ok(settingsHtml.includes('we-sub-topbar') && settingsHtml.includes('data-outline-action="close-settings"'), '设置页必须使用统一返回顶栏');
    assert.ok(settingsHtml.includes('we-settings-tabs-shell') && settingsHtml.includes('data-tab="common"') && settingsHtml.includes('data-tab="api"'), '设置页必须使用统一选项卡结构');
    assert.ok(settingsHtml.includes('we-settings-save-sticky'), '设置页底部保存栏应常驻');
    assert.ok(!/id="we-(?:api|model|fetch-models|save-settings)/.test(settingsHtml), '设置页不得使用世界/记忆冲突 ID');

    const faces = sandbox.WORLD_ENGINE_UI.listEngineFaces();
    const outlineFace = faces.find(f => f.id === 'outline');
    assert.ok(outlineFace && typeof outlineFace.getHeaderMood === 'function', 'outline face 应提供 getHeaderMood');
    assert.strictEqual(outlineFace.getHeaderText(), '尚未建纲');
    assert.ok(outlineFace.getHeaderMood().text.includes('尚未设置剧情大纲'));

    console.log('outline main entry & redesigned UI tests passed');
  })();
}

runMainEntrySuite().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
