// outline-engine-settings.js — 剧情大纲 v3 独立设置（不共享世界/记忆配置值，精简去繁）
window.OUTLINE_ENGINE_SETTINGS = (function() {
  'use strict';

  const STORAGE_KEY = 'outline_engine_settings';
  const VERSION = '3.0.0';
  const DEFAULTS = Object.freeze({
    // 独立 API 配置
    apiUrl: '',
    apiKey: '',
    model: 'gpt-3.5-turbo',
    connectionMode: 'direct',
    temperature: 0.2,
    maxTokens: 8192,
    apiTimeoutMs: 120000,
    stream: false,
    streamIdleTimeoutMs: 90000,
    jsonMode: false,
    topP: null,
    reasoningEffort: '',
    apiAutoRetries: 0,
    formatMaxRetries: 2,
    // 核心与检查节奏
    engineEnabled: false,
    firstLayerIsAiOpening: true,
    autoCheck: true,
    checkEveryX: 3,
    // 前台与后台注入控制
    injectIntoPrompt: true,
    injectPosition: 1,
    injectDepth: 1,
    injectMaxChars: 2000,
    narrativeLimit: 4,
    // 弱联动（只读参考，互不阻塞）
    injectIntoWorldEngine: true,
    worldInjectMaxChars: 2000,
    useWorldReference: true,
    injectIntoMemoryEngine: true,
    useMemoryReference: true,
    // 聊天元数据同步与自动快照
    syncToChat: false,
    autoBackup: false
  });

  let cached = null;

  function clampInt(value, fallback, min, max) {
    if (value === '' || value === null || value === undefined) return fallback;
    const num = parseInt(value, 10);
    return Math.min(max, Math.max(min, Number.isFinite(num) ? num : fallback));
  }

  function clampFloat(value, fallback, min, max) {
    if (value === '' || value === null || value === undefined) return fallback;
    const num = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(num) ? num : fallback));
  }

  function normalizeSettings(raw) {
    const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
    const topP = merged.topP !== '' && merged.topP !== null && merged.topP !== undefined && Number.isFinite(Number(merged.topP))
      ? clampFloat(merged.topP, 1, 0, 1)
      : null;
    const effort = String(merged.reasoningEffort || '').trim().toLowerCase();
    return {
      apiUrl: String(merged.apiUrl || '').trim(),
      apiKey: String(merged.apiKey || '').trim(),
      model: String(merged.model || DEFAULTS.model).trim() || DEFAULTS.model,
      connectionMode: merged.connectionMode === 'proxy' ? 'proxy' : 'direct',
      temperature: clampFloat(merged.temperature, DEFAULTS.temperature, 0, 2),
      maxTokens: clampInt(merged.maxTokens, DEFAULTS.maxTokens, 1, 1000000),
      apiTimeoutMs: clampInt(merged.apiTimeoutMs, DEFAULTS.apiTimeoutMs, 0, 3600000),
      stream: merged.stream === true,
      streamIdleTimeoutMs: clampInt(merged.streamIdleTimeoutMs, DEFAULTS.streamIdleTimeoutMs, 0, 3600000),
      jsonMode: merged.jsonMode === true,
      topP,
      reasoningEffort: ['low', 'medium', 'high', 'minimal', 'none'].includes(effort) ? effort : '',
      apiAutoRetries: clampInt(merged.apiAutoRetries, DEFAULTS.apiAutoRetries, 0, 10),
      formatMaxRetries: clampInt(merged.formatMaxRetries, DEFAULTS.formatMaxRetries, 0, 5),
      engineEnabled: merged.engineEnabled === true,
      firstLayerIsAiOpening: merged.firstLayerIsAiOpening !== false,
      autoCheck: merged.autoCheck !== false,
      checkEveryX: clampInt(merged.checkEveryX, DEFAULTS.checkEveryX, 1, 1000),
      injectIntoPrompt: merged.injectIntoPrompt !== false,
      injectPosition: [0, 1, 2].includes(Number(merged.injectPosition)) ? Number(merged.injectPosition) : 1,
      injectDepth: clampInt(merged.injectDepth, DEFAULTS.injectDepth, 0, 20),
      injectMaxChars: clampInt(merged.injectMaxChars, DEFAULTS.injectMaxChars, 200, 20000),
      narrativeLimit: clampInt(merged.narrativeLimit, DEFAULTS.narrativeLimit, 1, 20),
      injectIntoWorldEngine: merged.injectIntoWorldEngine !== false,
      worldInjectMaxChars: clampInt(merged.worldInjectMaxChars, DEFAULTS.worldInjectMaxChars, 300, 10000),
      useWorldReference: merged.useWorldReference !== false,
      injectIntoMemoryEngine: merged.injectIntoMemoryEngine !== false,
      useMemoryReference: merged.useMemoryReference !== false,
      syncToChat: merged.syncToChat === true,
      autoBackup: merged.autoBackup === true
    };
  }

  function readStored() {
    try {
      const raw = window.WORLD_ENGINE_STORE?.getItem?.(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      console.warn('[剧情大纲] 读取设置失败，使用默认值', error);
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
    window.WORLD_ENGINE_STORE?.setItem?.(STORAGE_KEY, JSON.stringify(cached));
    return { ...cached };
  }

  function patchSettings(patch) {
    return saveSettings({ ...getSettings(true), ...(patch || {}) });
  }

  return { STORAGE_KEY, VERSION, DEFAULTS, getSettings, saveSettings, patchSettings };
})();
