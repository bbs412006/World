// 剧情大纲 v3 UI 渲染、XSS 防护、独立设置与草稿隔离测试：node docs/outline-ui-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

async function main() {
  const store = new Map();
  let currentChat = 'ui-chat-1';
  let aborted = 0;
  let injected = 0;
  const faces = [];

  const sandbox = {
    window: null,
    console,
    confirm: () => true,
    document: { documentElement: { setAttribute() {}, removeAttribute() {} }, getElementById: () => null },
    SillyTavern: { getContext: () => ({ chatId: currentChat, chat: [] }) },
    WORLD_ENGINE_STORE: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    WORLD_ENGINE_CORE: { getChatId: () => currentChat },
    WORLD_ENGINE_CHATCACHE: { forScope: () => ({ listSnapshots: () => [], createSnapshot: () => null }) },
    WORLD_ENGINE_API: { getSettings: () => ({ apiUrl: 'https://world.test/v1', apiKey: 'wkey', model: 'wm' }) },
    WORLD_ENGINE_UI: {
      registerEngineFace: f => faces.push(f),
      refresh() {},
      showToast() {},
      renderLastPromptViewer: () => '<div class="we-last-prompt-mock">mock</div>'
    },
    OUTLINE_ENGINE: {
      abort: () => { aborted++; },
      applyInjection: () => { injected++; },
      buildNarrativeGuidance: () => '【剧情指导】测试指导',
      buildWorldGuidance: () => '【剧情指导：作者后台专用】后台测试',
      getUnlockedOpenNodes: () => [],
      isRunning: () => false,
      getRunningLabel: () => '',
      getLastDebug: () => ({}),
      getLastError: () => ''
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['outline-engine-settings.js', 'outline-engine-data.js', 'outline-engine-ui.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  }

  const data = sandbox.OUTLINE_ENGINE_DATA;
  const ui = sandbox.OUTLINE_ENGINE_UI;
  const settings = sandbox.OUTLINE_ENGINE_SETTINGS;

  // 1. 注册幂等
  assert.strictEqual(ui.init(), true);
  assert.strictEqual(ui.init(), false, '重复 init 不得重复注册');
  assert.strictEqual(faces.length, 1);

  // 2. 首页精简结构（3 项两字纵轴导航，无死路由）
  const homeHtml = ui.render();
  assert.ok(homeHtml.includes('剧情脉络'));
  assert.ok(homeHtml.includes('data-outline-nav="progress"') && homeHtml.includes('data-outline-nav="tracks"') && homeHtml.includes('data-outline-nav="schedule"'));
  assert.ok(!homeHtml.includes('data-outline-nav="facts"') && !homeHtml.includes('view-recovery'), 'v3 已移除臃肿的五表线索页与死路由');

  // 3. XSS 转义
  data.commitPlan({
    title: '<script>alert(1)</script>',
    chapters: [{ id: 'c1', title: '<img src=x onerror=alert(2)>', goal: '目标' }],
    tracks: [{ id: 't1', kind: 'main', title: '主线' }],
    nodes: [{ id: 'n1', trackId: 't1', chapterIds: ['c1'], title: '<b>节点</b>', publicHint: '<svg onload=alert(3)>' }]
  }, 0);
  await ui._test.handleAction('view-tracks');
  const tracksHtml = ui.render();
  assert.ok(!tracksHtml.includes('<script>alert(1)'), '标题必须转义防止 XSS');
  assert.ok(!tracksHtml.includes('<img src=x'), '章节标题必须转义防止 XSS');
  assert.ok(!tracksHtml.includes('<svg onload='), '提示必须转义防止 XSS');

  // 4. 草稿按聊天隔离
  currentChat = 'ui-chat-2';
  assert.strictEqual(ui.getDraft().view, 'home', '切换聊天后草稿视图应独立');
  currentChat = 'ui-chat-1';
  assert.strictEqual(ui.getDraft().view, 'tracks');

  // 5. 设置保存不串改世界设置，空温度/空 maxTokens 正确回退，保存时 abort 并重算注入
  await ui._test.handleAction('toggle-settings');
  const setHtml = ui.render();
  assert.ok(setHtml.includes('we-outline-sec-toggle') && !setHtml.includes('class="we-section-toggle"'), '大纲折叠分区应独立，避免与世界全局折叠表串状态');
  assert.ok(setHtml.includes('we-settings-save-sticky') && setHtml.includes('保存设置'));

  ui._test.captureInput({ dataset: { outlineSetting: 'temperature' }, value: '' });
  ui._test.captureInput({ dataset: { outlineSetting: 'maxTokens' }, value: '' });
  ui._test.captureInput({ dataset: { outlineSetting: 'formatMaxRetries' }, value: '3' });
  ui._test.captureInput({ dataset: { outlineSetting: 'injectDepth' }, value: '2' });
  await ui._test.handleAction('save-settings');
  const saved = settings.getSettings(true);
  assert.strictEqual(saved.temperature, 0.2, '清空温度应保存默认 0.2 而非 0');
  assert.strictEqual(saved.maxTokens, 8192, '清空 maxTokens 应保存默认 8192 而非 65000');
  assert.strictEqual(saved.formatMaxRetries, 3);
  assert.strictEqual(saved.injectDepth, 2);
  assert.ok(aborted >= 1 && injected >= 1);

  console.log('outline v3 UI tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
