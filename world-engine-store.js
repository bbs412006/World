// world-engine-store.js — 存储中间层
// 把世界引擎的所有存档从狭小的 localStorage（约 5MB，与酒馆共用）迁移到 IndexedDB（容量大几十倍）。
// 对上层暴露与 localStorage 相同的同步读写接口：启动时把 IndexedDB 数据灌入内存镜像，
// 读直接走镜像（同步），写同步更新镜像并异步刷入 IndexedDB。IndexedDB 不可用时自动回退 localStorage。
window.WORLD_ENGINE_STORE = (function() {
  const DB_NAME = 'world_engine';
  const STORE_NAME = 'kv';
  const PREFIXES = ['world_engine_', 'memory_engine_', 'outline_engine_'];

  let db = null;
  let ready = false;
  let staged = null;
  let lastPersistence = Promise.resolve();
  const mirror = new Map(); // key -> string value（内存镜像，支持同步读）

  // 写入回调（同步槽）：每次 setItem/removeItem 后通知订阅者。
  // 酒馆缓存模块（world-engine-chatcache.js）借此把按聊天隔离的存档镜像进 chat_metadata，
  // 实现跨设备同步；其他模块无需改动。hydrate() 直接写 mirror，不经过这里，故灌入镜像时不会回弹。
  let syncSink = null;
  function setSyncSink(sink) { syncSink = sink; }
  function notifySink(method, key, value) {
    if (!syncSink || typeof syncSink[method] !== 'function') return;
    try { syncSink[method](key, value); } catch (e) { /* 同步失败不得影响本地写入 */ }
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE_NAME)) d.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGetAll() {
    return new Promise((resolve, reject) => {
      const out = [];
      const cur = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { out.push([c.key, c.value]); c.continue(); }
        else resolve(out);
      };
      cur.onerror = () => reject(cur.error);
    });
  }

  function idbPut(key, value) {
    if (!db) return;
    try { db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value, key); }
    catch (e) { console.warn('[世界引擎] IndexedDB 写入失败', e); }
  }

  function idbDel(key) {
    if (!db) return;
    try { db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(key); }
    catch (e) {}
  }

  // 启动时调用一次：打开 IndexedDB、灌入镜像、迁移并清理 localStorage 中的旧存档
  async function hydrate() {
    if (ready) return;
    try {
      db = await openDB();
      for (const [k, v] of await idbGetAll()) mirror.set(k, v);
    } catch (e) {
      console.warn('[世界引擎] IndexedDB 不可用，回退到 localStorage', e);
      db = null;
    }
    // 把 localStorage 里遗留的 world_engine_* 搬进 IndexedDB，并腾出 localStorage 空间
    try {
      const legacyKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && PREFIXES.some(prefix => k.startsWith(prefix))) legacyKeys.push(k);
      }
      for (const k of legacyKeys) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        if (!mirror.has(k)) { mirror.set(k, v); idbPut(k, v); }
        if (db) localStorage.removeItem(k); // 仅在 IDB 可用（已落盘）时才删，避免丢数据
      }
      if (db && legacyKeys.length) {
        console.log(`[世界引擎] 已迁移 ${legacyKeys.length} 条存档至 IndexedDB`);
      }
    } catch (e) { console.warn('[世界引擎] 旧存档迁移失败（非致命）', e); }
    ready = true;
  }

  function getItem(key) {
    if (staged?.has(key)) return staged.get(key);
    if (mirror.has(key)) return mirror.get(key);
    // 镜像未命中（未 hydrate 或 IDB 不可用）时回退到 localStorage
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function setItem(key, value) {
    value = String(value);
    if (staged) { staged.set(key, value); return; }
    mirror.set(key, value);
    if (db) idbPut(key, value);
    else localStorage.setItem(key, value); // IDB 不可用时退回 localStorage（可能抛配额错误）
    notifySink('onWrite', key, value);
  }

  function removeItem(key) {
    if (staged) { staged.set(key, null); return; }
    mirror.delete(key);
    if (db) idbDel(key);
    else { try { localStorage.removeItem(key); } catch (e) {} }
    notifySink('onRemove', key, null);
  }

  // 返回镜像中所有 key（替代 localStorage.length / localStorage.key(i)）
  function keys() {
    if (staged) {
      const all = new Set([...mirror.keys()]);
      for (const [key, value] of staged) { if (value === null) all.delete(key); else all.add(key); }
      return [...all];
    }
    if (mirror.size || db) return [...mirror.keys()];
    const out = [];
    for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
    return out;
  }

  // 短事务仅包住已校验结果的同步提交，绝不跨越模型请求等待。
  function beginTransaction() {
    if (staged) throw new Error('存储事务已经开始');
    staged = new Map();
  }
  function rollbackTransaction() { staged = null; }
  function commitTransaction() {
    if (!staged) return Promise.resolve();
    const writes = staged; staged = null;
    const persistenceChatId = window.WORLD_ENGINE_CORE?.getChatId?.();
    const previous = new Map([...writes].map(([key]) => [key, getItem(key)]));
    let persistence = Promise.resolve();
    if (db && writes.size) {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      persistence = new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('联合存档写入失败'));
      });
      const target = transaction.objectStore(STORE_NAME);
      try {
        for (const [key, value] of writes) { if (value === null) target.delete(key); else target.put(value, key); }
      } catch (error) {
        // 某次 put 同步失败也必须撤销同一 IDB 事务里已经排队的其他键。
        try { transaction.abort(); } catch (_) {}
        persistence.catch(() => {});
        throw error;
      }
    } else {
      // localStorage 没有事务：先尝试全部写盘，失败时恢复原值，不发布镜像与通知。
      try {
        for (const [key, value] of writes) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
      } catch (error) {
        for (const [key, value] of previous) {
          try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (_) {}
        }
        throw error;
      }
    }
    for (const [key, value] of writes) { if (value === null) mirror.delete(key); else mirror.set(key, value); }
    const publish = () => {
      for (const [key, value] of writes) {
        // 较新的提交已经覆盖该键时，不把迟到的旧版本同步到聊天元数据。
        if (getItem(key) !== value) continue;
        notifySink(value === null ? 'onRemove' : 'onWrite', key, value);
      }
    };
    if (!db) publish();
    lastPersistence = persistence.then(() => { if (db) publish(); }).catch(error => {
      for (const [key, value] of previous) {
        if (mirror.get(key) !== writes.get(key) && !(writes.get(key) === null && !mirror.has(key))) continue;
        if (value === null) mirror.delete(key); else mirror.set(key, value);
      }
      if (window.WORLD_ENGINE_CORE?.getChatId?.() === persistenceChatId) {
        window.STORY_ENGINE_HISTORY?.markPersistenceFailure?.(error.message || String(error));
      }
      throw error;
    });
    // 仍把原 rejection 留给 flush/调用者，但不用事务的只读恢复入口不会制造 unhandled rejection。
    lastPersistence.catch(error => console.error('[联合存档] 持久化失败', error));
    return lastPersistence;
  }

  return { hydrate, getItem, setItem, removeItem, keys, setSyncSink,
    beginTransaction, commitTransaction, rollbackTransaction,
    isTransactionActive: () => staged !== null, flush: () => lastPersistence };
})();
