// outline-engine-cache.js — 剧情大纲 v3 聊天缓存与快照（纯状态同步，无 bundle/历史锁依赖）
(function() {
  'use strict';

  const META_KEY = 'outline_engine_v3';
  const LEGACY_META_KEYS = ['outline_engine_v2', 'outline_engine'];
  const SNAPSHOT_TYPE = 'outline-engine-chat-snapshot';
  const MAX_AUTO = 3;
  const MAX_MANUAL = 20;
  const DEBOUNCE_MS = 1500;

  let timer = null;
  let suspended = false;
  let restoring = Promise.resolve();

  const ctx = () => { try { return SillyTavern?.getContext?.() || null; } catch (_) { return null; } };
  const store = () => window.WORLD_ENGINE_STORE;
  const data = () => window.OUTLINE_ENGINE_DATA;
  const settings = () => window.OUTLINE_ENGINE_SETTINGS?.getSettings?.(true) || {};
  const clone = v => JSON.parse(JSON.stringify(v));
  const usable = c => Boolean(c && c.chatId && c.chatId !== 'default');
  const stateKey = id => (data()?.STATE_PREFIX || 'outline_engine_v3_state_') + id;
  const revKey = id => `outline_engine_v3_${id}_syncrev`;

  function getRev(id) { return Number(store()?.getItem?.(revKey(id))) || 0; }
  function setRev(id, rev) { store()?.setItem?.(revKey(id), String(Math.max(0, Number(rev) || 0))); }

  function sanitizePack(rawPack, chatId) {
    try {
      const rawState = typeof rawPack?.state === 'string' ? JSON.parse(rawPack.state) : rawPack?.state;
      if (!rawState || typeof rawState !== 'object') return null;
      const norm = data()?.normalizeState ? data().normalizeState(rawState, chatId) : rawState;
      return { state: JSON.stringify(norm) };
    } catch (_) {
      return null;
    }
  }

  function validPack(rawPack) {
    try {
      const rawState = typeof rawPack?.state === 'string' ? JSON.parse(rawPack.state) : rawPack?.state;
      return Boolean(rawState && rawState.plan && Array.isArray(rawState.plan.chapters));
    } catch (_) {
      return false;
    }
  }

  function packLocal(id) {
    const raw = store()?.getItem?.(stateKey(id));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return validPack({ state: parsed }) ? { state: JSON.stringify(parsed) } : null;
    } catch (_) {
      return null;
    }
  }

  function readNamespace() {
    const c = ctx();
    const raw = c?.chatMetadata?.[META_KEY];
    if (!raw || typeof raw !== 'object') return null;
    return clone(raw);
  }

  function ensureNamespace() {
    const c = ctx();
    const id = c?.chatId || 'default';
    const existing = readNamespace();
    const ns = existing && existing.v === 3
      ? existing
      : { v: 3, live: null, snapshots: [] };
    ns.snapshots = (Array.isArray(ns.snapshots) ? ns.snapshots : [])
      .filter(s => s && s.id && validPack(s.data))
      .map(s => ({ ...s, data: sanitizePack(s.data, id) || s.data }));
    return ns;
  }

  function writeNamespace(ns, targetId) {
    const c = ctx();
    if (!usable(c) || c.chatId !== targetId) return false;
    if (typeof c.updateChatMetadata === 'function') {
      c.updateChatMetadata({ [META_KEY]: ns });
    } else {
      c.chatMetadata = c.chatMetadata || {};
      c.chatMetadata[META_KEY] = ns;
    }
    try {
      if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
      else if (typeof c.saveMetadata === 'function') c.saveMetadata();
      else if (typeof c.saveChat === 'function') c.saveChat();
    } catch (_) {}
    return true;
  }

  function trimSnapshots(ns) {
    const autoList = ns.snapshots.filter(s => s.auto === true);
    const manualList = ns.snapshots.filter(s => s.auto !== true);
    const keepAuto = autoList.slice(-MAX_AUTO);
    const keepManual = manualList.slice(-MAX_MANUAL);
    const keepIds = new Set([...keepAuto, ...keepManual].map(s => s.id));
    ns.snapshots = ns.snapshots.filter(s => keepIds.has(s.id));
  }

  function addSnapshot(ns, name, auto, chatId, packed) {
    const snapshot = {
      id: `os_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: String(name || (auto ? '自动备份' : '手动存档')).trim().slice(0, 60) || '大纲存档',
      auto: auto === true,
      createdAt: Date.now(),
      chatId,
      v: 3,
      data: sanitizePack(packed, chatId) || packed
    };
    ns.snapshots.push(snapshot);
    trimSnapshots(ns);
    return snapshot;
  }

  function pushInto(ns, chatId) {
    const packed = packLocal(chatId);
    if (!packed) return null;
    const nextRev = Math.max(getRev(chatId), Number(ns.live?.rev) || 0) + 1;
    ns.live = { rev: nextRev, updatedAt: Date.now(), chatId, data: packed };
    return nextRev;
  }

  function install(packed, targetId, exact) {
    const cleanPack = sanitizePack(packed, targetId);
    if (!cleanPack) return false;
    window.OUTLINE_ENGINE?.abort?.();
    suspended = true;
    try {
      const parsed = JSON.parse(cleanPack.state);
      if (exact && parsed.originChatId === targetId) {
        data()?.saveState?.(parsed, targetId);
      } else {
        data()?.importData?.({ state: parsed, chatId: parsed.originChatId || targetId }, { includeProgress: true }, targetId);
      }
      return true;
    } finally {
      suspended = false;
    }
  }

  function runTick() {
    timer = null;
    const c = ctx();
    const st = settings();
    if (!usable(c) || (!st.syncToChat && !st.autoBackup)) return;
    const id = c.chatId;
    const packed = packLocal(id);
    if (!packed) return;
    const ns = ensureNamespace();
    let changed = false;
    let newRev = null;

    if (st.syncToChat && ns.live?.data?.state !== packed.state) {
      newRev = pushInto(ns, id);
      changed = true;
    }
    if (st.autoBackup) {
      const latestAuto = [...ns.snapshots].reverse().find(s => s.auto === true);
      if (!latestAuto || latestAuto.data?.state !== packed.state) {
        addSnapshot(ns, `自动备份 ${new Date().toLocaleTimeString()}`, true, id, packed);
        changed = true;
      }
    }
    if (changed && writeNamespace(ns, id) && newRev != null) {
      setRev(id, newRev);
    }
  }

  function onStoreWrite(changedKey) {
    if (suspended) return;
    const c = ctx();
    if (!usable(c) || changedKey !== stateKey(c.chatId)) return;
    const st = settings();
    if (!st.syncToChat && !st.autoBackup) return;
    clearTimeout(timer);
    timer = setTimeout(runTick, DEBOUNCE_MS);
  }

  function pushLiveNow() {
    const c = ctx();
    if (!usable(c) || !settings().syncToChat) return false;
    const id = c.chatId;
    const packed = packLocal(id);
    if (!packed) return false;
    const ns = ensureNamespace();
    if (ns.live?.data?.state === packed.state) {
      if (getRev(id) !== Number(ns.live?.rev || 0)) setRev(id, Number(ns.live?.rev || 0));
      return true;
    }
    const rev = pushInto(ns, id);
    if (rev == null) return false;
    if (writeNamespace(ns, id)) {
      setRev(id, rev);
      return true;
    }
    return false;
  }

  async function restoreChat() {
    clearTimeout(timer);
    timer = null;
    const c = ctx();
    if (!usable(c) || !settings().syncToChat) return;
    const id = c.chatId;

    // 若本地无 v3 数据且远端存在旧版 v2/v1 live 数据，则尝试迁移一次
    if (!store()?.getItem?.(stateKey(id))) {
      for (const legacyKey of LEGACY_META_KEYS) {
        const legacyState = c.chatMetadata?.[legacyKey]?.live?.data?.state;
        if (legacyState) {
          try {
            const parsed = typeof legacyState === 'string' ? JSON.parse(legacyState) : legacyState;
            data()?.importData?.({ state: parsed, chatId: id }, { includeProgress: true }, id);
            break;
          } catch (_) {}
        }
      }
    }

    const ns = readNamespace();
    const localRev = getRev(id);
    const remoteRev = Number(ns?.live?.rev) || 0;
    const localPack = packLocal(id);

    if (!validPack(ns?.live?.data)) {
      if (localPack) pushLiveNow();
      return;
    }
    if (localPack && ns.live.data.state === localPack.state) {
      if (localRev !== remoteRev) setRev(id, remoteRev);
      return;
    }
    if (remoteRev > localRev || !localPack) {
      if (install(ns.live.data, id, true)) setRev(id, remoteRev);
    } else if (localRev > remoteRev) {
      pushLiveNow();
    }
  }

  function onChatLoaded() {
    restoring = restoreChat().catch(err => console.warn('[剧情大纲] 聊天缓存恢复失败', err));
    return restoring;
  }

  function listSnapshots() { return ensureNamespace().snapshots; }

  function createSnapshot(name) {
    const c = ctx();
    if (!usable(c)) return null;
    const packed = packLocal(c.chatId);
    if (!packed) return null;
    const ns = ensureNamespace();
    const snap = addSnapshot(ns, name, false, c.chatId, packed);
    return writeNamespace(ns, c.chatId) ? snap : null;
  }

  async function restoreSnapshot(id) {
    const c = ctx();
    if (!usable(c)) return false;
    const targetId = c.chatId;
    const ns = ensureNamespace();
    const snap = ns.snapshots.find(s => s.id === id);
    if (!snap || !validPack(snap.data)) return false;

    const prev = packLocal(targetId);
    if (prev) addSnapshot(ns, '恢复前自动备份', true, targetId, prev);
    if (!install(snap.data, targetId, false)) return false;
    if (ctx()?.chatId !== targetId) return false;
    const rev = settings().syncToChat ? pushInto(ns, targetId) : null;
    if (!writeNamespace(ns, targetId)) return false;
    if (rev != null) setRev(targetId, rev);
    window.OUTLINE_ENGINE?.applyInjection?.();
    return true;
  }

  function renameSnapshot(id, name) {
    const c = ctx();
    if (!usable(c)) return false;
    const ns = ensureNamespace();
    const snap = ns.snapshots.find(s => s.id === id);
    if (!snap) return false;
    snap.name = String(name || snap.name).trim().slice(0, 60) || snap.name;
    return writeNamespace(ns, c.chatId);
  }

  function deleteSnapshot(id) {
    const c = ctx();
    if (!usable(c)) return false;
    const ns = ensureNamespace();
    const before = ns.snapshots.length;
    ns.snapshots = ns.snapshots.filter(s => s.id !== id);
    return ns.snapshots.length !== before && writeNamespace(ns, c.chatId);
  }

  function exportSnapshot(id) {
    const snap = listSnapshots().find(s => s.id === id);
    return snap ? { type: SNAPSHOT_TYPE, v: 3, ...clone(snap) } : null;
  }

  function importSnapshot(value) {
    const c = ctx();
    if (!usable(c) || value?.type !== SNAPSHOT_TYPE || ![2, 3].includes(Number(value?.v)) || !validPack(value?.data)) {
      throw new Error('不是有效的剧情大纲存档快照');
    }
    const ns = ensureNamespace();
    const snap = addSnapshot(ns, `${value.name || '大纲存档'}（导入）`, false, c.chatId, value.data);
    return writeNamespace(ns, c.chatId) ? snap : null;
  }

  function getStatus() {
    const c = ctx();
    const ns = readNamespace();
    const st = settings();
    return {
      usable: usable(c),
      apiAvailable: Boolean(c && (c.updateChatMetadata || c.chatMetadata)),
      syncEnabled: st.syncToChat,
      autoBackupEnabled: st.autoBackup,
      localRev: usable(c) ? getRev(c.chatId) : 0,
      liveRev: Number(ns?.live?.rev) || 0,
      snapshotCount: Array.isArray(ns?.snapshots) ? ns.snapshots.length : 0
    };
  }

  if (window.WORLD_ENGINE_CHATCACHE?.registerScope) {
    window.WORLD_ENGINE_CHATCACHE.registerScope('outline', {
      onStoreWrite,
      onChatLoaded,
      pushLiveNow,
      getStatus,
      listSnapshots,
      createSnapshot,
      restoreSnapshot,
      renameSnapshot,
      deleteSnapshot,
      exportSnapshot,
      importSnapshot,
      whenReady: () => restoring
    });
  }
})();
