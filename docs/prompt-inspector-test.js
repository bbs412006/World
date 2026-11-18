// node docs/prompt-inspector-test.js — 上次正文生成完整提示词捕获、三模块注入顺序识别与共用查看器离线回归测试
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function makeElement(tag = 'div', id = '') {
  const attrs = {}, listeners = {};
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
      add(...n) { n.forEach(k => classes.add(k)); },
      remove(...n) { n.forEach(k => classes.delete(k)); },
      toggle(k, force) { const next = force === undefined ? !classes.has(k) : Boolean(force); if (next) classes.add(k); else classes.delete(k); return next; },
      contains: k => classes.has(k)
    },
    set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach(n => classes.add(n)); },
    get className() { return [...classes].join(' '); },
    setAttribute(k, v) {
      attrs[k] = String(v);
      if (k === 'id') el.id = String(v);
      if (k.startsWith('data-')) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    },
    getAttribute: k => attrs[k] ?? null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    appendChild(c) { c.parentElement = el; el.children.push(c); return c; },
    set innerHTML(v) { el._innerHTML = String(v || ''); },
    get innerHTML() { return el._innerHTML; },
    set textContent(v) { el._textContent = String(v ?? ''); },
    get textContent() { return el._textContent; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 600 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => true,
    scrollIntoView() {}
  };
  return el;
}

async function main() {
  const store = new Map();
  const events = new Map();
  const bodyEl = makeElement('body');
  const byId = new Map();
  const docEl = makeElement('html');
  docEl.removeAttribute = () => {};

  const ctx = {
    chatId: 'inspector-test-chat',
    chat: [{ is_user: true, name: '你', mes: '推开大门' }],
    event_types: {
      CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
      GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
      CHAT_LOADED: 'chat_loaded'
    },
    extensionPrompts: {
      'world-engine-world': { value: '【世界信息】下雨了' },
      'memory-engine-memory': { value: '【记忆信息】认识守卫' },
      'outline-engine-outline': { value: '【剧情指导】进入大厅' }
    },
    eventSource: { on(name, fn) { events.set(name, fn); } }
  };

  const sandbox = {
    console, setTimeout, clearTimeout, Date, Math, Map, Set, Blob,
    innerWidth: 1280, innerHeight: 800,
    addEventListener() {},
    MutationObserver: class { observe() {} disconnect() {} },
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      documentElement: docEl,
      body: bodyEl,
      createElement: tag => makeElement(tag),
      getElementById: id => byId.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    SillyTavern: { getContext: () => ctx },
    WORLD_ENGINE_STORE: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    WORLD_ENGINE_CORE: { getChatId: () => ctx.chatId, getChatLayer: () => 0, loadFingerprint: () => '', loadState: () => ({ round: 2, events: [] }), renderUserName: t => String(t || '') },
    WORLD_ENGINE_API: { getSettings: () => ({ injectIntoPrompt: true }) },
    WORLD_ENGINE_EVOLUTION: { isRunning: () => false, abort() {} },
    MEMORY_ENGINE_SETTINGS: { VERSION: '1.1.2', getSettings: () => ({ engineEnabled: true, injectIntoPrompt: true }) },
    MEMORY_ENGINE_DATA: { loadState: () => ({ personal_memory: [], entity_memory: {} }) }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  for (const file of [
    'world-engine-inject-inspector.js',
    'outline-engine-settings.js',
    'outline-engine-data.js',
    'outline-engine-scheduler.js',
    'world-engine-ui.js',
    'outline-engine-ui.js'
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  }

  const insp = sandbox.WORLD_ENGINE_INJECT_INSPECTOR;
  insp.init();
  sandbox.OUTLINE_ENGINE_SETTINGS.patchSettings({ engineEnabled: true, injectIntoPrompt: true });
  sandbox.OUTLINE_ENGINE_UI.init();

  // 1. 对话补全：分别注入三条（世界 → 记忆 → 大纲）
  const chatEvent = {
    dryRun: false,
    chat: [
      { role: 'system', content: '角色设定原文 <keep-raw>' },
      { role: 'user', content: '推开大门' },
      { role: 'system', content: '【世界信息】下雨了' },
      { role: 'system', content: '【记忆信息】认识守卫' },
      { role: 'system', content: '【剧情指导】进入大厅' }
    ]
  };
  events.get('chat_completion_prompt_ready')(chatEvent);

  const fullChat = insp.getLastFullPrompt();
  assert.ok(fullChat && fullChat.apiType === 'chat');
  assert.strictEqual(fullChat.order.map(item => item.scope).join(','), 'world,memory,outline', '应按实际出现的第3/4/5条依次记录为 world -> memory -> outline');
  assert.ok(fullChat.fullText.includes('角色设定原文 <keep-raw>'), '必须完整保留角色设定等上下文全文');
  assert.ok(fullChat.fullText.includes('【剧情指导】进入大厅'));

  // 2. dryRun 预热不得覆盖上次有效捕获
  events.get('chat_completion_prompt_ready')({ dryRun: true, chat: [{ role: 'user', content: '干跑内容' }] });
  assert.strictEqual(insp.getLastFullPrompt().order.length, 3, 'dryRun 不得冲掉真实正文快照');

  // 3. 验证 UI 渲染包含顺序展示、完整正文提示词全文卡片与各条模块标签
  const sharedHtml = sandbox.WORLD_ENGINE_UI.renderLastPromptViewer();
  assert.ok(sharedHtml.includes('世界信息(第3条) → 记忆信息(第4条) → 剧情指导(第5条)'), 'UI 应清晰显示三大模块真实注入顺序');
  assert.ok(sharedHtml.includes('上次正文生成完整提示词全文') && sharedHtml.includes('角色设定原文 &lt;keep-raw&gt;'), 'UI 应展示转义后的完整正文提示词');
  assert.ok(sharedHtml.includes('data-we-prompt-copy') && sharedHtml.includes('data-we-prompt-export'));

  // 4. 大纲面板「注入与调度」与「调试」页集成该查看器
  await sandbox.OUTLINE_ENGINE_UI._test.handleAction('view-schedule');
  const outlineSchedHtml = sandbox.OUTLINE_ENGINE_UI.render();
  assert.ok(outlineSchedHtml.includes('上次正文生成完整提示词') && outlineSchedHtml.includes('世界信息(第3条) → 记忆信息(第4条) → 剧情指导(第5条)'));
  await sandbox.OUTLINE_ENGINE_UI._test.handleAction('view-debug');
  assert.ok(sandbox.OUTLINE_ENGINE_UI.render().includes('上次正文生成完整提示词全文'));

  // 5. 文本补全模式：即使超过 340 字也必须完整保留全文，且按真实字符顺序（例如 记忆 → 大纲 → 世界）排序
  const longHeader = 'A'.repeat(500);
  const longBody = '【记忆信息】守卫记得旧伤；\n【剧情指导】不要剧透；\n【世界信息】大雨倾盆。' + 'B'.repeat(500);
  const rawPrompt = longHeader + '\n' + longBody;
  events.get('generate_after_combine_prompts')({ dryRun: false, prompt: rawPrompt });
  const fullTextMode = insp.getLastFullPrompt();
  assert.strictEqual(fullTextMode.apiType, 'text');
  assert.strictEqual(fullTextMode.fullText, rawPrompt, '文本补全模式下必须保存 100% 完整提示词，不得截断');
  assert.strictEqual(fullTextMode.order.map(item => item.scope).join(','), 'memory,outline,world', '应按实际字符串中出现的真实顺序排序');

  // 6. 切换聊天清空快照
  events.get('chat_loaded')();
  assert.strictEqual(insp.getLastFullPrompt(), null);
  assert.ok(sandbox.WORLD_ENGINE_UI.renderLastPromptViewer().includes('生成一次正文后'));

  console.log('prompt inspector & 3-module order tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
