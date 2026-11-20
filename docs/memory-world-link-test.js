// 世界→记忆联动与指数注入离线测试：node docs/memory-world-link-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const store = new Map();
let version = 'A';
let apiCalls = 0;
const chat = [{ is_user: false, name: '角色', mes: '测试场景' }];
const memorySettings = {
  engineEnabled: true,
  bigSummaryEveryX: 1,
  injectIntoPrompt: false,
  maxTokens: 2000,
  temperature: 0.2,
  apiAutoRetries: 0,
  filterRegex: ''
};

const sandbox = {
  window: null,
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  document: { getElementById() { return null; } },
  SillyTavern: { getContext() { return { chat }; } },
  WORLD_ENGINE_STORE: {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); }
  },
  WORLD_ENGINE_CORE: {
    getChatId() { return 'world-link-test'; },
    getChatLayer() { return 20; },
    filterDialogue(value) { return value; }
  },
  WORLD_ENGINE_CHATCACHE: { forScope() { return { afterEvolution() {} }; } },
  WORLD_ENGINE_UI: { setMemoryEvolvingUI() {} },
  MEMORY_ENGINE_SETTINGS: { getSettings() { return { ...memorySettings }; } },
  WORLD_ENGINE_API: {
    getSettings() { return { memoryLinkEnabled: true }; },
    async callApi(prompt) {
      apiCalls++;
      if (prompt.includes('"big_summary": ""')) {
        return JSON.stringify({ big_summary: `总述${version}` });
      }
      return JSON.stringify({
        personal_memory: [{ name: ['甲'], known_by: [], memory: `甲记住世界版本${version}。`, time: '' }],
        entity_updates: [{
          type: 'location', name: '城门', description: `城门状态${version}`, event: `城门发生变化${version}。`, time: ''
        }]
      });
    }
  }
};
sandbox.window = sandbox;

for (const file of [
  'memory-engine-data.js', 'memory-engine-prompt.js', 'memory-engine-small-summary-prompt.js', 'memory-engine.js'
]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

(async () => {
  let ordinaryState = sandbox.MEMORY_ENGINE_DATA.loadState();
  ordinaryState.timeline.nodes.push({
    id: 'memory_ordinary', kind: 'memory', originChatId: 'world-link-test',
    startLayer: 19, endLayer: 20, status: 'valid', revision: 1,
    sourceRefs: [{
      chatId: 'world-link-test', messageId: 'ordinary:19-20', layer: 20,
      role: 'synthetic', swipeId: 0, hash: 'ordinary', synthetic: true
    }],
    sourceDigest: 'ordinary',
    personal: [{ name: ['ordinary-person'], known_by: [], memory: 'ordinary-memory', time: '' }],
    entities: {}, createdAt: Date.now(), updatedAt: Date.now()
  });
  sandbox.MEMORY_ENGINE_DATA.saveState(sandbox.MEMORY_ENGINE.replayTimeline(ordinaryState));
  // 弱联动保护：ingestWorldEvolution 不得再向记忆 7 表写入记录，但旧存档遗留的 world_link / world_engine 记录仍支持精准回滚与撤回
  const ingestRes = await sandbox.MEMORY_ENGINE.ingestWorldEvolution({
    layer: 20, worldDigest: '世界摘要A', worldUpdate: { world_digest: '世界摘要A' }, replace: false
  });
  assert.strictEqual(ingestRes.skipped, true, '弱联动模式下不得再往记忆写入世界纪要或角色');
  assert.strictEqual(apiCalls, 0, '弱联动模式 0 API 消耗');
  let state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(state.tables.chronicle.length, 0);

  // 模拟旧存档中已有的同楼层 world_link + 普通纪要，验证 rollbackLinkedLayer 只撤旧世界同步不误伤普通纪要
  state.timeline.nodes.push({
    id: 'memory_world_legacy', kind: 'world_link', source: 'world_engine', sourceKey: 'world-link-test:20',
    originChatId: 'world-link-test', startLayer: 20, endLayer: 20, status: 'valid', revision: 1,
    sourceRefs: [{ chatId: 'world-link-test', messageId: 'world:world-link-test:20', layer: 20, role: 'system', synthetic: true }],
    targetSheets: ['quests_events'],
    tableOps: [{ sheet: 'quests_events', op: 'upsert', key: '旧世界事件A', data: { quest_name: '旧世界事件A', detail_desc: '版本A' } }]
  });
  state.tables.chronicle.push(
    { id: 'small_world_legacy', rowId: 1, code_index: 'AM0001', source: 'world_engine', sourceKey: 'world-link-test:20', startLayer: 20, endLayer: 20, summary: '世界摘要A', chronicle_text: '世界摘要A', status: 'valid', revision: 1 },
    { id: 'small_ordinary', rowId: 2, code_index: 'AM0002', startLayer: 19, endLayer: 20, summary: 'ordinary-summary-19-20', chronicle_text: 'ordinary-summary-19-20', status: 'valid', revision: 1 }
  );
  sandbox.MEMORY_ENGINE_DATA.saveState(sandbox.MEMORY_ENGINE.replayTimeline(state));

  assert.strictEqual(sandbox.MEMORY_ENGINE._test.rollbackLinkedLayer(20), true);
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('摘要A') && !serialized.includes('版本A'), '回滚旧世界联动后不得残留旧世界纪要与任务');
  assert.ok(serialized.includes('ordinary-summary-19-20') && serialized.includes('ordinary'), '回滚旧世界联动不得误伤普通记忆与纪要');
  assert.strictEqual(state.tables.chronicle.length, 1);

  // 撤回世界同步纪要不得误伤普通对话纪要。
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  state.tables.chronicle = ['A', 'B', 'C', 'D'].map((id, index) => ({
    id, rowId: index + 1, code_index: `AM000${index + 1}`, startLayer: index, endLayer: index,
    summary: '纪要' + id, chronicle_text: '纪要' + id, status: 'valid', revision: 1,
    ...(id === 'A' ? { worldCommitId: 'removed-commit', source: 'world_engine' } : {})
  }));
  state.tableWatermarks.chronicle = 3;
  sandbox.MEMORY_ENGINE_DATA.saveState(state);
  sandbox.MEMORY_ENGINE.invalidateWorldCommits(['removed-commit']);
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.deepStrictEqual(Array.from(state.event_memory.small_summaries.map(item => item.id)), ['B', 'C', 'D'], '撤回世界提交只移除对应世界纪要');

  vm.runInNewContext(fs.readFileSync(path.join(root, 'memory-engine-timeline.js'), 'utf8'), sandbox, { filename: 'memory-engine-timeline.js' });
  chat.push({ is_user: true, name: '甲', mes: '我看到了货单。' }, { is_user: false, name: '角色', mes: '甲记住这份货单。' });
  const refs = sandbox.MEMORY_ENGINE_TIMELINE.captureRange(1, 2);
  let committedActive = true, historyApplying = false;
  sandbox.STORY_ENGINE_PROJECTION = { active: () => true };
  sandbox.STORY_ENGINE_HISTORY = { isCommitActive: id => id === 'cancel-commit' && committedActive,
    isApplying: () => historyApplying, getStatus: () => ({ blocked: false }) };
  const cancellationState = () => {
    const current = sandbox.MEMORY_ENGINE_DATA.loadState();
    current.timeline.root.base = { tables: sandbox.MEMORY_ENGINE_DATA.emptyTables(), round: 0, chatLayer: null };
    current.timeline.nodes = [{
      id: 'cancel-node', kind: 'world_link', source: 'world_engine', sourceKey: 'world-link-test:2', worldCommitId: 'cancel-commit',
      startLayer: 2, endLayer: 2, sourceDigest: 'cancel-source',
      sourceRefs: [{ chatId: 'world-link-test', messageId: 'cancel-world-source', synthetic: true, hash: 'cancel' }],
      status: 'valid', targetSheets: ['important_characters'],
      tableOps: [{ sheet: 'important_characters', op: 'upsert', key: '甲', data: { name: '甲', brief_intro: '目击者', presence_status: '在场', past_experience: '甲记住CANCEL_WORLD事实。' } }]
    }];
    const small = { id: 'cancel-minute', rowId: 1, code_index: 'AM0001', source: 'world_engine', worldCommitId: 'cancel-commit', startLayer: 2, endLayer: 2, summary: 'CANCEL_WORLD纪要', chronicle_text: 'CANCEL_WORLD纪要', revision: 1, status: 'valid', sourceDigest: '' };
    const ordinary = { id: 'ordinary-minute', rowId: 2, code_index: 'AM0002', startLayer: 1, endLayer: 2, summary: '原始普通纪要', chronicle_text: '原始普通纪要', revision: 1, status: 'valid', sourceRefs: refs, sourceDigest: 'ordinary-digest' };
    current.tables.chronicle = [small, ordinary];
    delete current.world_commit_archive;
    return sandbox.MEMORY_ENGINE.replayTimeline(current);
  };
  state = cancellationState(); sandbox.MEMORY_ENGINE_DATA.saveState(state); sandbox.MEMORY_ENGINE_DATA.saveCheckpoint(state);
  const callsBeforeCancel = apiCalls;
  historyApplying = true; // history.write会先撤记忆，之后才发布新的preview bundle。
  sandbox.MEMORY_ENGINE.invalidateWorldCommits(['cancel-commit']);
  historyApplying = false; committedActive = false;
  memorySettings.injectIntoPrompt = true;
  assert(!sandbox.MEMORY_ENGINE.applyInjection({ isReroll: true }).includes('CANCEL_WORLD'), '联合preview不能从legacy checkpoint复注旧摘要');
  assert(sandbox.MEMORY_ENGINE_DATA.loadState().world_commit_archive, '撤下贡献仍保留在完整聊天存档中');
  committedActive = true; // cancel恢复原commit，真实来源未改变。
  await sandbox.MEMORY_ENGINE.prepareHistoryForGeneration();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert(JSON.stringify(state.tables.important_characters).includes('CANCEL_WORLD'));
  assert(state.event_memory.small_summaries.some(item => item.id === 'cancel-minute' && item.status === 'valid'));
  assert(sandbox.MEMORY_ENGINE.applyInjection({ isReroll: true }).includes('CANCEL_WORLD'));
  assert.strictEqual(apiCalls, callsBeforeCancel, '可信原commit恢复不需要重提取API');
  // 真删楼导致commit仍inactive，贡献必须持续不注入。
  committedActive = false; sandbox.MEMORY_ENGINE.invalidateWorldCommits(['cancel-commit']);
  await sandbox.MEMORY_ENGINE.prepareHistoryForGeneration();
  assert(!sandbox.MEMORY_ENGINE.applyInjection({ isReroll: true }).includes('CANCEL_WORLD'));
  // preview期间普通纪要被编辑后，原可信世界commit恢复仍不丢失可信世界记忆。
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  state.tables.chronicle.find(item => item.id === 'ordinary-minute').chronicle_text = '编辑后的普通纪要';
  sandbox.MEMORY_ENGINE_DATA.saveState(state);
  committedActive = true; await sandbox.MEMORY_ENGINE.prepareHistoryForGeneration();
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert(JSON.stringify(state.tables.important_characters).includes('CANCEL_WORLD'), '普通纪要编辑不丢失可信世界记忆');
  assert(state.event_memory.small_summaries.some(item => item.id === 'ordinary-minute' && item.content === '编辑后的普通纪要'), '恢复世界提交不得覆盖已编辑的普通纪要');
  const listeners = new Map();
  sandbox.SillyTavern.getContext = () => ({ chat, event_types: {}, eventSource: { on(name, handler) { listeners.set(name, handler); } } });
  sandbox.MEMORY_ENGINE.init(); listeners.get('message_swiped')();
  assert(sandbox.MEMORY_ENGINE_DATA.loadState().timeline.nodes.some(item => item.worldCommitId === 'cancel-commit'), '联合MESSAGE_SWIPED不执行legacy单层rollback');
  memorySettings.injectIntoPrompt = false;
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  state.timeline.root.base.tables = {
    ...sandbox.MEMORY_ENGINE_DATA.emptyTables(),
    important_characters: [{ rowId: 1, name: 'OLD_ROOT', brief_intro: '旧角色', presence_status: '在场', past_experience: 'OLD_ROOT_MEMORY' }]
  };
  state.timeline.nodes = [
    { id: 'manual', kind: 'manual_snapshot', status: 'valid', snapshot: { tables: { ...sandbox.MEMORY_ENGINE_DATA.emptyTables(), important_characters: [{ rowId: 1, name: 'MANUAL', brief_intro: '手动', presence_status: '在场', past_experience: 'MANUAL_CONTENT' }] } } },
    { id: 'sourced', kind: 'table_ops', status: 'valid', sourceRefs: refs, targetSheets: ['important_characters'], tableOps: [{ sheet: 'important_characters', op: 'upsert', key: '甲', data: { name: '甲', brief_intro: '目击者', presence_status: '在场', past_experience: '甲记得实际货单。' } }] },
    { id: 'missing', kind: 'table_ops', status: 'valid', sourceRefs: [{ chatId: 'world-link-test', messageId: 'deleted', layer: 99, role: 'assistant', hash: 'old' }], targetSheets: ['important_characters'], tableOps: [{ sheet: 'important_characters', op: 'upsert', key: '已删人物', data: { name: '已删人物', brief_intro: '角色', presence_status: '在场', past_experience: 'DELETED_MEMORY' } }] }
  ];
  state.tables.chronicle = [
    { id: 'unprovenanced', rowId: 1, code_index: 'AM0001', summary: 'OLD_ROOT_SUMMARY', chronicle_text: 'OLD_ROOT_SUMMARY', status: 'valid' },
    { id: 'provenanced', rowId: 2, code_index: 'AM0002', summary: '真实货单纪要', chronicle_text: '真实货单纪要', status: 'valid', sourceRefs: refs }
  ];
  sandbox.MEMORY_ENGINE_DATA.saveState(state);
  sandbox.MEMORY_ENGINE_DATA.saveCheckpoint(state);
  sandbox.MEMORY_ENGINE_DATA.saveLinkCheckpoint({ layer: 2, baseState: state });
  const callsBeforeQuarantine = apiCalls;
  const quarantined = sandbox.MEMORY_ENGINE.quarantineUnprovenancedHistory({ reason: '从头重建测试' });
  await quarantined.persistence;
  state = sandbox.MEMORY_ENGINE_DATA.loadState();
  assert.strictEqual(apiCalls, callsBeforeQuarantine, '本地隔离不能额外运行模型');
  assert(quarantined.needsAuthorReview && quarantined.backupKey);
  const backup = sandbox.MEMORY_ENGINE.getQuarantineBackup(quarantined.backupKey);
  assert(JSON.stringify(backup.state).includes('OLD_ROOT_MEMORY') && JSON.stringify(backup.state).includes('MANUAL_CONTENT'));
  assert(JSON.stringify(backup.checkpoint).includes('OLD_ROOT_MEMORY') && backup.linkCheckpoint, '完整保留checkpoint和人工快照以供作者确认');
  const active = JSON.stringify({ tables: state.tables, event_memory: state.event_memory });
  assert(!active.includes('OLD_ROOT') && !active.includes('MANUAL_CONTENT') && !active.includes('DELETED_MEMORY'), '无来源Root和人工快照不能自动重新注入');
  assert(active.includes('甲记得实际货单') && active.includes('真实货单纪要'));
  assert.strictEqual(state.timeline.nodes.find(item => item.id === 'missing').status, 'stale');
  assert(!JSON.stringify(sandbox.MEMORY_ENGINE_DATA.loadCheckpoint()).includes('OLD_ROOT'), 'reroll用的checkpoint必须同步更新为安全态');
  assert.strictEqual(sandbox.MEMORY_ENGINE_DATA.loadLinkCheckpoint(), null);
  assert.strictEqual(state.event_memory.small_summary_layer, chat.length - 1, '隔离不隐式申请历史全量重填');
  memorySettings.injectIntoPrompt = true;
  sandbox.STORY_ENGINE_PROJECTION = { active: () => true };
  sandbox.STORY_ENGINE_HISTORY = { getStatus: () => ({ blocked: true, recovery: { status: 'blocked' } }) };
  chat[1].extra = { ...(chat[1].extra || {}), world_engine_memory_hidden: true }; chat[1].is_system = true;
  assert.strictEqual(sandbox.MEMORY_ENGINE.applyInjection(), '', '不明联合基底必须撤下记忆注入');
  assert.strictEqual(chat[1].is_system, false, '撤下注入必须恢复其覆盖的原文');
  sandbox.STORY_ENGINE_HISTORY.getStatus = () => ({ blocked: false, recovery: { status: 'pending' } });
  assert(sandbox.MEMORY_ENGINE.applyInjection().includes('甲记得实际货单'), '可信普通pending不清空记忆');

  console.log('memory world link tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
