// 独立剧情界面：草稿留在当前页面内，只有明确确认后才写入剧情状态。
window.OUTLINE_ENGINE_UI = (function() {
  'use strict';
  const drafts = new Map();
  const STATUS_LABELS = { pending: '待推进', active: '进行中', completed: '完成', skipped: '跳过', blocked: '受阻' };
  const TRACK_LABELS = { main: '主线', side: '支线', hidden: '暗线' };
  const VIEW_META = {
    tracks: { title: '跨章剧情线', poem: '草蛇灰线，伏脉千里' },
    schedule: { title: '调度与注入', poem: '运筹帷幄之中' },
    facts: { title: '事实与线索', poem: '明察秋毫，洞若观火' },
    recovery: { title: '联合历史恢复', poem: '鉴往知来，有迹可循' },
    transfer: { title: '归档与备份', poem: '藏诸名山，传之其人' },
    debug: { title: '剧情调试', poem: '纤毫毕现' }
  };
  const OUTLINE_SETTINGS_TABS = [
    { key: 'common', label: '常用' },
    { key: 'api', label: '连接' },
    { key: 'archive', label: '存档' },
    { key: 'debug', label: '调试' },
    { key: 'about', label: '关于' }
  ];
  let initialized = false;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const h = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const data = () => window.OUTLINE_ENGINE_DATA;
  const engine = () => window.OUTLINE_ENGINE;
  const settings = () => window.OUTLINE_ENGINE_SETTINGS?.getSettings?.(true) || {};
  const chatId = () => String(data()?.getChatId?.() || window.WORLD_ENGINE_CORE?.getChatId?.() || 'default');
  const cache = () => window.WORLD_ENGINE_CHATCACHE?.forScope?.('outline');
  const state = () => data()?.loadState?.() || { plan: { title: '', synopsis: '', constraints: '', chapters: [], tracks: [], nodes: [] }, revision: 0, proposals: [], progressEvents: [] };
  const history = () => window.STORY_ENGINE_HISTORY;
  const refresh = () => window.WORLD_ENGINE_UI?.refresh?.();
  function isRebuilding() { try { return history()?.getStatus?.().phase === 'rebuilding'; } catch (_) { return false; } }

  function draftFor(id) {
    id = id || chatId();
    if (!drafts.has(id)) drafts.set(id, {
      view: 'home', selectedNavView: null, settingsOpen: false, settingsTab: 'common', settingsDraft: null, editorOpen: false,
      plan: null, expectedRevision: null, expectedPlanSnapshot: '', selectedChapterId: '', lastCurrentChapterId: '', sourceText: '',
      textOpen: false, preview: null, previewRevision: null, previewPlanSnapshot: '', pendingJson: null,
      snapshotName: '', newFlagId: '', newFlagValue: true, message: '', error: false, busy: false
    });
    return drafts.get(id);
  }

  function notify(message, error, draft) {
    const current = draft || draftFor();
    current.message = String(message || '');
    current.error = Boolean(error);
    refresh();
  }

  async function run(action, label) {
    const originId = chatId(), draft = draftFor(originId);
    if (draft.busy) return;
    draft.busy = true;
    draft.message = label || '正在处理…';
    draft.error = false;
    refresh();
    try {
      return await action(draft, originId);
    } catch (error) {
      draft.message = String(error?.message || error);
      draft.error = true;
    } finally {
      draft.busy = false;
      refresh();
    }
  }

  function ensureCurrentChat(id) {
    if (chatId() !== id) throw new Error('已切换聊天，本次操作未写入新聊天。');
  }

  function button(action, label, extra, variant) {
    const cls = variant === 'primary' ? 'we-btn we-btn-primary' : variant === 'danger' ? 'we-btn we-btn-danger' : 'we-btn';
    return `<button type="button" class="${cls}" data-outline-action="${h(action)}"${extra || ''}>${h(label)}</button>`;
  }
  function field(label, name, value, options) {
    const opt = options || {};
    const attrs = `id="we-outline-${h(name)}" data-outline-setting="${h(name)}"`;
    if (opt.type === 'checkbox') return `<label class="we-outline-check"><input ${attrs} type="checkbox"${value ? ' checked' : ''}><span>${h(label)}</span></label>`;
    if (opt.choices) return `<label class="we-outline-field"><span>${h(label)}</span><select ${attrs}>${opt.choices.map(([id, text]) => `<option value="${h(id)}"${String(value) === id ? ' selected' : ''}>${h(text)}</option>`).join('')}</select></label>`;
    return `<label class="we-outline-field"><span>${h(label)}</span><input ${attrs} type="${h(opt.type || 'text')}" value="${h(value)}"${opt.min != null ? ` min="${opt.min}"` : ''}${opt.step ? ` step="${opt.step}"` : ''}${opt.type === 'password' ? ' autocomplete="new-password"' : ''}></label>`;
  }
  function subTopbar(title, poem, backAction) {
    return `<div class="we-sub-topbar">
      <button class="we-icon-btn" type="button" data-outline-action="${h(backAction || 'view-home')}" title="返回"><i class="fa-solid fa-arrow-left"></i></button>
      <span class="we-sub-title">${h(title)}</span>
      ${poem ? `<span class="we-memory-sub-poem">${h(poem)}</span>` : ''}
    </div>`;
  }
  function planText(value) { return Array.isArray(value) ? value.join('\n') : String(value || ''); }
  function nodeStatus(current, nodeId) {
    try { return data()?.getNodeStatus?.(current, nodeId) || 'pending'; }
    catch (_) { return 'pending'; }
  }
  function chaptersOf(plan) { return Array.isArray(plan?.chapters) ? plan.chapters : []; }
  function nodesOf(plan) { return Array.isArray(plan?.nodes) ? plan.nodes : chaptersOf(plan).flatMap(chapter => chapter.nodes || []); }
  function tracksOf(plan) { return Array.isArray(plan?.tracks) ? plan.tracks : []; }
  function chapterNodes(plan, id) { return data()?.getChapterNodes?.(plan, id) || chaptersOf(plan).find(chapter => chapter.id === id)?.nodes || []; }
  function trackNodes(plan, id) { return data()?.getTrackNodes?.(plan, id) || nodesOf(plan).filter(node => node.trackId === id); }
  function nodeTitle(plan, id) { return nodesOf(plan).find(node => node.id === id)?.title || id; }
  function dependencyIds(node) { return (node.dependencies || []).map(dep => typeof dep === 'string' ? dep : dep.nodeId); }
  function findDraftNode(draft, ds) { return nodesOf(draft.plan).find(node => node.id === ds.outlineNid) || draft.plan?.chapters?.[Number(ds.outlineCi)]?.nodes?.[Number(ds.outlineNi)]; }

  function selectControl(label, value, attributes, choices) {
    const options = [...choices];
    if (value != null && value !== '' && !options.some(([id]) => String(id) === String(value))) options.push([value, `${value}（当前引用缺失）`]);
    return `<label class="we-outline-field"><span>${h(label)}</span><select ${attributes}>${options.map(([id, text]) => `<option value="${h(id)}"${String(value ?? '') === String(id) ? ' selected' : ''}>${h(text)}</option>`).join('')}</select></label>`;
  }
  function choiceList(label, selected, choices, attributes) {
    const selectedSet = new Set(selected || []);
    const options = [...choices];
    for (const id of selectedSet) if (!options.some(([key]) => key === id)) options.push([id, `${id}（引用缺失，可取消关联）`]);
    return `<fieldset class="we-outline-choices"><legend>${h(label)}</legend>${options.map(([id, text]) => `<label class="we-outline-check"><input type="checkbox" ${attributes} value="${h(id)}"${selectedSet.has(id) ? ' checked' : ''}><span>${h(text)}</span></label>`).join('') || '<span class="we-outline-hint">暂无可选择项目</span>'}</fieldset>`;
  }
  function conditionSummary(condition, plan) {
    if (!condition) return '无额外条件';
    if (condition.all || condition.any) return `${condition.all ? '全部满足' : '任一满足'}：${(condition.all || condition.any).map(item => conditionSummary(item, plan)).join('；') || '空条件组'}`;
    if (condition.type === 'literal') return condition.value ? '作者固定为满足' : '作者固定为不满足';
    if (condition.type === 'nodeStatus') return `${nodeTitle(plan, condition.nodeId)}：${STATUS_LABELS[condition.status] || condition.status || '完成'}`;
    if (condition.type === 'chapter') return `章节范围：${(condition.chapterIds || []).join(' / ') || `${condition.fromChapterId || '不限'} → ${condition.toChapterId || '不限'}`}`;
    if (condition.type === 'worldField') return `世界 ${condition.collection || '?'} / ${condition.entityId || '?'} / ${condition.field || '?'} ${condition.op || 'eq'} ${String(condition.value ?? '')}`;
    if (condition.type === 'clueContact') return `已接触线索 ${condition.clueId || '?'}${condition.actorId ? `（${condition.actorId}）` : ''}`;
    if (condition.type === 'time') return `${condition.basis === 'storyDay' ? '剧情总天数' : '剧情日历日期'} ${condition.op || 'gte'} ${condition.value ?? '?'}`;
    if (condition.type === 'authorFlag') return `作者标记 ${condition.flagId || '?'} = ${condition.value === false ? '否' : '是'}`;
    return `待配置：${condition.text || '尚未定义的自然语言条件'}`;
  }

  function conditionRoot(node, slot) { return slot === 'disclosure' ? node.disclosure?.condition : node.trigger; }
  function conditionAt(node, slot, path) {
    let current = conditionRoot(node, slot);
    for (const index of path) current = (current?.all || current?.any || [])[index];
    return current;
  }
  function replaceCondition(node, slot, path, replacement) {
    if (!path.length) {
      if (slot === 'disclosure') node.disclosure = { ...(node.disclosure || {}), condition: replacement };
      else node.trigger = replacement;
      return;
    }
    const parent = conditionAt(node, slot, path.slice(0, -1));
    const list = parent?.all || parent?.any;
    if (!list) throw new Error('条件组已变化，请重新选择。');
    if (replacement === undefined) list.splice(path[path.length - 1], 1);
    else list[path[path.length - 1]] = replacement;
  }
  function blankCondition(type) {
    if (type === 'none') return null;
    if (type === 'all' || type === 'any') return { [type]: [] };
    if (type === 'literal') return { type, value: false };
    if (type === 'nodeStatus') return { type, nodeId: '', status: 'completed', allowSkipped: false };
    if (type === 'chapter') return { type, chapterIds: [], fromChapterId: '', toChapterId: '' };
    if (type === 'worldField') return { type, collection: 'events', entityId: '', field: '', op: 'eq', value: '' };
    if (type === 'clueContact') return { type, clueId: '', actorId: '' };
    if (type === 'time') return { type, basis: 'storyDay', op: 'gte', value: 0 };
    if (type === 'authorFlag') return { type, flagId: '', value: true };
    return { type: 'unconfigured', text: '' };
  }

  function renderCondition(condition, node, slot, path, plan) {
    const at = path || [], type = !condition ? 'none' : condition.all ? 'all' : condition.any ? 'any' : condition.type;
    const attrs = `data-outline-nid="${h(node.id)}" data-outline-condition-slot="${slot}" data-outline-condition-path="${h(JSON.stringify(at))}"`;
    const cf = name => `${attrs} data-outline-condition-field="${name}"`;
    const choices = [['none', '无额外条件'], ['all', '以下全部满足'], ['any', '以下任一满足'], ['nodeStatus', '节点状态'], ['chapter', '章节范围'], ['worldField', '世界实体字段'], ['clueContact', '人物已接触线索'], ['time', '剧情时间'], ['authorFlag', '作者标记'], ['literal', '固定开关'], ['unconfigured', '自然语言（待配置）']];
    let body = '';
    if (type === 'all' || type === 'any') body = (condition.all || condition.any).map((child, index) => renderCondition(child, node, slot, [...at, index], plan)).join('') + button('condition-add', '增加条件', ` ${attrs}`);
    else if (type === 'nodeStatus') body = selectControl('节点', condition.nodeId, cf('nodeId'), [['', '选择节点'], ...nodesOf(plan).filter(item => item.id !== node.id).map(item => [item.id, item.title || item.id])]) + selectControl('状态', condition.status, cf('status'), Object.entries(STATUS_LABELS)) + `<label class="we-outline-check"><input type="checkbox" ${cf('allowSkipped')}${condition.allowSkipped ? ' checked' : ''}><span>跳过也视为满足</span></label>`;
    else if (type === 'chapter') body = choiceList('指定章节（不选则使用下方范围）', condition.chapterIds, chaptersOf(plan).map(item => [item.id, item.title || item.id]), `${cf('chapterIds')} data-outline-condition-array="true"`) + selectControl('起始章', condition.fromChapterId, cf('fromChapterId'), [['', '不限'], ...chaptersOf(plan).map(item => [item.id, item.title || item.id])]) + selectControl('结束章', condition.toChapterId, cf('toChapterId'), [['', '不限'], ...chaptersOf(plan).map(item => [item.id, item.title || item.id])]);
    else if (type === 'worldField') {
      let world = {}; try { world = window.WORLD_ENGINE_CORE?.loadState?.() || {}; } catch (_) {}
      const collections = Object.keys(world).filter(key => Array.isArray(world[key]));
      if (!collections.includes(condition.collection)) collections.push(condition.collection || 'events');
      const entities = Array.isArray(world[condition.collection]) ? world[condition.collection].filter(item => item && item.id) : [];
      const entity = entities.find(item => item.id === condition.entityId);
      const fields = entity ? Object.keys(entity).filter(key => entity[key] === null || ['string', 'number', 'boolean'].includes(typeof entity[key])) : [];
      if (condition.field && !fields.includes(condition.field)) fields.push(condition.field);
      body = selectControl('实体集合', condition.collection, cf('collection'), collections.map(key => [key, key])) + selectControl('稳定实体 ID', condition.entityId, cf('entityId'), [['', '选择已有世界实体'], ...entities.map(item => [item.id, `${item.name || item.title || item.id} · ${item.id}`]), ...(!entities.some(item => item.id === condition.entityId) && condition.entityId ? [[condition.entityId, `${condition.entityId}（当前未找到）`]] : [])]) + selectControl('字段', condition.field, cf('field'), [['', '选择字段'], ...fields.map(key => [key, key])]) + selectControl('比较', condition.op, cf('op'), [['eq', '等于'], ['ne', '不等于'], ['gt', '大于'], ['gte', '大于等于'], ['lt', '小于'], ['lte', '小于等于'], ['contains', '包含'], ['exists', '存在']]) + selectControl('比较值类型', typeof condition.value, `${attrs} data-outline-condition-value-type="true"`, [['string', '文本'], ['number', '数字'], ['boolean', '是／否']]) + (typeof condition.value === 'boolean' ? `<label class="we-outline-check"><input type="checkbox" ${cf('value')}${condition.value ? ' checked' : ''}><span>比较值为是</span></label>` : editorField('比较值', condition.value, `${cf('value')} data-outline-numeric="${typeof condition.value === 'number'}"`)) + (!entities.length ? '<p class="we-outline-hint">当前未找到带稳定 ID 的实体。缺少来源时条件会等待信息，不会自动放行。</p>' : '');
    } else if (type === 'clueContact') {
      const clueList = uid('we-outline-clue-options'), actorList = uid('we-outline-actor-options');
      const clues = [...(state().clues || [])], actors = availableEntities().filter(ref => ref.source === 'memory' && ref.type === 'character');
      for (const planned of nodesOf(plan)) if (planned.id !== node.id && planned.disclosure?.clueText && engine()?.clueIdForNode) { const id = engine().clueIdForNode(planned.id); if (!clues.some(clue => clue.id === id)) clues.push({ id, publicHint: `计划线索：${planned.title}（尚未出现）` }); }
      body = `<label class="we-outline-field"><span>线索稳定 ID（已有或计划线索）</span><input ${cf('clueId')} list="${clueList}" value="${h(condition.clueId)}"><datalist id="${clueList}">${clues.map(clue => `<option value="${h(clue.id)}">${h(clue.publicHint || clue.id)}</option>`).join('')}</datalist></label><label class="we-outline-field"><span>接触者稳定 ID（留空为任意接触者）</span><input ${cf('actorId')} list="${actorList}" value="${h(condition.actorId)}"><datalist id="${actorList}">${actors.map(ref => `<option value="${h(ref.id)}">${h(ref.nameSnapshot)}</option>`).join('')}</datalist></label><p class="we-outline-hint">尚未出现的线索会保持等待信息，不会自动认为人物已经知情。</p>`;
    } else if (type === 'time') {
      const basis = condition.basis || 'calendar';
      body = selectControl('时间依据', basis, cf('basis'), [['storyDay', '剧情总天数'], ['calendar', '日历日期']]) + selectControl('时间比较', condition.op, cf('op'), [['gte', '不早于'], ['lte', '不晚于'], ['eq', '等于']]) + (basis === 'storyDay' ? `<label class="we-outline-field"><span>剧情总天数阈值</span><input type="number" step="any" ${cf('value')} data-outline-numeric="true" value="${h(condition.value)}"></label><p class="we-outline-hint">使用已提交世界状态的总天数 world.time；缺少该值时等待信息。</p>` : editorField('剧情日历日期（如 2026-11-17）', condition.value, cf('value')) + '<p class="we-outline-hint">日历条件需要可靠的故事日期；不会使用电脑日期推测。</p>');
    } else if (type === 'authorFlag') body = editorField('作者标记名称', condition.flagId, cf('flagId')) + `<label class="we-outline-check"><input type="checkbox" ${cf('value')}${condition.value !== false ? ' checked' : ''}><span>标记必须为是</span></label>`;
    else if (type === 'literal') body = `<label class="we-outline-check"><input type="checkbox" ${cf('value')}${condition.value ? ' checked' : ''}><span>固定为满足</span></label>`;
    else if (type === 'unconfigured') body = editorField('保留原文条件（配置前不执行）', condition.text, cf('text'), true);
    return `<div class="we-outline-condition">${selectControl('条件类型', type, `${attrs} data-outline-condition-type="true"`, choices)}${body}${at.length ? button('condition-remove', '移除此条件', ` ${attrs}`) : ''}</div>`;
  }

  function renderEvidence(current, node) {
    const manual = current.manualOverrides?.[node.id];
    const events = (current.progressEvents || []).filter(item => item.nodeId === node.id && !['stale', 'invalid'].includes(item.validity) && item.valid !== false && item.stale !== true && Number(item.planRevision) === Number(current.revision));
    const event = events[events.length - 1], evidence = event?.evidence || [];
    const sourceName = item => item.kind === 'world_fact' || item.source === 'world' || item.factId || item.worldCommitId ? '世界事实' : '正文证据';
    return `${manual ? '<div class="we-outline-hint">当前状态由手动指定。</div>' : ''}${evidence.length ? `<details class="we-outline-evidence"><summary>判断证据 ${evidence.length} 条</summary>${evidence.map(item => `<blockquote><span>${sourceName(item)} · ${h(item.messageId || item.factId || item.worldCommitId || item.commitId || '')}</span><p>${h(item.quote || item.text || '')}</p></blockquote>`).join('')}</details>` : '<div class="we-outline-hint">暂无有效事实证据；作者计划本身不算证据。</div>'}`;
  }

  function schedule(channel) {
    try { return engine()?.getSchedule?.(channel) || { selected: [], nodeIds: [], explanations: [] }; }
    catch (error) { return { selected: [], explanations: [], error: String(error?.message || error) }; }
  }
  function scheduleRows(value) { return value?.explanations || value?.candidates || []; }
  function reasonText(value) {
    const code = typeof value === 'object' ? value.message || value.text || value.reason || value.code : value;
    const labels = { selected: '本轮选中', paused: '剧情线已暂停', track_paused: '剧情线已暂停', unknown: '条件信息不足', waiting: '条件尚未满足', budget: '本轮数量预算已满', budget_waiting: '本轮节点预算已满', cooldown: '等待冷却', completed: '节点已完成', node_already_closed: '节点已经完成或跳过', dependency: '等待前置节点', trigger: '等待触发条件', private: '作者私密内容不提供给正文', blocked: '当前受阻', eligible: '具备调度资格', no_extra_condition: '无额外解锁条件', author_literal: '作者固定开关', current_chapter_missing: '当前章节缺失', condition_chapter_missing: '条件引用的章节不存在', chapter_range: '检查章节范围', world_reference_unconfigured: '世界实体引用待配置', world_collection_missing: '当前世界未提供该实体集合', world_field_missing: '世界实体字段缺失', world_field_exists: '检查世界字段是否存在', field_equality: '检查字段是否相等', field_inequality: '检查字段是否不等', field_contains: '检查字段是否包含目标内容', numeric_comparison: '检查字段数值范围', comparison_requires_numbers: '比较值不是可用数字', contains_requires_text_or_array: '包含操作需要文本或列表', unsupported_operator: '比较操作尚未配置', unsafe_field_path: '字段路径不受支持', actual_clue_contact: '检查实际线索接触证据', story_time_unreliable: '剧情时间来源不可靠', absolute_story_time_missing: '缺少可靠的剧情绝对时间', condition_requires_configuration_or_evidence: '自然语言条件待配置或缺少可复核证据', verified_condition_evidence: '条件已有可复核正文证据', track_missing: '剧情线引用缺失', recovery_required: '联合历史需要先恢复或重建', node_chapter_missing: '关联章节不存在', main_chapter_gate: '主线遵守当前章节范围', cross_chapter_track_persists: '此剧情线从起始章起持续跨章生效', player_action_requires_dialogue: '玩家行动必须由正文确认，后台不会代为完成', private_node_requires_available_public_clue: '私密节点仅在已有可发现公开线索时进入正文', one_node_per_track_tick: '此后台轮次已为同线安排一个节点' };
    if (labels[code]) return labels[code];
    const timeReasons = { story_day_missing: '尚无已提交的剧情总天数', story_day_target_unconfigured: '剧情总天数阈值尚未配置为数字' };
    if (timeReasons[code]) return timeReasons[code];
    const [prefix, ...parts] = String(code || '').split(':');
    if (prefix === 'node_status') return `前置节点 ${nodeTitle(state().plan, parts[0])} 当前${STATUS_LABELS[parts[1]] || parts[1] || '状态未知'}`;
    const dynamic = { dependency_node_missing: '依赖节点不存在', world_entity_missing: '世界稳定实体不存在', clue_missing: '线索尚未出现', author_flag_unconfigured: '作者标记尚未配置', author_flag: '检查作者标记' };
    return dynamic[prefix] ? `${dynamic[prefix]}：${parts.join(':')}` : String(code || '暂无说明');
  }
  function schedulingLabel(row, selected) {
    if (row.selected || selected?.includes(row.nodeId)) return '本轮选中';
    const reasons = row.reasons || [];
    if (reasons.includes('track_paused')) return '已暂停';
    if (reasons.includes('node_already_closed')) return '已完成／跳过';
    if (reasons.includes('cooldown')) return '冷却中';
    if (reasons.includes('recovery_required')) return '等待联合恢复';
    return row.eligible === null ? '信息不足' : row.eligible === false ? '等待条件' : '预算或轮转延后';
  }

  function renderNodeCard(current, node, index) {
    const status = nodeStatus(current, node.id), track = tracksOf(current.plan).find(item => item.id === node.trackId);
    const kind = track?.kind || 'main';
    const chapters = (node.chapterIds || []).map(id => chaptersOf(current.plan).find(ch => ch.id === id)?.title || id);
    return `<article class="we-outline-node we-outline-node-${h(kind)} we-outline-node-status-${h(status)}" data-outline-node="${h(node.id)}">
      <div class="we-outline-node-head">
        <strong>${index + 1}. ${h(node.title || '未命名节点')}</strong>
        <span class="we-outline-badge we-outline-badge-${h(kind)}">${h(TRACK_LABELS[kind] || '剧情')}</span>
        <span class="we-outline-badge">${node.required === false ? '可选' : '必要'}</span>
        <span class="we-outline-status we-outline-status-${h(status)}">${h(STATUS_LABELS[status] || status)}</span>
      </div>
      ${chapters.length ? `<p class="we-outline-hint">关联章节：${h(chapters.join(' / '))}（不限制跨章调度）</p>` : '<p class="we-outline-hint">跨章节点</p>'}
      ${node.publicHint ? `<p class="we-outline-public-hint"><strong>公开提示：</strong>${h(node.publicHint)}</p>` : ''}
      <details class="we-outline-author-content"><summary>${node.visibility === 'private' || track?.kind === 'hidden' ? '作者私密内容' : '作者计划与判据'}</summary>
        <p>${h(node.intent || '未填写意图')}</p><dl><dt>完成判据</dt><dd>${h(node.completionCriteria || '尚未填写；不会自动标记完成。')}</dd>${node.notes ? `<dt>作者备注</dt><dd>${h(node.notes)}</dd>` : ''}<dt>完成来源</dt><dd>${h({ dialogue: '正文', world: '世界后台事实', either: '正文或世界事实' }[node.completionSource] || '正文')}</dd><dt>解锁条件</dt><dd>${h(conditionSummary(node.trigger, current.plan))}</dd><dt>揭示条件</dt><dd>${h(conditionSummary(node.disclosure?.condition, current.plan))}</dd>${node.disclosure?.clueText ? `<dt>满足条件后可发现的线索</dt><dd>${h(node.disclosure.clueText)}</dd>` : ''}</dl>
      </details>${renderEvidence(current, node)}
      <label class="we-outline-status-select"><span>手动指定状态</span> <select data-outline-status="${h(node.id)}" aria-label="${h(node.title)}状态"><option value="" selected>选择手动状态</option>${Object.entries(STATUS_LABELS).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}${current.manualOverrides?.[node.id] ? '<option value="auto">恢复自动判断</option>' : ''}</select></label>
    </article>`;
  }

  function renderOutlineCore(current, draft, running, enabled) {
    const plan = current.plan || {};
    const chapters = chaptersOf(plan);
    const tracks = tracksOf(plan);
    const allNodes = nodesOf(plan);
    const validClues = (current.clues || []).filter(item => item.validity !== 'stale' && item.validity !== 'invalid');
    const curIndex = chapters.findIndex(ch => ch.id === current.currentChapterId);
    const curChapter = curIndex >= 0 ? chapters[curIndex] : chapters[0] || null;
    const gates = curChapter ? (curChapter.exitNodeIds || chapterNodes(plan, curChapter.id).filter(node => node.required !== false).map(node => node.id)) : [];
    const doneGates = gates.filter(id => ['completed', 'skipped'].includes(nodeStatus(current, id))).length;
    const doneAll = allNodes.filter(node => ['completed', 'skipped'].includes(nodeStatus(current, node.id))).length;
    const ratio = gates.length > 0 ? doneGates / gates.length : (allNodes.length > 0 ? doneAll / allNodes.length : 0);
    const clamped = Math.max(0, Math.min(1, ratio));
    const R = 64, C = 2 * Math.PI * R;
    const dash = (clamped * C).toFixed(1);
    const ringColor = clamped >= 1 ? 'var(--we-accent)' : 'var(--we-gold)';
    const theta = (clamped * 360 - 90) * Math.PI / 180;
    const dotX = (80 + R * Math.cos(theta)).toFixed(1);
    const dotY = (80 + R * Math.sin(theta)).toFixed(1);
    const pctNum = gates.length > 0 ? doneGates : Math.round(clamped * 100);
    const pctUnit = gates.length > 0 ? `<span>/${gates.length}</span>` : '<span>%</span>';
    const subLabel = curChapter ? (curChapter.title || '未命名章节') : '尚未建立大纲';
    const tierLabel = !chapters.length ? '待建大纲' : (curIndex >= 0 ? `第 ${curIndex + 1}/${chapters.length} 章` : `共 ${chapters.length} 章`);
    const stats = [
      ['章节', chapters.length],
      ['剧情线', tracks.length],
      ['节点', allNodes.length],
      ['线索', validClues.length]
    ].map(([k, v]) => `<div class="we-core-stat"><div class="we-core-stat-k">${k}</div><div class="we-core-stat-v">${v}</div></div>`).join('');

    return `<div class="we-section we-core-section we-outline-core-section">
      <div class="we-core" title="${h(subLabel)}">
        <div class="we-core-ring we-outline-core-ring">
          <svg viewBox="0 0 160 160" width="160" height="160" aria-hidden="true">
            <circle cx="80" cy="80" r="${R}" fill="none" stroke="color-mix(in srgb, var(--we-gold) 18%, transparent)" stroke-width="6"/>
            <circle cx="80" cy="80" r="${R}" fill="none" stroke="${ringColor}" stroke-width="6"
              stroke-linecap="round" stroke-dasharray="${dash} ${(C - clamped * C).toFixed(1)}"
              transform="rotate(-90 80 80)"/>
            ${clamped > 0 ? `<circle cx="${dotX}" cy="${dotY}" r="3.5" fill="#ffffff" opacity="0.95"/>` : ''}
          </svg>
          <div class="we-core-center">
            <div class="we-core-title">剧情脉络</div>
            <div class="we-core-sub">${h(subLabel)}</div>
            <div class="we-core-pct we-outline-core-value" style="color:${ringColor};">${pctNum}${pctUnit}</div>
            <div class="we-core-tier" style="color:${ringColor};">${h(tierLabel)}</div>
          </div>
        </div>
        <div class="we-core-stats">${stats}</div>
        <div class="we-outline-core-actions">
          ${button('check-now', running ? '检查中…' : '立即检查', running || !enabled ? ' disabled' : '', 'primary')}
          ${button('edit-plan', draft.plan ? '继续编辑草稿' : '编辑大纲')}
          ${button('open-text', '整理文本')}
          ${running ? button('abort', '停止', '', 'danger') : ''}
        </div>
      </div>
    </div>`;
  }

  function renderOutlineNavList(draft) {
    const rows = [
      { view: 'tracks', label: '剧情', sub: '主线 · 支线 · 暗线推进看板', poem: '草蛇灰线，伏脉千里' },
      { view: 'schedule', label: '调度', sub: '本轮正文与后台注入预览', poem: '运筹帷幄之中' },
      { view: 'facts', label: '线索', sub: '幕后事实 · 接触记录 · 知情', poem: '明察秋毫，洞若观火' },
      { view: 'recovery', label: '恢复', sub: '联合历史 · 审计与重建', poem: '鉴往知来，有迹可循' },
      { view: 'transfer', label: '归档', sub: '导入导出 · 保存点 · 调试', poem: '藏诸名山，传之其人' }
    ];
    const html = rows.map((row, index) => {
      const selected = draft.selectedNavView === row.view ? ' we-nav-row--selected' : '';
      const topLine = index === 0 ? '<div class="we-nav-line we-nav-line-hidden"></div>' : '<div class="we-nav-line"></div>';
      const bottomLine = index === rows.length - 1 ? '<div class="we-nav-line we-nav-line-hidden"></div>' : '<div class="we-nav-line"></div>';
      return `<div class="we-nav-row we-outline-nav-row${selected}" data-outline-nav="${row.view}">
        <div class="we-nav-label">${row.label}</div>
        <div class="we-nav-track">${topLine}<div class="we-nav-dot"></div>${bottomLine}</div>
        <div class="we-nav-content"><span class="we-nav-sub">${row.sub}</span><span class="we-nav-poem">${row.poem}</span></div>
        <i class="fa-solid fa-chevron-right we-nav-arrow"></i>
      </div>`;
    }).join('');
    return `<div class="we-nav-list we-outline-nav-list">${html}</div>`;
  }

  function renderHome(current, draft, running, enabled) {
    const plan = current.plan || {}, chapters = chaptersOf(plan);
    if (draft.lastCurrentChapterId !== current.currentChapterId && draft.selectedChapterId === draft.lastCurrentChapterId) draft.selectedChapterId = '';
    draft.lastCurrentChapterId = current.currentChapterId;
    const selected = chapters.find(ch => ch.id === draft.selectedChapterId) || chapters.find(ch => ch.id === current.currentChapterId) || chapters[0];
    const sidebar = chapters.map((chapter, index) => {
      const gates = chapter.exitNodeIds || chapterNodes(plan, chapter.id).filter(node => node.required !== false).map(node => node.id);
      const done = gates.filter(id => ['completed', 'skipped'].includes(nodeStatus(current, id))).length;
      const isCur = chapter.id === current.currentChapterId;
      return `<button type="button" class="we-outline-chapter${selected?.id === chapter.id ? ' is-selected' : ''}${isCur ? ' is-current' : ''}" data-outline-action="select-chapter" data-outline-chapter="${h(chapter.id)}"><span>${index + 1}. ${h(chapter.title || '未命名章节')}</span><small>${isCur ? '当前章 · ' : ''}门槛 ${done}/${gates.length}</small></button>`;
    }).join('');
    const nodes = selected ? chapterNodes(plan, selected.id) : [];

    const chapterSection = `<section class="we-section we-outline-home-chapter">
      <div class="we-section-title we-outline-sec-title">章节与进度<span class="we-section-motto">— 章回流转，各有其序</span></div>
      <div class="we-outline-plan-heading">
        <div class="we-outline-plan-title">${h(plan.title || '还没有剧情大纲')}</div>
        ${plan.synopsis ? `<details class="we-outline-plan-detail"><summary>作者梗概</summary><p>${h(plan.synopsis)}</p></details>` : ''}
        ${plan.constraints ? `<details class="we-outline-plan-detail"><summary>作者完整约束</summary><p>${h(planText(plan.constraints))}</p></details>` : ''}
      </div>
      ${chapters.length ? `<nav class="we-outline-chapters" aria-label="章节列表">${sidebar}</nav>
        <div class="we-outline-chapter-detail">
          <div class="we-outline-section-head">
            <h3>${h(selected?.title || '')}</h3>
            ${selected && selected.id !== current.currentChapterId ? button('set-current-chapter', '指定为当前章', ` data-outline-chapter="${h(selected.id)}"`) : '<span class="we-outline-badge we-outline-badge-current">当前章</span>'}
          </div>
          ${selected?.goal ? `<p class="we-outline-goal">章节目标：${h(selected.goal)}</p>` : ''}
          <p class="we-outline-hint">章节用于故事节奏，其他章节的剧情线仍可并行推进。</p>
          ${nodes.map((node, index) => renderNodeCard(current, node, index)).join('') || '<p class="we-outline-empty">本章暂无关联节点。跨章节点可在“剧情”看板查看。</p>'}
        </div>`
        : `<div class="we-outline-empty-box"><p class="we-outline-empty">先手工建立剧情线与节点，或导入文本整理为大纲。</p><div class="we-outline-actions">${button('edit-plan', '新建大纲', '', 'primary')}${button('open-text', '导入文本整理')}</div></div>`}
    </section>`;

    return `<div class="we-outline-home">
      ${renderOutlineCore(current, draft, running, enabled)}
      ${renderOutlineNavList(draft)}
      ${chapterSection}
      ${renderSuggestions(current)}
    </div>`;
  }

  function renderTracks(current) {
    const tracks = tracksOf(current.plan), narrative = schedule('narrative'), world = schedule('world');
    const narrIds = new Set(narrative.nodeIds || (narrative.selected || []).map(node => node.id));
    const worldIds = new Set(world.nodeIds || (world.selected || []).map(node => node.id));
    return `${subTopbar('跨章剧情线', VIEW_META.tracks.poem)}
      <section class="we-outline-track-board">
        <p class="we-outline-hint">作者看板包含完整计划；实际正文与后台收到的内容以“调度”页为准。</p>
        ${tracks.map(track => {
          const nodes = trackNodes(current.plan, track.id);
          return `<section class="we-section we-outline-track we-outline-track-${h(track.kind)}">
            <div class="we-outline-section-head">
              <div class="we-outline-track-title-row"><span class="we-outline-badge we-outline-badge-${h(track.kind)}">${h(TRACK_LABELS[track.kind] || track.kind)}</span><h3>${h(track.title || '未命名剧情线')}</h3></div>
              <div class="we-outline-actions"><span class="we-outline-hint">优先级 ${h(track.priority ?? 0)}</span>${button('track-pause', track.paused ? '继续此线' : '暂停此线', ` data-outline-track="${h(track.id)}"`)}</div>
            </div>
            ${track.goal ? `<p class="we-outline-goal">${h(track.goal)}</p>` : ''}
            ${track.paused ? '<p class="we-outline-message">此线已由作者暂停。</p>' : ''}
            ${nodes.map((node, index) => {
              const row = [...scheduleRows(narrative), ...scheduleRows(world)].find(item => item.nodeId === node.id);
              return `<div class="we-outline-track-node"><div class="we-outline-selection-tags">${narrIds.has(node.id) ? '<span class="we-outline-badge we-outline-badge-main">本轮正文</span>' : ''}${worldIds.has(node.id) ? '<span class="we-outline-badge we-outline-badge-side">本轮后台</span>' : ''}${!narrIds.has(node.id) && !worldIds.has(node.id) && row ? `<span class="we-outline-hint">${h((row.reasons || []).map(reasonText).join('；') || (row.eligible === null ? '等待信息' : '等待调度'))}</span>` : ''}</div>${renderNodeCard(current, node, index)}</div>`;
            }).join('') || '<p class="we-outline-empty">此线暂无节点。</p>'}
          </section>`;
        }).join('') || '<div class="we-section"><p class="we-outline-empty">尚未建立剧情线。可在“编辑大纲”中新增主线、支线或暗线。</p></div>'}
        ${renderSuggestions(current)}
      </section>`;
  }

  function displayDiff(value) {
    if (value == null) return '（无）';
    if (typeof value === 'boolean') return value ? '是' : '否';
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }

  function renderSuggestions(current) {
    const suggestions = (current.proposals || []).filter(item => !item.status || ['pending', 'stale'].includes(item.status));
    if (!suggestions.length) return '';
    const labels = { title: '标题', intent: '节点意图', completionCriteria: '完成判据', notes: '备注', required: '必要节点', goal: '章节目标', nodes: '章节节点', id: 'ID' };
    return `<section class="we-section we-outline-suggestions">
      <div class="we-section-title we-outline-sec-title">AI 调整建议<span class="we-section-motto">— 参详斟酌，采而后行</span></div>
      <p class="we-outline-hint">建议只在采纳后改动大纲。未来安排不会写成已发生的事实。</p>
      ${suggestions.map(proposal => {
        const before = proposal.before && typeof proposal.before === 'object' ? proposal.before : { content: proposal.before };
        const after = proposal.after && typeof proposal.after === 'object' ? proposal.after : { content: proposal.after };
        const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
        const stale = proposal.status === 'stale' || Number(proposal.planRevision) !== Number(current.revision);
        return `<article class="we-outline-proposal"><div class="we-outline-section-head"><strong>${h(proposal.reason || '剧情调整')}</strong>${stale ? '<span class="we-outline-badge">已过期，请重新检查</span>' : ''}</div><div class="we-outline-table-scroll"><table><thead><tr><th>内容</th><th>原内容</th><th>建议内容</th></tr></thead><tbody>${keys.map(key => `<tr><th>${h(labels[key] || key)}</th><td><pre>${h(displayDiff(before[key]))}</pre></td><td><pre>${h(displayDiff(after[key]))}</pre></td></tr>`).join('') || '<tr><td colspan="3">没有可展示的改动</td></tr>'}</tbody></table></div>${proposal.evidence ? `<p class="we-outline-hint">依据：${h(displayDiff(proposal.evidence))}</p>` : ''}<div class="we-outline-actions">${button('accept-proposal', '采纳', ` data-outline-proposal="${h(proposal.id)}"${stale ? ' disabled' : ''}`, 'primary')}${button('dismiss-proposal', '拒绝', ` data-outline-proposal="${h(proposal.id)}"`)}</div></article>`;
      }).join('')}
    </section>`;
  }

  function editorField(label, value, attributes, multiline) {
    return `<label class="we-outline-field"><span>${h(label)}</span>${multiline ? `<textarea ${attributes} rows="3">${h(planText(value))}</textarea>` : `<input type="text" ${attributes} value="${h(value)}">`}</label>`;
  }

  function availableEntities() {
    const result = [], originChatId = chatId();
    try {
      const world = window.WORLD_ENGINE_CORE?.loadState?.() || {};
      for (const [type, list] of Object.entries(world)) if (Array.isArray(list)) {
        for (const item of list) if (item?.id) result.push({ source: 'world', originChatId, type, id: item.id, nameSnapshot: item.name || item.title || item.id });
      }
    } catch (_) {}
    try {
      const memory = window.MEMORY_ENGINE_DATA?.loadState?.() || {};
      for (const item of memory.personal_memory || []) if (item.id) result.push({ source: 'memory', originChatId, type: 'character', id: item.id, nameSnapshot: item.names?.[0] || item.id });
      for (const [type, list] of Object.entries(memory.entity_memory || {})) if (Array.isArray(list)) for (const item of list) if (item.id) result.push({ source: 'memory', originChatId, type, id: item.id, nameSnapshot: item.name || item.id });
    } catch (_) {}
    return result;
  }
  function renderEntityRefs(node, draft) {
    const choices = availableEntities();
    return `<div class="we-outline-entity-links"><h4>世界／记忆稳定实体关联</h4>${(node.entityRefs || []).map((ref, index) => `<p>${h(ref.nameSnapshot || ref.id)} <span class="we-outline-hint">${h(ref.source)} / ${h(ref.type)} / ${h(ref.id)}</span> ${button('entity-remove', '移除', ` data-outline-nid="${h(node.id)}" data-outline-ref-index="${index}"`)}</p>`).join('')}${selectControl('选择当前聊天实体', draft.entityPicks?.[node.id] || '', `data-outline-entity-pick="true" data-outline-nid="${h(node.id)}"`, [['', '选择实体'], ...choices.map(ref => [JSON.stringify(ref), `${ref.source === 'world' ? '世界' : '记忆'} · ${ref.nameSnapshot} · ${ref.id}`])])}${button('entity-add', '增加关联', ` data-outline-nid="${h(node.id)}"`)}</div>`;
  }

  function renderPlanPreview(plan) {
    return `<div class="we-outline-plan-preview"><h4>${h(plan?.title || '未命名大纲')}</h4><p>${h(plan?.synopsis || '')}</p><p class="we-outline-hint">${chaptersOf(plan).length} 章 · ${tracksOf(plan).length} 条剧情线 · ${nodesOf(plan).length} 个节点</p>${tracksOf(plan).map(track => `<details open><summary>${h(TRACK_LABELS[track.kind] || track.kind)}：${h(track.title)}</summary><p>${h(track.goal)}</p><ol>${trackNodes(plan, track.id).map(node => `<li><strong>${h(node.title)}</strong><p>${h(node.intent)}</p><p>完成判据：${h(node.completionCriteria || '未填写')}</p><p>依赖：${h(dependencyIds(node).map(id => nodeTitle(plan, id)).join(' / ') || '无')}</p><p>解锁：${h(conditionSummary(node.trigger, plan))}</p><p>公开提示：${h(node.publicHint || '无')}</p><p>揭示：${h(conditionSummary(node.disclosure?.condition, plan))}；${h(node.disclosure?.clueText || '')}</p></li>`).join('')}</ol></details>`).join('')}${!tracksOf(plan).length ? chaptersOf(plan).map(ch => `<h4>${h(ch.title)}</h4><ol>${chapterNodes(plan, ch.id).map(node => `<li>${h(node.title)}：${h(node.completionCriteria)}</li>`).join('')}</ol>`).join('') : ''}</div>`;
  }

  function renderValidation(plan) {
    try {
      const result = data().validatePlan?.(plan), messages = [...(result?.errors || []), ...(result?.warnings || [])];
      return messages.length ? `<div class="we-outline-validation" role="status"><strong>计划关联与条件核对</strong><ul>${messages.map(message => `<li>${h(message)}</li>`).join('')}</ul></div>` : '';
    } catch (error) { return `<p class="we-outline-message is-error">${h(error?.message || error)}</p>`; }
  }

  function renderEditor(draft) {
    const plan = draft.plan || { title: '', synopsis: '', constraints: '', chapters: [], tracks: [], nodes: [] }, saved = state();
    const changed = Number(draft.expectedRevision) !== Number(saved.revision) || draft.expectedPlanSnapshot !== JSON.stringify(saved.plan);
    const conflict = changed ? `<section class="we-section we-outline-preview"><h4>当前保存的大纲已发生变化</h4><p>你的草稿已保留。继续保存会用草稿替换当前版本，请先核对下面的内容。</p><details><summary>查看当前版本</summary>${renderPlanPreview(saved.plan)}</details>${button('rebase-editor', '已核对，保留草稿继续保存', '', 'primary')}</section>` : '';
    const chapterChoices = chaptersOf(plan).map(ch => [ch.id, ch.title || ch.id]);
    const nodeChoices = nodesOf(plan).map(node => [node.id, node.title || node.id]);
    return `${subTopbar('编辑大纲', '草蛇灰线', 'close-editor')}
      <section class="we-outline-editor">
        <p class="we-outline-hint">草稿在收起、切换页面和后台刷新后保留；确认保存才替换计划。</p>
        ${conflict}${renderValidation(plan)}
        <div class="we-section">
          <div class="we-section-title">基础信息</div>
          ${editorField('大纲标题', plan.title, 'data-outline-plan-field="title"')}
          ${editorField('作者梗概', plan.synopsis, 'data-outline-plan-field="synopsis"', true)}
          ${editorField('作者完整约束（仅后台）', plan.constraints, 'data-outline-plan-field="constraints"', true)}
          ${editorField('正文可见梗概', plan.publicSynopsis, 'data-outline-plan-field="publicSynopsis"', true)}
          ${editorField('正文可见约束', plan.publicConstraints, 'data-outline-plan-field="publicConstraints"', true)}
          <p class="we-outline-hint">作者梗概与完整约束只供作者和后台使用。正文只读取公开梗概、公开约束与已允许的提示。</p>
        </div>
        <div class="we-section">
          <div class="we-section-title">章节节奏与章末门槛</div>
          ${chaptersOf(plan).map((chapter, ci) => `<section class="we-outline-edit-chapter"><div class="we-outline-section-head"><strong>第 ${ci + 1} 章</strong><div class="we-outline-actions">${button('chapter-up', '上移', ` data-outline-ci="${ci}"${ci === 0 ? ' disabled' : ''}`)}${button('chapter-down', '下移', ` data-outline-ci="${ci}"${ci === plan.chapters.length - 1 ? ' disabled' : ''}`)}${button('chapter-remove', '删除章节', ` data-outline-ci="${ci}"`, 'danger')}</div></div>${editorField('章节标题', chapter.title, `data-outline-chapter-field="title" data-outline-ci="${ci}"`)}${editorField('章节目标', chapter.goal, `data-outline-chapter-field="goal" data-outline-ci="${ci}"`, true)}${choiceList('章末门槛（这些节点完成或作者跳过后才推进章节）', chapter.exitNodeIds, nodeChoices, `data-outline-chapter-list="exitNodeIds" data-outline-ci="${ci}"`)}</section>`).join('')}
          ${button('chapter-add', '增加章节')}
        </div>
        <div class="we-section">
          <div class="we-section-title">剧情线</div>
          ${tracksOf(plan).map((track, ti) => `<section class="we-outline-edit-track"><div class="we-outline-section-head"><strong>${h(TRACK_LABELS[track.kind] || '剧情线')} ${ti + 1}</strong><div class="we-outline-actions">${button('track-up', '上移', ` data-outline-ti="${ti}"`)}${button('track-down', '下移', ` data-outline-ti="${ti}"`)}${button('track-remove', '删除剧情线', ` data-outline-ti="${ti}"`, 'danger')}</div></div>${editorField('名称', track.title, `data-outline-track-field="title" data-outline-ti="${ti}"`)}${selectControl('类型', track.kind, `data-outline-track-field="kind" data-outline-ti="${ti}"`, Object.entries(TRACK_LABELS))}${editorField('目标', track.goal, `data-outline-track-field="goal" data-outline-ti="${ti}"`, true)}<label class="we-outline-field"><span>优先级（数字越大越优先）</span><input type="number" data-outline-track-field="priority" data-outline-ti="${ti}" value="${h(track.priority ?? 0)}"></label><label class="we-outline-check"><input type="checkbox" data-outline-track-field="paused" data-outline-ti="${ti}"${track.paused ? ' checked' : ''}><span>暂停此线</span></label>${button('node-add', '为此线增加节点', ` data-outline-track="${h(track.id)}"`)}</section>`).join('')}
          ${button('track-add', '增加剧情线')}
        </div>
        <div class="we-section">
          <div class="we-section-title">跨章节点</div>
          ${nodesOf(plan).map((node, ni) => `<details class="we-outline-edit-node" open><summary>${ni + 1}. ${h(node.title || '新节点')}</summary><div class="we-outline-actions">${button('node-up', '上移', ` data-outline-nid="${h(node.id)}"`)}${button('node-down', '下移', ` data-outline-nid="${h(node.id)}"`)}${button('node-remove', '删除节点', ` data-outline-nid="${h(node.id)}"`, 'danger')}</div>${editorField('节点标题', node.title, `data-outline-node-field="title" data-outline-nid="${h(node.id)}"`)}${selectControl('所属剧情线', node.trackId, `data-outline-node-field="trackId" data-outline-nid="${h(node.id)}"`, tracksOf(plan).map(track => [track.id, `${TRACK_LABELS[track.kind] || ''} · ${track.title}`]))}${choiceList('关联章节（只标叙事位置，不限制跨章调度）', node.chapterIds, chapterChoices, `data-outline-node-list="chapterIds" data-outline-nid="${h(node.id)}"`)}${choiceList('前置节点', dependencyIds(node), nodeChoices.filter(([id]) => id !== node.id), `data-outline-node-list="dependencies" data-outline-nid="${h(node.id)}"`)}${editorField('作者意图', node.intent, `data-outline-node-field="intent" data-outline-nid="${h(node.id)}"`, true)}${editorField('完成判据', node.completionCriteria, `data-outline-node-field="completionCriteria" data-outline-nid="${h(node.id)}"`, true)}${editorField('作者备注', node.notes, `data-outline-node-field="notes" data-outline-nid="${h(node.id)}"`, true)}${editorField('可供正文使用的公开提示', node.publicHint, `data-outline-node-field="publicHint" data-outline-nid="${h(node.id)}"`, true)}<div class="we-outline-form-grid">${selectControl('执行主体', node.actorKind || 'player', `data-outline-node-field="actorKind" data-outline-nid="${h(node.id)}"`, [['player', '玩家相关'], ['npc', 'NPC后台']])}${selectControl('完成证据来源', node.completionSource || 'dialogue', `data-outline-node-field="completionSource" data-outline-nid="${h(node.id)}"`, [['dialogue', '正文'], ['world', '世界事实'], ['either', '正文或世界事实']])}${selectControl('作者内容可见性', node.visibility || 'public', `data-outline-node-field="visibility" data-outline-nid="${h(node.id)}"`, [['public', '公开'], ['private', '仅作者与后台']])}</div><label class="we-outline-check"><input type="checkbox" data-outline-node-field="required" data-outline-nid="${h(node.id)}"${node.required !== false ? ' checked' : ''}><span>必要节点</span></label>${(node.dependencies || []).filter(dep => typeof dep === 'object').map(dep => `<label class="we-outline-check"><input type="checkbox" data-outline-dependency-skip="${h(dep.nodeId)}" data-outline-nid="${h(node.id)}"${dep.allowSkipped ? ' checked' : ''}><span>前置 ${h(nodeTitle(plan, dep.nodeId))} 被跳过时也视为满足</span></label>`).join('')}${renderEntityRefs(node, draft)}<h4>解锁条件</h4>${renderCondition(node.trigger, node, 'trigger', [], plan)}<h4>线索揭示</h4>${editorField('条件满足后可被发现的线索文本', node.disclosure?.clueText, `data-outline-disclosure-text="true" data-outline-nid="${h(node.id)}"`, true)}${renderCondition(node.disclosure?.condition, node, 'disclosure', [], plan)}<p class="we-outline-hint">满足揭示条件只代表线索可发现；人物实际接触后才形成知情记录。</p></details>`).join('')}
          ${button('node-add', '增加节点')}
        </div>
        <div class="we-settings-save-actions we-settings-save-sticky">
          ${button('save-plan', '确认保存大纲', '', 'primary')}
          ${button('close-editor', '收起（保留草稿）')}
          ${button('discard-editor', '放弃草稿', '', 'danger')}
        </div>
      </section>`;
  }

  function renderTextImport(draft) {
    return `${subTopbar('整理文本', '删繁就简', 'close-text')}
      <section class="we-section we-outline-text-import">
        <div class="we-section-title">将多线文本整理成大纲</div>
        <label class="we-outline-field"><span>粘贴主线、支线、暗线及章节安排，或选择 .txt / .md</span><textarea id="we-outline-source-text" rows="9">${h(draft.sourceText)}</textarea></label>
        <input id="we-outline-text-file" type="file" accept=".txt,.md,text/plain,text/markdown">
        <div class="we-outline-actions">${button('organize-text', draft.busy ? '正在整理…' : 'AI整理并预览', draft.busy ? ' disabled' : '', 'primary')}${button('close-text', '收起（保留文本）')}</div>
        <p class="we-outline-hint">无法确定的条件会保留原文并标待配置；不会默认为满足。整理不会立即覆盖计划。</p>
      </section>
      ${draft.preview ? `<section class="we-section we-outline-preview">${renderPlanPreview(draft.preview)}<div class="we-outline-actions">${button('adopt-preview', '确认采用整理结果', '', 'primary')}${button('edit-preview', '先编辑此结果')}${button('discard-preview', '丢弃预览', '', 'danger')}</div></section>` : ''}`;
  }

  function renderSettings(draft) {
    const value = draft.settingsDraft || settings();
    const activeTab = OUTLINE_SETTINGS_TABS.some(t => t.key === draft.settingsTab) ? draft.settingsTab : 'common';
    draft.settingsTab = activeTab;
    const outlineVersion = window.OUTLINE_ENGINE_SETTINGS?.VERSION || '2.0.0';
    const panelContent = {
      common: `<div class="we-section">
          <div class="we-section-title">模块开关与检查</div>
          <div class="we-outline-form-grid">
            ${field('启用剧情模块', 'engineEnabled', value.engineEnabled, { type: 'checkbox' })}
            ${field('自动检查新增正文', 'autoCheck', value.autoCheck !== false, { type: 'checkbox' })}
            ${field('允许 AI 提出结构调整建议', 'allowProposals', value.allowProposals !== false, { type: 'checkbox' })}
            ${field('每多少个新增轮次检查一次', 'checkEveryX', value.checkEveryX ?? 3, { type: 'number', min: 1, step: 1 })}
          </div>
        </div>
        <div class="we-section">
          <div class="we-section-title">调度预算与注入</div>
          <div class="we-outline-form-grid">
            ${field('注入正文指导', 'injectIntoPrompt', value.injectIntoPrompt !== false, { type: 'checkbox' })}
            ${field('提供指导给世界推演', 'injectIntoWorldEngine', value.injectIntoWorldEngine !== false, { type: 'checkbox' })}
            ${field('正文每轮最多安排节点', 'narrativeLimit', value.narrativeLimit ?? 3, { type: 'number', min: 1, step: 1 })}
            ${field('后台每轮最多安排节点', 'worldLimit', value.worldLimit ?? 3, { type: 'number', min: 1, step: 1 })}
            ${field('重复安排冷却轮次', 'cooldownTicks', value.cooldownTicks ?? 1, { type: 'number', min: 0, step: 1 })}
            ${field('注入目标字数预算', 'injectMaxChars', value.injectMaxChars ?? 2500, { type: 'number', min: 200, step: 100 })}
          </div>
          <p class="we-outline-hint">超长核心约束和当前节点会完整保留，优先裁剪可选背景。</p>
        </div>`,
      api: `<div class="we-section">
          <div class="we-section-title">API 连接</div>
          ${field('API 来源', 'apiSource', value.apiSource || 'world', { choices: [['world', '复用世界引擎 API'], ['custom', '剧情模块独立 API']] })}
          <p class="we-outline-hint">复用模式读取世界引擎已配置的连接；这里的保存不会改写世界或记忆的设置。</p>
          <fieldset class="we-outline-custom-api"${value.apiSource === 'custom' ? '' : ' disabled'}>
            <legend>独立 API 配置</legend>
            <div class="we-outline-form-grid">
              ${field('API URL（含版本前缀）', 'apiUrl', value.apiUrl || '')}
              ${field('API Key', 'apiKey', value.apiKey || '', { type: 'password' })}
              ${field('模型', 'model', value.model || '')}
              ${field('连接方式', 'connectionMode', value.connectionMode || 'direct', { choices: [['direct', '浏览器直连'], ['proxy', '经酒馆服务端代理']] })}
              ${field('温度', 'temperature', value.temperature ?? 0.2, { type: 'number', min: 0, step: 0.1 })}
              ${field('最大输出 tokens', 'maxTokens', value.maxTokens ?? 8192, { type: 'number', min: 1, step: 1 })}
              ${field('请求超时（秒，0 为不限）', 'apiTimeoutSeconds', (value.apiTimeoutMs ?? 120000) / 1000, { type: 'number', min: 0, step: 1 })}
            </div>
          </fieldset>
        </div>`,
      archive: `<div class="we-section">
          <div class="we-section-title">当前聊天存档</div>
          ${field('实时同步到酒馆聊天', 'syncToChat', value.syncToChat, { type: 'checkbox' })}
          ${field('自动备份', 'autoBackup', value.autoBackup, { type: 'checkbox' })}
          <p class="we-outline-hint">开启同步后，大纲计划与进度会随酒馆聊天保存；API Key 等全局设置不会写入聊天。</p>
          <div class="we-outline-actions">${button('view-transfer', '打开导入导出与保存点')}${button('view-recovery', '查看联合历史恢复')}</div>
        </div>`,
      debug: renderDebugBody(),
      about: `<div class="we-section">
          <div class="we-changelog-top"><span class="we-changelog-cur">剧情大纲 v${h(outlineVersion)}</span></div>
          <div style="font-size:12px;color:var(--we-text2);line-height:1.75;">
            跨章节多线剧情引擎。主线、支线与暗线按前置条件、时间与剧情线索独立调度；幕后事实与正文公开线索分层投影，配合世界与记忆联合历史实现可回退、可审计的叙事推演。
          </div>
        </div>`
    };
    const tabBar = `<div class="we-settings-tabs-shell">
      <button type="button" class="we-settings-tab-scroll" data-dir="-1" title="向左滚动"><i class="fa-solid fa-chevron-left"></i></button>
      <div class="we-settings-tabs" id="we-settings-tabs">
        ${OUTLINE_SETTINGS_TABS.map(tab => `<button type="button" class="we-settings-tab${tab.key === activeTab ? ' we-settings-tab--active' : ''}" data-tab="${tab.key}">${tab.label}</button>`).join('')}
      </div>
      <button type="button" class="we-settings-tab-scroll" data-dir="1" title="向右滚动"><i class="fa-solid fa-chevron-right"></i></button>
    </div>`;
    const panels = OUTLINE_SETTINGS_TABS.map(tab =>
      `<div class="we-settings-panel" data-tab="${tab.key}"${tab.key === activeTab ? '' : ' style="display:none;"'}>${panelContent[tab.key] || ''}</div>`
    ).join('');

    return `${subTopbar('设置', '凡事豫则立', 'close-settings')}
      ${tabBar}${panels}
      <div class="we-settings-save-actions we-settings-save-sticky">
        ${button('save-settings', '保存剧情设置', '', 'primary')}
        ${button('check-now', '立即检查正文')}
      </div>`;
  }

  function renderImportReview(draft) {
    const preview = draft.pendingJson;
    if (!preview) return '';
    const joint = preview.kind === 'history';
    return `<section class="we-section we-outline-preview we-outline-import-review"><h3>${joint ? '确认联合历史恢复' : '确认大纲导入'}</h3>
      ${joint ? `<p>此文件包含世界、剧情与联合提交链，并用于核对来源记忆。${preview.sameChat ? '将恢复此聊天的历史位置，保留当前作者计划与手动标记。' : '跨聊天只采用作者计划，清除来源聊天的运行游标、证据与自动进度。'}</p><p class="we-outline-hint">来源聊天：${h(preview.sourceChatId || '未提供')} · ${h(preview.journalCount ?? 0)} 个提交 · ${h(preview.snapshotCount ?? 0)} 份历史快照</p>${preview.plan ? `<details><summary>备份内作者计划${preview.sameChat ? '（同聊天恢复时保留当前计划）' : ''}</summary>${renderPlanPreview(preview.plan)}</details>` : ''}` : renderPlanPreview(preview.plan)}
      ${preview.warnings?.length ? `<ul class="we-outline-validation">${preview.warnings.map(warning => `<li>${h(warning)}</li>`).join('')}</ul>` : ''}
      ${!joint && preview.sameChat && preview.payload.state ? `<label class="we-outline-check"><input id="we-outline-import-progress" type="checkbox"${preview.includeProgress ? ' checked' : ''}><span>${preview.payload.bundle?.bundle ? '恢复此聊天世界／剧情历史，并核对来源记忆' : '恢复此聊天的原执行进度'}</span></label>` : !joint ? '<p class="we-outline-hint">执行进度从当前聊天重新开始。</p>' : ''}
      <div class="we-outline-actions">${button('confirm-json-import', joint ? '确认联合恢复' : '确认导入', '', 'primary')}${button('cancel-json-import', '取消导入')}</div></section>`;
  }

  function renderTransfer(current, draft) {
    let cc, status, snapshots = [];
    try { cc = cache(); status = cc?.getStatus?.(); snapshots = cc?.listSnapshots?.() || []; } catch (_) {}
    return `${subTopbar('归档与备份', VIEW_META.transfer.poem)}
      <section class="we-section we-outline-transfer">
        <div class="we-section-title">计划、剧情数据与联合备份</div>
        <div class="we-outline-actions">${button('export-plan', '只导出作者计划 JSON')}${button('export-full', '导出完整联动 JSON')}${button('history-export', '导出联合历史')}</div>
        <label class="we-outline-field"><span>导入计划、剧情完整 JSON 或联合历史（先预览）</span><input id="we-outline-json-file" type="file" accept=".json,application/json"></label>
        <p class="we-outline-hint">作者计划包含暗线与私密设定。跨聊天导入会清除旧聊天的运行状态；高于当前支持版本的文件不会被写入。</p>
      </section>
      <section class="we-section we-outline-transfer">
        <div class="we-section-title">聊天备份保存点</div>
        <p class="we-outline-hint">${status ? `实时同步${status.syncEnabled ? '已开启' : '已关闭'} · 本地修订 ${h(status.localRev ?? 0)} / 聊天修订 ${h(status.liveRev ?? 0)} · ${snapshots.length} 份保存点` : '当前聊天存档接口尚未就绪。'}</p>
        <div class="we-outline-actions we-outline-snap-create"><input id="we-outline-snapshot-name" value="${h(draft.snapshotName)}" placeholder="保存点名称">${button('snapshot-create', '新建命名保存点', cc ? '' : ' disabled', 'primary')}</div>
        <div class="we-chatcache-list">${snapshots.map(snap => `<div class="we-snapshot-row">
          <div class="we-snapshot-main">
            <div class="we-snapshot-name"><span class="we-snapshot-badge${snap.auto ? ' is-auto' : ''}">${snap.auto ? '自动' : '手动'}</span>${h(snap.name || '未命名保存点')}</div>
            <div class="we-snapshot-meta">${h(snap.createdAt ? new Date(snap.createdAt).toLocaleString() : '')}</div>
          </div>
          <div class="we-snapshot-actions">${button('snapshot-restore', '恢复', ` data-outline-snapshot="${h(snap.id)}"`)}${button('snapshot-rename', '重命名', ` data-outline-snapshot="${h(snap.id)}"`)}${button('snapshot-export', '导出', ` data-outline-snapshot="${h(snap.id)}"`)}${button('snapshot-delete', '删除', ` data-outline-snapshot="${h(snap.id)}"`, 'danger')}</div>
        </div>`).join('') || '<div class="we-empty" style="padding:10px;">暂无剧情保存点</div>'}</div>
        <label class="we-outline-field" style="margin-top:10px;"><span>导入聊天保存点 JSON</span><input id="we-outline-snapshot-file" type="file" accept=".json,application/json"></label>
      </section>
      <section class="we-section">
        <div class="we-section-title">运行与注入调试</div>
        <p class="we-outline-hint">查看最近 API 请求、原始响应、提示词注入状态及导出剧情诊断包。</p>
        <div class="we-outline-actions">${button('view-debug', '打开调试信息')}</div>
      </section>`;
  }

  function renderScheduleView(current) {
    const pane = (channel, title) => {
      const value = schedule(channel), rows = scheduleRows(value);
      const selected = value.nodeIds || (value.selected || []).map(node => node.id);
      let projection = '';
      try { projection = channel === 'narrative' ? engine()?.buildNarrativeGuidance?.() || '' : engine()?.buildWorldGuidance?.(window.WORLD_ENGINE_CORE?.loadState?.()) || ''; }
      catch (error) { projection = `预览失败：${error?.message || error}`; }
      return `<section class="we-section we-outline-schedule-pane">
        <div class="we-section-title">${h(title)}</div>
        <p class="we-outline-hint">选中 ${selected.length} 个节点 · ${channel === 'narrative' ? settings().narrativeLimit ?? 3 : settings().worldLimit ?? 3} 个节点预算</p>
        ${value.error ? `<p class="we-outline-message is-error">${h(value.error)}</p>` : ''}
        <div class="we-outline-table-scroll"><table><thead><tr><th>节点</th><th>本轮结果</th><th>原因与等待</th></tr></thead><tbody>${rows.map(row => `<tr><td>${h(nodeTitle(current.plan, row.nodeId))}</td><td>${h(schedulingLabel(row, selected))}</td><td>${h((row.reasons || []).map(reasonText).join('；'))}<small>已等待 ${h(row.waitTurns ?? 0)} 轮 · 优先分 ${h(row.score ?? 0)}</small></td></tr>`).join('') || '<tr><td colspan="3">暂无候选节点</td></tr>'}</tbody></table></div>
        <details open class="we-outline-projection"><summary>${channel === 'narrative' ? '正文实际会收到的指导' : '世界后台实际会收到的指导'}</summary><pre>${h(projection || '当前没有注入内容。')}</pre></details>
      </section>`;
    };
    return `${subTopbar('调度与注入', VIEW_META.schedule.poem)}
      <p class="we-outline-hint">选中、信息不足、暂停、冷却和预算延后是不同结果。正文与后台投影独立；作者私密字段不会直接进入正文。</p>
      ${pane('narrative', '正文前台')}
      ${pane('world', '世界后台')}`;
  }

  function renderFacts(current, draft) {
    const valid = items => (items || []).filter(item => item.validity !== 'stale' && item.validity !== 'invalid');
    const facts = valid(current.privateFacts), clues = valid(current.clues), contacts = valid(current.contacts), knowledge = valid(current.knowledge);
    return `${subTopbar('事实与线索', VIEW_META.facts.poem)}
      <section class="we-outline-facts">
        <p class="we-outline-hint">后台事实、线索可发现、人物实际接触和人物知情分别保存。可发现不会自动让人物知情。</p>
        <div class="we-section">
          <details open><summary>后台私密事实 ${facts.length} 条（作者可见）</summary>${facts.map(fact => `<article class="we-outline-fact"><p>${h(fact.text)}</p><small>事实 ${h(fact.id)} · 世界提交 ${h(fact.commitId)} · 已知人物 ${h((fact.knownBy || []).join(' / ') || '无')}</small></article>`).join('') || '<p class="we-outline-empty">暂无已提交的后台事实；计划不计为事实。</p>'}</details>
        </div>
        <div class="we-section">
          <details open><summary>可发现线索 ${clues.length} 条</summary>${clues.map(clue => `<article class="we-outline-fact"><strong>${h(clue.publicHint || clue.id)}</strong><p>${clue.available ? '已满足发现条件' : '尚未满足发现条件'} · ${h({ available: '可发现', contacted: '已接触', known: '已有知情记录' }[clue.status] || '等待')}</p><small>线索 ID ${h(clue.id)} · 接触者 ${h((clue.contacts || []).join(' / ') || '无')} · 知情者 ${h((clue.knownBy || []).join(' / ') || '无')}</small></article>`).join('') || '<p class="we-outline-empty">暂无线索。</p>'}</details>
        </div>
        <div class="we-section">
          <details><summary>实际接触记录 ${contacts.length} 条</summary>${contacts.map(contact => `<blockquote><span>${h(contact.actorId)} 接触 ${h(contact.clueId)} · 正文 ${h(contact.messageId)}</span><p>${h(contact.quote)}</p></blockquote>`).join('') || '<p class="we-outline-empty">尚无正文确认的接触。</p>'}</details>
          <details><summary>人物知情记录 ${knowledge.length} 条</summary>${knowledge.map(item => `<p>${h(item.actorId)} 知道事实 ${h(item.factId)} <small>依据接触 ${h(item.contactId)}</small></p>`).join('') || '<p class="we-outline-empty">尚无已验证知情记录。</p>'}</details>
        </div>
        <div class="we-section">
          <div class="we-section-title">作者标记（手动设定，历史回退时保留）</div>
          ${Object.entries(current.authorFlags || {}).map(([id, value]) => `<label class="we-outline-check"><input type="checkbox" data-outline-author-flag="${h(id)}"${value ? ' checked' : ''}><span>${h(id)}</span></label>`).join('')}
          <div class="we-outline-actions"><input id="we-outline-flag-name" value="${h(draft.newFlagId)}" placeholder="新标记名称"><label class="we-outline-check"><input id="we-outline-flag-value" type="checkbox"${draft.newFlagValue ? ' checked' : ''}><span>设为是</span></label>${button('author-flag-add', '保存作者标记', '', 'primary')}</div>
        </div>
      </section>`;
  }

  function renderQuarantineNotice() {
    let backup = null;
    try { backup = window.MEMORY_ENGINE?.getQuarantineBackup?.() || null; } catch (_) {}
    if (!backup) return '';
    return `<section class="we-section we-outline-preview we-outline-quarantine"><h3>旧记忆资料待作者复核</h3><p>从头重建时，无法核对原文来源的旧 Root 和手工记忆已完整保留到隔离备份，暂不参与自动注入。普通历史回退不会触发此隔离。</p>${backup.reason ? `<p class="we-outline-hint">${h(backup.reason)}</p>` : ''}<div class="we-outline-actions">${button('memory-quarantine-export', '导出旧记忆隔离备份')}</div><p class="we-outline-hint">导出只读取本地备份，不会自动导入旧资料，也不会额外调用记忆 API。</p></section>`;
  }

  function renderRecovery() { return `${subTopbar('联合历史恢复', VIEW_META.recovery.poem)}${renderQuarantineNotice()}${renderRecoveryDetails()}`; }

  function renderRecoveryDetails() {
    const service = history();
    if (!service?.getStatus) return '<section class="we-section"><h3>联合历史与恢复</h3><p class="we-outline-empty">联合历史模块尚未就绪。当前不会自动执行回退或重建。</p></section>';
    const status = service.getStatus(), commits = service.listCommits?.() || [];
    const phases = { ready: '可继续', preview: '历史预览', 'pending-rebuild': '等待显式重建', blocked: '恢复受阻', rebuilding: '正在重建', uninitialized: '尚未建立联合基线', disabled: '联合历史未启用' };
    return `<section class="we-section we-outline-recovery">
      <div class="we-section-title">世界、记忆与剧情联合历史</div>
      <p class="we-outline-message${status.phase === 'blocked' ? ' is-error' : ''}">${h(phases[status.phase] || status.phase || '状态待确认')}${status.reason ? ` · ${h(status.reason)}` : ''}</p>
      <dl><dt>初始基线</dt><dd>${h(status.baselineLayer ?? '未建立')}</dd><dt>可恢复起始边界</dt><dd>${h(status.recoverableFromLayer ?? '未建立')}</dd><dt>最后有效楼层</dt><dd>${h(status.lastValidLayer ?? '未记录')}</dd><dt>待重建范围起点</dt><dd>${h(status.pendingFromLayer ?? '无')}</dd><dt>当前提交</dt><dd>${h(status.currentCommitId || '无')} · 分支 ${h(status.branchId || '无')}</dd><dt>完整 journal</dt><dd>${h(status.journalCount ?? commits.length)} 个提交 · ${h(status.snapshotCount ?? 0)} 份历史快照</dd></dl>
      <p class="we-outline-hint">联合 journal 保存世界与剧情自动状态，并撤下失效的来源记忆；普通滚动备份是保存点，两者用途不同。作者大纲与手动标记在回退时保留。</p>
      <div class="we-outline-actions">${button('history-audit', '审计当前原文')}${button('history-export', '导出联合历史备份')}${button('history-rebuild', '从待重建边界批量重建', '', 'primary')}</div>
      <label class="we-outline-field"><span>导入联合历史备份（先预览再确认）</span><input id="we-outline-history-file" type="file" accept=".json,application/json"></label>
      <div class="we-outline-table-scroll"><table><thead><tr><th>提交／分支</th><th>位置</th><th>类型与状态</th><th>恢复</th></tr></thead><tbody>${commits.map(commit => `<tr><td>${h(commit.id)}<small>${h(commit.branchId || '')}</small></td><td>${h(commit.layer ?? '—')}</td><td>${h(commit.kind || '')} · ${h(commit.status || '')}</td><td>${button('history-restore', '恢复此提交', ` data-outline-commit="${h(commit.id)}"`)}</td></tr>`).join('') || '<tr><td colspan="4">尚无联合提交记录</td></tr>'}</tbody></table></div>
    </section>`;
  }

  function renderTemporalNotice(current) {
    const notice = current.tracking?.temporalNotice;
    if (!notice || notice.kind === 'normal') return '';
    const labels = { flashback: '回忆片段', dream: '梦境片段', return_scene: '返回当前场景', contradiction: '原文时序存在矛盾', in_world_rewind: '故事内发生时间回溯' };
    return `<section class="we-section we-outline-temporal"><strong>${h(labels[notice.kind] || '时序待核对')}</strong><p>${h(notice.reason || '请核对正文与事实来源。')}</p><p class="we-outline-hint">回忆、梦境或故事内时间变化不会自动等同于删除真实聊天历史。需要联合恢复时请进入恢复页明确操作。</p>${(notice.evidence || []).map(item => `<blockquote><span>正文 ${h(item.messageId)}</span><p>${h(item.quote)}</p></blockquote>`).join('')}</section>`;
  }

  function renderDebugBody() {
    const debug = engine()?.getLastDebug?.() || {};
    let injection = null;
    try { injection = window.WORLD_ENGINE_INJECT_INSPECTOR?.getLastSnapshot?.('outline'); } catch (_) {}
    return `<section class="we-section we-outline-debug">
      <div class="we-section-title">剧情运行与注入调试</div>
      <p>运行状态：${h(engine()?.getRunningLabel?.() || (engine()?.isRunning?.() ? '运行中' : '空闲'))}</p>
      <p>最近错误：${h(engine()?.getLastError?.() || '无')}</p>
      <p>最终提示词注入：${h(injection?.status || '尚无记录')}</p>
      <div class="we-outline-actions">${button('export-diag', '导出剧情诊断包')}</div>
      <details><summary>最近请求</summary><pre>${h(debug.prompt || debug.requestPrompt || '暂无请求')}</pre></details>
      <details><summary>最近响应</summary><pre>${h(debug.rawResult || debug.response || debug.apiResponse || '暂无响应')}</pre></details>
      ${injection ? `<details><summary>最近注入检查</summary><pre>${h(JSON.stringify(injection, null, 2))}</pre></details>` : ''}
    </section>`;
  }

  function renderDebug() {
    return `${subTopbar('剧情调试', VIEW_META.debug.poem)}${renderDebugBody()}`;
  }

  function render() {
    const draft = draftFor(), current = state(), running = draft.busy || Boolean(engine()?.isRunning?.()) || isRebuilding(), enabled = settings().engineEnabled === true;
    const views = {
      home: () => renderHome(current, draft, running, enabled),
      tracks: () => renderTracks(current),
      schedule: () => renderScheduleView(current),
      facts: () => renderFacts(current, draft),
      recovery: () => renderRecovery(),
      transfer: () => renderTransfer(current, draft),
      debug: () => renderDebug()
    };
    const body = draft.settingsOpen
      ? renderSettings(draft)
      : draft.editorOpen
        ? renderEditor(draft)
        : draft.textOpen
          ? renderTextImport(draft)
          : (views[draft.view] || views.home)();
    const statusText = enabled
      ? `剧情模块已启用 · 每 ${settings().checkEveryX ?? 3} 轮自动检查`
      : '剧情模块当前关闭；仍可编辑与保存计划，启用后才检查和注入。';

    return `<div class="we-outline-root">
      <div class="we-outline-status-strip${enabled ? ' is-enabled' : ''}">${h(statusText)}</div>
      ${draft.message ? `<p role="status" class="we-outline-message${draft.error ? ' is-error' : ''}">${h(draft.message)}</p>` : ''}
      ${renderTemporalNotice(current)}
      ${renderImportReview(draft)}
      ${body}
    </div>`;
  }

  function commitReviewedPlan(plan, revision, snapshot) {
    // 导入或恢复存档可能带回相同修订号；还需比对用户开始审阅时的计划本身。
    if (snapshot && snapshot !== JSON.stringify(state().plan)) throw new Error('审阅期间大纲已变化。草稿已保留，请对照当前大纲后重试。');
    const validation = data().validatePlan?.(data().normalizePlan(plan));
    if (validation && !validation.valid) throw new Error(validation.errors.join('\n'));
    engine()?.abort?.();
    return data().commitPlan(clone(plan), revision);
  }

  function startEditor(plan, revision, snapshot) {
    const draft = draftFor();
    if (!draft.plan || plan) {
      draft.plan = clone(plan || state().plan || { title: '', synopsis: '', constraints: '', chapters: [] });
      draft.expectedRevision = revision ?? state().revision;
      draft.expectedPlanSnapshot = snapshot || JSON.stringify(state().plan);
    }
    draft.editorOpen = true;
    draft.textOpen = false;
    draft.settingsOpen = false;
  }

  function captureInput(element) {
    if (!element) return;
    const draft = draftFor(), ds = element.dataset || {};
    if (element.id === 'we-outline-source-text') draft.sourceText = element.value;
    else if (element.id === 'we-outline-snapshot-name') draft.snapshotName = element.value;
    else if (element.id === 'we-outline-flag-name') draft.newFlagId = element.value;
    else if (element.id === 'we-outline-flag-value') draft.newFlagValue = element.checked;
    else if (element.id === 'we-outline-import-progress' && draft.pendingJson) draft.pendingJson.includeProgress = element.checked;
    else if (ds.outlineSetting) {
      if (!draft.settingsDraft) draft.settingsDraft = clone(settings());
      const name = ds.outlineSetting;
      let value = element.type === 'checkbox' ? element.checked : element.value;
      if (element.type === 'number') {
        value = Number(element.value);
        if (!Number.isFinite(value)) return;
      }
      if (name === 'apiTimeoutSeconds') { draft.settingsDraft.apiTimeoutMs = Math.max(0, value) * 1000; }
      else draft.settingsDraft[name] = value;
    } else if (ds.outlineConditionType || ds.outlineConditionField || ds.outlineConditionValueType) {
      const node = findDraftNode(draft, ds);
      if (!node) return;
      const path = JSON.parse(ds.outlineConditionPath || '[]'), slot = ds.outlineConditionSlot || 'trigger';
      let condition = conditionAt(node, slot, path);
      if (ds.outlineConditionType) {
        const next = blankCondition(element.value);
        if ((element.value === 'all' || element.value === 'any') && (condition?.all || condition?.any)) next[element.value] = condition.all || condition.any;
        replaceCondition(node, slot, path, next);
      } else if (ds.outlineConditionValueType && condition) condition.value = element.value === 'number' ? 0 : element.value === 'boolean' ? true : '';
      else if (condition) {
        const key = ds.outlineConditionField;
        if (ds.outlineConditionArray) condition[key] = toggleChoice(condition[key], element.value, element.checked);
        else condition[key] = element.type === 'checkbox' ? element.checked : ds.outlineNumeric === 'true' ? Number(element.value) : element.value;
        if (key === 'collection') { condition.entityId = ''; condition.field = ''; }
        else if (key === 'entityId') condition.field = '';
        else if (key === 'basis') condition.value = element.value === 'storyDay' ? 0 : '';
      }
    } else if (ds.outlinePlanField && draft.plan) draft.plan[ds.outlinePlanField] = element.value;
    else if (ds.outlineChapterField && draft.plan?.chapters?.[Number(ds.outlineCi)]) draft.plan.chapters[Number(ds.outlineCi)][ds.outlineChapterField] = element.value;
    else if (ds.outlineChapterList && draft.plan?.chapters?.[Number(ds.outlineCi)]) {
      const chapter = draft.plan.chapters[Number(ds.outlineCi)];
      chapter[ds.outlineChapterList] = toggleChoice(chapter[ds.outlineChapterList], element.value, element.checked);
    } else if (ds.outlineTrackField) {
      const track = draft.plan?.tracks?.[Number(ds.outlineTi)];
      if (track) {
        track[ds.outlineTrackField] = element.type === 'checkbox' ? element.checked : element.type === 'number' ? Number(element.value) : element.value;
        if (ds.outlineTrackField === 'kind' && element.value === 'hidden') trackNodes(draft.plan, track.id).forEach(node => { node.visibility = 'private'; });
      }
    } else if (ds.outlineNodeList) {
      const node = findDraftNode(draft, ds);
      if (node) {
        const selected = toggleChoice(ds.outlineNodeList === 'dependencies' ? dependencyIds(node) : node[ds.outlineNodeList], element.value, element.checked);
        node[ds.outlineNodeList] = ds.outlineNodeList === 'dependencies' ? selected.map(id => (node.dependencies || []).find(dep => dep.nodeId === id) || { nodeId: id, allowSkipped: false }) : selected;
      }
    } else if (ds.outlineDependencySkip) {
      const node = findDraftNode(draft, ds), dep = node?.dependencies?.find(item => item.nodeId === ds.outlineDependencySkip);
      if (dep) dep.allowSkipped = element.checked;
    } else if (ds.outlineDisclosureText) {
      const node = findDraftNode(draft, ds);
      if (node) node.disclosure = { ...(node.disclosure || {}), clueText: element.value };
    } else if (ds.outlineEntityPick) {
      if (!draft.entityPicks) draft.entityPicks = {};
      draft.entityPicks[ds.outlineNid] = element.value;
    } else if (ds.outlineNodeField) {
      const node = findDraftNode(draft, ds);
      if (node) {
        node[ds.outlineNodeField] = element.type === 'checkbox' ? element.checked : element.value;
        if (ds.outlineNodeField === 'trackId' && tracksOf(draft.plan).find(track => track.id === element.value)?.kind === 'hidden') node.visibility = 'private';
      }
    }
  }

  function toggleChoice(values, id, selected) {
    const set = new Set(values || []);
    if (selected) set.add(id); else set.delete(id);
    return [...set];
  }

  function download(value, name) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function uid(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
  function reorder(list, index, step) {
    const next = index + step;
    if (list && next >= 0 && index >= 0 && index < list.length && next < list.length) [list[index], list[next]] = [list[next], list[index]];
  }

  async function handleAction(action, element) {
    const draft = draftFor(), ds = element?.dataset || {}, current = state();
    const ci = Number(ds.outlineCi);
    if (['home', 'tracks', 'schedule', 'facts', 'recovery', 'transfer', 'debug'].some(view => action === 'view-' + view)) {
      draft.view = action.slice(5);
      draft.selectedNavView = null;
      draft.settingsOpen = false;
      draft.editorOpen = false;
      draft.textOpen = false;
    }
    else if (action === 'toggle-settings') { draft.settingsOpen = !draft.settingsOpen; if (draft.settingsOpen) { draft.editorOpen = false; draft.textOpen = false; } if (!draft.settingsDraft) draft.settingsDraft = clone(settings()); }
    else if (action === 'close-settings') draft.settingsOpen = false;
    else if (action === 'edit-plan') startEditor();
    else if (action === 'close-editor') draft.editorOpen = false;
    else if (action === 'rebase-editor') { draft.expectedRevision = current.revision; draft.expectedPlanSnapshot = JSON.stringify(current.plan); draft.message = '已保留草稿并采用当前大纲作为保存基底。'; draft.error = false; }
    else if (action === 'discard-editor') { if (!window.confirm || window.confirm('放弃当前未保存的大纲草稿？')) { draft.editorOpen = false; draft.plan = null; } }
    else if (action === 'open-text') { draft.textOpen = true; draft.editorOpen = false; draft.settingsOpen = false; }
    else if (action === 'close-text') draft.textOpen = false;
    else if (action === 'select-chapter') draft.selectedChapterId = ds.outlineChapter === current.currentChapterId ? '' : ds.outlineChapter;
    else if (action === 'set-current-chapter') { engine()?.abort?.(); data().setCurrentChapter(ds.outlineChapter); draft.selectedChapterId = ''; engine()?.applyInjection?.(); notify('已指定当前章节。'); }
    else if (action === 'chapter-add') { draft.plan.chapters.push({ id: uid('chapter'), title: '新章节', goal: '', exitNodeIds: [] }); }
    else if (action === 'chapter-remove') {
      if (!window.confirm || window.confirm('从草稿删除章节？剧情节点会保留，只移除与此章的关联。')) {
        const removed = draft.plan.chapters.splice(ci, 1)[0];
        nodesOf(draft.plan).forEach(node => { node.chapterIds = (node.chapterIds || []).filter(id => id !== removed.id); });
      }
    }
    else if (action === 'chapter-up' || action === 'chapter-down') reorder(draft.plan.chapters, ci, action.endsWith('up') ? -1 : 1);
    else if (action === 'track-add') { if (!draft.plan.tracks) draft.plan.tracks = []; draft.plan.tracks.push({ id: uid('track'), kind: draft.plan.tracks.length ? 'side' : 'main', title: '新剧情线', goal: '', priority: 0, paused: false }); }
    else if (action === 'track-up' || action === 'track-down') reorder(draft.plan.tracks, Number(ds.outlineTi), action.endsWith('up') ? -1 : 1);
    else if (action === 'track-remove') {
      const track = draft.plan.tracks[Number(ds.outlineTi)];
      if (trackNodes(draft.plan, track.id).length) throw new Error('此线仍有节点，请先将节点移动到其他剧情线或删除节点。');
      draft.plan.tracks.splice(Number(ds.outlineTi), 1);
    } else if (action === 'track-pause') {
      const plan = clone(current.plan), track = tracksOf(plan).find(item => item.id === ds.outlineTrack);
      if (!track) throw new Error('剧情线已不存在。');
      track.paused = !track.paused; engine()?.abort?.(); data().commitPlan(plan, current.revision); engine()?.applyInjection?.();
    } else if (action === 'node-add') {
      if (!draft.plan.nodes) draft.plan.nodes = [];
      if (!tracksOf(draft.plan).length) draft.plan.tracks = [{ id: uid('track'), kind: 'main', title: '主线', goal: '', priority: 0, paused: false }];
      const track = tracksOf(draft.plan).find(item => item.id === ds.outlineTrack) || tracksOf(draft.plan)[0], hidden = track.kind === 'hidden';
      draft.plan.nodes.push({ id: uid('node'), trackId: track.id, chapterIds: [], dependencies: [], title: '新节点', intent: '', completionCriteria: '', notes: '', required: true, trigger: null, publicHint: '', disclosure: { condition: null, clueText: '' }, entityRefs: [], actorKind: hidden ? 'npc' : 'player', completionSource: hidden ? 'world' : 'dialogue', visibility: hidden ? 'private' : 'public' });
    } else if (action === 'node-remove') {
      const node = findDraftNode(draft, ds);
      if (!node) throw new Error('节点已不存在。');
      if (nodesOf(draft.plan).some(other => dependencyIds(other).includes(node.id)) || chaptersOf(draft.plan).some(chapter => (chapter.exitNodeIds || []).includes(node.id))) throw new Error('此节点仍被前置依赖或章末门槛引用，请先移除相关引用。');
      draft.plan.nodes = draft.plan.nodes.filter(item => item.id !== node.id);
    } else if (action === 'node-up' || action === 'node-down') {
      const node = findDraftNode(draft, ds), peers = trackNodes(draft.plan, node.trackId), index = peers.findIndex(item => item.id === node.id), other = peers[index + (action.endsWith('up') ? -1 : 1)];
      if (other) { const a = draft.plan.nodes.findIndex(item => item.id === node.id), b = draft.plan.nodes.findIndex(item => item.id === other.id); [draft.plan.nodes[a], draft.plan.nodes[b]] = [draft.plan.nodes[b], draft.plan.nodes[a]]; }
    } else if (action === 'condition-add' || action === 'condition-remove') {
      const node = findDraftNode(draft, ds), path = JSON.parse(ds.outlineConditionPath || '[]'), slot = ds.outlineConditionSlot || 'trigger';
      if (!node) throw new Error('节点已不存在。');
      if (action === 'condition-add') { const condition = conditionAt(node, slot, path); const list = condition?.all || condition?.any; if (!list) throw new Error('请先选择全部或任一条件组。'); list.push(blankCondition('unconfigured')); }
      else replaceCondition(node, slot, path, undefined);
    } else if (action === 'entity-add') {
      const node = findDraftNode(draft, ds), raw = draft.entityPicks?.[ds.outlineNid];
      if (!node || !raw) throw new Error('请先选择当前聊天的稳定实体。');
      const ref = JSON.parse(raw); if (!availableEntities().some(item => item.source === ref.source && item.type === ref.type && item.id === ref.id)) throw new Error('此实体已不存在，请重新选择。');
      if (!node.entityRefs) node.entityRefs = [];
      if (!node.entityRefs.some(item => item.source === ref.source && item.type === ref.type && item.id === ref.id)) node.entityRefs.push(ref);
    } else if (action === 'entity-remove') { const node = findDraftNode(draft, ds); node?.entityRefs?.splice(Number(ds.outlineRefIndex), 1); }
    else if (action === 'author-flag-add') {
      const id = draft.newFlagId.trim(); if (!id) throw new Error('请输入作者标记名称。');
      engine()?.abort?.(); const next = state(); next.authorFlags = { ...(next.authorFlags || {}), [id]: draft.newFlagValue }; data().saveState(next); draft.newFlagId = ''; engine()?.applyInjection?.();
    } else if (action === 'save-plan') {
      commitReviewedPlan(draft.plan, draft.expectedRevision, draft.expectedPlanSnapshot);
      draft.plan = null; draft.editorOpen = false; draft.message = '大纲已保存。'; draft.error = false;
      engine()?.applyInjection?.();
    } else if (action === 'save-settings') {
      const next = clone(draft.settingsDraft || settings());
      next.checkEveryX = Math.max(1, Math.floor(Number(next.checkEveryX) || 3));
      next.injectMaxChars = Math.max(200, Math.floor(Number(next.injectMaxChars) || 2500));
      next.maxTokens = Math.max(1, Math.floor(Number(next.maxTokens) || 65000));
      next.apiTimeoutMs = Math.max(0, Number(next.apiTimeoutMs) || 0);
      const previous = settings();
      const requestKeys = ['engineEnabled', 'autoCheck', 'checkEveryX', 'allowProposals', 'narrativeLimit', 'worldLimit', 'cooldownTicks', 'apiSource', 'apiUrl', 'apiKey', 'model', 'connectionMode', 'temperature', 'maxTokens', 'apiTimeoutMs'];
      if (requestKeys.some(key => previous[key] !== next[key])) engine()?.abort?.();
      window.OUTLINE_ENGINE_SETTINGS.patchSettings(next);
      draft.settingsDraft = clone(settings());
      if (next.syncToChat) cache()?.pushLiveNow?.();
      engine()?.applyInjection?.();
      notify('剧情设置已保存。');
    } else if (action === 'organize-text') {
      if (!draft.sourceText.trim()) throw new Error('请先粘贴或导入剧情文本。');
      const text = draft.sourceText, revision = current.revision, snapshot = JSON.stringify(current.plan);
      await run(async origin => { const plan = await engine().organizeText(text); origin.preview = clone(plan); origin.previewRevision = revision; origin.previewPlanSnapshot = snapshot; origin.message = '整理完成。请检查预览后确认采用，或先进入结构编辑。'; }, '正在整理剧情文本…');
    } else if (action === 'adopt-preview') {
      commitReviewedPlan(draft.preview, draft.previewRevision, draft.previewPlanSnapshot);
      draft.preview = null; draft.textOpen = false; draft.message = '已采用整理后的大纲。';
      engine()?.applyInjection?.();
    } else if (action === 'edit-preview') { startEditor(draft.preview, draft.previewRevision, draft.previewPlanSnapshot); draft.textOpen = false; }
    else if (action === 'discard-preview') draft.preview = null;
    else if (action === 'check-now') {
      await run(async origin => {
        const result = await engine().checkNow();
        const reasons = { disabled: '请先启用剧情模块。', busy: '已有剧情任务正在运行。', generating: '正文正在生成，请在回复完成后检查。', 'no-current-chapter': '当前章还没有可检查的节点。', 'no-sources': '暂无可用于判断的新增正文。', 'already-checked': '这些正文已经检查过，无需重复。', 'final-chapter-complete': '全部必要剧情已完成。', 'stale-result': '正文或大纲已变化，本次结果未写入。', aborted: '检查已停止。' };
        origin.message = result?.reason ? (reasons[result.reason] || `检查结果：${result.reason}`) : '正文检查完成。节点状态与调整建议已更新。';
        origin.error = result?.ok === false && result?.reason !== 'aborted';
      }, '正在检查新增正文…');
    } else if (action === 'abort') { if (isRebuilding()) { if (!window.WORLD_ENGINE?.abortLinkedRebuild) throw new Error('联合重建停止接口尚未就绪。'); await window.WORLD_ENGINE.abortLinkedRebuild(); } engine()?.abort?.(); notify('已发送停止信号。'); }
    else if (action === 'accept-proposal') { engine()?.abort?.(); await engine().applyProposal(ds.outlineProposal, current.revision); notify('已采纳剧情调整建议。'); }
    else if (action === 'dismiss-proposal') { await engine().dismissProposal(ds.outlineProposal); notify('已拒绝此建议。'); }
    else if (action === 'export-full') { const bundle = history()?.exportBundle?.() || null; download({ ...data().exportData(), bundle }, `outline-linked-full-${Date.now()}.json`); if (!bundle?.bundle) draft.message = '已导出剧情数据；当前尚无联合历史基线，因此此文件没有历史 journal。'; }
    else if (action === 'export-plan') download({ __outlineEnginePlan: true, schemaVersion: data().SCHEMA_VERSION || 2, plan: current.plan }, `outline-plan-${Date.now()}.json`);
    else if (action === 'cancel-json-import') draft.pendingJson = null;
    else if (action === 'confirm-json-import') {
      const preview = draft.pendingJson;
      if (!preview) throw new Error('请先选择待导入文件。');
      engine()?.abort?.();
      if (preview.kind === 'history') { if (!history()?.importBundle) throw new Error('联合历史模块尚未就绪。'); await history().importBundle(preview.payload); }
      else {
        const before = state();
        try { data().importData(preview.payload, { includeProgress: preview.sameChat && preview.includeProgress }); if (preview.sameChat && preview.includeProgress && preview.payload.bundle?.bundle) await history().importBundle(preview.payload.bundle); }
        catch (error) { data().saveState(before); throw error; }
      }
      await window.WORLD_ENGINE_STORE?.flush?.();
      draft.pendingJson = null; draft.message = '已按确认范围完成导入。'; engine()?.applyInjection?.();
    } else if (action === 'history-export') {
      if (!history()?.exportBundle) throw new Error('联合历史模块尚未就绪。');
      const value = history().exportBundle(); if (!value?.bundle) throw new Error('尚未建立联合历史基线，请先启用剧情模块并建立历史记录。'); download(value, `story-linked-history-${Date.now()}.json`);
    } else if (action === 'history-audit') {
      if (!history()?.reconcile) throw new Error('联合历史模块尚未就绪。');
      await history().reconcile(); notify('原文审计已完成，请查看恢复状态与待重建范围。');
    } else if (action === 'history-restore') {
      if (!history()?.restoreCommit) throw new Error('联合历史恢复接口尚未就绪。');
      if (!window.confirm || window.confirm('恢复到此联合提交？后续自动状态将撤回并标记待重建，作者大纲与手动标记会保留。')) await run(async (origin, id) => { ensureCurrentChat(id); await history().restoreCommit(ds.outlineCommit); await window.WORLD_ENGINE_STORE?.flush?.(); origin.message = '已恢复联合提交，后续原文需显式批量重建。'; }, '正在恢复联合历史…');
    } else if (action === 'history-rebuild') {
      if (!history()?.rebuild) throw new Error('联合批量重建接口尚未就绪。');
      const status = history().getStatus();
      if (!window.confirm || window.confirm(`从待重建边界 ${status.pendingFromLayer ?? status.lastValidLayer ?? '当前有效位置'} 批量重建世界、记忆与剧情？此操作会调用已配置API，作者计划与手动标记保留。`)) await run(async (origin, id) => { ensureCurrentChat(id); await history().rebuild(); origin.message = '批量重建已返回，请核对联合历史状态与剩余待重建范围。'; }, '正在批量重建联合历史…');
    } else if (action === 'snapshot-create') {
      if (!cache()?.createSnapshot?.(draft.snapshotName.trim() || '剧情存档')) throw new Error('未能创建存档，请检查当前聊天与剧情数据。');
      draft.snapshotName = ''; draft.message = '剧情存档已创建。';
    } else if (action === 'snapshot-restore') {
      if (!window.confirm || window.confirm('恢复此剧情存档？当前剧情状态将替换为存档内容。')) {
        if (!(await cache()?.restoreSnapshot?.(ds.outlineSnapshot))) throw new Error('恢复存档失败。');
        engine()?.applyInjection?.(); draft.message = '剧情存档已恢复。';
      }
    } else if (action === 'snapshot-rename') {
      const snap = cache()?.listSnapshots?.().find(item => item.id === ds.outlineSnapshot);
      const name = window.prompt?.('新的剧情存档名称', snap?.name || '剧情存档');
      if (name != null && name.trim() && !cache()?.renameSnapshot?.(ds.outlineSnapshot, name.trim())) throw new Error('重命名失败。');
    } else if (action === 'snapshot-export') {
      const exported = cache()?.exportSnapshot?.(ds.outlineSnapshot);
      if (!exported) throw new Error('没有可导出的存档。');
      download(exported, `outline-snapshot-${Date.now()}.json`);
    } else if (action === 'snapshot-delete') {
      if ((!window.confirm || window.confirm('删除这份剧情存档？')) && !cache()?.deleteSnapshot?.(ds.outlineSnapshot)) throw new Error('删除存档失败。');
    } else if (action === 'memory-quarantine-export') {
      const backup = window.MEMORY_ENGINE?.getQuarantineBackup?.();
      if (!backup) throw new Error('当前聊天没有可导出的旧记忆隔离备份。');
      download(backup, `memory-quarantine-${Date.now()}.json`);
    } else if (action === 'export-diag') window.WORLD_ENGINE_DIAG?.download?.('outline');
    refresh();
  }

  async function importFile(file, kind) {
    const originId = chatId(), draft = draftFor(originId);
    if (!file) return;
    const allowed = kind === 'text' ? /\.(txt|md)$/i : /\.json$/i;
    if (!allowed.test(String(file.name || ''))) throw new Error(kind === 'text' ? '仅支持 .txt 和 .md 文本文件。' : '请选择 .json 文件。');
    const sizeLimit = kind === 'text' ? 5 : 64;
    if (Number(file.size) > sizeLimit * 1024 * 1024) throw new Error(`文件超过 ${sizeLimit} MB，请先精简内容。`);
    const text = await file.text();
    ensureCurrentChat(originId);
    if (kind === 'text') { draft.sourceText = text; draft.message = '文本已载入，点击 AI 整理并预览后再确认采用。'; }
    else {
      let payload;
      try { payload = JSON.parse(text); } catch (_) { throw new Error('JSON 格式无效，尚未导入任何内容。'); }
      for (const version of [payload?.schemaVersion, payload?.state?.schemaVersion, payload?.bundle?.schemaVersion, payload?.bundle?.bundle?.schemaVersion]) {
        if (version != null && (!Number.isInteger(Number(version)) || Number(version) < 1)) throw new Error('文件的数据版本字段无效，尚未写入任何内容。');
        if (Number(version) > (data().SCHEMA_VERSION || 2)) throw new Error('文件来自更新的数据版本，当前版本不能读取；没有写入任何内容。');
      }
      if (kind === 'snapshot') {
        if (!window.confirm || window.confirm('将这份剧情快照导入当前聊天的存档列表？')) {
          if (!cache()?.importSnapshot?.(payload)) throw new Error('文件不是有效的剧情存档。');
          draft.message = '剧情存档已导入列表；点击恢复后才替换当前进度。';
        }
      } else {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('文件不包含有效的大纲对象。');
        const isHistory = payload.type === 'story-engine-bundle' || (payload.schemaVersion === 2 && payload.baseline && Array.isArray(payload.journal));
        if (isHistory) {
          const bundle = payload.bundle || payload;
          if (!bundle?.baseline || !Array.isArray(bundle.journal)) throw new Error('联合历史文件缺少完整基线或journal。');
          draft.pendingJson = { kind: 'history', payload: clone(payload), sourceChatId: bundle.chatId, sameChat: String(bundle.chatId || '') === originId, includeProgress: false, journalCount: bundle.journal.length, snapshotCount: bundle.snapshots?.length || 0, plan: payload.outline?.plan ? data().normalizePlan(payload.outline.plan) : null };
        } else {
          const candidate = payload.plan || payload.state?.plan || payload;
          if (!Array.isArray(candidate.chapters)) throw new Error('文件中没有 chapters 章节列表。');
          const seen = new Set();
          for (const item of [...chaptersOf(candidate), ...tracksOf(candidate), ...nodesOf(candidate)]) if (item?.id) { if (seen.has(item.id)) throw new Error(`文件存在重复 ID：${item.id}，请先修正引用。`); seen.add(item.id); }
          const plan = data().normalizePlan(candidate), validation = data().validatePlan?.(plan);
          if (validation && !validation.valid) throw new Error(validation.errors.join('\n'));
          draft.pendingJson = { kind: 'data', payload: clone(payload), plan, warnings: validation?.warnings || [], sourceChatId: payload.chatId || payload.state?.originChatId || '', sameChat: String(payload.chatId || payload.state?.originChatId || '') === originId, includeProgress: false };
        }
        draft.message = 'JSON 已读取。请确认导入范围后再写入。';
      }
    }
    refresh();
  }

  function bind(body) {
    const root = body?.querySelector?.('.we-outline-root') || document.querySelector('.we-outline-root');
    if (!root) return;
    root.oninput = event => { try { captureInput(event.target); } catch (error) { notify(error?.message || error, true); } };
    root.onchange = async event => {
      const element = event.target;
      try {
        captureInput(element);
        if (element?.dataset?.outlineStatus && element.value) {
          engine()?.abort?.();
          const next = data().setNodeStatus(element.dataset.outlineStatus, element.value);
          const advanced = data().advanceChapter(next);
          if (advanced.currentChapterId !== next.currentChapterId) data().saveState(advanced);
          engine()?.applyInjection?.(); refresh();
        } else if (element?.dataset?.outlineAuthorFlag) {
          engine()?.abort?.(); const next = state(); next.authorFlags = { ...(next.authorFlags || {}), [element.dataset.outlineAuthorFlag]: element.checked }; data().saveState(next); engine()?.applyInjection?.(); refresh();
        } else if (['we-outline-text-file', 'we-outline-json-file', 'we-outline-snapshot-file', 'we-outline-history-file'].includes(element.id)) {
          await importFile(element.files?.[0], element.id === 'we-outline-text-file' ? 'text' : element.id === 'we-outline-snapshot-file' ? 'snapshot' : 'json');
          element.value = '';
        } else if (element?.dataset?.outlineSetting === 'apiSource' || element?.dataset?.outlineConditionType || element?.dataset?.outlineConditionValueType || ['collection', 'entityId', 'basis'].includes(element?.dataset?.outlineConditionField) || element?.dataset?.outlineNodeList === 'dependencies' || element?.dataset?.outlineTrackField === 'kind' || element?.dataset?.outlineNodeField === 'trackId') refresh();
      } catch (error) { notify(error?.message || error, true); }
    };
    root.onclick = async event => {
      const navRow = event.target?.closest?.('.we-outline-nav-row[data-outline-nav]');
      if (navRow && root.contains(navRow)) {
        event.preventDefault();
        const targetView = navRow.dataset.outlineNav;
        const draft = draftFor();
        if (draft.selectedNavView === targetView) {
          draft.selectedNavView = null;
          await handleAction('view-' + targetView, navRow);
        } else {
          draft.selectedNavView = targetView;
          refresh();
        }
        return;
      }
      const element = event.target?.closest?.('[data-outline-action]');
      if (element && root.contains(element)) {
        event.preventDefault();
        try { await handleAction(element.dataset.outlineAction, element); }
        catch (error) { notify(error?.message || error, true); }
        return;
      }
      const tabBtn = event.target?.closest?.('.we-settings-tab[data-tab]');
      if (tabBtn && root.contains(tabBtn) && !tabBtn.onclick) {
        const key = tabBtn.dataset.tab;
        draftFor().settingsTab = key;
        root.querySelectorAll('.we-settings-tab').forEach(t => t.classList.toggle('we-settings-tab--active', t.dataset.tab === key));
        root.querySelectorAll('.we-settings-panel').forEach(p => { p.style.display = p.dataset.tab === key ? '' : 'none'; });
        return;
      }
      const draft = draftFor();
      if (draft.view === 'home' && !draft.settingsOpen && !draft.editorOpen && !draft.textOpen && draft.selectedNavView && !event.target?.closest?.('.we-nav-row, select, input, textarea, button, summary, details, label, a')) {
        draft.selectedNavView = null;
        refresh();
      }
    };
  }

  function init() {
    if (initialized) return;
    if (!window.WORLD_ENGINE_UI?.registerEngineFace) throw new Error('剧情界面需要共用 UI 注册入口。');
    window.WORLD_ENGINE_UI.registerEngineFace({
      id: 'outline', label: '剧情大纲', panelClass: 'we-outline-face', ballClass: 'we-ball-outline-face',
      render, bind,
      openSettings: () => {
        const draft = draftFor();
        draft.settingsOpen = !draft.settingsOpen;
        if (draft.settingsOpen) { draft.editorOpen = false; draft.textOpen = false; }
        if (!draft.settingsDraft) draft.settingsDraft = clone(settings());
      },
      isSettingsOpen: () => draftFor().settingsOpen,
      onSettingsTab: key => { draftFor().settingsTab = key; },
      isEditing: () => { const draft = draftFor(); return draft.editorOpen || draft.textOpen || Boolean(draft.pendingJson); },
      getHeaderText: () => {
        const current = state(), chapters = chaptersOf(current.plan);
        if (!chapters.length) return '尚未建纲';
        const index = chapters.findIndex(item => item.id === current.currentChapterId);
        return index >= 0 ? `第 ${index + 1}/${chapters.length} 章` : `共 ${chapters.length} 章`;
      },
      getHeaderMood: () => {
        const current = state(), chapters = chaptersOf(current.plan);
        const chapter = chapters.find(item => item.id === current.currentChapterId) || chapters[0] || null;
        const enabled = settings().engineEnabled === true;
        const running = draftFor().busy || Boolean(engine()?.isRunning?.()) || isRebuilding();
        if (running) {
          return { text: engine()?.getRunningLabel?.() || (isRebuilding() ? '联合历史重建中' : '正在检查剧情…'), color: 'var(--we-gold)' };
        }
        const chapterName = chapter ? (chapter.title || '未命名章节') : '尚未设置剧情大纲';
        if (enabled) {
          return { text: `${chapterName} · 每 ${settings().checkEveryX ?? 3} 轮检查`, color: 'var(--we-accent)' };
        }
        return { text: `${chapterName} · 模块未启用`, color: 'var(--we-text3)' };
      },
      getTheme: () => { try { return localStorage.getItem('we-theme') || 'default'; } catch (_) { return 'default'; } },
      getVersion: () => window.OUTLINE_ENGINE_SETTINGS?.VERSION || '1.0.0',
      getSettings: settings,
      setEnabled: enabled => { if (!enabled) engine()?.abort?.(); window.OUTLINE_ENGINE_SETTINGS.patchSettings({ engineEnabled: enabled }); if (draftFor().settingsDraft) draftFor().settingsDraft.engineEnabled = enabled; engine()?.applyInjection?.(); },
      isRunning: () => draftFor().busy || Boolean(engine()?.isRunning?.()) || isRebuilding(),
      getRunningLabel: () => engine()?.getRunningLabel?.() || (isRebuilding() ? '联合历史重建' : draftFor().busy ? '剧情任务' : ''),
      showForward: true, showRedo: false, forwardTitle: '立即检查剧情进度',
      forward: () => handleAction('check-now'), redo: () => handleAction('check-now'), abort: () => engine()?.abort?.()
    });
    initialized = true;
  }

  return { init, render, bind, _test: { h, draftFor, captureInput, handleAction, importFile, renderSuggestions } };
})();
