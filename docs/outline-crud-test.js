// node docs/outline-crud-test.js — 剧情大纲瘦身看板与随时增删改、级联清理、手动线索持久化及备份清空离线回归测试
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

async function main() {
  const store = new Map();
  const snapshots = [];
  let registeredFace = null;
  let injections = new Map();
  let confirmResult = true;
  const confirmMessages = [];

  const ctx = {
    chatId: 'crud-chat',
    chat: [
      { is_user: false, name: '旁白', mes: '夜雨落在码头。' },
      { is_user: true, name: '主角', mes: '我查看石阶旁的脚印。' },
      { is_user: false, name: '旁白', mes: '石阶尽头露出一扇半掩的木门。' }
    ],
    event_types: {},
    eventSource: { on() {} },
    setExtensionPrompt(name, content) { injections.set(name, content); }
  };

  const sandbox = {
    console, setTimeout, clearTimeout, AbortController, Date, Math, Map, Set, Blob,
    localStorage: { getItem: () => null },
    document: { querySelector: () => null, createElement: () => ({ click() {} }) },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    SillyTavern: { getContext: () => ctx },
    WORLD_ENGINE_STORE: {
      getItem: k => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    WORLD_ENGINE_CORE: { getChatId: () => ctx.chatId, loadState: () => ({ events: [] }) },
    WORLD_ENGINE_API: { getSettings: () => ({ apiUrl: 'https://api.example/v1', model: 'm1' }), async callApi() { return JSON.stringify({ nodeUpdates: [], proposals: [] }); } },
    WORLD_ENGINE_CHATCACHE: {
      forScope: () => ({
        createSnapshot(name) { snapshots.push(name); return true; },
        listSnapshots: () => snapshots.map((n, i) => ({ id: 'snap_' + i, name: n, createdAt: Date.now() })),
        getStatus: () => ({ syncEnabled: false, localRev: 0, liveRev: 0 })
      })
    },
    WORLD_ENGINE_UI: {
      registerEngineFace(face) { registeredFace = face; },
      refresh() {}
    },
    confirm(msg) { confirmMessages.push(msg); return confirmResult; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  for (const file of [
    'memory-engine-timeline.js',
    'outline-engine-settings.js',
    'outline-engine-data.js',
    'outline-engine-scheduler.js',
    'outline-engine-prompt.js',
    'outline-engine.js',
    'outline-engine-ui.js'
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  }

  const data = sandbox.OUTLINE_ENGINE_DATA;
  const engine = sandbox.OUTLINE_ENGINE;
  const ui = sandbox.OUTLINE_ENGINE_UI;
  const settings = sandbox.OUTLINE_ENGINE_SETTINGS;

  ui.init();
  settings.patchSettings({ engineEnabled: true, injectIntoPrompt: true });

  // 1. 随时新增章节与剧情线
  await ui._test.handleAction('quick-add-chapter');
  assert.strictEqual(registeredFace.isEditing(), true, '原地新增章节时 isEditing 应返回 true 防止后台重绘抢焦点');
  ui._test.captureInput({ dataset: { outlineInlineField: 'title' }, value: '第一章 码头疑云', type: 'text' });
  ui._test.captureInput({ dataset: { outlineInlineField: 'goal' }, value: '查明接头人下落', type: 'textarea' });
  await ui._test.handleAction('quick-save-chapter');
  assert.strictEqual(data.loadState().plan.chapters.length, 1);
  assert.strictEqual(data.loadState().plan.chapters[0].title, '第一章 码头疑云');

  await ui._test.handleAction('quick-add-track');
  ui._test.captureInput({ dataset: { outlineInlineField: 'title' }, value: '暗涌线', type: 'text' });
  ui._test.captureInput({ dataset: { outlineInlineField: 'kind' }, value: 'main', type: 'select-one' });
  ui._test.captureInput({ dataset: { outlineInlineField: 'priority' }, value: '10', type: 'number' });
  await ui._test.handleAction('quick-save-track');
  assert.strictEqual(data.loadState().plan.tracks[0].title, '暗涌线');
  const mainTrackId = data.loadState().plan.tracks[0].id;
  const ch1Id = data.loadState().plan.chapters[0].id;

  // 2. 随时新增节点、原地编辑节点及条件、验证实时同步写入与注入
  await ui._test.handleAction('board-mode-chapter');
  await ui._test.handleAction('quick-add-node', { dataset: { outlineChapter: ch1Id, outlineTrack: mainTrackId } });
  const addedNid1 = ui._test.draftFor().inlineEdit.data.id;
  ui._test.captureInput({ dataset: { outlineNodeField: 'title', outlineNid: addedNid1 }, value: '找到线人', type: 'text' });
  ui._test.captureInput({ dataset: { outlineNodeField: 'intent', outlineNid: addedNid1 }, value: '线人在码头仓库接头', type: 'textarea' });
  ui._test.captureInput({ dataset: { outlineNodeField: 'completionCriteria', outlineNid: addedNid1 }, value: '双方对上暗号', type: 'textarea' });
  await ui._test.handleAction('quick-save-node');

  assert.strictEqual(data.loadState().plan.nodes.length, 1);
  assert.ok((injections.get('outline-engine-outline') || '').includes('找到线人'), '保存节点后应立即刷新正文注入');

  // 默认折叠节点卡片，点击展开细节
  const collapsedHtml = ui.render();
  assert.ok(collapsedHtml.includes('we-outline-node-body" hidden'), '节点卡片应默认收起详情避免冗长');
  await ui._test.handleAction('toggle-node', { dataset: { outlineNid: addedNid1 } });
  assert.ok(!ui.render().includes('we-outline-node-body" hidden'), '点击节点可展开详细判据');

  // 原地编辑节点 + 添加高阶依赖引用（为后面测试级联删除做准备）
  await ui._test.handleAction('quick-add-node', { dataset: { outlineChapter: ch1Id, outlineTrack: mainTrackId } });
  const addedNid2 = ui._test.draftFor().inlineEdit.data.id;
  ui._test.captureInput({ dataset: { outlineNodeField: 'title', outlineNid: addedNid2 }, value: '核实暗语内容', type: 'text' });
  ui._test.captureInput({ dataset: { outlineNodeList: 'dependencies', outlineNid: addedNid2 }, value: addedNid1, checked: true, type: 'checkbox' });
  await ui._test.handleAction('quick-save-node');

  // 把 addedNid1 绑定到章节 exitNodeIds，测试级联引用清理
  await ui._test.handleAction('quick-edit-chapter', { dataset: { outlineChapter: ch1Id } });
  ui._test.captureInput({ dataset: { outlineInlineList: 'exitNodeIds' }, value: addedNid1, checked: true, type: 'checkbox' });
  await ui._test.handleAction('quick-save-chapter');
  assert.ok(data.loadState().plan.chapters[0].exitNodeIds.includes(addedNid1));

  // 3. 测试删除节点自动级联清理前置依赖和章末门槛，不再死锁报错
  confirmMessages.length = 0;
  await ui._test.handleAction('quick-remove-node', { dataset: { outlineNid: addedNid1 } });
  assert.ok(confirmMessages.some(m => m.includes('1 个前置依赖') && m.includes('1 个章末门槛')), '删被引用节点应提示级联影响');
  const afterRemoveNode = data.loadState().plan;
  assert.strictEqual(afterRemoveNode.nodes.length, 1);
  assert.strictEqual(afterRemoveNode.nodes[0].id, addedNid2);
  assert.strictEqual(afterRemoveNode.nodes[0].dependencies.length, 0, '前置依赖引用必须自动清理');
  assert.strictEqual(afterRemoveNode.chapters[0].exitNodeIds.length, 0, '章末门槛引用必须自动清理');

  // 4. 测试原地修改大纲标题与梗概
  await ui._test.handleAction('quick-edit-plan');
  ui._test.captureInput({ dataset: { outlineInlineField: 'title' }, value: '海港秘闻', type: 'text' });
  ui._test.captureInput({ dataset: { outlineInlineField: 'synopsis' }, value: '夜半交易背后的秘密', type: 'textarea' });
  await ui._test.handleAction('quick-save-plan');
  assert.strictEqual(data.loadState().plan.title, '海港秘闻');

  // 5. 测试存在节点时删除剧情线：先增一条支线并移入/连同删除
  await ui._test.handleAction('quick-add-track');
  ui._test.captureInput({ dataset: { outlineInlineField: 'title' }, value: '备用支线', type: 'text' });
  ui._test.captureInput({ dataset: { outlineInlineField: 'kind' }, value: 'side', type: 'select-one' });
  await ui._test.handleAction('quick-save-track');
  const sideTrackId = data.loadState().plan.tracks[1].id;

  // 在暗涌线删线时选择节点迁移到备用支线
  await ui._test.handleAction('quick-remove-track', { dataset: { outlineTrack: mainTrackId } });
  assert.ok(ui.render().includes('请选择处理方式'), '线内有节点时原地给出迁移或一并删除选项');
  await ui._test.handleAction('quick-track-delete-move', { dataset: { outlineTrack: mainTrackId } });
  assert.strictEqual(data.loadState().plan.tracks.length, 1);
  assert.strictEqual(data.loadState().plan.nodes[0].trackId, sideTrackId, '节点应自动迁入保留线');

  // 连同线内节点一并删除
  await ui._test.handleAction('quick-remove-track', { dataset: { outlineTrack: sideTrackId } });
  await ui._test.handleAction('quick-track-delete-all', { dataset: { outlineTrack: sideTrackId } });
  assert.strictEqual(data.loadState().plan.tracks.length, 0);
  assert.strictEqual(data.loadState().plan.nodes.length, 0);

  // 6. 测试删除章节保留跨章节点
  await ui._test.handleAction('quick-add-node', { dataset: { outlineChapter: ch1Id } });
  const keepNodeId = ui._test.draftFor().inlineEdit.data.id;
  ui._test.captureInput({ dataset: { outlineNodeField: 'title', outlineNid: keepNodeId }, value: '跨章保留节点', type: 'text' });
  await ui._test.handleAction('quick-save-node');
  await ui._test.handleAction('quick-remove-chapter', { dataset: { outlineChapter: ch1Id } });
  assert.strictEqual(data.loadState().plan.chapters.length, 0);
  assert.strictEqual(data.loadState().plan.nodes.length, 1);
  assert.strictEqual(data.loadState().plan.nodes[0].chapterIds.length, 0, '删章后节点应变为跨章节点保留下来');

  // 7. 测试事实、独立线索、作者标记的增删改 + refreshClues 不覆写独立线索
  await ui._test.handleAction('view-facts');
  const seedState = data.loadState();
  seedState.privateFacts = [{ id: 'f_manual', text: '旧私密内容', commitId: 'c1', validity: 'valid', knownBy: [] }];
  seedState.authorFlags = { secretDoorOpen: true };
  data.saveState(seedState);

  await ui._test.handleAction('quick-edit-fact', { dataset: { outlineFact: 'f_manual' } });
  ui._test.captureInput({ dataset: { outlineInlineField: 'text' }, value: '修正后的私密事实', type: 'textarea' });
  await ui._test.handleAction('quick-save-fact');
  assert.strictEqual(data.loadState().privateFacts[0].text, '修正后的私密事实');

  await ui._test.handleAction('quick-add-clue');
  ui._test.captureInput({ dataset: { outlineInlineField: 'publicHint' }, value: '门缝里露出半片焦纸', type: 'textarea' });
  await ui._test.handleAction('quick-save-clue');
  const clueId = data.loadState().clues[0].id;
  assert.strictEqual(data.loadState().clues[0].available, true);

  // 校验后台检查期间，独立手动线索不会因没有 nodeId 而被 refreshClues 归零关闭
  await engine.checkNow();
  assert.strictEqual(data.loadState().clues[0].available, true, '手动独立线索在检查后应保持开放');

  await ui._test.handleAction('toggle-clue-available', { dataset: { outlineClue: clueId } });
  assert.strictEqual(data.loadState().clues[0].available, false);
  await ui._test.handleAction('quick-edit-clue', { dataset: { outlineClue: clueId } });
  ui._test.captureInput({ dataset: { outlineInlineField: 'publicHint' }, value: '门缝里新添了一把铜钥匙', type: 'textarea' });
  await ui._test.handleAction('quick-save-clue');
  assert.strictEqual(data.loadState().clues[0].publicHint, '门缝里新添了一把铜钥匙');

  await ui._test.handleAction('quick-remove-clue', { dataset: { outlineClue: clueId } });
  assert.strictEqual(data.loadState().clues.length, 0);
  await ui._test.handleAction('quick-remove-fact', { dataset: { outlineFact: 'f_manual' } });
  assert.strictEqual(data.loadState().privateFacts.length, 0);
  await ui._test.handleAction('author-flag-remove', { dataset: { outlineFlag: 'secretDoorOpen' } });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(data.loadState().authorFlags, 'secretDoorOpen'), false);

  // 8. 测试全局草稿与即时修改碰撞保护 + 一键清空大纲（带自动保存点备份）
  await ui._test.handleAction('edit-plan');
  ui._test.captureInput({ dataset: { outlinePlanField: 'title' }, value: '未提交的批量草稿', type: 'text' });
  await ui._test.handleAction('close-editor');
  confirmResult = false;
  await ui._test.handleAction('quick-edit-plan');
  assert.ok(ui._test.draftFor().plan && !ui._test.draftFor().inlineEdit, '取消确认时不得丢弃全局草稿');
  confirmResult = true;
  await ui._test.handleAction('clear-outline');
  assert.ok(snapshots.includes('清空大纲前自动备份'), '清空大纲前必须先生成自动保存点');
  assert.strictEqual(data.loadState().plan.title, '');
  assert.strictEqual(data.loadState().plan.nodes.length, 0);
  assert.strictEqual(ui._test.draftFor().plan, null);

  console.log('outline slimmed UI & inline CRUD / cascade delete tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
