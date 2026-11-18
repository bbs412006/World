// 记忆引擎运行链：复用世界引擎的 API、过滤、世界书、存档和注入机制。
window.MEMORY_ENGINE = (function() {
  const INJECTION_NAME = 'memory-engine-memory';
  const SENTINEL = '【记忆信息】';
  const DEFAULT_INJECTION_DICE_SIDES = 10000;
  const ENTITY_TYPES = ['organization', 'object', 'ability', 'location'];
  const ENTITY_LABELS = { organization: '组织', object: '物件', ability: '能力', location: '地点' };
  let initialized = false, running = false, backfillRunning = false, reconciling = false;
  let runningLabel = '';
  let abortController = null, autoTimer = null, lastEventKey = '';
  let hiddenSyncPromise = Promise.resolve();
  let lastDebug = { prompt: '', rawResult: '', parsed: null, error: '' };
  let backfillStatus = { running: false, current: 0, total: 0, message: '' };
  let summaryBackfillStatus = { running: false, current: 0, total: 0, message: '' };

  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const clean = v => String(v == null ? '' : v).trim();
  const unique = list => Array.from(new Set((list || []).map(clean).filter(Boolean)));
  const normalized = v => clean(v).toLocaleLowerCase();
  const settings = () => window.MEMORY_ENGINE_SETTINGS?.getSettings(true) || {};
  const data = () => window.MEMORY_ENGINE_DATA;
  const timelineApi = () => window.MEMORY_ENGINE_TIMELINE;
  function setExternalStatus(text, isError) {
    window.__WE_SetExternalStatus?.(text, !!isError);
  }
  function refreshMemoryPanel() {
    window.WORLD_ENGINE_UI?.refresh?.(true);
  }
  function context() { try { return SillyTavern.getContext(); } catch (_) { return null; } }
  const chat = () => context()?.chat || [];
  const currentLayer = () => Math.max(0, chat().length - 1);
  const ignoreFirstLayer = st => st?.firstLayerIsAiOpening !== false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function configuredNameBlacklist(st) {
    return new Set(clean(st?.nameBlacklist).split(/\r?\n/).map(normalized).filter(Boolean));
  }

  function nameIsBlacklisted(value, blacklist) {
    const names = Array.isArray(value) ? value : [value];
    return names.some(name => blacklist.has(normalized(name)));
  }

  function rollbackLinkedLayer(layer) {
    const state = data()?.loadState?.();
    if (!state) return false;
    const removed = removeLinkedLayerFromState(state, layer);
    if (!removed.removed) return false;
    data().saveState(replayTimeline(state));
    applyInjection();
    return true;
  }

  // 每条候选记录各掷一次离散骰子，再按指数衰减权重计算优先级。
  // 最新记录权重最高；最旧记录的权重至少为 1 / 骰子面数，因此始终保留非零机会。
  function exponentialMemorySample(items, limit, randomFn = Math.random, diceSides = DEFAULT_INJECTION_DICE_SIDES) {
    const source = Array.isArray(items) ? items : [];
    const take = Math.max(0, Math.min(source.length, parseInt(limit) || 0));
    if (!take || !source.length) return [];
    if (source.length <= take) return source.slice();
    const sides = Math.max(1000, Math.min(10000, parseInt(diceSides) || DEFAULT_INJECTION_DICE_SIDES));
    const scale = Math.max(1, take);
    return source.map((item, index) => {
      const age = source.length - 1 - index;
      const weight = Math.max(1 / sides, Math.exp(-age / scale));
      const roll = Math.max(1, Math.min(sides, Math.floor(Number(randomFn()) * sides) + 1));
      const unit = roll / (sides + 1);
      return { item, index, priority: -Math.log(unit) / weight };
    }).sort((a, b) => a.priority - b.priority)
      .slice(0, take)
      .sort((a, b) => a.index - b.index)
      .map(entry => entry.item);
  }

  function formatMessages(messages, startLayer) {
    const ctx = context();
    return (messages || []).map((message, i) => {
      const fallback = message?.is_user ? (ctx?.name1 || '用户') : (ctx?.name2 || '角色');
      return `[楼层 ${Number(startLayer || 0) + i}]【${clean(message?.name) || fallback}】\n${clean(message?.mes)}`;
    }).filter(Boolean).join('\n\n');
  }

  function recentConversation(rounds) {
    return recentConversationBatch(rounds).conversation;
  }

  function recentConversationBatch(rounds) {
    const all = chat(), count = Math.max(1, parseInt(rounds) || 1) * 2;
    const start = Math.max(ignoreFirstLayer(settings()) ? 1 : 0, all.length - count);
    const end = Math.max(start, all.length - 1);
    return {
      startLayer: start,
      endLayer: end,
      conversation: formatMessages(all.slice(start), start),
      sourceRefs: timelineApi()?.captureRange?.(start, end) || []
    };
  }

  function extractStoryTime(text) {
    const found = Array.from(String(text || '').matchAll(/『([^』]*(?:年|月|日|时|刻)[^』]*)』/g));
    return found.length ? clean(found.at(-1)[1].split('丨').slice(0, 3).join(' ')) : '';
  }

  function filterConversation(conversation, st) {
    return window.WORLD_ENGINE_CORE?.filterDialogue?.(
      conversation, { evolveFilterRegex: st.filterRegex || '' }
    ) || conversation;
  }

  function previousRawReference(task, roundCount, st) {
    const count = Math.max(0, parseInt(roundCount) || 0);
    const all = chat();
    const boundary = Number.isFinite(Number(task?.startLayer)) ? Number(task.startLayer) : all.length;
    if (!count || boundary <= 0) return { conversation: '', startLayer: boundary, endLayer: boundary - 1 };
    const aiLayers = all.map((message, index) => (
      index < boundary && !(ignoreFirstLayer(st || settings()) && index === 0) && message && !message.is_user ? index : -1
    )).filter(index => index >= 0).slice(-count);
    if (!aiLayers.length) return { conversation: '', startLayer: boundary, endLayer: boundary - 1 };
    const firstAi = aiLayers[0];
    let start = firstAi;
    for (let index = firstAi - 1; index >= 0; index--) {
      if (all[index] && !all[index].is_user) break;
      start = index;
    }
    const end = aiLayers.at(-1);
    return {
      conversation: formatMessages(all.slice(start, end + 1), start),
      startLayer: start,
      endLayer: end
    };
  }

  function buildTaskReferenceContext(state, task, st) {
    const eventMemory = ensureEventState(state);
    const rawCount = st?.referenceRawRounds === undefined ? 1 : Math.max(0, parseInt(st.referenceRawRounds) || 0);
    const raw = previousRawReference(task, rawCount, st);
    const rawBoundary = raw.conversation
      ? raw.startLayer
      : (Number.isFinite(Number(task?.startLayer)) ? Number(task.startLayer) : Infinity);
    const currentChatId = clean(data()?.getChatId?.());
    const valid = item => item?.status !== 'stale' && item?.status !== 'failed' && clean(item?.content);
    const beforeLayer = (item, layer) => {
      const originChatId = clean(item?.originChatId);
      if (originChatId && currentChatId && originChatId !== currentChatId) return true;
      return Number(item?.endLayer) < layer;
    };
    const smallCount = st?.referenceSmallSummaryCount === undefined
      ? 5 : Math.max(0, parseInt(st.referenceSmallSummaryCount) || 0);
    const bigCount = st?.referenceBigSummaryCount === undefined
      ? 1 : Math.max(0, parseInt(st.referenceBigSummaryCount) || 0);
    const eligibleSmall = eventMemory.small_summaries
      .filter(item => valid(item) && beforeLayer(item, rawBoundary));
    const historySmallSummaries = smallCount ? eligibleSmall.slice(-smallCount) : [];
    const currentChatSmall = historySmallSummaries.find(item => {
      const originChatId = clean(item?.originChatId);
      return !originChatId || !currentChatId || originChatId === currentChatId;
    });
    const bigBoundary = currentChatSmall ? Number(currentChatSmall.startLayer) : rawBoundary;
    const eligibleBig = eventMemory.big_summaries
      .filter(item => valid(item) && beforeLayer(item, bigBoundary));
    const historyBigSummaries = bigCount ? eligibleBig.slice(-bigCount) : [];
    const parts = [];
    if (historyBigSummaries.length) parts.push(`【更早总述】\n${historyBigSummaries.map((item, index) =>
      `${index + 1}. [楼层 ${Number(item?.startLayer) || 0}-${Number(item?.endLayer) || 0}] ${clean(item?.content)}`
    ).join('\n')}`);
    if (historySmallSummaries.length) parts.push(`【前置纪要】\n${historySmallSummaries.map((item, index) =>
      `${index + 1}. [楼层 ${Number(item?.startLayer) || 0}-${Number(item?.endLayer) || 0}] ${clean(item?.content)}`
    ).join('\n')}`);
    if (raw.conversation) parts.push(`【近期正文】\n${filterConversation(raw.conversation, st)}`);
    return { historyBigSummaries, historySmallSummaries, raw, text: parts.join('\n\n') };
  }

  function buildSmallHistoryContext(state, task) {
    const st = settings();
    const context = buildTaskReferenceContext(state, task, st);
    return {
      historyBigSummaries: context.historyBigSummaries,
      historySmallSummaries: context.historySmallSummaries
    };
  }

  function buildRequestPrompt_hints() {
    try { return window.STORY_ENGINE_BRIDGE?.getMemoryExtractionHints?.() || {}; }
    catch (_) { return {}; }
  }

  async function buildRequestPrompt(tasks, state, st) {
    const segments = [];
    const hints = buildRequestPrompt_hints();
    const enableStructured = st?.enableFactAndArcExtraction !== false;
    const memoryReference = tasks.memory ? buildTaskReferenceContext(state, tasks.memory, st) : null;
    const sharesReference = Boolean(tasks.memory && tasks.small
      && Number(tasks.memory.startLayer) === Number(tasks.small.startLayer)
      && Number(tasks.memory.endLayer) === Number(tasks.small.endLayer));
    const smallReference = tasks.small && !sharesReference
      ? buildTaskReferenceContext(state, tasks.small, st) : null;
    if (tasks.memory) {
      const filtered = filterConversation(tasks.memory.conversation, st);
      let worldbook = '';
      if (st.worldbookEnabled && window.WORLD_ENGINE_WORLDBOOK?.buildPromptSection) {
        worldbook = await window.WORLD_ENGINE_WORLDBOOK.buildPromptSection(filtered, 'memory');
      }
      const activeOngoingFacts = (state.ongoing_facts || []).filter(item => item?.status !== 'resolved' && item?.status !== 'superseded').slice(-20);
      const knownCharacterArcs = Array.isArray(state.character_arcs) ? state.character_arcs.slice(0, 20) : [];
      const user = window.MEMORY_ENGINE_PROMPT.buildUserPrompt({
        currentStoryTime: extractStoryTime(filtered),
        knownPeople: (state.personal_memory || []).map(character => unique(character.names)),
        knownEntities: ENTITY_TYPES.flatMap(type => (state.entity_memory?.[type] || []).map(entity => ({
          type: ENTITY_LABELS[type], name: entity.name, aliases: unique(entity.aliases), description: entity.description
        }))),
        activeOngoingFacts: enableStructured ? activeOngoingFacts : [],
        knownCharacterArcs: enableStructured ? knownCharacterArcs : [],
        outlineFocusHint: clean(hints.outlineFocusHint),
        worldContextHint: clean(hints.worldContextHint),
        worldbook,
        referenceContext: memoryReference?.text || '',
        conversation: filtered
      });
      segments.push(`【任务说明】\n${window.MEMORY_ENGINE_PROMPT.TASK_PROMPT || window.MEMORY_ENGINE_PROMPT.SYSTEM_PROMPT}\n\n${user}`);
    }
    if (tasks.small) {
      segments.push(`【任务说明】\n${window.MEMORY_ENGINE_SMALL_SUMMARY_PROMPT.SYSTEM_PROMPT}\n\n${window.MEMORY_ENGINE_SMALL_SUMMARY_PROMPT.buildUserPrompt({
        ...tasks.small,
        reuseConversation: sharesReference,
        outlineFocusHint: clean(hints.outlineFocusHint),
        referenceContext: sharesReference && memoryReference?.text
          ? '沿用同一请求前文人物/实体任务中的【只读辅助参考】，不得把其中旧内容写成本段新增事件。'
          : (smallReference?.text || ''),
        conversation: filterConversation(tasks.small.conversation, st)
      })}`);
    }
    if (tasks.big) {
      segments.push(`【任务说明】\n${window.MEMORY_ENGINE_BIG_SUMMARY_PROMPT.SYSTEM_PROMPT}\n\n${window.MEMORY_ENGINE_BIG_SUMMARY_PROMPT.buildUserPrompt({
        ...tasks.big
      })}`);
    }
    const fields = [];
    if (tasks.memory) {
      fields.push(`"personal_memory": [
    {
      "name": ["人物名或别名"],
      "known_by": ["其他知情人物名"],
      "memory": "一条独立的人物主观记忆",
      "time": "这条记忆对应的绝对故事时间或空字符串"
    }
  ]`, `"entity_updates": [
    {
      "type": "organization、object、ability、location 四者之一",
      "name": "实体名称",
      "aliases": ["实体别名"],
      "description": "当前描述或空字符串",
      "event": "一条独立的本批新增重要事件或空字符串",
      "time": "这条事件对应的绝对故事时间或空字符串"
    }
  ]`);
      if (enableStructured) {
        fields.push(`"ongoing_fact_updates": [
    {
      "action": "upsert 或 resolve",
      "id": "修订/完结已有事实时填 fact_xxxxxx，新增填空字符串",
      "category": "状态、契约、设定、持有、伤病、关系定性、环境 之一",
      "subject": "事实主体（角色/物品/地点/全局）",
      "fact": "当前生效的简明持续事实（不超过120字）",
      "keywords": ["检索关键词"]
    }
  ]`, `"character_arc_updates": [
    {
      "name": "人物规范名称",
      "current_stance": "当前态度/立场（不超过60字）",
      "arc_summary": "近期心理转变与关系弧光摘要（不超过120字）",
      "relationship": "当前关系定性标签",
      "progress_pct": 0
    }
  ]`);
      }
    }
    if (tasks.small) {
      fields.push('"small_summary": ""');
      if (enableStructured) {
        fields.push('"small_summary_keywords": []', '"small_summary_entities": []', '"small_summary_impact": "normal"');
      }
    }
    if (tasks.big) {
      fields.push('"big_summary": ""');
      if (enableStructured) fields.push('"big_summary_keywords": []');
    }
    const tone = clean(st.tonePrompt);
    const emptyMemory = tasks.memory
      ? '\n\n没有对应内容时分别使用 "personal_memory": [] 和 "entity_updates": []'
        + (enableStructured ? '、"ongoing_fact_updates": []、"character_arc_updates": []' : '')
        + '；不得省略字段。'
      : '';
    return `${segments.join('\n\n=====\n\n')}\n\n【统一输出要求】\n只输出一个合法 JSON 对象，不要输出 Markdown、代码围栏或解释。严格按照以下完整结构返回；模板文字替换为实际内容：\n{\n  ${fields.join(',\n  ')}\n}${emptyMemory}${tone ? `\n\n【附加要求】\n${tone}` : ''}`;
  }

  function extractBalancedJsonSpan(text) {
    let result = null;
    let inString = false;
    let escaped = false;
    let rootChar = '';
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (!rootChar && (ch === '{' || ch === '[')) {
        rootChar = ch;
        start = i;
        depth = 1;
      } else if (rootChar) {
        const open = rootChar;
        const close = open === '{' ? '}' : ']';
        if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0 && start !== -1) {
            try {
              const parsed = JSON.parse(text.slice(start, i + 1));
              if (parsed && typeof parsed === 'object') result = parsed;
            } catch (_) {}
            rootChar = '';
            start = -1;
          }
        }
      }
    }
    return result;
  }

  function parseJsonPayload(raw) {
    let text = clean(raw);
    if (!text) throw new Error('API 返回中没有合法 JSON 对象或数组');
    // 剔除思考模型常见 <think>/<thought>/<reasoning> 包装，避免其中方括号或花括号误导截取
    text = text.replace(/<(?:think|thought|reasoning)\b[^>]*>[\s\S]*?<\/(?:think|thought|reasoning)>/gi, '').trim();
    const candidates = [];
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match;
    while ((match = fenceRe.exec(text)) !== null) {
      const inner = clean(match[1]);
      if (inner) candidates.push(inner);
    }
    candidates.reverse();
    const strippedTop = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (strippedTop) candidates.push(strippedTop);

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_) {}
      const balanced = extractBalancedJsonSpan(candidate);
      if (balanced) return balanced;
      try {
        const repaired = window.WORLD_ENGINE_API?.parseJSON?.(candidate);
        if (repaired && typeof repaired === 'object') return repaired;
      } catch (_) {}
    }
    throw new Error('API 返回中没有合法 JSON 对象或数组');
  }

  function parseResponse(raw, tasks) {
    const value = parseJsonPayload(raw);
    const nameBlacklist = configuredNameBlacklist(settings());
    // 兼容 0.1.x：旧 API 只返回人物记忆数组。
    const personalValue = tasks.memory ? (Array.isArray(value)
      ? value
      : (value?.personal_memory || value?.memories || value?.memory || value?.data || [])) : [];
    const personalSource = Array.isArray(personalValue)
      ? personalValue
      : (personalValue && typeof personalValue === 'object' ? [personalValue] : []);
    const counts = new Map(), personal = [];
    for (const item of personalSource) {
      if (!item || typeof item !== 'object') continue;
      if (nameIsBlacklisted(item.name, nameBlacklist)) continue;
      const names = unique(Array.isArray(item.name) ? item.name : [item.name]), memory = clean(item.memory);
      if (!names.length || !memory) continue;
      const holder = normalized(names[0]), count = counts.get(holder) || 0;
      if (count >= 3) continue;
      counts.set(holder, count + 1);
      let time = clean(item.time);
      if (/^(昨晚|昨天|三天前|刚才|不久前|宴会之后)$/.test(time)) time = '';
      personal.push({
        name: names,
        known_by: unique(Array.isArray(item.known_by) ? item.known_by : [item.known_by])
          .filter(name => !names.some(holderName => normalized(holderName) === normalized(name))),
        memory,
        time
      });
      if (personal.length >= 8) break;
    }
    const entityValue = tasks.memory && !Array.isArray(value) ? value?.entity_updates : [];
    const entitySource = Array.isArray(entityValue)
      ? entityValue
      : (entityValue && typeof entityValue === 'object' ? [entityValue] : []);
    const entities = {};
    for (const type of ENTITY_TYPES) entities[type] = [];
    const perEntityCounts = new Map();
    let entityUpdateCount = 0;
    for (const item of entitySource) {
      if (entityUpdateCount >= 8) break;
      if (!item || typeof item !== 'object') continue;
      const aliases = unique(Array.isArray(item.aliases) ? item.aliases : [item.aliases]);
      if (nameIsBlacklisted([item.name, ...aliases], nameBlacklist)) continue;
      if (!ENTITY_TYPES.includes(item.type)) continue;
      const type = item.type, name = clean(item.name), description = clean(item.description), event = clean(item.event);
      if (!name) continue;
      const cleanAliases = aliases.filter(alias => normalized(alias) !== normalized(name));
      const key = `${type}:${normalized(name)}`, count = perEntityCounts.get(key) || 0;
      if (count >= 3) continue;
      perEntityCounts.set(key, count + 1);
      entities[type].push({ name, aliases: cleanAliases, description, event, time: event ? sanitizeTime(item.time) : '' });
      entityUpdateCount++;
    }
    let smallSummary = '';
    let smallSummaryKeywords = [];
    let smallSummaryEntities = [];
    let smallSummaryImpact = 'normal';
    if (tasks.small && !Array.isArray(value)) {
      if (value?.small_summary && typeof value.small_summary === 'object') {
        smallSummary = clean(value.small_summary.content || value.small_summary.text);
        smallSummaryKeywords = unique(value.small_summary.keywords).slice(0, 8);
        smallSummaryEntities = unique(value.small_summary.entity_names || value.small_summary.entityNames).slice(0, 12);
        smallSummaryImpact = value.small_summary.impact === 'key' ? 'key' : 'normal';
      } else {
        smallSummary = clean(value?.small_summary);
      }
      if (!smallSummaryKeywords.length) smallSummaryKeywords = unique(value?.small_summary_keywords).slice(0, 8);
      if (!smallSummaryEntities.length) smallSummaryEntities = unique(value?.small_summary_entities).slice(0, 12);
      if (value?.small_summary_impact === 'key') smallSummaryImpact = 'key';
    }
    let bigSummary = '';
    let bigSummaryKeywords = [];
    if (tasks.big && !Array.isArray(value)) {
      bigSummary = clean(value?.big_summary);
      bigSummaryKeywords = unique(value?.big_summary_keywords).slice(0, 12);
    }
    const factUpdates = [];
    const factSource = tasks.memory && !Array.isArray(value) && Array.isArray(value?.ongoing_fact_updates) ? value.ongoing_fact_updates : [];
    for (const item of factSource) {
      if (!item || typeof item !== 'object') continue;
      const action = clean(item.action) === 'resolve' ? 'resolve' : 'upsert';
      const subject = clean(item.subject) || '全局';
      const category = clean(item.category) || '状态';
      const fact = Array.from(clean(item.fact || item.content)).slice(0, 120).join('');
      const id = clean(item.id);
      if (action === 'upsert' && !fact) continue;
      if (action === 'resolve' && !id && !fact && !subject) continue;
      if (nameIsBlacklisted([subject], nameBlacklist)) continue;
      factUpdates.push({
        action,
        id,
        category,
        subject,
        fact,
        keywords: unique(item.keywords).slice(0, 8)
      });
      if (factUpdates.length >= 10) break;
    }
    const arcUpdates = [];
    const arcSource = tasks.memory && !Array.isArray(value) && Array.isArray(value?.character_arc_updates) ? value.character_arc_updates : [];
    for (const item of arcSource) {
      if (!item || typeof item !== 'object') continue;
      const name = clean(item.name);
      if (!name || nameIsBlacklisted([name], nameBlacklist)) continue;
      const currentStance = Array.from(clean(item.current_stance ?? item.currentStance)).slice(0, 60).join('');
      const arcSummary = Array.from(clean(item.arc_summary ?? item.arcSummary)).slice(0, 120).join('');
      const relationship = Array.from(clean(item.relationship)).slice(0, 40).join('');
      const pctNum = Number(item.progress_pct ?? item.progressPct);
      const progressPct = Number.isFinite(pctNum) ? Math.max(0, Math.min(100, Math.round(pctNum))) : null;
      if (!currentStance && !arcSummary && !relationship && progressPct === null) continue;
      arcUpdates.push({ name, currentStance, arcSummary, relationship, progressPct });
      if (arcUpdates.length >= 6) break;
    }
    return {
      personal, entities, factUpdates, arcUpdates,
      smallSummary, smallSummaryKeywords, smallSummaryEntities, smallSummaryImpact,
      bigSummary, bigSummaryKeywords
    };
  }

  function sanitizeTime(value) {
    const time = clean(value);
    return /^(昨晚|昨天|三天前|刚才|不久前|宴会之后)$/.test(time) ? '' : time;
  }

  function nextCharacterId(state) {
    const max = (state.personal_memory || []).reduce((n, character) => {
      const match = /^char_(\d+)$/.exec(clean(character.id));
      return Math.max(n, match ? Number(match[1]) : 0);
    }, 0);
    return `char_${String(max + 1).padStart(6, '0')}`;
  }

  function findCharacter(state, names) {
    const wanted = new Set(unique(names).map(normalized));
    return (state.personal_memory || []).find(character =>
      (character.names || []).some(name => wanted.has(normalized(name))));
  }

  function addKnowledge(index, names, record) {
    for (const name of unique(names)) {
      const key = normalized(name);
      if (!Array.isArray(index[key])) index[key] = [];
      if (!index[key].some(item => item.ownerId === record.ownerId && item.time === record.time && item.memory === record.memory)) {
        index[key].push(clone(record));
      }
    }
  }

  function rebuildKnowledgeIndex(state) {
    const index = {};
    for (const character of state.personal_memory || []) {
      for (const [time, memories] of Object.entries(character.memory || {})) {
        for (const memory of Array.isArray(memories) ? memories : []) {
          addKnowledge(index, character.names, { ownerId: character.id, time, memory });
        }
      }
    }
    state.knowledge_index = index;
  }

  function ensureEntityState(state) {
    if (!state.entity_memory || typeof state.entity_memory !== 'object' || Array.isArray(state.entity_memory)) state.entity_memory = {};
    for (const type of ENTITY_TYPES) {
      if (!Array.isArray(state.entity_memory[type])) state.entity_memory[type] = [];
      for (const entity of state.entity_memory[type]) {
        const name = clean(entity?.name);
        entity.aliases = unique(Array.isArray(entity?.aliases) ? entity.aliases : [entity?.aliases])
          .filter(alias => normalized(alias) !== normalized(name));
      }
    }
    if (!state.entity_index || typeof state.entity_index !== 'object' || Array.isArray(state.entity_index)) state.entity_index = {};
  }

  function nextEntityId(state, type) {
    ensureEntityState(state);
    const prefix = { organization: 'org', object: 'obj', ability: 'ability', location: 'location' }[type];
    const pattern = new RegExp(`^${prefix}_(\\d+)$`);
    const max = state.entity_memory[type].reduce((number, entity) => {
      const match = pattern.exec(clean(entity.id));
      return Math.max(number, match ? Number(match[1]) : 0);
    }, 0);
    return `${prefix}_${String(max + 1).padStart(6, '0')}`;
  }

  function rebuildEntityIndex(state) {
    ensureEntityState(state);
    const index = {};
    for (const type of ENTITY_TYPES) {
      for (const entity of state.entity_memory[type]) {
        if (!clean(entity.id)) entity.id = nextEntityId(state, type);
        const names = unique([entity.name, ...(entity.aliases || [])]);
        for (const name of names) index[`${type}:${normalized(name)}`] = entity.id;
      }
    }
    state.entity_index = index;
  }

  function repairStateIndexes(state, previousState) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
    const oldState = previousState && typeof previousState === 'object' ? previousState : state;
    const oldIndex = clone(oldState.knowledge_index || {});
    const aliasTargets = {};
    const removedAliases = new Set();
    for (const oldPerson of oldState.personal_memory || []) {
      const current = (state.personal_memory || []).find(person => person.id === oldPerson.id);
      if (!current) {
        for (const oldName of oldPerson.names || []) removedAliases.add(normalized(oldName));
        continue;
      }
      for (const oldName of oldPerson.names || []) aliasTargets[normalized(oldName)] = unique(current.names || []);
    }
    rebuildKnowledgeIndex(state);
    const validRecords = new Set();
    for (const person of state.personal_memory || []) {
      for (const [time, memories] of Object.entries(person.memory || {})) {
        for (const memory of Array.isArray(memories) ? memories : []) validRecords.add(`${person.id}\u0000${time}\u0000${memory}`);
      }
    }
    for (const [oldName, records] of Object.entries(oldIndex)) {
      if (removedAliases.has(normalized(oldName))) continue;
      const targets = aliasTargets[normalized(oldName)] || [oldName];
      for (const record of Array.isArray(records) ? records : []) {
        if (!validRecords.has(`${record.ownerId}\u0000${record.time}\u0000${record.memory}`)) continue;
        addKnowledge(state.knowledge_index, targets, record);
      }
    }
    rebuildEntityIndex(state);
    return state;
  }

  function findEntity(state, type, name, aliases) {
    ensureEntityState(state);
    const names = unique([name, ...(aliases || [])]);
    let id = names.map(item => state.entity_index[`${type}:${normalized(item)}`]).find(Boolean);
    let entity = id && state.entity_memory[type].find(item => item.id === id);
    if (!entity) entity = state.entity_memory[type].find(item => {
      const existing = unique([item.name, ...(item.aliases || [])]).map(normalized);
      return names.some(candidate => existing.includes(normalized(candidate)));
    });
    if (entity) {
      if (!clean(entity.id)) entity.id = nextEntityId(state, type);
      for (const candidate of names) state.entity_index[`${type}:${normalized(candidate)}`] = entity.id;
    }
    return entity;
  }

  function mergeEntityMemories(state, groups) {
    ensureEntityState(state);
    if (!Object.keys(state.entity_index).length) rebuildEntityIndex(state);
    const result = { entities: 0, history: 0, descriptions: 0 };
    for (const type of ENTITY_TYPES) {
      for (const item of groups?.[type] || []) {
        let entity = findEntity(state, type, item.name, item.aliases);
        let isNew = false;
        if (!entity) {
          entity = { id: nextEntityId(state, type), name: item.name, aliases: unique(item.aliases), description: '', history: [] };
          state.entity_memory[type].push(entity);
          state.entity_index[`${type}:${normalized(item.name)}`] = entity.id;
          result.entities++;
          isNew = true;
        }
        entity.aliases = unique([...(entity.aliases || []), ...(item.aliases || []),
          normalized(entity.name) === normalized(item.name) ? '' : item.name])
          .filter(alias => normalized(alias) !== normalized(entity.name));
        for (const candidate of [entity.name, ...entity.aliases]) {
          state.entity_index[`${type}:${normalized(candidate)}`] = entity.id;
        }
        if (item.description && entity.description !== item.description) {
          entity.description = item.description;
          if (!isNew) result.descriptions++;
        }
        if (!Array.isArray(entity.history)) entity.history = [];
        if (item.event && !entity.history.some(old => clean(old.time) === clean(item.time) && clean(old.event) === clean(item.event))) {
          entity.history.push({ time: clean(item.time), event: clean(item.event) });
          result.history++;
        }
      }
    }
    return result;
  }

  function mergeMemories(state, items) {
    if (!state.knowledge_index || typeof state.knowledge_index !== 'object') rebuildKnowledgeIndex(state);
    let added = 0;
    for (const item of items) {
      let character = findCharacter(state, item.name);
      if (!character) {
        character = { id: nextCharacterId(state), names: [], memory: {} };
        state.personal_memory.push(character);
      }
      character.names = unique([...(character.names || []), ...item.name]);
      if (!character.memory || typeof character.memory !== 'object' || Array.isArray(character.memory)) character.memory = {};
      const time = item.time || '';
      if (!Array.isArray(character.memory[time])) character.memory[time] = [];
      const exists = Object.values(character.memory).some(list => Array.isArray(list) && list.includes(item.memory));
      if (!exists) { character.memory[time].push(item.memory); added++; }
      const record = { ownerId: character.id, time, memory: item.memory };
      addKnowledge(state.knowledge_index, character.names, record); // 持有者本人自动补入
      for (const knowerName of item.known_by) {
        let knower = findCharacter(state, [knowerName]);
        if (!knower) {
          knower = { id: nextCharacterId(state), names: [knowerName], memory: {} };
          state.personal_memory.push(knower);
        }
        addKnowledge(state.knowledge_index, knower.names, record);
      }
    }
    return added;
  }

  function replaceKnownByRecords(state, ownerId, records) {
    if (!state || typeof state !== 'object') return state;
    if (!state.knowledge_index || typeof state.knowledge_index !== 'object' || Array.isArray(state.knowledge_index)) state.knowledge_index = {};
    const owner = (state.personal_memory || []).find(character => character.id === ownerId);
    if (!owner) return state;
    for (const [name, indexed] of Object.entries(state.knowledge_index)) {
      state.knowledge_index[name] = (Array.isArray(indexed) ? indexed : []).filter(record => record.ownerId !== ownerId);
      if (!state.knowledge_index[name].length) delete state.knowledge_index[name];
    }
    for (const item of records || []) {
      const time = clean(item?.time), memory = clean(item?.memory ?? item?.content);
      if (!memory) continue;
      const record = { ownerId, time, memory };
      addKnowledge(state.knowledge_index, owner.names, record);
      for (const knowerName of unique(item?.known_by).filter(name => !(owner.names || []).some(alias => normalized(alias) === normalized(name)))) {
        let knower = findCharacter(state, [knowerName]);
        if (!knower) {
          knower = { id: nextCharacterId(state), names: [knowerName], memory: {} };
          state.personal_memory.push(knower);
        }
        addKnowledge(state.knowledge_index, knower.names, record);
      }
    }
    return state;
  }

  function ensureStructuredMemoryState(state) {
    if (!state || typeof state !== 'object') return state;
    if (!Array.isArray(state.ongoing_facts)) state.ongoing_facts = [];
    if (!Array.isArray(state.character_arcs)) state.character_arcs = [];
    return state;
  }

  function nextOngoingFactId(state) {
    const max = (state.ongoing_facts || []).reduce((n, item) => {
      const match = /^fact_(\d+)$/.exec(clean(item?.id));
      return Math.max(n, match ? Number(match[1]) : 0);
    }, 0);
    return `fact_${String(max + 1).padStart(6, '0')}`;
  }

  function nextCharacterArcId(state) {
    const max = (state.character_arcs || []).reduce((n, item) => {
      const match = /^arc_(\d+)$/.exec(clean(item?.id));
      return Math.max(n, match ? Number(match[1]) : 0);
    }, 0);
    return `arc_${String(max + 1).padStart(6, '0')}`;
  }

  function clampProgressPct(value, fallback = 0) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  function mergeOngoingFacts(state, factUpdates, layer, sourceRefs, worldCommitId) {
    ensureStructuredMemoryState(state);
    let changed = 0;
    const targetLayer = Number.isFinite(Number(layer)) ? Number(layer) : currentLayer();
    const originChatId = data()?.getChatId?.() || 'default';
    for (const item of Array.isArray(factUpdates) ? factUpdates : []) {
      if (!item || typeof item !== 'object') continue;
      const action = clean(item.action) === 'resolve' ? 'resolve' : 'upsert';
      const itemId = clean(item.id);
      const subject = clean(item.subject) || '全局';
      const category = clean(item.category) || '状态';
      const factText = Array.from(clean(item.fact || item.content)).slice(0, 120).join('');
      const keywords = unique(item.keywords);
      if (action === 'resolve') {
        for (const existing of state.ongoing_facts) {
          if (existing.status === 'resolved') continue;
          const matchById = itemId && existing.id === itemId;
          const matchByKey = !itemId
            && normalized(existing.subject) === normalized(subject)
            && normalized(existing.category) === normalized(category)
            && (!factText || normalized(existing.fact) === normalized(factText) || existing.fact.includes(factText));
          if (matchById || matchByKey) {
            existing.status = 'resolved';
            existing.updatedLayer = targetLayer;
            changed++;
          }
        }
        continue;
      }
      if (!factText) continue;
      const byId = itemId ? state.ongoing_facts.find(entry => entry.id === itemId) : null;
      const exactSame = state.ongoing_facts.find(entry =>
        entry.status === 'active'
        && normalized(entry.category) === normalized(category)
        && normalized(entry.subject) === normalized(subject)
        && normalized(entry.fact) === normalized(factText)
      );
      if (byId) {
        byId.category = category;
        byId.subject = subject;
        byId.fact = factText;
        byId.keywords = unique([...(byId.keywords || []), ...keywords]);
        byId.status = 'active';
        byId.updatedLayer = targetLayer;
        changed++;
      } else if (exactSame) {
        exactSame.keywords = unique([...(exactSame.keywords || []), ...keywords]);
        exactSame.updatedLayer = targetLayer;
      } else {
        state.ongoing_facts.push({
          id: nextOngoingFactId(state),
          category,
          subject,
          fact: factText,
          keywords,
          status: 'active',
          startLayer: targetLayer,
          updatedLayer: targetLayer,
          ...(worldCommitId ? { worldCommitId: clean(worldCommitId), source: 'world_engine' } : {}),
          sourceRefs: Array.isArray(sourceRefs) ? clone(sourceRefs) : [],
          originChatId
        });
        changed++;
      }
    }
    return changed;
  }

  function mergeCharacterArcs(state, arcUpdates, layer) {
    ensureStructuredMemoryState(state);
    if (!Array.isArray(state.personal_memory)) state.personal_memory = [];
    let updated = 0;
    const targetLayer = Number.isFinite(Number(layer)) ? Number(layer) : currentLayer();
    const originChatId = data()?.getChatId?.() || 'default';
    for (const item of Array.isArray(arcUpdates) ? arcUpdates : []) {
      if (!item || typeof item !== 'object') continue;
      const name = clean(item.name);
      if (!name) continue;
      let character = findCharacter(state, [name]);
      if (!character) {
        character = { id: nextCharacterId(state), names: [name], memory: {} };
        state.personal_memory.push(character);
      }
      let arc = state.character_arcs.find(entry =>
        (entry.characterId && entry.characterId === character.id)
        || (entry.names || []).some(n => (character.names || []).some(cn => normalized(cn) === normalized(n)))
      );
      if (!arc) {
        arc = {
          id: nextCharacterArcId(state),
          characterId: character.id,
          names: unique(character.names),
          currentStance: '',
          arcSummary: '',
          relationship: '',
          progressPct: 0,
          updatedLayer: targetLayer,
          originChatId
        };
        state.character_arcs.push(arc);
      }
      arc.characterId = character.id;
      arc.names = unique([...(arc.names || []), ...(character.names || []), name]);
      const stance = clean(item.currentStance ?? item.current_stance);
      const summary = clean(item.arcSummary ?? item.arc_summary);
      const relation = clean(item.relationship);
      if (stance) arc.currentStance = Array.from(stance).slice(0, 60).join('');
      if (summary) arc.arcSummary = Array.from(summary).slice(0, 120).join('');
      if (relation) arc.relationship = Array.from(relation).slice(0, 40).join('');
      if (item.progressPct != null || item.progress_pct != null) {
        arc.progressPct = clampProgressPct(item.progressPct ?? item.progress_pct, arc.progressPct);
      }
      arc.updatedLayer = targetLayer;
      updated++;
    }
    return updated;
  }

  function ensureEventState(state) {
    if (!state.event_memory || typeof state.event_memory !== 'object' || Array.isArray(state.event_memory)) state.event_memory = {};
    if (!Array.isArray(state.event_memory.small_summaries)) state.event_memory.small_summaries = [];
    if (!Array.isArray(state.event_memory.big_summaries)) {
      state.event_memory.big_summaries = state.event_memory.big_summary?.content ? [state.event_memory.big_summary] : [];
    }
    delete state.event_memory.big_summary;
    if (!Number.isFinite(Number(state.event_memory.big_summary_cursor))) state.event_memory.big_summary_cursor = 0;
    state.event_memory.big_summary_cursor = Math.max(0, Math.min(
      state.event_memory.small_summaries.length, Number(state.event_memory.big_summary_cursor) || 0
    ));
    return state.event_memory;
  }

  function ensureTimelineState(state) {
    if (!state.timeline || typeof state.timeline !== 'object' || Array.isArray(state.timeline)) {
      // MEMORY_ENGINE_DATA.normalizeState normally creates this; the fallback protects tests and partial imports.
      const originChatId = data()?.getChatId?.() || 'default';
      state.timeline = {
        version: 1,
        originChatId,
        root: {
          id: `root:${originChatId}`,
          originChatId,
          createdAt: Date.now(),
          base: {
            personal_memory: clone(state.personal_memory || []),
            knowledge_index: clone(state.knowledge_index || {}),
            entity_memory: clone(state.entity_memory || {}),
            entity_index: clone(state.entity_index || {}),
            ongoing_facts: clone(state.ongoing_facts || []),
            character_arcs: clone(state.character_arcs || []),
            round: Math.max(0, Number(state.round) || 0),
            chatLayer: state.chatLayer ?? null
          }
        },
        nodes: []
      };
    }
    if (!Array.isArray(state.timeline.nodes)) state.timeline.nodes = [];
    return state.timeline;
  }

  function nextTimelineNodeId(timeline) {
    const max = (timeline.nodes || []).reduce((number, node) => {
      const match = /^memory_(\d+)$/.exec(clean(node?.id));
      return Math.max(number, match ? Number(match[1]) : 0);
    }, 0);
    return `memory_${String(max + 1).padStart(6, '0')}`;
  }

  function sourceBounds(refs, fallbackLayer) {
    const layers = (refs || []).map(ref => Number(ref?.layer)).filter(Number.isFinite);
    const fallback = Number.isFinite(Number(fallbackLayer)) ? Number(fallbackLayer) : currentLayer();
    return {
      startLayer: layers.length ? Math.min(...layers) : fallback,
      endLayer: layers.length ? Math.max(...layers) : fallback
    };
  }

  function appendTimelineNode(state, extracted, task, options) {
    const timeline = ensureTimelineState(state), api = timelineApi();
    let refs = Array.isArray(task?.sourceRefs) ? clone(task.sourceRefs) : [];
    if (!refs.length && Number.isFinite(Number(task?.startLayer)) && Number.isFinite(Number(task?.endLayer))) {
      refs = api?.captureRange?.(Number(task.startLayer), Number(task.endLayer)) || [];
    }
    // 世界引擎联动等合成输入没有真实聊天正文，用跨聊天唯一的合成来源记录身份。
    if (!refs.length) {
      const originChatId = data()?.getChatId?.() || 'default';
      const layer = Number.isFinite(Number(options?.layer)) ? Number(options.layer) : currentLayer();
      const sourceText = clean(task?.conversation);
      refs = [{
        chatId: originChatId,
        messageId: clean(task?.sourceKey) || `synthetic:${originChatId}:${layer}:${api?.hashText?.(sourceText) || sourceText.length}`,
        layer,
        role: 'synthetic',
        swipeId: 0,
        hash: api?.hashText?.(sourceText) || String(sourceText.length),
        synthetic: true
      }];
    }
    const digest = api?.digestRefs?.(refs) || '';
    const existing = timeline.nodes.find(node => node.sourceDigest && node.sourceDigest === digest && node.status !== 'stale');
    if (existing) return existing;
    const bounds = sourceBounds(refs, options?.layer);
    const node = {
      id: nextTimelineNodeId(timeline),
      kind: task?.kind || 'memory',
      source: task?.kind === 'world_link' ? 'world_engine' : undefined,
      sourceKey: task?.kind === 'world_link' ? clean(task?.sourceKey) : undefined,
      worldCommitId: task?.kind === 'world_link' ? clean(task?.worldCommitId) : undefined,
      originChatId: data()?.getChatId?.() || 'default',
      startLayer: bounds.startLayer,
      endLayer: bounds.endLayer,
      sourceRefs: refs,
      sourceDigest: digest,
      personal: clone(extracted?.personal || []),
      entities: clone(extracted?.entities || {}),
      factUpdates: clone(extracted?.factUpdates || []),
      arcUpdates: clone(extracted?.arcUpdates || []),
      status: 'valid',
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    timeline.nodes.push(node);
    return node;
  }

  // 世界联动是一笔带来源标记的独立事务。重 roll 只撤销当前楼层的联动节点、
  // 世界摘要纪要及消费过这些纪要的总述；普通对话记忆和普通纪要始终保留。
  function removeLinkedLayerFromState(state, layer) {
    const numericLayer = Number(layer);
    if (!Number.isFinite(numericLayer)) return { removed: false, sourceKey: '', removedSmallIds: [] };
    const sourceKey = `${data()?.getChatId?.() || 'default'}:${numericLayer}`;
    const timeline = ensureTimelineState(state), eventMemory = ensureEventState(state);
    const matchesNode = node => {
      if (node?.kind !== 'world_link') return false;
      if (clean(node?.sourceKey) === sourceKey) return true;
      if ((node?.sourceRefs || []).some(ref => clean(ref?.messageId) === sourceKey)) return true;
      return !clean(node?.sourceKey) && Number(node?.startLayer) === numericLayer
        && Number(node?.endLayer) === numericLayer;
    };
    const matchesSmall = item => item?.source === 'world_engine' && (
      clean(item?.sourceKey) === sourceKey
      || (!clean(item?.sourceKey) && Number(item?.startLayer) === numericLayer && Number(item?.endLayer) === numericLayer)
    );

    const removedNodes = timeline.nodes.filter(matchesNode);
    const removedSmall = eventMemory.small_summaries.filter(matchesSmall);
    if (!removedNodes.length && !removedSmall.length) {
      return { removed: false, sourceKey, removedSmallIds: [] };
    }

    const removedSmallIds = new Set(removedSmall.map(item => clean(item?.id)).filter(Boolean));
    const affectedBig = eventMemory.big_summaries.filter(item =>
      (item?.childIds || []).some(id => removedSmallIds.has(clean(id)))
    );
    const affectedChildIds = new Set([
      ...removedSmallIds,
      ...affectedBig.flatMap(item => item?.childIds || []).map(clean).filter(Boolean)
    ]);
    const firstAffectedIndex = eventMemory.small_summaries.findIndex(item => affectedChildIds.has(clean(item?.id)));

    timeline.nodes = timeline.nodes.filter(node => !matchesNode(node));
    eventMemory.small_summaries = eventMemory.small_summaries.filter(item => !matchesSmall(item));
    eventMemory.big_summaries = eventMemory.big_summaries.filter(item => !affectedBig.includes(item));
    if (firstAffectedIndex >= 0) {
      eventMemory.big_summary_cursor = Math.min(eventMemory.big_summary_cursor, firstAffectedIndex);
    }
    eventMemory.big_summary_cursor = Math.max(0, Math.min(
      eventMemory.small_summaries.length, Number(eventMemory.big_summary_cursor) || 0
    ));
    return {
      removed: true,
      sourceKey,
      removedNodeIds: removedNodes.map(node => node.id),
      removedSmallIds: [...removedSmallIds],
      removedBigIds: affectedBig.map(item => item.id)
    };
  }

  function replayTimeline(state, stopBeforeId) {
    const timeline = ensureTimelineState(state), root = clone(timeline.root?.base || {});
    const derived = {
      personal_memory: clone(root.personal_memory || []),
      knowledge_index: clone(root.knowledge_index || {}),
      entity_memory: clone(root.entity_memory || {}),
      entity_index: clone(root.entity_index || {}),
      ongoing_facts: clone(root.ongoing_facts || []),
      character_arcs: clone(root.character_arcs || []),
      round: Math.max(0, Number(root.round) || 0),
      chatLayer: root.chatLayer ?? null,
      event_memory: clone(state.event_memory || {}),
      ...(state.world_commit_archive ? { world_commit_archive: clone(state.world_commit_archive) } : {}),
      timeline: clone(timeline)
    };
    ensureEntityState(derived);
    ensureStructuredMemoryState(derived);
    for (const node of timeline.nodes) {
      if (stopBeforeId && node.id === stopBeforeId) break;
      if (node.status !== 'valid') continue;
      if (node.kind === 'manual_snapshot' && node.snapshot) {
        derived.personal_memory = clone(node.snapshot.personal_memory || []);
        derived.knowledge_index = clone(node.snapshot.knowledge_index || {});
        derived.entity_memory = clone(node.snapshot.entity_memory || {});
        derived.entity_index = clone(node.snapshot.entity_index || {});
        if (Array.isArray(node.snapshot.ongoing_facts)) derived.ongoing_facts = clone(node.snapshot.ongoing_facts);
        if (Array.isArray(node.snapshot.character_arcs)) derived.character_arcs = clone(node.snapshot.character_arcs);
        derived.round = Math.max(derived.round, Number(node.snapshot.round) || 0);
        derived.chatLayer = node.snapshot.chatLayer ?? derived.chatLayer;
        ensureEntityState(derived);
        ensureStructuredMemoryState(derived);
        continue;
      }
      mergeMemories(derived, clone(node.personal || []));
      mergeEntityMemories(derived, clone(node.entities || {}));
      if (Array.isArray(node.factUpdates) && node.factUpdates.length) {
        mergeOngoingFacts(derived, clone(node.factUpdates), node.endLayer, node.sourceRefs, node.worldCommitId);
      }
      if (Array.isArray(node.arcUpdates) && node.arcUpdates.length) {
        mergeCharacterArcs(derived, clone(node.arcUpdates), node.endLayer);
      }
      derived.round += 1;
      if (Number.isFinite(Number(node.endLayer))) derived.chatLayer = Number(node.endLayer);
    }
    repairStateIndexes(derived, derived);
    return derived;
  }

  function commitManualState(nextState, previousState) {
    if (!nextState || !previousState) return nextState;
    const memoryView = state => JSON.stringify({
      personal_memory: state.personal_memory || [],
      knowledge_index: state.knowledge_index || {},
      entity_memory: state.entity_memory || {},
      entity_index: state.entity_index || {},
      ongoing_facts: state.ongoing_facts || [],
      character_arcs: state.character_arcs || []
    });
    if (memoryView(nextState) === memoryView(previousState)) return nextState;
    const timeline = ensureTimelineState(previousState), api = timelineApi();
    const layer = currentLayer(), originChatId = data()?.getChatId?.() || 'default';
    const snapshot = {
      personal_memory: clone(nextState.personal_memory || []),
      knowledge_index: clone(nextState.knowledge_index || {}),
      entity_memory: clone(nextState.entity_memory || {}),
      entity_index: clone(nextState.entity_index || {}),
      ongoing_facts: clone(nextState.ongoing_facts || []),
      character_arcs: clone(nextState.character_arcs || []),
      round: Math.max(0, Number(nextState.round) || 0),
      chatLayer: nextState.chatLayer ?? layer
    };
    const hash = api?.hashText?.(memoryView(nextState)) || String(Date.now());
    timeline.nodes.push({
      id: nextTimelineNodeId(timeline),
      kind: 'manual_snapshot',
      originChatId,
      startLayer: layer,
      endLayer: layer,
      sourceRefs: [{ chatId: originChatId, messageId: `manual:${Date.now()}`, layer, role: 'synthetic', swipeId: 0, hash, synthetic: true }],
      sourceDigest: hash,
      personal: [],
      entities: {},
      snapshot,
      status: 'valid',
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    nextState.timeline = clone(timeline);
    return nextState;
  }

  // 自动纪要只处理进入当前聊天之后新增的对话。首次见到一个聊天时仅落下
  // 当前楼层基线，不调用 API；从头整理历史记录只允许由批量重填显式触发。
  function initializeSummaryBaseline() {
    const memoryData = data();
    if (!memoryData) return null;
    const state = memoryData.loadState();
    const eventMemory = ensureEventState(state);
    if (eventMemory.small_summary_layer !== null
      && eventMemory.small_summary_layer !== ''
      && Number.isFinite(Number(eventMemory.small_summary_layer))) return state;
    eventMemory.small_summary_layer = chat().length - 1;
    return memoryData.saveState(state);
  }

  function nextSmallSummaryId(eventMemory) {
    const max = (eventMemory.small_summaries || []).reduce((number, item) => {
      const match = /^small_(\d+)$/.exec(clean(item?.id));
      return Math.max(number, match ? Number(match[1]) : 0);
    }, 0);
    return `small_${String(max + 1).padStart(6, '0')}`;
  }

  function nextBigSummaryId(eventMemory) {
    const max = (eventMemory.big_summaries || []).reduce((number, item) => {
      const match = /^big_(\d+)$/.exec(clean(item?.id));
      return Math.max(number, match ? Number(match[1]) : 0);
    }, 0);
    return `big_${String(max + 1).padStart(6, '0')}`;
  }

  async function requestTasks(tasks, options) {
    const st = settings(), state = options?.baseState ? clone(options.baseState) : data().loadState();
    const prompt = await buildRequestPrompt(tasks, state, st);
    lastDebug = { prompt, requestPrompt: prompt, rawResult: '', apiResponse: '', parsed: null, error: '' };
    const retries = Math.max(0, Number(options?.retries ?? st.apiAutoRetries) || 0);
    const purpose = tasks.memory && tasks.small
      ? '人物、实体与纪要'
      : (tasks.memory ? '人物与实体提取' : (tasks.small ? '阶段纪要' : '总述'));
    const runAttempt = async ({ attempt, maxAttempts }) => {
      let logId = null;
      try {
        window.WORLD_ENGINE_API?.setNextRequestMeta?.({
          module: 'memory',
          purpose,
          attempt: attempt + 1,
          maxAttempts,
          onLogId: id => { logId = id; }
        });
        const raw = await window.WORLD_ENGINE_API.callApi(
          prompt, st.maxTokens, st.temperature, abortController?.signal, st
        );
        lastDebug.rawResult = lastDebug.apiResponse = raw;
        let parsed;
        try {
          parsed = parseResponse(raw, tasks);
        } catch (parseErr) {
          window.WORLD_ENGINE_API?.updateRequestLog?.(logId, {
            status: 'error',
            phase: '解析失败',
            error: String(parseErr?.message || parseErr)
          });
          throw parseErr;
        }
        lastDebug.parsed = clone(parsed);
        return parsed;
      } catch (error) {
        lastDebug.error = String(error?.message || error);
        throw error;
      }
    };

    if (typeof window.WORLD_ENGINE_API?.executeWithRetry === 'function') {
      return window.WORLD_ENGINE_API.executeWithRetry(runAttempt, {
        retries,
        signal: abortController?.signal,
        shouldContinue: () => !abortController?.signal?.aborted,
        onRetry: ({ attempt, maxRetries }) => {
          ui()?.setMemoryEvolvingUI?.(true, `重试提取 ${attempt}/${maxRetries}`);
        }
      });
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await runAttempt({ attempt, maxAttempts: retries + 1 });
      } catch (error) {
        if (abortController?.signal?.aborted || attempt >= retries) throw error;
      }
    }
    throw new Error('记忆 API 请求失败');
  }

  async function runTasks(tasks, options) {
    if (running && !options?.allowWhileBackfill) return { skipped: true, reason: 'running' };
    if (!tasks?.memory && !tasks?.small && !tasks?.big) return { skipped: true, reason: 'no_tasks' };
    if (tasks.small && tasks.big) throw new Error('总述必须在纪要落库后独立运行');
    running = true;
    runningLabel = tasks.memory && tasks.small ? '人物、实体与纪要'
      : (tasks.memory ? '人物与实体提取' : (tasks.small ? '纪要' : '总述'));
    const taskLabel = runningLabel;
    abortController = new AbortController();
    setExternalStatus(`正在进行${taskLabel}…`);
    // 顶部状态机会先清理悬浮球运行类，因此最后再按当前引擎面刷新动画状态。
    window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(true, runningLabel);
    try {
      const requestChatId = data().getChatId();
      const before = options?.baseState ? clone(options.baseState) : data().loadState();
      const extracted = await requestTasks(tasks, { ...options, baseState: before });
      if (requestChatId !== data().getChatId() || abortController?.signal?.aborted ||
          (tasks.memory?.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(tasks.memory.worldCommitId) === false)) {
        const error = new Error('记忆来源或聊天已变化，旧结果已丢弃'); error.name = 'AbortError'; throw error;
      }
      for (const task of Object.values(tasks)) {
        if (Array.isArray(task?.sourceRefs) && task.sourceRefs.length && timelineApi()?.auditRefs?.(task.sourceRefs)?.valid === false) {
          const error = new Error('正文已变化，记忆结果未写入'); error.name = 'AbortError'; throw error;
        }
      }
      if (options?.saveCheckpoint !== false) data().saveCheckpoint(before);
      const next = clone(before);
      const memorySourceDigest = tasks.memory && Array.isArray(tasks.memory.sourceRefs) && tasks.memory.sourceRefs.length
        ? timelineApi()?.digestRefs?.(tasks.memory.sourceRefs) || '' : '';
      const memoryAlreadyStored = memorySourceDigest && ensureTimelineState(next).nodes.some(node =>
        node.kind === 'memory' && node.status === 'valid' && clean(node.sourceDigest) === memorySourceDigest
      );
      const applyMemory = Boolean(tasks.memory && !memoryAlreadyStored);
      const targetLayer = Number.isFinite(Number(options?.layer)) ? Number(options.layer) : (Number(tasks.memory?.endLayer) || currentLayer());
      const addedPersonal = applyMemory ? mergeMemories(next, extracted.personal) : 0;
      const entityChanges = applyMemory
        ? mergeEntityMemories(next, extracted.entities)
        : { entities: 0, history: 0, descriptions: 0 };
      const factChanges = applyMemory && Array.isArray(extracted.factUpdates) && extracted.factUpdates.length
        ? mergeOngoingFacts(next, extracted.factUpdates, targetLayer, tasks.memory?.sourceRefs, tasks.memory?.worldCommitId)
        : 0;
      const arcChanges = applyMemory && Array.isArray(extracted.arcUpdates) && extracted.arcUpdates.length
        ? mergeCharacterArcs(next, extracted.arcUpdates, targetLayer)
        : 0;
      if (applyMemory) appendTimelineNode(next, extracted, tasks.memory, options);
      const eventMemory = ensureEventState(next);
      const outlineHints = tasks.small ? buildRequestPrompt_hints() : {};
      let addedSmall = 0, updatedBig = 0;
      if (tasks.small && extracted.smallSummary) {
        const sourceRefs = clone(tasks.small.sourceRefs || timelineApi()?.captureRange?.(tasks.small.startLayer, tasks.small.endLayer) || []);
        const sourceDigest = timelineApi()?.digestRefs?.(sourceRefs) || '';
        const existingSummary = sourceDigest ? eventMemory.small_summaries.find(item =>
          item.status !== 'stale' && clean(item.sourceDigest) === sourceDigest
        ) : null;
        if (!existingSummary) {
          eventMemory.small_summaries.push({
            id: nextSmallSummaryId(eventMemory),
            startLayer: Number(tasks.small.startLayer) || 0,
            endLayer: Number(tasks.small.endLayer) || 0,
            content: extracted.smallSummary,
            keywords: unique(extracted.smallSummaryKeywords),
            entityNames: unique(extracted.smallSummaryEntities),
            impactLevel: extracted.smallSummaryImpact === 'key' ? 'key' : 'normal',
            ...(clean(outlineHints.outlineChapterTitle) ? { outlineChapterTitle: clean(outlineHints.outlineChapterTitle) } : {}),
            sourceRefs,
            sourceDigest,
            originChatId: data()?.getChatId?.() || 'default',
            status: 'valid',
            revision: 1
          });
          addedSmall = 1;
        }
        eventMemory.small_summary_layer = Number(tasks.small.endLayer) || 0;
      }
      if (options?.worldDigestMinute?.content) {
        const linked = options.worldDigestMinute;
        eventMemory.small_summaries.push({
          id: nextSmallSummaryId(eventMemory),
          startLayer: Number(linked.layer) || 0,
          endLayer: Number(linked.layer) || 0,
          content: Array.from(clean(linked.content)).slice(0, 200).join(''),
          keywords: unique(linked.keywords),
          entityNames: unique(linked.entityNames),
          impactLevel: linked.impactLevel === 'key' ? 'key' : 'normal',
          source: 'world_engine',
          sourceKey: clean(linked.sourceKey),
          ...(linked.worldCommitId ? { worldCommitId: clean(linked.worldCommitId) } : {}),
          status: 'valid',
          revision: 1
        });
        addedSmall += 1;
      }
      if (tasks.big && extracted.bigSummary) {
        eventMemory.big_summaries.push({
          id: nextBigSummaryId(eventMemory),
          startLayer: Number(tasks.big.startLayer) || 0,
          endLayer: Number(tasks.big.endLayer) || 0,
          content: extracted.bigSummary,
          keywords: unique(extracted.bigSummaryKeywords),
          childIds: clone(tasks.big.childIds || []),
          childDigest: clean(tasks.big.childDigest),
          sourceRefs: clone(tasks.big.sourceRefs || []),
          originChatId: data()?.getChatId?.() || 'default',
          status: 'valid',
          revision: 1
        });
        eventMemory.big_summary_cursor = Math.min(
          eventMemory.small_summaries.length,
          eventMemory.big_summary_cursor + Math.max(1, Number(tasks.big.consumeCount) || 1)
        );
        updatedBig = 1;
      }
      const added = addedPersonal + entityChanges.entities + entityChanges.history + entityChanges.descriptions + factChanges + arcChanges;
      if (tasks.memory) {
        if (applyMemory) next.round = Math.max(0, Number(next.round) || 0) + 1;
        next.chatLayer = Number.isFinite(Number(options?.layer)) ? Number(options.layer) : currentLayer();
      }
      data().saveState(next);
      window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.afterEvolution?.();
      applyInjection();
      refreshMemoryPanel();
      if (!options?.allowWhileBackfill && !backfillRunning) {
        refreshVectorRecallAsync(next);
      }
      setExternalStatus(`${taskLabel}完成`);
      return {
        added: added + addedSmall + updatedBig,
        extracted: extracted.personal.length + ENTITY_TYPES.reduce((sum, type) => sum + extracted.entities[type].length, 0),
        addedPersonal,
        entityChanges,
        factChanges,
        arcChanges,
        addedSmall,
        updatedBig,
        state: next
      };
    } catch (error) {
      const stopped = abortController?.signal?.aborted || error?.name === 'AbortError';
      setExternalStatus(stopped ? `${taskLabel}已停止` : `${taskLabel}失败：${error?.message || error}`, !stopped);
      throw error;
    } finally {
      running = false;
      runningLabel = '';
      abortController = null;
      window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(false, '');
    }
  }

  async function extractConversation(conversation, options) {
    return runTasks({ memory: {
      conversation,
      sourceRefs: clone(options?.sourceRefs || []),
      startLayer: options?.startLayer,
      endLayer: options?.endLayer,
      sourceKey: options?.sourceKey
    } }, options);
  }

  function countAiSince(layer, st, endLayer) {
    const anchor = layer !== null && layer !== '' && Number.isFinite(Number(layer)) ? Number(layer) : -1;
    const all = chat(), skipOpening = anchor < 0 && ignoreFirstLayer(st || settings());
    const end = endLayer !== undefined && Number.isFinite(Number(endLayer)) ? Number(endLayer) : all.length - 1;
    return all.reduce((count, message, index) => count + (
      index > anchor && index <= end && !(skipOpening && index === 0) && message && !message.is_user ? 1 : 0
    ), 0);
  }

  function stableAutoEndLayer(st) {
    const delayFloors = Math.max(0, parseInt(st?.summaryDelayFloors) || 0);
    if (!delayFloors) return undefined;
    const all = chat(), skipOpening = ignoreFirstLayer(st);
    const aiLayers = all.map((message, index) => (
      !(skipOpening && index === 0) && message && !message.is_user ? index : -1
    )).filter(index => index >= 0);
    if (aiLayers.length <= delayFloors) return -1;
    return aiLayers[aiLayers.length - 1 - delayFloors];
  }

  function getAiBatchAfter(layer, maxAi, endLayer, settingsOverride) {
    const all = chat();
    const anchor = layer !== null && layer !== '' && Number.isFinite(Number(layer)) ? Number(layer) : -1;
    const skipOpening = anchor < 0 && ignoreFirstLayer(settingsOverride || settings());
    const end = endLayer !== undefined && Number.isFinite(Number(endLayer)) ? Number(endLayer) : all.length - 1;
    const aiLayers = all.map((message, index) => (index > anchor && index <= end && !(skipOpening && index === 0) && message && !message.is_user ? index : -1))
      .filter(index => index >= 0).slice(0, Math.max(1, parseInt(maxAi) || 1));
    if (!aiLayers.length) return null;
    const firstAi = aiLayers[0], finish = aiLayers.at(-1);
    const start = firstAi > 0 && all[firstAi - 1]?.is_user ? firstAi - 1 : firstAi;
    return {
      startLayer: start,
      endLayer: finish,
      aiCount: aiLayers.length,
      conversation: formatMessages(all.slice(start, finish + 1), start),
      sourceRefs: timelineApi()?.captureRange?.(start, finish) || []
    };
  }

  function buildBigTask(state, force, thresholdOverride) {
    const st = settings(), eventMemory = ensureEventState(state);
    const allPending = eventMemory.small_summaries.slice(eventMemory.big_summary_cursor);
    const threshold = Math.max(1, parseInt(thresholdOverride ?? st.bigSummaryEveryX) || 5);
    if (!force && allPending.length < threshold) return null;
    if (force && !allPending.length) return null;
    const pending = force ? allPending : allPending.slice(0, threshold);
    const childIds = pending.map(item => item.id);
    const sourceRefs = timelineApi()?.unionRefs?.(pending.map(item => item.sourceRefs || [])) || [];
    return {
      summaries: pending,
      consumeCount: pending.length,
      startLayer: Number(pending[0]?.startLayer) || 0,
      endLayer: Number(pending.at(-1)?.endLayer) || 0,
      childIds,
      childDigest: timelineApi()?.hashText?.(pending.map(item => `${item.id}:${item.revision || 1}:${item.sourceDigest || ''}`).join('|')) || '',
      sourceRefs
    };
  }

  async function runTasksThenDueBig(tasks, options, bigThresholdOverride) {
    const primary = await runTasks(tasks, options);
    if (primary?.skipped) return primary;
    const after = data().loadState();
    const bigTask = buildBigTask(after, false, bigThresholdOverride);
    if (!bigTask) return primary;
    const bigResult = await runTasks({ big: bigTask }, {
      ...options,
      baseState: after,
      saveCheckpoint: false,
      // 世界摘要纪要只在 primary 落库一次；这里仅消费待整理纪要生成总述。
      worldDigestMinute: null
    });
    return {
      ...primary,
      added: Number(primary.added || 0) + Number(bigResult?.updatedBig || 0),
      updatedBig: Number(bigResult?.updatedBig || 0),
      state: bigResult?.state || primary.state
    };
  }

  // 手动向前提取与重新推演共用：读取轮数 = min(配置上限, 基底状态至今的实际 AI 轮数)。
  function getElapsedReadRounds(baseState, maxRounds) {
    const limit = Math.max(1, parseInt(maxRounds) || 1);
    const anchor = baseState?.chatLayer !== null && baseState?.chatLayer !== '' && Number.isFinite(Number(baseState?.chatLayer))
      ? Number(baseState.chatLayer) : -1;
    return Math.max(1, Math.min(countAiSince(anchor), limit));
  }

  async function autoExtract() {
    const st = settings();
    if (st.engineEnabled === false || running || backfillRunning || reconciling) return;
    // 历史正文修复必须等本轮 AI 回复完成后才请求 API；手动提取模式也照常修复历史。
    await reconcileHistory();
    if (st.evolveMode !== 'auto') return;
    const state = data().loadState();
    const anchor = state.chatLayer !== null && state.chatLayer !== '' && Number.isFinite(Number(state.chatLayer))
      ? Number(state.chatLayer) : -1;
    const stableEnd = stableAutoEndLayer(st);
    const tasks = {};
    if (stableEnd !== -1 && countAiSince(anchor, st, stableEnd) >= Math.max(1, parseInt(st.evolveEveryX) || 1)) {
      tasks.memory = stableEnd === undefined
        ? recentConversationBatch(st.evolveReadRounds)
        : getAiBatchAfter(anchor, st.evolveReadRounds, stableEnd, st);
    }
    const eventMemory = ensureEventState(state);
    const smallEvery = Math.max(1, parseInt(st.smallSummaryEveryX) || 1);
    const smallBatch = stableEnd !== -1 && countAiSince(eventMemory.small_summary_layer, st, stableEnd) >= smallEvery
      ? getAiBatchAfter(eventMemory.small_summary_layer, smallEvery, stableEnd, st) : null;
    if (smallBatch) tasks.small = smallBatch;
    const bigTask = buildBigTask(state, false);
    if (!tasks.memory && !tasks.small) {
      if (!bigTask) return;
      const result = await runTasks({ big: bigTask }, { baseState: state });
      if (buildBigTask(data().loadState(), false)) {
        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => autoExtract().catch(error => console.error('[记忆引擎] 自动总述补进度失败', error)), 0);
      }
      return result;
    }
    const targetLayer = stableEnd !== undefined ? stableEnd : currentLayer();
    const result = await runTasksThenDueBig(tasks, { layer: targetLayer, baseState: state });
    const after = data().loadState(), afterEvent = ensureEventState(after);
    const nextStableEnd = stableAutoEndLayer(st);
    if ((nextStableEnd !== -1 && countAiSince(afterEvent.small_summary_layer, st, nextStableEnd) >= smallEvery)
        || buildBigTask(after, false)) {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => autoExtract().catch(error => console.error('[记忆引擎] 自动纪要补进度失败', error)), 0);
    }
    return result;
  }

  async function manualExtract() {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    const state = data().loadState();
    const timeline = ensureTimelineState(state), eventMemory = ensureEventState(state);
    const memoryLayer = state.chatLayer !== null && state.chatLayer !== '' && Number.isFinite(Number(state.chatLayer))
      ? Number(state.chatLayer) : null;
    const summaryLayer = eventMemory.small_summary_layer !== null && eventMemory.small_summary_layer !== ''
      && Number.isFinite(Number(eventMemory.small_summary_layer)) ? Number(eventMemory.small_summary_layer) : null;
    const hasTrackedSummaries = eventMemory.small_summaries.some(summary =>
      Array.isArray(summary.sourceRefs) && summary.sourceRefs.length
    );
    // 新聊天首次建立纪要基线时，人物游标尚为空；此时沿用纪要基线，避免误把整段旧聊天当成待处理。
    // 若已经存在带正文来源的纪要，则从头寻找尚缺人物实体的最早一轮，补齐两条链。
    let anchor = memoryLayer === null ? (hasTrackedSummaries ? -1 : (summaryLayer ?? -1))
      : (summaryLayer === null ? memoryLayer : Math.min(memoryLayer, summaryLayer));
    let batch = null;
    while (true) {
      const candidate = getAiBatchAfter(anchor, 1);
      if (!candidate) break;
      const digest = timelineApi()?.digestRefs?.(candidate.sourceRefs || []) || '';
      const hasNode = digest && timeline.nodes.some(node =>
        node.kind === 'memory' && node.status === 'valid' && clean(node.sourceDigest) === digest
      );
      const hasSummary = digest && eventMemory.small_summaries.some(summary =>
        summary.status !== 'stale' && clean(summary.sourceDigest) === digest
      );
      if (hasNode && hasSummary) {
        anchor = candidate.endLayer;
        continue;
      }
      batch = candidate;
      break;
    }
    if (!batch) throw new Error('当前没有尚未提取的新一轮正文');
    return runTasksThenDueBig({ memory: batch, small: batch }, {
      ...batch, layer: batch.endLayer, baseState: state
    });
  }

  async function manualReextract() {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    if (running || backfillRunning || reconciling) throw new Error('已有记忆任务正在运行');
    const current = data().loadState();
    const timeline = ensureTimelineState(current);
    const latestNode = timeline.nodes.slice().reverse().find(node => node.kind === 'memory' && node.status === 'valid');
    if (latestNode) {
      const eventMemory = ensureEventState(current);
      const sourceDigest = clean(latestNode.sourceDigest)
        || timelineApi()?.digestRefs?.(latestNode.sourceRefs || []) || '';
      const pairedSummary = sourceDigest ? eventMemory.small_summaries.find(summary => {
        const digest = clean(summary.sourceDigest)
          || timelineApi()?.digestRefs?.(summary.sourceRefs || []) || '';
        return summary.status === 'valid' && digest === sourceDigest;
      }) : null;
      const taskLabel = '人物、实体与纪要重新推演';
      running = true;
      runningLabel = taskLabel;
      abortController = new AbortController();
      setExternalStatus(`正在进行${taskLabel}…`);
      window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(true, runningLabel);
      let repaired;
      try {
        latestNode.status = 'stale';
        if (pairedSummary) pairedSummary.status = 'stale';
        data().saveState(current);
        repaired = await repairMemoryAndSmall(latestNode.id, pairedSummary?.id);
        if (!repaired) throw new Error('最新一轮人物、实体与纪要未能重新提取');
        setExternalStatus(`${taskLabel}完成`);
      } catch (error) {
        // 请求失败或用户停止时恢复旧节点，不能把一次未完成的重新推演留成 stale。
        const rollback = data().loadState();
        const rollbackNode = ensureTimelineState(rollback).nodes.find(node => node.id === latestNode.id);
        const rollbackSummary = pairedSummary
          ? ensureEventState(rollback).small_summaries.find(summary => summary.id === pairedSummary.id)
          : null;
        if (rollbackNode?.status === 'stale') rollbackNode.status = 'valid';
        if (rollbackSummary?.status === 'stale') rollbackSummary.status = 'valid';
        data().saveState(rollback);
        applyInjection();
        const stopped = abortController?.signal?.aborted || error?.name === 'AbortError';
        setExternalStatus(stopped ? `${taskLabel}已停止` : `${taskLabel}失败：${error?.message || error}`, !stopped);
        throw error;
      } finally {
        running = false;
        runningLabel = '';
        abortController = null;
        window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(false, '');
      }

      // 与原动作一致：重做受本轮纪要影响的既有总述，并在仍满足阈值时继续生成总述。
      const reconciliation = await reconcileHistory();
      const afterReconcile = data().loadState();
      const dueBigTask = buildBigTask(afterReconcile, false);
      const bigResult = dueBigTask
        ? await runTasks({ big: dueBigTask }, { baseState: afterReconcile, saveCheckpoint: false })
        : null;
      const updated = Math.max(1, Number(repaired?.updated || 0));
      return {
        added: updated + Number(reconciliation?.repairedCount || 0) + Number(bigResult?.updatedBig || 0),
        extracted: Number(repaired?.extracted || 0),
        updatedBig: Number(reconciliation?.updatedBig || 0) + Number(bigResult?.updatedBig || 0),
        replacedNodeId: latestNode.id,
        replacedSummaryId: pairedSummary?.id || null,
        state: bigResult?.state || data().loadState()
      };
    }
    // 旧数据尚未产生时间链节点时，保留一次兼容回退；新节点产生后不再依赖 checkpoint。
    const checkpoint = data().loadCheckpoint();
    if (!checkpoint) throw new Error('没有可用于重新推演的记忆存档点');
    const readRounds = getElapsedReadRounds(checkpoint, st.manualReadRounds);
    const batch = recentConversationBatch(readRounds);
    return runTasksThenDueBig({ memory: batch, small: batch }, {
      ...batch, layer: currentLayer(), baseState: checkpoint
    });
  }

  async function manualSmallSummary() {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    const state = data().loadState(), eventMemory = ensureEventState(state);
    const batch = getAiBatchAfter(eventMemory.small_summary_layer, Math.max(1, parseInt(st.smallSummaryEveryX) || 5));
    if (!batch) throw new Error('当前状态之后没有可总结的新对话');
    return runTasksThenDueBig({ small: batch }, { baseState: state });
  }

  async function manualBigSummary() {
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    const state = data().loadState(), bigTask = buildBigTask(state, true);
    if (!bigTask) throw new Error('当前没有尚未并入总述的纪要');
    return runTasks({ big: bigTask }, { baseState: state });
  }

  function newHistoryAuditReport() {
    return { changedLayers: new Set(), deletedLayers: new Set() };
  }

  function collectHistoryAudit(report, audit) {
    if (!report || !audit) return;
    for (const item of audit.changed || []) {
      const layer = Number(item?.before?.layer ?? item?.after?.layer);
      if (Number.isFinite(layer)) report.changedLayers.add(layer);
    }
    for (const ref of audit.missing || []) {
      const layer = Number(ref?.layer);
      if (Number.isFinite(layer)) report.deletedLayers.add(layer);
    }
  }

  // 楼层数字会在删楼后整体前移。来源引用可以用稳定消息 ID 判断哪些旧楼
  // 消失了，但纪要进度仍是数字游标，必须同步减去游标之前被删的楼层数。
  // 否则新对话要先“追平”删除前的楼层号，期间不会再生成纪要。
  function rewindSummaryCursorForDeletedLayers(state, report) {
    const deleted = [...(report?.deletedLayers || [])].filter(Number.isFinite);
    if (!deleted.length) return false;
    const eventMemory = ensureEventState(state);
    if (eventMemory.small_summary_layer === null || eventMemory.small_summary_layer === ''
      || !Number.isFinite(Number(eventMemory.small_summary_layer))) return false;
    const anchor = Number(eventMemory.small_summary_layer);
    const removedBeforeCursor = deleted.filter(layer => layer <= anchor).length;
    if (!removedBeforeCursor) return false;
    eventMemory.small_summary_layer = Math.max(-1, anchor - removedBeforeCursor);
    return true;
  }

  function formatHistoryLayers(layers) {
    const values = [...(layers || [])].filter(Number.isFinite).sort((a, b) => a - b);
    return values.length ? `第 ${values.join('、')} 楼` : '';
  }

  function historyAuditMessage(report, phase, error) {
    const changed = formatHistoryLayers(report?.changedLayers);
    const deleted = formatHistoryLayers(report?.deletedLayers);
    const subjects = [changed ? `${changed}正文已修改` : '', deleted ? `${deleted}已删除` : ''].filter(Boolean);
    if (!subjects.length) {
      if (phase === 'failed') return `历史记忆修复失败：旧记忆已停止注入，本次使用原始正文。原因：${error?.message || error}`;
      return phase === 'success' ? '历史记忆对账完成' : '正在核对历史楼层与记忆链…';
    }
    const subject = subjects.join('；');
    if (phase === 'detected') return `检测到${subject}，正在重建相关记忆、纪要与总述…`;
    if (phase === 'success') return `${subject}：相关记忆、纪要与总述已更新，本次注入采用新正文。`;
    return `${subject}：历史记忆修复失败，旧记忆已停止注入，本次使用原始正文。原因：${error?.message || error}`;
  }

  function auditStoredSources(state, report) {
    const api = timelineApi(), timeline = ensureTimelineState(state), eventMemory = ensureEventState(state);
    let changed = false;
    const refreshValidRefs = (record, audit) => {
      if (!audit?.valid || audit.inherited || audit.synthetic || !Array.isArray(audit.refs)) return;
      const oldLayers = (record.sourceRefs || []).map(ref => Number(ref.layer)).join(',');
      const newLayers = audit.refs.map(ref => Number(ref.layer)).join(',');
      if (oldLayers === newLayers) return;
      record.sourceRefs = clone(audit.refs);
      const bounds = sourceBounds(audit.refs, record.endLayer);
      record.startLayer = bounds.startLayer;
      record.endLayer = bounds.endLayer;
      changed = true;
    };
    for (const node of timeline.nodes) {
      if (!Array.isArray(node.sourceRefs) || !node.sourceRefs.length) continue;
      const audit = api?.auditRefs?.(node.sourceRefs);
      collectHistoryAudit(report, audit);
      refreshValidRefs(node, audit);
      const nextStatus = audit?.valid && !(node.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(node.worldCommitId) === false) ? 'valid' : 'stale';
      if (node.status !== nextStatus) { node.status = nextStatus; changed = true; }
    }
    for (const summary of eventMemory.small_summaries) {
      if (summary.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(summary.worldCommitId) === false) {
        if (summary.status !== 'stale') { summary.status = 'stale'; changed = true; }
        continue;
      }
      if (!Array.isArray(summary.sourceRefs) || !summary.sourceRefs.length) continue; // 旧版手工/迁移纪要保持封存。
      const audit = api?.auditRefs?.(summary.sourceRefs);
      collectHistoryAudit(report, audit);
      refreshValidRefs(summary, audit);
      const nextStatus = audit?.valid ? 'valid' : 'stale';
      if (summary.status !== nextStatus) { summary.status = nextStatus; changed = true; }
    }
    for (const overview of eventMemory.big_summaries) {
      if (!Array.isArray(overview.childIds) || !overview.childIds.length) continue;
      const children = overview.childIds.map(id => eventMemory.small_summaries.find(item => item.id === id)).filter(Boolean);
      const digest = api?.hashText?.(children.map(item => `${item.id}:${item.revision || 1}:${item.sourceDigest || ''}`).join('|')) || '';
      const valid = children.length === overview.childIds.length
        && children.every(item => item.status === 'valid')
        && digest === clean(overview.childDigest);
      const nextStatus = valid ? 'valid' : 'stale';
      if (overview.status !== nextStatus) { overview.status = nextStatus; changed = true; }
    }
    return changed;
  }

  async function repairMemoryNode(nodeId) {
    let state = data().loadState(), timeline = ensureTimelineState(state);
    let node = timeline.nodes.find(item => item.id === nodeId);
    if (!node || node.status !== 'stale') return false;
    if (node.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(node.worldCommitId) === false) return false;
    const api = timelineApi(), audit = api?.auditRefs?.(node.sourceRefs);
    if (!audit?.refs?.length) {
      timeline.nodes = timeline.nodes.filter(item => item.id !== nodeId);
      data().saveState(replayTimeline(state));
      return true;
    }
    const base = replayTimeline(state, nodeId);
    const conversation = api?.refsToConversation?.(node.sourceRefs) || '';
    if (!conversation) return false;
    const repairBounds = sourceBounds(audit.refs, node.endLayer);
    const extracted = await requestTasks({ memory: {
      conversation,
      startLayer: repairBounds.startLayer,
      endLayer: repairBounds.endLayer
    } }, { baseState: base });

    state = data().loadState();
    timeline = ensureTimelineState(state);
    node = timeline.nodes.find(item => item.id === nodeId);
    if (!node) return false;
    const bounds = sourceBounds(audit.refs, node.endLayer);
    node.sourceRefs = clone(audit.refs);
    node.sourceDigest = api?.digestRefs?.(audit.refs) || '';
    node.startLayer = bounds.startLayer;
    node.endLayer = bounds.endLayer;
    node.personal = clone(extracted.personal || []);
    node.entities = clone(extracted.entities || {});
    node.status = 'valid';
    node.revision = Math.max(1, Number(node.revision) || 1) + 1;
    node.updatedAt = Date.now();
    data().saveState(replayTimeline(state));
    refreshMemoryPanel();
    return true;
  }

  // 日常提取固定为一轮后，同轮人物/实体节点与纪要拥有相同来源。
  // 历史变化时也联合请求，保持新增与修复使用同一个最小事务单元。
  async function repairMemoryAndSmall(nodeId, summaryId) {
    let state = data().loadState(), timeline = ensureTimelineState(state), eventMemory = ensureEventState(state);
    let node = timeline.nodes.find(item => item.id === nodeId);
    let summary = summaryId ? eventMemory.small_summaries.find(item => item.id === summaryId) : null;
    if (!node || node.status !== 'stale' || (summaryId && (!summary || summary.status !== 'stale'))) return false;

    const api = timelineApi();
    const nodeAudit = api?.auditRefs?.(node.sourceRefs);
    const summaryAudit = summary ? api?.auditRefs?.(summary.sourceRefs) : nodeAudit;
    if (!nodeAudit?.refs?.length || !summaryAudit?.refs?.length) return false;
    const nodeDigest = api?.digestRefs?.(nodeAudit.refs) || '';
    const summaryDigest = api?.digestRefs?.(summaryAudit.refs) || '';
    if (!nodeDigest || nodeDigest !== summaryDigest) return false;

    const conversation = api?.refsToConversation?.(node.sourceRefs) || '';
    if (!conversation) return false;
    const bounds = sourceBounds(nodeAudit.refs, node.endLayer);
    const base = replayTimeline(state, nodeId);
    const extracted = await requestTasks({
      memory: {
        startLayer: bounds.startLayer,
        endLayer: bounds.endLayer,
        conversation
      },
      small: {
        startLayer: bounds.startLayer,
        endLayer: bounds.endLayer,
        conversation
      }
    }, { baseState: base });
    if (!clean(extracted.smallSummary)) {
      throw new Error('API 未返回纪要，已保留重新推演前的记录');
    }

    state = data().loadState();
    timeline = ensureTimelineState(state);
    eventMemory = ensureEventState(state);
    node = timeline.nodes.find(item => item.id === nodeId);
    summary = summaryId ? eventMemory.small_summaries.find(item => item.id === summaryId) : null;
    if (!node || (summaryId && !summary)) return false;

    node.sourceRefs = clone(nodeAudit.refs);
    node.sourceDigest = nodeDigest;
    node.startLayer = bounds.startLayer;
    node.endLayer = bounds.endLayer;
    node.personal = clone(extracted.personal || []);
    node.entities = clone(extracted.entities || {});
    node.status = 'valid';
    node.revision = Math.max(1, Number(node.revision) || 1) + 1;
    node.updatedAt = Date.now();

    if (!summary) {
      summary = {
        id: nextSmallSummaryId(eventMemory),
        startLayer: bounds.startLayer,
        endLayer: bounds.endLayer,
        sourceRefs: clone(summaryAudit.refs),
        sourceDigest: summaryDigest,
        content: extracted.smallSummary,
        originChatId: data()?.getChatId?.() || 'default',
        status: 'valid',
        revision: 1
      };
      eventMemory.small_summaries.push(summary);
      eventMemory.small_summary_layer = Math.max(Number(eventMemory.small_summary_layer) || 0, bounds.endLayer);
    } else {
      summary.startLayer = bounds.startLayer;
      summary.endLayer = bounds.endLayer;
      summary.sourceRefs = clone(summaryAudit.refs);
      summary.sourceDigest = summaryDigest;
      summary.content = extracted.smallSummary;
      summary.status = 'valid';
      summary.revision = Math.max(1, Number(summary.revision) || 1) + 1;
    }
    data().saveState(replayTimeline(state));
    refreshMemoryPanel();
    const extractedCount = (extracted.personal || []).length
      + ENTITY_TYPES.reduce((sum, type) => sum + (extracted.entities?.[type] || []).length, 0);
    return { repaired: true, extracted: extractedCount, updated: extractedCount + 1 };
  }

  async function repairSmallSummary(summaryId) {
    let state = data().loadState(), eventMemory = ensureEventState(state);
    let summary = eventMemory.small_summaries.find(item => item.id === summaryId);
    if (!summary || summary.status !== 'stale') return false;
    const api = timelineApi(), audit = api?.auditRefs?.(summary.sourceRefs);
    if (!audit?.refs?.length) {
      const index = eventMemory.small_summaries.findIndex(item => item.id === summaryId);
      if (index >= 0) {
        eventMemory.small_summaries.splice(index, 1);
        if (index < eventMemory.big_summary_cursor) eventMemory.big_summary_cursor--;
      }
      data().saveState(state);
      return true;
    }
    const conversation = api?.refsToConversation?.(summary.sourceRefs) || '';
    if (!conversation) return false;
    const bounds = sourceBounds(audit.refs, summary.endLayer);
    const extracted = await requestTasks({ small: {
      startLayer: bounds.startLayer,
      endLayer: bounds.endLayer,
      conversation
    } }, { baseState: state });

    state = data().loadState();
    eventMemory = ensureEventState(state);
    summary = eventMemory.small_summaries.find(item => item.id === summaryId);
    if (!summary) return false;
    summary.startLayer = bounds.startLayer;
    summary.endLayer = bounds.endLayer;
    summary.sourceRefs = clone(audit.refs);
    summary.sourceDigest = api?.digestRefs?.(audit.refs) || '';
    summary.content = extracted.smallSummary;
    summary.status = 'valid';
    summary.revision = Math.max(1, Number(summary.revision) || 1) + 1;
    data().saveState(state);
    refreshMemoryPanel();
    return true;
  }

  async function repairBigSummary(overviewId) {
    let state = data().loadState(), eventMemory = ensureEventState(state);
    let overview = eventMemory.big_summaries.find(item => item.id === overviewId);
    if (!overview || overview.status !== 'stale') return false;
    const children = (overview.childIds || []).map(id => eventMemory.small_summaries.find(item => item.id === id)).filter(Boolean);
    if (!children.length) {
      eventMemory.big_summaries = eventMemory.big_summaries.filter(item => item.id !== overviewId);
      data().saveState(state);
      return true;
    }
    if (children.some(item => item.status !== 'valid')) return false;
    const api = timelineApi();
    const extracted = await requestTasks({ big: { summaries: children } }, { baseState: state });

    state = data().loadState();
    eventMemory = ensureEventState(state);
    overview = eventMemory.big_summaries.find(item => item.id === overviewId);
    if (!overview) return false;
    overview.content = extracted.bigSummary;
    overview.childIds = children.map(item => item.id);
    overview.startLayer = Number(children[0]?.startLayer) || 0;
    overview.endLayer = Number(children.at(-1)?.endLayer) || 0;
    overview.sourceRefs = api?.unionRefs?.(children.map(item => item.sourceRefs || [])) || [];
    overview.childDigest = api?.hashText?.(children.map(item => `${item.id}:${item.revision || 1}:${item.sourceDigest || ''}`).join('|')) || '';
    overview.status = 'valid';
    overview.revision = Math.max(1, Number(overview.revision) || 1) + 1;
    data().saveState(state);
    refreshMemoryPanel();
    return true;
  }

  async function reconcileHistory() {
    if (reconciling || running || backfillRunning || settings().engineEnabled === false) return { skipped: true };
    reconciling = true;
    let announced = false;
    let repairedCount = 0, updatedBig = 0;
    const auditReport = newHistoryAuditReport();
    try {
      let state = data().loadState();
      // 一旦来源失效，立即从 Root 重放并排除 stale 节点；即使后续 API
      // 修复失败，旧人物/实体贡献也不会继续进入注入。
      const sourcesChanged = auditStoredSources(state, auditReport);
      const summaryCursorChanged = rewindSummaryCursorForDeletedLayers(state, auditReport);
      if (sourcesChanged || summaryCursorChanged) {
        state = replayTimeline(state);
        data().saveState(state);
      }
      const timeline = ensureTimelineState(state), eventMemory = ensureEventState(state);
      const needsRepair = timeline.nodes.some(node => node.status === 'stale')
        || eventMemory.small_summaries.some(item => item.status === 'stale')
        || eventMemory.big_summaries.some(item => item.status === 'stale');
      if (!needsRepair) {
        applyInjection();
        return { repaired: false };
      }
      runningLabel = '历史记忆对账';
      abortController = new AbortController();
      setExternalStatus(historyAuditMessage(auditReport, 'detected'));
      window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(true, runningLabel);
      announced = true;

      for (const node of ensureTimelineState(data().loadState()).nodes.slice()) {
        if (node.status !== 'stale') continue;
        const current = data().loadState();
        const currentEvent = ensureEventState(current);
        const nodeSourceDigest = clean(node.sourceDigest)
          || timelineApi()?.digestRefs?.(node.sourceRefs || []) || '';
        const pairedSummary = nodeSourceDigest ? currentEvent.small_summaries.find(summary => {
          if (summary.status !== 'stale') return false;
          const summaryDigest = clean(summary.sourceDigest)
            || timelineApi()?.digestRefs?.(summary.sourceRefs || []) || '';
          return summaryDigest === nodeSourceDigest;
        }) : null;
        const repairedTogether = pairedSummary
          ? await repairMemoryAndSmall(node.id, pairedSummary.id)
          : false;
        if (repairedTogether) repairedCount += Math.max(1, Number(repairedTogether.updated || 0));
        else if (await repairMemoryNode(node.id)) repairedCount += 1;
      }
      state = data().loadState();
      auditStoredSources(state);
      data().saveState(state);
      for (const summary of ensureEventState(data().loadState()).small_summaries.slice()) {
        if (summary.status === 'stale' && await repairSmallSummary(summary.id)) repairedCount += 1;
      }
      state = data().loadState();
      auditStoredSources(state);
      data().saveState(state);
      for (const overview of ensureEventState(data().loadState()).big_summaries.slice()) {
        if (overview.status === 'stale' && await repairBigSummary(overview.id)) {
          repairedCount += 1;
          updatedBig += 1;
        }
      }
      state = data().loadState();
      auditStoredSources(state);
      data().saveState(state);
      const finalTimeline = ensureTimelineState(state), finalEventMemory = ensureEventState(state);
      const unresolved = finalTimeline.nodes.some(node => node.status === 'stale')
        || finalEventMemory.small_summaries.some(item => item.status === 'stale')
        || finalEventMemory.big_summaries.some(item => item.status === 'stale');
      if (unresolved) throw new Error('仍有相关记忆或纪要未能重建');
      applyInjection();
      setExternalStatus(historyAuditMessage(auditReport, 'success'));
      return { repaired: true, repairedCount, updatedBig };
    } catch (error) {
      const state = data().loadState();
      auditStoredSources(state, auditReport);
      data().saveState(replayTimeline(state));
      applyInjection(); // 失效摘要不注入，正文会恢复，避免信息洞。
      setExternalStatus(historyAuditMessage(auditReport, 'failed', error), true);
      throw error;
    } finally {
      reconciling = false;
      runningLabel = '';
      abortController = null;
      if (announced) window.WORLD_ENGINE_UI?.setMemoryEvolvingUI?.(false, '');
    }
  }

  function abort() {
    backfillRunning = false;
    abortController?.abort();
    try { window.MEMORY_ENGINE_VECTOR?.abort?.(); } catch (_) {}
  }

  function clearInjection() {
    const ctx = context();
    if (typeof ctx?.setExtensionPrompt === 'function') ctx.setExtensionPrompt(INJECTION_NAME, '', 1, 1);
    else if (typeof ctx?.unregisterInjection === 'function') ctx.unregisterInjection(INJECTION_NAME);
  }

  function registerInjection(content) {
    const ctx = context();
    if (typeof ctx?.setExtensionPrompt === 'function') ctx.setExtensionPrompt(INJECTION_NAME, content, 1, 1);
    else if (typeof ctx?.registerInjection === 'function') {
      ctx.unregisterInjection?.(INJECTION_NAME);
      ctx.registerInjection(INJECTION_NAME, content, { position: 1, depth: 1, role: 'system' });
    }
  }

  async function prepareHistoryForGeneration() {
    if (settings().engineEnabled === false) return { invalidated: false };
    restoreActiveWorldContributions();
    const auditReport = newHistoryAuditReport();
    let state = data().loadState();
    const sourcesChanged = auditStoredSources(state, auditReport);
    const summaryCursorChanged = rewindSummaryCursorForDeletedLayers(state, auditReport);
    if (sourcesChanged || summaryCursorChanged) {
      state = replayTimeline(state);
      data().saveState(state);
    }
    // stale 纪要/总述不会再注入；其来源正文（例如第 3、4 楼）会从隐藏集合移除。
    applyInjection();
    await hiddenSyncPromise;
    return { invalidated: sourcesChanged || summaryCursorChanged };
  }

  function selectHiddenMessageIds(coveredRefs, currentChatId, recentMessageIds) {
    const recent = recentMessageIds instanceof Set ? recentMessageIds : new Set(recentMessageIds || []);
    return new Set((coveredRefs || [])
      .filter(ref => clean(ref?.chatId) === clean(currentChatId))
      .map(ref => clean(ref?.messageId))
      .filter(messageId => messageId && !recent.has(messageId)));
  }

  function recentRawRoundMessageIds(messages, roundCount, st, api) {
    const source = Array.isArray(messages) ? messages : [];
    const take = Math.max(0, parseInt(roundCount) || 0);
    if (!source.length || !take) return new Set();
    const opening = ignoreFirstLayer(st);
    const aiLayers = source.map((message, index) => (
      !message?.is_user && !(opening && index === 0) ? index : -1
    )).filter(index => index >= 0);
    const start = aiLayers.length > take ? aiLayers[aiLayers.length - take - 1] + 1 : 0;
    return new Set(source.slice(start)
      .map(message => clean(api?.ensureMessageId?.(message)))
      .filter(Boolean));
  }

  function syncHiddenMessages(messageIds, label) {
    try {
      hiddenSyncPromise = Promise.resolve(timelineApi()?.syncHidden?.(messageIds))
        .catch(error => console.warn(`[记忆引擎] ${label}`, error));
    } catch (error) {
      console.warn(`[记忆引擎] ${label}`, error);
      hiddenSyncPromise = Promise.resolve();
    }
    return hiddenSyncPromise;
  }

  function collectCharacterCandidates(state, character, globalSeen) {
    const records = [];
    for (const name of character?.names || []) records.push(...(state.knowledge_index?.[normalized(name)] || []));
    return records.filter(record => {
      const key = `${record.ownerId}\u0000${record.time}\u0000${record.memory}`;
      return !globalSeen.has(key);
    }).filter((record, index, list) => list.findIndex(other =>
      other.ownerId === record.ownerId && other.time === record.time && other.memory === record.memory
    ) === index);
  }

  function tokenizeSearchText(text) {
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

  function scoreArchivedSmallSummary(item, queryTokens, scanLower, index, total) {
    if (!item || item.status === 'stale' || item.status === 'failed' || !clean(item.content)) return 0;
    let score = 0;
    for (const kw of Array.isArray(item.keywords) ? item.keywords : []) {
      const low = clean(kw).toLocaleLowerCase();
      if (!low) continue;
      if (scanLower.includes(low)) score += 12;
      else {
        for (const t of tokenizeSearchText(low)) if (queryTokens.has(t)) score += 4;
      }
    }
    for (const ent of Array.isArray(item.entityNames) ? item.entityNames : []) {
      const low = clean(ent).toLocaleLowerCase();
      if (low && scanLower.includes(low)) score += 8;
    }
    const contentTokens = tokenizeSearchText(item.content);
    let overlap = 0;
    for (const token of contentTokens) if (queryTokens.has(token)) overlap++;
    if (contentTokens.size > 0 && overlap > 0) {
      score += Math.min(8, overlap * 1.5);
    }
    if (score <= 0) return 0;
    if (item.impactLevel === 'key') score += 2;
    score += total > 1 ? (index / total) * 2 : 0;
    return score;
  }

  function buildBudgetedSections(blocks, maxChars) {
    const budget = Math.max(500, parseInt(maxChars) || 3500);
    const active = blocks.filter(block => block && clean(block.text)).map(block => ({ ...block }));
    const join = list => list.map(item => item.text).filter(Boolean).join('\n\n');
    if (join(active).length <= budget) return join(active);
    // 预算超出时优先逐行裁剪低优先级区块（碎记忆/实体历史 → 历史唤醒 → 旧总述 → 弧光 → 持续事实），保留主干和标题头。
    const sortedIndexes = active
      .map((item, idx) => ({ idx, priority: Number(item.priority) || 0 }))
      .sort((a, b) => a.priority - b.priority)
      .map(entry => entry.idx);
    for (const idx of sortedIndexes) {
      if (join(active).length <= budget) break;
      const lines = active[idx].text.split('\n');
      while (lines.length > 2 && join(active).length > budget) {
        lines.pop();
        active[idx].text = lines.join('\n');
      }
      if (join(active).length > budget) {
        const overflow = join(active).length - budget;
        if (active[idx].text.length <= overflow + 24) active[idx].text = '';
        else active[idx].text = Array.from(active[idx].text).slice(0, Math.max(0, Array.from(active[idx].text).length - overflow - 3)).join('') + '…';
      }
    }
    return join(active);
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
    ensureEntityState(state);
    ensureStructuredMemoryState(state);
    const eventMemory = ensureEventState(state);
    const activeFacts = (state.ongoing_facts || []).filter(item => item.status === 'active');
    const arcs = Array.isArray(state.character_arcs) ? state.character_arcs : [];
    const hasPeople = Boolean(state?.personal_memory?.length);
    const hasEntities = ENTITY_TYPES.some(type => state.entity_memory[type].length);
    const hasEvents = Boolean(eventMemory.big_summaries.length || eventMemory.small_summaries.length);
    if (!hasPeople && !hasEntities && !hasEvents && !activeFacts.length && !arcs.length) {
      clearInjection();
      syncHiddenMessages(new Set(), '恢复正文失败');
      return '';
    }
    if (!state.knowledge_index || !Object.keys(state.knowledge_index).length) rebuildKnowledgeIndex(state);
    const scan = chat().slice(-Math.max(1, parseInt(st.searchDepth) || 5)).map(message => clean(message?.mes)).join('\n');
    const scanLower = scan.toLocaleLowerCase();
    const queryTokens = tokenizeSearchText(scan);
    let bridgeActors = [];
    let bridgeHints = {};
    let vectorRecall = null;
    try {
      const bridge = window.STORY_ENGINE_BRIDGE;
      if (bridge) {
        bridgeActors = bridge.getOutlineActiveActors?.() || [];
        bridgeHints = bridge.getCrossInjectionHints?.() || {};
      }
    } catch (_) {}
    try {
      vectorRecall = st.vectorEnabled === true ? window.MEMORY_ENGINE_VECTOR?.getRecallScoresForInjection?.() : null;
    } catch (_) {}
    const bridgeActorSet = new Set(bridgeActors.map(normalized).filter(Boolean));
    const appearsInScan = name => {
      if (!name) return false;
      if (bridgeActorSet.has(normalized(name))) return true;
      return new RegExp(String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u').test(scan);
    };
    const matched = (state.personal_memory || []).filter(character =>
      (character.names || []).some(appearsInScan) || Number(vectorRecall?.personScores?.[character.id]) > 0
    ).sort((a, b) => {
      const aAppear = (a.names || []).some(appearsInScan) ? 1 : 0;
      const bAppear = (b.names || []).some(appearsInScan) ? 1 : 0;
      const aScore = aAppear * 0.5 + (Number(vectorRecall?.personScores?.[a.id]) || 0);
      const bScore = bAppear * 0.5 + (Number(vectorRecall?.personScores?.[b.id]) || 0);
      return bScore - aScore;
    });
    const matchedEntities = ENTITY_TYPES.flatMap(type => state.entity_memory[type]
      .filter(entity => unique([entity.name, ...(entity.aliases || [])]).some(appearsInScan)
        || Number(vectorRecall?.entityScores?.[`${type}:${entity.id}`]) > 0)
      .map(entity => ({
        type,
        entity,
        rankScore: (unique([entity.name, ...(entity.aliases || [])]).some(appearsInScan) ? 0.5 : 0)
          + (Number(vectorRecall?.entityScores?.[`${type}:${entity.id}`]) || 0)
      })))
      .sort((a, b) => b.rankScore - a.rankScore);
    const blocks = [], globalSeen = new Set(), limit = Math.max(1, parseInt(st.maxPerCharacter) || 20);

    // P0: 持续生效事实（与当前场景人物/扫描词元/语义向量命中者优先排前）
    const factsLimit = Math.max(0, parseInt(st.injectOngoingFactsLimit ?? 15) || 0);
    if (factsLimit > 0 && activeFacts.length) {
      const sortedFacts = activeFacts.map((fact, idx) => {
        const vecScore = Number(vectorRecall?.factScores?.[fact.id]) || 0;
        const hit = (fact.subject && appearsInScan(fact.subject) ? 10 : 0)
          + (Array.isArray(fact.keywords) ? fact.keywords.filter(kw => scanLower.includes(clean(kw).toLocaleLowerCase())).length * 4 : 0)
          + vecScore * 30;
        return { fact, hit, idx };
      }).sort((a, b) => (b.hit - a.hit) || (b.idx - a.idx)).slice(0, factsLimit);
      blocks.push({
        priority: 90,
        text: `【长期持续事实】\n${sortedFacts.map(({ fact }) =>
          `- [${fact.category || '状态'} · ${fact.subject || '全局'}] ${fact.fact}`
        ).join('\n')}`
      });
    }

    const bigLimit = Math.max(1, parseInt(st.bigSummaryInjectLimit) || 3);
    const validBig = eventMemory.big_summaries.filter(item => item.status !== 'stale' && item.status !== 'failed');
    const recentBig = validBig.slice(-bigLimit);
    if (recentBig.length) {
      blocks.push({
        priority: 80,
        text: `【故事总述】\n${recentBig.map(item =>
          `- [楼层 ${item.startLayer}-${item.endLayer}] ${item.content}`
        ).join('\n')}`
      });
    }
    // 总述注入上限只控制进入 prompt 的总述数量；判断纪要是否已经整理时，
    // 必须查看全部有效总述，避免旧总述退出注入窗口后其子纪要重新被注入。
    const coveredChildIds = new Set(validBig.flatMap(item => item.childIds || []));
    const hasStructuredOverview = eventMemory.big_summaries.some(item => Array.isArray(item.childIds) && item.childIds.length);
    const pendingSmall = eventMemory.small_summaries.filter((item, index) => {
      if (item.status === 'stale' || item.status === 'failed') return false;
      // 新结构按 childIds 精确判断；旧数据没有 childIds 时继续兼容游标。
      if (hasStructuredOverview) return !coveredChildIds.has(item.id);
      return index >= eventMemory.big_summary_cursor;
    });
    if (pendingSmall.length) {
      const worldDigestTrim = clean(bridgeHints.worldDigestTrim);
      blocks.push({
        priority: 85,
        text: `【近期事件纪要】\n${pendingSmall.map(item => {
          const isWorldDup = item.source === 'world_engine' && worldDigestTrim && clean(item.content) === worldDigestTrim;
          const prefix = isWorldDup ? '[世界同步] ' : '';
          return `- [楼层 ${item.startLayer}-${item.endLayer}] ${prefix}${item.content}`;
        }).join('\n')}`
      });
    }

    // P3: 对已折叠进总述的历史纪要，综合本地关键词/词元重合与 Embedding/Rerank 语义召回精准唤醒
    const recallLimit = Math.max(0, parseInt(st.recallArchivedSmallLimit ?? 3) || 0);
    if (recallLimit > 0 && hasStructuredOverview) {
      const archivedSmall = eventMemory.small_summaries.filter(item =>
        item.status !== 'stale' && item.status !== 'failed' && coveredChildIds.has(item.id)
      );
      const recalled = archivedSmall
        .map((item, idx) => {
          const lexical = scoreArchivedSmallSummary(item, queryTokens, scanLower, idx, archivedSmall.length);
          const vecScore = Number(vectorRecall?.smallScores?.[item.id]) || 0;
          return { item, score: lexical + vecScore * 35, vecScore };
        })
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, recallLimit);
      if (recalled.length) {
        const hasVectorHits = recalled.some(entry => entry.vecScore > 0);
        const title = hasVectorHits ? '【语义与关键词召回历史细节】' : '【关键词召回历史细节】';
        blocks.push({
          priority: 65,
          text: `${title}\n${recalled.map(({ item, vecScore }) => {
            const tags = [
              item.keywords?.length ? `#${item.keywords.slice(0, 3).join(' #')}` : '',
              vecScore > 0 ? `语义 ${(vecScore * 100).toFixed(0)}%` : ''
            ].filter(Boolean).join(' · ');
            return `- [楼层 ${item.startLayer}-${item.endLayer}${tags ? ` · ${tags}` : ''}] ${item.content}`;
          }).join('\n')}`
        });
      }
    }

    // P4: 匹配人物（优先附带角色弧光卡片 + 主观记忆采样）
    const arcLimit = Math.max(0, parseInt(st.injectCharacterArcsLimit ?? 6) || 0);
    let injectedArcCount = 0;
    const arcMap = new Map();
    for (const arc of arcs) {
      if (arc.characterId) arcMap.set(arc.characterId, arc);
      for (const n of arc.names || []) arcMap.set(normalized(n), arc);
    }
    for (const character of matched) {
      const charArc = arcMap.get(character.id) || (character.names || []).map(n => arcMap.get(normalized(n))).find(Boolean);
      const candidates = collectCharacterCandidates(state, character, globalSeen);
      const selected = exponentialMemorySample(candidates, limit, Math.random, st.injectionDiceSides);
      selected.forEach(record => globalSeen.add(`${record.ownerId}\u0000${record.time}\u0000${record.memory}`));
      const charLines = [];
      if (charArc && injectedArcCount < arcLimit && (charArc.currentStance || charArc.arcSummary || charArc.relationship)) {
        injectedArcCount++;
        charLines.push(`- [角色弧光 ${charArc.progressPct ?? 0}%${charArc.relationship ? ` · ${charArc.relationship}` : ''}] ${charArc.currentStance || ''}${charArc.arcSummary ? `｜${charArc.arcSummary}` : ''}`);
      }
      if (selected.length) {
        charLines.push(...selected.map(record => `- [${record.time || '时间未明'}] ${record.memory}`));
      }
      if (charLines.length) {
        blocks.push({
          priority: 50,
          text: `【${character.names?.[0] || character.id}】\n${charLines.join('\n')}`
        });
      }
    }
    if (matchedEntities.length) {
      const entitySections = matchedEntities.map(({ type, entity }) => {
        const lines = [`【${ENTITY_LABELS[type]}：${entity.name}】`, entity.description];
        const history = exponentialMemorySample(
          Array.isArray(entity.history) ? entity.history : [], limit, Math.random, st.injectionDiceSides
        );
        if (history.length) lines.push(...history.map(entry => `- [${entry.time || '时间未明'}] ${entry.event}`));
        return lines.filter(Boolean).join('\n');
      });
      blocks.push({
        priority: 40,
        text: `【相关世界实体】\n${entitySections.join('\n\n')}`
      });
    }
    const coveredRefs = timelineApi()?.unionRefs?.([
      ...recentBig.map(item => item.sourceRefs || []),
      ...pendingSmall.map(item => item.sourceRefs || [])
    ]) || [];
    const api = timelineApi();
    const coveredMessageIds = (() => {
      if (st.hideCoveredRawText === false) return new Set();
      const baseKeep = st.recentRawRounds === undefined ? 1 : Math.max(0, parseInt(st.recentRawRounds) || 0);
      const delayKeep = Math.max(0, parseInt(st.summaryDelayFloors) || 0);
      const keepRawRounds = Math.max(baseKeep, delayKeep);
      const recentMessageIds = recentRawRoundMessageIds(chat(), keepRawRounds, st, api);
      return selectHiddenMessageIds(coveredRefs, data()?.getChatId?.(), recentMessageIds);
    })();
    syncHiddenMessages(coveredMessageIds, '同步正文覆盖失败');
    if (!blocks.length) { clearInjection(); return ''; }
    const header = `${SENTINEL}\n事件总结记录对话中已经发生的剧情；持续事实记录当前长期生效的约束；人物条目包含阶段弧光与当前场景人物知晓的主观记忆（允许彼此矛盾）；实体条目记录相关组织、物件、能力与地点的当前描述和本地历史。\n\n`;
    const maxBodyChars = Math.max(300, (parseInt(st.memoryInjectMaxChars) || 3500) - header.length);
    const body = buildBudgetedSections(blocks, maxBodyChars);
    if (!body) { clearInjection(); return ''; }
    const content = `${header}${body}`;
    registerInjection(content);
    return content;
  }

  function buildWorldEngineContext(worldState) {
    const st = settings();
    if (st.engineEnabled === false || st.injectIntoWorldEngine !== true || !worldState) return '';
    const state = data().loadState();
    ensureEntityState(state);
    ensureStructuredMemoryState(state);
    if (!state.knowledge_index || !Object.keys(state.knowledge_index).length) rebuildKnowledgeIndex(state);
    const scan = JSON.stringify(worldState);
    const appears = name => name && scan.includes(String(name));
    const limit = Math.max(1, parseInt(st.worldEngineMemoryLimit) || 5);
    const sections = [], seenRecords = new Set();
    const matchedFacts = (state.ongoing_facts || []).filter(item =>
      item.status === 'active' && (appears(item.subject) || (item.keywords || []).some(appears) || item.subject === '全局')
    ).slice(-6);
    if (matchedFacts.length) {
      sections.push(`【相关持续事实】\n` + matchedFacts.map(item =>
        `- [${item.category || '状态'} · ${item.subject || '全局'}] ${item.fact}`
      ).join('\n'));
    }
    for (const character of state.personal_memory || []) {
      if (!(character.names || []).some(appears)) continue;
      const candidates = collectCharacterCandidates(state, character, seenRecords);
      const selected = exponentialMemorySample(candidates, limit, Math.random, st.injectionDiceSides);
      selected.forEach(record => seenRecords.add(`${record.ownerId}\u0000${record.time}\u0000${record.memory}`));
      if (selected.length) sections.push(`【人物：${character.names?.[0] || character.id}】\n` +
        selected.map(record => `- [${record.time || '时间未明'}] ${record.memory}`).join('\n'));
    }
    for (const type of ENTITY_TYPES) {
      for (const entity of state.entity_memory[type] || []) {
        if (!unique([entity.name, ...(entity.aliases || [])]).some(appears)) continue;
        const lines = [`【${ENTITY_LABELS[type]}：${entity.name}】`];
        if (entity.description) lines.push(entity.description);
        lines.push(...exponentialMemorySample(
          Array.isArray(entity.history) ? entity.history : [], limit, Math.random, st.injectionDiceSides
        )
          .map(entry => `- [${entry.time || '时间未明'}] ${entry.event}`));
        sections.push(lines.join('\n'));
      }
    }
    if (!sections.length) return '';
    return `【记忆引擎提供的相关人物与实体信息】\n以下信息只用于辅助世界推演；不包含纪要或总述。\n\n${sections.join('\n\n')}`;
  }

  function buildLightweightWorldEntities(worldUpdate) {
    const groups = {};
    for (const type of ENTITY_TYPES) groups[type] = [];
    if (!worldUpdate || typeof worldUpdate !== 'object') return groups;
    for (const faction of Array.isArray(worldUpdate.factions) ? worldUpdate.factions : []) {
      const name = clean(faction?.name);
      if (!name) continue;
      const desc = [faction.status && `状态:${faction.status}`, faction.relation && `关系:${faction.relation}`, faction.currentGoal && `目标:${faction.currentGoal}`].filter(Boolean).join(' · ');
      groups.organization.push({ name, aliases: [], description: desc, event: clean(faction.event || ''), time: '' });
    }
    for (const evt of Array.isArray(worldUpdate.events) ? worldUpdate.events : []) {
      const name = clean(evt?.name), desc = clean(evt?.desc);
      if (!name || !desc) continue;
      if (['已爆发', '已完成'].includes(evt.stage)) {
        groups.organization.push({ name: clean(evt.faction || name), aliases: [], description: '', event: Array.from(`事件「${name}」进入${evt.stage}：${desc}`).slice(0, 50).join(''), time: '' });
      }
    }
    return groups;
  }

  function syncVerifiedOutlineKnowledge(events) {
    const st = settings();
    if (st.engineEnabled === false || !Array.isArray(events) || !events.length) return { changed: 0 };
    const nameBlacklist = configuredNameBlacklist(st);
    const state = data().loadState();
    const timeline = ensureTimelineState(state);
    let changed = 0;
    const personal = [];
    for (const entry of events) {
      const names = unique(entry?.actorNames || [entry?.actorId]).filter(n => !nameIsBlacklisted(n, nameBlacklist));
      const memory = Array.from(clean(entry?.memory)).slice(0, 50).join('');
      const eventId = clean(entry?.outlineEventId);
      if (!names.length || !memory) continue;
      const duplicateNode = eventId && timeline.nodes.some(node =>
        node.status === 'valid' && node.kind === 'outline_verified' && node.outlineEventId === eventId
      );
      if (duplicateNode) continue;
      personal.push({ name: names, known_by: [], memory, time: clean(entry?.time), outlineEventId: eventId });
    }
    if (!personal.length) return { changed: 0 };
    const layer = Number.isFinite(Number(events[0]?.layer)) ? Number(events[0].layer) : currentLayer();
    for (const item of personal) {
      changed += mergeMemories(state, [item]);
      const refs = Array.isArray(events.find(e => e.outlineEventId === item.outlineEventId)?.sourceRefs)
        ? clone(events.find(e => e.outlineEventId === item.outlineEventId).sourceRefs)
        : [];
      timeline.nodes.push({
        id: nextTimelineNodeId(timeline),
        kind: 'outline_verified',
        outlineEventId: item.outlineEventId,
        originChatId: data()?.getChatId?.() || 'default',
        startLayer: layer,
        endLayer: layer,
        sourceRefs: refs,
        sourceDigest: timelineApi()?.digestRefs?.(refs) || `outline:${item.outlineEventId || Date.now()}`,
        personal: [item],
        entities: {},
        factUpdates: [],
        arcUpdates: [],
        status: 'valid',
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }
    data().saveState(replayTimeline(state));
    applyInjection();
    refreshMemoryPanel();
    return { changed };
  }

  function getSnapshotSummaryForBridge() {
    try {
      const state = data().loadState();
      ensureEntityState(state);
      ensureStructuredMemoryState(state);
      const events = ensureEventState(state);
      return {
        ongoingFacts: clone((state.ongoing_facts || []).filter(item => item.status === 'active')),
        characterArcs: clone(state.character_arcs || []),
        recentSmallSummaries: clone((events.small_summaries || []).filter(item => item.status === 'valid').slice(-5)),
        recentBigSummaries: clone((events.big_summaries || []).filter(item => item.status === 'valid').slice(-2)),
        peopleRoster: (state.personal_memory || []).map(p => ({ id: p.id, names: unique(p.names) })),
        entityRoster: ENTITY_TYPES.flatMap(type => (state.entity_memory[type] || []).map(e => ({
          id: e.id, type, name: e.name, aliases: unique(e.aliases), description: clean(e.description)
        })))
      };
    } catch (_) {
      return null;
    }
  }

  async function ingestWorldEvolution(payload) {
    const originChatId = data().getChatId();
    const worldSettings = window.WORLD_ENGINE_API?.getSettings?.(true) || {};
    if (worldSettings.memoryLinkEnabled !== true && payload?.force !== true) return { skipped: true, reason: 'disabled' };
    const st = settings();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭，无法执行世界联动');
    if (backfillRunning) throw new Error('记忆引擎正在批量重填，暂不能执行世界联动');
    const layer = Number.isFinite(Number(payload?.layer)) ? Number(payload.layer) : currentLayer();
    // 普通记忆提取先开始时，等待它完整落库；不得并发读取同一基底后互相覆盖。
    const deadline = Date.now() + Math.max(10000, Number(st.apiTimeoutMs) || 120000);
    while (running && Date.now() < deadline) await delay(100);
    if (running) throw new Error('等待当前记忆任务结束超时');
    if (originChatId !== data().getChatId()) throw new Error('聊天已经切换，世界记忆联动已取消');
    if (payload?.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(payload.worldCommitId) === false) return { skipped: true, reason: 'stale-world-commit' };
    if (payload?.replace === true) rollbackLinkedLayer(layer);

    const digest = clean(payload?.worldDigest);
    if (!digest) return { skipped: true, reason: 'empty_digest' };
    const sourceKey = `${data().getChatId()}:${layer}`;
    const safeWorldUpdate = window.STORY_ENGINE_PROJECTION?.active?.()
      ? window.STORY_ENGINE_PROJECTION.forMemory(payload?.worldUpdate || {}) : payload?.worldUpdate;
    const worldInfo = safeWorldUpdate && typeof safeWorldUpdate === 'object'
      ? JSON.stringify(safeWorldUpdate, null, 2)
      : digest;
    const attemptBase = data().loadState();

    // 轻同步模式（不发起额外的记忆提取 LLM API 调用，直接落库公开世界节点并在总述到阈时只归纳大总结）
    if (payload?.lightweight === true) {
      const next = clone(attemptBase);
      const lightweightEntities = buildLightweightWorldEntities(safeWorldUpdate);
      const entityChanges = mergeEntityMemories(next, lightweightEntities);
      const factUpdates = (Array.isArray(safeWorldUpdate?.worldTrends) ? safeWorldUpdate.worldTrends : [])
        .filter(trend => clean(trend?.name) && clean(trend?.description))
        .slice(0, 3)
        .map(trend => ({
          action: trend.status === '已结束' ? 'resolve' : 'upsert',
          category: '设定',
          subject: clean(trend.name),
          fact: Array.from(clean(trend.description)).slice(0, 120).join(''),
          keywords: unique([trend.name, trend.scope])
        }));
      const factChanges = factUpdates.length
        ? mergeOngoingFacts(next, factUpdates, layer, null, clean(payload?.worldCommitId))
        : 0;
      appendTimelineNode(next, {
        personal: [],
        entities: lightweightEntities,
        factUpdates,
        arcUpdates: []
      }, {
        kind: 'world_link',
        sourceKey,
        worldCommitId: clean(payload?.worldCommitId),
        startLayer: layer,
        endLayer: layer,
        conversation: digest
      }, { layer });
      const eventMemory = ensureEventState(next);
      const worldKeywords = unique([
        ...(Array.isArray(safeWorldUpdate?.factions) ? safeWorldUpdate.factions.map(f => f?.name) : []),
        ...(Array.isArray(safeWorldUpdate?.events) ? safeWorldUpdate.events.map(e => e?.name) : [])
      ]).slice(0, 6);
      eventMemory.small_summaries.push({
        id: nextSmallSummaryId(eventMemory),
        startLayer: layer,
        endLayer: layer,
        content: Array.from(digest).slice(0, 200).join(''),
        keywords: worldKeywords,
        entityNames: worldKeywords,
        impactLevel: 'normal',
        source: 'world_engine',
        sourceKey,
        ...(payload?.worldCommitId ? { worldCommitId: clean(payload.worldCommitId) } : {}),
        status: 'valid',
        revision: 1
      });
      data().saveState(next);
      window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.afterEvolution?.();
      applyInjection();
      refreshMemoryPanel();
      const bigTask = buildBigTask(next, false);
      let updatedBig = 0;
      if (bigTask) {
        const bigRes = await runTasks({ big: bigTask }, { baseState: next, saveCheckpoint: false });
        updatedBig = Number(bigRes?.updatedBig || 0);
      }
      return {
        lightweight: true,
        added: entityChanges.entities + entityChanges.history + entityChanges.descriptions + factChanges + 1 + updatedBig,
        addedSmall: 1,
        updatedBig,
        state: data().loadState()
      };
    }

    try {
      const result = await runTasksThenDueBig({
        memory: {
          conversation: `【世界引擎本轮返回】\n${worldInfo}\n\n以上是客观世界信息。只更新其中明确支持的人物认知与世界实体，不得猜测任何人物知晓未公开信息。`,
          sourceKey,
          worldCommitId: clean(payload?.worldCommitId),
          startLayer: layer,
          endLayer: layer,
          kind: 'world_link'
        }
      }, {
        layer,
        baseState: attemptBase,
        saveCheckpoint: false,
        worldDigestMinute: { layer, sourceKey, content: digest, worldCommitId: clean(payload?.worldCommitId) }
      });
      return result;
    } catch (error) {
      // 联动失败只撤销本次联动尝试；同楼层已完成的普通记忆提取仍应保留。
      if (originChatId === data().getChatId() && !(payload?.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(payload.worldCommitId) === false)) {
        data().saveState(attemptBase); applyInjection();
      }
      throw error;
    }
  }

  function invalidateWorldCommits(ids) {
    const removed = new Set(Array.isArray(ids) ? ids : []);
    if (!removed.size) return { changed: false };
    const state = data().loadState(), timeline = ensureTimelineState(state), events = ensureEventState(state);
    const archive = state.world_commit_archive || { nodes: [], smallSummaries: [], bigSummaries: [] };
    archive.nodes = Array.isArray(archive.nodes) ? archive.nodes : [];
    archive.smallSummaries = Array.isArray(archive.smallSummaries) ? archive.smallSummaries : [];
    archive.bigSummaries = Array.isArray(archive.bigSummaries) ? archive.bigSummaries : [];
    const preserve = (items, value) => {
      const index = items.findIndex(item => item.record?.id === value.record.id && item.record?.worldCommitId === value.record.worldCommitId);
      if (index < 0) items.push(value); else items[index] = value;
    };
    timeline.nodes.forEach((record, position) => { if (removed.has(record.worldCommitId)) preserve(archive.nodes, { record: clone(record), position }); });
    events.small_summaries.forEach((record, position) => { if (removed.has(record.worldCommitId)) preserve(archive.smallSummaries, { record: clone(record), position }); });
    const removedMinuteIds = new Set(events.small_summaries.filter(item => removed.has(item.worldCommitId)).map(item => item.id));
    events.big_summaries.forEach((record, position) => {
      if (!(record.childIds || []).some(id => removedMinuteIds.has(id))) return;
      preserve(archive.bigSummaries, { record: clone(record), position,
        children: (record.childIds || []).map(id => {
          const child = events.small_summaries.find(item => item.id === id);
          return child ? { id, content: child.content, revision: child.revision, sourceDigest: child.sourceDigest || '', worldCommitId: child.worldCommitId || '' } : { id, missing: true };
        }) });
    });
    state.world_commit_archive = archive;
    const beforeNodes = timeline.nodes.length, beforeSmall = events.small_summaries.length;
    timeline.nodes = timeline.nodes.filter(node => !removed.has(node.worldCommitId));
    const removedMinutes = new Set(events.small_summaries.filter(item => removed.has(item.worldCommitId)).map(item => item.id));
    const oldCursor = Math.max(0, Math.min(events.small_summaries.length, Number(events.big_summary_cursor) || 0));
    const removedBeforeCursor = events.small_summaries.slice(0, oldCursor).filter(item => removedMinutes.has(item.id)).length;
    events.small_summaries = events.small_summaries.filter(item => !removedMinutes.has(item.id));
    for (const overview of events.big_summaries) if ((overview.childIds || []).some(id => removedMinutes.has(id))) overview.status = 'stale';
    if (beforeNodes === timeline.nodes.length && beforeSmall === events.small_summaries.length) return { changed: false };
    abortController?.abort();
    events.big_summary_cursor = Math.min(oldCursor - removedBeforeCursor, events.small_summaries.length);
    data().saveState(replayTimeline(state));
    applyInjection();
    return { changed: true, removedNodes: beforeNodes - timeline.nodes.length, removedMinutes: removedMinutes.size };
  }

  // preview 暂时撤下的世界贡献仍在同一聊天的完整存档中；只有原 commit 重新可信 active 才恢复。
  function restoreActiveWorldContributions() {
    const state = data().loadState(), archive = state.world_commit_archive;
    if (!archive || !window.STORY_ENGINE_HISTORY?.isCommitActive || window.STORY_ENGINE_HISTORY.isApplying?.() === true) return false;
    const active = record => record?.worldCommitId && window.STORY_ENGINE_HISTORY.isCommitActive(record.worldCommitId) === true;
    const timeline = ensureTimelineState(state), events = ensureEventState(state), smallIdMap = new Map();
    let changed = false;
    const restoredSmall = new Set();
    const insert = (items, record, position) => items.splice(Math.max(0, Math.min(items.length, Number(position) || 0)), 0, record);
    archive.nodes = (archive.nodes || []).filter(entry => {
      if (!active(entry.record)) return true;
      const record = clone(entry.record);
      if (!timeline.nodes.some(item => item.worldCommitId === record.worldCommitId && item.sourceDigest === record.sourceDigest)) {
        if (timeline.nodes.some(item => item.id === record.id)) record.id = nextTimelineNodeId(timeline);
        record.status = 'valid'; insert(timeline.nodes, record, entry.position);
      }
      changed = true; return false;
    });
    archive.smallSummaries = (archive.smallSummaries || []).filter(entry => {
      if (!active(entry.record)) return true;
      const record = clone(entry.record), originalId = record.id;
      const same = events.small_summaries.find(item => item.worldCommitId === record.worldCommitId && item.content === record.content && item.sourceKey === record.sourceKey);
      if (same) smallIdMap.set(originalId, same.id);
      else {
        if (events.small_summaries.some(item => item.id === record.id)) record.id = nextSmallSummaryId(events);
        record.status = 'valid'; insert(events.small_summaries, record, entry.position); smallIdMap.set(originalId, record.id);
      }
      restoredSmall.add(originalId); changed = true; return false;
    });
    archive.bigSummaries = (archive.bigSummaries || []).filter(entry => {
      const children = (entry.children || []).map(snapshot => ({ snapshot, child: events.small_summaries.find(item => item.id === (smallIdMap.get(snapshot.id) || snapshot.id)) }));
      const ready = children.length && children.every(({ snapshot, child }) => !snapshot.missing && child?.status === 'valid' &&
        child.content === snapshot.content && Number(child.revision || 1) === Number(snapshot.revision || 1) && (child.sourceDigest || '') === snapshot.sourceDigest &&
        (!child.worldCommitId || window.STORY_ENGINE_HISTORY.isCommitActive(child.worldCommitId) === true));
      if (!ready) {
        // 子纪要已被编辑时，不能仅凭旧 childDigest 把原总述重新标为 valid。
        if (children.some(({ snapshot }) => restoredSmall.has(snapshot.id))) {
          events.big_summaries = events.big_summaries.filter(item => item.id !== entry.record.id || item.content !== entry.record.content);
          changed = true;
        }
        return true;
      }
      const record = clone(entry.record), existingIndex = events.big_summaries.findIndex(item => item.id === record.id);
      record.childIds = children.map(item => item.child.id);
      record.childDigest = timelineApi()?.hashText?.(children.map(({ child }) => `${child.id}:${child.revision || 1}:${child.sourceDigest || ''}`).join('|')) || '';
      record.status = 'valid';
      if (existingIndex >= 0) {
        const existing = events.big_summaries[existingIndex];
        if (existing.status === 'stale' || existing.content === record.content) events.big_summaries[existingIndex] = record;
      } else insert(events.big_summaries, record, entry.position);
      changed = true; return false;
    });
    if (!changed) return false;
    const covered = new Set(events.big_summaries.filter(item => item.status === 'valid').flatMap(item => item.childIds || []));
    events.big_summary_cursor = 0;
    while (events.big_summary_cursor < events.small_summaries.length && covered.has(events.small_summaries[events.big_summary_cursor].id)) events.big_summary_cursor++;
    if (!archive.nodes.length && !archive.smallSummaries.length && !archive.bigSummaries.length) delete state.world_commit_archive;
    data().saveState(replayTimeline(state));
    return true;
  }

  function getQuarantineBackup(backupKey) {
    const chatId = data()?.getChatId?.() || 'default';
    const prefix = `memory_engine_quarantine_${chatId}_`;
    const key = clean(backupKey || window.WORLD_ENGINE_STORE?.getItem(`memory_engine_quarantine_latest_${chatId}`));
    if (!key.startsWith(prefix)) return null;
    try { return JSON.parse(window.WORLD_ENGINE_STORE?.getItem(key) || 'null'); } catch (_) { return null; }
  }

  // 仅由作者显式从头重建时调用。无来源 Root 和人工全量快照先完整备份，再退出自动注入。
  // 本地隔离不请求模型；仍有真实来源的节点继续沿原流程审计、修复。
  function quarantineUnprovenancedHistory(options) {
    const state = data().loadState(), chatId = data().getChatId(), timeline = ensureTimelineState(state), events = ensureEventState(state);
    const checkpoint = data().loadCheckpoint?.() || null, linkCheckpoint = data().loadLinkCheckpoint?.() || null;
    const stamp = Date.now(), prefix = `memory_engine_quarantine_${chatId}_`;
    let backupKey = prefix + stamp, suffix = 0;
    while (window.WORLD_ENGINE_STORE?.getItem(backupKey) != null) backupKey = prefix + stamp + '_' + ++suffix;
    const backup = { type: 'memory-engine-quarantine-backup', version: 1, chatId, createdAt: stamp,
      reason: clean(options?.reason || '作者显式从头重建，隔离无来源记忆'), state: clone(state), checkpoint: clone(checkpoint), linkCheckpoint: clone(linkCheckpoint) };
    const store = window.WORLD_ENGINE_STORE;
    const ownsTransaction = typeof store.beginTransaction === 'function' && !store.isTransactionActive?.();
    if (ownsTransaction) store.beginTransaction();
    try {
    // 备份失败则直接抛出：不能在没有可恢复副本时清理任何记忆。
    window.WORLD_ENGINE_STORE.setItem(backupKey, JSON.stringify(backup));
    window.WORLD_ENGINE_STORE.setItem(`memory_engine_quarantine_latest_${chatId}`, backupKey);
    try { window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.createSnapshot?.('无来源记忆隔离前完整备份'); } catch (_) { /* 独立本地备份已成功。 */ }
    abortController?.abort();
    const root = timeline.root?.base || {};
    const counts = { rootPeople: root.personal_memory?.length || 0,
      rootEntities: ENTITY_TYPES.reduce((total, type) => total + (root.entity_memory?.[type]?.length || 0), 0),
      manualNodes: 0, unprovenancedNodes: 0, staleNodes: 0, smallSummaries: 0, bigSummaries: 0 };
    const supported = record => {
      if (record?.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(record.worldCommitId) === true) return true;
      const refs = record?.sourceRefs;
      return Array.isArray(refs) && refs.length > 0 && refs.every(ref => clean(ref.chatId) === chatId && clean(ref.messageId) && ref.synthetic !== true);
    };
    const audited = record => {
      if (record.worldCommitId && window.STORY_ENGINE_HISTORY?.isCommitActive?.(record.worldCommitId) === true) return true;
      return timelineApi()?.auditRefs?.(record.sourceRefs)?.valid === true;
    };
    timeline.nodes = timeline.nodes.filter(node => {
      if (node.kind === 'manual_snapshot' || node.snapshot) { counts.manualNodes++; return false; }
      if (!supported(node)) { counts.unprovenancedNodes++; return false; }
      node.status = audited(node) ? 'valid' : 'stale'; if (node.status === 'stale') counts.staleNodes++;
      return true;
    });
    timeline.root.base = { personal_memory: [], knowledge_index: {}, entity_memory: { organization: [], object: [], ability: [], location: [] }, entity_index: {}, round: 0, chatLayer: null };
    events.small_summaries = events.small_summaries.filter(summary => {
      if (!supported(summary)) { counts.smallSummaries++; return false; }
      summary.status = audited(summary) ? 'valid' : 'stale'; return true;
    });
    const smallById = new Map(events.small_summaries.map(item => [item.id, item]));
    events.big_summaries = events.big_summaries.filter(summary => {
      const children = summary.childIds || [];
      if (!children.length || children.some(id => !smallById.has(id))) { counts.bigSummaries++; return false; }
      summary.status = children.every(id => smallById.get(id).status === 'valid') ? 'valid' : 'stale'; return true;
    });
    const covered = new Set(events.big_summaries.filter(item => item.status === 'valid').flatMap(item => item.childIds || []));
    events.big_summary_cursor = 0;
    while (events.big_summary_cursor < events.small_summaries.length && covered.has(events.small_summaries[events.big_summary_cursor].id)) events.big_summary_cursor++;
    // 隔离不是申请历史全量记忆重填；下一轮纪要从当前聊天基线继续。
    events.small_summary_layer = currentLayer();
    const safe = replayTimeline(state);
    data().saveState(safe);
    data().saveCheckpoint(safe);
    data().clearLinkCheckpoint?.();
    const persistence = ownsTransaction ? store.commitTransaction() : Promise.resolve();
    window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.afterEvolution?.();
    applyInjection(); refreshMemoryPanel();
    return { changed: true, backupKey, quarantined: counts, retainedNodes: safe.timeline.nodes.length, needsAuthorReview: true, persistence };
    } catch (error) {
      if (ownsTransaction && store.isTransactionActive?.()) store.rollbackTransaction();
      throw error;
    }
  }

  function setBackfillStatus(current, total, message) {
    backfillStatus = { running: backfillRunning, current, total, message: message || '' };
    const element = document.getElementById('we-memory-person-backfill-status');
    if (element) element.textContent = backfillStatus.message;
  }

  function setSummaryBackfillStatus(current, total, message) {
    summaryBackfillStatus = { running: backfillRunning, current, total, message: message || '' };
    const element = document.getElementById('we-memory-summary-backfill-status');
    if (element) element.textContent = summaryBackfillStatus.message;
  }

  async function backfill() {
    if (backfillRunning || running) return;
    const st = settings(), all = chat();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    const configuredEnd = Math.max(0, parseInt(st.backfillEndLayer) || 0);
    const end = Math.min(all.length - 1, configuredEnd || all.length - 1);
    const opening = ignoreFirstLayer(st);
    const aiLayers = all.map((message, index) => (!message?.is_user && index <= end && !(opening && index === 0) ? index : -1)).filter(i => i >= 0);
    const size = Math.max(1, parseInt(st.backfillBatchSize) || 5), batches = [];
    for (let i = 0; i < aiLayers.length; i += size) batches.push(aiLayers.slice(i, i + size));
    if (!batches.length) { setBackfillStatus(0, 0, '没有可重填的 AI 楼层'); return; }
    backfillRunning = true;
    window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.createSnapshot?.('记忆重填前自动备份');
    const original = data().loadState();
    data().saveCheckpoint(original);
    data().saveState({
      ...original,
      personal_memory: [],
      knowledge_index: {},
      entity_memory: { organization: [], object: [], ability: [], location: [] },
      entity_index: {},
      round: 0,
      chatLayer: null,
      timeline: null
    });
    try {
      for (let i = 0; i < batches.length && backfillRunning; i++) {
        const layers = batches[i], start = Math.max(0, layers[0] - 1), finish = layers.at(-1);
        setBackfillStatus(i, batches.length, `正在重填 ${i + 1} / ${batches.length}`);
        await extractConversation(formatMessages(all.slice(start, finish + 1), start), {
          startLayer: start,
          endLayer: finish,
          sourceRefs: timelineApi()?.captureRange?.(start, finish) || [],
          layer: finish, retries: st.backfillRetries, saveCheckpoint: true, allowWhileBackfill: true
        });
      }
      setBackfillStatus(batches.length, batches.length, backfillRunning ? '记忆重填完成' : '记忆重填已停止');
    } catch (error) {
      setBackfillStatus(backfillStatus.current, batches.length, `重填失败：${error?.message || error}`);
      throw error;
    } finally { backfillRunning = false; backfillStatus.running = false; applyInjection(); }
  }

  async function backfillSummaries() {
    if (backfillRunning || running) return;
    const st = settings(), all = chat();
    if (st.engineEnabled === false) throw new Error('记忆引擎已关闭');
    const configuredEnd = Math.max(0, parseInt(st.backfillEndLayer) || 0);
    const end = Math.min(all.length - 1, configuredEnd || all.length - 1);
    const opening = ignoreFirstLayer(st);
    const aiLayers = all.map((message, index) => (!message?.is_user && index <= end && !(opening && index === 0) ? index : -1)).filter(index => index >= 0);
    const size = Math.max(1, parseInt(st.summaryBackfillSmallEveryX) || 5), batches = [];
    for (let i = 0; i < aiLayers.length; i += size) batches.push(aiLayers.slice(i, i + size));
    if (!batches.length) { setSummaryBackfillStatus(0, 0, '没有可重填的 AI 楼层'); return; }
    backfillRunning = true;
    window.WORLD_ENGINE_CHATCACHE?.forScope?.('memory')?.createSnapshot?.('纪要与总述重填前自动备份');
    const original = data().loadState();
    data().saveCheckpoint(original);
    data().saveState({
      ...original,
      event_memory: { small_summaries: [], big_summaries: [], small_summary_layer: null, big_summary_cursor: 0 }
    });
    try {
      for (let i = 0; i < batches.length && backfillRunning; i++) {
        const layers = batches[i], firstAi = layers[0], finish = layers.at(-1);
        const start = firstAi > 0 && all[firstAi - 1]?.is_user ? firstAi - 1 : firstAi;
        const smallTask = {
          startLayer: start,
          endLayer: finish,
          conversation: formatMessages(all.slice(start, finish + 1), start),
          sourceRefs: timelineApi()?.captureRange?.(start, finish) || []
        };
        const state = data().loadState();
        setSummaryBackfillStatus(i, batches.length, `正在重填纪要与总述 ${i + 1} / ${batches.length}`);
        await runTasksThenDueBig({ small: smallTask }, {
          baseState: state, retries: st.backfillRetries, saveCheckpoint: true, allowWhileBackfill: true
        }, st.summaryBackfillBigEveryX);
      }
      setSummaryBackfillStatus(batches.length, batches.length, backfillRunning ? '纪要与总述重填完成' : '纪要与总述重填已停止');
    } catch (error) {
      setSummaryBackfillStatus(summaryBackfillStatus.current, batches.length, `纪要与总述重填失败：${error?.message || error}`);
      throw error;
    } finally { backfillRunning = false; summaryBackfillStatus.running = false; applyInjection(); }
  }

  function stopBackfill() {
    backfillRunning = false;
    abortController?.abort();
    setBackfillStatus(backfillStatus.current, backfillStatus.total, '正在停止…');
    setSummaryBackfillStatus(summaryBackfillStatus.current, summaryBackfillStatus.total, '正在停止…');
  }

  function refreshVectorRecallAsync(stateOverride) {
    try {
      const st = settings();
      if (st.engineEnabled === false || st.vectorEnabled !== true) return;
      const vecApi = window.MEMORY_ENGINE_VECTOR;
      if (!vecApi?.recallForQuery || vecApi.isRunning?.()) return;
      const scan = chat().slice(-Math.max(1, parseInt(st.searchDepth) || 5)).map(message => clean(message?.mes)).join('\n');
      if (!scan) return;
      Promise.resolve(vecApi.recallForQuery(scan, { state: stateOverride })).catch(err =>
        console.warn('[记忆引擎] 后台语义向量检索失败（已隔离）', err)
      );
    } catch (_) {}
  }

  function onMessageReceived() {
    const key = `${currentLayer()}:${clean(chat().at(-1)?.mes).slice(-80)}`;
    if (key === lastEventKey) return;
    lastEventKey = key;
    clearTimeout(autoTimer);
    if (window.STORY_ENGINE_BRIDGE?.shouldCoordinateGeneration?.()) {
      window.STORY_ENGINE_BRIDGE.scheduleTurn?.({ scope: 'memory', layer: currentLayer(), key, run: async () => {
        const res = await autoExtract();
        refreshVectorRecallAsync();
        return res;
      } });
      return;
    }
    autoTimer = setTimeout(async () => {
      try {
        await autoExtract();
      } catch (error) {
        console.error('[记忆引擎] 自动提取失败', error);
      } finally {
        refreshVectorRecallAsync();
      }
    }, 1500);
  }

  function schedulePreparation(delayMs = 50) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => prepareHistoryForGeneration()
      .catch(error => console.error('[记忆引擎] 历史摘要撤旧失败', error)), delayMs);
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
      }
      catch (error) { console.error(`[记忆引擎] ${label}事件处理失败`, error); }
    };
  }

  function init() {
    if (initialized) return;
    initialized = true;
    initializeSummaryBaseline();
    const ctx = context(), types = ctx?.event_types || {};
    if (ctx?.eventSource) {
      ctx.eventSource.on(types.GENERATION_ENDED || types.MESSAGE_RECEIVED || 'message_received', guardEvent('生成完成', onMessageReceived));
      ctx.eventSource.on(types.CHAT_LOADED || 'chat_loaded', guardEvent('聊天加载', () => {
        window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
        clearTimeout(autoTimer);
        abortController?.abort();
        lastEventKey = '';
        initializeSummaryBaseline();
        schedulePreparation(100);
      }));
      ctx.eventSource.on(types.MESSAGE_SWIPED || 'message_swiped', guardEvent('滑动重生成', () => {
        window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
        clearTimeout(autoTimer);
        abortController?.abort();
        if (window.STORY_ENGINE_PROJECTION?.active?.() === true) applyInjection();
        else if (!rollbackLinkedLayer(currentLayer())) applyInjection({ isReroll: true });
        schedulePreparation(50);
      }));
      ctx.eventSource.on(types.MESSAGE_DELETED || 'message_deleted', guardEvent('删除消息', () => {
        window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
        clearTimeout(autoTimer);
        abortController?.abort();
        lastEventKey = '';
        schedulePreparation(50);
      }));
      ctx.eventSource.on(types.GENERATION_STARTED || 'generation_started', guardEvent('生成开始', (type, _opts, dryRun) => {
        if (!dryRun) {
          window.STORY_ENGINE_BRIDGE?.cancelTurn?.();
          applyInjection({ isReroll: type === 'swipe' || type === 'regenerate' });
        }
      }));
    }
    try { applyInjection(); }
    catch (error) { console.error('[记忆引擎] 首次注入失败', error); }
  }

  return {
    init, applyInjection, buildWorldEngineContext, ingestWorldEvolution, manualExtract, manualReextract, extractNow: manualExtract,
    reconcileHistory, prepareHistoryForGeneration, replayTimeline, commitManualState,
    invalidateWorldCommits, syncVerifiedOutlineKnowledge, getSnapshotSummaryForBridge,
    quarantineUnprovenancedHistory, getQuarantineBackup,
    manualSmallSummary, manualBigSummary,
    backfill, backfillSummaries, stopBackfill, abort,
    repairStateIndexes, replaceKnownByRecords,
    getLastDebug: () => clone(lastDebug), getBackfillStatus: () => clone(backfillStatus),
    getSummaryBackfillStatus: () => clone(summaryBackfillStatus),
    getRunningLabel: () => runningLabel,
    isRunning: () => running || backfillRunning || reconciling,
    _test: {
      exponentialMemorySample, rollbackLinkedLayer, removeLinkedLayerFromState, rewindSummaryCursorForDeletedLayers,
      buildSmallHistoryContext, buildTaskReferenceContext, previousRawReference,
      parseResponse, selectHiddenMessageIds, recentRawRoundMessageIds,
      mergeOngoingFacts, mergeCharacterArcs, scoreArchivedSmallSummary, tokenizeSearchText, stableAutoEndLayer, autoExtract
    }
  };
})();
