// memory-engine-vector.js — Embedding + Rerank 语义记忆召回与独立向量缓存
window.MEMORY_ENGINE_VECTOR = (function() {
  'use strict';

  const VECTOR_PREFIX = 'memory_engine_vectors_';
  const BATCH_SIZE = 16;
  const clean = value => String(value == null ? '' : value).trim();
  const unique = values => Array.from(new Set((Array.isArray(values) ? values : [values]).map(clean).filter(Boolean)));
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

  let maintainRunning = false;
  let activeMaintainPromise = null;
  let recallRunning = false;
  let abortController = null;
  let maintainStatus = { running: false, current: 0, total: 0, message: '' };
  let lastQueryVector = { chatId: '', model: '', url: '', queryHash: '', vector: null };
  let lastRecallCache = null;

  function getChatId() {
    return clean(window.WORLD_ENGINE_CORE?.getChatId?.() || 'default');
  }

  function settings() {
    return window.MEMORY_ENGINE_SETTINGS?.getSettings?.(true) || {};
  }

  function hashText(value) {
    if (typeof window.MEMORY_ENGINE_TIMELINE?.hashText === 'function') {
      return window.MEMORY_ENGINE_TIMELINE.hashText(value);
    }
    const text = String(value == null ? '' : value);
    let first = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      first ^= text.charCodeAt(i);
      first = Math.imul(first, 0x01000193) >>> 0;
    }
    return first.toString(16).padStart(8, '0');
  }

  function normalizeVector(vec) {
    if (!Array.isArray(vec) || !vec.length) return [];
    let normSq = 0;
    for (let i = 0; i < vec.length; i++) {
      const n = Number(vec[i]) || 0;
      normSq += n * n;
    }
    const norm = Math.sqrt(normSq);
    if (!norm) return vec.map(() => 0);
    return vec.map(v => Number(((Number(v) || 0) / norm).toFixed(6)));
  }

  function dotProduct(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (Number(a[i]) || 0) * (Number(b[i]) || 0);
    return sum;
  }

  function tokenizeHybridText(text) {
    const raw = clean(text).toLocaleLowerCase();
    const tokens = new Set();
    if (!raw) return tokens;
    for (const word of raw.match(/[a-z0-9_]{2,}/g) || []) tokens.add(word);
    for (const seg of raw.match(/[\u4e00-\u9fff]+/g) || []) {
      if (seg.length === 1) { tokens.add(seg); continue; }
      for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
    }
    return tokens;
  }

  function computeLexicalOverlap(queryTokens, docText) {
    if (!queryTokens || !queryTokens.size) return 0;
    const docTokens = tokenizeHybridText(docText);
    if (!docTokens.size) return 0;
    let hits = 0;
    for (const tok of docTokens) {
      if (queryTokens.has(tok)) hits++;
    }
    if (!hits) return 0;
    // 以文档核心词被查询命中的覆盖率为主、并兼顾绝对命中次数，抑制长短文本偏差
    const coverage = hits / Math.min(docTokens.size, Math.max(4, queryTokens.size));
    const bonus = Math.min(0.25, hits * 0.04);
    return Number(Math.min(1, coverage * 0.8 + bonus).toFixed(4));
  }

  function computeScoreDistribution(scores) {
    const valid = (Array.isArray(scores) ? scores : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const count = valid.length;
    if (!count) return { count: 0, min: 0, max: 0, mean: 0, median: 0 };
    const sum = valid.reduce((acc, v) => acc + v, 0);
    const mid = Math.floor(count / 2);
    const median = count % 2 === 1 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
    return {
      count,
      min: Number(valid[0].toFixed(4)),
      max: Number(valid[count - 1].toFixed(4)),
      mean: Number((sum / count).toFixed(4)),
      median: Number(median.toFixed(4))
    };
  }

  function emptyStore(chatId) {
    return {
      version: 1,
      chatId: clean(chatId || getChatId()),
      embeddingModel: '',
      dimensions: 0,
      records: {},
      hashArchive: {}
    };
  }

  function loadVectorStore(chatId) {
    const id = clean(chatId || getChatId());
    try {
      const raw = window.WORLD_ENGINE_STORE?.getItem?.(VECTOR_PREFIX + id);
      if (!raw) return emptyStore(id);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.records || typeof parsed.records !== 'object') {
        return emptyStore(id);
      }
      return {
        version: 1,
        chatId: id,
        embeddingModel: clean(parsed.embeddingModel),
        dimensions: Math.max(0, parseInt(parsed.dimensions, 10) || 0),
        records: parsed.records,
        hashArchive: parsed.hashArchive && typeof parsed.hashArchive === 'object' ? parsed.hashArchive : {}
      };
    } catch (_) {
      return emptyStore(id);
    }
  }

  function saveVectorStore(data, chatId) {
    const id = clean(chatId || data?.chatId || getChatId());
    const archive = data?.hashArchive && typeof data.hashArchive === 'object' ? { ...data.hashArchive } : {};
    const archiveKeys = Object.keys(archive);
    if (archiveKeys.length > 300) {
      for (const k of archiveKeys.slice(0, archiveKeys.length - 300)) delete archive[k];
    }
    const next = {
      version: 1,
      chatId: id,
      embeddingModel: clean(data?.embeddingModel),
      dimensions: Math.max(0, parseInt(data?.dimensions, 10) || 0),
      records: data?.records && typeof data.records === 'object' ? data.records : {},
      hashArchive: archive
    };
    window.WORLD_ENGINE_STORE?.setItem?.(VECTOR_PREFIX + id, JSON.stringify(next));
    return next;
  }

  function pruneVectorsForState(stateOverride) {
    const id = getChatId();
    const st = settings();
    const state = stateOverride || window.MEMORY_ENGINE_DATA?.loadState?.();
    if (!state) return { pruned: 0, restored: 0, total: 0 };
    const store = loadVectorStore(id);
    if (!store.hashArchive || typeof store.hashArchive !== 'object') store.hashArchive = {};
    for (const rec of Object.values(store.records || {})) {
      if (rec?.textHash && Array.isArray(rec.vector) && rec.vector.length) {
        store.hashArchive[rec.textHash] = rec.vector;
      }
    }
    const items = collectVectorizableItems(state, st);
    const itemMap = new Map(items.map(item => [item.key, item]));
    let pruned = 0, restored = 0;
    for (const key of Object.keys(store.records || {})) {
      const item = itemMap.get(key);
      if (!item) {
        delete store.records[key];
        pruned++;
        continue;
      }
      const existing = store.records[key];
      if (!existing || existing.textHash !== item.textHash) {
        const archived = store.hashArchive[item.textHash];
        if (Array.isArray(archived) && archived.length) {
          store.records[key] = {
            key: item.key,
            kind: item.kind,
            ...(item.entityType ? { entityType: item.entityType } : {}),
            refId: item.refId,
            label: item.label,
            text: item.text,
            textHash: item.textHash,
            vector: archived,
            updatedAt: Date.now()
          };
          restored++;
        } else {
          delete store.records[key];
          pruned++;
        }
      }
    }
    for (const item of items) {
      if (!store.records[item.key]) {
        const archived = store.hashArchive[item.textHash];
        if (Array.isArray(archived) && archived.length) {
          store.records[item.key] = {
            key: item.key,
            kind: item.kind,
            ...(item.entityType ? { entityType: item.entityType } : {}),
            refId: item.refId,
            label: item.label,
            text: item.text,
            textHash: item.textHash,
            vector: archived,
            updatedAt: Date.now()
          };
          restored++;
        }
      }
    }
    if (pruned > 0 || restored > 0) {
      saveVectorStore(store, id);
      if (lastRecallCache?.chatId === id) lastRecallCache = null;
    }
    return { pruned, restored, total: Object.keys(store.records).length };
  }

  function clearVectorCache(chatId) {
    const id = clean(chatId || getChatId());
    window.WORLD_ENGINE_STORE?.removeItem?.(VECTOR_PREFIX + id);
    if (lastQueryVector.chatId === id) lastQueryVector = { chatId: '', model: '', url: '', queryHash: '', vector: null };
    if (lastRecallCache?.chatId === id) lastRecallCache = null;
    maintainStatus = { running: false, current: 0, total: 0, message: '向量缓存已清空' };
    return true;
  }

  function collectVectorizableItems(state, stOverride) {
    const st = stOverride || settings();
    const targetState = state || window.MEMORY_ENGINE_DATA?.loadState?.() || {};
    const model = clean(st.embeddingModel);
    const items = [];

    if (st.vectorIncludeArchivedSmall !== false) {
      for (const s of targetState.event_memory?.small_summaries || []) {
        if (!s || s.status === 'stale' || s.status === 'failed' || !clean(s.content)) continue;
        const text = [
          (s.keywords || []).length ? `关键词：${s.keywords.join('、')}` : '',
          (s.entityNames || []).length ? `涉及：${s.entityNames.join('、')}` : '',
          s.content
        ].filter(Boolean).join('；').slice(0, 420);
        items.push({
          key: `small:${s.id}`,
          kind: 'small',
          refId: s.id,
          label: `纪要[楼层 ${s.startLayer}-${s.endLayer}]`,
          text,
          textHash: hashText(`${model}||small||${text}`)
        });
      }
    }

    if (st.vectorIncludeFacts !== false) {
      for (const f of targetState.ongoing_facts || []) {
        if (!f || f.status !== 'active' || !clean(f.fact)) continue;
        const text = `[${f.category || '状态'} · ${f.subject || '全局'}] ${f.fact}${(f.keywords || []).length ? ` (${f.keywords.join('、')})` : ''}`.slice(0, 320);
        items.push({
          key: `fact:${f.id}`,
          kind: 'fact',
          refId: f.id,
          label: `事实[${f.subject || '全局'}]`,
          text,
          textHash: hashText(`${model}||fact||${text}`)
        });
      }
    }

    if (st.vectorIncludePersonalAndEntity !== false) {
      const arcs = Array.isArray(targetState.character_arcs) ? targetState.character_arcs : [];
      for (const p of targetState.personal_memory || []) {
        const names = unique(p?.names);
        if (!names.length) continue;
        const arc = arcs.find(a => a.characterId === p.id || (a.names || []).some(n => names.includes(n)));
        const recentMemories = Object.values(p.memory || {}).flat().slice(-5);
        if (!arc && !recentMemories.length) continue;
        const text = [
          `人物：${names.join('/')}`,
          arc?.relationship ? `关系：${arc.relationship}` : '',
          arc?.currentStance ? `立场：${arc.currentStance}` : '',
          recentMemories.join('；')
        ].filter(Boolean).join(' | ').slice(0, 360);
        items.push({
          key: `person:${p.id}`,
          kind: 'person',
          refId: p.id,
          label: `人物[${names[0]}]`,
          text,
          textHash: hashText(`${model}||person||${text}`)
        });
      }

      for (const type of ['organization', 'object', 'ability', 'location']) {
        for (const e of targetState.entity_memory?.[type] || []) {
          if (!clean(e?.name)) continue;
          const aliases = unique(e.aliases);
          const recentHist = (Array.isArray(e.history) ? e.history : []).slice(-4).map(h => h.event);
          const text = [
            `${e.name}${aliases.length ? `(${aliases.join('/')})` : ''}`,
            clean(e.description),
            recentHist.join('；')
          ].filter(Boolean).join(' | ').slice(0, 360);
          items.push({
            key: `entity:${type}:${e.id}`,
            kind: 'entity',
            entityType: type,
            refId: e.id,
            label: `实体[${e.name}]`,
            text,
            textHash: hashText(`${model}||entity||${text}`)
          });
        }
      }
    }
    return items;
  }

  function getStats(state) {
    const st = settings();
    const id = getChatId();
    const store = loadVectorStore(id);
    const items = collectVectorizableItems(state, st);
    let indexed = 0, missing = 0;
    for (const item of items) {
      const cached = store.records[item.key];
      if (cached && cached.textHash === item.textHash && Array.isArray(cached.vector) && cached.vector.length) {
        indexed++;
      } else {
        missing++;
      }
    }
    return {
      chatId: id,
      totalItems: items.length,
      indexed,
      missing,
      storedTotal: Object.keys(store.records).length,
      embeddingModel: store.embeddingModel || clean(st.embeddingModel),
      dimensions: store.dimensions || 0,
      lastRecall: lastRecallCache?.chatId === id ? {
        method: lastRecallCache.method,
        hitCount: lastRecallCache.hits.length,
        hits: clone(lastRecallCache.hits),
        diagnostics: clone(lastRecallCache.diagnostics || null),
        timestamp: lastRecallCache.timestamp
      } : null
    };
  }

  function embeddingConfig(st) {
    return {
      apiUrl: clean(st.embeddingApiUrl),
      apiKey: clean(st.embeddingApiKey),
      model: clean(st.embeddingModel),
      apiTimeoutMs: Number(st.embeddingTimeoutMs) || 60000
    };
  }

  function rerankConfig(st) {
    return {
      apiUrl: clean(st.rerankApiUrl || st.embeddingApiUrl),
      apiKey: clean(st.rerankApiKey || st.embeddingApiKey),
      model: clean(st.rerankModel),
      topN: Math.max(1, parseInt(st.rerankTopK, 10) || 5),
      apiTimeoutMs: Number(st.rerankTimeoutMs) || 60000
    };
  }

  async function maintainVectors(options = {}) {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    const embCfg = embeddingConfig(st);
    if (!embCfg.apiUrl || !embCfg.model) throw new Error('请先配置 Embedding API URL 和模型名称');
    if (typeof window.WORLD_ENGINE_API?.callEmbeddingApi !== 'function') throw new Error('API 模块未支持 Embedding');
    if (maintainRunning && activeMaintainPromise) {
      if (options.forceRebuild) throw new Error('向量维护任务已在运行中');
      try { await activeMaintainPromise; } catch (_) {}
    }
    if (maintainRunning) throw new Error('向量维护任务已在运行中');

    const runMaintain = async () => {
      const chatId = getChatId();
      const state = options.state || window.MEMORY_ENGINE_DATA?.loadState?.();
      const items = collectVectorizableItems(state, st);
      const store = options.forceRebuild ? emptyStore(chatId) : loadVectorStore(chatId);

      // 清理已不存在的旧条目，防止向量库孤儿残留
      const validKeys = new Set(items.map(item => item.key));
      let pruned = 0;
      for (const key of Object.keys(store.records)) {
        if (!validKeys.has(key)) { delete store.records[key]; pruned++; }
      }

      const modelChanged = store.embeddingModel && store.embeddingModel !== embCfg.model;
      if (modelChanged || options.forceRebuild) store.hashArchive = {};
      if (!store.hashArchive || typeof store.hashArchive !== 'object') store.hashArchive = {};
      for (const rec of Object.values(store.records || {})) {
        if (rec?.textHash && Array.isArray(rec.vector) && rec.vector.length) {
          store.hashArchive[rec.textHash] = rec.vector;
        }
      }
      let restoredFromArchive = 0;
      const pending = items.filter(item => {
        const existing = store.records[item.key];
        if (!options.forceRebuild && !modelChanged && existing && existing.textHash === item.textHash
            && Array.isArray(existing.vector) && existing.vector.length) {
          return false;
        }
        if (!options.forceRebuild && !modelChanged && Array.isArray(store.hashArchive[item.textHash]) && store.hashArchive[item.textHash].length) {
          const archived = store.hashArchive[item.textHash];
          store.dimensions = archived.length;
          store.records[item.key] = {
            key: item.key,
            kind: item.kind,
            ...(item.entityType ? { entityType: item.entityType } : {}),
            refId: item.refId,
            label: item.label,
            text: item.text,
            textHash: item.textHash,
            vector: archived,
            updatedAt: Date.now()
          };
          restoredFromArchive++;
          return false;
        }
        return true;
      });

      if ((pruned > 0 || restoredFromArchive > 0) && !pending.length) {
        store.embeddingModel = embCfg.model;
        saveVectorStore(store, chatId);
      }
      if (!pending.length) {
        maintainStatus = { running: false, current: items.length, total: items.length, message: '全部向量均已是最新，无需重复请求' };
        options.onProgress?.(maintainStatus);
        return { updated: 0, pruned, total: items.length, skipped: true };
      }

      maintainRunning = true;
      abortController = new AbortController();
      let updated = 0;
      try {
        store.embeddingModel = embCfg.model;
        for (let i = 0; i < pending.length; i += BATCH_SIZE) {
          if (abortController.signal.aborted || getChatId() !== chatId) break;
          const batch = pending.slice(i, i + BATCH_SIZE);
          maintainStatus = {
            running: true,
            current: updated,
            total: pending.length,
            message: `正在计算向量 ${updated}/${pending.length}…`
          };
          options.onProgress?.(maintainStatus);
          const vectors = await window.WORLD_ENGINE_API.callEmbeddingApi(
            batch.map(item => item.text),
            embCfg,
            abortController.signal
          );
          if (abortController.signal.aborted || getChatId() !== chatId) break;
          batch.forEach((item, idx) => {
            const norm = normalizeVector(vectors[idx]);
            if (!norm.length) return;
            store.dimensions = norm.length;
            store.hashArchive[item.textHash] = norm;
            store.records[item.key] = {
              key: item.key,
              kind: item.kind,
              ...(item.entityType ? { entityType: item.entityType } : {}),
              refId: item.refId,
              label: item.label,
              text: item.text,
              textHash: item.textHash,
              vector: norm,
              updatedAt: Date.now()
            };
            updated++;
          });
          // 每完成一批立即落盘（防断电/手动停止后重复计费）
          saveVectorStore(store, chatId);
        }
        maintainStatus = {
          running: false,
          current: updated,
          total: pending.length,
          message: abortController.signal.aborted ? `已中止，已保留已完成 ${updated} 条向量` : `向量维护完成：新增/更新 ${updated} 条`
        };
        options.onProgress?.(maintainStatus);
        return { updated, pruned, total: items.length };
      } finally {
        maintainRunning = false;
        abortController = null;
      }
    };

    const p = runMaintain();
    activeMaintainPromise = p;
    try {
      return await p;
    } finally {
      if (activeMaintainPromise === p) activeMaintainPromise = null;
    }
  }

  async function embedQueryCached(queryText, embCfg, chatId, signal) {
    const queryHash = hashText(queryText);
    if (lastQueryVector.chatId === chatId && lastQueryVector.model === embCfg.model
        && lastQueryVector.url === embCfg.apiUrl && lastQueryVector.queryHash === queryHash
        && Array.isArray(lastQueryVector.vector) && lastQueryVector.vector.length) {
      return lastQueryVector.vector;
    }
    const vectors = await window.WORLD_ENGINE_API.callEmbeddingApi([queryText], embCfg, signal);
    const norm = normalizeVector(vectors[0]);
    if (!norm.length) throw new Error('Query 向量返回为空');
    lastQueryVector = { chatId, model: embCfg.model, url: embCfg.apiUrl, queryHash, vector: norm };
    return norm;
  }

  async function recallForQuery(queryText, options = {}) {
    const st = settings();
    if (st.engineEnabled === false || st.vectorEnabled !== true) return null;
    const query = clean(queryText);
    if (!query) return null;
    const embCfg = embeddingConfig(st);
    if (!embCfg.apiUrl || !embCfg.model) return null;
    if (recallRunning && !options.force) return lastRecallCache;

    const chatId = getChatId();
    const state = options.state || window.MEMORY_ENGINE_DATA?.loadState?.();
    if (options.autoMaintain !== false && st.vectorAutoMaintain !== false && !maintainRunning) {
      try { await maintainVectors({ state }); } catch (err) { console.warn('[记忆检索] 自动增量向量维护失败（已隔离）', err); }
    }
    const store = loadVectorStore(chatId);
    const entries = Object.values(store.records || {}).filter(entry => Array.isArray(entry?.vector) && entry.vector.length);
    if (!entries.length) return null;

    recallRunning = true;
    const localAbort = new AbortController();
    const activeAbort = abortController || localAbort;
    try {
      const queryVec = await embedQueryCached(query, embCfg, chatId, activeAbort.signal);
      if (getChatId() !== chatId) return null;

      const minCosine = Number.isFinite(Number(st.vectorThreshold)) ? Number(st.vectorThreshold) : 0.3;
      const topK = Math.max(1, parseInt(st.vectorTopK, 10) || 12);
      const queryTokens = tokenizeHybridText(query);
      const rerankWeight = Number.isFinite(Number(st.rerankHybridWeight))
        ? Math.max(0, Math.min(1, Number(st.rerankHybridWeight))) : 0.75;
      const scoredEntries = entries
        .filter(entry => entry.vector.length === queryVec.length)
        .map(entry => {
          const cosineScore = Math.max(0, dotProduct(queryVec, entry.vector));
          const lexicalScore = computeLexicalOverlap(queryTokens, entry.text);
          const denseLexicalScore = Math.min(1, cosineScore + lexicalScore * 0.15);
          return {
            entry,
            cosineScore,
            lexicalScore,
            denseLexicalScore,
            coarseScore: cosineScore + lexicalScore * 0.18
          };
        });
      const cosineDistribution = computeScoreDistribution(scoredEntries.map(item => item.cosineScore));
      const vectorCandidates = scoredEntries
        .filter(item => item.cosineScore >= minCosine || item.lexicalScore >= 0.35)
        .sort((a, b) => b.coarseScore - a.coarseScore)
        .slice(0, topK);

      if (!vectorCandidates.length) {
        lastRecallCache = {
          chatId,
          queryHash: hashText(query),
          method: 'embedding',
          timestamp: Date.now(),
          hits: [],
          diagnostics: {
            totalIndexed: scoredEntries.length,
            candidateCount: 0,
            lexicalGuardCount: 0,
            rerankWeight,
            similarity_distribution: cosineDistribution,
            candidateCosineDistribution: computeScoreDistribution([]),
            rerankDistribution: null,
            finalDistribution: computeScoreDistribution([])
          },
          smallScores: {},
          factScores: {},
          personScores: {},
          entityScores: {}
        };
        if (options.apply !== false) window.MEMORY_ENGINE?.applyInjection?.();
        return lastRecallCache;
      }

      let method = 'embedding';
      let lexicalGuardCount = 0;
      let rerankDistribution = null;
      let finalHits = vectorCandidates.map(item => ({
        key: item.entry.key,
        kind: item.entry.kind,
        entityType: item.entry.entityType || '',
        refId: item.entry.refId,
        label: item.entry.label,
        text: item.entry.text,
        cosineScore: Number(item.cosineScore.toFixed(4)),
        lexicalScore: Number(item.lexicalScore.toFixed(4)),
        rerankScore: null,
        lexicalGuardKept: false,
        score: Number(item.denseLexicalScore.toFixed(4))
      })).sort((a, b) => b.score - a.score);

      const rCfg = rerankConfig(st);
      if (st.rerankEnabled === true && rCfg.apiUrl && rCfg.model && typeof window.WORLD_ENGINE_API?.callRerankApi === 'function') {
        try {
          const reranked = await window.WORLD_ENGINE_API.callRerankApi(
            query,
            vectorCandidates.map(item => item.entry.text),
            rCfg,
            activeAbort.signal
          );
          if (getChatId() !== chatId) return null;
          rerankDistribution = computeScoreDistribution(reranked.map(item => item.score));
          const minRerank = Number.isFinite(Number(st.rerankThreshold)) ? Number(st.rerankThreshold) : 0.2;
          const filtered = reranked
            .map(item => {
              const cand = vectorCandidates[item.index];
              if (!cand) return null;
              const passThreshold = item.score >= minRerank;
              const guardKept = !passThreshold && cand.lexicalScore >= 0.55 && item.score >= minRerank * 0.5;
              if (!passThreshold && !guardKept) return null;
              if (guardKept) lexicalGuardCount++;
              const blended = rerankWeight * item.score + (1 - rerankWeight) * cand.denseLexicalScore;
              return {
                key: cand.entry.key,
                kind: cand.entry.kind,
                entityType: cand.entry.entityType || '',
                refId: cand.entry.refId,
                label: cand.entry.label,
                text: cand.entry.text,
                cosineScore: Number(cand.cosineScore.toFixed(4)),
                lexicalScore: Number(cand.lexicalScore.toFixed(4)),
                rerankScore: Number(item.score.toFixed(4)),
                lexicalGuardKept: guardKept,
                score: Number(Math.min(1, Math.max(0, blended)).toFixed(4))
              };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score)
            .slice(0, rCfg.topN);
          if (filtered.length) {
            finalHits = filtered;
            method = 'embedding+rerank';
          }
        } catch (rerankErr) {
          console.warn('[记忆检索] Rerank 重排失败，优雅降级为 Embedding 余弦+词法混合排序', rerankErr);
        }
      }

      const smallScores = {}, factScores = {}, personScores = {}, entityScores = {};
      for (const hit of finalHits) {
        if (hit.kind === 'small') smallScores[hit.refId] = hit.score;
        else if (hit.kind === 'fact') factScores[hit.refId] = hit.score;
        else if (hit.kind === 'person') personScores[hit.refId] = hit.score;
        else if (hit.kind === 'entity') entityScores[`${hit.entityType}:${hit.refId}`] = hit.score;
      }

      lastRecallCache = {
        chatId,
        queryHash: hashText(query),
        method,
        timestamp: Date.now(),
        hits: finalHits,
        diagnostics: {
          totalIndexed: scoredEntries.length,
          candidateCount: vectorCandidates.length,
          lexicalGuardCount,
          rerankWeight,
          similarity_distribution: cosineDistribution,
          candidateCosineDistribution: computeScoreDistribution(vectorCandidates.map(c => c.cosineScore)),
          rerankDistribution,
          finalDistribution: computeScoreDistribution(finalHits.map(h => h.score))
        },
        smallScores,
        factScores,
        personScores,
        entityScores
      };
      if (options.apply !== false) window.MEMORY_ENGINE?.applyInjection?.();
      return lastRecallCache;
    } finally {
      recallRunning = false;
    }
  }

  function getRecallScoresForInjection() {
    const st = settings();
    if (st.engineEnabled === false || st.vectorEnabled !== true) return null;
    const id = getChatId();
    if (!lastRecallCache || lastRecallCache.chatId !== id) return null;
    return lastRecallCache;
  }

  function abort() {
    abortController?.abort();
  }

  function exportVectorData() {
    const id = getChatId();
    const store = loadVectorStore(id);
    return {
      __memoryVectorData: true,
      format: 'memory-vector-index',
      version: 1,
      exportedAt: new Date().toISOString(),
      chatId: id,
      count: Object.keys(store.records || {}).length,
      store
    };
  }

  function importVectorData(payload, options = {}) {
    if (maintainRunning || recallRunning || options.isBusy?.() === true) {
      throw new Error('记忆或向量任务运行中，暂不能导入向量文件');
    }
    const targetChat = clean(options.expectedChatId);
    const id = getChatId();
    if (targetChat && targetChat !== id) {
      throw new Error('导入前聊天身份已切换，已取消写入以防串台');
    }
    if (!payload || typeof payload !== 'object' || payload.__memoryVectorData !== true
        || payload.format !== 'memory-vector-index' || !payload.store || typeof payload.store.records !== 'object') {
      throw new Error('向量文件格式无效：仅接受标准 memory-vector-index JSON');
    }
    const currentModel = clean(settings().embeddingModel);
    const incomingModel = clean(payload.store.embeddingModel);
    if (currentModel && incomingModel && currentModel !== incomingModel && options.allowModelMismatch !== true) {
      throw new Error(`向量文件模型 (${incomingModel}) 与当前设置 (${currentModel}) 不匹配`);
    }
    const saved = saveVectorStore({
      ...payload.store,
      chatId: id
    }, id);
    lastRecallCache = null;
    lastQueryVector = { chatId: '', model: '', url: '', queryHash: '', vector: null };
    return saved;
  }

  return {
    getStats,
    loadVectorStore,
    saveVectorStore,
    clearVectorCache,
    pruneVectorsForState,
    collectVectorizableItems,
    maintainVectors,
    recallForQuery,
    getRecallScoresForInjection,
    exportVectorData,
    importVectorData,
    abort,
    isRunning: () => maintainRunning || recallRunning,
    getStatus: () => ({ ...maintainStatus, maintainRunning, recallRunning }),
    _test: { normalizeVector, dotProduct, hashText, tokenizeHybridText, computeLexicalOverlap, computeScoreDistribution }
  };
})();
