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
      if (sel === '#we-sat-forward') return el._satFwd || (el._satFwd = makeElement('span', 'we-sat-forward'));
      if (sel === '#we-sat-redo') return el._satRedo || (el._satRedo = makeElement('span', 'we-sat-redo'));
      if (sel === '#we-sat-abort') return el._satAbort || (el._satAbort = makeElement('span', 'we-sat-abort'));
      if (sel === '#we-sat-power') return el._satPower || (el._satPower = makeElement('span', 'we-sat-power'));
      if (sel === '#we-sat-engine-switch') return el._satSwitch || (el._satSwitch = makeElement('span', 'we-sat-engine-switch'));
      if (sel === '#we-sat-outline-switch') return el._satOutline || (el._satOutline = makeElement('span', 'we-sat-outline-switch'));
      if (sel === '.we-ball-ring') return el._ballRing || (el._ballRing = makeElement('span'));
      if (sel === '.we-ball-badge') return el._ballBadge || (el._ballBadge = makeElement('span'));
      if (sel === '.we-ball-count') return el._ballCount || (el._ballCount = makeElement('span'));
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
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    MutationObserver: class { observe() {} disconnect() {} },
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
      getSettings: () => JSON.parse(storage.get('world_engine_settings') || '{}'),
      fetchModelList: async () => ['gpt-4o-mini', 'claude-3-5-sonnet']
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

  // 1. 未注册 outline 时，主界面与悬浮球均不显示大纲入口（故障隔离）
  sandbox.WORLD_ENGINE_UI.buildInputButton();
  sandbox.WORLD_ENGINE_UI.showPanel();
  const ball = byId.get('we-input-btn');
  const ballOutlineSwitch = ball.querySelector('#we-sat-outline-switch');
  const ballEngineSwitch = ball.querySelector('#we-sat-engine-switch');
  assert.strictEqual(ballOutlineSwitch.style.display, 'none', '未注册剧情大纲时悬浮球不应显示大纲切换钮');
  assert.strictEqual(ballEngineSwitch.dataset.targetEngine, 'memory', '未注册剧情大纲时世界面右下角卫星应指向记忆引擎');
  const panel = byId.get('we-panel');
  const panelBody = panel.querySelector('#we-panel-body');
  assert.ok(!panelBody.innerHTML.includes('data-face="outline"'), '未注册剧情大纲时主界面不应渲染大纲入口');
  const switcher = panel.querySelector('#we-face-switcher');
  assert.ok(!switcher.innerHTML.includes('data-switch-face="outline"'), '未注册剧情大纲时切换栏不应包含大纲');

  // 2. 注册 outline 后，主界面遮蔽模式、展开模式、顶部切换栏与悬浮球左下角均展示剧情大纲入口
  sandbox.OUTLINE_ENGINE_UI.init();
  sandbox.WORLD_ENGINE_UI.refresh();
  assert.strictEqual(ballOutlineSwitch.style.display, '', '注册剧情大纲后悬浮球左下角切换钮必须可见');
  assert.strictEqual(ballOutlineSwitch.dataset.targetEngine, 'outline', '世界面下悬浮球大纲切换钮应指向剧情大纲');
  assert.ok(ballOutlineSwitch.classList.contains('we-sat-target-outline'), '悬浮球大纲切换钮应带大纲图标样式类');
  assert.strictEqual(ballEngineSwitch.dataset.targetEngine, 'memory', '世界面下右下角仍可一键切记忆引擎');
  const originalOutlineRunning = sandbox.OUTLINE_ENGINE?.isRunning;
  sandbox.OUTLINE_ENGINE = { ...(sandbox.OUTLINE_ENGINE || {}), isRunning: () => true, getRunningLabel: () => '检查剧情进度' };
  sandbox.WORLD_ENGINE_UI.refresh();
  assert.strictEqual(ballOutlineSwitch.dataset.engineRunning, 'true', '剧情大纲后台运行时悬浮球大纲按钮应同步运行态');
  assert.ok(ballOutlineSwitch.classList.contains('we-sat-engine-running'), '剧情大纲后台运行时悬浮球大纲按钮应启用脉冲动画类');
  sandbox.OUTLINE_ENGINE.isRunning = originalOutlineRunning || (() => false);
  sandbox.WORLD_ENGINE_UI.refresh();
  assert.ok(switcher.innerHTML.includes('data-switch-face="outline"'), '顶部切换栏必须包含剧情大纲入口');
  assert.ok(switcher.innerHTML.includes('世界引擎') && switcher.innerHTML.includes('记忆引擎') && switcher.innerHTML.includes('剧情大纲'));
  assert.ok(panelBody.innerHTML.includes('data-face="outline"'), '主界面导航必须展示大纲入口');
  assert.ok(panelBody.innerHTML.includes('草蛇灰线，伏脉千里'), '主界面大纲入口应遵循同款古文句式');

  storage.set('world_engine_settings', JSON.stringify({ displayMode: 'expand' }));
  sandbox.WORLD_ENGINE_UI.refresh();
  assert.ok(panelBody.innerHTML.includes('id="we-sec-outline-entry"'), '展开模式主界面也必须展示剧情大纲入口卡片');
  assert.ok(panelBody.innerHTML.includes('data-switch-face="outline"'), '展开模式应提供直接打开剧情大纲按钮');

  // 3. 剧情大纲瘦身首页与分页结构检查（统一视觉语言 + 职责一目了然）
  const outlineHtml = sandbox.OUTLINE_ENGINE_UI.render();
  assert.ok(outlineHtml.includes('we-outline-core-section') && outlineHtml.includes('剧情脉络'), '剧情大纲首页应包含核心环形仪表盘');
  assert.ok(outlineHtml.includes('we-outline-nav-list') && outlineHtml.includes('data-outline-nav="tracks"') && outlineHtml.includes('data-outline-nav="schedule"') && outlineHtml.includes('data-outline-nav="facts"'), '剧情大纲首页纵轴导航应保留剧情、注入、线索 3 项高频入口');
  assert.ok(!outlineHtml.includes('data-outline-nav="transfer"') && !outlineHtml.includes('data-outline-nav="recovery"'), '低频存档与恢复已收进设置页，不应占首页纵轴导航');
  assert.ok(outlineHtml.includes('we-outline-pos-section') && outlineHtml.includes('当前位置'), '剧情大纲首页应展示当前所处剧情位置');
  assert.ok(!outlineHtml.includes('we-outline-board-toolbar'), '完整剧情看板已放进导航“剧情”模块，首页不再重复平铺');

  // 4. 二级分页、设置选项卡与编辑器均使用统一的 we-sub-topbar 与 we-settings-tabs-shell
  return (async () => {
    await sandbox.OUTLINE_ENGINE_UI._test.handleAction('toggle-injection-preview');
    assert.ok(sandbox.OUTLINE_ENGINE_UI.render().includes('正文注入实时预览'), '首页应支持展开注入预览看作用内容');
    await sandbox.OUTLINE_ENGINE_UI._test.handleAction('toggle-injection-preview');

    await sandbox.OUTLINE_ENGINE_UI._test.handleAction('view-tracks');
    const tracksHtml = sandbox.OUTLINE_ENGINE_UI.render();
    assert.ok(tracksHtml.includes('we-outline-home-chapter') && tracksHtml.includes('we-outline-board-toolbar') && tracksHtml.includes('data-outline-action="board-mode-chapter"') && tracksHtml.includes('data-outline-action="board-mode-track"'), '剧情分页应直接采用完整剧情看板样式并支持按章节/按剧情线切换');

    for (const view of ['tracks', 'schedule', 'facts', 'recovery', 'transfer', 'debug']) {
      await sandbox.OUTLINE_ENGINE_UI._test.handleAction('view-' + view);
      const subHtml = sandbox.OUTLINE_ENGINE_UI.render();
      assert.ok(subHtml.includes('we-sub-topbar') && subHtml.includes('data-outline-action="view-home"'), `${view} 分页必须使用统一返回顶栏`);
    }
    await sandbox.OUTLINE_ENGINE_UI._test.handleAction('view-home');

    await sandbox.OUTLINE_ENGINE_UI._test.handleAction('toggle-settings');
    const settingsHtml = sandbox.OUTLINE_ENGINE_UI.render();
    assert.ok(settingsHtml.includes('we-sub-topbar') && settingsHtml.includes('data-outline-action="close-settings"'), '设置页必须使用统一返回顶栏');
    assert.ok(settingsHtml.includes('we-settings-tabs-shell') && settingsHtml.includes('data-tab="common"') && settingsHtml.includes('data-tab="api"') && settingsHtml.includes('聊天备份保存点'), '设置->存档选项卡应直接收纳保存点、导出与历史恢复');
    assert.ok(settingsHtml.includes('we-settings-save-sticky'), '设置页底部保存栏应常驻');
    assert.ok(settingsHtml.includes('id="we-outline-fetch-models"') && settingsHtml.includes('id="we-outline-apiAutoRetries"'), '大纲独立 API 设置应支持拉取模型列表与自动重试配置');
    assert.ok(!/id="we-(?:api|model|fetch-models|save-settings)/.test(settingsHtml), '设置页不得使用世界/记忆冲突 ID');

    sandbox.OUTLINE_ENGINE_UI._test.captureInput({ dataset: { outlineSetting: 'apiSource' }, value: 'custom', type: 'select-one' });
    sandbox.OUTLINE_ENGINE_UI._test.captureInput({ dataset: { outlineSetting: 'apiAutoRetries' }, value: '2', type: 'number' });
    await sandbox.OUTLINE_ENGINE_UI._test.handleAction('fetch-models');
    const afterFetchHtml = sandbox.OUTLINE_ENGINE_UI.render();
    assert.ok(afterFetchHtml.includes('id="we-outline-model-list"') && afterFetchHtml.includes('gpt-4o-mini'), '获取模型列表后应渲染模型下拉选框');
    sandbox.OUTLINE_ENGINE_UI._test.captureInput({ id: 'we-outline-model-list', dataset: {}, value: 'gpt-4o-mini', type: 'select-one' });
    await sandbox.OUTLINE_ENGINE_UI._test.handleAction('save-settings');
    assert.strictEqual(sandbox.OUTLINE_ENGINE_SETTINGS.getSettings(true).model, 'gpt-4o-mini');
    assert.strictEqual(sandbox.OUTLINE_ENGINE_SETTINGS.getSettings(true).apiAutoRetries, 2);

    // 同视图刷新应保持滚动条位置
    panelBody.scrollTop = 180;
    sandbox.WORLD_ENGINE_UI.refresh();
    assert.strictEqual(panelBody.scrollTop, 180, '同视图刷新应保留面板滚动位置');

    const faces = sandbox.WORLD_ENGINE_UI.listEngineFaces();
    const outlineFace = faces.find(f => f.id === 'outline');
    assert.ok(outlineFace && typeof outlineFace.getHeaderMood === 'function', 'outline face 应提供 getHeaderMood');
    assert.strictEqual(outlineFace.getHeaderText(), '尚未建纲');
    assert.ok(outlineFace.getHeaderMood().text.includes('尚未设置剧情大纲'));
    assert.strictEqual(typeof outlineFace.getScrollKey, 'function', 'outline face 应提供 getScrollKey');

    console.log('outline main entry & redesigned UI tests passed');
  })();
}

runMainEntrySuite().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
