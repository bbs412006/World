// 剧情大纲 v3 运行时测试：node docs/outline-runtime-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createEnv(initialChat) {
  const store = new Map();
  const listeners = new Map();
  const injections = new Map();
  const snapshots = [];
  const calls = [];
  let apiHandler = null;
  const chat = initialChat.map(m => ({ ...m }));
  const types = {
    GENERATION_STARTED: 'generation_started',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',
    CHAT_CHANGED: 'chat_id_changed',
    CHAT_LOADED: 'chat_loaded',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_EDITED: 'message_edited'
  };

  const ctx = {
    chatId: 'outline-v3-runtime-chat',
    chat,
    name1: '林墨',
    name2: '旁白',
    event_types: types,
    eventSource: {
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      },
      emit(name, ...args) {
        for (const fn of listeners.get(types[name] || name) || []) fn(...args);
      }
    },
    setExtensionPrompt(name, content, position, depth) {
      injections.set(name, { content, position, depth });
    }
  };

  const sandbox = {
    window: null,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    Date,
    Math,
    SillyTavern: { getContext: () => ctx },
    WORLD_ENGINE_STORE: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    WORLD_ENGINE_CORE: {
      getChatId: () => ctx.chatId,
      filterDialogue: v => v
    },
    WORLD_ENGINE_CHATCACHE: {
      forScope: () => ({
        whenReady: () => Promise.resolve(),
        createSnapshot: name => { snapshots.push(name); return { id: 's1', name }; }
      })
    },
    WORLD_ENGINE_UI: { refresh() {}, updateBallControls() {} },
    WORLD_ENGINE_API: {
      getSettings: () => ({ apiKey: 'WORLD_SECRET_KEY', acceptOutlineGuidance: true }),
      setNextRequestMeta() {},
      updateRequestLog() {},
      async callApi(prompt, maxTokens, temp, signal, cfg) {
        calls.push({ prompt, maxTokens, temp, cfg });
        if (apiHandler) return apiHandler(prompt, { maxTokens, temp, signal, cfg });
        throw new Error('apiHandler not set');
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['outline-engine-settings.js', 'outline-engine-data.js', 'outline-engine-prompt.js', 'outline-engine.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  }
  return { sandbox, ctx, chat, calls, injections, snapshots, setApiHandler(fn) { apiHandler = fn; } };
}

(async () => {
  // 1. 禁用时不注入、不检查；启用后支持自定义注入位置与防剧透双轨注入
  {
    const env = createEnv([
      { is_user: false, name: '旁白', mes: '开场白' },
      { is_user: true, name: '林墨', mes: '走入青石镇' },
      { is_user: false, name: '旁白', mes: '镇外古井泛着异味。' }
    ]);
    const { OUTLINE_ENGINE_SETTINGS: cfg, OUTLINE_ENGINE_DATA: data, OUTLINE_ENGINE: eng } = env.sandbox;
    data.commitPlan({
      title: '青石镇卷',
      publicSynopsis: '少年追查古井异味',
      publicConstraints: '保持克制悬疑节奏',
      authorNotes: '幕后真凶是镇长周大福',
      chapters: [
        { id: 'c1', title: '第一章 毒井', goal: '查清古井异常' },
        { id: 'c2', title: '第二章 摊牌', goal: '公堂对质' }
      ],
      tracks: [
        { id: 'm', kind: 'main', title: '主线' },
        { id: 'h', kind: 'hidden', title: '镇长暗线' }
      ],
      nodes: [
        { id: 'n1', trackId: 'm', chapterIds: ['c1'], title: '采集井水', publicHint: '古井边似乎留有脚印', completionCriteria: '成功取回井水样本', secretNotes: '毒药来自北境', required: true },
        { id: 'n2', trackId: 'm', chapterIds: ['c2'], dependencies: ['n1'], title: '揭穿真凶', publicHint: '前往镇公所', completionCriteria: '当众拿出证据', required: true },
        { id: 'h1', trackId: 'h', chapterIds: ['c1'], title: '周大福密谋', publicHint: '镇长书房深夜有黑影闪过', secretNotes: '周大福收受北境贿赂', required: false }
      ]
    }, 0);

    assert.strictEqual(eng.applyInjection(), '', '未启用时不得注入主聊天');
    assert.strictEqual((await eng.checkNow()).reason, 'disabled');

    cfg.patchSettings({ engineEnabled: true, apiUrl: 'https://outline.test/v1', apiKey: '', model: 'outline-m1', injectPosition: 1, injectDepth: 2 });
    const front = eng.applyInjection();
    const slot = env.injections.get('outline-engine-outline');
    assert.strictEqual(slot.position, 1);
    assert.strictEqual(slot.depth, 2, '应使用配置的注入深度');
    assert.ok(front.startsWith('【剧情指导】'), '前台注入必须含哨兵头');
    assert.ok(front.includes('古井边似乎留有脚印'), '应注入公开节点提示');
    assert.ok(!front.includes('周大福') && !front.includes('北境') && !front.includes('镇长书房深夜有黑影闪过'), '严禁向前台泄露作者备忘、幕后备注或未显露暗线');

    const backend = eng.buildWorldGuidance();
    assert.ok(backend.startsWith('【剧情指导：作者后台专用】'));
    assert.ok(backend.includes('周大福') && backend.includes('北境'), '世界后台指导应包含幕后真相与暗线备注');
  }

  // 2. 连续两次 checkNow 绝不因冷却漏检当前主线节点 + JSON 带错回灌纠错重试 + 暗线自动显露 + 独立 API Key 隔离
  {
    const env = createEnv([
      { is_user: false, name: '旁白', mes: '开场白' },
      { is_user: true, name: '林墨', mes: '我蹲在井边查看脚印' },
      { is_user: false, name: '旁白', mes: '井沿沾着可疑的白色粉末，远处镇长书房灯火一闪而灭。' }
    ]);
    const { OUTLINE_ENGINE_SETTINGS: cfg, OUTLINE_ENGINE_DATA: data, OUTLINE_ENGINE: eng } = env.sandbox;
    cfg.patchSettings({ engineEnabled: true, apiUrl: 'https://outline.test/v1', apiKey: '', model: 'outline-m1', formatMaxRetries: 2 });
    data.commitPlan({
      title: '测试卷',
      chapters: [
        { id: 'c1', title: '第一章', goal: '调查' },
        { id: 'c2', title: '第二章', goal: '收尾' }
      ],
      tracks: [
        { id: 'm', kind: 'main', title: '主线' },
        { id: 'h', kind: 'hidden', title: '暗线' }
      ],
      nodes: [
        { id: 'n1', trackId: 'm', chapterIds: ['c1'], title: '查验井水', publicHint: '查井', completionCriteria: '确认井水含毒并取样', required: true },
        { id: 'n2', trackId: 'm', chapterIds: ['c2'], dependencies: ['n1'], title: '对质', publicHint: '对质', completionCriteria: '对质完成', required: true },
        { id: 'h1', trackId: 'h', chapterIds: ['c1'], title: '书房黑影', publicHint: '书房灯火异样', secretNotes: '镇长密会', required: false }
      ]
    }, 0);

    // 第一次核对：故意先返回一次坏 JSON，验证自动纠错重试
    let attempt = 0;
    env.setApiHandler(async prompt => {
      attempt++;
      if (attempt === 1) return '抱歉我忘了输出JSON';
      assert.ok(prompt.includes('【纠错要求】'), '重试必须带回上轮报错');
      return JSON.stringify({
        nodeUpdates: [
          { nodeId: 'n1', status: 'active', reason: '已开始查验井水' },
          { nodeId: 'h1', status: 'active', reason: '镇长书房灯火闪动被察觉', revealPublic: true }
        ]
      });
    });

    const r1 = await eng.checkNow();
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(attempt, 2, '应在第一次脏输出后自动纠错重试成功');
    assert.strictEqual(env.calls[0].cfg.apiKey, '', '大纲 API Key 留空时绝不回退读取世界引擎 API Key');
    assert.strictEqual(data.getNodeStatus(data.loadState(), 'n1'), 'active');
    assert.strictEqual(data.getNode(data.loadState(), 'h1').revealPublic, true, '暗线节点显露后应置 revealPublic=true');
    const frontAfterReveal = eng.applyInjection();
    assert.ok(frontAfterReveal.includes('[表面线索] 书房灯火异样') && !frontAfterReveal.includes('镇长密会') && !frontAfterReveal.includes('书房黑影'), '显露暗线仅输出表面公开提示，仍不泄露标题与幕后真相');

    // 第二轮对话后紧接着第二次 checkNow：n1 绝不被冷却排除！
    env.chat.push(
      { is_user: true, name: '林墨', mes: '我用银针试水并装瓶带走' },
      { is_user: false, name: '旁白', mes: '银针变黑，你顺利封存了毒水样本。' }
    );
    let sawN1InSecondCheck = false;
    env.setApiHandler(async prompt => {
      sawN1InSecondCheck = prompt.includes('[n1]');
      return JSON.stringify({
        nodeUpdates: [{ nodeId: 'n1', status: 'completed', reason: '银针验毒并封存样本' }]
      });
    });
    const r2 = await eng.checkNow();
    assert.strictEqual(sawN1InSecondCheck, true, '连续第二次核对绝不能因冷却漏掉进行中的主线节点 n1');
    assert.strictEqual(r2.chapterAdvanced, true, '完成 n1 后应自动进入第二章');
    assert.strictEqual(data.loadState().currentChapterId, 'c2');

    // 3. 删楼 0ms 自动回退：删除第 3-4 楼，n1 自动退回 active（L2），章节自动退回第一章！
    eng.init();
    env.chat.splice(3);
    env.ctx.eventSource.emit('MESSAGE_DELETED');
    assert.strictEqual(data.loadState().currentChapterId, 'c1', '删楼后章节应 0ms 自动回退至第一章');
    assert.strictEqual(data.getNodeStatus(data.loadState(), 'n1'), 'pending', 'L4 完成覆盖写入后，删至 L2 应撤回该完成记录');

    // 4. 清空大纲自动留存快照并清除注入
    const cleared = eng.clearAllOutlineData({ backup: true });
    assert.strictEqual(cleared.cleared, true);
    assert.strictEqual(env.snapshots.length, 1, '清空大纲前应自动创建快照备份');
    assert.strictEqual(env.injections.get('outline-engine-outline').content, '', '清空大纲后应立即撤下注入');
  }

  // 5. organizeText 文本整理预览不直接覆写存档
  {
    const env = createEnv([{ is_user: false, name: '旁白', mes: '开场' }]);
    const { OUTLINE_ENGINE_SETTINGS: cfg, OUTLINE_ENGINE_DATA: data, OUTLINE_ENGINE: eng } = env.sandbox;
    cfg.patchSettings({ apiUrl: 'https://outline.test/v1', model: 'm1' });
    env.setApiHandler(async () => JSON.stringify({
      title: '整理卷',
      chapters: [{ id: 'ch1', title: '序章', goal: '起程' }],
      tracks: [{ id: 't1', kind: 'main', title: '主线' }],
      nodes: [{ id: 'n1', trackId: 't1', chapterIds: ['ch1'], title: '出发', completionCriteria: '离村' }]
    }));
    const out = await eng.organizeText('主角离开山村踏上旅途');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.plan.chapters.length, 1);
    assert.strictEqual(data.loadState().plan.chapters.length, 0, 'organizeText 仅生成预览，不得未经确认直接落盘');
  }

  console.log('outline v3 runtime tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
