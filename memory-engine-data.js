// memory-engine-data.js — 记忆引擎 7 表体系按聊天隔离的状态、规范化、重放操作与存档点（对齐 shujuku 核心 7 表）
window.MEMORY_ENGINE_DATA = (function() {
  const STATE_PREFIX = 'memory_engine_state_';
  const CHECKPOINT_PREFIX = 'memory_engine_checkpoint_';
  const LINK_CHECKPOINT_PREFIX = 'memory_engine_link_checkpoint_';
  const VERSION = '3.0.0';
  const SCHEMA_VERSION = 3;
  const TIMELINE_VERSION = 2;

  const TABLE_KEYS = Object.freeze([
    'global_state',
    'protagonist_info',
    'important_characters',
    'protagonist_skills',
    'inventory',
    'quests_events',
    'chronicle'
  ]);

  const TABLE_SCHEMAS = Object.freeze({
    global_state: Object.freeze({
      key: 'global_state',
      name: '全局数据表',
      shortName: '全局',
      mode: 'singleton',
      primaryKey: 'story_state',
      allowDelete: false,
      description: '记录当前主角所在三级地点与故事时间，有且仅有一行。',
      columns: Object.freeze([
        { key: 'story_state', label: '全局状态', required: true, readonly: true, defaultValue: '全局状态' },
        { key: 'current_location', label: '当前详细地点', required: true, placeholder: '仅写本级名称，如：御苑' },
        { key: 'current_minor_region', label: '当前次要地区', required: false, placeholder: '如：新宿区' },
        { key: 'current_major_region', label: '当前主要地区', required: false, placeholder: '如：东京都' },
        { key: 'prev_scene_time', label: '上轮场景时间', required: false, placeholder: 'YYYY-MM-DD HH:MM' },
        { key: 'elapsed_time', label: '经过的时间', required: false, placeholder: '如：30分 / 2小时 / 1天' },
        { key: 'cur_time', label: '当前时间', required: true, placeholder: 'YYYY-MM-DD HH:MM' }
      ])
    }),
    protagonist_info: Object.freeze({
      key: 'protagonist_info',
      name: '主角信息表',
      shortName: '主角',
      mode: 'singleton',
      primaryKey: 'name',
      allowDelete: false,
      description: '记录主角核心身份、外貌、近况、所在地点与随身财物，有且仅有一行。',
      columns: Object.freeze([
        { key: 'name', label: '姓名', required: true, placeholder: '主角姓名' },
        { key: 'gender', label: '性别', required: false, placeholder: '男 / 女 / 其他' },
        { key: 'age', label: '年龄', required: false, placeholder: '如：22' },
        { key: 'appearance', label: '外貌特征', required: false, multiline: true, placeholder: '整体印象与日常风格' },
        { key: 'identity_text', label: '身份', required: false, placeholder: '逗号分隔多项身份' },
        { key: 'current_condition', label: '近况', required: false, defaultValue: '一切如常', placeholder: '当前身体/情绪/心头牵挂' },
        { key: 'location_name', label: '所在地点', required: false, placeholder: '仅写地点名' },
        { key: 'belongings', label: '随身财物', required: false, multiline: true, placeholder: '当前随身携带的有意义物品' }
      ])
    }),
    important_characters: Object.freeze({
      key: 'important_characters',
      name: '重要角色表',
      shortName: '角色',
      mode: 'keyed',
      primaryKey: 'name',
      allowDelete: true,
      description: '记录所有对剧情有作用的重要角色；默认不删，离场仅更新在场状态。',
      columns: Object.freeze([
        { key: 'name', label: '姓名', required: true, placeholder: '唯一姓名，不得重名' },
        { key: 'gender', label: '性别', required: false, placeholder: '男 / 女' },
        { key: 'age', label: '年龄', required: false, placeholder: '如：20' },
        { key: 'brief_intro', label: '一句话介绍', required: true, placeholder: '≤15字客观身份事实，禁性格标签' },
        { key: 'appearance', label: '外貌特征', required: false, multiline: true, placeholder: '固有长相特征' },
        { key: 'outfit_text', label: '穿着打扮', required: false, multiline: true, placeholder: '当前服饰、饰品、持握物' },
        { key: 'location_name', label: '所在地点', required: false, placeholder: '当前所在地点名' },
        { key: 'presence_status', label: '在场状态', required: true, defaultValue: '在场', choices: ['在场', '离场'] },
        { key: 'relation_text', label: '人际关系', required: false, multiline: true, placeholder: '角色名:关系1,关系2;另一角色:关系' },
        { key: 'past_experience', label: '过往经历', required: false, multiline: true, placeholder: '增量整合关键经历，≤300字' }
      ])
    }),
    protagonist_skills: Object.freeze({
      key: 'protagonist_skills',
      name: '主角技能表',
      shortName: '技能',
      mode: 'keyed',
      primaryKey: 'skill_name',
      allowDelete: true,
      description: '记录主角掌握的技能、术法与专长；被剥夺或替换时删除。',
      columns: Object.freeze([
        { key: 'skill_name', label: '技能名称', required: true, placeholder: '唯一技能名' },
        { key: 'skill_type', label: '技能类型', required: true, defaultValue: '主动', choices: ['主动', '被动'] },
        { key: 'skill_level', label: '等级/阶段', required: false, placeholder: '如：Lv.1 / 精通' },
        { key: 'effect_desc', label: '效果描述', required: false, multiline: true, placeholder: '当前等级的具体效果' }
      ])
    }),
    inventory: Object.freeze({
      key: 'inventory',
      name: '背包物品表',
      shortName: '物品',
      mode: 'keyed',
      primaryKey: 'item_name',
      allowDelete: true,
      description: '记录主角持有的物品与装备；耗尽、丢弃或摧毁时删除。',
      columns: Object.freeze([
        { key: 'item_name', label: '物品名称', required: true, placeholder: '唯一物品名' },
        { key: 'quantity', label: '数量', required: true, defaultValue: '1', placeholder: '如：1 / 3' },
        { key: 'description', label: '描述/效果', required: false, multiline: true, placeholder: '功能、状态或背景说明' },
        { key: 'category', label: '类别', required: false, placeholder: '如：武器 / 消耗品 / 关键物品 / 杂物' }
      ])
    }),
    quests_events: Object.freeze({
      key: 'quests_events',
      name: '任务与事件表',
      shortName: '任务',
      mode: 'keyed',
      primaryKey: 'quest_name',
      allowDelete: true,
      description: '记录当前进行中的主线/支线任务与待解事件；完成、失败或过期后删除。',
      columns: Object.freeze([
        { key: 'quest_name', label: '任务名称', required: true, placeholder: '唯一任务/事件标题' },
        { key: 'quest_type', label: '任务类型', required: true, defaultValue: '支线任务', choices: ['主线任务', '支线任务'] },
        { key: 'issuer', label: '发布者', required: false, placeholder: '角色或势力' },
        { key: 'detail_desc', label: '详细描述', required: false, multiline: true, placeholder: '目标与具体要求' },
        { key: 'current_progress', label: '当前进度', required: false, placeholder: '当前推进阶段' },
        { key: 'time_limit', label: '任务时限', required: false, placeholder: '剩余期限或截止时间' },
        { key: 'reward', label: '奖励', required: false, placeholder: '完成后可获收益' },
        { key: 'penalty', label: '惩罚', required: false, placeholder: '失败后果' }
      ])
    }),
    chronicle: Object.freeze({
      key: 'chronicle',
      name: '纪要表',
      shortName: '纪要',
      mode: 'append',
      primaryKey: 'code_index',
      allowDelete: false,
      description: '按轮次/批次追加的客观事件纪要，带 AMXXXX 编码索引、概览、正文与重要对话。',
      columns: Object.freeze([
        { key: 'code_index', label: '编码索引', required: true, placeholder: 'AM0001' },
        { key: 'time_span', label: '时间跨度', required: false, placeholder: 'YYYY-MM-DD HH:MM ~ YYYY-MM-DD HH:MM' },
        { key: 'summary', label: '概览', required: true, placeholder: '≤30字一句话概括' },
        { key: 'chronicle_text', label: '纪要', required: true, multiline: true, placeholder: '客观中立的详细事件记录' },
        { key: 'key_dialogue', label: '重要对话', required: false, multiline: true, placeholder: '推动转折/承诺/揭秘的原文台词（可留空）' }
      ])
    })
  });

  function getChatId() {
    return window.WORLD_ENGINE_CORE?.getChatId?.() || 'default';
  }

  function key(prefix) { return prefix + getChatId(); }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  const clean = value => String(value == null ? '' : value).trim();
  const normalized = value => clean(value).toLocaleLowerCase();
  const unique = values => Array.from(new Set((Array.isArray(values) ? values : [values]).map(clean).filter(Boolean)));
  function parse(raw, fallback) {
    if (!raw) return clone(fallback);
    try { return JSON.parse(raw); } catch (_) { return clone(fallback); }
  }

  function emptyTables() {
    return {
      global_state: [],
      protagonist_info: [],
      important_characters: [],
      protagonist_skills: [],
      inventory: [],
      quests_events: [],
      chronicle: []
    };
  }

  function emptyWatermarks() {
    return {
      global_state: null,
      protagonist_info: null,
      important_characters: null,
      protagonist_skills: null,
      inventory: null,
      quests_events: null,
      chronicle: null
    };
  }

  function parseCodeIndexNum(code) {
    const m = /^AM(\d+)$/i.exec(clean(code));
    return m ? parseInt(m[1], 10) : 0;
  }

  function formatCodeIndex(num) {
    const n = Math.max(1, parseInt(num, 10) || 1);
    return `AM${String(n).padStart(4, '0')}`;
  }

  function nextChronicleCode(rows) {
    const max = (Array.isArray(rows) ? rows : []).reduce((acc, row) => Math.max(acc, parseCodeIndexNum(row?.code_index || row?.codeIndex)), 0);
    return formatCodeIndex(max + 1);
  }

  function deriveSummaryText(text) {
    const raw = clean(text).replace(/\s+/g, ' ');
    if (!raw) return '';
    const firstSentence = raw.split(/[。！？!?\n]/)[0] || raw;
    return Array.from(firstSentence).slice(0, 30).join('');
  }

  function resolveAiRecordBounds(item) {
    const fallbackStart = Number.isFinite(Number(item?.startLayer)) ? Number(item.startLayer) : 0;
    const fallbackEnd = Number.isFinite(Number(item?.endLayer)) ? Number(item.endLayer) : fallbackStart;
    if (item?.kind === 'manual_snapshot' || item?.source === 'world_engine') {
      return { startLayer: fallbackStart, endLayer: fallbackEnd };
    }
    const aiLayers = (Array.isArray(item?.sourceRefs) ? item.sourceRefs : [])
      .filter(ref => ref && !ref.synthetic && ref.role === 'assistant' && Number.isFinite(Number(ref.layer)))
      .map(ref => Number(ref.layer));
    if (!aiLayers.length) return { startLayer: fallbackStart, endLayer: fallbackEnd };
    return {
      startLayer: Math.min(...aiLayers),
      endLayer: Math.max(...aiLayers)
    };
  }

  function normalizeTableRow(sheetKey, raw, rowIdHint, usedCodes) {
    const schema = TABLE_SCHEMAS[sheetKey];
    if (!schema || !raw || typeof raw !== 'object') return null;
    const rowId = Math.max(1, parseInt(raw.rowId ?? raw.row_id ?? rowIdHint, 10) || 1);

    if (sheetKey === 'global_state') {
      const loc = clean(raw.current_location ?? raw.location);
      const minor = clean(raw.current_minor_region);
      const major = clean(raw.current_major_region);
      const prevTime = clean(raw.prev_scene_time);
      const elapsed = clean(raw.elapsed_time);
      const curTime = clean(raw.cur_time ?? raw.current_time);
      if (!loc && !minor && !major && !curTime && !prevTime && !elapsed) return null;
      return {
        rowId: 1,
        story_state: '全局状态',
        current_location: loc,
        current_minor_region: minor,
        current_major_region: major,
        prev_scene_time: prevTime,
        elapsed_time: elapsed,
        cur_time: curTime
      };
    }

    if (sheetKey === 'protagonist_info') {
      const name = clean(raw.name ?? raw.char_name);
      const gender = clean(raw.gender);
      const age = clean(raw.age);
      const appearance = clean(raw.appearance);
      const identity = clean(raw.identity_text ?? raw.occupation ?? raw.identity);
      const condition = clean(raw.current_condition) || (name ? '一切如常' : '');
      const loc = clean(raw.location_name);
      const belongings = clean(raw.belongings);
      if (!name && !appearance && !identity && !loc && !belongings) return null;
      return {
        rowId: 1,
        name,
        gender,
        age,
        appearance,
        identity_text: identity,
        current_condition: condition,
        location_name: loc,
        belongings
      };
    }

    if (sheetKey === 'important_characters') {
      const name = clean(raw.name);
      if (!name) return null;
      const rawPresence = clean(raw.presence_status);
      const presence = rawPresence === '离场' || clean(raw.is_absent) === '是' ? '离场' : '在场';
      return {
        rowId,
        name,
        gender: clean(raw.gender),
        age: clean(raw.age),
        brief_intro: clean(raw.brief_intro),
        appearance: clean(raw.appearance),
        outfit_text: clean(raw.outfit_text),
        location_name: clean(raw.location_name),
        presence_status: presence,
        relation_text: clean(raw.relation_text),
        past_experience: clean(raw.past_experience)
      };
    }

    if (sheetKey === 'protagonist_skills') {
      const skillName = clean(raw.skill_name ?? raw.name);
      if (!skillName) return null;
      const rawType = clean(raw.skill_type);
      return {
        rowId,
        skill_name: skillName,
        skill_type: rawType === '被动' ? '被动' : (rawType || '主动'),
        skill_level: clean(raw.skill_level),
        effect_desc: clean(raw.effect_desc ?? raw.description)
      };
    }

    if (sheetKey === 'inventory') {
      const itemName = clean(raw.item_name ?? raw.name);
      if (!itemName) return null;
      const qtyRaw = clean(raw.quantity);
      return {
        rowId,
        item_name: itemName,
        quantity: qtyRaw || '1',
        description: clean(raw.description),
        category: clean(raw.category)
      };
    }

    if (sheetKey === 'quests_events') {
      const questName = clean(raw.quest_name ?? raw.name ?? raw.title);
      if (!questName) return null;
      const rawType = clean(raw.quest_type);
      return {
        rowId,
        quest_name: questName,
        quest_type: rawType === '主线任务' || rawType === '主线' ? '主线任务' : (rawType || '支线任务'),
        issuer: clean(raw.issuer),
        detail_desc: clean(raw.detail_desc ?? raw.fact ?? raw.description),
        current_progress: clean(raw.current_progress),
        time_limit: clean(raw.time_limit),
        reward: clean(raw.reward),
        penalty: clean(raw.penalty)
      };
    }

    if (sheetKey === 'chronicle') {
      const chronicleText = clean(raw.chronicle_text ?? raw.content);
      if (!chronicleText) return null;
      const bounds = resolveAiRecordBounds(raw);
      let codeIndex = clean(raw.code_index ?? raw.codeIndex).toUpperCase();
      if (!/^AM\d{4,}$/.test(codeIndex) || (usedCodes && usedCodes.has(codeIndex))) {
        let candidateNum = Math.max(1, (usedCodes ? usedCodes.size : 0) + 1);
        while (usedCodes && usedCodes.has(formatCodeIndex(candidateNum))) candidateNum++;
        codeIndex = formatCodeIndex(candidateNum);
      }
      if (usedCodes) usedCodes.add(codeIndex);
      const id = clean(raw.id) || `small_${String(rowId).padStart(6, '0')}`;
      const normalizedRow = {
        id,
        rowId,
        code_index: codeIndex,
        time_span: clean(raw.time_span ?? raw.timeSpan),
        summary: clean(raw.summary) || deriveSummaryText(chronicleText),
        chronicle_text: chronicleText,
        key_dialogue: clean(raw.key_dialogue ?? raw.keyDialogue),
        startLayer: bounds.startLayer,
        endLayer: bounds.endLayer,
        keywords: unique(raw.keywords),
        entityNames: unique(raw.entityNames ?? raw.entities),
        impactLevel: raw.impactLevel === 'key' || raw.impact === 'key' ? 'key' : 'normal',
        ...(clean(raw.outlineChapterTitle) ? { outlineChapterTitle: clean(raw.outlineChapterTitle) } : {}),
        sourceRefs: Array.isArray(raw.sourceRefs) ? clone(raw.sourceRefs) : [],
        sourceDigest: clean(raw.sourceDigest),
        originChatId: clean(raw.originChatId),
        status: ['valid', 'stale', 'pending', 'failed'].includes(raw.status) ? raw.status : 'valid',
        revision: Math.max(1, parseInt(raw.revision, 10) || 1)
      };
      if (raw.source === 'world_engine') normalizedRow.source = 'world_engine';
      if (raw.sourceKey) normalizedRow.sourceKey = String(raw.sourceKey);
      if (raw.worldCommitId) normalizedRow.worldCommitId = clean(raw.worldCommitId);
      return normalizedRow;
    }

    return null;
  }

  function normalizeTables(rawTables) {
    const src = rawTables && typeof rawTables === 'object' && !Array.isArray(rawTables) ? rawTables : {};
    const out = emptyTables();
    for (const sheetKey of TABLE_KEYS) {
      const schema = TABLE_SCHEMAS[sheetKey];
      const list = Array.isArray(src[sheetKey]) ? src[sheetKey] : [];
      if (schema.mode === 'singleton') {
        const first = list.length ? normalizeTableRow(sheetKey, list[0], 1) : null;
        out[sheetKey] = first ? [first] : [];
        continue;
      }
      if (schema.mode === 'keyed') {
        const seen = new Map();
        let nextId = 1;
        for (const item of list) {
          const row = normalizeTableRow(sheetKey, item, nextId);
          if (!row) continue;
          const pk = normalized(row[schema.primaryKey]);
          if (!pk) continue;
          if (seen.has(pk)) {
            const idx = seen.get(pk);
            out[sheetKey][idx] = mergeRowFields(sheetKey, out[sheetKey][idx], row);
          } else {
            row.rowId = Math.max(nextId, row.rowId || nextId);
            nextId = row.rowId + 1;
            seen.set(pk, out[sheetKey].length);
            out[sheetKey].push(row);
          }
        }
        continue;
      }
      if (schema.mode === 'append') {
        const usedCodes = new Set();
        let nextId = 1;
        for (const item of list) {
          const row = normalizeTableRow(sheetKey, item, nextId, usedCodes);
          if (!row) continue;
          row.rowId = nextId++;
          out[sheetKey].push(row);
        }
      }
    }
    return out;
  }

  function mergeRowFields(sheetKey, existing, patch) {
    const schema = TABLE_SCHEMAS[sheetKey];
    if (!existing) return clone(patch);
    const merged = clone(existing);
    for (const col of schema.columns) {
      if (col.readonly) continue;
      const val = clean(patch?.[col.key]);
      if (val !== '') merged[col.key] = val;
    }
    if (sheetKey === 'global_state') merged.story_state = '全局状态';
    if (sheetKey === 'important_characters') {
      const rawPresence = clean(patch?.presence_status);
      if (rawPresence === '在场' || rawPresence === '离场') merged.presence_status = rawPresence;
    }
    return merged;
  }

  function nextRowIdFor(rows) {
    return (Array.isArray(rows) ? rows : []).reduce((max, row) => Math.max(max, parseInt(row?.rowId, 10) || 0), 0) + 1;
  }

  function applyTableOps(tables, ops, options) {
    const next = normalizeTables(tables);
    const list = Array.isArray(ops) ? ops : [];
    for (const op of list) {
      if (!op || typeof op !== 'object') continue;
      const sheetKey = clean(op.sheet);
      const schema = TABLE_SCHEMAS[sheetKey];
      if (!schema) continue;
      const action = clean(op.op || 'upsert').toLowerCase();

      if (schema.mode === 'singleton') {
        if (action === 'delete') continue;
        const dataObj = op.data && typeof op.data === 'object' ? op.data : op;
        if (next[sheetKey].length) {
          next[sheetKey][0] = mergeRowFields(sheetKey, next[sheetKey][0], dataObj);
        } else {
          const created = normalizeTableRow(sheetKey, dataObj, 1);
          if (created) next[sheetKey] = [created];
        }
        continue;
      }

      if (schema.mode === 'keyed') {
        const pkCol = schema.primaryKey;
        if (action === 'delete') {
          if (!schema.allowDelete) continue;
          const targetKey = normalized(op.key ?? op.data?.[pkCol] ?? op[pkCol]);
          const targetRowId = Number.isFinite(Number(op.rowId)) ? Number(op.rowId) : null;
          if (!targetKey && targetRowId === null) continue;
          next[sheetKey] = next[sheetKey].filter(row => {
            if (targetKey && normalized(row[pkCol]) === targetKey) return false;
            if (targetRowId !== null && Number(row.rowId) === targetRowId) return false;
            return true;
          });
          continue;
        }
        const dataObj = op.data && typeof op.data === 'object' ? op.data : op;
        const matchKey = normalized(op.key ?? dataObj[pkCol]);
        if (!matchKey) continue;
        const idx = next[sheetKey].findIndex(row => normalized(row[pkCol]) === matchKey);
        if (idx >= 0) {
          if (action === 'append_experience' && sheetKey === 'important_characters') {
            const existingExp = clean(next[sheetKey][idx].past_experience);
            const addedExp = clean(dataObj.past_experience);
            if (addedExp && !existingExp.includes(addedExp)) {
              next[sheetKey][idx] = {
                ...next[sheetKey][idx],
                past_experience: existingExp ? `${existingExp}；${addedExp}` : addedExp
              };
            }
          } else {
            next[sheetKey][idx] = mergeRowFields(sheetKey, next[sheetKey][idx], dataObj);
          }
        } else {
          const created = normalizeTableRow(sheetKey, dataObj, nextRowIdFor(next[sheetKey]));
          if (created) next[sheetKey].push(created);
        }
        continue;
      }

      if (schema.mode === 'append' && action !== 'delete') {
        const dataObj = op.data && typeof op.data === 'object' ? op.data : op;
        const usedCodes = new Set(next.chronicle.map(r => r.code_index));
        const created = normalizeTableRow('chronicle', {
          ...dataObj,
          ...(options?.meta || {})
        }, nextRowIdFor(next.chronicle), usedCodes);
        if (created) next.chronicle.push(created);
      }
    }
    return next;
  }

  function hasAnyTableRows(tables) {
    if (!tables || typeof tables !== 'object') return false;
    return TABLE_KEYS.some(k => Array.isArray(tables[k]) && tables[k].length > 0);
  }

  function migrateLegacyIntoTables(raw) {
    const tables = emptyTables();
    // 1. 旧 personal_memory + character_arcs -> important_characters
    const arcs = Array.isArray(raw?.character_arcs) ? raw.character_arcs : [];
    const people = Array.isArray(raw?.personal_memory) ? raw.personal_memory : [];
    let charRowId = 1;
    for (const person of people) {
      const names = unique(person?.names);
      const mainName = names[0];
      if (!mainName) continue;
      const basic = person?.profile?.basicInfo || person?.profile?.basic_info || {};
      const arc = arcs.find(a => a?.characterId === person.id || unique(a?.names || a?.name).some(n => names.includes(n)));
      const memSnippets = Object.values(person?.memory || {}).flat().map(clean).filter(Boolean).slice(-3).join('；');
      const pastExp = clean(person?.profile?.experiences) || memSnippets;
      const intro = clean(basic.identity) || (names.length > 1 ? `又名${names.slice(1).join('/')}` : '重要角色');
      const rel = clean(basic.relations) || (arc?.relationship ? `主角:${arc.relationship}` : '');
      const row = normalizeTableRow('important_characters', {
        name: mainName,
        brief_intro: Array.from(intro).slice(0, 30).join(''),
        appearance: clean(basic.appearance),
        presence_status: '在场',
        relation_text: rel,
        past_experience: pastExp
      }, charRowId++);
      if (row) tables.important_characters.push(row);
    }

    // 2. 旧 entity_memory.ability / world_memory.ability -> protagonist_skills
    const abilities = Array.isArray(raw?.entity_memory?.ability || raw?.world_memory?.ability)
      ? (raw?.entity_memory?.ability || raw?.world_memory?.ability) : [];
    abilities.forEach((item, idx) => {
      const row = normalizeTableRow('protagonist_skills', {
        skill_name: clean(item?.name),
        skill_type: '主动',
        skill_level: '',
        effect_desc: clean(item?.description) || (Array.isArray(item?.history) ? item.history.map(h => clean(h?.event)).filter(Boolean).join('；') : '')
      }, idx + 1);
      if (row) tables.protagonist_skills.push(row);
    });

    // 3. 旧 entity_memory.object / world_memory.item -> inventory
    const objects = Array.isArray(raw?.entity_memory?.object || raw?.entity_memory?.item || raw?.world_memory?.object || raw?.world_memory?.item)
      ? (raw?.entity_memory?.object || raw?.entity_memory?.item || raw?.world_memory?.object || raw?.world_memory?.item) : [];
    objects.forEach((item, idx) => {
      const row = normalizeTableRow('inventory', {
        item_name: clean(item?.name),
        quantity: '1',
        description: clean(item?.description) || (Array.isArray(item?.history) ? item.history.map(h => clean(h?.event)).filter(Boolean).join('；') : ''),
        category: '物品'
      }, idx + 1);
      if (row) tables.inventory.push(row);
    });

    // 4. 旧 ongoing_facts (active) -> quests_events
    const facts = Array.isArray(raw?.ongoing_facts) ? raw.ongoing_facts : [];
    let qRowId = 1;
    for (const fact of facts) {
      if (fact?.status === 'resolved' || fact?.status === 'superseded') continue;
      const text = clean(fact?.fact || fact?.content);
      if (!text) continue;
      const subj = clean(fact?.subject);
      const cat = clean(fact?.category);
      const title = subj && subj !== '全局'
        ? `${subj}：${Array.from(text).slice(0, 16).join('')}`
        : Array.from(text).slice(0, 20).join('');
      const row = normalizeTableRow('quests_events', {
        quest_name: title,
        quest_type: cat === '主线' || cat === '主线任务' ? '主线任务' : '支线任务',
        issuer: subj && subj !== '全局' ? subj : '',
        detail_desc: text,
        current_progress: cat || '进行中'
      }, qRowId++);
      if (row) tables.quests_events.push(row);
    }

    // 5. 旧 event_memory.small_summaries -> chronicle
    const smalls = Array.isArray(raw?.event_memory?.small_summaries) ? raw.event_memory.small_summaries : [];
    const usedCodes = new Set();
    smalls.forEach((item, idx) => {
      const row = normalizeTableRow('chronicle', {
        ...item,
        chronicle_text: clean(item?.chronicle_text ?? item?.content),
        code_index: clean(item?.code_index ?? item?.codeIndex)
      }, idx + 1, usedCodes);
      if (row) tables.chronicle.push(row);
    });

    return normalizeTables(tables);
  }

  function projectChronicleToSmallSummaries(chronicleRows) {
    return (Array.isArray(chronicleRows) ? chronicleRows : []).map((row, idx) => {
      const item = {
        id: clean(row.id) || `small_${String(idx + 1).padStart(6, '0')}`,
        rowId: row.rowId || idx + 1,
        codeIndex: row.code_index,
        code_index: row.code_index,
        timeSpan: row.time_span || '',
        time_span: row.time_span || '',
        summary: row.summary || '',
        content: row.chronicle_text || '',
        chronicle_text: row.chronicle_text || '',
        keyDialogue: row.key_dialogue || '',
        key_dialogue: row.key_dialogue || '',
        startLayer: Number.isFinite(Number(row.startLayer)) ? Number(row.startLayer) : 0,
        endLayer: Number.isFinite(Number(row.endLayer)) ? Number(row.endLayer) : 0,
        keywords: unique(row.keywords),
        entityNames: unique(row.entityNames),
        impactLevel: row.impactLevel === 'key' ? 'key' : 'normal',
        ...(clean(row.outlineChapterTitle) ? { outlineChapterTitle: clean(row.outlineChapterTitle) } : {}),
        sourceRefs: Array.isArray(row.sourceRefs) ? clone(row.sourceRefs) : [],
        sourceDigest: clean(row.sourceDigest),
        originChatId: clean(row.originChatId),
        status: ['valid', 'stale', 'pending', 'failed'].includes(row.status) ? row.status : 'valid',
        revision: Math.max(1, parseInt(row.revision, 10) || 1)
      };
      if (row.source === 'world_engine') item.source = 'world_engine';
      if (row.sourceKey) item.sourceKey = String(row.sourceKey);
      if (row.worldCommitId) item.worldCommitId = clean(row.worldCommitId);
      return item;
    });
  }

  function memoryBaseFrom(state) {
    const tables = state?.tables && typeof state.tables === 'object'
      ? normalizeTables(state.tables)
      : migrateLegacyIntoTables(state);
    return {
      tables,
      round: Math.max(0, parseInt(state?.round, 10) || 0),
      chatLayer: state?.chatLayer !== null && state?.chatLayer !== '' && Number.isFinite(Number(state?.chatLayer))
        ? Number(state.chatLayer) : null
    };
  }

  function newTimeline(state, options) {
    const sourceChatId = clean(options?.originChatId || getChatId()) || 'default';
    return {
      version: TIMELINE_VERSION,
      originChatId: sourceChatId,
      root: {
        id: `root:${sourceChatId}`,
        originChatId: sourceChatId,
        createdAt: Date.now(),
        base: memoryBaseFrom(state)
      },
      nodes: [],
      migratedFromLegacy: options?.migratedFromLegacy === true
    };
  }

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      tables: emptyTables(),
      tableWatermarks: emptyWatermarks(),
      event_memory: {
        small_summaries: [],
        small_summary_layer: null
      },
      round: 0,
      chatLayer: null,
      rebaseLayer: null,
      autoBaselineLayer: null,
      timeline: null
    };
  }

  function normalizeWatermarks(raw, state) {
    const hasExplicitMap = Boolean(raw && typeof raw === 'object' && !Array.isArray(raw));
    const src = hasExplicitMap ? raw : {};
    const out = emptyWatermarks();
    const fallbackStateLayer = state?.chatLayer !== null && state?.chatLayer !== '' && Number.isFinite(Number(state?.chatLayer))
      ? Number(state.chatLayer) : null;
    const fallbackChronLayer = state?.event_memory?.small_summary_layer !== null && state?.event_memory?.small_summary_layer !== ''
      && Number.isFinite(Number(state?.event_memory?.small_summary_layer))
      ? Number(state.event_memory.small_summary_layer) : null;
    for (const k of TABLE_KEYS) {
      if (hasExplicitMap && Object.prototype.hasOwnProperty.call(src, k)) {
        const val = src[k];
        out[k] = (val !== null && val !== undefined && val !== '' && Number.isFinite(Number(val)))
          ? Number(val) : null;
      } else if (k === 'chronicle') {
        out[k] = fallbackChronLayer;
      } else {
        out[k] = fallbackStateLayer;
      }
    }
    return out;
  }

  function normalizeState(state) {
    const raw = state && typeof state === 'object' && !Array.isArray(state) ? clone(state) : defaultState();
    const hasCanonicalTables = raw.tables && typeof raw.tables === 'object' && !Array.isArray(raw.tables);
    let tables = hasCanonicalTables ? normalizeTables(raw.tables) : migrateLegacyIntoTables(raw);

    // 兼容同步：仅对尚未升级的旧版（< v3）状态或缺少 tables 的旧数据，从 event_memory.small_summaries 迁入 chronicle
    const isLegacyState = !hasCanonicalTables || Number(raw.schemaVersion || 0) < SCHEMA_VERSION;
    const rawSmalls = Array.isArray(raw.event_memory?.small_summaries) ? raw.event_memory.small_summaries : [];
    if (isLegacyState && !tables.chronicle.length && rawSmalls.length) {
      const usedCodes = new Set();
      tables.chronicle = rawSmalls.map((item, idx) => normalizeTableRow('chronicle', {
        ...item,
        chronicle_text: clean(item?.chronicle_text ?? item?.content),
        code_index: clean(item?.code_index ?? item?.codeIndex)
      }, idx + 1, usedCodes)).filter(Boolean);
    }

    // 兼容迁移：如果 tables 中除了 chronicle 外全空，但存在旧 personal_memory / entity_memory / ongoing_facts，则无损迁入
    const nonChronHasData = TABLE_KEYS.some(k => k !== 'chronicle' && tables[k].length > 0);
    const hasLegacyData = (Array.isArray(raw.personal_memory) && raw.personal_memory.length > 0)
      || (Array.isArray(raw.ongoing_facts) && raw.ongoing_facts.length > 0)
      || (raw.entity_memory && typeof raw.entity_memory === 'object' && (
        (raw.entity_memory.ability?.length || 0) > 0 || (raw.entity_memory.object?.length || 0) > 0
      ));
    if (!nonChronHasData && hasLegacyData && Number(raw.schemaVersion || 0) < SCHEMA_VERSION) {
      const migrated = migrateLegacyIntoTables(raw);
      for (const k of TABLE_KEYS) {
        if (k !== 'chronicle' && !tables[k].length && migrated[k].length) tables[k] = migrated[k];
      }
    }

    const round = Math.max(0, parseInt(raw.round, 10) || 0);
    const chatLayer = raw.chatLayer !== null && raw.chatLayer !== '' && Number.isFinite(Number(raw.chatLayer))
      ? Number(raw.chatLayer) : null;
    const rebaseLayer = raw.rebaseLayer !== null && raw.rebaseLayer !== '' && Number.isFinite(Number(raw.rebaseLayer))
      ? Number(raw.rebaseLayer) : null;
    const autoBaselineLayer = raw.autoBaselineLayer !== null && raw.autoBaselineLayer !== '' && Number.isFinite(Number(raw.autoBaselineLayer))
      ? Number(raw.autoBaselineLayer) : null;

    const watermarks = normalizeWatermarks(raw.tableWatermarks, {
      chatLayer,
      event_memory: raw.event_memory
    });

    const next = {
      schemaVersion: SCHEMA_VERSION,
      tables,
      tableWatermarks: watermarks,
      event_memory: {
        small_summaries: projectChronicleToSmallSummaries(tables.chronicle),
        small_summary_layer: watermarks.chronicle
      },
      round,
      chatLayer,
      rebaseLayer,
      autoBaselineLayer,
      timeline: null
    };

    if (raw.world_commit_archive && typeof raw.world_commit_archive === 'object') {
      next.world_commit_archive = clone(raw.world_commit_archive);
    }

    if (!raw.timeline || typeof raw.timeline !== 'object' || Array.isArray(raw.timeline)) {
      next.timeline = newTimeline(next, { migratedFromLegacy: true });
    } else {
      const tl = raw.timeline;
      const originChatId = clean(tl.originChatId || tl.root?.originChatId || getChatId()) || 'default';
      const rootBase = tl.root?.base && typeof tl.root.base === 'object'
        ? memoryBaseFrom(tl.root.base) : memoryBaseFrom(next);
      next.timeline = {
        version: TIMELINE_VERSION,
        originChatId,
        root: {
          id: clean(tl.root?.id) || `root:${originChatId}`,
          originChatId: clean(tl.root?.originChatId || originChatId),
          createdAt: Number(tl.root?.createdAt) || Date.now(),
          base: rootBase
        },
        nodes: (Array.isArray(tl.nodes) ? tl.nodes : []).map((node, index) => {
          const nBounds = resolveAiRecordBounds(node);
          const isLegacyShell = node?.kind === 'memory' && node?.memoryExtracted === false;
          const targetSheets = Array.isArray(node?.targetSheets)
            ? Array.from(new Set(node.targetSheets.filter(k => TABLE_KEYS.includes(k))))
            : (node?.kind === 'memory' && !isLegacyShell
              ? TABLE_KEYS.filter(k => k !== 'chronicle')
              : []);
          let tableOps = Array.isArray(node?.tableOps) ? clone(node.tableOps) : [];
          // 兼容旧版 timeline.nodes（将旧 personal/profileUpdates/entities/factUpdates 转成 tableOps）
          if (!tableOps.length && (node?.kind === 'memory' || node?.kind === 'world_link' || node?.kind === 'outline_verified')) {
            tableOps = legacyNodeToTableOps(node);
          }
          return {
            id: clean(node?.id) || `memory_${String(index + 1).padStart(6, '0')}`,
            kind: clean(node?.kind) || 'table_ops',
            ...(node?.source === 'world_engine' ? { source: 'world_engine' } : {}),
            ...(clean(node?.sourceKey) ? { sourceKey: clean(node.sourceKey) } : {}),
            ...(clean(node?.worldCommitId) ? { worldCommitId: clean(node.worldCommitId) } : {}),
            originChatId: clean(node?.originChatId || originChatId),
            startLayer: nBounds.startLayer,
            endLayer: nBounds.endLayer,
            sourceRefs: Array.isArray(node?.sourceRefs) ? clone(node.sourceRefs) : [],
            sourceDigest: clean(node?.sourceDigest),
            targetSheets,
            tableOps,
            snapshot: node?.snapshot && typeof node.snapshot === 'object' ? memoryBaseFrom(node.snapshot) : null,
            status: ['valid', 'stale', 'pending', 'failed'].includes(node?.status) ? node.status : 'valid',
            revision: Math.max(1, parseInt(node?.revision, 10) || 1),
            createdAt: Number(node?.createdAt) || Date.now(),
            updatedAt: Number(node?.updatedAt) || Number(node?.createdAt) || Date.now()
          };
        }),
        migratedFromLegacy: tl.migratedFromLegacy === true
      };
    }
    return next;
  }

  function legacyNodeToTableOps(node) {
    const ops = [];
    for (const upd of Array.isArray(node?.profileUpdates) ? node.profileUpdates : []) {
      const name = clean(Array.isArray(upd?.names) ? upd.names[0] : upd?.name);
      if (!name) continue;
      const b = upd?.basicInfo || upd?.basic_info || {};
      ops.push({
        sheet: 'important_characters',
        op: 'upsert',
        key: name,
        data: {
          name,
          brief_intro: clean(b.identity),
          appearance: clean(b.appearance),
          relation_text: clean(b.relations),
          past_experience: clean(upd?.experiences)
        }
      });
    }
    for (const p of Array.isArray(node?.personal) ? node.personal : []) {
      const name = clean(Array.isArray(p?.name) ? p.name[0] : p?.name);
      if (!name) continue;
      ops.push({
        sheet: 'important_characters',
        op: 'upsert',
        key: name,
        data: {
          name,
          brief_intro: '重要角色',
          past_experience: clean(p?.memory)
        }
      });
    }
    const ent = node?.entities && typeof node.entities === 'object' ? node.entities : {};
    for (const ab of Array.isArray(ent.ability) ? ent.ability : []) {
      if (!clean(ab?.name)) continue;
      ops.push({
        sheet: 'protagonist_skills',
        op: 'upsert',
        key: clean(ab.name),
        data: { skill_name: clean(ab.name), skill_type: '主动', effect_desc: clean(ab.description || ab.event) }
      });
    }
    for (const obj of Array.isArray(ent.object) ? ent.object : []) {
      if (!clean(obj?.name)) continue;
      ops.push({
        sheet: 'inventory',
        op: 'upsert',
        key: clean(obj.name),
        data: { item_name: clean(obj.name), quantity: '1', description: clean(obj.description || obj.event), category: '物品' }
      });
    }
    for (const f of Array.isArray(node?.factUpdates) ? node.factUpdates : []) {
      const text = clean(f?.fact);
      if (!text) continue;
      const title = clean(f?.subject) && clean(f.subject) !== '全局'
        ? `${clean(f.subject)}：${Array.from(text).slice(0, 16).join('')}`
        : Array.from(text).slice(0, 20).join('');
      if (f?.action === 'resolve') {
        ops.push({ sheet: 'quests_events', op: 'delete', key: title });
      } else {
        ops.push({
          sheet: 'quests_events',
          op: 'upsert',
          key: title,
          data: { quest_name: title, quest_type: '支线任务', issuer: clean(f?.subject), detail_desc: text, current_progress: clean(f?.category || '进行中') }
        });
      }
    }
    return ops;
  }

  function tableRowCounts(state) {
    const tables = state?.tables || emptyTables();
    const counts = {};
    for (const k of TABLE_KEYS) counts[k] = Array.isArray(tables[k]) ? tables[k].length : 0;
    counts.totalRows = TABLE_KEYS.reduce((sum, k) => sum + counts[k], 0);
    // 兼容统计别名
    counts.people = counts.important_characters + counts.protagonist_info;
    counts.entities = counts.protagonist_skills + counts.inventory;
    counts.facts = counts.quests_events;
    counts.minutes = counts.chronicle;
    return counts;
  }

  function hasState() { return window.WORLD_ENGINE_STORE?.getItem(key(STATE_PREFIX)) !== null; }
  function loadState() { return normalizeState(parse(window.WORLD_ENGINE_STORE?.getItem(key(STATE_PREFIX)), defaultState())); }
  function saveState(state) {
    const next = normalizeState(state);
    window.WORLD_ENGINE_STORE?.setItem(key(STATE_PREFIX), JSON.stringify(next));
    return clone(next);
  }

  function loadCheckpoint() {
    const checkpoint = parse(window.WORLD_ENGINE_STORE?.getItem(key(CHECKPOINT_PREFIX)), null);
    return checkpoint ? normalizeState(checkpoint) : null;
  }
  function saveCheckpoint(state) {
    const next = state === undefined ? loadState() : normalizeState(state);
    window.WORLD_ENGINE_STORE?.setItem(key(CHECKPOINT_PREFIX), JSON.stringify(clone(next)));
    return clone(next);
  }
  function clearCheckpoint() { window.WORLD_ENGINE_STORE?.removeItem(key(CHECKPOINT_PREFIX)); }

  function loadLinkCheckpoint() {
    const value = parse(window.WORLD_ENGINE_STORE?.getItem(key(LINK_CHECKPOINT_PREFIX)), null);
    if (!value || typeof value !== 'object' || !value.baseState) return null;
    return {
      layer: Number.isFinite(Number(value.layer)) ? Number(value.layer) : null,
      rolledBack: value.rolledBack === true,
      baseState: normalizeState(value.baseState)
    };
  }
  function saveLinkCheckpoint(value) {
    if (!value || !value.baseState) return null;
    const next = {
      layer: Number(value.layer),
      rolledBack: value.rolledBack === true,
      baseState: normalizeState(value.baseState)
    };
    window.WORLD_ENGINE_STORE?.setItem(key(LINK_CHECKPOINT_PREFIX), JSON.stringify(next));
    return clone(next);
  }
  function clearLinkCheckpoint() { window.WORLD_ENGINE_STORE?.removeItem(key(LINK_CHECKPOINT_PREFIX)); }

  function portableState(state) {
    const current = normalizeState(state);
    return {
      schemaVersion: SCHEMA_VERSION,
      tables: clone(current.tables),
      tableWatermarks: clone(current.tableWatermarks),
      event_memory: clone(current.event_memory),
      timeline: clone(current.timeline),
      round: current.round,
      chatLayer: current.chatLayer,
      rebaseLayer: current.rebaseLayer
    };
  }

  function currentChatLayer() {
    const fromCore = window.WORLD_ENGINE_CORE?.getChatLayer?.();
    if (Number.isFinite(Number(fromCore))) return Math.max(0, Number(fromCore));
    try { return Math.max(0, (SillyTavern.getContext()?.chat || []).length - 1); }
    catch (_) { return 0; }
  }

  function rebaseImportedState(state) {
    const next = normalizeState(state);
    const layer = currentChatLayer();
    next.chatLayer = layer;
    next.rebaseLayer = layer;
    for (const k of TABLE_KEYS) next.tableWatermarks[k] = layer;
    next.event_memory.small_summary_layer = layer;
    next.timeline = newTimeline(next, { originChatId: getChatId(), migratedFromLegacy: false });
    return next;
  }
  function rebaseToCurrentChat(state) { return rebaseImportedState(state); }

  function exportMemoryPackage() {
    const current = normalizeState(loadState());
    const cleanTables = clone(current.tables);
    cleanTables.chronicle = (cleanTables.chronicle || [])
      .filter(item => item.status !== 'stale' && item.status !== 'failed')
      .map((item, idx) => ({
        id: `small_${String(idx + 1).padStart(6, '0')}`,
        rowId: idx + 1,
        code_index: item.code_index,
        time_span: item.time_span,
        summary: item.summary,
        chronicle_text: item.chronicle_text,
        key_dialogue: item.key_dialogue,
        startLayer: 0,
        endLayer: 0,
        keywords: unique(item.keywords),
        entityNames: unique(item.entityNames),
        impactLevel: item.impactLevel === 'key' ? 'key' : 'normal',
        ...(clean(item.outlineChapterTitle) ? { outlineChapterTitle: clean(item.outlineChapterTitle) } : {}),
        status: 'valid',
        revision: 1
      }));
    const pkgSmalls = projectChronicleToSmallSummaries(cleanTables.chronicle).map(item => {
      const copy = { ...item };
      delete copy.sourceRefs;
      delete copy.sourceDigest;
      return copy;
    });
    const pkg = {
      schemaVersion: SCHEMA_VERSION,
      tables: cleanTables,
      event_memory: {
        small_summaries: pkgSmalls
      }
    };
    return {
      __memoryEnginePackage: true,
      format: 'memory-summary-package',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      chatId: getChatId(),
      counts: tableRowCounts(pkg),
      package: pkg
    };
  }

  function importMemoryPackage(payload, options) {
    if (options?.isBusy?.() === true) throw new Error('记忆任务正在运行中，无法导入记忆包');
    const targetChatId = clean(options?.expectedChatId);
    if (targetChatId && targetChatId !== clean(getChatId())) {
      throw new Error('导入前聊天身份已切换，已取消写入以防串台');
    }
    if (!payload || typeof payload !== 'object' || payload.__memoryEnginePackage !== true || payload.format !== 'memory-summary-package' || !payload.package || typeof payload.package !== 'object') {
      throw new Error('总结记忆包格式校验失败：仅接受标准 memory-summary-package JSON');
    }
    const pkg = payload.package;
    const hasTables = pkg.tables && typeof pkg.tables === 'object';
    const hasLegacy = Array.isArray(pkg.personal_memory) || (pkg.entity_memory && typeof pkg.entity_memory === 'object') || (pkg.event_memory && typeof pkg.event_memory === 'object');
    if (!hasTables && !hasLegacy) {
      throw new Error('总结记忆包缺少有效的表格或剧情记忆内容');
    }
    const normalizedPkg = normalizeState(pkg);
    const rebased = rebaseImportedState(normalizedPkg);
    rebased.tables.chronicle = (rebased.tables.chronicle || []).map(item => ({
      ...item,
      sourceRefs: [],
      sourceDigest: '',
      originChatId: getChatId(),
      status: 'valid'
    }));
    rebased.event_memory.small_summaries = projectChronicleToSmallSummaries(rebased.tables.chronicle);
    rebased.timeline = newTimeline(rebased, { originChatId: getChatId(), migratedFromLegacy: false });
    clearCheckpoint();
    clearLinkCheckpoint();
    try { window.MEMORY_ENGINE_VECTOR?.clearVectorCache?.(getChatId()); } catch (_) {}
    return saveState(rebased);
  }

  function exportData() {
    const state = portableState(loadState());
    const rawCheckpoint = loadCheckpoint();
    const checkpoint = rawCheckpoint ? portableState(rawCheckpoint) : null;
    return {
      __memoryEngineData: true,
      format: 'portable-full-backup',
      version: VERSION,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      chatId: getChatId(),
      counts: {
        state: tableRowCounts(state),
        checkpoint: checkpoint ? tableRowCounts(checkpoint) : null
      },
      state,
      checkpoint
    };
  }

  function importData(payload) {
    const selected = payload?.__memoryEngineData ? (payload.state || payload.current_state || payload.data || payload) : (payload?.state || payload);
    const hasTables = selected?.tables && typeof selected.tables === 'object' && !Array.isArray(selected.tables);
    const hasPersonal = Array.isArray(selected?.personal_memory);
    const hasWorld = (selected?.entity_memory && typeof selected.entity_memory === 'object' && !Array.isArray(selected.entity_memory))
      || (selected?.world_memory && typeof selected.world_memory === 'object' && !Array.isArray(selected.world_memory));
    if (!selected || typeof selected !== 'object' || Array.isArray(selected) || (!hasTables && !hasPersonal && !hasWorld)) {
      throw new Error('缺少合法的记忆表格数据');
    }
    const sourceChatId = clean(payload?.chatId || selected?.timeline?.originChatId);
    const sameChat = sourceChatId && sourceChatId === clean(getChatId());
    const prepare = value => sameChat ? normalizeState(value) : rebaseImportedState(value);
    saveState(prepare(selected));
    if (payload?.format === 'portable-current-state') {
      clearCheckpoint();
    } else if (payload?.__memoryEngineData || Object.prototype.hasOwnProperty.call(payload || {}, 'checkpoint')) {
      if (payload.checkpoint) saveCheckpoint(prepare(payload.checkpoint)); else clearCheckpoint();
    }
    return loadState();
  }

  return {
    VERSION,
    SCHEMA_VERSION,
    TABLE_KEYS,
    TABLE_SCHEMAS,
    getChatId,
    emptyTables,
    emptyWatermarks,
    nextChronicleCode,
    formatCodeIndex,
    normalizeTableRow,
    normalizeTables,
    applyTableOps,
    tableRowCounts,
    projectChronicleToSmallSummaries,
    defaultState,
    normalizeState,
    hasState,
    loadState,
    saveState,
    loadCheckpoint,
    saveCheckpoint,
    clearCheckpoint,
    loadLinkCheckpoint,
    saveLinkCheckpoint,
    clearLinkCheckpoint,
    exportData,
    importData,
    exportMemoryPackage,
    importMemoryPackage,
    rebaseToCurrentChat
  };
})();
