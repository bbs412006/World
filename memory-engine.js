// memory-engine.js — 记忆引擎（对齐 shujuku 核心 7 表、单表水位线、Wave 波次追平、带错纠错重试与同步删楼回退）
window.MEMORY_ENGINE = (function() {
  'use strict';

  const INJECTION_NAME = 'memory-engine-memory';
  const MUTATION_TRAILING_MS = 1200;
  const MUTATION_MAX_WAIT_MS = 3000;

  let initialized = false;
  let running = false;
  let backfillRunning = false;
  let reconciling = false;
  let generationActive = false;
  let abortController = null;
  let autoTimer = null;
  let lastEventKey = '';
  let lastError = '';
  let runningLabel = '';
  let lastDebug = null;
  let lastInjectionDebug = null;
  let hiddenSyncPromise = Promise.resolve();
  let backfillStatus = { running: false, current: 0, total: 0, message: '' };
  let summaryBackfillStatus = { running: false, current: 0, total: 0, message: '' };

  // 事件代次锁（对齐 shujuku Epoch Lease）与删/滑/改楼防抖调度状态
  let autoFillEpoch = 0;
  let mutationGeneration = 0;
  let mutationTimer = null;
  let mutationFirstAt = 0;
  let mutationRunning = false;
  let mutationPending = false;
  let mutationReason = '';
  let mutationRefillRequested = false;

  const clean = value => String(value == null ? '' : value).trim();
  const normalized = value => clean(value).toLocaleLowerCase();
  const unique = values => Array.from(new Set((Array.isArray(values) ? values : [values]).map(clean).filter(Boolean)));
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function context() {
    try { return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null; }
    catch (_) { return null; }
  }
  function chat() {
    const list = context()?.chat;
    return Array.isArray(list) ? list : [];
  }
  function data() { return window.MEMORY_ENGINE_DATA; }
  function settings() { return window.MEMORY_ENGINE_SETTINGS?.getSettings?.(true) || {}; }
  function promptApi() { return window.MEMORY_ENGINE_PROMPT; }
  function timelineApi() { return window.MEMORY_ENGINE_TIMELINE; }
  function tableKeys() { return data()?.TABLE_KEYS || ['global_state', 'protagonist_info', 'important_characters', 'protagonist_skills', 'inventory', 'quests_events', 'chronicle']; }
  function tableSchemas() { return data()?.TABLE_SCHEMAS || {}; }
  function bumpAutoFillEpoch() { return ++autoFillEpoch; }

  function formatLayerSpan(startLayer, endLayer, sep = '-') {
    const s = Number.isFinite(Number(startLayer)) ? Number(startLayer) : 0;
    const e = Number.isFinite(Number(endLayer)) ? Number(endLayer) : s;
    return s === e ? String(e) : `${s}${sep}${e}`;
  }

  // 对齐 shujuku message-handler：剔除用户消息、系统旁白（narrator）与工具调用空楼
  function isFillEligibleAiMessage(message) {
    if (!message || typeof message !== 'object') return false;
    if (message.is_user === true) return false;
    if (message.extra?.type === 'narrator') return false;
    if (message.is_system === true && Array.isArray(message.extra?.tool_invocations)) return false;
    return true;
  }

  function ignoreFirstLayer(stOverride) {
    const st = stOverride || settings();
    return st.firstLayerIsAiOpening !== false;
  }

  function currentLayer() {
    const all = chat();
    return all.length ? all.length - 1 : 0;
  }

  function collectEligibleAiLayers(stOverride, startLayer, endLayer) {
    const st = stOverride || settings();
    const all = chat();
    if (!all.length) return [];
    const minStart = ignoreFirstLayer(st) ? 1 : 0;
    const lo = Math.max(minStart, Number.isFinite(Number(startLayer)) ? Number(startLayer) : minStart);
    const hi = Math.min(all.length - 1, Number.isFinite(Number(endLayer)) ? Number(endLayer) : all.length - 1);
    const out = [];
    for (let i = lo; i <= hi; i++) {
      if (isFillEligibleAiMessage(all[i])) out.push(i);
    }
    return out;
  }

  function getEffectiveSummaryDelay(stOverride) {
    const st = stOverride || settings();
    const rawDelay = Math.max(0, parseInt(st.summaryDelayFloors, 10) || 0);
    return st.skipCurrentFloorSummary === true ? Math.max(1, rawDelay) : rawDelay;
  }

  function stableAutoEndLayer(stOverride) {
    const st = stOverride || settings();
    const delayFloors = getEffectiveSummaryDelay(st);
    const allAi = collectEligibleAiLayers(st);
    if (!allAi.length) return -1;
    if (delayFloors <= 0) return allAi[allAi.length - 1];
    if (allAi.length <= delayFloors) return -1;
    return allAi[allAi.length - 1 - delayFloors];
  }

  function setExternalStatus(text, isError) {
    try { window.__WE_SetExternalStatus?.(text, Boolean(isError)); } catch (_) {}
  }

  function setRunningUI(active, label) {
    running = Boolean(active);
    runningLabel = active ? clean(label) : '';
    try { window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(running || backfillRunning || reconciling, runningLabel); } catch (_) {}
  }

  function refreshMemoryPanel() {
    try { window.WORLD_ENGINE_UI?.refresh?.(); } catch (_) {}
  }

  function setBackfillStatus(current, total, message) {
    backfillStatus = { running: backfillRunning, current, total, message: message || '' };
    if (typeof document !== 'undefined') {
      const el = document.getElementById('we-memory-person-backfill-status');
      if (el) el.textContent = backfillStatus.message;
    }
  }

  function setSummaryBackfillStatus(current, total, message) {
    summaryBackfillStatus = { running: backfillRunning, current, total, message: message || '' };
    if (typeof document !== 'undefined') {
      for (const id of ['we-memory-home-fill-status', 'we-memory-core-status', 'we-memory-summary-backfill-status', 'we-memory-minutes-action-status']) {
        const el = document.getElementById(id);
        if (el) el.textContent = summaryBackfillStatus.message;
      }
    }
  }

  function filterText(text, stOverride) {
    const st = stOverride || settings();
    let out = String(text == null ? '' : text);
    const rawRegex = clean(st.filterRegex);
    if (rawRegex && window.WORLD_ENGINE_CORE?.applyFilterRegex) {
      try { out = window.WORLD_ENGINE_CORE.applyFilterRegex(out, rawRegex); } catch (_) {}
    } else if (rawRegex) {
      for (const line of rawRegex.split('\n').map(clean).filter(Boolean)) {
        try {
          const m = line.match(/^\/(.+)\/([gimsuy]*)$/);
          const re = m ? new RegExp(m[1], m[2] || 'g') : new RegExp(line, 'g');
          out = out.replace(re, '');
        } catch (_) {}
      }
    }
    return out.trim();
  }

  function formatConversationSlice(startLayer, endLayer, stOverride) {
    const all = chat();
    const st = stOverride || settings();
    const lines = [];
    for (let i = Math.max(0, startLayer); i <= Math.min(all.length - 1, endLayer); i++) {
      const msg = all[i];
      if (!msg) continue;
      if (!msg.is_user && !isFillEligibleAiMessage(msg)) continue;
      const speaker = msg.is_user ? (clean(msg.name) || '用户') : (clean(msg.name) || '角色');
      const body = filterText(msg.mes, st);
      if (!body) continue;
      lines.push(`[楼层 ${i}] ${speaker}：${body}`);
    }
    return lines.join('\n\n');
  }

  function buildBatchFromAiLayers(aiLayers, stOverride) {
    const all = chat();
    const st = stOverride || settings();
    const layers = (Array.isArray(aiLayers) ? aiLayers : []).filter(l => Number.isInteger(l) && l >= 0 && l < all.length).sort((a, b) => a - b);
    if (!layers.length) return null;
    const startLayer = layers[0];
    const endLayer = layers[layers.length - 1];
    // 对话上下文与溯源包含紧邻的前一层用户输入，保证语义完整与删改用户楼层可回退；记录的起止楼层保持纯 AI 楼层号
    const dialogueStart = startLayer > 0 && all[startLayer - 1]?.is_user ? startLayer - 1 : startLayer;
    const sourceRefs = timelineApi()?.captureRange?.(dialogueStart, endLayer) || [];
    const sourceDigest = timelineApi()?.digestRefs?.(sourceRefs) || `layers:${layers.join(',')}`;
    const conversation = formatConversationSlice(dialogueStart, endLayer, st);
    return {
      startLayer,
      endLayer,
      dialogueStart,
      aiLayers: layers,
      aiCount: layers.length,
      sourceRefs,
      sourceDigest,
      conversation
    };
  }

  function previousRawReference(dialogueStart, stOverride) {
    const st = stOverride || settings();
    const rounds = Math.max(0, parseInt(st.referenceRawRounds, 10) || 0);
    if (!rounds || dialogueStart <= 0) return '';
    const all = chat();
    const priorAi = [];
    for (let i = dialogueStart - 1; i >= 0 && priorAi.length < rounds; i--) {
      if (isFillEligibleAiMessage(all[i])) priorAi.unshift(i);
    }
    if (!priorAi.length) return '';
    const refStart = priorAi[0] > 0 && all[priorAi[0] - 1]?.is_user ? priorAi[0] - 1 : priorAi[0];
    return formatConversationSlice(refStart, dialogueStart - 1, st);
  }

  function currentStoryTimeFrom(state) {
    const gs = state?.tables?.global_state?.[0];
    if (clean(gs?.cur_time)) return clean(gs.cur_time);
    try {
      const world = window.WORLD_ENGINE_CORE?.loadState?.();
      if (clean(world?.time?.current)) return clean(world.time.current);
      if (Number.isFinite(Number(world?.time?.day))) return `第${world.time.day}天${clean(world.time.period) ? ` ${clean(world.time.period)}` : ''}`;
    } catch (_) {}
    return '';
  }

  function getBridgeHints() {
    try { return window.STORY_ENGINE_BRIDGE?.getMemoryExtractionHints?.() || {}; }
    catch (_) { return {}; }
  }

  async function loadWorldbookContext(conversation, stOverride) {
    const st = stOverride || settings();
    if (!st.worldbookEnabled || !window.WORLD_ENGINE_WORLDBOOK?.buildPromptSection) return '';
    try {
      return clean(await window.WORLD_ENGINE_WORLDBOOK.buildPromptSection(conversation, 'memory'));
    } catch (_) {
      return '';
    }
  }

  // ==================== JSON 提取、7 表校验与兼容适配 ====================

  function sanitizeDirtyJson(raw) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const next = raw[i + 1];
      if (inStr) {
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') { out += ch; inStr = false; continue; }
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') { out += '\\r'; continue; }
        if (ch === '\t') { out += '\\t'; continue; }
        out += ch;
        continue;
      }
      if (ch === '"') { inStr = true; out += ch; continue; }
      if (ch === '/' && next === '/') {
        while (i < raw.length && raw[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
        i++;
        continue;
      }
      out += ch;
    }
    // 清理字符串外尾随逗号（如 , } 或 , ]）
    let cleaned = '';
    inStr = false;
    esc = false;
    for (let i = 0; i < out.length; i++) {
      const ch = out[i];
      if (inStr) {
        cleaned += ch;
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; cleaned += ch; continue; }
      if (ch === ',') {
        let j = i + 1;
        while (j < out.length && /\s/.test(out[j])) j++;
        if (out[j] === '}' || out[j] === ']') continue;
      }
      cleaned += ch;
    }
    return cleaned;
  }

  function extractJsonObject(raw) {
    let text = String(raw == null ? '' : raw).trim();
    if (!text) return { ok: false, error: '模型返回为空，没有合法 JSON 对象' };
    text = text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
      .trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence) text = fence[1].trim();
    const tryParse = str => {
      for (const candidate of [str, sanitizeDirtyJson(str)]) {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (_) {}
        try {
          const repaired = window.WORLD_ENGINE_API?.parseJSON?.(candidate);
          if (repaired && typeof repaired === 'object' && !Array.isArray(repaired)) return repaired;
        } catch (_) {}
      }
      return null;
    };
    const direct = tryParse(text);
    if (direct) return { ok: true, data: direct };
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const sliced = tryParse(text.slice(first, last + 1));
      if (sliced) return { ok: true, data: sliced };
    }
    return { ok: false, error: '回复中没有合法 JSON 对象（请检查引号闭合与逗号语法）' };
  }

  function getNameBlacklistSet() {
    const raw = clean(settings().nameBlacklist);
    if (!raw) return new Set();
    return new Set(raw.split(/\r?\n/).map(normalized).filter(Boolean));
  }

  // 兼容适配：若旧测试或老模型返回 legacy 键名（small_summary / personal_memory / entity_updates / ongoing_fact_updates），自动转为 7 表格式
  function adaptLegacyPayload(obj, targetSheets) {
    const adapted = { ...obj };
    const hasModernKey = targetSheets.some(k => Object.prototype.hasOwnProperty.call(obj, k));
    if (hasModernKey) return adapted;

    const hasLegacy = Object.prototype.hasOwnProperty.call(obj, 'small_summary')
      || Array.isArray(obj.personal_memory)
      || Array.isArray(obj.character_profile_updates)
      || Array.isArray(obj.entity_updates)
      || Array.isArray(obj.ongoing_fact_updates);
    if (!hasLegacy) return adapted;

    if (targetSheets.includes('important_characters')) {
      const upsert = [];
      for (const upd of Array.isArray(obj.character_profile_updates) ? obj.character_profile_updates : []) {
        const name = clean(Array.isArray(upd?.names) ? upd.names[0] : upd?.name);
        if (!name) continue;
        const b = upd?.basic_info || upd?.basicInfo || {};
        upsert.push({
          name,
          brief_intro: clean(b.identity) || '重要角色',
          appearance: clean(b.appearance),
          relation_text: clean(b.relations),
          past_experience: clean(upd?.experiences),
          presence_status: '在场'
        });
      }
      for (const pm of Array.isArray(obj.personal_memory) ? obj.personal_memory : []) {
        const name = clean(Array.isArray(pm?.name) ? pm.name[0] : pm?.name);
        if (!name) continue;
        if (!upsert.some(item => normalized(item.name) === normalized(name))) {
          upsert.push({ name, brief_intro: '重要角色', past_experience: clean(pm?.memory), presence_status: '在场' });
        }
      }
      if (upsert.length) adapted.important_characters = { upsert, delete: [] };
    }

    if (Array.isArray(obj.entity_updates)) {
      const skills = [], items = [];
      let latestLocation = '';
      for (const ent of obj.entity_updates) {
        const name = clean(ent?.name);
        if (!name) continue;
        if (ent.type === 'ability') {
          skills.push({ skill_name: name, skill_type: '主动', effect_desc: clean(ent.description || ent.event) });
        } else if (ent.type === 'object' || ent.type === 'item') {
          items.push({ item_name: name, quantity: '1', description: clean(ent.description || ent.event), category: '物品' });
        } else if (ent.type === 'location') {
          latestLocation = name;
        }
      }
      if (skills.length && targetSheets.includes('protagonist_skills')) adapted.protagonist_skills = { upsert: skills, delete: [] };
      if (items.length && targetSheets.includes('inventory')) adapted.inventory = { upsert: items, delete: [] };
      if (latestLocation && targetSheets.includes('global_state') && !adapted.global_state) {
        adapted.global_state = { current_location: latestLocation };
      }
    }

    if (Array.isArray(obj.ongoing_fact_updates) && targetSheets.includes('quests_events')) {
      const upsert = [], del = [];
      for (const f of obj.ongoing_fact_updates) {
        const text = clean(f?.fact);
        if (!text) continue;
        const title = clean(f?.subject) && clean(f.subject) !== '全局'
          ? `${clean(f.subject)}：${Array.from(text).slice(0, 16).join('')}`
          : Array.from(text).slice(0, 20).join('');
        if (f.action === 'resolve') del.push(title);
        else upsert.push({ quest_name: title, quest_type: '支线任务', issuer: clean(f?.subject), detail_desc: text, current_progress: clean(f?.category || '进行中') });
      }
      if (upsert.length || del.length) adapted.quests_events = { upsert, delete: del };
    }

    if (targetSheets.includes('chronicle') && clean(obj.small_summary)) {
      adapted.chronicle = {
        chronicle_text: clean(obj.small_summary),
        keywords: unique(obj.small_summary_keywords),
        entities: unique(obj.small_summary_entities),
        impact: obj.small_summary_impact === 'key' ? 'key' : 'normal'
      };
    }

    return adapted;
  }

  function parseAndValidateTableResponse(rawText, targetSheets, options) {
    const sheets = Array.isArray(targetSheets) && targetSheets.length ? targetSheets : tableKeys();
    const extracted = extractJsonObject(rawText);
    if (!extracted.ok) {
      return { ok: false, errors: [extracted.error], tableOps: [], chronicleRows: [] };
    }
    const schemas = tableSchemas();
    const obj = adaptLegacyPayload(extracted.data, sheets);
    const blacklist = getNameBlacklistSet();
    const errors = [];
    const tableOps = [];
    const chronicleRows = [];

    for (const sheetKey of sheets) {
      const schema = schemas[sheetKey];
      if (!schema) continue;
      const val = obj[sheetKey];

      if (schema.mode === 'singleton') {
        if (val == null) continue;
        if (typeof val !== 'object' || Array.isArray(val)) {
          errors.push(`${schema.name} (${sheetKey}) 必须为 JSON 对象或 null`);
          continue;
        }
        const hasAnyValue = schema.columns.some(col => !col.readonly && clean(val[col.key]) !== '');
        if (hasAnyValue) {
          tableOps.push({ sheet: sheetKey, op: 'upsert', data: clone(val) });
        }
        continue;
      }

      if (schema.mode === 'keyed') {
        if (val == null) continue;
        let upsertList = [], deleteList = [];
        if (Array.isArray(val)) {
          upsertList = val;
        } else if (typeof val === 'object') {
          if (val.upsert !== undefined && !Array.isArray(val.upsert)) {
            errors.push(`${schema.name} (${sheetKey}).upsert 必须为数组`);
            continue;
          }
          if (val.delete !== undefined && !Array.isArray(val.delete)) {
            errors.push(`${schema.name} (${sheetKey}).delete 必须为数组`);
            continue;
          }
          upsertList = Array.isArray(val.upsert) ? val.upsert : [];
          deleteList = Array.isArray(val.delete) ? val.delete : [];
        } else {
          errors.push(`${schema.name} (${sheetKey}) 必须为 { upsert: [], delete: [] } 对象`);
          continue;
        }
        const pk = schema.primaryKey;
        upsertList.forEach((row, idx) => {
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            errors.push(`${schema.name} (${sheetKey}).upsert[${idx}] 必须为对象`);
            return;
          }
          const pkVal = clean(row[pk] ?? row.name);
          if (!pkVal) {
            errors.push(`${schema.name} (${sheetKey}).upsert[${idx}] 缺少必填主键字段 ${pk}`);
            return;
          }
          if (blacklist.size && blacklist.has(normalized(pkVal))) return;
          const payload = { ...row, [pk]: pkVal };
          tableOps.push({ sheet: sheetKey, op: 'upsert', key: pkVal, data: payload });
        });
        for (const item of deleteList) {
          const delKey = clean(typeof item === 'object' ? (item?.[pk] ?? item?.key ?? item?.name) : item);
          if (delKey) tableOps.push({ sheet: sheetKey, op: 'delete', key: delKey });
        }
        continue;
      }

      if (schema.mode === 'append' && sheetKey === 'chronicle') {
        const list = Array.isArray(val) ? val : (val && typeof val === 'object' ? [val] : []);
        if (!list.length) {
          errors.push('纪要表 (chronicle) 缺少必填记录对象，必须提供 chronicle_text');
          continue;
        }
        list.forEach((entry, idx) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`纪要表 chronicle[${idx}] 必须为对象`);
            return;
          }
          const text = clean(entry.chronicle_text ?? entry.content);
          if (!text) {
            errors.push(`纪要表 chronicle[${idx}] 缺少非空 chronicle_text 正文`);
            return;
          }
          chronicleRows.push({
            code_index: clean(entry.code_index ?? entry.codeIndex),
            time_span: clean(entry.time_span ?? entry.timeSpan),
            summary: clean(entry.summary),
            chronicle_text: text,
            key_dialogue: clean(entry.key_dialogue ?? entry.keyDialogue),
            keywords: unique(entry.keywords),
            entityNames: unique(entry.entities ?? entry.entityNames),
            impactLevel: entry.impact === 'key' || entry.impactLevel === 'key' ? 'key' : 'normal'
          });
        });
      }
    }

    if (errors.length) {
      return { ok: false, errors, tableOps, chronicleRows, rawParsed: obj };
    }
    return { ok: true, errors: [], tableOps, chronicleRows, rawParsed: obj };
  }

  // ==================== 时间线重放、水位线与覆盖统计 ====================

  function ensureTimelineState(state) {
    if (!state.timeline || typeof state.timeline !== 'object') {
      state.timeline = data().normalizeState(state).timeline;
    }
    if (!Array.isArray(state.timeline.nodes)) state.timeline.nodes = [];
    return state.timeline;
  }

  function sortChronicleRows(rows) {
    return (Array.isArray(rows) ? rows : []).slice().sort((a, b) => {
      const aEnd = Number.isFinite(Number(a?.endLayer)) ? Number(a.endLayer) : 0;
      const bEnd = Number.isFinite(Number(b?.endLayer)) ? Number(b.endLayer) : 0;
      if (aEnd !== bEnd) return aEnd - bEnd;
      const aStart = Number.isFinite(Number(a?.startLayer)) ? Number(a.startLayer) : 0;
      const bStart = Number.isFinite(Number(b?.startLayer)) ? Number(b.startLayer) : 0;
      if (aStart !== bStart) return aStart - bStart;
      return String(a?.id || '').localeCompare(String(b?.id || ''));
    });
  }

  function isCurrentChatRecord(item) {
    const cid = clean(data()?.getChatId?.() || 'default');
    const recCid = clean(item?.originChatId);
    return !recCid || recCid === cid;
  }

  function aiLayersCoveredByRecord(record) {
    const out = [];
    const refs = Array.isArray(record?.sourceRefs) ? record.sourceRefs : [];
    const assistantRefs = refs.filter(r => r && !r.synthetic && r.role === 'assistant' && Number.isFinite(Number(r.layer)));
    if (assistantRefs.length) {
      for (const r of assistantRefs) out.push(Number(r.layer));
      return unique(out).map(Number);
    }
    if (record?.source !== 'world_engine' && Number.isFinite(Number(record?.startLayer)) && Number.isFinite(Number(record?.endLayer))) {
      const s = Number(record.startLayer), e = Number(record.endLayer);
      if (e >= s && (s > 0 || e > 0)) {
        for (const l of collectEligibleAiLayers(settings(), s, e)) out.push(l);
      }
    }
    return out;
  }

  function hasSealedBaseline(state) {
    return state?.rebaseLayer !== null && state?.rebaseLayer !== undefined && Number.isFinite(Number(state.rebaseLayer));
  }

  function recomputeWatermarks(state) {
    const tl = ensureTimelineState(state);
    const wm = data().emptyWatermarks();
    const rebase = hasSealedBaseline(state) ? Number(state.rebaseLayer) : null;
    for (const k of tableKeys()) wm[k] = rebase;

    for (const node of tl.nodes) {
      if (!node || node.status !== 'valid' || node.kind === 'world_link' || node.kind === 'manual_snapshot') continue;
      if (!isCurrentChatRecord(node)) continue;
      const end = Number.isFinite(Number(node.endLayer)) ? Number(node.endLayer) : null;
      if (end === null) continue;
      const targets = Array.isArray(node.targetSheets) && node.targetSheets.length
        ? node.targetSheets
        : tableKeys().filter(k => k !== 'chronicle');
      for (const k of targets) {
        if (wm[k] === null || end > wm[k]) wm[k] = end;
      }
    }

    for (const row of state.tables?.chronicle || []) {
      if (!row || row.status === 'stale' || row.status === 'failed' || row.source === 'world_engine') continue;
      if (!isCurrentChatRecord(row)) continue;
      const end = Number.isFinite(Number(row.endLayer)) ? Number(row.endLayer) : null;
      if (end !== null && (wm.chronicle === null || end > wm.chronicle)) wm.chronicle = end;
    }

    state.tableWatermarks = wm;
    const nonChron = tableKeys().filter(k => k !== 'chronicle').map(k => wm[k]).filter(v => v !== null);
    state.chatLayer = nonChron.length ? Math.max(...nonChron) : (wm.chronicle !== null ? wm.chronicle : rebase);
    if (!state.event_memory) state.event_memory = { small_summaries: [], small_summary_layer: null };
    state.event_memory.small_summary_layer = wm.chronicle;
    return wm;
  }

  function sortTimelineNodesPreservingSnapshots(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    const out = [];
    let segment = [];
    const flushSegment = () => {
      if (!segment.length) return;
      segment.sort((a, b) => {
        const aEnd = Number.isFinite(Number(a?.endLayer)) ? Number(a.endLayer) : 0;
        const bEnd = Number.isFinite(Number(b?.endLayer)) ? Number(b.endLayer) : 0;
        if (aEnd !== bEnd) return aEnd - bEnd;
        const aStart = Number.isFinite(Number(a?.startLayer)) ? Number(a.startLayer) : 0;
        const bStart = Number.isFinite(Number(b?.startLayer)) ? Number(b.startLayer) : 0;
        if (aStart !== bStart) return aStart - bStart;
        return (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0);
      });
      out.push(...segment);
      segment = [];
    };
    for (const node of list) {
      if (node?.kind === 'manual_snapshot') {
        flushSegment();
        out.push(node);
      } else {
        segment.push(node);
      }
    }
    flushSegment();
    return out;
  }

  function replayTimeline(inputState) {
    const state = data().normalizeState(inputState);
    const tl = ensureTimelineState(state);
    tl.nodes = sortTimelineNodesPreservingSnapshots(tl.nodes);
    const chronicleBackup = clone(state.tables.chronicle || []);
    let tables = data().normalizeTables(tl.root?.base?.tables || data().emptyTables());
    let round = Math.max(0, parseInt(tl.root?.base?.round, 10) || 0);

    for (const node of tl.nodes) {
      if (!node || node.status !== 'valid') continue;
      if (node.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(node.worldCommitId) === false) continue;
      if (node.kind === 'manual_snapshot' && node.snapshot?.tables) {
        tables = data().normalizeTables(node.snapshot.tables);
        // 保留最新的 chronicle 列表（手动快照若也改了 chronicle 则以快照为准）
        continue;
      }
      if (Array.isArray(node.tableOps) && node.tableOps.length) {
        const nonChronOps = node.tableOps.filter(op => op && op.sheet !== 'chronicle');
        if (nonChronOps.length) tables = data().applyTableOps(tables, nonChronOps);
      }
      if (node.kind !== 'world_link') round++;
    }

    // 保留 chronicle（除非最新的有效 manual_snapshot 明确覆写了 chronicle）
    const lastValidManual = [...tl.nodes].reverse().find(n => n && n.status === 'valid' && n.kind === 'manual_snapshot' && n.snapshot?.tables);
    const hasLaterChronicle = chronicleBackup.some(row => Number(row?.revision) > 0 && row.sourceRefs?.length);
    if (!lastValidManual || hasLaterChronicle) {
      tables.chronicle = sortChronicleRows(chronicleBackup);
    }
    tables = data().normalizeTables(tables);
    state.tables = tables;
    state.round = round;
    recomputeWatermarks(state);
    state.event_memory = {
      small_summaries: data().projectChronicleToSmallSummaries(state.tables.chronicle),
      small_summary_layer: state.tableWatermarks.chronicle
    };
    return data().normalizeState(state);
  }

  function coveredLayersBySheet(state) {
    const sets = {};
    for (const k of tableKeys()) sets[k] = new Set();
    const tl = ensureTimelineState(state);
    for (const node of tl.nodes) {
      if (!node || node.status !== 'valid' || node.kind === 'world_link' || node.kind === 'manual_snapshot') continue;
      if (!isCurrentChatRecord(node)) continue;
      const layers = aiLayersCoveredByRecord(node);
      if (!layers.length) continue;
      const targets = Array.isArray(node.targetSheets) && node.targetSheets.length
        ? node.targetSheets
        : tableKeys().filter(k => k !== 'chronicle');
      for (const k of targets) {
        if (!sets[k]) continue;
        for (const l of layers) sets[k].add(l);
      }
    }
    for (const row of state.tables?.chronicle || []) {
      if (!row || row.status === 'stale' || row.status === 'failed' || row.source === 'world_engine') continue;
      if (!isCurrentChatRecord(row) || !clean(row.chronicle_text)) continue;
      for (const l of aiLayersCoveredByRecord(row)) sets.chronicle.add(l);
    }
    return sets;
  }

  function getSummaryCoverageStatus(stOverride) {
    const st = stOverride || settings();
    const all = chat();
    const state = data()?.loadState?.() || data().defaultState();
    const firstEligibleLayer = ignoreFirstLayer(st) ? 1 : 0;
    const latestLayer = all.length - 1;
    const allAi = collectEligibleAiLayers(st, firstEligibleLayer, latestLayer);
    const latestAiLayer = allAi.length ? allAi[allAi.length - 1] : -1;
    const effectiveDelayFloors = getEffectiveSummaryDelay(st);
    const latestAutoTargetLayer = stableAutoEndLayer(st);
    const coveredBySheet = coveredLayersBySheet(state);
    const schemas = tableSchemas();

    // 若存在封存/导入基线，跳过基线之前的历史楼层
    let catchUpStart = firstEligibleLayer;
    if (hasSealedBaseline(state)) {
      const sealed = Number(state.rebaseLayer);
      catchUpStart = Math.max(firstEligibleLayer, sealed + 1);
    }

    const perSheet = {};
    const uncoveredUnionAll = new Set();
    const uncoveredUnionAuto = new Set();

    for (const key of tableKeys()) {
      const cfg = st.tableConfigs?.[key] || { enabled: true, updateFrequency: 0 };
      const coveredSet = coveredBySheet[key] || new Set();
      const uncoveredAll = allAi.filter(l => l >= catchUpStart && !coveredSet.has(l));
      const uncoveredAuto = latestAutoTargetLayer >= 0 ? uncoveredAll.filter(l => l <= latestAutoTargetLayer) : [];
      if (cfg.enabled !== false) {
        for (const l of uncoveredAll) uncoveredUnionAll.add(l);
        for (const l of uncoveredAuto) uncoveredUnionAuto.add(l);
      }
      perSheet[key] = {
        key,
        name: schemas[key]?.name || key,
        shortName: schemas[key]?.shortName || key,
        watermark: state.tableWatermarks?.[key] ?? null,
        coveredCount: allAi.filter(l => coveredSet.has(l)).length,
        uncoveredLayers: uncoveredAll,
        uncoveredCount: uncoveredAll.length,
        uncoveredAutoLayers: uncoveredAuto,
        uncoveredAutoCount: uncoveredAuto.length,
        rowCount: Array.isArray(state.tables?.[key]) ? state.tables[key].length : 0,
        enabled: cfg.enabled !== false,
        updateFrequency: Number(cfg.updateFrequency) || 0
      };
    }

    const chronInfo = perSheet.chronicle;
    const uncoveredCombinedAll = Array.from(uncoveredUnionAll).sort((a, b) => a - b);
    const uncoveredCombinedAuto = Array.from(uncoveredUnionAuto).sort((a, b) => a - b);
    const staleCount = (state.tables?.chronicle || []).filter(r => r.status === 'stale').length
      + (state.timeline?.nodes || []).filter(n => n.status === 'stale').length;
    const validSummaryCount = (state.tables?.chronicle || []).filter(r => r.status !== 'stale' && r.status !== 'failed').length;
    const cursorLayer = state.tableWatermarks?.chronicle ?? null;
    const coveredEndLayer = chronInfo.watermark !== null ? chronInfo.watermark : -1;

    return {
      chatTotalLayers: all.length,
      firstEligibleLayer,
      firstAiLayer: allAi.length ? allAi[0] : -1,
      latestLayer,
      latestAiLayer,
      effectiveDelayFloors,
      skipCurrentFloorSummary: st.skipCurrentFloorSummary === true,
      latestAutoTargetLayer,
      cursorLayer,
      coveredEndLayer,
      totalAiCount: allAi.length,
      coveredAiCount: chronInfo.coveredCount,
      coveredMemoryAiCount: allAi.length - uncoveredCombinedAll.length,
      staleCount,
      validSummaryCount,
      uncoveredAiLayers: chronInfo.uncoveredLayers,
      uncoveredCount: chronInfo.uncoveredCount,
      uncoveredAutoAiLayers: chronInfo.uncoveredAutoLayers,
      uncoveredAutoCount: chronInfo.uncoveredAutoCount,
      uncoveredCombinedAiLayers: uncoveredCombinedAll,
      uncoveredCombinedCount: uncoveredCombinedAll.length,
      uncoveredCombinedAutoAiLayers: uncoveredCombinedAuto,
      uncoveredCombinedAutoCount: uncoveredCombinedAuto.length,
      perSheet
    };
  }

  // ==================== shujuku 风格 Wave 波次规划器（零 Token 预检） ====================

  function resolveSelectedSheets(rawSelection, stOverride) {
    const st = stOverride || settings();
    const allKeys = tableKeys();
    const source = Array.isArray(rawSelection) && rawSelection.length
      ? rawSelection
      : (Array.isArray(st.catchUpSelectedTables) && st.catchUpSelectedTables.length
        ? st.catchUpSelectedTables
        : allKeys.filter(k => st.tableConfigs?.[k]?.enabled !== false));
    const filtered = Array.from(new Set(source.filter(k => allKeys.includes(k))));
    return filtered.length ? filtered : [...allKeys];
  }

  function splitLayersIntoBatches(aiLayers, batchSize) {
    const size = Math.max(1, parseInt(batchSize, 10) || 1);
    const out = [];
    for (let i = 0; i < aiLayers.length; i += size) {
      const slice = aiLayers.slice(i, i + size);
      out.push({
        startLayer: slice[0],
        endLayer: slice[slice.length - 1],
        aiLayers: slice
      });
    }
    return out;
  }

  function prepareCatchUpPlan(options = {}) {
    const st = settings();
    const coverage = getSummaryCoverageStatus(st);
    const includeCurrentFloor = options.includeCurrentFloor === true;
    const selectedSheets = resolveSelectedSheets(options.selectedSheets, st);
    const batchSize = Math.max(1, parseInt(options.batchSize ?? st.catchUpBatchSize ?? 3, 10) || 3);
    const targetEndLayer = includeCurrentFloor ? coverage.latestAiLayer : coverage.latestAutoTargetLayer;
    const skippedLatestCount = !includeCurrentFloor && coverage.effectiveDelayFloors > 0
      ? Math.min(coverage.effectiveDelayFloors, coverage.totalAiCount)
      : 0;

    if (targetEndLayer < 0) {
      const msg = coverage.effectiveDelayFloors > 0 && !includeCurrentFloor
        ? '当前楼层处于延迟区（当前层不填表），暂无可追平楼层'
        : '当前聊天没有可填表的 AI 楼层';
      return {
        targetEndLayer: -1,
        totalAiCount: coverage.totalAiCount,
        skippedLatestCount,
        selectedSheets,
        batchSize,
        waves: [],
        totalBatches: 0,
        totalUncoveredAiFloors: 0,
        staleCount: coverage.staleCount,
        alreadyCaughtUp: true,
        summaryText: msg,
        perSheet: coverage.perSheet
      };
    }

    // 扫描所有目标 AI 楼层，按每层缺失表的精确集合切分连续 Wave（同集合连续楼层自动合流！）
    const minLayer = Number.isFinite(Number(options.minLayer)) ? Number(options.minLayer) : -1;
    const missingSets = {};
    const unionLayers = new Set();
    for (const k of selectedSheets) {
      const rawList = includeCurrentFloor
        ? (coverage.perSheet[k]?.uncoveredLayers || [])
        : (coverage.perSheet[k]?.uncoveredAutoLayers || []);
      const list = minLayer >= 0 ? rawList.filter(l => l >= minLayer) : rawList;
      missingSets[k] = new Set(list);
      for (const l of list) unionLayers.add(l);
    }

    const sortedLayers = Array.from(unionLayers).sort((a, b) => a - b);
    const waves = [];
    const schemas = tableSchemas();

    for (const layer of sortedLayers) {
      const needSheets = selectedSheets.filter(k => missingSets[k].has(layer));
      if (!needSheets.length) continue;
      const sig = needSheets.join(',');
      const prev = waves[waves.length - 1];
      if (prev && prev.signature === sig) {
        prev.aiLayers.push(layer);
        prev.endLayer = layer;
      } else {
        waves.push({
          signature: sig,
          startLayer: layer,
          endLayer: layer,
          aiLayers: [layer],
          sheets: needSheets,
          sheetNames: needSheets.map(k => schemas[k]?.shortName || k),
          batches: []
        });
      }
    }

    let totalBatches = 0;
    for (const wave of waves) {
      const chunks = splitLayersIntoBatches(wave.aiLayers, batchSize);
      wave.batches = chunks.map(c => ({
        ...c,
        sheets: [...wave.sheets],
        sheetNames: [...wave.sheetNames]
      }));
      totalBatches += wave.batches.length;
    }

    const alreadyCaughtUp = totalBatches === 0;
    const waveLines = waves.map((w, idx) =>
      `第 ${idx + 1} 波：AI 楼层 ${formatLayerSpan(w.startLayer, w.endLayer, '–')}（${w.aiLayers.length} 层 · ${w.batches.length} 批）→ ${w.sheetNames.join('、')}`
    );
    const skipNote = skippedLatestCount > 0 ? `（已按延迟保护跳过最新 ${skippedLatestCount} 条 AI 回复）` : '';
    const summaryText = alreadyCaughtUp
      ? `所选 ${selectedSheets.length} 张表均已追平至第 ${targetEndLayer} 层${skipNote}，无需补填`
      : `待补 ${sortedLayers.length} 条 AI 回复至第 ${targetEndLayer} 层${skipNote}，合并为 ${waves.length} 波 / ${totalBatches} 批（每批最多 ${batchSize} 层）`;

    return {
      targetEndLayer,
      totalAiCount: coverage.totalAiCount,
      skippedLatestCount,
      selectedSheets,
      batchSize,
      waves,
      waveLines,
      totalBatches,
      totalUncoveredAiFloors: sortedLayers.length,
      staleCount: coverage.staleCount,
      alreadyCaughtUp,
      summaryText,
      perSheet: coverage.perSheet
    };
  }

  // ==================== API 调用 + 带错回灌纠错重试 ====================

  async function callTableFillWithRetry(batch, targetSheets, baseState, options = {}) {
    const st = settings();
    const api = window.WORLD_ENGINE_API;
    if (!api?.callApi) throw new Error('API 模块未就绪');
    const cfg = {
      apiUrl: st.apiUrl,
      apiKey: st.apiKey,
      model: st.model,
      connectionMode: st.connectionMode,
      temperature: st.temperature,
      maxTokens: st.maxTokens,
      apiTimeoutMs: st.apiTimeoutMs,
      stream: st.stream,
      streamIdleTimeoutMs: st.streamIdleTimeoutMs,
      jsonMode: st.jsonMode,
      topP: st.topP,
      reasoningEffort: st.reasoningEffort
    };

    const hints = getBridgeHints();
    const worldbook = await loadWorldbookContext(batch.conversation, st);
    const refContext = options.skipReference ? '' : previousRawReference(batch.dialogueStart, st);
    const nextCode = data().nextChronicleCode(baseState?.tables?.chronicle);
    const baseMessages = promptApi().buildMessages({
      targetSheets,
      tables: baseState?.tables || data().emptyTables(),
      currentStoryTime: currentStoryTimeFrom(baseState),
      worldbook,
      outlineFocusHint: hints.outlineFocusHint || '',
      worldContextHint: hints.worldContextHint || '',
      referenceContext: refContext,
      referenceChronicleCount: st.referenceSmallSummaryCount,
      beforeLayer: options.beforeLayer ?? batch.startLayer,
      conversation: batch.conversation,
      startLayer: batch.startLayer,
      endLayer: batch.endLayer,
      aiCount: batch.aiCount,
      minChars: st.smallSummaryMinChars,
      nextChronicleCode: nextCode,
      tonePrompt: st.tonePrompt,
      customSystemPrompt: st.tableFillSystemPrompt,
      customSheetRules: st.tableFillSheetRules
    });

    const defaultFormatRetries = st.tableFillMaxRetries !== undefined && st.tableFillMaxRetries !== null
      ? st.tableFillMaxRetries
      : (st.apiAutoRetries ?? 2);
    const maxFormatRetries = Math.max(0, parseInt(options.formatRetries ?? defaultFormatRetries, 10) || 0);
    const retryHistory = [];
    let lastRaw = '';
    let lastParsed = null;

    for (let attempt = 0; attempt <= maxFormatRetries; attempt++) {
      if (abortController?.signal?.aborted) {
        const abortErr = new Error('已取消');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const messages = retryHistory.length
        ? promptApi().buildRetryCorrectionMessages(baseMessages, retryHistory, targetSheets)
        : baseMessages;
      const promptText = typeof promptApi().messagesToPromptString === 'function'
        ? promptApi().messagesToPromptString(messages)
        : messages.map(m => m.content).join('\n\n---\n\n');

      const sheetLabel = targetSheets.map(k => tableSchemas()[k]?.shortName || k).join('/');
      const purpose = `${options.purpose || '填表'} [${formatLayerSpan(batch.startLayer, batch.endLayer)}] (${sheetLabel})${attempt > 0 ? ` · 纠错重试${attempt}` : ''}`;

      const invokeOnce = async () => {
        let capturedLogId = null;
        api.setNextRequestMeta?.({
          module: 'memory',
          purpose,
          attempt: attempt + 1,
          maxAttempts: maxFormatRetries + 1,
          onLogId: id => { capturedLogId = id; }
        });
        const raw = await api.callApi(promptText, st.maxTokens, st.temperature, abortController?.signal, cfg);
        return { raw, logId: capturedLogId };
      };

      const { raw, logId } = typeof api.executeWithRetry === 'function'
        ? await api.executeWithRetry(invokeOnce, {
            retries: Math.max(0, parseInt(options.networkRetries ?? st.apiAutoRetries ?? 0, 10) || 0),
            signal: abortController?.signal
          })
        : await invokeOnce();

      lastRaw = raw;
      const parsed = parseAndValidateTableResponse(raw, targetSheets, {
        tables: baseState?.tables,
        minChars: st.smallSummaryMinChars
      });
      lastParsed = parsed;

      lastDebug = {
        at: Date.now(),
        targetSheets: [...targetSheets],
        range: formatLayerSpan(batch.startLayer, batch.endLayer),
        attempt: attempt + 1,
        requestPrompt: promptText,
        rawResult: raw,
        ok: parsed.ok,
        errors: parsed.errors
      };

      if (parsed.ok) {
        const summaryParts = [];
        if (parsed.tableOps.length) summaryParts.push(`表变更 ${parsed.tableOps.length} 项`);
        if (parsed.chronicleRows.length) summaryParts.push(`纪要 +${parsed.chronicleRows.length}`);
        if (logId) api.updateRequestLog?.(logId, { phase: `完成（${summaryParts.join(' · ') || '无变更'}）` });
        return { ...parsed, raw, attempts: attempt + 1 };
      }

      if (logId) {
        api.updateRequestLog?.(logId, {
          status: 'error',
          phase: '解析失败',
          error: parsed.errors.join('；')
        });
      }
      retryHistory.push({ response: raw, errors: parsed.errors });
      if (attempt < maxFormatRetries) {
        console.warn(`[记忆引擎] 填表输出校验失败，准备第 ${attempt + 1} 次带错回灌纠错重试：`, parsed.errors);
      }
    }

    throw new Error(`填表解析失败（已纠错重试 ${maxFormatRetries} 次）：${(lastParsed?.errors || ['没有合法 JSON 对象']).join('；')}`);
  }

  // ==================== 单批执行与落盘 ====================

  function nextNodeId(nodes) {
    const max = (Array.isArray(nodes) ? nodes : []).reduce((acc, n) => {
      const m = /^memory_(\d+)$/.exec(clean(n?.id));
      return Math.max(acc, m ? Number(m[1]) : 0);
    }, 0);
    return `memory_${String(max + 1).padStart(6, '0')}`;
  }

  function nextChronicleId(rows) {
    const max = (Array.isArray(rows) ? rows : []).reduce((acc, r) => {
      const m = /^small_(\d+)$/.exec(clean(r?.id));
      return Math.max(acc, m ? Number(m[1]) : 0);
    }, 0);
    return `small_${String(max + 1).padStart(6, '0')}`;
  }

  async function executeTableFillBatch(batch, options = {}) {
    const originChatId = data().getChatId();
    const targetSheets = Array.isArray(options.targetSheets) && options.targetSheets.length
      ? Array.from(new Set(options.targetSheets))
      : tableKeys();
    const baseState = options.baseState ? clone(options.baseState) : data().loadState();

    const result = await callTableFillWithRetry(batch, targetSheets, baseState, {
      purpose: options.purpose || '结构化填表',
      networkRetries: options.retries,
      formatRetries: options.formatRetries
    });

    if (originChatId !== data().getChatId()) {
      throw new Error('填表期间聊天已切换，本次结果未写入');
    }
    if (options.expectedEpoch !== undefined && options.expectedEpoch !== autoFillEpoch) {
      return { skipped: true, reason: 'epoch_stale' };
    }

    const latest = data().loadState();
    const tl = ensureTimelineState(latest);
    const overwrite = options.overwrite === true;
    const now = Date.now();
    const aiLayerSet = new Set(batch.aiLayers || []);

    // 若为覆盖模式或修复 stale，先移除同范围内冲突的旧节点/旧纪要（覆盖模式绝不误杀包含范围外楼层的跨区节点）
    const nonChronTargets = targetSheets.filter(k => k !== 'chronicle');
    if (nonChronTargets.length) {
      if (overwrite || options.replaceStale) {
        const rangeMin = Number.isFinite(Number(options.overwriteStartLayer)) ? Number(options.overwriteStartLayer) : batch.startLayer;
        const rangeMax = Number.isFinite(Number(options.overwriteEndLayer)) ? Number(options.overwriteEndLayer) : batch.endLayer;
        for (const node of tl.nodes) {
          if (!node || node.kind === 'manual_snapshot' || node.kind === 'world_link') continue;
          const nodeLayers = node.status === 'stale' ? survivingAiLayersForRecord(node) : aiLayersCoveredByRecord(node);
          const overlaps = nodeLayers.some(l => aiLayerSet.has(l));
          if (!overlaps) continue;
          const containedInOverwrite = nodeLayers.length > 0 && nodeLayers.every(l => l >= rangeMin && l <= rangeMax);
          if ((overwrite && containedInOverwrite) || (options.replaceStale && node.status === 'stale')) {
            node.targetSheets = (node.targetSheets || []).filter(k => !nonChronTargets.includes(k));
            node.tableOps = (node.tableOps || []).filter(op => !nonChronTargets.includes(op.sheet));
            if (!node.targetSheets.length && !node.tableOps.length) node._drop = true;
          }
        }
        tl.nodes = tl.nodes.filter(n => !n._drop);
      }

      tl.nodes.push({
        id: nextNodeId(tl.nodes),
        kind: options.kind || 'table_ops',
        ...(clean(options.sourceKey) ? { sourceKey: clean(options.sourceKey) } : {}),
        ...(clean(options.worldCommitId) ? { worldCommitId: clean(options.worldCommitId) } : {}),
        originChatId,
        startLayer: batch.startLayer,
        endLayer: batch.endLayer,
        sourceRefs: clone(batch.sourceRefs || []),
        sourceDigest: batch.sourceDigest || '',
        targetSheets: [...nonChronTargets],
        tableOps: clone(result.tableOps || []),
        snapshot: null,
        status: 'valid',
        revision: 1,
        createdAt: now,
        updatedAt: now
      });
    }

    let addedChronicle = 0;
    if (targetSheets.includes('chronicle') && result.chronicleRows.length) {
      if (overwrite || options.replaceStale) {
        const rangeMin = Number.isFinite(Number(options.overwriteStartLayer)) ? Number(options.overwriteStartLayer) : batch.startLayer;
        const rangeMax = Number.isFinite(Number(options.overwriteEndLayer)) ? Number(options.overwriteEndLayer) : batch.endLayer;
        latest.tables.chronicle = (latest.tables.chronicle || []).filter(row => {
          if (row.source === 'world_engine') return true;
          const rowLayers = row.status === 'stale' ? survivingAiLayersForRecord(row) : aiLayersCoveredByRecord(row);
          const overlaps = rowLayers.some(l => aiLayerSet.has(l));
          if (!overlaps) return true;
          if (options.replaceStale && row.status === 'stale') return false;
          if (overwrite && rowLayers.length > 0 && rowLayers.every(l => l >= rangeMin && l <= rangeMax)) return false;
          return true;
        });
      }
      const existingDigests = new Set((latest.tables.chronicle || []).filter(r => r.status === 'valid').map(r => r.sourceDigest).filter(Boolean));
      const usedCodes = new Set((latest.tables.chronicle || []).map(r => r.code_index));
      const outlineChapter = (() => {
        try {
          const os = window.OUTLINE_ENGINE_DATA?.loadState?.();
          const ch = (os?.plan?.chapters || []).find(c => c.id === os?.currentChapterId);
          return clean(ch?.title);
        } catch (_) { return ''; }
      })();

      for (const entry of result.chronicleRows) {
        if (!overwrite && batch.sourceDigest && existingDigests.has(batch.sourceDigest)) continue;
        const row = data().normalizeTableRow('chronicle', {
          ...entry,
          id: nextChronicleId(latest.tables.chronicle),
          startLayer: batch.startLayer,
          endLayer: batch.endLayer,
          sourceRefs: clone(batch.sourceRefs || []),
          sourceDigest: batch.sourceDigest || '',
          originChatId,
          ...(outlineChapter ? { outlineChapterTitle: outlineChapter } : {}),
          status: 'valid',
          revision: 1
        }, (latest.tables.chronicle?.length || 0) + 1, usedCodes);
        if (row) {
          latest.tables.chronicle.push(row);
          addedChronicle++;
        }
      }
    }

    const replayed = replayTimeline(latest);
    if (options.saveCheckpoint !== false) data().saveCheckpoint(baseState);
    const saved = data().saveState(replayed);
    window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.afterEvolution?.();
    return {
      ok: true,
      added: result.tableOps.length + addedChronicle,
      opsCount: result.tableOps.length,
      addedSmall: addedChronicle,
      attempts: result.attempts,
      state: saved
    };
  }

  // ==================== 审计、删楼同步回退与历史修复 ====================

  function extractAiLayersFromRefs(refs) {
    const all = chat();
    const out = [];
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (!ref || ref.synthetic === true) continue;
      const layer = Number(ref.layer);
      if (!Number.isFinite(layer) || layer < 0) continue;
      const isAssistant = ref.role === 'assistant'
        || (!ref.role && all[layer] && isFillEligibleAiMessage(all[layer]));
      if (isAssistant) out.push(layer);
    }
    return unique(out).map(Number).sort((a, b) => a - b);
  }

  function sameRefLayers(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Number(a[i]?.layer) !== Number(b[i]?.layer) || clean(a[i]?.messageId) !== clean(b[i]?.messageId)) return false;
    }
    return true;
  }

  function auditStoredSources(state, options = {}) {
    const pruneDead = options.pruneDead !== false;
    const tl = ensureTimelineState(state);
    const auditFn = timelineApi()?.auditRefs;
    const all = chat();
    let changed = false;

    const nextNodes = [];
    for (const node of tl.nodes) {
      if (!node || node.kind === 'manual_snapshot') { nextNodes.push(node); continue; }
      if (node.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(node.worldCommitId) === false) {
        changed = true;
        continue;
      }
      if (!isCurrentChatRecord(node)) { nextNodes.push(node); continue; }
      const refs = Array.isArray(node.sourceRefs) ? node.sourceRefs : [];
      if (!refs.length || refs.every(r => r?.synthetic === true)) {
        if (pruneDead && (node.kind === 'world_link' || node.source === 'world_engine')) {
          const endL = Number(node.endLayer);
          if (all.length === 0 || (Number.isFinite(endL) && endL >= all.length)) {
            changed = true;
            continue;
          }
        }
        nextNodes.push(node);
        continue;
      }
      if (typeof auditFn !== 'function') { nextNodes.push(node); continue; }

      const check = auditFn(refs);
      if (check?.valid) {
        const updatedRefs = Array.isArray(check.refs) && check.refs.length ? clone(check.refs) : refs;
        const aiLayers = extractAiLayersFromRefs(updatedRefs);
        if (node.status === 'stale') { node.status = 'valid'; changed = true; }
        if (!sameRefLayers(node.sourceRefs, updatedRefs)) {
          node.sourceRefs = updatedRefs;
          changed = true;
        }
        if (aiLayers.length) {
          if (node.startLayer !== aiLayers[0] || node.endLayer !== aiLayers[aiLayers.length - 1]) {
            node.startLayer = aiLayers[0];
            node.endLayer = aiLayers[aiLayers.length - 1];
            changed = true;
          }
        }
        nextNodes.push(node);
      } else {
        const survivingRefs = Array.isArray(check?.refs) ? clone(check.refs) : [];
        const survivingAi = extractAiLayersFromRefs(survivingRefs);
        if (pruneDead && survivingAi.length === 0) {
          changed = true; // 所覆盖 AI 楼层已全部删除或仅剩孤儿用户楼：彻底裁剪
        } else {
          if (node.status !== 'stale') { node.status = 'stale'; changed = true; }
          nextNodes.push(node);
        }
      }
    }
    tl.nodes = nextNodes;

    const nextChronicle = [];
    for (const row of state.tables?.chronicle || []) {
      if (!row) continue;
      if (row.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(row.worldCommitId) === false) {
        changed = true;
        continue;
      }
      if (!isCurrentChatRecord(row)) { nextChronicle.push(row); continue; }
      const refs = Array.isArray(row.sourceRefs) ? row.sourceRefs : [];
      if (row.source === 'world_engine' || !refs.length || refs.every(r => r?.synthetic === true)) {
        if (pruneDead && row.source === 'world_engine') {
          const endL = Number(row.endLayer);
          if (all.length === 0 || (Number.isFinite(endL) && endL >= all.length)) {
            changed = true;
            continue;
          }
        }
        nextChronicle.push(row);
        continue;
      }
      if (typeof auditFn !== 'function') { nextChronicle.push(row); continue; }

      const check = auditFn(refs);
      if (check?.valid) {
        const updatedRefs = Array.isArray(check.refs) && check.refs.length ? clone(check.refs) : refs;
        const aiLayers = extractAiLayersFromRefs(updatedRefs);
        if (row.status === 'stale') { row.status = 'valid'; changed = true; }
        if (!sameRefLayers(row.sourceRefs, updatedRefs)) {
          row.sourceRefs = updatedRefs;
          changed = true;
        }
        if (aiLayers.length) {
          if (row.startLayer !== aiLayers[0] || row.endLayer !== aiLayers[aiLayers.length - 1]) {
            row.startLayer = aiLayers[0];
            row.endLayer = aiLayers[aiLayers.length - 1];
            changed = true;
          }
        }
        nextChronicle.push(row);
      } else {
        const survivingRefs = Array.isArray(check?.refs) ? clone(check.refs) : [];
        const survivingAi = extractAiLayersFromRefs(survivingRefs);
        if (pruneDead && survivingAi.length === 0) {
          changed = true;
        } else {
          if (row.status !== 'stale') { row.status = 'stale'; changed = true; }
          nextChronicle.push(row);
        }
      }
    }
    state.tables.chronicle = nextChronicle;
    return changed;
  }

  function survivingAiLayersForRecord(record) {
    const auditFn = timelineApi()?.auditRefs;
    const refs = Array.isArray(record?.sourceRefs) ? record.sourceRefs : [];
    if (typeof auditFn === 'function' && refs.length && !refs.every(r => r?.synthetic === true)) {
      const check = auditFn(refs);
      return extractAiLayersFromRefs(check?.refs || []);
    }
    return aiLayersCoveredByRecord(record);
  }

  function runLocalAuditAndReplay(options = {}) {
    restoreActiveWorldContributions();
    let state = data().loadState();
    const changed = auditStoredSources(state, { pruneDead: options.pruneDead !== false });
    if (changed) {
      state = replayTimeline(state);
      data().saveState(state);
      try { window.MEMORY_ENGINE_VECTOR?.pruneVectorsForState?.(state); } catch (_) {}
      refreshMemoryPanel();
    }
    return { changed, state };
  }

  async function prepareHistoryForGeneration(options = {}) {
    if (settings().engineEnabled === false) return { invalidated: false };
    const { changed } = runLocalAuditAndReplay(options);
    applyInjection();
    await hiddenSyncPromise;
    return { invalidated: changed };
  }

  async function reconcileHistory(options = {}) {
    if (reconciling || running || backfillRunning || settings().engineEnabled === false) return { skipped: true };
    reconciling = true;
    let repairedCount = 0;
    const st = settings();
    const respectDelay = options?.respectDelay !== false;
    try {
      const { state } = runLocalAuditAndReplay({ pruneDead: true });
      const stableEnd = respectDelay ? stableAutoEndLayer(st) : (collectEligibleAiLayers(st).at(-1) ?? -1);

      // 收集需要重填的 stale 节点与纪要所对应的楼层和目标表；若处于延迟区且无稳态楼层可修，则直接裁剪 stale 尾项交由后续正常填表
      const staleLayersBySheet = {};
      for (const k of tableKeys()) staleLayersBySheet[k] = new Set();
      let prunedDelayStale = false;
      const keepNodes = [];
      for (const node of state.timeline?.nodes || []) {
        if (node?.status !== 'stale') { keepNodes.push(node); continue; }
        const targets = Array.isArray(node.targetSheets) && node.targetSheets.length ? node.targetSheets : tableKeys().filter(k => k !== 'chronicle');
        const eligible = survivingAiLayersForRecord(node).filter(l => stableEnd >= 0 && l <= stableEnd);
        if (eligible.length) {
          for (const l of eligible) for (const k of targets) staleLayersBySheet[k]?.add(l);
          keepNodes.push(node);
        } else if (respectDelay) {
          prunedDelayStale = true;
        } else {
          keepNodes.push(node);
        }
      }
      const keepChron = [];
      for (const row of state.tables?.chronicle || []) {
        if (row?.status !== 'stale' || row.source === 'world_engine') { keepChron.push(row); continue; }
        const eligible = survivingAiLayersForRecord(row).filter(l => stableEnd >= 0 && l <= stableEnd);
        if (eligible.length) {
          for (const l of eligible) staleLayersBySheet.chronicle.add(l);
          keepChron.push(row);
        } else if (respectDelay) {
          prunedDelayStale = true;
        } else {
          keepChron.push(row);
        }
      }
      if (prunedDelayStale) {
        state.timeline.nodes = keepNodes;
        state.tables.chronicle = keepChron;
        data().saveState(replayTimeline(state));
      }

      const staleUnion = new Set();
      for (const k of tableKeys()) for (const l of staleLayersBySheet[k]) staleUnion.add(l);
      const staleSorted = Array.from(staleUnion).sort((a, b) => a - b);

      if (staleSorted.length) {
        abortController = new AbortController();
        setRunningUI(true, '历史记忆对账');
        setExternalStatus('记忆引擎：修复已修改楼层…');
        // 按连续同表集合分波修复
        const waves = [];
        for (const layer of staleSorted) {
          const sheets = tableKeys().filter(k => staleLayersBySheet[k].has(layer));
          const sig = sheets.join(',');
          const prev = waves[waves.length - 1];
          if (prev && prev.sig === sig) prev.layers.push(layer);
          else waves.push({ sig, sheets, layers: [layer] });
        }
        for (const wave of waves) {
          if (abortController.signal.aborted) break;
          const batch = buildBatchFromAiLayers(wave.layers, st);
          if (!batch || !batch.conversation) continue;
          await executeTableFillBatch(batch, {
            targetSheets: wave.sheets,
            replaceStale: true,
            purpose: '历史改写修复'
          });
          repairedCount++;
        }
      }

      if (options.refillUncovered === true && st.evolveMode === 'auto' && st.autoRefillOnHistoryChange !== false) {
        const curState = data().loadState();
        const autoBase = curState.autoBaselineLayer !== null && curState.autoBaselineLayer !== undefined && Number.isFinite(Number(curState.autoBaselineLayer))
          ? Number(curState.autoBaselineLayer) : -1;
        const plan = prepareCatchUpPlan({
          includeCurrentFloor: !respectDelay,
          minLayer: autoBase >= 0 ? autoBase + 1 : undefined,
          batchSize: st.catchUpBatchSize || 3
        });
        if (!plan.alreadyCaughtUp && plan.waves.length) {
          if (!abortController) abortController = new AbortController();
          setRunningUI(true, '补齐历史缺口');
          for (const wave of plan.waves) {
            for (const b of wave.batches) {
              if (abortController.signal.aborted) break;
              const batch = buildBatchFromAiLayers(b.aiLayers, st);
              if (!batch || !batch.conversation) continue;
              await executeTableFillBatch(batch, {
                targetSheets: b.sheets,
                overwrite: false,
                purpose: '历史变动补漏'
              });
              repairedCount++;
            }
          }
        }
      }
      return { repaired: repairedCount > 0 || prunedDelayStale, repairedCount };
    } catch (error) {
      lastError = clean(error?.message || error);
      console.warn('[记忆引擎] 历史修复失败', error);
      return { repaired: repairedCount > 0, repairedCount, error: lastError };
    } finally {
      reconciling = false;
      abortController = null;
      setRunningUI(false, '');
      applyInjection();
      refreshMemoryPanel();
      if (repairedCount > 0) refreshVectorRecallAsync(data().loadState());
    }
  }

  // ==================== 平时自动填表（分表独立频率 + 同批合流 + Epoch 保护） ====================

  async function autoExtract(expectedEpoch) {
    const st = settings();
    if (st.engineEnabled === false || running || backfillRunning || reconciling) return;
    if (expectedEpoch !== undefined && expectedEpoch !== autoFillEpoch) return;
    const originChatId = data().getChatId();

    await reconcileHistory({
      respectDelay: true,
      refillUncovered: false
    });
    if (st.evolveMode !== 'auto') return;
    if (expectedEpoch !== undefined && expectedEpoch !== autoFillEpoch) return;
    if (originChatId !== data().getChatId()) return;

    const coverage = getSummaryCoverageStatus(st);
    if (coverage.latestAutoTargetLayer < 0) return;

    const currentState = data().loadState();
    const autoBaseline = currentState.autoBaselineLayer !== null && currentState.autoBaselineLayer !== undefined && Number.isFinite(Number(currentState.autoBaselineLayer))
      ? Number(currentState.autoBaselineLayer) : -1;

    // 逐表判断到期条件（支持 per-sheet 独立频率，仅针对首次进聊基线之后的新楼层触发自动填表；历史补齐交由一键追平）
    const dueSheets = [];
    for (const key of tableKeys()) {
      const info = coverage.perSheet[key];
      if (!info || !info.enabled) continue;
      const defaultFreq = key === 'chronicle'
        ? Math.max(1, parseInt(st.smallSummaryEveryX, 10) || 1)
        : Math.max(1, parseInt(st.evolveEveryX, 10) || 1);
      const freq = info.updateFrequency > 0 ? info.updateFrequency : defaultFreq;
      const autoNewLayers = autoBaseline >= 0
        ? info.uncoveredAutoLayers.filter(l => l > autoBaseline)
        : info.uncoveredAutoLayers;
      if (autoNewLayers.length >= freq) dueSheets.push(key);
    }
    if (!dueSheets.length) return;

    const plan = prepareCatchUpPlan({
      selectedSheets: dueSheets,
      includeCurrentFloor: false,
      minLayer: autoBaseline >= 0 ? autoBaseline + 1 : undefined,
      batchSize: Math.max(1, parseInt(st.smallSummaryEveryX, 10) || 1)
    });
    if (plan.alreadyCaughtUp || !plan.waves.length) return;

    abortController = new AbortController();
    setRunningUI(true, '自动填表');
    setExternalStatus('记忆引擎：自动填表中…');
    lastError = '';
    let completed = 0;
    try {
      for (const wave of plan.waves) {
        for (const b of wave.batches) {
          if (abortController.signal.aborted) break;
          if (expectedEpoch !== undefined && expectedEpoch !== autoFillEpoch) break;
          if (originChatId !== data().getChatId()) break;
          const batch = buildBatchFromAiLayers(b.aiLayers, st);
          if (!batch || !batch.conversation) continue;
          await executeTableFillBatch(batch, {
            targetSheets: b.sheets,
            overwrite: false,
            expectedEpoch,
            purpose: '自动填表'
          });
          completed++;
        }
      }
      if (completed > 0) setExternalStatus('记忆引擎：自动填表完成');
      return { ok: true, completedBatches: completed, state: data().loadState() };
    } catch (error) {
      lastError = clean(error?.message || error);
      setExternalStatus(`记忆引擎填表失败：${lastError}`, true);
      throw error;
    } finally {
      abortController = null;
      setRunningUI(false, '');
      applyInjection();
      refreshMemoryPanel();
      if (completed > 0) refreshVectorRecallAsync(data().loadState());
    }
  }

  // ==================== 一键追平（Wave 波次智能合流）与范围填表 ====================

  async function catchUpToLatest(options = {}) {
    const st = settings(), all = chat();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    if (backfillRunning || running || reconciling) throw new Error('已有记忆任务正在运行');
    if (!all.length) {
      setSummaryBackfillStatus(0, 0, '当前聊天为空，无需追平');
      return { completedBatches: 0, totalBatches: 0, addedSmall: 0, repaired: 0, alreadyCaughtUp: true };
    }

    const includeCurrentFloor = options.includeCurrentFloor === true;
    const respectDelay = includeCurrentFloor ? false : (options.respectDelay !== false);
    const selectedSheets = resolveSelectedSheets(options.selectedSheets, st);
    const batchSize = Math.max(1, parseInt(options.batchSize ?? st.catchUpBatchSize ?? 3, 10) || 3);

    // 1. 零 Token 本地对账与死记录清理
    runLocalAuditAndReplay({ pruneDead: true });

    // 2. 修复目标边界之前的 stale 记录
    let repaired = 0;
    const preState = data().loadState();
    const hasStale = (preState.timeline?.nodes || []).some(n => n.status === 'stale')
      || (preState.tables?.chronicle || []).some(r => r.status === 'stale');
    if (hasStale) {
      const rec = await reconcileHistory({ respectDelay, refillUncovered: false });
      repaired += Number(rec?.repairedCount || 0);
    }

    // 3. 重新规划 Wave 波次（吸收上述修复后的最新水位）
    const plan = prepareCatchUpPlan({ selectedSheets, includeCurrentFloor, batchSize });
    if (plan.alreadyCaughtUp || !plan.waves.length) {
      const msg = repaired > 0
        ? `已修复 ${repaired} 条历史记录并追平至第 ${plan.targetEndLayer} 层`
        : plan.summaryText;
      setSummaryBackfillStatus(0, 0, msg);
      applyInjection();
      refreshMemoryPanel();
      refreshVectorRecallAsync(data().loadState());
      return {
        completedBatches: 0,
        totalBatches: 0,
        addedSmall: 0,
        repaired,
        targetEndLayer: plan.targetEndLayer,
        alreadyCaughtUp: repaired === 0,
        plan,
        message: msg,
        state: data().loadState()
      };
    }

    backfillRunning = true;
    abortController = new AbortController();
    setRunningUI(true, '一键追平');
    window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.createSnapshot?.('一键追平填表前自动备份');
    data().saveCheckpoint(data().loadState());

    let completedBatches = 0, addedSmall = 0;
    const totalBatches = plan.totalBatches;
    try {
      for (const wave of plan.waves) {
        if (!backfillRunning || abortController.signal.aborted) break;
        for (const b of wave.batches) {
          if (!backfillRunning || abortController.signal.aborted) break;
          const label = `正在追平 ${completedBatches + 1}/${totalBatches} 批（楼层 ${formatLayerSpan(b.startLayer, b.endLayer, '–')} · ${b.sheetNames.join('/')}）`;
          setSummaryBackfillStatus(completedBatches, totalBatches, label);
          setExternalStatus(`记忆追平 ${completedBatches + 1}/${totalBatches}`);
          const batch = buildBatchFromAiLayers(b.aiLayers, st);
          if (!batch || !batch.conversation) continue;
          const res = await executeTableFillBatch(batch, {
            targetSheets: b.sheets,
            overwrite: false,
            retries: st.backfillRetries,
            purpose: '一键追平'
          });
          if (res?.skipped) continue;
          completedBatches++;
          addedSmall += Number(res?.addedSmall || 0);
        }
      }
      const stopped = !backfillRunning || abortController.signal.aborted;
      const msg = stopped
        ? `追平已停止（已完成 ${completedBatches}/${totalBatches} 批，已写内容已保留）`
        : `已追平至第 ${plan.targetEndLayer} 层（共 ${plan.waves.length} 波 ${completedBatches} 批${repaired > 0 ? `，修复 ${repaired} 条` : ''}）`;
      setSummaryBackfillStatus(completedBatches, totalBatches, msg);
      setExternalStatus(stopped ? '记忆追平已停止' : '记忆追平完成');
      return {
        completedBatches,
        totalBatches,
        addedSmall,
        repaired,
        targetEndLayer: plan.targetEndLayer,
        stopped,
        plan,
        message: msg,
        state: data().loadState()
      };
    } catch (error) {
      lastError = clean(error?.message || error);
      setSummaryBackfillStatus(completedBatches, totalBatches, `追平失败：${lastError}`);
      setExternalStatus(`记忆追平失败：${lastError}`, true);
      throw error;
    } finally {
      backfillRunning = false;
      abortController = null;
      summaryBackfillStatus.running = false;
      setRunningUI(false, '');
      const latestState = data().loadState();
      applyInjection();
      refreshMemoryPanel();
      refreshVectorRecallAsync(latestState);
    }
  }

  async function fillSummaryRange(options = {}) {
    const st = settings(), all = chat();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    if (backfillRunning || running || reconciling) throw new Error('已有记忆任务正在运行');
    if (!all.length) throw new Error('当前聊天为空');

    const firstEligible = ignoreFirstLayer(st) ? 1 : 0;
    const rawStart = Number.isFinite(Number(options.startLayer)) ? Math.max(0, Math.floor(Number(options.startLayer))) : firstEligible;
    const startLayer = Math.max(firstEligible, rawStart);
    const rawEnd = Number.isFinite(Number(options.endLayer)) ? Math.floor(Number(options.endLayer)) : (all.length - 1);
    const endLayer = (rawEnd <= 0 && options.explicitZeroEnd !== true)
      ? (all.length - 1)
      : Math.min(all.length - 1, Math.max(startLayer, rawEnd));
    const batchSize = Math.max(1, parseInt(options.batchSize ?? st.catchUpBatchSize ?? 3, 10) || 3);
    const overwrite = options.overwrite === true;
    const selectedSheets = options.includeMemory === false
      ? ['chronicle']
      : resolveSelectedSheets(options.selectedSheets, st);

    const rangeAi = collectEligibleAiLayers(st, startLayer, endLayer);
    if (!rangeAi.length) {
      const msg = `楼层 ${formatLayerSpan(startLayer, endLayer, '–')} 内没有可填表的 AI 回复`;
      setSummaryBackfillStatus(0, 0, msg);
      return { completedBatches: 0, totalBatches: 0, addedSmall: 0, message: msg, state: data().loadState() };
    }

    let planBatches = [];
    if (overwrite) {
      planBatches = splitLayersIntoBatches(rangeAi, batchSize).map(c => ({
        ...c,
        sheets: [...selectedSheets],
        sheetNames: selectedSheets.map(k => tableSchemas()[k]?.shortName || k)
      }));
    } else {
      const covered = coveredLayersBySheet(data().loadState());
      const waves = [];
      for (const layer of rangeAi) {
        const need = selectedSheets.filter(k => !covered[k]?.has(layer));
        if (!need.length) continue;
        const sig = need.join(',');
        const prev = waves[waves.length - 1];
        if (prev && prev.sig === sig) prev.layers.push(layer);
        else waves.push({ sig, sheets: need, layers: [layer] });
      }
      for (const w of waves) {
        for (const c of splitLayersIntoBatches(w.layers, batchSize)) {
          planBatches.push({
            ...c,
            sheets: [...w.sheets],
            sheetNames: w.sheets.map(k => tableSchemas()[k]?.shortName || k)
          });
        }
      }
    }

    if (!planBatches.length) {
      const msg = `楼层 ${formatLayerSpan(startLayer, endLayer, '–')} 所选表均已覆盖，无需补填`;
      setSummaryBackfillStatus(0, 0, msg);
      return { completedBatches: 0, totalBatches: 0, addedSmall: 0, alreadyCaughtUp: true, message: msg, state: data().loadState() };
    }

    backfillRunning = true;
    abortController = new AbortController();
    setRunningUI(true, '范围填表');
    window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.createSnapshot?.(`范围填表前自动备份（${startLayer}-${endLayer}）`);
    data().saveCheckpoint(data().loadState());

    let completedBatches = 0, addedSmall = 0, totalOps = 0;
    try {
      for (let i = 0; i < planBatches.length && backfillRunning; i++) {
        if (abortController.signal.aborted) break;
        const b = planBatches[i];
        setSummaryBackfillStatus(i, planBatches.length, `正在范围填表 ${i + 1}/${planBatches.length}（楼层 ${formatLayerSpan(b.startLayer, b.endLayer, '–')} · ${b.sheetNames.join('/')}）`);
        const batch = buildBatchFromAiLayers(b.aiLayers, st);
        if (!batch || !batch.conversation) continue;
        const res = await executeTableFillBatch(batch, {
          targetSheets: b.sheets,
          overwrite,
          overwriteStartLayer: startLayer,
          overwriteEndLayer: endLayer,
          retries: st.backfillRetries,
          purpose: overwrite ? '范围覆盖填表' : '范围增量填表'
        });
        completedBatches++;
        addedSmall += Number(res?.addedSmall || 0);
        totalOps += Number(res?.opsCount || 0);
      }
      const stopped = !backfillRunning || abortController.signal.aborted;
      const msg = stopped
        ? `范围填表已停止（已完成 ${completedBatches}/${planBatches.length} 批）`
        : `范围填表完成（楼层 ${formatLayerSpan(startLayer, endLayer, '–')}，共 ${completedBatches} 批）`;
      setSummaryBackfillStatus(completedBatches, planBatches.length, msg);
      return {
        completedBatches,
        totalBatches: planBatches.length,
        opsCount: totalOps,
        addedSmall,
        added: totalOps + addedSmall,
        stopped,
        message: msg,
        state: data().loadState()
      };
    } catch (error) {
      lastError = clean(error?.message || error);
      setSummaryBackfillStatus(completedBatches, planBatches.length, `范围填表失败：${lastError}`);
      throw error;
    } finally {
      backfillRunning = false;
      abortController = null;
      summaryBackfillStatus.running = false;
      setRunningUI(false, '');
      const latestState = data().loadState();
      applyInjection();
      refreshMemoryPanel();
      refreshVectorRecallAsync(latestState);
    }
  }

  async function manualExtract() {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    if (running || backfillRunning || reconciling) throw new Error('已有记忆任务正在运行');
    const plan = prepareCatchUpPlan({ includeCurrentFloor: true, batchSize: 1 });
    if (plan.alreadyCaughtUp || !plan.waves.length) {
      return { skipped: true, message: '当前所有表格已是最新', state: data().loadState() };
    }
    const firstBatch = plan.waves[0].batches[0];
    const batch = buildBatchFromAiLayers(firstBatch.aiLayers, st);
    if (!batch || !batch.conversation) return { skipped: true, state: data().loadState() };
    abortController = new AbortController();
    setRunningUI(true, '手动填表');
    try {
      return await executeTableFillBatch(batch, {
        targetSheets: firstBatch.sheets,
        overwrite: false,
        purpose: '手动填表'
      });
    } finally {
      abortController = null;
      setRunningUI(false, '');
      applyInjection();
      refreshMemoryPanel();
      refreshVectorRecallAsync(data().loadState());
    }
  }

  async function manualReextract() {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    if (running || backfillRunning || reconciling) throw new Error('已有记忆任务正在运行');
    const allAi = collectEligibleAiLayers(st);
    if (!allAi.length) throw new Error('当前聊天没有可重填的 AI 楼层');
    const targetLayer = allAi[allAi.length - 1];
    return fillSummaryRange({
      startLayer: targetLayer,
      endLayer: targetLayer,
      batchSize: 1,
      overwrite: true
    });
  }

  async function manualSmallSummary() {
    return catchUpToLatest({ selectedSheets: ['chronicle'], includeCurrentFloor: true, batchSize: settings().smallSummaryEveryX || 1 });
  }

  async function backfill(options = {}) {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    if (running || backfillRunning || reconciling) throw new Error('已有记忆任务正在运行');
    const nonChronSheets = tableKeys().filter(k => k !== 'chronicle');
    const prev = data().loadState();
    data().saveCheckpoint(prev);
    window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.createSnapshot?.('重填结构化 6 表前自动备份');
    const wiped = clone(prev);
    const tl = ensureTimelineState(wiped);
    if (!tl.root) tl.root = { id: `root:${data().getChatId()}`, originChatId: data().getChatId(), createdAt: Date.now(), base: { tables: data().emptyTables(), round: 0, chatLayer: null } };
    if (!tl.root.base) tl.root.base = { tables: data().emptyTables(), round: 0, chatLayer: null };
    tl.root.base.tables = { ...data().emptyTables(), chronicle: clone(wiped.tables?.chronicle || []) };
    tl.nodes = tl.nodes.filter(n => n?.kind === 'world_link');
    for (const k of nonChronSheets) {
      wiped.tables[k] = [];
      if (wiped.tableWatermarks) wiped.tableWatermarks[k] = null;
    }
    wiped.rebaseLayer = null;
    data().saveState(replayTimeline(wiped));
    const endLayer = Math.max(0, parseInt(options.endLayer ?? st.backfillEndLayer ?? 0, 10) || 0);
    return fillSummaryRange({
      startLayer: Math.max(0, parseInt(options.startLayer ?? st.backfillStartLayer ?? 0, 10) || 0),
      endLayer: endLayer > 0 ? endLayer : undefined,
      selectedSheets: nonChronSheets,
      batchSize: Math.max(1, parseInt(options.batchSize ?? st.backfillBatchSize ?? 5, 10) || 5),
      overwrite: true
    });
  }

  async function backfillSummaries(options = {}) {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    if (running || backfillRunning || reconciling) throw new Error('已有记忆任务正在运行');
    const prev = data().loadState();
    data().saveCheckpoint(prev);
    window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.createSnapshot?.('重填全部纪要前自动备份');
    const wiped = clone(prev);
    wiped.tables.chronicle = (wiped.tables.chronicle || []).filter(r => r?.source === 'world_engine');
    if (wiped.tableWatermarks) wiped.tableWatermarks.chronicle = null;
    if (wiped.event_memory) {
      wiped.event_memory.small_summaries = data().projectChronicleToSmallSummaries(wiped.tables.chronicle);
      wiped.event_memory.small_summary_layer = null;
    }
    data().saveState(replayTimeline(wiped));
    const endLayer = Math.max(0, parseInt(options.endLayer ?? st.backfillEndLayer ?? 0, 10) || 0);
    return fillSummaryRange({
      startLayer: Math.max(0, parseInt(options.startLayer ?? st.backfillStartLayer ?? 0, 10) || 0),
      endLayer: endLayer > 0 ? endLayer : undefined,
      selectedSheets: ['chronicle'],
      batchSize: Math.max(1, parseInt(options.batchSize ?? st.summaryBackfillSmallEveryX ?? 5, 10) || 5),
      overwrite: true
    });
  }

  function stopBackfill() {
    backfillRunning = false;
    cancelMutationRefresh();
    abortController?.abort();
    setBackfillStatus(backfillStatus.current, backfillStatus.total, '正在停止…');
    setSummaryBackfillStatus(summaryBackfillStatus.current, summaryBackfillStatus.total, '正在停止…');
  }

  function abort() {
    backfillRunning = false;
    bumpAutoFillEpoch();
    clearTimeout(autoTimer);
    cancelMutationRefresh();
    abortController?.abort();
    setRunningUI(false, '');
  }

  function commitManualState(nextState) {
    const normalizedNext = data().normalizeState(nextState);
    const tl = ensureTimelineState(normalizedNext);
    const now = Date.now();
    tl.nodes.push({
      id: nextNodeId(tl.nodes),
      kind: 'manual_snapshot',
      originChatId: data().getChatId(),
      startLayer: currentLayer(),
      endLayer: currentLayer(),
      sourceRefs: [],
      sourceDigest: '',
      targetSheets: [...tableKeys()],
      tableOps: [],
      snapshot: {
        tables: clone(normalizedNext.tables),
        round: normalizedNext.round,
        chatLayer: normalizedNext.chatLayer
      },
      status: 'valid',
      revision: 1,
      createdAt: now,
      updatedAt: now
    });
    const saved = data().saveState(replayTimeline(normalizedNext));
    window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.afterEvolution?.();
    applyInjection();
    refreshMemoryPanel();
    refreshVectorRecallAsync(saved);
    return saved;
  }

  // ==================== 注入构建（对齐 shujuku 双层省 Token 注入） ====================

  function tokenizeSearchText(text) {
    const raw = clean(text).toLocaleLowerCase();
    const tokens = new Set();
    if (!raw) return tokens;
    for (const w of raw.match(/[a-z0-9_]{2,}/g) || []) tokens.add(w);
    for (const seg of raw.match(/[\u4e00-\u9fff]+/g) || []) {
      if (seg.length === 1) { tokens.add(seg); continue; }
      for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
    }
    return tokens;
  }

  function scoreArchivedChronicle(row, scanText, scanTokens) {
    const lowerScan = clean(scanText).toLocaleLowerCase();
    let score = 0;
    if (clean(row.code_index) && lowerScan.includes(row.code_index.toLocaleLowerCase())) score += 10;
    for (const kw of row.keywords || []) {
      if (clean(kw) && lowerScan.includes(kw.toLocaleLowerCase())) score += 3;
    }
    for (const ent of row.entityNames || []) {
      if (clean(ent) && lowerScan.includes(ent.toLocaleLowerCase())) score += 2.5;
    }
    const summaryTokens = tokenizeSearchText(`${row.summary || ''} ${row.chronicle_text || ''}`);
    let hits = 0;
    for (const t of summaryTokens) if (scanTokens.has(t)) hits++;
    score += Math.min(4, hits * 0.25);
    if (row.impactLevel === 'key') score += 0.8;
    return score;
  }

  function recentRawRoundMessageIds(messagesOrCount, maybeCount, stOverride, timelineHelper) {
    const hasExplicitMessages = Array.isArray(messagesOrCount);
    const all = hasExplicitMessages ? messagesOrCount : chat();
    const rounds = Math.max(0, parseInt(hasExplicitMessages ? maybeCount : messagesOrCount, 10) || 0);
    if (!rounds || !all.length) return new Set();
    const st = stOverride || settings();
    const minIdx = ignoreFirstLayer(st) ? 1 : 0;
    const tl = timelineHelper || timelineApi();
    const getId = (msg, idx) => {
      if (!msg) return '';
      if (typeof tl?.ensureMessageId === 'function') return clean(tl.ensureMessageId(msg));
      return clean(tl?.sourceRef?.(msg, idx)?.messageId);
    };
    const collected = [];
    let aiSeen = 0;
    for (let i = all.length - 1; i >= minIdx; i--) {
      const msg = all[i];
      const id = getId(msg, i);
      if (id) collected.unshift(id);
      if (isFillEligibleAiMessage(msg)) {
        aiSeen++;
        if (aiSeen >= rounds) {
          if (i - 1 >= minIdx && all[i - 1]?.is_user) {
            const uId = getId(all[i - 1], i - 1);
            if (uId) collected.unshift(uId);
          }
          break;
        }
      }
    }
    return new Set(collected);
  }

  function selectHiddenMessageIds(coveredRefs, currentChatId, recentMessageIds) {
    const recent = recentMessageIds instanceof Set ? recentMessageIds : new Set(recentMessageIds || []);
    return new Set((coveredRefs || [])
      .filter(ref => clean(ref?.chatId) === clean(currentChatId))
      .map(ref => clean(ref?.messageId))
      .filter(messageId => messageId && !recent.has(messageId)));
  }

  function syncHiddenMessages(hiddenIds, errorLabel) {
    if (typeof timelineApi()?.syncHidden !== 'function') return;
    const p = Promise.resolve(timelineApi().syncHidden(hiddenIds))
      .catch(err => console.warn(`[记忆引擎] ${errorLabel || '同步隐藏楼层失败'}`, err));
    hiddenSyncPromise = p;
  }

  function clearInjection() {
    const ctx = context();
    if (typeof ctx?.setExtensionPrompt === 'function') ctx.setExtensionPrompt(INJECTION_NAME, '', 1, 1);
  }

  function applyInjection(options) {
    const st = settings();
    const unsafeStoryBase = window.STORY_ENGINE_PROJECTION?.active?.() === true && window.STORY_ENGINE_HISTORY?.getStatus?.().blocked === true;
    if (st.engineEnabled === false || st.injectIntoPrompt === false || unsafeStoryBase) {
      clearInjection();
      syncHiddenMessages(new Set(), '恢复正文失败');
      return '';
    }
    restoreActiveWorldContributions();
    const legacyReroll = options?.isReroll && window.STORY_ENGINE_PROJECTION?.active?.() !== true;
    const state = (legacyReroll && data().loadCheckpoint()) || data().loadState();
    const tables = state.tables || data().emptyTables();
    const counts = data().tableRowCounts(state);
    if (counts.totalRows === 0) {
      clearInjection();
      syncHiddenMessages(new Set(), '恢复正文失败');
      return '';
    }

    const scanDepth = Math.max(1, parseInt(st.searchDepth, 10) || 5);
    const scanText = chat().slice(-scanDepth).map(m => clean(m?.mes)).join('\n');
    const lowerScan = scanText.toLocaleLowerCase();
    const scanTokens = tokenizeSearchText(scanText);
    const outlineActors = (() => {
      try { return window.STORY_ENGINE_BRIDGE?.getOutlineActiveActors?.() || []; }
      catch (_) { return []; }
    })();
    const outlineActorSet = new Set(outlineActors.map(normalized).filter(Boolean));
    const vectorRecall = (() => {
      try { return window.MEMORY_ENGINE_VECTOR?.getRecallScoresForInjection?.() || null; }
      catch (_) { return null; }
    })();
    const recalledKeys = new Set((vectorRecall?.hits || []).map(h => h.key));

    const headerLine = '【长期记忆数据库（以下为客观已记录事实，请保持连贯）】\n';
    const budget = Math.max(200, parseInt(st.memoryInjectMaxChars, 10) || 8000);
    const sections = [];
    let usedChars = headerLine.length;
    const pushSection = (title, body) => {
      const text = clean(body);
      if (!text) return false;
      const block = `<${title}>\n${text}\n</${title}>`;
      if (usedChars + block.length + 2 > budget) {
        const remain = budget - usedChars - title.length * 2 - 12;
        if (remain < 40) return false;
        const trimmed = `<${title}>\n${text.slice(0, remain)}…\n</${title}>`;
        sections.push(trimmed);
        usedChars += trimmed.length + 2;
        return false;
      }
      sections.push(block);
      usedChars += block.length + 2;
      return true;
    };

    // 1. 全局数据表
    const gs = tables.global_state?.[0];
    if (gs) {
      const locParts = [gs.current_major_region, gs.current_minor_region, gs.current_location].map(clean).filter(Boolean);
      const timeParts = [
        gs.cur_time ? `当前时间：${gs.cur_time}` : '',
        gs.prev_scene_time ? `上轮时间：${gs.prev_scene_time}` : '',
        gs.elapsed_time ? `经过：${gs.elapsed_time}` : ''
      ].filter(Boolean);
      pushSection('全局状态', [
        locParts.length ? `当前地点：${locParts.join(' · ')}` : '',
        timeParts.length ? timeParts.join('｜') : ''
      ].filter(Boolean).join('\n'));
    }

    // 2. 主角信息表
    const pro = tables.protagonist_info?.[0];
    if (pro) {
      const lines = [
        `姓名：${pro.name || '主角'}${pro.gender || pro.age ? `（${[pro.gender, pro.age].filter(Boolean).join(' / ')}）` : ''}${pro.identity_text ? `｜身份：${pro.identity_text}` : ''}`,
        pro.current_condition ? `近况：${pro.current_condition}` : '',
        pro.location_name ? `所在地点：${pro.location_name}` : '',
        pro.appearance ? `外貌：${pro.appearance}` : '',
        pro.belongings ? `随身财物：${pro.belongings}` : ''
      ].filter(Boolean);
      pushSection('主角信息', lines.join('\n'));
    }

    // 3. 任务与事件表
    if (tables.quests_events?.length) {
      const qLines = tables.quests_events.map(q => {
        const meta = [q.issuer ? `发布：${q.issuer}` : '', q.current_progress ? `进度：${q.current_progress}` : '', q.time_limit ? `时限：${q.time_limit}` : ''].filter(Boolean).join('｜');
        const extra = [q.reward ? `奖励：${q.reward}` : '', q.penalty ? `惩罚：${q.penalty}` : ''].filter(Boolean).join('｜');
        return `- [${q.quest_type || '支线任务'}] ${q.quest_name}${meta ? `（${meta}）` : ''}：${q.detail_desc || ''}${extra ? ` [${extra}]` : ''}`;
      });
      pushSection('当前任务与事件', qLines.join('\n'));
    }

    // 4. 重要角色表（双层注入：全员索引 + 在场/正文提及/向量召回角色详情）
    if (tables.important_characters?.length) {
      const activeOrMentioned = [];
      const indexLines = [];
      for (const ch of tables.important_characters) {
        indexLines.push(`- ${ch.name}｜${ch.brief_intro || '重要角色'}｜${ch.presence_status || '在场'}${ch.location_name ? `·${ch.location_name}` : ''}`);
        const vecHit = recalledKeys.has(`char:${ch.rowId}`)
          || recalledKeys.has(`char:${ch.name}`)
          || Number(vectorRecall?.personScores?.[String(ch.rowId)] || 0) > 0;
        const mentioned = clean(ch.name) && (
          lowerScan.includes(ch.name.toLocaleLowerCase())
          || outlineActorSet.has(normalized(ch.name))
          || vecHit
        );
        if (ch.presence_status === '在场' || mentioned) activeOrMentioned.push(ch);
      }
      if (activeOrMentioned.length) {
        const detailLines = activeOrMentioned.map(ch => {
          const head = `【${ch.name}】${[ch.gender, ch.age].filter(Boolean).join('/')} · ${ch.brief_intro || ''}（${ch.presence_status || '在场'}${ch.location_name ? `@${ch.location_name}` : ''}）`;
          const body = [
            ch.appearance ? `外貌：${ch.appearance}` : '',
            ch.outfit_text ? `穿着：${ch.outfit_text}` : '',
            ch.relation_text ? `关系：${ch.relation_text}` : '',
            ch.past_experience ? `经历：${ch.past_experience}` : '',
            ch.interaction_options ? `可交互：${ch.interaction_options}` : ''
          ].filter(Boolean).join('｜');
          return body ? `${head}\n  ${body}` : head;
        });
        pushSection('重要角色详情', detailLines.join('\n'));
      }
      pushSection('已登场重要角色索引', indexLines.join('\n'));
    }

    // 5. 主角技能表 & 背包物品表（向量命中的条目优先排前）
    if (tables.protagonist_skills?.length) {
      const sortedSkills = [...tables.protagonist_skills].sort((a, b) => {
        const sa = Number(vectorRecall?.entityScores?.[`ability:${a.rowId}`] || 0);
        const sb = Number(vectorRecall?.entityScores?.[`ability:${b.rowId}`] || 0);
        return sb - sa;
      });
      const sLines = sortedSkills.map(s =>
        `- ${s.skill_name} [${s.skill_type || '主动'}${s.skill_level ? `·${s.skill_level}` : ''}]：${s.effect_desc || ''}`
      );
      pushSection('主角技能', sLines.join('\n'));
    }
    if (tables.inventory?.length) {
      const sortedItems = [...tables.inventory].sort((a, b) => {
        const sa = Number(vectorRecall?.entityScores?.[`object:${a.rowId}`] || 0);
        const sb = Number(vectorRecall?.entityScores?.[`object:${b.rowId}`] || 0);
        return sb - sa;
      });
      const iLines = sortedItems.map(item =>
        `- ${item.item_name} ×${item.quantity || '1'}${item.category ? ` [${item.category}]` : ''}${item.description ? `：${item.description}` : ''}`
      );
      pushSection('背包物品', iLines.join('\n'));
    }

    // 6. 纪要表（最近 N 条完整直注 + 早期归档 AM 索引 + 关键词/向量精准召回）
    const validChronicle = (tables.chronicle || []).filter(r => r && r.status !== 'stale' && r.status !== 'failed' && clean(r.chronicle_text));
    const injectLimit = Math.max(0, parseInt(st.smallSummaryInjectLimit, 10) ?? 8);
    const recentRows = injectLimit > 0 ? validChronicle.slice(-injectLimit) : [];
    const recentIds = new Set(recentRows.map(r => r.id));
    const archivedRows = validChronicle.filter(r => !recentIds.has(r.id));

    if (recentRows.length) {
      const lines = recentRows.map(r => {
        const span = formatLayerSpan(r.startLayer, r.endLayer);
        const head = `[${r.code_index} · 楼层 ${span}${r.time_span ? ` · ${r.time_span}` : ''}]`;
        return `${head} ${r.chronicle_text}${r.key_dialogue ? `\n  重要对话：${r.key_dialogue}` : ''}`;
      });
      pushSection('近期纪要', lines.join('\n'));
    }

    const recallLimit = Math.max(0, parseInt(st.recallArchivedSmallLimit, 10) || 3);
    if (archivedRows.length && recallLimit > 0) {
      const recalled = archivedRows
        .map(row => {
          const vecBoost = (recalledKeys.has(`small:${row.id}`) || Number(vectorRecall?.smallScores?.[row.id] || 0) > 0) ? 6 : 0;
          return {
            row,
            score: scoreArchivedChronicle(row, scanText, scanTokens) + vecBoost
          };
        })
        .filter(item => item.score >= 2.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, recallLimit)
        .map(item => item.row);
      if (recalled.length) {
        const rLines = recalled.map(r =>
          `[${r.code_index} · 楼层 ${formatLayerSpan(r.startLayer, r.endLayer)}${r.time_span ? ` · ${r.time_span}` : ''}] ${r.chronicle_text}${r.key_dialogue ? `\n  重要对话：${r.key_dialogue}` : ''}`
        );
        pushSection('记忆回溯', rLines.join('\n'));
      }
    }

    if (archivedRows.length) {
      const idxLines = archivedRows.map(r =>
        `- ${r.code_index}${r.time_span ? ` | ${r.time_span}` : ''} | ${r.summary || clean(r.chronicle_text).slice(0, 30)}`
      );
      pushSection('已发生的事件概览', idxLines.join('\n'));
    }

    const content = sections.length
      ? `${headerLine}${sections.join('\n\n')}`
      : '';
    const ctx = context();
    if (typeof ctx?.setExtensionPrompt === 'function') {
      ctx.setExtensionPrompt(INJECTION_NAME, content, 1, 1);
    }

    // 同步隐藏已由有效纪要覆盖的旧楼层原文（保留 recentRawRounds 轮原文可见）
    if (st.hideCoveredRawText !== false && validChronicle.length) {
      const coveredRefs = validChronicle.filter(r => r.source !== 'world_engine').flatMap(r => r.sourceRefs || []);
      const recentIdsSet = recentRawRoundMessageIds(st.recentRawRounds);
      const hidden = selectHiddenMessageIds(coveredRefs, data().getChatId(), recentIdsSet);
      syncHiddenMessages(hidden, '同步隐藏已覆盖正文失败');
    } else {
      syncHiddenMessages(new Set(), '恢复正文失败');
    }

    lastInjectionDebug = {
      at: Date.now(),
      chars: content.length,
      budget,
      sections: sections.length,
      content
    };
    try { window.WORLD_ENGINE_INJECT_INSPECTOR?.record?.('memory', content, { budget, sections: sections.length }); } catch (_) {}
    return content;
  }

  // ==================== 世界 / 大纲跨引擎联动接口 ====================

  function buildWorldEngineContext() {
    const st = settings();
    if (st.engineEnabled === false || st.injectIntoWorldEngine === false) return '';
    const state = data().loadState();
    const tables = state.tables || data().emptyTables();
    const limit = Math.max(1, parseInt(settings().worldEngineMemoryLimit, 10) || 5);
    const lines = [];
    const gs = tables.global_state?.[0];
    if (gs) lines.push(`当前地点与时间：${[gs.current_major_region, gs.current_minor_region, gs.current_location].filter(Boolean).join('·')} ${gs.cur_time || ''}`.trim());
    const pro = tables.protagonist_info?.[0];
    if (pro?.name) lines.push(`主角：${pro.name}（${pro.identity_text || ''}${pro.current_condition ? `｜${pro.current_condition}` : ''}）`);
    if (tables.important_characters?.length) {
      lines.push('重要角色：' + tables.important_characters.slice(0, limit).map(c => `${c.name}(${c.brief_intro || ''}/${c.presence_status})`).join('；'));
    }
    if (tables.quests_events?.length) {
      lines.push('进行中任务：' + tables.quests_events.slice(0, limit).map(q => `${q.quest_name}(${q.current_progress || '进行中'})`).join('；'));
    }
    const recentChron = (tables.chronicle || []).filter(r => r.status === 'valid').slice(-limit);
    if (recentChron.length) {
      lines.push('近期纪要：\n' + recentChron.map(r => `- [${r.code_index}·楼层${formatLayerSpan(r.startLayer, r.endLayer)}] ${r.summary || clean(r.chronicle_text).slice(0, 120)}`).join('\n'));
    }
    return lines.join('\n');
  }

  function getSnapshotSummaryForBridge() {
    try {
      const state = data().loadState();
      const tables = state.tables || data().emptyTables();
      const validSmalls = (state.event_memory?.small_summaries || []).filter(item => item.status === 'valid' && clean(item.content));
      const recentSmallSummaries = validSmalls.slice(-6);
      const recentIds = new Set(recentSmallSummaries.map(item => item.id));
      const keySmallSummaries = validSmalls.filter(item => item.impactLevel === 'key' && !recentIds.has(item.id)).slice(-4);
      return {
        globalState: tables.global_state?.[0] ? clone(tables.global_state[0]) : null,
        protagonist: tables.protagonist_info?.[0] ? clone(tables.protagonist_info[0]) : null,
        characters: clone(tables.important_characters || []),
        skills: clone(tables.protagonist_skills || []),
        inventory: clone(tables.inventory || []),
        quests: clone(tables.quests_events || []),
        // 兼容桥接字段（大纲参考与世界参考沿用）
        ongoingFacts: (tables.quests_events || []).map(q => ({
          id: `quest_${q.rowId}`,
          category: q.quest_type || '任务',
          subject: q.issuer || q.quest_name,
          fact: `${q.quest_name}${q.current_progress ? `（${q.current_progress}）` : ''}：${q.detail_desc || ''}`.trim(),
          status: 'active'
        })),
        recentSmallSummaries: clone(recentSmallSummaries),
        keySmallSummaries: clone(keySmallSummaries),
        peopleRoster: (tables.important_characters || []).map(c => ({
          id: `char_${c.rowId}`,
          names: [c.name],
          brief_intro: c.brief_intro,
          presence_status: c.presence_status,
          relation_text: c.relation_text,
          past_experience: c.past_experience,
          profile: {
            basicInfo: { identity: c.brief_intro, appearance: c.appearance, relations: c.relation_text },
            experiences: c.past_experience
          }
        })),
        entityRoster: [
          ...(tables.inventory || []).map(it => ({ type: 'object', name: it.item_name, aliases: [] })),
          ...(tables.protagonist_skills || []).map(sk => ({ type: 'ability', name: sk.skill_name, aliases: [] }))
        ]
      };
    } catch (_) {
      return null;
    }
  }

  // 弱联动模式：剧情大纲不再向记忆 7 表写入任何记录（仅通过协同桥提供只读焦距参考）
  function syncVerifiedOutlineKnowledge() {
    return { changed: 0, readonly: true };
  }

  function removeLinkedLayerFromState(state, layer) {
    const sourceKey = `${data().getChatId()}:${layer}`;
    const tl = ensureTimelineState(state);
    const beforeN = tl.nodes.length;
    const beforeC = (state.tables?.chronicle || []).length;
    tl.nodes = tl.nodes.filter(n => !(n?.kind === 'world_link' && n.sourceKey === sourceKey));
    state.tables.chronicle = (state.tables.chronicle || []).filter(r => !(r?.source === 'world_engine' && r.sourceKey === sourceKey));
    return tl.nodes.length !== beforeN || state.tables.chronicle.length !== beforeC;
  }

  function rollbackLinkedLayer(layer) {
    const state = data().loadState();
    if (!removeLinkedLayerFromState(state, layer)) return false;
    data().saveState(replayTimeline(state));
    applyInjection();
    refreshMemoryPanel();
    return true;
  }

  // 弱联动模式：世界引擎不再向记忆 7 表写入纪要或任务（旧存档中已有的 world_engine/world_link 记录仍受上方回滚与撤回逻辑正常维护）
  async function ingestWorldEvolution() {
    return { skipped: true, reason: 'readonly_weak_coupling', lightweight: true, added: 0, addedSmall: 0 };
  }

  function invalidateWorldCommits(ids) {
    const removed = new Set(Array.isArray(ids) ? ids : []);
    if (!removed.size) return { changed: false };
    const state = data().loadState();
    const tl = ensureTimelineState(state);
    const archive = state.world_commit_archive || { nodes: [], chronicle: [] };
    archive.nodes = Array.isArray(archive.nodes) ? archive.nodes : [];
    archive.chronicle = Array.isArray(archive.chronicle) ? archive.chronicle : [];
    const preserve = (items, value) => {
      const idx = items.findIndex(item => item.record?.id === value.record.id && item.record?.worldCommitId === value.record.worldCommitId);
      if (idx < 0) items.push(value); else items[idx] = value;
    };
    tl.nodes.forEach((record, position) => { if (removed.has(record.worldCommitId)) preserve(archive.nodes, { record: clone(record), position }); });
    (state.tables.chronicle || []).forEach((record, position) => { if (removed.has(record.worldCommitId)) preserve(archive.chronicle, { record: clone(record), position }); });
    state.world_commit_archive = archive;
    const beforeN = tl.nodes.length, beforeC = (state.tables.chronicle || []).length;
    tl.nodes = tl.nodes.filter(n => !removed.has(n.worldCommitId));
    state.tables.chronicle = (state.tables.chronicle || []).filter(r => !removed.has(r.worldCommitId));
    if (beforeN === tl.nodes.length && beforeC === state.tables.chronicle.length) return { changed: false };
    abortController?.abort();
    data().saveState(replayTimeline(state));
    applyInjection();
    return { changed: true, removedNodes: beforeN - tl.nodes.length, removedMinutes: beforeC - state.tables.chronicle.length };
  }

  function restoreActiveWorldContributions() {
    const state = data().loadState(), archive = state.world_commit_archive;
    if (!archive || !window.STORY_ENGINE_HISTORY?.isCommitActive || window.STORY_ENGINE_HISTORY.isApplying?.() === true) return false;
    const active = record => record?.worldCommitId && window.STORY_ENGINE_HISTORY.isCommitActive(record.worldCommitId) === true;
    const tl = ensureTimelineState(state);
    let changed = false;
    const insert = (items, record, position) => items.splice(Math.max(0, Math.min(items.length, Number(position) || 0)), 0, record);
    archive.nodes = (archive.nodes || []).filter(entry => {
      if (!active(entry.record)) return true;
      const rec = clone(entry.record);
      if (!tl.nodes.some(item => item.worldCommitId === rec.worldCommitId && item.sourceDigest === rec.sourceDigest)) {
        rec.status = 'valid'; insert(tl.nodes, rec, entry.position);
      }
      changed = true; return false;
    });
    const chronArchive = archive.chronicle || archive.smallSummaries || [];
    const remainingChron = chronArchive.filter(entry => {
      if (!active(entry.record)) return true;
      const rec = clone(entry.record);
      const exists = (state.tables.chronicle || []).some(item => item.worldCommitId === rec.worldCommitId && item.sourceKey === rec.sourceKey);
      if (!exists) {
        const usedCodes = new Set((state.tables.chronicle || []).map(r => r.code_index));
        const normalizedRec = data().normalizeTableRow('chronicle', rec, (state.tables.chronicle?.length || 0) + 1, usedCodes);
        if (normalizedRec) insert(state.tables.chronicle, normalizedRec, entry.position);
      }
      changed = true; return false;
    });
    archive.chronicle = remainingChron;
    delete archive.smallSummaries;
    if (!changed) return false;
    if (!archive.nodes.length && !archive.chronicle.length) delete state.world_commit_archive;
    data().saveState(replayTimeline(state));
    return true;
  }

  function getQuarantineBackup(backupKey) {
    const cid = data()?.getChatId?.() || 'default';
    const prefix = `memory_engine_quarantine_${cid}_`;
    const k = clean(backupKey || window.WORLD_ENGINE_STORE?.getItem(`memory_engine_quarantine_latest_${cid}`));
    if (!k.startsWith(prefix)) return null;
    try { return JSON.parse(window.WORLD_ENGINE_STORE?.getItem(k) || 'null'); } catch (_) { return null; }
  }

  function quarantineUnprovenancedHistory(options) {
    const state = data().loadState(), cid = data().getChatId(), tl = ensureTimelineState(state);
    const checkpoint = data().loadCheckpoint?.() || null, linkCheckpoint = data().loadLinkCheckpoint?.() || null;
    const stamp = Date.now(), prefix = `memory_engine_quarantine_${cid}_`;
    let backupKey = prefix + stamp, suffix = 0;
    while (window.WORLD_ENGINE_STORE?.getItem(backupKey) != null) backupKey = prefix + stamp + '_' + ++suffix;
    const backup = {
      type: 'memory-engine-quarantine-backup',
      version: 2,
      chatId: cid,
      createdAt: stamp,
      reason: clean(options?.reason || '作者显式从头重建，隔离无来源记忆'),
      state: clone(state),
      checkpoint: clone(checkpoint),
      linkCheckpoint: clone(linkCheckpoint)
    };
    const store = window.WORLD_ENGINE_STORE;
    const ownsTx = typeof store.beginTransaction === 'function' && !store.isTransactionActive?.();
    if (ownsTx) store.beginTransaction();
    try {
      store.setItem(backupKey, JSON.stringify(backup));
      store.setItem(`memory_engine_quarantine_latest_${cid}`, backupKey);
      try { window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.createSnapshot?.('无来源记忆隔离前完整备份'); } catch (_) {}
      abortController?.abort();
      const supported = rec => {
        if (rec?.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(rec.worldCommitId) === true) return true;
        const refs = rec?.sourceRefs;
        return Array.isArray(refs) && refs.length > 0 && refs.every(ref => clean(ref.chatId) === cid && clean(ref.messageId) && ref.synthetic !== true);
      };
      const audited = rec => {
        if (rec?.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(rec.worldCommitId) === true) return true;
        return timelineApi()?.auditRefs?.(rec.sourceRefs)?.valid === true;
      };
      const counts = { rootRows: data().tableRowCounts({ tables: tl.root?.base?.tables }).totalRows, manualNodes: 0, unprovenancedNodes: 0, staleNodes: 0, chronicleRows: 0 };
      tl.nodes = tl.nodes.filter(node => {
        if (node.kind === 'manual_snapshot' || node.snapshot) { counts.manualNodes++; return false; }
        if (!supported(node)) { counts.unprovenancedNodes++; return false; }
        node.status = audited(node) ? 'valid' : 'stale';
        if (node.status === 'stale') counts.staleNodes++;
        return true;
      });
      tl.root.base = { tables: data().emptyTables(), round: 0, chatLayer: null };
      state.tables.chronicle = (state.tables.chronicle || []).filter(row => {
        if (!supported(row)) { counts.chronicleRows++; return false; }
        row.status = audited(row) ? 'valid' : 'stale';
        return true;
      });
      state.rebaseLayer = currentLayer();
      const safe = replayTimeline(state);
      data().saveState(safe);
      data().saveCheckpoint(safe);
      data().clearLinkCheckpoint?.();
      const persistence = ownsTx ? store.commitTransaction() : Promise.resolve();
      window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.afterEvolution?.();
      applyInjection();
      refreshMemoryPanel();
      return { changed: true, backupKey, quarantined: counts, retainedNodes: safe.timeline.nodes.length, needsAuthorReview: true, persistence };
    } catch (error) {
      if (ownsTx && store.isTransactionActive?.()) store.rollbackTransaction();
      throw error;
    }
  }

  // ==================== 向量召回同步与事件生命周期 ====================

  function refreshVectorRecallAsync(stateOverride) {
    try {
      const st = settings();
      if (st.engineEnabled === false) return;
      const vecApi = window.MEMORY_ENGINE_VECTOR;
      if (!vecApi) return;
      vecApi.pruneVectorsForState?.(stateOverride);
      if (st.vectorEnabled !== true || vecApi.isRunning?.()) return;
      const scan = chat().slice(-Math.max(1, parseInt(st.searchDepth, 10) || 5)).map(m => clean(m?.mes)).join('\n');
      if (scan && typeof vecApi.recallForQuery === 'function') {
        Promise.resolve(vecApi.recallForQuery(scan, { state: stateOverride })).catch(err =>
          console.warn('[记忆引擎] 后台语义向量检索失败（已隔离）', err)
        );
      } else if (st.vectorAutoMaintain !== false && typeof vecApi.maintainVectors === 'function') {
        Promise.resolve(vecApi.maintainVectors({ state: stateOverride })).catch(err =>
          console.warn('[记忆引擎] 后台语义向量维护失败（已隔离）', err)
        );
      }
    } catch (_) {}
  }

  // 对齐 shujuku chat-mutation-scheduler：Trailing (1.2s) + MaxWait (3s) + 代次串行化，防止狂滑重入
  function cancelMutationRefresh() {
    clearTimeout(mutationTimer);
    mutationTimer = null;
    mutationGeneration++;
    mutationFirstAt = 0;
    mutationPending = false;
  }

  function scheduleMutationRefresh(reason, options = {}) {
    mutationReason = reason || '历史变化';
    if (options.refillUncovered) mutationRefillRequested = true;
    mutationGeneration++;
    const now = Date.now();
    if (!mutationFirstAt) mutationFirstAt = now;

    if (now - mutationFirstAt >= MUTATION_MAX_WAIT_MS) {
      clearTimeout(mutationTimer);
      mutationTimer = null;
      void runMutationRound();
      return;
    }
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      void runMutationRound();
    }, MUTATION_TRAILING_MS);
  }

  async function runMutationRound() {
    if (mutationRunning) {
      mutationPending = true;
      return;
    }
    mutationRunning = true;
    const startedGen = mutationGeneration;
    const shouldRefill = mutationRefillRequested;
    mutationFirstAt = 0;
    mutationRefillRequested = false;
    try {
      await prepareHistoryForGeneration({ pruneDead: true, respectDelay: true });
      const st = settings();
      if (shouldRefill && !generationActive && st.engineEnabled !== false && st.evolveMode === 'auto' && st.autoRefillOnHistoryChange !== false) {
        if (!(window.STORY_ENGINE_PROJECTION?.active?.() === true && window.STORY_ENGINE_HISTORY?.getStatus?.().blocked === true)) {
          await reconcileHistory({ respectDelay: true, refillUncovered: true });
        }
      }
    } catch (error) {
      console.error(`[记忆引擎] ${mutationReason} 刷新失败`, error);
    } finally {
      mutationRunning = false;
      if (mutationPending && mutationGeneration > startedGen) {
        mutationPending = false;
        void runMutationRound();
      }
    }
  }

  function onMessageReceived() {
    generationActive = false;
    const all = chat();
    const lastMsg = all.at(-1);
    if (lastMsg && !isFillEligibleAiMessage(lastMsg)) return;
    const key = `${currentLayer()}:${clean(lastMsg?.mes).slice(-80)}`;
    if (key === lastEventKey) return;
    lastEventKey = key;
    const capturedEpoch = autoFillEpoch;
    clearTimeout(autoTimer);
    if (window.STORY_ENGINE_BRIDGE?.shouldCoordinateGeneration?.()) {
      window.STORY_ENGINE_BRIDGE.scheduleTurn?.({
        scope: 'memory',
        layer: currentLayer(),
        key,
        run: async () => {
          if (capturedEpoch !== autoFillEpoch) return;
          const res = await autoExtract(capturedEpoch);
          refreshVectorRecallAsync();
          return res;
        }
      });
      return;
    }
    autoTimer = setTimeout(async () => {
      if (capturedEpoch !== autoFillEpoch) return;
      try {
        await autoExtract(capturedEpoch);
      } catch (error) {
        console.error('[记忆引擎] 自动填表失败', error);
      } finally {
        refreshVectorRecallAsync();
      }
    }, 1500);
  }

  function guardEvent(label, handler) {
    if (typeof window.WORLD_ENGINE_GUARD_EVENT === 'function') {
      return window.WORLD_ENGINE_GUARD_EVENT('记忆引擎', label, handler);
    }
    return function(...args) {
      try {
        const result = handler(...args);
        if (result && typeof result.then === 'function') {
          return result.catch(error => console.error(`[记忆引擎] ${label}事件处理失败`, error));
        }
        return result;
      } catch (error) {
        console.error(`[记忆引擎] ${label}事件处理失败`, error);
      }
    };
  }

  function ensureAutoBaselineForExistingChat() {
    const st = settings();
    if (st.engineEnabled === false) return;
    const allAi = collectEligibleAiLayers(st);
    if (!allAi.length) return;
    const state = data().loadState();
    const counts = data().tableRowCounts(state);
    const hasNodes = (state.timeline?.nodes || []).length > 0;
    if (counts.totalRows === 0 && !hasNodes && state.chatLayer === null && state.autoBaselineLayer === null && state.rebaseLayer === null) {
      state.autoBaselineLayer = allAi[allAi.length - 1];
      data().saveState(state);
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    ensureAutoBaselineForExistingChat();
    const ctx = context(), types = ctx?.event_types || {};
    if (ctx?.eventSource) {
      ctx.eventSource.on(types.GENERATION_ENDED || types.MESSAGE_RECEIVED || 'message_received', guardEvent('生成完成', onMessageReceived));
      ctx.eventSource.on(types.GENERATION_STOPPED || 'generation_stopped', guardEvent('生成中止', () => {
        generationActive = false;
      }));

      const onChatChange = () => {
        generationActive = false;
        bumpAutoFillEpoch();
        window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
        clearTimeout(autoTimer);
        cancelMutationRefresh();
        abortController?.abort();
        lastEventKey = '';
        ensureAutoBaselineForExistingChat();
        void prepareHistoryForGeneration({ pruneDead: true, respectDelay: true });
      };
      ctx.eventSource.on(types.CHAT_LOADED || 'chat_loaded', guardEvent('聊天加载', onChatChange));
      const chatChangedEvent = types.CHAT_CHANGED || 'chat_id_changed';
      if (chatChangedEvent !== (types.CHAT_LOADED || 'chat_loaded')) {
        ctx.eventSource.on(chatChangedEvent, guardEvent('聊天切换', onChatChange));
      }

      // 对齐 shujuku #56：删楼事件直接 await 同步撤旧、重放并刷新注入（0ms 重生成脏读窗口！）
      ctx.eventSource.on(types.MESSAGE_DELETED || 'message_deleted', guardEvent('删除消息', async () => {
        bumpAutoFillEpoch();
        window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
        clearTimeout(autoTimer);
        cancelMutationRefresh();
        abortController?.abort();
        lastEventKey = '';
        await prepareHistoryForGeneration({ pruneDead: true, respectDelay: true });
        if (!generationActive) scheduleMutationRefresh('删除楼层', { refillUncovered: true });
      }));

      // 滑动与编辑走代次防抖调度（Trailing 1.2s + MaxWait 3s）
      ctx.eventSource.on(types.MESSAGE_SWIPED || 'message_swiped', guardEvent('滑动重生成', () => {
        bumpAutoFillEpoch();
        window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
        clearTimeout(autoTimer);
        abortController?.abort();
        lastEventKey = '';
        if (window.STORY_ENGINE_PROJECTION?.active?.() === true) applyInjection();
        else if (!rollbackLinkedLayer(currentLayer())) applyInjection({ isReroll: true });
        scheduleMutationRefresh('滑动切换', { refillUncovered: !generationActive });
      }));

      ctx.eventSource.on(types.MESSAGE_EDITED || 'message_edited', guardEvent('编辑消息', () => {
        bumpAutoFillEpoch();
        window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
        clearTimeout(autoTimer);
        abortController?.abort();
        lastEventKey = '';
        runLocalAuditAndReplay({ pruneDead: true });
        applyInjection();
        scheduleMutationRefresh('编辑重写', { refillUncovered: !generationActive });
      }));

      ctx.eventSource.on(types.GENERATION_STARTED || 'generation_started', guardEvent('生成开始', (type, _opts, dryRun) => {
        if (!dryRun) {
          generationActive = true;
          cancelMutationRefresh();
          window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
          // 生成开始前兜底同步裁剪任何已删除/失效来源，确保 0 脏注入
          runLocalAuditAndReplay({ pruneDead: true });
          applyInjection({ isReroll: type === 'swipe' || type === 'regenerate' });
        }
      }));
    }
    try { applyInjection(); }
    catch (error) { console.error('[记忆引擎] 首次注入失败', error); }
  }

  return {
    init,
    applyInjection,
    buildWorldEngineContext,
    ingestWorldEvolution,
    manualExtract,
    manualReextract,
    extractNow: manualExtract,
    reconcileHistory,
    prepareHistoryForGeneration,
    replayTimeline,
    commitManualState,
    invalidateWorldCommits,
    syncVerifiedOutlineKnowledge,
    getSnapshotSummaryForBridge,
    quarantineUnprovenancedHistory,
    getQuarantineBackup,
    manualSmallSummary,
    fillSummaryRange,
    prepareCatchUpPlan,
    catchUpToLatest,
    getSummaryCoverageStatus,
    backfill,
    backfillSummaries,
    stopBackfill,
    abort,
    getLastDebug: () => clone(lastDebug),
    getLastError: () => lastError,
    getLastInjectionDebug: () => clone(lastInjectionDebug),
    getBackfillStatus: () => clone(backfillStatus),
    getSummaryBackfillStatus: () => clone(summaryBackfillStatus),
    getRunningLabel: () => runningLabel,
    isRunning: () => running || backfillRunning || reconciling,
    _test: {
      isFillEligibleAiMessage,
      formatLayerSpan,
      collectEligibleAiLayers,
      getEffectiveSummaryDelay,
      stableAutoEndLayer,
      parseAndValidateTableResponse,
      extractJsonObject,
      buildBatchFromAiLayers,
      previousRawReference,
      selectHiddenMessageIds,
      recentRawRoundMessageIds,
      scoreArchivedChronicle,
      tokenizeSearchText,
      rollbackLinkedLayer,
      removeLinkedLayerFromState,
      auditStoredSources,
      autoExtract,
      getSummaryCoverageStatus,
      prepareCatchUpPlan,
      fillSummaryRange,
      catchUpToLatest,
      executeTableFillBatch,
      getAutoFillEpoch: () => autoFillEpoch,
      bumpAutoFillEpoch
    }
  };
})();
