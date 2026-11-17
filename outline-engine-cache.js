// 剧情存档：只同步当前聊天状态，不含 API 设置或密钥。
(function() {
  'use strict';
  const NS = 'outline_engine';
  const TYPE = 'outline-engine-chat-snapshot';
  const MAX_AUTO = 3, MAX_MANUAL = 20;
  const copy = value => JSON.parse(JSON.stringify(value));
  const store = () => window.WORLD_ENGINE_STORE;
  const settings = () => window.OUTLINE_ENGINE_SETTINGS.getSettings();
  const data = () => window.OUTLINE_ENGINE_DATA;
  const key = id => `outline_engine_state_${id}`;
  const revKey = id => `outline_engine_${id}_syncrev`;
  let suspended = false, timer = null;
  function ctx() { try { return SillyTavern.getContext(); } catch (_) { return null; } }
  function usable(context) { return !!(context?.chatId && context.chatId !== 'default'); }
  function read() { const value = ctx()?.chatMetadata?.[NS]; return value?.v === 1 ? copy(value) : null; }
  function ensure() {
    const value = read() || { v: 1, live: null, snapshots: [] };
    if (!Array.isArray(value.snapshots)) value.snapshots = [];
    value.snapshots = value.snapshots.filter(item => validPack(item?.data)).map(item => ({
      ...item, data: sanitizePack(item.data, item.chatId)
    }));
    if (validPack(value.live?.data)) value.live.data = sanitizePack(value.live.data, value.live.chatId);
    return value;
  }
  function sanitizePack(value, id) {
    return { state: JSON.stringify(data().normalizeState(JSON.parse(value.state), id)) };
  }
  function revision(id) { return Math.max(0, Number(store().getItem(revKey(id))) || 0); }
  function setRevision(id, value) { store().setItem(revKey(id), String(value)); }
  function pack(id) {
    const raw = store().getItem(key(id));
    if (raw == null) return {};
    try { return { state: JSON.stringify(data().normalizeState(JSON.parse(raw), id)) }; }
    catch (_) { return {}; }
  }
  function same(a, b) { return a?.state === b?.state; }
  function validPack(value) {
    if (!value || typeof value.state !== 'string') return false;
    try {
      const state = JSON.parse(value.state);
      return state?.schemaVersion === 1 && Array.isArray(state?.plan?.chapters);
    } catch (_) { return false; }
  }
  function write(value, expectedChatId) {
    const context = ctx();
    if (!usable(context) || context.chatId !== expectedChatId) return false;
    try {
      if (typeof context.updateChatMetadata === 'function') context.updateChatMetadata({ [NS]: value });
      else if (context.chatMetadata) context.chatMetadata[NS] = value;
      else return false;
      const save = context.saveMetadataDebounced || context.saveMetadata || context.saveChat;
      if (typeof save === 'function') save.call(context);
      return true;
    } catch (error) { console.warn('[剧情大纲] 保存聊天存档失败', error); return false; }
  }
  function install(value, id, exact) {
    if (!validPack(value)) throw new Error('剧情存档格式无效');
    window.OUTLINE_ENGINE?.abort?.();
    suspended = true;
    try {
      const state = JSON.parse(value.state);
      // 实时同步采用远端修订原样恢复；用户导入/恢复才增加大纲修订号。
      // 否则每次换设备都递增 revision，导致两端反复把同一份计划推回去。
      if (exact && state.originChatId === id) data().saveState(state, id);
      else data().importData({ type: 'outline-engine-data', schemaVersion: 1, state }, {
          includeProgress: state.originChatId === id
        });
    } finally { suspended = false; }
  }
  function pushInto(namespace, id) {
    const packed = pack(id);
    if (!validPack(packed)) return null;
    const rev = Math.max(revision(id), Number(namespace.live?.rev) || 0) + 1;
    namespace.live = { rev, updatedAt: Date.now(), chatId: id, data: packed };
    return rev;
  }
  function pushLiveNow() {
    const context = ctx();
    if (!usable(context)) return false;
    const namespace = ensure(), packed = pack(context.chatId);
    if (!validPack(packed)) return false;
    if (same(namespace.live?.data, packed) && revision(context.chatId) === Number(namespace.live?.rev)) return true;
    const rev = pushInto(namespace, context.chatId);
    if (!write(namespace, context.chatId)) return false;
    setRevision(context.chatId, rev);
    return true;
  }
  function addSnapshot(namespace, name, auto, id, packed) {
    const snapshot = {
      id: `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: String(name || '剧情存档').slice(0, 60), auto: !!auto,
      createdAt: Date.now(), chatId: id, data: sanitizePack(packed, id), v: 1
    };
    namespace.snapshots.unshift(snapshot);
    let autos = 0, manuals = 0;
    namespace.snapshots = namespace.snapshots.filter(item => item.auto ? ++autos <= MAX_AUTO : ++manuals <= MAX_MANUAL);
    return snapshot;
  }
  function runTick(id) {
    timer = null;
    const context = ctx();
    if (!usable(context) || context.chatId !== id) return;
    const namespace = ensure(), packed = pack(id), st = settings();
    if (!validPack(packed)) return;
    let changed = false, rev = null;
    if (st.syncToChat && !same(namespace.live?.data, packed)) {
      rev = pushInto(namespace, id); changed = true;
    }
    if (st.autoBackup && !same(namespace.snapshots.find(item => item.auto)?.data, packed)) {
      addSnapshot(namespace, '自动备份', true, id, packed); changed = true;
    }
    if (changed && write(namespace, id) && rev != null) setRevision(id, rev);
  }
  function onStoreWrite(changedKey) {
    const context = ctx();
    if (suspended || !usable(context) || changedKey !== key(context.chatId)) return;
    const st = settings();
    if (!st.syncToChat && !st.autoBackup) return;
    clearTimeout(timer);
    const id = context.chatId;
    timer = setTimeout(() => runTick(id), 1500);
  }
  function onChatLoaded() {
    clearTimeout(timer); timer = null;
    const context = ctx();
    if (!usable(context) || !settings().syncToChat) return;
    const namespace = read(), local = revision(context.chatId), remote = Number(namespace?.live?.rev) || 0;
    if (!validPack(namespace?.live?.data)) { pushLiveNow(); return; }
    if (remote > local || !validPack(pack(context.chatId))) {
      install(namespace.live.data, context.chatId, true); setRevision(context.chatId, remote);
    } else if (local > remote) pushLiveNow();
  }
  function listSnapshots() { return ensure().snapshots; }
  function createSnapshot(name) {
    const context = ctx();
    if (!usable(context)) return null;
    const packed = pack(context.chatId);
    if (!validPack(packed)) return null;
    const namespace = ensure(), snapshot = addSnapshot(namespace, name, false, context.chatId, packed);
    return write(namespace, context.chatId) ? snapshot : null;
  }
  function restoreSnapshot(id) {
    const context = ctx();
    if (!usable(context)) return false;
    const namespace = ensure(), snapshot = namespace.snapshots.find(item => item.id === id);
    if (!snapshot || !validPack(snapshot.data)) return false;
    const previous = pack(context.chatId);
    if (validPack(previous)) addSnapshot(namespace, '恢复前自动备份', true, context.chatId, previous);
    install(snapshot.data, context.chatId);
    const rev = settings().syncToChat ? pushInto(namespace, context.chatId) : null;
    if (!write(namespace, context.chatId)) return false;
    if (rev != null) setRevision(context.chatId, rev);
    window.OUTLINE_ENGINE?.prepareHistoryForGeneration?.();
    window.OUTLINE_ENGINE?.applyInjection?.();
    return true;
  }
  function renameSnapshot(id, name) {
    const context = ctx(); if (!usable(context)) return false;
    const namespace = ensure(), snapshot = namespace.snapshots.find(item => item.id === id);
    if (!snapshot) return false;
    snapshot.name = String(name || snapshot.name).slice(0, 60);
    return write(namespace, context.chatId);
  }
  function deleteSnapshot(id) {
    const context = ctx(); if (!usable(context)) return false;
    const namespace = ensure(), before = namespace.snapshots.length;
    namespace.snapshots = namespace.snapshots.filter(item => item.id !== id);
    return before !== namespace.snapshots.length && write(namespace, context.chatId);
  }
  function exportSnapshot(id) {
    const snapshot = listSnapshots().find(item => item.id === id);
    return snapshot ? { type: TYPE, v: 1, ...copy(snapshot) } : null;
  }
  function importSnapshot(value) {
    const context = ctx();
    if (!usable(context) || value?.type !== TYPE || value.v !== 1 || !validPack(value.data)) throw new Error('不是有效的剧情存档');
    const namespace = ensure();
    const snapshot = addSnapshot(namespace, `${value.name || '剧情存档'}（导入）`, false, context.chatId, value.data);
    return write(namespace, context.chatId) ? snapshot : null;
  }
  function getStatus() {
    const context = ctx(), namespace = read(), st = settings();
    return {
      usable: usable(context), apiAvailable: !!(context && (context.updateChatMetadata || context.chatMetadata)),
      syncEnabled: st.syncToChat, autoBackupEnabled: st.autoBackup,
      localRev: usable(context) ? revision(context.chatId) : 0,
      liveRev: Number(namespace?.live?.rev) || 0, snapshotCount: namespace?.snapshots?.length || 0
    };
  }
  window.WORLD_ENGINE_CHATCACHE.registerScope('outline', {
    onStoreWrite, onChatLoaded, pushLiveNow, getStatus,
    listSnapshots, createSnapshot, restoreSnapshot, renameSnapshot, deleteSnapshot,
    exportSnapshot, importSnapshot
  });
})();
