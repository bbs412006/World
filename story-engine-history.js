// 联合事实日志。保存实际结果并本地重放；不调用模型、不重新掷骰、不回退作者计划和人工覆盖。
window.STORY_ENGINE_HISTORY = (function() {
  'use strict';
  const PREFIX = 'outline_engine_v2_bundle_';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const clean = value => String(value == null ? '' : value).trim();
  const data = () => window.OUTLINE_ENGINE_DATA;
  const store = () => window.WORLD_ENGINE_STORE;
  const timeline = () => window.MEMORY_ENGINE_TIMELINE;
  let applying = false, sequence = 0, session = 0, generation = null;
  const persistenceFailures = new Map();
  const pending = new Map();
  function context() { try { return SillyTavern.getContext(); } catch (_) { return null; } }
  function id() { return clean(context()?.chatId || window.WORLD_ENGINE_CORE?.getChatId?.() || 'default'); }
  function enabled() { return window.OUTLINE_ENGINE_SETTINGS?.getSettings?.().engineEnabled === true; }
  function uid(prefix) { return `${prefix}_${Date.now().toString(36)}_${(++sequence).toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  function hash(value) { return timeline().hashText(JSON.stringify(stable(value))); }
  function publicWorld(value) {
    const result = window.STORY_ENGINE_PROJECTION?.publicWorld?.(value) || clone(value || {});
    result.blackbox = { secretActions: [], secretAssets: [] };
    delete result.lastUpdated; delete result.lastInjection;
    return result;
  }
  function worldHash(value) {
    const result = publicWorld(value);
    for (const key of ['lastEvolveResult', 'memories', '_terminalEventsThisRound', 'storyCommitId']) delete result[key];
    return hash(result);
  }
  function canonicalWorld(value) {
    const projected = publicWorld(value);
    const result = window.WORLD_ENGINE_CORE.getCleanExport ? window.WORLD_ENGINE_CORE.getCleanExport(projected) : projected;
    if (projected.lastEvolveResult) result.lastEvolveResult = clone(projected.lastEvolveResult);
    return publicWorld(result);
  }
  function captureAutomatic(state) {
    if (data().captureAutomaticState) return data().captureAutomaticState(state);
    const result = {};
    for (const key of ['currentChapterId', 'progressEvents', 'proposals', 'tracking', 'scheduler', 'privateFacts', 'clues', 'contacts', 'knowledge', 'recovery']) result[key] = clone(state[key]);
    return result;
  }
  function restoreAutomatic(state, automatic) {
    if (data().restoreAutomaticState) return data().restoreAutomaticState(state, automatic);
    return { ...state, ...clone(automatic) };
  }
  function refs() { return context()?.chat?.length ? timeline().captureRange(0, context().chat.length - 1) : []; }
  function refKey(ref) { return [clean(ref.chatId), clean(ref.messageId), Number(ref.swipeId) || 0, clean(ref.hash)].join(':'); }
  function prefixHashes(source) {
    const result = [hash([])];
    for (const ref of source) result.push(hash([result[result.length - 1], refKey(ref)]));
    return result;
  }
  function load() {
    const raw = store().getItem(PREFIX + id()); if (raw == null) return null;
    let value;
    try { value = JSON.parse(raw); } catch (_) { throw new Error('联合历史损坏，已保留原始存储，请恢复备份'); }
    if (Number(value?.schemaVersion) > 2) throw new Error('联合历史来自更新版本，当前版本不能覆盖该存储');
    if (value?.schemaVersion !== 2 || value.chatId !== id()) throw new Error('联合历史版本或聊天身份不匹配，已保留原始存储');
    return value;
  }
  function transaction(callback) {
    const owns = typeof store().beginTransaction === 'function' && !store().isTransactionActive?.();
    const token = owns ? store().beginTransaction() : null;
    try { const result = callback(); if (owns) store().commitTransaction(token); return result; }
    catch (error) { if (owns) store().rollbackTransaction(token); throw error; }
  }
  function delta(before, after, path = []) {
    if (JSON.stringify(stable(before)) === JSON.stringify(stable(after))) return [];
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!object(before) || !object(after)) return [{ path, value: clone(after) }];
    const patches = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.prototype.hasOwnProperty.call(after, key)) patches.push({ path: [...path, key], remove: true });
      else patches.push(...delta(before[key], after[key], [...path, key]));
    }
    return patches;
  }
  function applyDelta(frame, patches) {
    let result = clone(frame);
    for (const patch of patches || []) {
      if (!patch.path.length) { result = clone(patch.value); continue; }
      let target = result;
      for (const key of patch.path.slice(0, -1)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('联合日志含非法路径');
        if (!target[key] || typeof target[key] !== 'object') target[key] = {};
        target = target[key];
      }
      const key = patch.path[patch.path.length - 1];
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('联合日志含非法路径');
      if (patch.remove) delete target[key]; else target[key] = clone(patch.value);
    }
    return result;
  }
  function pathTo(bundle, target) {
    const lookup = new Map(bundle.journal.map(commit => [commit.id, commit]));
    const chain = [], seen = new Set();
    while (target !== bundle.baseline.id) {
      if (seen.has(target) || !lookup.has(target)) throw new Error('联合日志缺段或父提交循环');
      seen.add(target); const commit = lookup.get(target); chain.unshift(commit); target = commit.parentId;
    }
    return chain;
  }
  function materialize(bundle, target) {
    if (hash(bundle.baseline.frame) !== bundle.baseline.hash) throw new Error('初始联合基底校验失败');
    const chain = pathTo(bundle, target), positions = new Map([[bundle.baseline.id, -1], ...chain.map((commit, index) => [commit.id, index])]);
    let frame = clone(bundle.baseline.frame), start = 0;
    const checkpoints = (bundle.snapshots || []).filter(snapshot => positions.has(snapshot.atCommitId)).sort((a, b) => positions.get(b.atCommitId) - positions.get(a.atCommitId));
    for (const checkpoint of checkpoints) {
      const position = positions.get(checkpoint.atCommitId), expected = position < 0 ? bundle.baseline.hash : chain[position].afterHash;
      if (hash(checkpoint.frame) !== checkpoint.hash || checkpoint.hash !== expected) continue;
      frame = clone(checkpoint.frame); start = positions.get(checkpoint.atCommitId) + 1; break;
    }
    for (let i = start; i < chain.length; i++) {
      const commit = chain[i];
      if (hash(frame) !== commit.beforeHash) throw new Error('联合日志基底校验失败');
      frame = applyDelta(frame, commit.delta);
      if (hash(frame) !== commit.afterHash) throw new Error('联合日志结果校验失败');
    }
    return frame;
  }
  function metadata(bundle) {
    const frame = materialize(bundle, bundle.preview?.baseHeadId || bundle.headId);
    const head = bundle.journal.find(commit => commit.id === (bundle.preview?.baseHeadId || bundle.headId));
    const recovery = bundle.recovery || {};
    return { phase: bundle.preview ? 'preview' : recovery.status || 'ready', blocked: ['blocked', 'pending-rebuild'].includes(recovery.status),
      paused: ['blocked', 'pending-rebuild'].includes(recovery.status), reason: clean(recovery.reason), recovery: clone(recovery),
      baselineLayer: bundle.baseline.prefixLength - 1, recoverableFromLayer: bundle.baseline.prefixLength - 1,
      lastValidLayer: head ? head.prefixLength - 1 : bundle.baseline.prefixLength - 1,
      pendingFromLayer: recovery.pendingFromLayer ?? null, currentCommitId: bundle.preview?.baseHeadId || bundle.headId,
      branchId: bundle.preview?.branchId || bundle.branchId, journalCount: bundle.journal.length,
      snapshotCount: bundle.snapshots.length, revision: bundle.revision, worldHash: worldHash(frame.world) };
  }
  function write(bundle, frame, applyWorld = true) {
    return transaction(() => {
      applying = true;
      try {
        bundle.revision = Math.max(0, Number(bundle.revision) || 0) + 1;
        if (frame) {
          const previous = load();
          if (previous) {
            let oldIds = [], newIds = [];
            try { oldIds = pathTo(previous, previous.preview?.baseHeadId || previous.headId).filter(item => item.kind === 'world').map(item => item.id); } catch (_) {}
            try { newIds = pathTo(bundle, bundle.preview?.baseHeadId || bundle.headId).filter(item => item.kind === 'world').map(item => item.id); } catch (_) {}
            const invalidated = oldIds.filter(commitId => !newIds.includes(commitId));
            if (invalidated.length) window.MEMORY_ENGINE?.invalidateWorldCommits?.(invalidated);
          }
          const state = restoreAutomatic(data().loadState(), frame.outline);
          state.recovery = clone(bundle.recovery || { status: 'ready' });
          data().saveState(state);
          if (applyWorld) window.WORLD_ENGINE_CORE.saveState(clone(frame.world));
        }
        store().setItem(PREFIX + id(), JSON.stringify(bundle));
      } finally { applying = false; }
      return bundle;
    });
  }
  function legacyFacts(world, rootId) {
    const entries = window.STORY_ENGINE_PROJECTION?.privateEventsFromBlackbox?.(world) || [
      ...(world?.blackbox?.secretActions || []).map(item => ({ text: item.action })),
      ...(world?.blackbox?.secretAssets || []).map(item => ({ text: `秘密资源：${item.name}` }))
    ];
    return entries.filter(item => clean(item.text)).map((entry, index) => ({ id: `${rootId}_legacy_${index}`, commitId: rootId,
      factHash: hash(entry.text), text: clean(entry.text), visibility: 'private', knownBy: [], entityRefs: clone(entry.entityRefs || []), validity: 'valid', legacy: true }));
  }
  function ensureBaseline(beforeWorld, options = {}) {
    let bundle = load(); if (bundle) return bundle;
    if (!enabled()) return null;
    const world = clone(beforeWorld || window.WORLD_ENGINE_CORE.loadState()), state = data().loadState(), source = options.sourceRefs || refs();
    const rootId = uid('root');
    state.privateFacts = [...(state.privateFacts || []), ...legacyFacts(world, rootId)];
    const normalized = canonicalWorld(world); normalized.storyCommitId = rootId;
    const frame = { world: normalized, outline: captureAutomatic(state) };
    bundle = { schemaVersion: 2, chatId: id(), epoch: uid('epoch'), revision: 0, branchId: uid('branch'), headId: rootId,
      baseline: { id: rootId, prefixLength: source.length, prefixHash: prefixHashes(source)[source.length], sourceRefs: source, frame, hash: hash(frame) },
      snapshots: [{ atCommitId: rootId, frame: clone(frame), hash: hash(frame) }], journal: [], recovery: { status: 'ready', reason: '' }, preview: null };
    write(bundle, frame); return bundle;
  }
  function getStatus() {
    const persistenceFailure = persistenceFailures.get(id());
    if (persistenceFailure) return { phase: 'blocked', blocked: true, paused: true, reason: persistenceFailure, recovery: { status: 'blocked', reason: persistenceFailure } };
    let bundle;
    try { bundle = load(); } catch (error) { return { phase: 'blocked', blocked: true, paused: true, reason: error.message, recovery: { status: 'blocked', reason: error.message } }; }
    if (!bundle) return { phase: enabled() ? 'uninitialized' : 'disabled', blocked: false, paused: false, reason: '', recovery: { status: 'ready' },
      baselineLayer: null, recoverableFromLayer: null, lastValidLayer: null, pendingFromLayer: null, currentCommitId: '', branchId: '', journalCount: 0, snapshotCount: 0, revision: 0 };
    try { return metadata(bundle); }
    catch (error) { return { phase: 'blocked', blocked: true, paused: true, reason: error.message, recovery: { status: 'blocked', reason: error.message }, journalCount: bundle.journal?.length || 0, revision: bundle.revision }; }
  }
  function retainIndependent(bundle, frame, length, prefixHash) {
    const current = data().loadState(), restored = restoreAutomatic(current, frame.outline), existing = new Set((restored.progressEvents || []).map(event => event.id));
    const retained = (current.progressEvents || []).filter(event => {
      const node = data().getNode?.(current, event.nodeId);
      if (!event.independent || event.validity !== 'valid' || existing.has(event.id) || !node || node.trigger || node.dependencies?.length || event.parentEventIds?.length ||
          event.evidence?.some(proof => proof.kind === 'world_fact') || !event.sourceRefs?.length || node.actorKind !== 'player') return false;
      const audit = timeline().auditRefs(event.sourceRefs);
      return audit.valid && !audit.synthetic && !audit.inherited && audit.refs.every(ref => ref.chatId === id() && ref.layer < length) &&
        event.evidence?.length && event.evidence.every(proof => {
          const ref = audit.refs.find(item => item.messageId === proof.messageId);
          return ref && proof.hash === ref.hash && clean(proof.quote) && String(context().chat[ref.layer]?.mes || '').includes(proof.quote);
        });
    });
    if (!retained.length) return frame;
    restored.progressEvents.push(...clone(retained));
    const after = { world: clone(frame.world), outline: captureAutomatic(data().advanceChapter(restored)) };
    const commit = { id: uid('independent'), parentId: bundle.headId, branchId: bundle.branchId, generationId: '', kind: 'outline', mode: 'retain-independent',
      prefixLength: length, prefixHash, sourceRefs: timeline().unionRefs(retained.map(event => event.sourceRefs)), layer: length - 1, createdAt: Date.now(),
      beforeHash: hash(frame), afterHash: hash(after), delta: delta(frame, after), facts: [], status: 'active' };
    bundle.journal.push(commit); bundle.headId = commit.id; return after;
  }
  function reconcile(options = {}) {
    window.OUTLINE_ENGINE?.abort?.();
    let bundle;
    try { bundle = ensureBaseline(); } catch (_) { return { changed: false, status: getStatus(), worldState: null, outlineState: data().loadState() }; }
    if (!bundle) return { changed: false, status: getStatus() };
    const source = refs(), hashes = prefixHashes(source);
    let target = bundle.baseline.id, failure = '', changed = false;
    try {
      if (source.length < bundle.baseline.prefixLength || hashes[bundle.baseline.prefixLength] !== bundle.baseline.prefixHash) failure = '正文早于启用基底或稳定消息身份已丢失';
      else {
        const chain = pathTo(bundle, bundle.headId);
        for (const commit of chain) {
          if (commit.prefixLength > source.length || hashes[commit.prefixLength] !== commit.prefixHash) break;
          target = commit.id;
        }
        const current = materialize(bundle, bundle.headId);
        if (!options.allowWorldMismatch && target === bundle.headId && !bundle.preview && worldHash(window.WORLD_ENGINE_CORE.loadState()) !== worldHash(current.world)) failure = '公开世界被外部修改，需恢复联合存档或显式重新建立基底';
      }
      if (failure) {
        bundle.recovery = { status: 'blocked', reason: failure, boundaryLayer: bundle.baseline.prefixLength - 1 };
        write(bundle, null, false); return { changed: true, status: getStatus(), worldState: null, outlineState: data().loadState() };
      }
      if (bundle.preview) return { changed: false, status: metadata(bundle), worldState: materialize(bundle, bundle.preview.baseHeadId).world, outlineState: data().loadState() };
      if (target !== bundle.headId) {
        let frame = materialize(bundle, target); const commit = bundle.journal.find(item => item.id === target);
        const length = commit?.prefixLength ?? bundle.baseline.prefixLength;
        bundle.headId = target; bundle.branchId = uid('branch');
        bundle.recovery = source.length > length ? { status: 'pending-rebuild', reason: '保留正文超出最后完整有效提交，后续结果需显式重新对账',
          pendingFromLayer: length, pendingMessageIds: source.slice(length).map(ref => ref.messageId) } : { status: 'ready', reason: '' };
        frame = retainIndependent(bundle, frame, length, hashes[length]);
        write(bundle, frame); changed = true;
      }
      return { changed, status: getStatus(), worldState: materialize(bundle, bundle.headId).world, outlineState: data().loadState() };
    } catch (error) {
      bundle.recovery = { status: 'blocked', reason: error.message, boundaryLayer: bundle.baseline.prefixLength - 1 };
      write(bundle, null, false); return { changed: true, status: getStatus(), worldState: null, outlineState: data().loadState() };
    }
  }
  function prepareForGeneration(options = {}) {
    if (options.dryRun || !enabled()) return { changed: false, status: getStatus() };
    const source = refs(), targetLayerValue = Number.isFinite(Number(options.targetLayer)) ? Number(options.targetLayer) : Math.max(0, source.length - 1);
    const signature = hash({ type: options.type || 'normal', target: targetLayerValue, prefix: prefixHashes(source).pop(), chatId: id() });
    if (generation && !generation.completed && generation.signature === signature && generation.chatId === id()) return { status: getStatus(), worldState: getWorldState(), outlineState: data().loadState() };
    session++; generation = { id: uid('generation'), signature, chatId: id(), completed: false };
    window.OUTLINE_ENGINE?.abort?.();
    const result = reconcile(); if (result.status.blocked) return result;
    const bundle = load(); if (!bundle) return result;
    if (!['swipe', 'regenerate'].includes(options.type)) return result;
    const targetLayer = targetLayerValue;
    if (targetLayer < bundle.baseline.prefixLength) {
      bundle.recovery = { status: 'blocked', reason: '该回复产生前的状态早于启用基底，不能构造不存在的历史状态', boundaryLayer: bundle.baseline.prefixLength - 1 };
      write(bundle, null, false); return { changed: true, status: getStatus(), worldState: null };
    }
    let target = bundle.baseline.id;
    for (const commit of pathTo(bundle, bundle.headId)) { if (commit.prefixLength > targetLayer) break; target = commit.id; }
    bundle.preview = { oldHeadId: bundle.headId, baseHeadId: target, branchId: uid('branch'), generationId: generation.id, targetLayer };
    bundle.recovery = { status: 'ready', reason: '' };
    const frame = materialize(bundle, target); write(bundle, frame);
    return { changed: true, status: getStatus(), worldState: clone(frame.world), outlineState: data().loadState() };
  }
  function finishGeneration() { if (generation) generation.completed = true; }
  function cancelGeneration() {
    session++; pending.clear(); if (generation) generation.completed = true;
    const bundle = load(); if (!bundle?.preview) return { changed: false, status: getStatus() };
    const oldHead = bundle.preview.oldHeadId, source = refs(), hashes = prefixHashes(source);
    const commit = bundle.journal.find(item => item.id === oldHead), length = commit?.prefixLength ?? bundle.baseline.prefixLength;
    const expected = commit?.prefixHash ?? bundle.baseline.prefixHash;
    bundle.preview = null;
    if (hashes[length] === expected) { bundle.headId = oldHead; bundle.recovery = { status: 'ready', reason: '' }; write(bundle, materialize(bundle, oldHead)); }
    else { write(bundle, null, false); return reconcile(); }
    return { changed: true, status: getStatus(), worldState: getWorldState(), outlineState: data().loadState() };
  }
  function captureWorldStep(options = {}) {
    let bundle = ensureBaseline(options.beforeWorld);
    if (!bundle) return null;
    if (getStatus().blocked && !bundle.rebuilding) throw new Error(getStatus().reason || '联合历史需要恢复或显式重建');
    let baseId = bundle.preview?.baseHeadId || bundle.headId;
    if (options.mode === 'redo' && !bundle.preview) {
      const last = pathTo(bundle, bundle.headId).filter(commit => commit.kind === 'world').pop();
      if (!last) throw new Error('没有可重新推演的世界提交');
      baseId = last.parentId;
    }
    const frame = materialize(bundle, baseId), current = refs(), state = data().loadState();
    if (!bundle.preview && options.mode !== 'redo' && options.beforeWorld && worldHash(options.beforeWorld) !== worldHash(frame.world)) {
      markExternalWorldChange('世界基底与联合日志不一致'); throw new Error('世界基底与联合日志不一致');
    }
    const sourceRefs = clone(options.sourceRefs || []);
    if (sourceRefs.length && (!timeline().auditRefs(sourceRefs).valid || sourceRefs.some(ref => ref.synthetic || ref.chatId !== id()))) throw new Error('本次世界推演的正文来源已失效');
    const prefixLength = bundle.rebuilding && sourceRefs.length ? Math.max(...sourceRefs.map(ref => Number(ref.layer) + 1)) : current.length;
    const token = { id: uid('task'), chatId: id(), epoch: bundle.epoch, headId: bundle.headId, baseId, bundleRevision: bundle.revision,
      session, generationId: generation?.id || '', mode: options.mode || 'forward', beforeWorld: clone(frame.world), beforeOutline: clone(frame.outline),
      planRevision: state.revision, planHash: hash(state.plan), manualHash: hash(state.manualOverrides || {}), sourceRefs,
      sourceDigest: timeline().digestRefs(sourceRefs), prefixLength, prefixHash: prefixHashes(current)[prefixLength],
      guardPrefixLength: current.length, guardPrefixHash: prefixHashes(current).pop(), branchId: bundle.preview?.branchId || bundle.branchId };
    pending.set(token.id, token); return token;
  }
  function validateWorldStep(token) {
    const bundle = load(), state = data().loadState(), current = refs();
    return !!token && pending.get(token.id) === token && token.chatId === id() && token.epoch === bundle?.epoch && token.headId === bundle?.headId &&
      token.bundleRevision === bundle?.revision && token.session === session && token.generationId === (generation?.id || '') &&
      token.planRevision === state.revision && token.planHash === hash(state.plan) && token.manualHash === hash(state.manualOverrides || {}) &&
      token.guardPrefixLength === current.length && token.guardPrefixHash === prefixHashes(current).pop() &&
      (!token.sourceRefs.length || (timeline().auditRefs(token.sourceRefs).valid && timeline().digestRefs(timeline().auditRefs(token.sourceRefs).refs) === token.sourceDigest));
  }
  function factRecords(commitId, privateEvents, beforeWorld, afterWorld) {
    const result = (privateEvents || []).filter(item => clean(item?.text)).map((item, index) => ({ ...clone(item),
      id: `${commitId}_private_${index}`, clientId: clean(item.id), commitId, privateEventIndex: index,
      text: clean(item.text), visibility: 'private', knownBy: clone(item.knownBy || []), entityRefs: clone(item.entityRefs || []),
      hash: hash({ text: clean(item.text), knownBy: item.knownBy || [], entityRefs: item.entityRefs || [] }) }));
    for (const collection of ['events', 'factions', 'worldTrends', 'winds', 'enemies']) {
      const before = new Map((beforeWorld[collection] || []).map(item => [item.id, item]));
      for (const item of afterWorld[collection] || []) if (hash(item) !== hash(before.get(item.id))) result.push({ id: `${commitId}_${collection}_${item.id}`, commitId,
        visibility: 'public', collection, entityId: item.id, value: clone(item), hash: hash(item) });
    }
    return result;
  }
  function commitWorldStep(token, payload = {}) {
    if (!validateWorldStep(token)) throw new Error('世界推演结果已迟到或基底变化，结果已丢弃');
    const bundle = load(), before = materialize(bundle, token.baseId), commitId = uid('world');
    const world = canonicalWorld(payload.worldState); world.storyCommitId = commitId;
    const facts = factRecords(commitId, payload.privateEvents, before.world, world);
    const commit = { id: commitId, parentId: token.baseId, branchId: token.branchId, generationId: token.generationId, kind: 'world', mode: token.mode,
      prefixLength: token.prefixLength, prefixHash: token.prefixHash, sourceRefs: clone(token.sourceRefs), layer: token.prefixLength - 1,
      createdAt: Date.now(), facts, observations: clone(payload.observations || []), beforeWorld: clone(token.beforeWorld), worldState: clone(world), validated: true, status: 'active' };
    pending.set(commitId, commit);
    try {
      let outline = payload.outlineState || data().loadState();
      if (window.OUTLINE_ENGINE?.ingestWorldCommit) outline = window.OUTLINE_ENGINE.ingestWorldCommit(commit, { state: outline, persist: false }) || outline;
      const after = { world, outline: captureAutomatic(outline) };
      delete commit.worldState; delete commit.beforeWorld; delete commit.validated;
      commit.beforeHash = hash(before); commit.afterHash = hash(after); commit.delta = delta(before, after);
      bundle.journal.push(commit); bundle.headId = commitId; bundle.branchId = token.branchId; bundle.preview = null;
      bundle.recovery = bundle.rebuilding ? { status: 'rebuilding', reason: '', pendingFromLayer: token.prefixLength } : { status: 'ready', reason: '' };
      const count = pathTo(bundle, commitId).filter(item => item.kind === 'world').length;
      if (count % 10 === 0 || before.outline.currentChapterId !== after.outline.currentChapterId) bundle.snapshots.push({ atCommitId: commitId, frame: clone(after), hash: hash(after) });
      write(bundle, after); pending.delete(token.id);
      return { ...clone(commit), worldState: clone(world), outlineState: data().loadState() };
    } finally { pending.delete(commitId); }
  }
  function abortWorldStep(token) { if (token) pending.delete(token.id); }
  function recordOutlineCommit(beforeState, afterState, sourceRefs) {
    if (!enabled() || applying) { data().saveState(afterState); return null; }
    const bundle = ensureBaseline(), before = materialize(bundle, bundle.preview?.baseHeadId || bundle.headId);
    if (getStatus().blocked) throw new Error('联合历史待恢复，不能发布新的自动剧情判断');
    const after = { world: clone(before.world), outline: captureAutomatic(afterState) }, source = refs();
    if (hash(before) === hash(after)) { data().saveState(afterState); return null; }
    const commit = { id: uid('outline'), parentId: bundle.preview?.baseHeadId || bundle.headId, branchId: bundle.preview?.branchId || bundle.branchId,
      generationId: generation?.id || '', kind: 'outline', mode: 'check', prefixLength: source.length, prefixHash: prefixHashes(source).pop(),
      sourceRefs: clone(sourceRefs || []), layer: source.length - 1, createdAt: Date.now(), beforeHash: hash(before), afterHash: hash(after),
      delta: delta(before, after), facts: [], status: 'active' };
    bundle.journal.push(commit); bundle.headId = commit.id; bundle.branchId = commit.branchId; bundle.preview = null; bundle.recovery = { status: 'ready', reason: '' };
    if (before.outline.currentChapterId !== after.outline.currentChapterId) bundle.snapshots.push({ atCommitId: commit.id, frame: clone(after), hash: hash(after) });
    write(bundle, after, false); return clone(commit);
  }
  function validateWorldEvidence(proof, suppliedCommit) {
    const bundle = load(); if (!bundle || !proof) return null;
    let commit = suppliedCommit && pending.get(suppliedCommit.id) === suppliedCommit ? suppliedCommit : null;
    if (!commit) {
      const active = new Set([bundle.baseline.id, ...pathTo(bundle, bundle.preview?.baseHeadId || bundle.headId).map(item => item.id)]);
      if (!active.has(proof.commitId)) return null;
      commit = bundle.journal.find(item => item.id === proof.commitId);
    }
    if (!commit || (proof.commitId && proof.commitId !== commit.id)) return null;
    const fact = (commit.facts || []).find(item => proof.privateEventIndex != null ? item.privateEventIndex === Number(proof.privateEventIndex) : item.id === proof.factId || item.clientId === proof.factId);
    if (!fact || (proof.hash && proof.hash !== fact.hash)) return null;
    return { kind: 'world_fact', commitId: commit.id, factId: fact.id, hash: fact.hash };
  }
  function getWorldState() {
    try { const bundle = load(); if (!bundle) return null; return materialize(bundle, bundle.preview?.baseHeadId || bundle.headId).world; } catch (_) { return null; }
  }
  function isCommitActive(commitId) {
    try { const bundle = load(); if (!bundle || getStatus().phase === 'blocked') return false;
      return commitId === bundle.baseline.id || pathTo(bundle, bundle.preview?.baseHeadId || bundle.headId).some(commit => commit.id === commitId); }
    catch (_) { return false; }
  }
  function listCommits() {
    let bundle; try { bundle = load(); } catch (_) { return []; } if (!bundle) return [];
    let active = new Set(); try { active = new Set(pathTo(bundle, bundle.headId).map(item => item.id)); } catch (_) {}
    return bundle.journal.map(commit => ({ id: commit.id, parentId: commit.parentId, branchId: commit.branchId, kind: commit.kind,
      layer: commit.layer, createdAt: commit.createdAt, mode: commit.mode, status: active.has(commit.id) ? 'active' : 'archived' }));
  }
  function restoreCommit(target) {
    window.OUTLINE_ENGINE?.abort?.(); session++; pending.clear();
    persistenceFailures.delete(id());
    const bundle = load(); if (!bundle) throw new Error('没有联合历史');
    const frame = materialize(bundle, target), commit = bundle.journal.find(item => item.id === target), length = commit?.prefixLength ?? bundle.baseline.prefixLength;
    const expected = commit?.prefixHash ?? bundle.baseline.prefixHash, source = refs();
    if (prefixHashes(source)[length] !== expected) throw new Error('该提交的正文来源与当前聊天不一致');
    bundle.headId = target; bundle.branchId = uid('branch'); bundle.preview = null;
    bundle.recovery = source.length > length ? { status: 'pending-rebuild', reason: '已恢复历史提交，保留后文需要显式重新对账', pendingFromLayer: length } : { status: 'ready', reason: '' };
    write(bundle, frame); return { worldState: getWorldState(), outlineState: data().loadState(), status: getStatus() };
  }
  function markExternalWorldChange(reason) {
    const bundle = load(); if (!bundle) return;
    bundle.recovery = { status: 'blocked', reason: clean(reason) || '检测到联合日志之外的世界修改' };
    write(bundle, null, false);
  }
  function recordWorldEdit(beforeWorld, worldState) {
    if (!enabled() || applying) return null;
    if (beforeWorld && worldHash(beforeWorld) === worldHash(worldState)) return null;
    const token = captureWorldStep({ mode: 'edit', sourceRefs: [], beforeWorld });
    return commitWorldStep(token, { worldState });
  }
  function exportBundle() { return { type: 'story-engine-bundle', schemaVersion: 2, bundle: clone(load()), outline: { plan: clone(data().loadState().plan) } }; }
  function validateBundle(value) {
    const bundle = clone(value?.bundle || value);
    if (bundle?.schemaVersion !== 2 || !bundle.baseline || !Array.isArray(bundle.journal)) throw new Error('联合历史格式无效或版本过新');
    const forbidden = new Set(['apiKey', 'apiUrl', 'authorization', 'Authorization', 'settings', 'apiSettings']);
    const audit = item => {
      if (!item || typeof item !== 'object') return;
      if (Array.isArray(item)) { item.forEach(audit); return; }
      for (const [key, entry] of Object.entries(item)) { if (forbidden.has(key)) throw new Error('联合历史不得携带 API 配置或密钥'); audit(entry); }
      if (Array.isArray(item.path) && item.path.some(part => forbidden.has(part) || ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('联合日志路径不允许写入配置或对象原型');
    };
    audit(bundle);
    const allowed = ['schemaVersion', 'chatId', 'epoch', 'revision', 'branchId', 'headId', 'baseline', 'snapshots', 'journal', 'recovery', 'preview', 'rebuilding'];
    for (const key of Object.keys(bundle)) if (!allowed.includes(key)) delete bundle[key];
    const ids = new Set([bundle.baseline.id]);
    for (const commit of bundle.journal) {
      if (!commit.id || ids.has(commit.id)) throw new Error('联合提交ID重复或缺失');
      ids.add(commit.id);
      if (!Number.isInteger(commit.prefixLength) || commit.prefixLength < 0 || !Array.isArray(commit.delta)) throw new Error('联合提交缺少可重放增量或来源边界');
    }
    for (const snapshot of bundle.snapshots || []) if (!ids.has(snapshot.atCommitId) || hash(snapshot.frame) !== snapshot.hash) throw new Error('联合周期快照校验失败');
    for (const commit of bundle.journal) materialize(bundle, commit.id);
    materialize(bundle, bundle.headId);
    return bundle;
  }
  function importBundle(value) {
    const bundle = validateBundle(value);
    window.OUTLINE_ENGINE?.abort?.(); session++; pending.clear(); generation = null; persistenceFailures.delete(id());
    if (bundle.chatId !== id()) {
      if (value?.outline?.plan) data().importData({ plan: value.outline.plan }, { includeProgress: false });
      store().removeItem?.(PREFIX + id()); ensureBaseline();
      return { importedPlanOnly: true, status: getStatus() };
    }
    materialize(bundle, bundle.headId);
    const previous = load(); bundle.revision = Math.max(bundle.revision || 0, previous?.revision || 0);
    bundle.preview = null; write(bundle, null, false);
    const result = reconcile({ allowWorldMismatch: true });
    if (!result.status.blocked) write(load(), materialize(load(), load().headId));
    return { ...result, status: getStatus() };
  }
  function beginRebuild(options = {}) {
    window.OUTLINE_ENGINE?.abort?.(); session++; pending.clear(); generation = null; persistenceFailures.delete(id());
    let bundle = ensureBaseline();
    const source = refs(), baselineValid = source.length >= bundle.baseline.prefixLength && prefixHashes(source)[bundle.baseline.prefixLength] === bundle.baseline.prefixHash;
    if (options.fromBeginning || !baselineValid || getStatus().phase === 'blocked') {
      store().setItem(PREFIX + id() + '_before_rebuild', JSON.stringify(bundle));
      store().removeItem(PREFIX + id());
      const state = data().loadState();
      for (const key of ['progressEvents', 'proposals', 'privateFacts', 'clues', 'contacts', 'knowledge']) state[key] = [];
      state.tracking = { ...state.tracking, pendingRecheck: false, roundsSinceCheck: 0, lastDigest: '' };
      state.currentChapterId = state.plan.chapters[0]?.id || ''; state.scheduler = {}; data().saveState(state);
      bundle = ensureBaseline(window.WORLD_ENGINE_CORE.getDefaultState(), { sourceRefs: [] });
    }
    const head = bundle.journal.find(commit => commit.id === bundle.headId), fromLayer = head?.prefixLength ?? bundle.baseline.prefixLength;
    bundle.rebuilding = { startedAt: Date.now(), fromLayer, chatId: id() }; bundle.preview = null;
    bundle.recovery = { status: 'rebuilding', reason: '', pendingFromLayer: fromLayer };
    const frame = materialize(bundle, bundle.headId); write(bundle, frame);
    return { worldState: clone(frame.world), fromLayer, fromChatIndex: fromLayer, chatId: id(), status: getStatus() };
  }
  function finishRebuild(success, options = {}) {
    const bundle = load(); if (!bundle) return getStatus();
    delete bundle.rebuilding;
    const head = bundle.journal.find(commit => commit.id === bundle.headId), length = head?.prefixLength ?? bundle.baseline.prefixLength;
    bundle.recovery = success ? { status: 'ready', reason: '' } : { status: 'pending-rebuild', reason: clean(options.reason) || '重建中止，已成功批次保留', pendingFromLayer: length };
    write(bundle, materialize(bundle, bundle.headId)); return getStatus();
  }
  function resetBaseline(worldState) {
    window.OUTLINE_ENGINE?.abort?.(); session++; pending.clear(); generation = null;
    const previous = load();
    if (previous) store().setItem(PREFIX + id() + '_before_rebuild', JSON.stringify(previous));
    store().removeItem(PREFIX + id());
    const state = data().loadState();
    for (const key of ['progressEvents', 'proposals', 'privateFacts', 'clues', 'contacts', 'knowledge']) state[key] = [];
    state.scheduler = {}; state.recovery = { status: 'ready' };
    data().saveState(state); return ensureBaseline(worldState);
  }
  function rebuild(options) {
    if (typeof window.WORLD_ENGINE?.rebuildLinkedHistory !== 'function') throw new Error('世界引擎尚未提供显式批量重建入口');
    return window.WORLD_ENGINE.rebuildLinkedHistory(options);
  }
  function markPersistenceFailure(reason) { persistenceFailures.set(id(), '联合存档未能持久化：' + clean(reason)); window.OUTLINE_ENGINE?.abort?.(); }
  return { PREFIX, isEnabled: enabled, isApplying: () => applying, ensureBaseline, captureWorldStep, validateWorldStep, commitWorldStep, abortWorldStep,
    prepareForGeneration, finishGeneration, cancelGeneration, reconcile, getStatus, getWorldState, listCommits, restoreCommit,
    recordOutlineCommit, validateWorldEvidence, recordWorldEdit, markExternalWorldChange, isCommitActive,
    exportBundle, validateBundle, importBundle, resetBaseline, beginRebuild, finishRebuild, rebuild, markPersistenceFailure };
})();
