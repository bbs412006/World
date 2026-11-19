// 独立模式（剧情大纲关闭）世界引擎删楼自动回退回归测试
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function createHarness() {
  const storeMap = new Map();
  let syncSink = null;
  let apiResponder = null;
  const listeners = new Map();

  const chat = [{ is_user: false, name: 'AI', mes: '开场白：雾港初醒。' }];
  const ctx = {
    chatId: 'chat-standalone-1',
    name1: '主角',
    name2: 'AI',
    chat,
    chatMetadata: {},
    event_types: {
      CHAT_LOADED: 'chat_loaded',
      MESSAGE_DELETED: 'message_deleted',
      MESSAGE_EDITED: 'message_edited',
      GENERATION_STARTED: 'generation_started',
      GENERATION_ENDED: 'generation_ended',
      MESSAGE_SWIPED: 'message_swiped',
      GENERATION_STOPPED: 'generation_stopped'
    },
    eventSource: {
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      },
      emit(name, ...args) {
        for (const fn of (listeners.get(name) || [])) fn(...args);
      }
    },
    updateChatMetadata(patch) { Object.assign(this.chatMetadata, patch); },
    saveMetadataDebounced() {},
    saveChatConditional() { return Promise.resolve(); }
  };

  let settings = {
    engineEnabled: true,
    syncToChat: true,
    autoBackup: false,
    evolveMode: 'auto',
    evolveEveryX: 1,
    evolveReadRounds: 1,
    firstLayerIsAiOpening: true,
    backfillBatchSize: 2,
    regionalIncidentChance: 0,
    distantEventChance: 0,
    nearEventChance: 0,
    apiRetryCount: 0
  };

  let linkedActive = false;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math,
    Date,
    setTimeout,
    clearTimeout,
    AbortController,
    SillyTavern: { getContext: () => ctx },
    WORLD_ENGINE_STORE: {
      getItem: key => (storeMap.has(key) ? storeMap.get(key) : null),
      setItem(key, val) {
        storeMap.set(key, String(val));
        syncSink?.onWrite?.(key, String(val));
      },
      removeItem(key) {
        storeMap.delete(key);
        syncSink?.onRemove?.(key);
      },
      setSyncSink(sink) { syncSink = sink; },
      keys: () => Array.from(storeMap.keys()),
      isTransactionActive: () => false
    },
    WORLD_ENGINE_API: {
      getSettings: () => settings,
      parseJSON: raw => JSON.parse(raw),
      async callApi(_prompt, _maxTokens, _temp, signal) {
        if (!apiResponder) throw new Error('apiResponder not set');
        return apiResponder(signal);
      }
    },
    WORLD_ENGINE_WORLDBOOK: {
      async buildPromptSection() { return ''; }
    },
    WORLD_ENGINE_RULES: {
      loadRules: () => '',
      getAllRulesText: () => ''
    },
    WORLD_ENGINE_PRESET: {
      getActivePreset: () => ({ segments: {} })
    },
    STORY_ENGINE_PROJECTION: {
      active: () => linkedActive
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  for (const file of [
    'memory-engine-timeline.js',
    'world-engine-core.js',
    'world-engine-ledger.js',
    'world-engine-evolution.js',
    'world-engine-chatcache.js'
  ]) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }

  return {
    sandbox,
    ctx,
    storeMap,
    setApiResponder(fn) { apiResponder = fn; },
    setLinked(flag) { linkedActive = !!flag; },
    setSettings(patch) { settings = { ...settings, ...patch }; },
    pushTurn(userText, aiText) {
      ctx.chat.push({ is_user: true, name: '主角', mes: userText });
      ctx.chat.push({ is_user: false, name: 'AI', mes: aiText });
      return ctx.chat.length - 1;
    },
    async evolveCurrent(updateObj, opts = {}) {
      apiResponder = async () => JSON.stringify(updateObj);
      const core = sandbox.WORLD_ENGINE_CORE;
      const evolution = sandbox.WORLD_ENGINE_EVOLUTION;
      const ledger = sandbox.WORLD_ENGINE_LEDGER;
      const timeline = sandbox.MEMORY_ENGINE_TIMELINE;
      const state = core.loadState();
      const endLayer = ctx.chat.length - 1;
      const startLayer = Math.max(1, endLayer - 1);
      const ok = await evolution.evolve(state, '', String(ctx.chat[endLayer]?.mes || ''), {
        dialogueText: `用户：${ctx.chat[startLayer]?.mes || ''}\nAI：${ctx.chat[endLayer]?.mes || ''}`,
        sourceRefs: timeline.captureRange(startLayer, endLayer),
        ...opts
      });
      assert.strictEqual(ok, true, 'evolveCurrent should succeed: ' + evolution.getLastError());
      ledger.recordChanges(state);
      core.updateCurrentHistorySnapshot(state);
      return clone(core.loadState());
    }
  };
}

function makeRoundUpdate(n, tag = '') {
  return {
    world_digest: `第${n}轮世界摘要${tag}`,
    events: [
      { id: null, name: `事件_${n}${tag}`, type: 'conflict', level: 3, stage: '萌芽', stageRound: 2, desc: `第${n}轮冲突${tag}` }
    ],
    factions: [
      { id: null, name: `势力_${n}${tag}`, scope: `区域${n}`, status: '稳固', relation: '中立', currentGoal: `目标${n}${tag}`, core_person: `人物${n}` }
    ],
    winds: [],
    worldTrends: [],
    economy: { climate: n >= 4 ? '紧张' : '平稳', signals: [`信号_${n}${tag}`] },
    reputation: { authority: `名声_${n}${tag}` },
    enemies: [],
    influenceChain: []
  };
}

async function run() {
  // ───────── 1. 多楼推进 + 多楼尾部删除自动回退 ─────────
  {
    const h = createHarness();
    const core = h.sandbox.WORLD_ENGINE_CORE;
    const snapshotsByRound = {};

    for (let r = 1; r <= 5; r++) {
      h.pushTurn(`第${r}轮玩家行动`, `第${r}轮AI回应`);
      snapshotsByRound[r] = await h.evolveCurrent(makeRoundUpdate(r));
      assert.strictEqual(snapshotsByRound[r].round, r);
      assert.strictEqual(snapshotsByRound[r].chatLayer, r * 2);
    }

    const histBefore = clone(core.loadHistory());
    assert.deepStrictEqual(histBefore.entries.map(e => e.layer), [2, 4, 6, 8, 10]);
    assert.strictEqual(histBefore.baseline.isEmpty, true);

    // 删掉第 4、5 轮（楼层 7..10），回到第 3 轮（楼层 6）
    h.ctx.chat.splice(7);
    assert.strictEqual(h.ctx.chat.length, 7);

    const rb = core.rollbackToLayer();
    assert.strictEqual(rb.rolledBack, true);
    assert.strictEqual(rb.layer, 6);
    assert.strictEqual(rb.round, 3);
    assert.strictEqual(rb.prunedCount, 2);

    const stateAfter = clone(core.loadState());
    const cpAfter = clone(core.restoreCheckpoint());
    assert.strictEqual(stateAfter.round, 3);
    assert.strictEqual(stateAfter.chatLayer, 6);
    assert.strictEqual(stateAfter.worldDigest, '第3轮世界摘要');
    assert.deepStrictEqual(stateAfter.events.map(e => e.name).sort(), ['事件_1', '事件_2', '事件_3']);
    assert.deepStrictEqual(stateAfter.factions.map(f => f.name).sort(), ['势力_1', '势力_2', '势力_3']);
    assert.strictEqual(stateAfter.memories.length, snapshotsByRound[3].memories.length);
    assert.strictEqual(stateAfter.memories.length, 2, 'rounds 2 and 3 ledger entries preserved, rounds 4 and 5 rolled back');
    assert.deepStrictEqual(stateAfter.memories.map(m => m.round), [3, 2]);
    assert.strictEqual(cpAfter.round, 2);
    assert.strictEqual(cpAfter.chatLayer, 4);
    assert.strictEqual(cpAfter.worldDigest, '第2轮世界摘要');
    assert.strictEqual(core.loadFingerprint(), '6');
    assert.deepStrictEqual(clone(core.loadHistory()).entries.map(e => e.layer), [2, 4, 6]);
    console.log('✓ 1. 多楼推进与跨多楼删除回退（state/checkpoint/fingerprint/账本全部一致）');

    // ───────── 2. 回退后继续新分支推进 ─────────
    h.pushTurn('第4轮新分支玩家行动', '第4轮新分支AI回应');
    assert.strictEqual(core.isNewRound(), true);
    const branchState = await h.evolveCurrent(makeRoundUpdate(4, '_新分支'));
    assert.strictEqual(branchState.round, 4);
    assert.strictEqual(branchState.chatLayer, 8);
    assert.strictEqual(branchState.worldDigest, '第4轮世界摘要_新分支');
    assert.ok(!branchState.events.some(e => e.name === '事件_4' || e.name === '事件_5'));
    assert.ok(branchState.events.some(e => e.name === '事件_4_新分支'));
    assert.strictEqual(core.restoreCheckpoint().round, 3);
    assert.strictEqual(core.restoreCheckpoint().chatLayer, 6);
    assert.deepStrictEqual(clone(core.loadHistory()).entries.map(e => e.layer), [2, 4, 6, 8]);
    console.log('✓ 2. 回退后继续新分支推进，无旧分支残留');

    // ───────── 3. 同层 redo 与自动重 roll 不污染上一层快照 ─────────
    const layer6BeforeRedo = clone(core.loadHistory().entries.find(e => e.layer === 6));
    const redoState = await h.evolveCurrent(makeRoundUpdate(4, '_redo'), { mode: 'redo' });
    assert.strictEqual(redoState.round, 3, 'standalone redo keeps checkpoint round');
    assert.strictEqual(redoState.worldDigest, '第4轮世界摘要_redo');
    assert.deepStrictEqual(clone(core.loadHistory()).entries.map(e => e.layer), [2, 4, 6, 8]);
    assert.deepStrictEqual(clone(core.loadHistory().entries.find(e => e.layer === 6)), layer6BeforeRedo);
    assert.strictEqual(core.restoreCheckpoint().chatLayer, 6);

    // 自动重 roll（同层 fingerprint === '8' -> isNewRound() === false）
    assert.strictEqual(core.isNewRound(), false);
    const rerollState = await h.evolveCurrent(makeRoundUpdate(4, '_autoroll'));
    assert.strictEqual(rerollState.round, 3, 'autoroll keeps current round');
    assert.strictEqual(rerollState.worldDigest, '第4轮世界摘要_autoroll');
    assert.deepStrictEqual(clone(core.loadHistory()).entries.map(e => e.layer), [2, 4, 6, 8]);
    assert.deepStrictEqual(clone(core.loadHistory().entries.find(e => e.layer === 6)), layer6BeforeRedo);
    console.log('✓ 3. 同层 redo 与自动重 roll 原地替换当前层快照，不破坏上一层');

    // ───────── 4. 只删最后一条 AI 回复（留下用户楼层）─────────
    h.pushTurn('第5轮玩家行动', '第5轮AI回应');
    await h.evolveCurrent(makeRoundUpdate(5, '_tmp'));
    assert.strictEqual(core.loadState().chatLayer, 10);
    h.ctx.chat.pop(); // 剩下 0..9（9 是用户消息）
    const rbOrphan = core.rollbackToLayer();
    assert.strictEqual(rbOrphan.rolledBack, true);
    assert.strictEqual(rbOrphan.layer, 8);
    assert.strictEqual(core.loadState().chatLayer, 8);
    assert.strictEqual(core.loadState().worldDigest, '第4轮世界摘要_autoroll');
    assert.strictEqual(core.loadFingerprint(), '8');
    console.log('✓ 4. 只删末尾 AI 回复（保留用户楼层）自动回退至上一推演层');

    // ───────── 5. 删除中间楼层（楼层左移）自动截断受损前缀 ─────────
    // 删掉楼层 4（第 2 轮 AI 回复），楼层 5..9 左移
    h.ctx.chat.splice(4, 1);
    const rbMid = core.rollbackToLayer();
    assert.strictEqual(rbMid.rolledBack, true);
    assert.strictEqual(rbMid.layer, 2);
    assert.strictEqual(rbMid.round, 1);
    assert.strictEqual(core.loadState().worldDigest, '第1轮世界摘要');
    assert.strictEqual(core.restoreCheckpoint(), null);
    assert.strictEqual(core.loadFingerprint(), '2');
    console.log('✓ 5. 中间楼层删除导致来源缺失与移位时自动截断回退至最早完好层');

    // ───────── 6. 删回首次推演之前（只剩开场白 0 层）→ 回到初始空白且不死锁 ─────────
    h.ctx.chat.splice(1);
    assert.strictEqual(h.ctx.chat.length, 1);
    const rbInit = core.rollbackToLayer();
    assert.strictEqual(rbInit.rolledBack, true);
    assert.strictEqual(rbInit.cleared, true);
    assert.strictEqual(rbInit.layer, -1);
    assert.strictEqual(core.hasState(), false);
    assert.strictEqual(core.restoreCheckpoint(), null);
    assert.strictEqual(core.loadFingerprint(), '');
    assert.strictEqual(core.isNewRound(), true);

    // 重新发一轮验证不会死锁
    h.pushTurn('重启第1轮玩家', '重启第1轮AI');
    const restarted = await h.evolveCurrent(makeRoundUpdate(1, '_重启'));
    assert.strictEqual(restarted.round, 1);
    assert.strictEqual(restarted.chatLayer, 2);
    assert.strictEqual(restarted.worldDigest, '第1轮世界摘要_重启');
    console.log('✓ 6. 删回首次推演之前清空到初始世界，且下一轮正常推演不死锁');

    // ───────── 7. 清空整个聊天（chat.length === 0）─────────
    h.ctx.chat.length = 0;
    const rbEmpty = core.rollbackToLayer();
    assert.strictEqual(rbEmpty.rolledBack, true);
    assert.strictEqual(rbEmpty.cleared, true);
    assert.strictEqual(core.hasState(), false);
    assert.strictEqual(core.loadFingerprint(), '0');
    console.log('✓ 7. 清空全部消息时彻底重置世界状态、存档点与历史栈');
  }

  // ───────── 8. 旧存档兼容兜底 + 升级后基线保护 ─────────
  {
    const h = createHarness();
    const core = h.sandbox.WORLD_ENGINE_CORE;
    for (let r = 1; r <= 6; r++) h.pushTurn(`U${r}`, `A${r}`);

    // 构造无 history 键的旧存档（state 在 10 层第 5 轮，checkpoint 在 8 层第 4 轮）
    const cpLegacy = { ...core.getDefaultState(), round: 4, chatLayer: 8, worldDigest: '旧第4轮' };
    const stLegacy = { ...core.getDefaultState(), round: 5, chatLayer: 10, worldDigest: '旧第5轮' };
    core.saveCheckpoint(cpLegacy);
    core.saveState(stLegacy);
    core.saveFingerprint('10');

    // Part A: 尚未新增任何 history 就删楼到 8 层 → 走 checkpoint 兜底
    h.ctx.chat.splice(9); // 0..8
    const rbLegacy = core.rollbackToLayer();
    assert.strictEqual(rbLegacy.rolledBack, true);
    assert.strictEqual(rbLegacy.fromCheckpoint, true);
    assert.strictEqual(rbLegacy.layer, 8);
    assert.strictEqual(core.loadState().round, 4);
    assert.strictEqual(core.loadState().worldDigest, '旧第4轮');

    // Part B: 在此旧状态上继续推进 2 轮（10 层、12 层），应自动以 8 层为非空 baseline
    h.pushTurn('U5新', 'A5新');
    await h.evolveCurrent(makeRoundUpdate(5, '_升级后'));
    h.pushTurn('U6新', 'A6新');
    await h.evolveCurrent(makeRoundUpdate(6, '_升级后'));
    assert.strictEqual(core.loadState().round, 6);
    assert.strictEqual(core.loadHistory().baseline.isEmpty, false);
    assert.strictEqual(core.loadHistory().baseline.layer, 8);

    // 删回 8 层 → 精准回到升级前旧第4轮基线
    h.ctx.chat.splice(9);
    const rbBase = core.rollbackToLayer();
    assert.strictEqual(rbBase.rolledBack, true);
    assert.strictEqual(rbBase.resetToBaseline, true);
    assert.strictEqual(rbBase.layer, 8);
    assert.strictEqual(core.loadState().round, 4);
    assert.strictEqual(core.loadState().worldDigest, '旧第4轮');

    // 再往前推进 1 轮后直接删过基线（到 6 层）→ 回到初始空白并标记 beyondBaseline
    h.pushTurn('U5再', 'A5再');
    await h.evolveCurrent(makeRoundUpdate(5, '_再'));
    h.ctx.chat.splice(7); // 0..6 < baseline(8)
    const rbBeyond = core.rollbackToLayer();
    assert.strictEqual(rbBeyond.rolledBack, true);
    assert.strictEqual(rbBeyond.cleared, true);
    assert.strictEqual(rbBeyond.beyondBaseline, true);
    assert.strictEqual(rbBeyond.baselineLayer, 8);
    assert.strictEqual(core.hasState(), false);
    console.log('✓ 8. 旧存档 checkpoint 兜底 + 升级后基线回退与越界提示均正常');
  }

  // ───────── 9. backfillEvolve 批量回填按真实楼层记录历史，删尾楼可精确回退 ─────────
  {
    const h = createHarness();
    const core = h.sandbox.WORLD_ENGINE_CORE;
    const evolution = h.sandbox.WORLD_ENGINE_EVOLUTION;
    for (let r = 1; r <= 4; r++) h.pushTurn(`回填玩家${r}`, `回填AI${r}`);

    let batchSeq = 0;
    h.setApiResponder(async () => {
      batchSeq++;
      return JSON.stringify(makeRoundUpdate(batchSeq, '_回填'));
    });

    const res = await evolution.backfillEvolve({ batchSize: 2, ignoreFirstLayer: true, retries: 0 });
    assert.strictEqual(res.done, true);
    assert.strictEqual(res.totalBatches, 2);
    const hist = clone(core.loadHistory());
    assert.deepStrictEqual(hist.entries.map(e => e.layer), [4, 8]);
    assert.strictEqual(core.loadState().chatLayer, 8);
    assert.strictEqual(core.loadState().round, 2);
    assert.ok(hist.entries[1].state.memories.length >= 1, 'batch 2 ledger included in history snapshot');

    // 删掉后 2 轮（楼层 5..8），回到第 1 批（楼层 4）
    h.ctx.chat.splice(5);
    const rb = core.rollbackToLayer();
    assert.strictEqual(rb.rolledBack, true);
    assert.strictEqual(rb.layer, 4);
    assert.strictEqual(rb.round, 1);
    assert.strictEqual(core.loadState().worldDigest, '第1轮世界摘要_回填');
    assert.strictEqual(core.loadState().memories.length, 0, 'batch 2 ledger rolled back cleanly');
    assert.strictEqual(core.restoreCheckpoint(), null);
    console.log('✓ 9. backfillEvolve 按真实楼层落盘历史栈，删楼可精准回退到对应批次');
  }

  // ───────── 10. 推演进行中被删楼中止，旧 backup 绝不覆盖已回退的新状态 ─────────
  {
    const h = createHarness();
    const core = h.sandbox.WORLD_ENGINE_CORE;
    const evolution = h.sandbox.WORLD_ENGINE_EVOLUTION;

    h.pushTurn('P1', 'A1');
    await h.evolveCurrent(makeRoundUpdate(1));
    h.pushTurn('P2', 'A2');
    await h.evolveCurrent(makeRoundUpdate(2));
    h.pushTurn('P3', 'A3');

    let rejectFlight = null;
    h.setApiResponder(signal => new Promise((_resolve, reject) => {
      rejectFlight = reject;
      signal?.addEventListener('abort', () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));

    const inflight = evolution.evolve(core.loadState(), '', 'A3', {
      dialogueText: '用户：P3\nAI：A3',
      sourceRefs: h.sandbox.MEMORY_ENGINE_TIMELINE.captureRange(5, 6)
    });

    // 等微任务进入 callApi 后模拟用户连删楼层 3..6（回到第 1 轮 2 层）
    await new Promise(r => setTimeout(r, 10));
    h.ctx.chat.splice(3);
    evolution.abort();
    const rb = core.rollbackToLayer();
    assert.strictEqual(rb.rolledBack, true);
    assert.strictEqual(rb.layer, 2);
    assert.strictEqual(rb.round, 1);

    const ok = await inflight;
    assert.strictEqual(ok, false);
    assert.strictEqual(core.loadState().round, 1, 'aborted evolve must not overwrite rolled-back state with stale round-2 backup');
    assert.strictEqual(core.loadState().chatLayer, 2);
    assert.strictEqual(core.loadState().worldDigest, '第1轮世界摘要');
    void rejectFlight;
    console.log('✓ 10. 推演进行中删楼中止时，旧 backup 不会覆盖已回退状态');
  }

  // ───────── 11. ChatCache live 同步含 history，快照不含 history，恢复快照清旧 history ─────────
  {
    const h = createHarness();
    const core = h.sandbox.WORLD_ENGINE_CORE;
    const cache = h.sandbox.WORLD_ENGINE_CHATCACHE;
    await cache.init();

    h.pushTurn('P1', 'A1');
    await h.evolveCurrent(makeRoundUpdate(1));
    h.pushTurn('P2', 'A2');
    await h.evolveCurrent(makeRoundUpdate(2));

    assert.strictEqual(cache.pushLiveNow(), true);
    const liveData = h.ctx.chatMetadata.world_engine?.live?.data;
    assert.ok(liveData && liveData.history, 'live sync should include history slot');

    const snap = cache.createSnapshot('手动存档');
    assert.ok(snap && snap.data, 'snapshot created');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(snap.data, 'history'), false, 'snapshot should omit history to avoid chat_metadata bloat');

    assert.strictEqual(cache.restoreSnapshot(snap.id), true);
    assert.strictEqual(core.loadHistory().entries.length, 0, 'restoreSnapshot normalizes layer and clears stale history');
    console.log('✓ 11. ChatCache live 携带 history、快照排除 history、恢复快照清理旧 history');
  }

  // ───────── 12. 联合模式（剧情大纲开启）完全交由 STORY_ENGINE_HISTORY，不干扰 ─────────
  {
    const h = createHarness();
    const core = h.sandbox.WORLD_ENGINE_CORE;
    h.setLinked(true);
    h.pushTurn('P1', 'A1');
    const st = core.loadState();
    st.round = 1;
    st.chatLayer = 2;
    assert.strictEqual(core.recordHistorySnapshot(st, { layer: 2 }), null);
    const rb = core.rollbackToLayer();
    assert.strictEqual(rb.rolledBack, false);
    assert.strictEqual(rb.reason, 'linked-active');
    console.log('✓ 12. 剧情大纲开启时独立历史与回退静默让位，零干扰');
  }

  console.log('\n🎉 独立模式世界引擎删楼自动回退测试 12/12 全部通过！');
}

run().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
