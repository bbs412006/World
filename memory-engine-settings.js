// memory-engine-settings.js — 记忆引擎独立设置（只复用 API/调度等实现，不共享配置值）
window.MEMORY_ENGINE_SETTINGS = (function() {
  const STORAGE_KEY = 'memory_engine_settings';
  const VERSION = '1.3.0';
  const DEFAULTS = Object.freeze({
    apiUrl: '',
    apiKey: '',
    model: 'gpt-3.5-turbo',
    connectionMode: 'direct',
    temperature: 0.2,
    maxTokens: 65000,
    apiTimeoutMs: 120000,
    stream: false,
    streamIdleTimeoutMs: 90000,
    jsonMode: false,
    topP: null,
    reasoningEffort: '',
    engineEnabled: true,
    firstLayerIsAiOpening: true,
    evolveMode: 'auto',
    evolveEveryX: 1,
    evolveReadRounds: 1,
    manualReadRounds: 1,
    smallSummaryEveryX: 1,
    smallSummaryMinChars: 500,
    smallSummaryInjectLimit: 8,
    skipCurrentFloorSummary: false,
    summaryDelayFloors: 0,
    autoRefillOnHistoryChange: true,
    hideCoveredRawText: true,
    recentRawRounds: 1,
    referenceRawRounds: 1,
    referenceSmallSummaryCount: 5,
    injectIntoPrompt: true,
    injectIntoWorldEngine: false,
    worldEngineMemoryLimit: 5,
    acceptWorldHint: true,
    injectIntoOutlineEngine: true,
    acceptOutlineSync: true,
    searchDepth: 5,
    maxPerCharacter: 20,
    memoryInjectMaxChars: 3500,
    recallArchivedSmallLimit: 3,
    injectOngoingFactsLimit: 15,
    injectCharacterArcsLimit: 6,
    enableFactAndArcExtraction: true,
    worldLinkMode: 'lightweight',
    coordinationMode: 'stagger-serial',
    vectorEnabled: false,
    vectorAutoMaintain: true,
    embeddingApiUrl: '',
    embeddingApiKey: '',
    embeddingModel: 'BAAI/bge-m3',
    rerankEnabled: false,
    rerankApiUrl: '',
    rerankApiKey: '',
    rerankModel: 'BAAI/bge-reranker-v2-m3',
    vectorTopK: 12,
    vectorThreshold: 0.3,
    rerankTopK: 5,
    rerankThreshold: 0.2,
    rerankHybridWeight: 0.75,
    embeddingTimeoutMs: 60000,
    rerankTimeoutMs: 60000,
    vectorIncludeArchivedSmall: true,
    vectorIncludeFacts: true,
    vectorIncludePersonalAndEntity: true,
    injectionDiceSides: 10000,
    apiAutoRetries: 0,
    nameBlacklist: '',
    filterRegex: '',
    tonePrompt: '',
    worldbookEnabled: false,
    worldbookTrigger: false,
    syncToChat: false,
    autoBackup: false,
    backfillBatchSize: 5,
    summaryBackfillSmallEveryX: 5,
    backfillRetries: 2,
    backfillStartLayer: 0,
    backfillEndLayer: 0
  });

  let cached = null;

  function clampInt(value, fallback, min, max) {
    const num = parseInt(value, 10);
    const parsed = Number.isFinite(num) ? num : fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function clampFloat(value, fallback, min, max) {
    const num = Number(value);
    const parsed = Number.isFinite(num) ? num : fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  // 人物与实体记忆保持每轮可重放提取；纪要批量间隔（smallSummaryEveryX）与延迟楼层允许独立配置。
  function normalizeSettings(value) {
    const merged = { ...DEFAULTS, ...(value || {}) };
    const savedMaxTokens = Math.max(1, parseInt(merged.maxTokens) || 65000);
    return {
      ...merged,
      // 旧版部分预设把输出上限保存成 4096；升级后自动迁移，避免继续截断 API 返回。
      maxTokens: savedMaxTokens === 4096 ? 65000 : savedMaxTokens,
      stream: merged.stream === true,
      streamIdleTimeoutMs: clampInt(merged.streamIdleTimeoutMs, 90000, 0, 3600000),
      jsonMode: merged.jsonMode === true,
      topP: (merged.topP !== '' && merged.topP != null && Number.isFinite(Number(merged.topP)))
        ? clampFloat(merged.topP, 1, 0, 1)
        : null,
      reasoningEffort: ['low', 'medium', 'high', 'minimal', 'none'].includes(String(merged.reasoningEffort || '').trim().toLowerCase())
        ? String(merged.reasoningEffort).trim().toLowerCase()
        : '',
      evolveEveryX: 1,
      evolveReadRounds: 1,
      manualReadRounds: 1,
      smallSummaryEveryX: clampInt(merged.smallSummaryEveryX, 1, 1, 20),
      smallSummaryMinChars: clampInt(merged.smallSummaryMinChars, 500, 50, 5000),
      smallSummaryInjectLimit: clampInt(merged.smallSummaryInjectLimit, 8, 0, 50),
      skipCurrentFloorSummary: merged.skipCurrentFloorSummary === true,
      summaryDelayFloors: clampInt(merged.summaryDelayFloors, 0, 0, 10),
      autoRefillOnHistoryChange: merged.autoRefillOnHistoryChange !== false,
      recentRawRounds: clampInt(merged.recentRawRounds, 1, 0, 50),
      referenceRawRounds: clampInt(merged.referenceRawRounds, 1, 0, 20),
      referenceSmallSummaryCount: clampInt(merged.referenceSmallSummaryCount, 5, 0, 50),
      backfillStartLayer: clampInt(merged.backfillStartLayer, 0, 0, 100000),
      backfillEndLayer: clampInt(merged.backfillEndLayer, 0, 0, 100000),
      summaryBackfillSmallEveryX: clampInt(merged.summaryBackfillSmallEveryX, 5, 1, 50),
      memoryInjectMaxChars: clampInt(merged.memoryInjectMaxChars, 3500, 500, 20000),
      recallArchivedSmallLimit: clampInt(merged.recallArchivedSmallLimit, 3, 0, 10),
      injectOngoingFactsLimit: clampInt(merged.injectOngoingFactsLimit, 15, 0, 50),
      injectCharacterArcsLimit: clampInt(merged.injectCharacterArcsLimit, 6, 0, 30),
      enableFactAndArcExtraction: merged.enableFactAndArcExtraction !== false,
      worldLinkMode: merged.worldLinkMode === 'llm' ? 'llm' : 'lightweight',
      coordinationMode: merged.coordinationMode === 'independent' ? 'independent' : 'stagger-serial',
      acceptWorldHint: merged.acceptWorldHint !== false,
      injectIntoOutlineEngine: merged.injectIntoOutlineEngine !== false,
      acceptOutlineSync: merged.acceptOutlineSync !== false,
      vectorEnabled: merged.vectorEnabled === true,
      vectorAutoMaintain: merged.vectorAutoMaintain !== false,
      embeddingApiUrl: String(merged.embeddingApiUrl ?? '').trim(),
      embeddingApiKey: String(merged.embeddingApiKey ?? '').trim(),
      embeddingModel: String(merged.embeddingModel || 'BAAI/bge-m3').trim(),
      rerankEnabled: merged.rerankEnabled === true,
      rerankApiUrl: String(merged.rerankApiUrl ?? '').trim(),
      rerankApiKey: String(merged.rerankApiKey ?? '').trim(),
      rerankModel: String(merged.rerankModel || 'BAAI/bge-reranker-v2-m3').trim(),
      vectorTopK: clampInt(merged.vectorTopK, 12, 1, 50),
      vectorThreshold: clampFloat(merged.vectorThreshold, 0.3, 0, 1),
      rerankTopK: clampInt(merged.rerankTopK, 5, 1, 20),
      rerankThreshold: clampFloat(merged.rerankThreshold, 0.2, 0, 1),
      rerankHybridWeight: clampFloat(merged.rerankHybridWeight, 0.75, 0, 1),
      embeddingTimeoutMs: clampInt(merged.embeddingTimeoutMs, 60000, 3000, 600000),
      rerankTimeoutMs: clampInt(merged.rerankTimeoutMs, 60000, 3000, 600000),
      vectorIncludeArchivedSmall: merged.vectorIncludeArchivedSmall !== false,
      vectorIncludeFacts: merged.vectorIncludeFacts !== false,
      vectorIncludePersonalAndEntity: merged.vectorIncludePersonalAndEntity !== false
    };
  }

  function readStored() {
    try {
      const raw = window.WORLD_ENGINE_STORE?.getItem(STORAGE_KEY);
      if (!raw) {
        // test 分支早期版本曾把 memory* 字段误放进 world_engine_settings；仅首次读取时迁移。
        const worldRaw = window.WORLD_ENGINE_STORE?.getItem('world_engine_settings');
        const world = worldRaw ? JSON.parse(worldRaw) : {};
        const migrated = {
          evolveMode: world.memoryEvolveMode,
          evolveEveryX: world.memoryEvolveEveryX,
          evolveReadRounds: world.memoryEvolveReadRounds,
          manualReadRounds: world.memoryManualReadRounds,
          injectIntoPrompt: world.memoryInjectIntoPrompt,
          searchDepth: world.memorySearchDepth,
          maxPerCharacter: world.memoryMaxPerCharacter,
          worldbookEnabled: world.memoryWorldbookEnabled,
          backfillBatchSize: world.memoryBackfillBatchSize,
          backfillRetries: world.memoryBackfillRetries,
          backfillEndLayer: world.memoryBackfillEndLayer
        };
        const clean = Object.fromEntries(Object.entries(migrated).filter(([, value]) => value !== undefined));
        if (Object.keys(clean).length) return clean;
      }
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      console.warn('[记忆引擎] 读取设置失败，使用默认值', error);
      return {};
    }
  }

  function getSettings(forceRefresh) {
    if (forceRefresh) cached = null;
    if (!cached) cached = normalizeSettings(readStored());
    return { ...cached };
  }

  function saveSettings(next) {
    cached = normalizeSettings(next);
    window.WORLD_ENGINE_STORE?.setItem(STORAGE_KEY, JSON.stringify(cached));
    return { ...cached };
  }

  function patchSettings(patch) {
    return saveSettings({ ...getSettings(true), ...(patch || {}) });
  }

  return {
    STORAGE_KEY,
    VERSION,
    DEFAULTS,
    getSettings,
    saveSettings,
    patchSettings
  };
})();
