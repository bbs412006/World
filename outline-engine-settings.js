// 剧情大纲使用独立配置；复用世界 API 实现时不覆盖世界引擎的配置。
window.OUTLINE_ENGINE_SETTINGS = (function() {
  const STORAGE_KEY = 'outline_engine_settings';
  const VERSION = '2.1.0';
  const DEFAULTS = Object.freeze({
    engineEnabled: false,
    apiSource: 'world',
    autoCheck: true,
    checkEveryX: 3,
    allowProposals: true,
    firstLayerIsAiOpening: true,
    injectIntoPrompt: true,
    injectIntoWorldEngine: true,
    injectMaxChars: 2500,
    narrativeLimit: 3,
    worldLimit: 3,
    cooldownTicks: 1,
    syncToChat: false,
    autoBackup: false,
    apiUrl: '',
    apiKey: '',
    model: 'gpt-3.5-turbo',
    connectionMode: 'direct',
    temperature: 0.2,
    maxTokens: 8192,
    apiTimeoutMs: 120000,
    apiAutoRetries: 0
  });
  let cached = null;
  const integer = (value, fallback, minimum, maximum) => {
    const number = parseInt(value, 10);
    return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? number : fallback));
  };
  function normalize(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const next = { ...DEFAULTS, ...source };
    next.engineEnabled = next.engineEnabled === true;
    next.apiSource = next.apiSource === 'custom' ? 'custom' : 'world';
    for (const key of ['autoCheck', 'allowProposals', 'firstLayerIsAiOpening', 'injectIntoPrompt', 'injectIntoWorldEngine']) next[key] = next[key] !== false;
    next.syncToChat = next.syncToChat === true;
    next.autoBackup = next.autoBackup === true;
    next.checkEveryX = integer(next.checkEveryX, 3, 1, 1000);
    next.injectMaxChars = integer(next.injectMaxChars, 2500, 200, 20000);
    next.narrativeLimit = integer(next.narrativeLimit, 3, 1, 20);
    next.worldLimit = integer(next.worldLimit, 3, 1, 20);
    next.cooldownTicks = integer(next.cooldownTicks, 1, 0, 100);
    next.maxTokens = integer(next.maxTokens, 8192, 1, 1000000);
    next.apiTimeoutMs = integer(next.apiTimeoutMs, 120000, 0, 3600000);
    next.apiAutoRetries = integer(next.apiAutoRetries, 0, 0, 10);
    next.temperature = Number.isFinite(Number(next.temperature)) ? Math.max(0, Math.min(2, Number(next.temperature))) : 0.2;
    next.connectionMode = next.connectionMode === 'proxy' ? 'proxy' : 'direct';
    for (const key of ['apiUrl', 'apiKey', 'model']) next[key] = String(next[key] == null ? '' : next[key]).trim();
    return next;
  }
  function getSettings(forceRefresh) {
    if (forceRefresh) cached = null;
    if (!cached) {
      let value = {};
      try { value = JSON.parse(window.WORLD_ENGINE_STORE?.getItem(STORAGE_KEY) || '{}'); }
      catch (_) { /* 损坏设置只影响大纲，使用默认配置。 */ }
      cached = normalize(value);
    }
    return { ...cached };
  }
  function saveSettings(value) {
    cached = normalize(value);
    window.WORLD_ENGINE_STORE?.setItem(STORAGE_KEY, JSON.stringify(cached));
    return { ...cached };
  }
  function patchSettings(patch) { return saveSettings({ ...getSettings(true), ...(patch || {}) }); }
  return { STORAGE_KEY, VERSION, DEFAULTS, getSettings, saveSettings, patchSettings };
})();
