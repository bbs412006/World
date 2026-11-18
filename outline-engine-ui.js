// 独立剧情界面：支持精简看板浏览、卡片原地随时增删改、双层表单与防剧透分层控制。
window.OUTLINE_ENGINE_UI = (function() {
  'use strict';
  const drafts = new Map();
  const STATUS_LABELS = { pending: '待推进', active: '进行中', completed: '完成', skipped: '跳过', blocked: '受阻' };
  const TRACK_LABELS = { main: '主线', side: '支线', hidden: '暗线' };
  const VIEW_META = {
    tracks: { title: '跨章剧情线', poem: '草蛇灰线，伏脉千里' },
    schedule: { title: '注入与调度', poem: '运筹帷幄之中' },
    facts: { title: '线索与真相', poem: '明察秋毫，洞若观火' },
    recovery: { title: '联合历史恢复', poem: '鉴往知来，有迹可循' },
    transfer: { title: '存档与恢复', poem: '藏诸名山，鉴往知来' },
    debug: { title: '剧情调试', poem: '纤毫毕现' }
  };
  const OUTLINE_SETTINGS_TABS = [
    { key: 'common', label: '常用' },
    { key: 'link', label: '联动' },
    { key: 'advanced', label: '高级' },
    { key: 'archive', label: '存档' },
    { key: 'debug', label: '调试' },
    { key: 'about', label: '关于' }
  ];
  const OUTLINE_THEME_KEY = 'outline-engine-theme';
  const OUTLINE_THEMES = [
    { id: 'default', name: '墨玉 · 默认' },
    { id: 'night', name: '夜阑 · 近黑' },
    { id: 'deepsea', name: '深海 · 幽蓝' },
    { id: 'plum', name: '夜合 · 暗紫' },
    { id: 'paper', name: '云白 · 清爽' },
    { id: 'sakura', name: '早樱 · 浅粉' }
  ];
  function normalizeOutlineTheme(id) {
    return OUTLINE_THEMES.some(theme => theme.id === id) ? id : 'default';
  }
  function getStoredOutlineTheme() {
    try { return normalizeOutlineTheme(localStorage.getItem(OUTLINE_THEME_KEY) || localStorage.getItem('we-theme') || 'default'); }
    catch (_) { return 'default'; }
  }
  function applyOutlineTheme(id) {
    const theme = normalizeOutlineTheme(id);
    if (typeof document !== 'undefined' && document.documentElement) {
      if (theme === 'default') document.documentElement.removeAttribute('data-we-theme');
      else document.documentElement.setAttribute('data-we-theme', theme);
    }
    try { localStorage.setItem(OUTLINE_THEME_KEY, theme); } catch (_) {}
  }
  let initialized = false;
  const clean = value => String(value == null ? '' : value).trim();
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
      view: 'home', boardMode: 'chapter', tracksBoardMode: 'track', selectedNavView: null, settingsOpen: false, settingsTab: 'common', settingsDraft: null, coordinationMode: null, collapsedSections: {},
      editorOpen: false, textOpen: false, injectionPreviewOpen: false,
      expandedNodes: {}, expandedEditorNodes: {}, expandedEditorAdv: {}, inlineEdit: null,
      confirmDeleteTrackId: null, confirmBatchDeleteTrackId: null,
      plan: null, expectedRevision: null, expectedPlanSnapshot: '', selectedChapterId: '', lastCurrentChapterId: '',
      sourceText: '', preview: null, previewRevision: null, previewPlanSnapshot: '', pendingJson: null,
      snapshotName: '', newFlagId: '', newFlagValue: true, newClueText: '', fetchedModels: [], fetchingModels: false,
      message: '', error: false, busy: false
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
  function iconButton(action, iconClass, title, extra, danger) {
    return `<button type="button" class="we-icon-btn${danger ? ' we-outline-icon-danger' : ''}" data-outline-action="${h(action)}" title="${h(title)}" aria-label="${h(title)}"${extra || ''}><i class="fa-solid ${h(iconClass)}"></i></button>`;
  }
  function field(label, name, value, options) {
    const opt = options || {};
    const attrs = `id="we-outline-${h(name)}" data-outline-setting="${h(name)}"`;
    if (opt.type === 'checkbox') return `<label class="we-outline-check"><input ${attrs} type="checkbox"${value ? ' checked' : ''}><span>${h(label)}</span></label>`;
    if (opt.choices) return `<label class="we-outline-field"><span>${h(label)}</span><select ${attrs}>${opt.choices.map(([id, text]) => `<option value="${h(id)}"${String(value) === id ? ' selected' : ''}>${h(text)}</option>`).join('')}</select></label>`;
    return `<label class="we-outline-field"><span>${h(label)}</span><input ${attrs} type="${h(opt.type || 'text')}" value="${h(value)}"${opt.min != null ? ` min="${opt.min}"` : ''}${opt.step ? ` step="${opt.step}"` : ''}${opt.type === 'password' ? ' autocomplete="new-password"' : ''}></label>`;
  }
  function settingHint(hint) {
    return hint ? `<div class="we-outline-field-hint">${hint}</div>` : '';
  }
  function settingsSection(draft, id, title, body) {
    const collapsed = Boolean(draft?.collapsedSections?.[id]);
    return `<div class="we-section"><div class="we-section-title"><span class="we-section-toggle" data-section="${h(id)}"><span class="we-section-arrow" id="we-section-arrow-${h(id)}">${collapsed ? '▶' : '▼'}</span>${h(title)}</span></div><div class="we-section-body" id="we-section-body-${h(id)}"${collapsed ? ' style="display:none"' : ''}>${body}</div></div>`;
  }
  function settingCheck(label, name, checked, hint) {
    return `<div class="we-input-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input id="we-outline-${h(name)}" data-outline-setting="${h(name)}" type="checkbox"${checked ? ' checked' : ''}>${h(label)}</label>${settingHint(hint)}</div>`;
  }
  function settingInput(label, name, value, opts) {
    const opt = opts || {};
    const numAttrs = `${opt.min != null ? ` min="${opt.min}"` : ''}${opt.max != null ? ` max="${opt.max}"` : ''}${opt.step ? ` step="${opt.step}"` : ''}`;
    const placeholder = opt.placeholder ? ` placeholder="${h(opt.placeholder)}"` : '';
    const auto = opt.type === 'password' ? ' autocomplete="new-password"' : '';
    return `<div class="we-input-group"><label>${h(label)}</label><input id="we-outline-${h(name)}" data-outline-setting="${h(name)}" type="${h(opt.type || 'text')}" value="${h(value)}"${placeholder}${numAttrs}${auto} style="width:100%;">${settingHint(opt.hint)}</div>`;
  }
  function settingSelect(label, name, value, choices, hint) {
    return `<div class="we-input-group"><label>${h(label)}</label><select id="we-outline-${h(name)}" data-outline-setting="${h(name)}" style="width:100%;">${choices.map(([id, text]) => `<option value="${h(id)}"${String(value) === id ? ' selected' : ''}>${h(text)}</option>`).join('')}</select>${settingHint(hint)}</div>`;
  }
  function settingCompactField(label, name, value, opts) {
    const opt = opts || {};
    const numAttrs = `${opt.min != null ? ` min="${opt.min}"` : ''}${opt.max != null ? ` max="${opt.max}"` : ''}${opt.step ? ` step="${opt.step}"` : ''}`;
    return `<div style="flex:1;"><label>${h(label)}</label><input id="we-outline-${h(name)}" data-outline-setting="${h(name)}" type="${h(opt.type || 'number')}" value="${h(value)}"${numAttrs} style="width:100%;"></div>`;
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
  function uid(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
  function reorder(list, index, step) {
    const next = index + step;
    if (list && next >= 0 && index >= 0 && index < list.length && next < list.length) [list[index], list[next]] = [list[next], list[index]];
  }
  function toggleChoice(values, id, selected) {
    const set = new Set(values || []);
    if (selected) set.add(id); else set.delete(id);
    return [...set];
  }
  function findDraftNode(draft, ds) {
    if (!draft.editorOpen && draft.inlineEdit?.kind === 'node' && draft.inlineEdit.data && (!ds?.outlineNid || draft.inlineEdit.data.id === ds.outlineNid)) {
      return draft.inlineEdit.data;
    }
    return nodesOf(draft.plan).find(node => node.id === ds?.outlineNid) || draft.plan?.chapters?.[Number(ds?.outlineCi)]?.nodes?.[Number(ds?.outlineNi)];
  }
  function editingPlanContext(draft) {
    if (!draft.editorOpen && draft.inlineEdit?.kind === 'node') return state().plan || { chapters: [], tracks: [], nodes: [] };
    return draft.plan || state().plan || { chapters: [], tracks: [], nodes: [] };
  }

  function blankNodeFor(track, chapterId) {
    const hidden = track?.kind === 'hidden';
    return {
      id: uid('node'), trackId: track?.id || 'main', chapterIds: chapterId ? [chapterId] : [], dependencies: [],
      title: '', intent: '', completionCriteria: '', notes: '', required: true,
      trigger: null, publicHint: '', disclosure: { condition: null, clueText: '' }, entityRefs: [],
      actorKind: hidden ? 'npc' : 'player', completionSource: hidden ? 'world' : 'dialogue',
      visibility: hidden ? 'private' : 'public'
    };
  }
  function nodeUsageSummary(plan, nodeId) {
    const depCount = nodesOf(plan).filter(other => other.id !== nodeId && dependencyIds(other).includes(nodeId)).length;
    const exitCount = chaptersOf(plan).filter(ch => (ch.exitNodeIds || []).includes(nodeId)).length;
    return { depCount, exitCount, hasRefs: depCount > 0 || exitCount > 0 };
  }
  function removeNodeFromPlan(plan, nodeId) {
    plan.nodes = nodesOf(plan).filter(item => item.id !== nodeId);
    for (const node of plan.nodes) {
      node.dependencies = (node.dependencies || []).filter(dep => (typeof dep === 'string' ? dep : dep.nodeId) !== nodeId);
    }
    for (const ch of chaptersOf(plan)) {
      if (Array.isArray(ch.exitNodeIds)) ch.exitNodeIds = ch.exitNodeIds.filter(id => id !== nodeId);
    }
  }
  function removeTrackFromPlan(plan, trackId, mode, fallbackTrackId) {
    if (!Array.isArray(plan.tracks)) return;
    const index = plan.tracks.findIndex(item => item.id === trackId);
    if (index < 0) return;
    if (mode === 'delete-nodes') {
      for (const node of trackNodes(plan, trackId)) removeNodeFromPlan(plan, node.id);
    } else if (mode === 'move-nodes') {
      const target = plan.tracks.find(item => item.id === fallbackTrackId && item.id !== trackId)
        || plan.tracks.find(item => item.id !== trackId && item.kind === 'main')
        || plan.tracks.find(item => item.id !== trackId);
      if (!target) throw new Error('没有其他可接收节点的剧情线。');
      for (const node of nodesOf(plan)) {
        if (node.trackId === trackId) node.trackId = target.id;
      }
    }
    plan.tracks.splice(index, 1);
  }
  function canCommitSavedPlan(draft) {
    if (!draft.plan) return true;
    if (window.confirm && !window.confirm('存在未保存的“全量编排”草稿；直接修改会丢弃草稿并即时生效，是否继续？')) return false;
    draft.plan = null;
    draft.expectedRevision = null;
    draft.expectedPlanSnapshot = '';
    return true;
  }
  function commitSavedPlan(draft, mutator, message) {
    if (!canCommitSavedPlan(draft)) return false;
    const current = state();
    const nextPlan = clone(current.plan || { title: '', synopsis: '', constraints: '', publicSynopsis: '', publicConstraints: '', chapters: [], tracks: [], nodes: [] });
    if (mutator(nextPlan, current) === false) return false;
    engine()?.abort?.();
    data().commitPlan(nextPlan, current.revision);
    draft.inlineEdit = null;
    draft.confirmDeleteTrackId = null;
    engine()?.applyInjection?.();
    if (message) { draft.message = message; draft.error = false; }
    return true;
  }

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
  function editorField(label, value, attributes, multiline, placeholder) {
    const ph = placeholder ? ` placeholder="${h(placeholder)}"` : '';
    return `<label class="we-outline-field"><span>${h(label)}</span>${multiline ? `<textarea ${attributes} rows="3"${ph}>${h(planText(value))}</textarea>` : `<input type="text" ${attributes} value="${h(value)}"${ph}>`}</label>`;
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
  function shortScheduleSummary(node, status, narrSched, worldSched) {
    if (['completed', 'skipped'].includes(status)) return { text: '', tone: '' };
    const narrIds = new Set(narrSched.nodeIds || (narrSched.selected || []).map(n => n.id));
    const worldIds = new Set(worldSched.nodeIds || (worldSched.selected || []).map(n => n.id));
    if (narrIds.has(node.id)) return { text: '本轮注入正文', tone: 'main' };
    if (worldIds.has(node.id)) return { text: '本轮发往后台', tone: 'side' };
    const row = scheduleRows(narrSched).find(item => item.nodeId === node.id) || scheduleRows(worldSched).find(item => item.nodeId === node.id);
    if (!row) return { text: '', tone: '' };
    const filtered = (row.reasons || []).filter(r => r !== 'no_extra_condition' && r !== 'main_chapter_gate' && r !== 'cross_chapter_track_persists');
    const firstReason = filtered[0] ? reasonText(filtered[0]) : schedulingLabel(row, []);
    return { text: firstReason, tone: 'muted' };
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
    const choices = availableEntities(), picks = (!draft.editorOpen && draft.inlineEdit?.kind === 'node') ? (draft.inlineEdit.entityPicks || {}) : (draft.entityPicks || {});
    return `<div class="we-outline-entity-links"><h4>世界／记忆稳定实体关联</h4>${(node.entityRefs || []).map((ref, index) => `<p>${h(ref.nameSnapshot || ref.id)} <span class="we-outline-hint">${h(ref.source)} / ${h(ref.type)} / ${h(ref.id)}</span> ${button('entity-remove', '移除', ` data-outline-nid="${h(node.id)}" data-outline-ref-index="${index}"`)}</p>`).join('')}${selectControl('选择当前聊天实体', picks[node.id] || '', `data-outline-entity-pick="true" data-outline-nid="${h(node.id)}"`, [['', '选择实体'], ...choices.map(ref => [JSON.stringify(ref), `${ref.source === 'world' ? '世界' : '记忆'} · ${ref.nameSnapshot} · ${ref.id}`])])}${button('entity-add', '增加关联', ` data-outline-nid="${h(node.id)}"`)}</div>`;
  }

  // 共用节点双层表单（原地编辑 & 全局编排共用，常用字段常驻，条件树/可见性按需展开）
  function renderNodeFormBody(node, plan, draft, advOpen, onSaveAction, onCancelAction, saveLabel) {
    const chapterChoices = chaptersOf(plan).map(ch => [ch.id, ch.title || ch.id]);
    const trackChoices = tracksOf(plan).length ? tracksOf(plan).map(track => [track.id, `${TRACK_LABELS[track.kind] || ''} · ${track.title || '未命名剧情线'}`]) : [['main', '主线 · 默认主线']];
    const nodeChoices = nodesOf(plan).filter(item => item.id !== node.id).map(item => [item.id, item.title || item.id]);
    return `${editorField('节点标题', node.title, `data-outline-node-field="title" data-outline-nid="${h(node.id)}"`, false, '例如：在酒馆偶遇线人')}
      <div class="we-outline-form-grid">
        ${selectControl('所属剧情线', node.trackId, `data-outline-node-field="trackId" data-outline-nid="${h(node.id)}"`, trackChoices)}
        <label class="we-outline-check we-outline-check-inline"><input type="checkbox" data-outline-node-field="required" data-outline-nid="${h(node.id)}"${node.required !== false ? ' checked' : ''}><span>必要节点（作章末推进门槛）</span></label>
      </div>
      ${chaptersOf(plan).length ? choiceList('关联章节（只标所属章回，不限制跨章调度）', node.chapterIds, chapterChoices, `data-outline-node-list="chapterIds" data-outline-nid="${h(node.id)}"`) : ''}
      ${editorField('剧情意图 / 发展方向', node.intent, `data-outline-node-field="intent" data-outline-nid="${h(node.id)}"`, true, '想推动怎样的遭遇、冲突或氛围')}
      ${editorField('完成判据（留空则需手动标完成）', node.completionCriteria, `data-outline-node-field="completionCriteria" data-outline-nid="${h(node.id)}"`, true, '正文明确写出哪些条件满足后算完成')}
      <details class="we-outline-adv-fold" data-outline-adv-key="${h(node.id)}"${advOpen ? ' open' : ''}>
        <summary data-outline-action="toggle-adv-fold" data-outline-nid="${h(node.id)}">高级调度与防剧透设置（公开提示、前置依赖、解锁与线索）</summary>
        <div class="we-outline-adv-body">
          ${editorField('可供正文使用的公开提示', node.publicHint, `data-outline-node-field="publicHint" data-outline-nid="${h(node.id)}"`, true, '留空则用节点标题；暗线建议填不剧透的探索提示')}
          ${editorField('作者备注', node.notes, `data-outline-node-field="notes" data-outline-nid="${h(node.id)}"`, true)}
          <div class="we-outline-form-grid">
            ${selectControl('执行主体', node.actorKind || 'player', `data-outline-node-field="actorKind" data-outline-nid="${h(node.id)}"`, [['player', '玩家相关'], ['npc', 'NPC后台']])}
            ${selectControl('完成证据来源', node.completionSource || 'dialogue', `data-outline-node-field="completionSource" data-outline-nid="${h(node.id)}"`, [['dialogue', '正文'], ['world', '世界事实'], ['either', '正文或世界事实']])}
            ${selectControl('作者内容可见性', node.visibility || 'public', `data-outline-node-field="visibility" data-outline-nid="${h(node.id)}"`, [['public', '公开'], ['private', '仅作者与后台']])}
          </div>
          ${choiceList('前置节点', dependencyIds(node), nodeChoices, `data-outline-node-list="dependencies" data-outline-nid="${h(node.id)}"`)}
          ${(node.dependencies || []).filter(dep => typeof dep === 'object').map(dep => `<label class="we-outline-check"><input type="checkbox" data-outline-dependency-skip="${h(dep.nodeId)}" data-outline-nid="${h(node.id)}"${dep.allowSkipped ? ' checked' : ''}><span>前置 ${h(nodeTitle(plan, dep.nodeId))} 被跳过时也视为满足</span></label>`).join('')}
          ${renderEntityRefs(node, draft)}
          <h4>解锁条件</h4>
          ${renderCondition(node.trigger, node, 'trigger', [], plan)}
          <h4>线索揭示</h4>
          ${editorField('条件满足后可被发现的线索文本', node.disclosure?.clueText, `data-outline-disclosure-text="true" data-outline-nid="${h(node.id)}"`, true)}
          ${renderCondition(node.disclosure?.condition, node, 'disclosure', [], plan)}
          <p class="we-outline-hint">满足揭示条件只代表线索可发现；人物实际接触后才形成知情记录。</p>
        </div>
      </details>
      ${onSaveAction ? `<div class="we-outline-actions we-outline-inline-actions">${button(onCancelAction, '取消')}${button(onSaveAction, saveLabel || '保存节点', '', 'primary')}</div>` : ''}`;
  }

  function renderNodeCard(current, node, index, draft, schedContext) {
    const uiDraft = draft || draftFor();
    const status = nodeStatus(current, node.id);
    const track = tracksOf(current.plan).find(item => item.id === node.trackId);
    const kind = track?.kind || 'main';
    const isEditing = !uiDraft.editorOpen && uiDraft.inlineEdit?.kind === 'node' && !uiDraft.inlineEdit.isNew && uiDraft.inlineEdit.id === node.id;
    const expanded = isEditing || Boolean(uiDraft.expandedNodes?.[node.id]);
    const chapters = (node.chapterIds || []).map(id => chaptersOf(current.plan).find(ch => ch.id === id)?.title || id);
    const sched = schedContext ? shortScheduleSummary(node, status, schedContext.narrative, schedContext.world) : { text: '', tone: '' };
    const snippet = clean(node.intent || node.publicHint || '');

    return `<article class="we-outline-node we-outline-node-${h(kind)} we-outline-node-status-${h(status)}${expanded ? '' : ' is-collapsed'}" data-outline-node="${h(node.id)}">
      <div class="we-outline-node-head">
        <button type="button" class="we-icon-btn we-outline-node-toggle" data-outline-action="toggle-node" data-outline-nid="${h(node.id)}" title="${expanded ? '收起详情' : '展开详情'}" aria-expanded="${expanded ? 'true' : 'false'}"><i class="fa-solid fa-chevron-${expanded ? 'down' : 'right'}"></i></button>
        <div class="we-outline-node-title-wrap" data-outline-action="toggle-node" data-outline-nid="${h(node.id)}">
          <strong>${index + 1}. ${h(node.title || '未命名节点')}</strong>
          <div class="we-outline-node-badges">
            <span class="we-outline-badge we-outline-badge-${h(kind)}">${h(TRACK_LABELS[kind] || '剧情')}</span>
            <span class="we-outline-status we-outline-status-${h(status)}">${h(STATUS_LABELS[status] || status)}</span>
            ${node.required === false ? '<span class="we-outline-badge">可选</span>' : ''}
            ${sched.text ? `<span class="we-outline-sched-pill is-${h(sched.tone)}">${h(sched.text)}</span>` : ''}
          </div>
        </div>
        ${isEditing ? '' : `<div class="we-outline-node-ops">
          ${iconButton('quick-edit-node', 'fa-pen', '编辑节点', ` data-outline-nid="${h(node.id)}"`)}
          ${iconButton('quick-remove-node', 'fa-trash', '删除节点', ` data-outline-nid="${h(node.id)}"`, true)}
        </div>`}
      </div>
      ${!expanded && snippet ? `<p class="we-outline-node-snippet">${h(snippet)}</p>` : ''}
      <div class="we-outline-node-body"${expanded ? '' : ' hidden'}>
        ${isEditing
          ? `<div class="we-outline-inline-editor">${renderNodeFormBody(uiDraft.inlineEdit.data, current.plan, uiDraft, uiDraft.inlineEdit.showAdvanced, 'quick-save-node', 'quick-edit-cancel', '保存节点')}</div>`
          : `${chapters.length ? `<p class="we-outline-hint">关联章节：${h(chapters.join(' / '))}</p>` : '<p class="we-outline-hint">跨章节点（全章均参与条件调度）</p>'}
            ${node.publicHint ? `<p class="we-outline-public-hint"><strong>公开提示：</strong>${h(node.publicHint)}</p>` : ''}
            <details class="we-outline-author-content" open><summary>${node.visibility === 'private' || track?.kind === 'hidden' ? '作者私密内容' : '作者计划与判据'}</summary>
              <p>${h(node.intent || '未填写意图')}</p><dl><dt>完成判据</dt><dd>${h(node.completionCriteria || '尚未填写；不会自动标记完成。')}</dd>${node.notes ? `<dt>作者备注</dt><dd>${h(node.notes)}</dd>` : ''}<dt>完成来源</dt><dd>${h({ dialogue: '正文', world: '世界后台事实', either: '正文或世界事实' }[node.completionSource] || '正文')}</dd><dt>解锁条件</dt><dd>${h(conditionSummary(node.trigger, current.plan))}</dd><dt>揭示条件</dt><dd>${h(conditionSummary(node.disclosure?.condition, current.plan))}</dd>${node.disclosure?.clueText ? `<dt>满足条件后可发现的线索</dt><dd>${h(node.disclosure.clueText)}</dd>` : ''}</dl>
            </details>${renderEvidence(current, node)}
            <label class="we-outline-status-select"><span>手动指定状态</span> <select data-outline-status="${h(node.id)}" aria-label="${h(node.title)}状态"><option value="" selected>选择手动状态</option>${Object.entries(STATUS_LABELS).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}${current.manualOverrides?.[node.id] ? '<option value="auto">恢复自动判断</option>' : ''}</select></label>`}
      </div>
    </article>`;
  }

  function renderOutlineCore(current, draft, running, enabled, narrSched) {
    const plan = current.plan || {};
    const chapters = chaptersOf(plan), tracks = tracksOf(plan), allNodes = nodesOf(plan);
    const validClues = (current.clues || []).filter(item => item.validity !== 'stale' && item.validity !== 'invalid');
    const curIndex = chapters.findIndex(ch => ch.id === current.currentChapterId);
    const curChapter = curIndex >= 0 ? chapters[curIndex] : chapters[0] || null;
    const gates = curChapter ? (curChapter.exitNodeIds || chapterNodes(plan, curChapter.id).filter(node => node.required !== false).map(node => node.id)) : [];
    const doneGates = gates.filter(id => ['completed', 'skipped'].includes(nodeStatus(current, id))).length;
    const doneAll = allNodes.filter(node => ['completed', 'skipped'].includes(nodeStatus(current, node.id))).length;
    const ratio = gates.length > 0 ? doneGates / gates.length : (allNodes.length > 0 ? doneAll / allNodes.length : 0);
    const clamped = Math.max(0, Math.min(1, ratio));
    const R = 64, C = 2 * Math.PI * R, dash = (clamped * C).toFixed(1);
    const ringColor = clamped >= 1 ? 'var(--we-accent)' : 'var(--we-gold)';
    const theta = (clamped * 360 - 90) * Math.PI / 180;
    const dotX = (80 + R * Math.cos(theta)).toFixed(1), dotY = (80 + R * Math.sin(theta)).toFixed(1);
    const pctNum = gates.length > 0 ? doneGates : Math.round(clamped * 100);
    const pctUnit = gates.length > 0 ? `<span>/${gates.length}</span>` : '<span>%</span>';
    const subLabel = curChapter ? (curChapter.title || '未命名章节') : (allNodes.length ? '跨章无章界大纲' : '尚未建立大纲');
    const tierLabel = !chapters.length ? (allNodes.length ? `共 ${allNodes.length} 个节点` : '待建大纲') : (curIndex >= 0 ? `第 ${curIndex + 1}/${chapters.length} 章` : `共 ${chapters.length} 章`);
    const stats = [['章节', chapters.length], ['剧情线', tracks.length], ['节点', allNodes.length], ['线索', validClues.length]]
      .map(([k, v]) => `<div class="we-core-stat"><div class="we-core-stat-k">${k}</div><div class="we-core-stat-v">${v}</div></div>`).join('');

    let previewDrawer = '';
    if (draft.injectionPreviewOpen) {
      let guidanceText = '';
      if (!enabled) guidanceText = '模块尚未启用；启用后将在每次生成正文前，按系统提示词柔性注入选中节点的公开指引。';
      else if (settings().injectIntoPrompt === false) guidanceText = '“注入正文指导”开关已关闭，当前不会向正文注入任何大纲内容。';
      else {
        const chosen = narrSched.selected || [];
        const publicChosen = chosen.filter(node => node.visibility !== 'private');
        const clues = validClues.filter(c => c.available && c.publicHint);
        guidanceText = publicChosen.length || clues.length
          ? `【本轮拟进入正文的公开内容】\n${publicChosen.map(n => `- ${n.trackId === 'legacy-main' ? n.title : (n.publicHint || n.title)}`).join('\n')}${clues.length ? `\n可发现线索：${clues.map(c => c.publicHint).join('；')}` : ''}`
          : '本轮暂无满足前置条件的公开节点或可发现线索需要注入正文。';
      }
      const lastFull = window.WORLD_ENGINE_INJECT_INSPECTOR?.getLastFullPrompt?.();
      const orderLine = lastFull
        ? `上次正文三模块实际顺序：${(lastFull.order || []).map(item => item.label).join(' → ') || '均未注入'}（共 ${lastFull.promptLength || 0} 字）`
        : '尚未捕获上次正文生成；生成一次正文后可在“查看完整提示词与调度”中核对三模块全文与顺序。';
      previewDrawer = `<div class="we-outline-inject-preview">
        <div class="we-outline-section-head"><strong>正文注入实时预览</strong>${button('view-schedule', '查看完整提示词与调度')}</div>
        <p class="we-outline-hint">大纲以【剧情指导】柔性插入对话末端（system），只提供公开线索与方向，绝不直接剧透私密真相。</p>
        <p class="we-outline-hint">${h(orderLine)}</p>
        <pre>${h(guidanceText)}</pre>
      </div>`;
    }

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
          ${button('open-text', '整理文本')}
          ${button('edit-plan', draft.plan ? '继续草稿' : '全量编排')}
          ${button('toggle-injection-preview', draft.injectionPreviewOpen ? '收起注入预览' : '注入预览')}
          ${running ? button('abort', '停止', '', 'danger') : ''}
        </div>
      </div>
      ${previewDrawer}
    </div>`;
  }

  function renderOutlineNavList(draft) {
    const rows = [
      { view: 'tracks', label: '剧情', sub: '主线 · 支线 · 暗线跨章看板与随手增删改', poem: '草蛇灰线，伏脉千里' },
      { view: 'schedule', label: '注入', sub: '本轮哪些节点入选或被拦 · 上次正文完整提示词', poem: '运筹帷幄之中' },
      { view: 'facts', label: '线索', sub: '私密事实 · 可发现线索 · 接触与作者标记', poem: '明察秋毫，洞若观火' }
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

  function renderInlinePlanForm(editData) {
    return `<div class="we-outline-inline-editor">
      ${editorField('大纲标题', editData.title, 'data-outline-inline-field="title"')}
      ${editorField('故事梗概（作者视角）', editData.synopsis, 'data-outline-inline-field="synopsis"', true)}
      ${editorField('作者完整约束（仅后台与世界引擎可见）', editData.constraints, 'data-outline-inline-field="constraints"', true)}
      <details class="we-outline-adv-fold">
        <summary>正文公开覆盖（留空则不向正文透露作者梗概与暗线约束）</summary>
        <div class="we-outline-adv-body">
          ${editorField('正文可见梗概', editData.publicSynopsis, 'data-outline-inline-field="publicSynopsis"', true)}
          ${editorField('正文可见约束', editData.publicConstraints, 'data-outline-inline-field="publicConstraints"', true)}
        </div>
      </details>
      <div class="we-outline-actions we-outline-inline-actions">${button('quick-edit-cancel', '取消')}${button('quick-save-plan', '保存大纲信息', '', 'primary')}</div>
    </div>`;
  }

  function renderInlineChapterForm(editData, plan, isNew) {
    const nodeChoices = nodesOf(plan).map(node => [node.id, node.title || node.id]);
    return `<div class="we-outline-inline-editor">
      <div class="we-outline-section-head"><strong>${isNew ? '新增章节' : '编辑章节'}</strong></div>
      ${editorField('章节标题', editData.title, 'data-outline-inline-field="title"', false, '例如：第一章 初入长街')}
      ${editorField('章节目标', editData.goal, 'data-outline-inline-field="goal"', true, '本章主要推进哪段体验')}
      ${nodeChoices.length ? `<details class="we-outline-adv-fold"><summary>章末推进门槛（可选节点）</summary><div class="we-outline-adv-body">${choiceList('完成或跳过以下节点后自动推进到下一章', editData.exitNodeIds, nodeChoices, 'data-outline-inline-list="exitNodeIds"')}</div></details>` : ''}
      <div class="we-outline-actions we-outline-inline-actions">${button('quick-edit-cancel', '取消')}${button('quick-save-chapter', isNew ? '创建章节' : '保存章节', '', 'primary')}</div>
    </div>`;
  }

  function renderInlineTrackForm(editData, isNew) {
    return `<div class="we-outline-inline-editor">
      <div class="we-outline-section-head"><strong>${isNew ? '新增剧情线' : '编辑剧情线'}</strong></div>
      <div class="we-outline-form-grid">
        ${editorField('剧情线名称', editData.title, 'data-outline-inline-field="title"', false, '例如：王室密谋线')}
        ${selectControl('类型（决定默认公私属性）', editData.kind || 'side', 'data-outline-inline-field="kind"', Object.entries(TRACK_LABELS))}
      </div>
      ${editorField('长期目标', editData.goal, 'data-outline-inline-field="goal"', true)}
      <div class="we-outline-form-grid">
        <label class="we-outline-field"><span>调度优先级（越大越先出）</span><input type="number" data-outline-inline-field="priority" value="${h(editData.priority ?? 0)}"></label>
        <label class="we-outline-check we-outline-check-inline"><input type="checkbox" data-outline-inline-field="paused"${editData.paused ? ' checked' : ''}><span>暂停此线调度</span></label>
      </div>
      <div class="we-outline-actions we-outline-inline-actions">${button('quick-edit-cancel', '取消')}${button('quick-save-track', isNew ? '创建剧情线' : '保存剧情线', '', 'primary')}</div>
    </div>`;
  }

  function renderTrackBoardInner(current, draft, schedContext) {
    const tracks = tracksOf(current.plan);
    const addingTrack = !draft.editorOpen && draft.inlineEdit?.kind === 'track' && draft.inlineEdit.isNew;
    const addingNode = !draft.editorOpen && draft.inlineEdit?.kind === 'node' && draft.inlineEdit.isNew;
    const addingNodeHere = trackId => addingNode && draft.inlineEdit.data.trackId === trackId;
    const orphanAddingNode = addingNode && !tracks.some(t => t.id === draft.inlineEdit.data.trackId)
      ? `<div class="we-outline-node we-outline-node-new"><div class="we-outline-inline-editor">${renderNodeFormBody(draft.inlineEdit.data, current.plan, draft, draft.inlineEdit.showAdvanced, 'quick-save-node', 'quick-edit-cancel', '添加节点')}</div></div>`
      : '';

    return `${addingTrack ? renderInlineTrackForm(draft.inlineEdit.data, true) : ''}${orphanAddingNode}
      ${tracks.map((track, ti) => {
        const nodes = trackNodes(current.plan, track.id);
        const editingTrack = !draft.editorOpen && draft.inlineEdit?.kind === 'track' && !draft.inlineEdit.isNew && draft.inlineEdit.id === track.id;
        const confirmDel = draft.confirmDeleteTrackId === track.id;
        const otherTrack = tracks.find(t => t.id !== track.id && t.kind === 'main') || tracks.find(t => t.id !== track.id);
        return `<section class="we-section we-outline-track we-outline-track-${h(track.kind)}">
          <div class="we-outline-section-head">
            <div class="we-outline-track-title-row">
              <span class="we-outline-badge we-outline-badge-${h(track.kind)}">${h(TRACK_LABELS[track.kind] || track.kind)}</span>
              <h3>${h(track.title || '未命名剧情线')}</h3>
              <span class="we-outline-hint">优先级 ${h(track.priority ?? 0)}</span>
              ${track.paused ? '<span class="we-outline-badge">作者暂停</span>' : ''}
            </div>
            <div class="we-outline-track-ops">
              ${button('quick-add-node', '+ 节点', ` data-outline-track="${h(track.id)}"`)}
              ${button('track-pause', track.paused ? '继续此线' : '暂停此线', ` data-outline-track="${h(track.id)}"`)}
              ${iconButton('quick-track-up', 'fa-arrow-up', '上移剧情线', ` data-outline-ti="${ti}"${ti === 0 ? ' disabled' : ''}`)}
              ${iconButton('quick-track-down', 'fa-arrow-down', '下移剧情线', ` data-outline-ti="${ti}"${ti === tracks.length - 1 ? ' disabled' : ''}`)}
              ${iconButton('quick-edit-track', 'fa-pen', '编辑剧情线', ` data-outline-track="${h(track.id)}"`)}
              ${iconButton('quick-remove-track', 'fa-trash', '删除剧情线', ` data-outline-track="${h(track.id)}"`, true)}
            </div>
          </div>
          ${confirmDel ? `<div class="we-outline-confirm-bar">
            <span>此剧情线仍有 ${nodes.length} 个节点，请选择处理方式：</span>
            <div class="we-outline-actions">
              ${otherTrack ? button('quick-track-delete-move', `节点移至「${otherTrack.title || '主线'}」并删线`, ` data-outline-track="${h(track.id)}"`) : ''}
              ${button('quick-track-delete-all', `连同 ${nodes.length} 个节点一并删除`, ` data-outline-track="${h(track.id)}"`, 'danger')}
              ${button('quick-track-cancel-delete', '取消')}
            </div>
          </div>` : ''}
          ${editingTrack ? renderInlineTrackForm(draft.inlineEdit.data, false) : ''}
          ${track.goal ? `<p class="we-outline-goal">${h(track.goal)}</p>` : ''}
          ${track.paused ? '<p class="we-outline-message">此线已由作者暂停；恢复前不会进入调度。</p>' : ''}
          ${addingNodeHere(track.id) ? `<div class="we-outline-node we-outline-node-new"><div class="we-outline-inline-editor">${renderNodeFormBody(draft.inlineEdit.data, current.plan, draft, draft.inlineEdit.showAdvanced, 'quick-save-node', 'quick-edit-cancel', '添加节点')}</div></div>` : ''}
          ${nodes.map((node, index) => renderNodeCard(current, node, index, draft, schedContext)).join('') || (addingNodeHere(track.id) ? '' : '<p class="we-outline-empty">此线暂无节点，点击右上“+ 节点”即可随手添加。</p>')}
        </section>`;
      }).join('') || (addingTrack || orphanAddingNode ? '' : '<div class="we-outline-empty-box"><p class="we-outline-empty">尚未建立剧情线，可点击上方“+ 剧情线”新建，或使用“整理文本”一键生成。</p></div>')}`;
  }

  function renderStoryBoard(current, draft, schedContext, mode, sectionTitle, sectionMotto) {
    const plan = current.plan || {}, chapters = chaptersOf(plan), tracks = tracksOf(plan), allNodes = nodesOf(plan);
    if (draft.lastCurrentChapterId !== current.currentChapterId && draft.selectedChapterId === draft.lastCurrentChapterId) draft.selectedChapterId = '';
    draft.lastCurrentChapterId = current.currentChapterId;
    const selected = chapters.find(ch => ch.id === draft.selectedChapterId) || chapters.find(ch => ch.id === current.currentChapterId) || chapters[0];
    const selectedIndex = chapters.findIndex(ch => ch.id === selected?.id);
    const hasAnyContent = Boolean(clean(plan.title) || clean(plan.synopsis) || chapters.length || tracks.length || allNodes.length);

    const sidebar = chapters.map((chapter, index) => {
      const gates = chapter.exitNodeIds || chapterNodes(plan, chapter.id).filter(node => node.required !== false).map(node => node.id);
      const done = gates.filter(id => ['completed', 'skipped'].includes(nodeStatus(current, id))).length;
      const isCur = chapter.id === current.currentChapterId;
      return `<button type="button" class="we-outline-chapter${selected?.id === chapter.id ? ' is-selected' : ''}${isCur ? ' is-current' : ''}" data-outline-action="select-chapter" data-outline-chapter="${h(chapter.id)}"><span>${index + 1}. ${h(chapter.title || '未命名章节')}</span><small>${isCur ? '当前章 · ' : ''}门槛 ${done}/${gates.length}</small></button>`;
    }).join('');
    const nodes = selected ? chapterNodes(plan, selected.id) : [];
    const unchaptered = allNodes.filter(node => !Array.isArray(node.chapterIds) || !node.chapterIds.length);
    const editingPlan = !draft.editorOpen && draft.inlineEdit?.kind === 'plan';
    const addingChapter = !draft.editorOpen && draft.inlineEdit?.kind === 'chapter' && draft.inlineEdit.isNew;
    const editingChapter = !draft.editorOpen && draft.inlineEdit?.kind === 'chapter' && !draft.inlineEdit.isNew && draft.inlineEdit.id === selected?.id;
    const addingNodeInChapter = !draft.editorOpen && draft.inlineEdit?.kind === 'node' && draft.inlineEdit.isNew && mode === 'chapter';

    let boardBody = '';
    if (!hasAnyContent && !draft.inlineEdit) {
      boardBody = `<div class="we-outline-empty-box">
        <p class="we-outline-empty">暂无剧情大纲。大纲会在生成正文前注入柔和的【剧情指导】，帮 AI 稳定推进剧情又不剧透暗线。</p>
        <div class="we-outline-actions">${button('open-text', '导入文本由 AI 整理', '', 'primary')}${button('quick-add-chapter', '+ 新建章节')}${button('quick-add-node', '+ 新建节点')}</div>
      </div>`;
    } else if (mode === 'track') {
      boardBody = renderTrackBoardInner(current, draft, schedContext);
    } else {
      boardBody = `${addingChapter ? renderInlineChapterForm(draft.inlineEdit.data, plan, true) : ''}
        ${chapters.length ? `<nav class="we-outline-chapters" aria-label="章节列表">${sidebar}</nav>
          <div class="we-outline-chapter-detail">
            <div class="we-outline-section-head">
              <div class="we-outline-track-title-row">
                <h3>${h(selected?.title || '')}</h3>
                ${selected && selected.id !== current.currentChapterId ? button('set-current-chapter', '设为当前章', ` data-outline-chapter="${h(selected.id)}"`) : '<span class="we-outline-badge we-outline-badge-current">当前章</span>'}
              </div>
              <div class="we-outline-track-ops">
                ${button('quick-add-node', '+ 本章加节点', ` data-outline-chapter="${h(selected?.id || '')}"`)}
                ${iconButton('quick-chapter-up', 'fa-arrow-up', '前移章节', ` data-outline-ci="${selectedIndex}"${selectedIndex <= 0 ? ' disabled' : ''}`)}
                ${iconButton('quick-chapter-down', 'fa-arrow-down', '后移章节', ` data-outline-ci="${selectedIndex}"${selectedIndex < 0 || selectedIndex >= chapters.length - 1 ? ' disabled' : ''}`)}
                ${iconButton('quick-edit-chapter', 'fa-pen', '编辑章节', ` data-outline-chapter="${h(selected?.id || '')}"`)}
                ${iconButton('quick-remove-chapter', 'fa-trash', '删除章节', ` data-outline-chapter="${h(selected?.id || '')}"`, true)}
              </div>
            </div>
            ${editingChapter ? renderInlineChapterForm(draft.inlineEdit.data, plan, false) : ''}
            ${selected?.goal ? `<p class="we-outline-goal">章节目标：${h(selected.goal)}</p>` : ''}
            ${addingNodeInChapter ? `<div class="we-outline-node we-outline-node-new"><div class="we-outline-inline-editor">${renderNodeFormBody(draft.inlineEdit.data, plan, draft, draft.inlineEdit.showAdvanced, 'quick-save-node', 'quick-edit-cancel', '添加节点')}</div></div>` : ''}
            ${nodes.map((node, index) => renderNodeCard(current, node, index, draft, schedContext)).join('') || (addingNodeInChapter ? '' : '<p class="we-outline-empty">本章暂无节点，点上方“+ 本章加节点”即可创建；跨章节点可切至“按剧情线”查看。</p>')}
          </div>` : `${addingNodeInChapter ? `<div class="we-outline-node we-outline-node-new"><div class="we-outline-inline-editor">${renderNodeFormBody(draft.inlineEdit.data, plan, draft, draft.inlineEdit.showAdvanced, 'quick-save-node', 'quick-edit-cancel', '添加节点')}</div></div>` : ''}`}
        ${unchaptered.length ? `<div class="we-outline-unchaptered"><div class="we-outline-section-head"><strong>跨章常驻节点（未绑定特定章节）</strong></div>${unchaptered.map((node, idx) => renderNodeCard(current, node, idx, draft, schedContext)).join('')}</div>` : ''}`;
    }

    return `<section class="we-section we-outline-home-chapter">
      <div class="we-section-title we-outline-sec-title">${h(sectionTitle || '剧情看板')}<span class="we-section-motto">— ${h(sectionMotto || '章回多线，随增随改')}</span></div>
      <div class="we-outline-plan-heading">
        <div class="we-outline-section-head">
          <div class="we-outline-plan-title">${h(plan.title || '还没有剧情大纲')}</div>
          <div class="we-outline-node-ops">
            ${iconButton('quick-edit-plan', 'fa-pen', '编辑大纲标题与梗概')}
            ${hasAnyContent ? iconButton('clear-outline', 'fa-trash', '清空当前大纲', '', true) : ''}
          </div>
        </div>
        ${editingPlan ? renderInlinePlanForm(draft.inlineEdit.data) : `
          ${plan.synopsis ? `<details class="we-outline-plan-detail"><summary>作者梗概</summary><p>${h(plan.synopsis)}</p></details>` : ''}
          ${plan.constraints ? `<details class="we-outline-plan-detail"><summary>作者完整约束</summary><p>${h(planText(plan.constraints))}</p></details>` : ''}
        `}
      </div>
      <div class="we-outline-board-toolbar">
        <div class="we-outline-seg" role="group" aria-label="看板分组模式">
          <button type="button" class="we-outline-seg-btn${mode === 'chapter' ? ' is-active' : ''}" data-outline-action="board-mode-chapter">按章节</button>
          <button type="button" class="we-outline-seg-btn${mode === 'track' ? ' is-active' : ''}" data-outline-action="board-mode-track">按剧情线</button>
        </div>
        <div class="we-outline-actions">
          ${button('quick-add-chapter', '+ 章节')}
          ${button('quick-add-track', '+ 线')}
          ${button('quick-add-node', '+ 节点', '', 'primary')}
        </div>
      </div>
      ${boardBody}
    </section>`;
  }

  function renderCurrentPositionCard(current, draft, schedContext) {
    const plan = current.plan || {}, chapters = chaptersOf(plan), tracks = tracksOf(plan), allNodes = nodesOf(plan);
    if (draft.lastCurrentChapterId !== current.currentChapterId && draft.selectedChapterId === draft.lastCurrentChapterId) draft.selectedChapterId = '';
    draft.lastCurrentChapterId = current.currentChapterId;
    const hasAnyContent = Boolean(clean(plan.title) || clean(plan.synopsis) || chapters.length || tracks.length || allNodes.length);
    const curChapter = chapters.find(ch => ch.id === current.currentChapterId) || chapters[0] || null;
    const viewChapter = chapters.find(ch => ch.id === draft.selectedChapterId) || curChapter;
    const isPreviewingOther = Boolean(viewChapter && curChapter && viewChapter.id !== curChapter.id);

    if (!hasAnyContent) {
      return `<section class="we-section we-outline-pos-section">
        <div class="we-outline-section-head">
          <div class="we-section-title we-outline-sec-title" style="margin-bottom:0;border:none;padding:0;">当前位置<span class="we-section-motto">— 脉络所至，一目了然</span></div>
          <div class="we-outline-actions">${button('view-tracks', '进入剧情看板 →')}</div>
        </div>
        <div class="we-outline-empty-box">
          <p class="we-outline-empty">尚未建立剧情大纲。可点“整理文本”由 AI 拆解，或进入“剧情”页新建章节与剧情线。</p>
          <div class="we-outline-actions">${button('open-text', '整理文本导入', '', 'primary')}${button('view-tracks', '前往剧情看板')}</div>
        </div>
      </section>`;
    }

    const doneAll = allNodes.filter(node => ['completed', 'skipped'].includes(nodeStatus(current, node.id))).length;
    const viewIndex = viewChapter ? chapters.findIndex(ch => ch.id === viewChapter.id) : -1;
    const gates = viewChapter ? (viewChapter.exitNodeIds || chapterNodes(plan, viewChapter.id).filter(node => node.required !== false).map(node => node.id)) : [];
    const doneGates = gates.filter(id => ['completed', 'skipped'].includes(nodeStatus(current, id))).length;

    // 聚焦当前位置的节点：优先展示本轮拟注入节点 + 当前展示章内节点（只取核心前 5 条，保持首页紧凑）
    const seen = new Set(), focusNodes = [];
    const pushUnique = list => {
      for (const node of list) {
        if (node && !seen.has(node.id)) { seen.add(node.id); focusNodes.push(node); }
      }
    };
    const chNodes = viewChapter ? chapterNodes(plan, viewChapter.id) : allNodes;
    const activeChNodes = chNodes.filter(node => !['completed', 'skipped'].includes(nodeStatus(current, node.id)));
    if (!isPreviewingOther) pushUnique(schedContext.narrative?.selected || []);
    pushUnique(activeChNodes.length ? activeChNodes : chNodes);
    pushUnique(chNodes);
    const MAX_HOME_NODES = 5;
    const visibleNodes = focusNodes.slice(0, MAX_HOME_NODES);
    const omittedCount = Math.max(0, focusNodes.length - visibleNodes.length);

    const chapterLine = viewChapter
      ? `<div class="we-outline-pos-chapter">
          <div class="we-outline-track-title-row">
            <strong>${viewIndex >= 0 ? `第 ${viewIndex + 1}/${chapters.length} 章 · ` : ''}${h(viewChapter.title || '未命名章节')}</strong>
            ${isPreviewingOther
              ? `<span class="we-outline-badge">正在查看其它章</span>${button('select-chapter', '回到当前章', ` data-outline-chapter="${h(curChapter.id)}"`)}`
              : '<span class="we-outline-badge we-outline-badge-current">当前章</span>'}
            ${gates.length ? `<span class="we-outline-hint">推进门槛 ${doneGates}/${gates.length}</span>` : ''}
          </div>
          ${viewChapter.goal ? `<p class="we-outline-goal">${h(viewChapter.goal)}</p>` : ''}
        </div>`
      : `<div class="we-outline-pos-chapter"><strong>跨章自由推进中</strong></div>`;

    return `<section class="we-section we-outline-pos-section">
      <div class="we-outline-section-head">
        <div class="we-section-title we-outline-sec-title" style="margin-bottom:0;border:none;padding:0;">当前位置<span class="we-section-motto">— 脉络所至，一目了然</span></div>
        <div class="we-outline-actions">${button('view-tracks', '进入剧情看板 →')}</div>
      </div>
      ${plan.title ? `<div class="we-outline-pos-plan">《${h(plan.title)}》</div>` : ''}
      ${chapterLine}
      <div class="we-outline-pos-nodes">
        ${visibleNodes.map((node, index) => renderNodeCard(current, node, index, draft, schedContext)).join('') || '<p class="we-outline-empty">当前位置暂无待推进节点。</p>'}
        ${omittedCount > 0 ? `<p class="we-outline-hint">还有 ${omittedCount} 个节点已折叠，请在“剧情看板”查看与编排。</p>` : ''}
      </div>
      <div class="we-outline-pos-foot">全书共 ${chapters.length} 章 · ${tracks.length} 条剧情线 · 已完成 ${doneAll}/${allNodes.length} 个节点</div>
    </section>`;
  }

  function renderHome(current, draft, running, enabled) {
    const schedContext = { narrative: schedule('narrative'), world: schedule('world') };
    return `<div class="we-outline-home">
      ${renderOutlineCore(current, draft, running, enabled, schedContext.narrative)}
      ${renderOutlineNavList(draft)}
      ${renderCurrentPositionCard(current, draft, schedContext)}
      ${renderSuggestions(current)}
    </div>`;
  }

  function renderTracks(current, draft) {
    const uiDraft = draft || draftFor();
    const schedContext = { narrative: schedule('narrative'), world: schedule('world') };
    const mode = uiDraft.tracksBoardMode === 'chapter' ? 'chapter' : 'track';
    return `${subTopbar('跨章剧情线', VIEW_META.tracks.poem)}
      ${renderStoryBoard(current, uiDraft, schedContext, mode, '跨章剧情看板', '草蛇灰线，伏脉千里')}
      ${renderSuggestions(current)}`;
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
    const nodeChoices = nodesOf(plan).map(node => [node.id, node.title || node.id]);
    return `${subTopbar('全量编排大纲', '草蛇灰线', 'close-editor')}
      <section class="we-outline-editor">
        <p class="we-outline-hint">草稿支持收起后继续保留；确认保存才写入正式大纲。单个节点、章回修改可在主看板原地点击铅笔图标完成。</p>
        ${conflict}${renderValidation(plan)}
        <div class="we-section">
          <div class="we-section-title">基础信息</div>
          ${editorField('大纲标题', plan.title, 'data-outline-plan-field="title"')}
          ${editorField('作者梗概', plan.synopsis, 'data-outline-plan-field="synopsis"', true)}
          ${editorField('作者完整约束（仅后台）', plan.constraints, 'data-outline-plan-field="constraints"', true)}
          <details class="we-outline-adv-fold">
            <summary>正文公开覆盖（公开梗概 / 公开约束）</summary>
            <div class="we-outline-adv-body">
              ${editorField('正文可见梗概', plan.publicSynopsis, 'data-outline-plan-field="publicSynopsis"', true)}
              ${editorField('正文可见约束', plan.publicConstraints, 'data-outline-plan-field="publicConstraints"', true)}
            </div>
          </details>
        </div>
        <div class="we-section">
          <div class="we-section-title">章节节奏与章末门槛</div>
          ${chaptersOf(plan).map((chapter, ci) => `<section class="we-outline-edit-chapter"><div class="we-outline-section-head"><strong>第 ${ci + 1} 章 · ${h(chapter.title || '未命名')}</strong><div class="we-outline-actions">${button('chapter-up', '上移', ` data-outline-ci="${ci}"${ci === 0 ? ' disabled' : ''}`)}${button('chapter-down', '下移', ` data-outline-ci="${ci}"${ci === plan.chapters.length - 1 ? ' disabled' : ''}`)}${button('chapter-remove', '删除章节', ` data-outline-ci="${ci}"`, 'danger')}</div></div>${editorField('章节标题', chapter.title, `data-outline-chapter-field="title" data-outline-ci="${ci}"`)}${editorField('章节目标', chapter.goal, `data-outline-chapter-field="goal" data-outline-ci="${ci}"`, true)}<details class="we-outline-adv-fold"><summary>章末推进门槛</summary><div class="we-outline-adv-body">${choiceList('完成或跳过以下节点后推进下一章', chapter.exitNodeIds, nodeChoices, `data-outline-chapter-list="exitNodeIds" data-outline-ci="${ci}"`)}</div></details></section>`).join('')}
          ${button('chapter-add', '增加章节')}
        </div>
        <div class="we-section">
          <div class="we-section-title">剧情线</div>
          ${tracksOf(plan).map((track, ti) => {
            const count = trackNodes(plan, track.id).length;
            const confirmDel = draft.confirmBatchDeleteTrackId === track.id;
            const other = tracksOf(plan).find(t => t.id !== track.id && t.kind === 'main') || tracksOf(plan).find(t => t.id !== track.id);
            return `<section class="we-outline-edit-track"><div class="we-outline-section-head"><strong>${h(TRACK_LABELS[track.kind] || '剧情线')} ${ti + 1} · ${h(track.title || '未命名')}</strong><div class="we-outline-actions">${button('track-up', '上移', ` data-outline-ti="${ti}"`)}${button('track-down', '下移', ` data-outline-ti="${ti}"`)}${button('track-remove', '删除剧情线', ` data-outline-ti="${ti}"`, 'danger')}</div></div>
              ${confirmDel ? `<div class="we-outline-confirm-bar"><span>此线仍有 ${count} 个节点：</span><div class="we-outline-actions">${other ? button('track-remove-move', `节点移入「${other.title || '主线'}」并删线`, ` data-outline-ti="${ti}"`) : ''}${button('track-remove-delete-all', '连同节点一起删除', ` data-outline-ti="${ti}"`, 'danger')}${button('track-remove-cancel', '取消')}</div></div>` : ''}
              ${editorField('名称', track.title, `data-outline-track-field="title" data-outline-ti="${ti}"`)}${selectControl('类型', track.kind, `data-outline-track-field="kind" data-outline-ti="${ti}"`, Object.entries(TRACK_LABELS))}${editorField('目标', track.goal, `data-outline-track-field="goal" data-outline-ti="${ti}"`, true)}<div class="we-outline-form-grid"><label class="we-outline-field"><span>优先级（越大越先）</span><input type="number" data-outline-track-field="priority" data-outline-ti="${ti}" value="${h(track.priority ?? 0)}"></label><label class="we-outline-check we-outline-check-inline"><input type="checkbox" data-outline-track-field="paused" data-outline-ti="${ti}"${track.paused ? ' checked' : ''}><span>暂停此线</span></label></div>${button('node-add', '为此线增加节点', ` data-outline-track="${h(track.id)}"`)}</section>`;
          }).join('')}
          ${button('track-add', '增加剧情线')}
        </div>
        <div class="we-section">
          <div class="we-section-title">跨章节点（共 ${nodesOf(plan).length} 个，点标题展开）</div>
          ${nodesOf(plan).map((node, ni) => {
            const isOpen = Boolean(draft.expandedEditorNodes?.[node.id]);
            const advOpen = Boolean(draft.expandedEditorAdv?.[node.id]);
            return `<details class="we-outline-edit-node" data-outline-editor-nid="${h(node.id)}"${isOpen ? ' open' : ''}>
              <summary>${ni + 1}. ${h(node.title || '新节点')} <span class="we-outline-hint">${h(tracksOf(plan).find(t => t.id === node.trackId)?.title || '')}</span></summary>
              <div class="we-outline-actions" style="margin:6px 0;">${button('node-up', '上移', ` data-outline-nid="${h(node.id)}"`)}${button('node-down', '下移', ` data-outline-nid="${h(node.id)}"`)}${button('node-remove', '删除节点', ` data-outline-nid="${h(node.id)}"`, 'danger')}</div>
              ${renderNodeFormBody(node, plan, draft, advOpen, '', '', '')}
            </details>`;
          }).join('')}
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
        <div class="we-section-title">将大纲文本智能拆分为多线节点</div>
        <p class="we-outline-hint">支持粘贴自然语言大纲或导入 .txt / .md。AI 只做结构化拆分，不私自扩写剧情，整理结果需你确认后才覆盖生效。</p>
        <label class="we-outline-field"><span>粘贴主线、支线、暗线及章节安排，或选择文件</span><textarea id="we-outline-source-text" rows="9">${h(draft.sourceText)}</textarea></label>
        <input id="we-outline-text-file" type="file" accept=".txt,.md,text/plain,text/markdown">
        <div class="we-outline-actions">${button('organize-text', draft.busy ? '正在整理…' : 'AI整理并预览', draft.busy ? ' disabled' : '', 'primary')}${button('close-text', '收起（保留文本）')}</div>
      </section>
      ${draft.preview ? `<section class="we-section we-outline-preview">${renderPlanPreview(draft.preview)}<div class="we-outline-actions">${button('adopt-preview', '确认采用整理结果', '', 'primary')}${button('edit-preview', '先进入全量编排')}${button('discard-preview', '丢弃预览', '', 'danger')}</div></section>` : ''}`;
  }

  function renderArchiveBody(current, draft, options) {
    const collapsible = Boolean(options?.collapsible);
    let cc, status, snapshots = [];
    try { cc = cache(); status = cc?.getStatus?.(); snapshots = cc?.listSnapshots?.() || []; } catch (_) {}
    const hasPlan = Boolean(clean(current.plan?.title) || chaptersOf(current.plan).length || tracksOf(current.plan).length || nodesOf(current.plan).length);
    const snapshotBody = `<p class="we-outline-hint">${status ? `实时同步${status.syncEnabled ? '已开启' : '已关闭'} · 本地修订 ${h(status.localRev ?? 0)} / 聊天修订 ${h(status.liveRev ?? 0)} · ${snapshots.length} 份保存点` : '当前聊天存档接口尚未就绪。'}</p>
        <div class="we-outline-actions we-outline-snap-create"><input id="we-outline-snapshot-name" value="${h(draft.snapshotName)}" placeholder="保存点名称">${button('snapshot-create', '新建命名保存点', cc ? '' : ' disabled', 'primary')}</div>
        <div class="we-chatcache-list">${snapshots.map(snap => `<div class="we-snapshot-row">
          <div class="we-snapshot-main">
            <div class="we-snapshot-name"><span class="we-snapshot-badge${snap.auto ? ' is-auto' : ''}">${snap.auto ? '自动' : '手动'}</span>${h(snap.name || '未命名保存点')}</div>
            <div class="we-snapshot-meta">${h(snap.createdAt ? new Date(snap.createdAt).toLocaleString() : '')}</div>
          </div>
          <div class="we-snapshot-actions">${button('snapshot-restore', '恢复', ` data-outline-snapshot="${h(snap.id)}"`)}${button('snapshot-rename', '重命名', ` data-outline-snapshot="${h(snap.id)}"`)}${button('snapshot-export', '导出', ` data-outline-snapshot="${h(snap.id)}"`)}${button('snapshot-delete', '删除', ` data-outline-snapshot="${h(snap.id)}"`, 'danger')}</div>
        </div>`).join('') || '<div class="we-empty" style="padding:10px;">暂无剧情保存点</div>'}</div>
        <div class="we-input-group" style="margin-top:10px;margin-bottom:0;">
          <label>导入聊天保存点 JSON</label>
          <input id="we-outline-snapshot-file" type="file" accept=".json,application/json" style="width:100%;">
        </div>`;
    const dataBody = `<div class="we-outline-actions">
          ${button('export-plan', '导出作者计划 JSON')}
          ${button('export-full', '导出完整联动 JSON')}
          ${button('history-export', '导出联合历史')}
          ${hasPlan ? button('clear-outline', '清空当前大纲', '', 'danger') : ''}
        </div>
        <div class="we-input-group" style="margin-top:8px;margin-bottom:0;">
          <label>导入计划、剧情完整 JSON 或联合历史（先预览再写入）</label>
          <input id="we-outline-json-file" type="file" accept=".json,application/json" style="width:100%;">
          <div class="we-outline-field-hint">清空前会自动为你保存一份聊天快照以便后悔恢复；跨聊天导入会清除旧聊天的运行游标。</div>
        </div>`;
    const recoveryInner = `${renderQuarantineNotice()}${renderRecoveryDetails()}`;
    if (collapsible) {
      return settingsSection(draft, 'set-outline-snapshots', '聊天备份保存点', snapshotBody)
        + settingsSection(draft, 'set-outline-data', '剧情数据导入 / 导出', dataBody)
        + settingsSection(draft, 'set-outline-recovery', '联合历史恢复与审计', recoveryInner);
    }
    return `<section class="we-section we-outline-transfer">
        <div class="we-section-title">聊天备份保存点</div>
        ${snapshotBody}
      </section>
      <section class="we-section we-outline-transfer">
        <div class="we-section-title">剧情数据导入 / 导出</div>
        ${dataBody}
      </section>
      <section class="we-section">
        <details class="we-outline-adv-fold">
          <summary>联合历史恢复与审计（世界 / 记忆 / 剧情回退重建）</summary>
          <div class="we-outline-adv-body" style="margin-top:8px;">${recoveryInner}</div>
        </details>
      </section>`;
  }

  function renderSettings(current, draft) {
    const value = draft.settingsDraft || settings();
    const activeTab = OUTLINE_SETTINGS_TABS.some(t => t.key === draft.settingsTab) ? draft.settingsTab : 'common';
    draft.settingsTab = activeTab;
    const outlineVersion = window.OUTLINE_ENGINE_SETTINGS?.VERSION || '2.0.0';
    const runningLabel = engine()?.getRunningLabel?.() || (isRebuilding() ? '联合历史重建中' : draft.busy ? '剧情任务中' : '');
    const apiTimeoutMs = Number.isFinite(Number(value.apiTimeoutMs)) ? Number(value.apiTimeoutMs) : 120000;
    const idleTimeoutMs = Number.isFinite(Number(value.streamIdleTimeoutMs)) ? Number(value.streamIdleTimeoutMs) : 90000;
    const effortVal = String(value.reasoningEffort || '').trim().toLowerCase();
    const apiBody = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
        ${button('copy-world-api', '填入世界引擎地址/Key', '', '')}
      </div>
      ${settingSelect('连接方式', 'connectionMode', value.connectionMode || 'direct', [['direct', '直连（默认）'], ['proxy', '经酒馆代理（解决跨域 CORS）']], '连不上或控制台报 CORS 错误时，切到「经酒馆代理」由酒馆服务端转发。')}
      ${settingInput('剧情大纲 API URL（OpenAI 兼容）', 'apiUrl', value.apiUrl || '', { placeholder: 'https://api.openai.com/v1', hint: '填到「版本前缀」一级即可，/chat/completions 可加可不加。' })}
      ${settingInput('剧情大纲 API Key', 'apiKey', value.apiKey || '', { type: 'password' })}
      <div class="we-input-group" style="display:flex;gap:6px;align-items:end;">
        <div style="flex:1;">
          <label>模型</label>
          <input id="we-outline-model" data-outline-setting="model" type="text" value="${h(value.model || '')}" placeholder="模型名称" style="width:100%;">
        </div>
        ${button('fetch-models', draft.fetchingModels ? '获取中…' : '获取列表', ` id="we-outline-fetch-models"${draft.fetchingModels ? ' disabled' : ''} style="white-space:nowrap;flex-shrink:0;"`)}
        ${button('test-api', draft.testingApi ? '测试中…' : '测试请求', ` id="we-outline-test-api"${draft.testingApi ? ' disabled' : ''} style="white-space:nowrap;flex-shrink:0;"`)}
      </div>
      <div class="we-input-group">
        <select id="we-outline-model-list" style="${Array.isArray(draft.fetchedModels) && draft.fetchedModels.length ? '' : 'display:none;'}width:100%;margin-top:4px;"><option value="">-- 选择模型${Array.isArray(draft.fetchedModels) && draft.fetchedModels.length ? `（共 ${draft.fetchedModels.length} 个）` : ''} --</option>${(draft.fetchedModels || []).map(m => `<option value="${h(m)}"${String(value.model || '') === String(m) ? ' selected' : ''}>${h(m)}</option>`).join('')}</select>
      </div>
      ${draft.apiTestStatus ? `<div class="we-outline-field-hint" id="we-outline-api-test-status" style="margin-bottom:6px;${draft.apiTestError ? 'color:#f66;' : ''}">${h(draft.apiTestStatus)}</div>` : ''}
      <div class="we-input-group" style="display:flex;gap:6px;">
        ${settingCompactField('温度', 'temperature', value.temperature ?? 0.2, { type: 'number', min: 0, step: 0.1 })}
        ${settingCompactField('最大输出 token', 'maxTokens', value.maxTokens ?? 8192, { type: 'number', min: 1, step: 1 })}
      </div>
      ${settingInput('请求超时（秒）', 'apiTimeoutSeconds', Math.max(0, Math.round(apiTimeoutMs / 1000)), { type: 'number', min: 0, step: 1, hint: '超过该时间仍未收到完整响应会自动中止。0 = 不超时。' })}
      ${settingCheck('流式传输（stream）', 'stream', value.stream === true, '开启后按 SSE 流式增量接收响应，适合易等待超时或仅推荐流式的反代渠道。')}
      <details class="we-api-adv-fold">
        <summary>高级请求参数（流式空闲超时 / JSON 模式 / top_p / 推理力度）</summary>
        <div class="we-api-adv-body">
          ${settingInput('流式分片空闲超时（秒）', 'streamIdleTimeoutSeconds', Math.max(0, Math.round(idleTimeoutMs / 1000)), { type: 'number', min: 0, step: 1, hint: '开始收到流式数据后，超过该时间无新分片自动中止（不影响首字前的慢思考等待）；0 = 仅用总超时。' })}
          ${settingCheck('强制 JSON 输出（response_format）', 'jsonMode', value.jsonMode === true, '在支持 OpenAI JSON 模式的渠道附带 response_format: json_object；部分不支持该字段的反代若报 400 请关闭。')}
          <div class="we-input-group" style="display:flex;gap:6px;">
            <div style="flex:1;">
              <label>top_p（0–1，留空=默认）</label>
              <input id="we-outline-topP" data-outline-setting="topP" type="number" min="0" max="1" step="0.05" value="${value.topP == null ? '' : h(value.topP)}" placeholder="留空不传" style="width:100%;">
            </div>
            <div style="flex:1;">
              <label>推理力度（reasoning_effort）</label>
              <select id="we-outline-reasoningEffort" data-outline-setting="reasoningEffort" style="width:100%;">
                <option value=""${!effortVal ? ' selected' : ''}>默认（不传）</option>
                <option value="low"${effortVal === 'low' ? ' selected' : ''}>低（low）</option>
                <option value="medium"${effortVal === 'medium' ? ' selected' : ''}>中（medium）</option>
                <option value="high"${effortVal === 'high' ? ' selected' : ''}>高（high）</option>
              </select>
            </div>
          </div>
        </div>
      </details>`;

    const evolveBody = `
      ${settingCheck('启用剧情模块', 'engineEnabled', value.engineEnabled, '关闭后仅停用自动检查与正文注入，仍可随时新建、编辑或删除大纲，不影响世界引擎与记忆引擎。')}
      ${settingCheck('首楼为 AI 开场白', 'firstLayerIsAiOpening', value.firstLayerIsAiOpening !== false, '默认勾选：第 0 层不计入自动检查轮次与进度核对；取消勾选后，第 0 层按普通对话参与核对。')}
      ${settingCheck('自动检查新增正文', 'autoCheck', value.autoCheck !== false, '开启后每累积指定新增 AI 轮次自动调用 API 核对节点状态与线索揭露；关闭则仅手动触发。')}
      ${settingInput('每多少个新增轮次检查一次（X）', 'checkEveryX', value.checkEveryX ?? 3, { type: 'number', min: 1, step: 1, hint: '重 Roll 不计入新轮次。' })}
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${button('check-now', '立即检查正文', '', 'primary')}
      </div>
      <div class="we-hint" id="we-outline-task-status" style="margin-top:8px;">${runningLabel ? `正在进行${h(runningLabel)}` : '当前没有运行中的剧情任务'}</div>`;

    const injectBody = `
      ${settingCheck('注入正文指导', 'injectIntoPrompt', value.injectIntoPrompt !== false, '按当前章节焦点、主支暗线优先度与冷却轮次，挑选活跃节点与公开线索提示注入正文提示词。')}
      <div class="we-input-group" style="display:flex;gap:6px;">
        ${settingCompactField('正文每轮最多安排节点', 'narrativeLimit', value.narrativeLimit ?? 3, { type: 'number', min: 1, step: 1 })}
        ${settingCompactField('重复安排冷却轮次', 'cooldownTicks', value.cooldownTicks ?? 1, { type: 'number', min: 0, step: 1 })}
      </div>
      ${settingInput('注入目标字数预算', 'injectMaxChars', value.injectMaxChars ?? 2500, { type: 'number', min: 200, step: 100, hint: '限制注入正文的剧情指导篇幅，优先保留主线节点、当前章焦点与关键过渡门槛。' })}`;

    const bridgeSummary = window.STORY_ENGINE_BRIDGE?.getStatusSummary?.() || null;
    const effectiveCoordMode = (draft.coordinationMode === 'independent' || draft.coordinationMode === 'stagger-serial')
      ? draft.coordinationMode
      : (window.STORY_ENGINE_BRIDGE?.getCoordinationMode?.() || 'stagger-serial');
    const bridgeHint = bridgeSummary
      ? `当前已开启模块：${[bridgeSummary.worldEnabled && '世界', bridgeSummary.memoryEnabled && '记忆', bridgeSummary.outlineEnabled && '大纲'].filter(Boolean).join(' · ') || '无'} · 正文注入顺序：世界 → 记忆 → 大纲`
      : '未加载协同桥（当前处于严格独立模式；仍可预存配置，停用任一模块不影响其余模块工作）';
    const bridgeBody = `
      <div class="we-hint" style="margin-bottom:8px;">${h(bridgeHint)}</div>
      <div class="we-input-group">
        <label>同轮多模块 API 并发调度策略</label>
        <select id="we-outline-coordinationMode" style="width:100%;">
          <option value="stagger-serial"${effectiveCoordMode === 'stagger-serial' ? ' selected' : ''}>串行错峰管道（推荐 · 保护 Vertex 等并发受限渠道）</option>
          <option value="independent"${effectiveCoordMode === 'independent' ? ' selected' : ''}>各自独立并发（无排队，按各自原定时器直发）</option>
        </select>
        <div class="we-outline-field-hint">启用 ≥2 个自动后台引擎且选择串行错峰时，固定按“世界推演 → 大纲核对 → 记忆提取”先后错峰排队，单并发执行并复用前置最新公开结果；仅启用单个引擎时始终立即直通。三个模块共享此调度策略。</div>
      </div>`;
    const worldLinkBody = `
      ${settingCheck('提供指导给世界推演', 'injectIntoWorldEngine', value.injectIntoWorldEngine !== false, '开启后，世界后台推演会收到大纲提供的线索触发倾向、幕后布局与关键节点意图，辅助推演衔接；未揭露私密事实不会泄露给玩家角色。')}
      ${settingInput('后台每轮最多安排节点', 'worldLimit', value.worldLimit ?? 3, { type: 'number', min: 1, step: 1, hint: '限制每次交给世界引擎推演的剧情节点条数，避免挤占世界推演提示词空间。' })}
      ${settingCheck('在大纲核对与线索判定中使用世界公开状态', 'useWorldReference', value.useWorldReference !== false, '允许大纲后台核对参考世界公开摘要与大势，且线索条件可读取世界故事天数与事件账本（关闭后大纲完全脱离世界状态独立判定）。')}`;
    const memoryLinkBody = `
      ${settingCheck('向记忆引擎同步已核实线索与公开焦距', 'injectIntoMemoryEngine', value.injectIntoMemoryEngine !== false, '开启后，经正文逐字原文证据核实的新增线索接触（contacts）与揭露真相（reveals）会自动安全写入对应人物记忆，并向记忆提取提供公开章节焦点；未揭露私密事实始终隔离。')}
      ${settingCheck('在大纲核对与整理中参考记忆摘要与持续事实', 'useMemoryReference', value.useMemoryReference !== false, '开启后，整理与核对会参考记忆引擎中的人物别名、活跃持续事实、最新总述、近期纪要及人物弧光作为只读背景（不会作为正文原文完成证据）。')}`;

    const retryBody = settingInput('API 异常自动重试次数（X）', 'apiAutoRetries', value.apiAutoRetries ?? 0, { type: 'number', min: 0, step: 1, hint: '仅连接、HTTP、超时、空返回或 JSON 无法修补等故障才重试；正常解析为空变更不算错误。' });
    const proposalBody = settingCheck('允许 AI 提出结构调整建议', 'allowProposals', value.allowProposals !== false, '核对正文后若发现故事走向明显偏离预设计划，允许 AI 在建议区生成微调草案；所有建议需作者审阅确认后才会写入正式大纲。');
    const outlineTheme = getStoredOutlineTheme();
    const outlineThemeOptions = OUTLINE_THEMES.map(theme => `<option value="${theme.id}"${theme.id === outlineTheme ? ' selected' : ''}>${theme.name}</option>`).join('');
    const displayBody = `
      <div class="we-input-group">
        <label>剧情大纲主题配色</label>
        <select id="we-outline-theme-select" style="width:100%;">${outlineThemeOptions}</select>
        <div class="we-outline-field-hint">只影响剧情大纲面板并独立记忆；切回世界或记忆引擎时自动恢复对应模块自己的配色。</div>
      </div>`;

    const syncBody = `
      ${settingCheck('实时同步到酒馆聊天', 'syncToChat', value.syncToChat, '开启同步后，大纲计划与进度会随酒馆聊天保存；API Key 等全局设置不会写入聊天。')}
      ${settingCheck('自动备份', 'autoBackup', value.autoBackup, '关键节点推进、批量调整或覆盖导入前自动保留聊天恢复保存点。')}`;

    const debugSectionBody = `<button class="we-btn" type="button" data-outline-action="export-diag" style="width:100%;margin-bottom:8px;">导出诊断包</button><div id="we-outline-debug-render">${renderDebugContent()}</div>`;

    const aboutBody = `
      <div class="we-about-current"><span class="we-changelog-cur">剧情大纲 v${h(outlineVersion)}</span></div>
      <div class="we-section" style="margin-top:10px;">
        <div class="we-section-title">剧情大纲 ${h(outlineVersion)}</div>
        <div style="font-size:12px;color:var(--we-text2);line-height:1.7;">
          跨章节多线剧情引擎。主线、支线与暗线按前置条件、时间与剧情线索独立调度；幕后事实与正文公开线索分层投影，配合世界与记忆联合历史实现可回退、可审计的叙事推演。
        </div>
      </div>
      <div class="we-section" style="margin-top:10px;">
        <div class="we-section-title">v2.1.1 · 设置界面统一与三模块对称联动</div>
        <ul class="we-changelog-items">
          <li>设置页结构与视觉全面统一：API 连接并入「常用」，补齐「联动」「高级」选项卡，统一使用可折叠分区、竖排标准控件与底部常驻保存栏，并在「常用」补入「首楼为 AI 开场白」开关、「高级」补入独立主题配色切换。</li>
          <li>「联动」页升级为「三模块协同调度」「与世界引擎联动」「与记忆引擎联动」三张对称卡片：支持直接切换三模块共用的并发调度策略，并可独立开关参考世界公开状态、向记忆同步核实线索及参考记忆背景，断联后依然严格独立运行。</li>
        </ul>
      </div>
      <div class="we-section" style="margin-top:10px;">
        <div class="we-section-title">v2.1.0 · 界面精简与三模块协同联动</div>
        <ul class="we-changelog-items">
          <li>首页精简展示当前所处剧情位置，完整剧情看板收进纵轴「剧情」模块，存档与恢复整合进右上角设置。</li>
          <li>接入跨模块协同桥：整理与核对融入已激活世界/记忆模块的人物及势力别名参考；核对只读上下文补充记忆持续事实、最新总述、近期纪要与人物弧光。</li>
          <li>经逐字原文证据核实的新增线索接触（contacts）与揭露真相（reveals）可自动安全同步至对应人物主观记忆时间链；未揭露私密事实仍严密隔离。</li>
          <li>支持同轮多模块并发「串行错峰管道」，紧随世界推演之后核对正文，减少重复重查并对齐正文注入顺序（世界 → 记忆 → 大纲）。</li>
        </ul>
      </div>
      <div class="we-section" style="margin-top:10px;">
        <div class="we-section-title">v2.0.0 · 跨章多线调度与联合事实日志</div>
        <ul class="we-changelog-items">
          <li>章节与主线、支线、暗线解耦；新增私密事实、可发现线索、实际接触与知情分层投影及联合历史增量快照恢复。</li>
        </ul>
      </div>`;

    const panelContent = {
      common: settingsSection(draft, 'set-outline-api', '剧情大纲 API', apiBody)
        + settingsSection(draft, 'set-outline-evolve', '剧情检查与节奏', evolveBody)
        + settingsSection(draft, 'set-outline-inject', '剧情指导注入', injectBody),
      link: settingsSection(draft, 'set-outline-bridge', '三模块协同调度', bridgeBody)
        + settingsSection(draft, 'set-outline-world-link', '与世界引擎联动', worldLinkBody)
        + settingsSection(draft, 'set-outline-memory-link', '与记忆引擎联动', memoryLinkBody),
      advanced: settingsSection(draft, 'set-outline-retry', 'API 自动重试', retryBody)
        + settingsSection(draft, 'set-outline-proposals', 'AI 结构调整建议', proposalBody)
        + settingsSection(draft, 'set-outline-display', '界面显示', displayBody),
      archive: settingsSection(draft, 'set-outline-sync', '同步与缓存', syncBody)
        + renderArchiveBody(current, draft, { collapsible: true }),
      debug: settingsSection(draft, 'set-outline-debug', '剧情推演调试', debugSectionBody),
      about: aboutBody
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

    return `${subTopbar('设置', '', 'close-settings')}
      ${tabBar}${panels}
      <div class="we-settings-save-actions we-settings-save-sticky">
        ${button('save-settings', '保存设置')}
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
    return `${subTopbar('存档与恢复', VIEW_META.transfer.poem)}
      <div class="we-outline-intro-banner">此处集中管理当前聊天的快照保存点、大纲文件导入导出、联合历史回退重建与 API 调试包。</div>
      ${renderArchiveBody(current, draft)}
      <section class="we-section">
        <details class="we-outline-adv-fold">
          <summary>运行与注入调试（最近请求、响应及诊断包）</summary>
          <div class="we-outline-adv-body" style="margin-top:8px;">${renderDebugBody()}</div>
        </details>
      </section>`;
  }

  function renderLastPromptSummaryCard() {
    const sharedHtml = window.WORLD_ENGINE_UI?.renderLastPromptViewer?.({ focus: 'outline' });
    if (sharedHtml) {
      return `<section class="we-section we-outline-last-prompt">
        <div class="we-section-title">上次正文生成完整提示词（含三模块顺序）</div>
        <p class="we-outline-hint">世界、记忆、大纲三者均通过酒馆 position=1、depth=1（system）注入，按模块写入顺序排列（默认通常为 世界信息 → 记忆信息 → 剧情指导）。</p>
        ${sharedHtml}
      </section>`;
    }
    const full = window.WORLD_ENGINE_INJECT_INSPECTOR?.getLastFullPrompt?.();
    if (!full) return '';
    return `<section class="we-section we-outline-last-prompt">
      <div class="we-section-title">上次正文生成完整提示词</div>
      <p class="we-outline-hint">实际先后顺序：${h((full.order || []).map(item => item.label).join(' → ') || '本轮均未命中')}</p>
      <details><summary>展开上次完整提示词（${h(String(full.promptLength || 0))} 字）</summary><pre>${h(full.fullText || '')}</pre></details>
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
    return `${subTopbar('注入与调度', VIEW_META.schedule.poem)}
      <div class="we-outline-intro-banner">下方展示本轮每个节点为何入选或被条件拦截、即将注入的原文，以及最近一次发往正文模型的完整提示词与三大模块顺序。</div>
      ${renderLastPromptSummaryCard()}
      ${pane('narrative', '正文前台')}
      ${pane('world', '世界后台')}`;
  }

  function renderFacts(current, draft) {
    const valid = items => (items || []).filter(item => item.validity !== 'stale' && item.validity !== 'invalid');
    const facts = valid(current.privateFacts), clues = valid(current.clues), contacts = valid(current.contacts), knowledge = valid(current.knowledge);
    const edit = draft.inlineEdit;

    return `${subTopbar('线索与真相', VIEW_META.facts.poem)}
      <section class="we-outline-facts">
        <div class="we-outline-intro-banner">「私密事实」仅后台与作者可见；「可发现线索」开放后允许正文出现，只有人物实际看见/听到后才会记入「接触」与「知情」。可在此随时修正或删除。</div>
        <div class="we-section">
          <details open><summary>后台私密事实 ${facts.length} 条（作者可见）</summary>${facts.map(fact => {
            const editingFact = edit?.kind === 'fact' && edit.id === fact.id;
            return `<article class="we-outline-fact">
              <div class="we-outline-section-head">
                <small>事实 ${h(fact.id)} · 世界提交 ${h(fact.commitId || '手动')} · 已知人物 ${h((fact.knownBy || []).join(' / ') || '无')}</small>
                <div class="we-outline-node-ops">
                  ${iconButton('quick-edit-fact', 'fa-pen', '编辑私密事实', ` data-outline-fact="${h(fact.id)}"`)}
                  ${iconButton('quick-remove-fact', 'fa-trash', '删除私密事实', ` data-outline-fact="${h(fact.id)}"`, true)}
                </div>
              </div>
              ${editingFact
                ? `<div class="we-outline-inline-editor">${editorField('私密事实内容', edit.data.text, 'data-outline-inline-field="text"', true)}<div class="we-outline-actions">${button('quick-edit-cancel', '取消')}${button('quick-save-fact', '保存事实', '', 'primary')}</div></div>`
                : `<p>${h(fact.text)}</p>`}
            </article>`;
          }).join('') || '<p class="we-outline-empty">暂无已提交的后台事实；计划不计为事实。</p>'}</details>
        </div>
        <div class="we-section">
          <div class="we-outline-section-head" style="margin-bottom:4px;">
            <strong>可发现线索 ${clues.length} 条</strong>
            ${button('quick-add-clue', '+ 新增线索')}
          </div>
          ${edit?.kind === 'clue' && edit.isNew ? `<div class="we-outline-inline-editor">${editorField('线索公开提示（正文允许描述的内容）', edit.data.publicHint, 'data-outline-inline-field="publicHint"', true)}<label class="we-outline-check"><input type="checkbox" data-outline-inline-field="available"${edit.data.available ? ' checked' : ''}><span>立即开放发现（注入正文指导）</span></label><div class="we-outline-actions">${button('quick-edit-cancel', '取消')}${button('quick-save-clue', '添加线索', '', 'primary')}</div></div>` : ''}
          <details open><summary>查看全部线索</summary>${clues.map(clue => {
            const editingClue = edit?.kind === 'clue' && !edit.isNew && edit.id === clue.id;
            return `<article class="we-outline-fact">
              <div class="we-outline-section-head">
                <strong>${h(clue.publicHint || clue.id)}</strong>
                <div class="we-outline-node-ops">
                  ${button('toggle-clue-available', clue.available ? '暂停发现' : '开放发现', ` data-outline-clue="${h(clue.id)}"`)}
                  ${iconButton('quick-edit-clue', 'fa-pen', '编辑线索', ` data-outline-clue="${h(clue.id)}"`)}
                  ${iconButton('quick-remove-clue', 'fa-trash', '删除线索', ` data-outline-clue="${h(clue.id)}"`, true)}
                </div>
              </div>
              ${editingClue
                ? `<div class="we-outline-inline-editor">${editorField('线索公开提示', edit.data.publicHint, 'data-outline-inline-field="publicHint"', true)}<label class="we-outline-check"><input type="checkbox" data-outline-inline-field="available"${edit.data.available ? ' checked' : ''}><span>允许正文发现</span></label><div class="we-outline-actions">${button('quick-edit-cancel', '取消')}${button('quick-save-clue', '保存线索', '', 'primary')}</div></div>`
                : `<p>${clue.available ? '已满足发现条件（可发现）' : '尚未开放'} · ${h({ available: '待接触', contacted: '已接触', known: '已有知情记录' }[clue.status] || '等待')}</p><small>线索 ID ${h(clue.id)} · 接触者 ${h((clue.contacts || []).join(' / ') || '无')} · 知情者 ${h((clue.knownBy || []).join(' / ') || '无')}</small>`}
            </article>`;
          }).join('') || '<p class="we-outline-empty">暂无线索。</p>'}</details>
        </div>
        <div class="we-section">
          <details><summary>实际接触记录 ${contacts.length} 条</summary>${contacts.map(contact => `<blockquote><span>${h(contact.actorId)} 接触 ${h(contact.clueId)} · 正文 ${h(contact.messageId)}</span><p>${h(contact.quote)}</p></blockquote>`).join('') || '<p class="we-outline-empty">尚无正文确认的接触。</p>'}</details>
          <details><summary>人物知情记录 ${knowledge.length} 条</summary>${knowledge.map(item => `<p>${h(item.actorId)} 知道事实 ${h(item.factId)} <small>依据接触 ${h(item.contactId)}</small></p>`).join('') || '<p class="we-outline-empty">尚无已验证知情记录。</p>'}</details>
        </div>
        <div class="we-section">
          <div class="we-section-title">作者标记（手动开关，回退保留，可随手删除）</div>
          ${Object.entries(current.authorFlags || {}).map(([id, value]) => `<div class="we-outline-flag-row">
            <label class="we-outline-check"><input type="checkbox" data-outline-author-flag="${h(id)}"${value ? ' checked' : ''}><span>${h(id)}</span></label>
            ${iconButton('author-flag-remove', 'fa-trash', '删除此标记', ` data-outline-flag="${h(id)}"`, true)}
          </div>`).join('') || '<p class="we-outline-hint">暂无作者标记。</p>'}
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

  function renderDebugContent() {
    const debug = engine()?.getLastDebug?.() || {};
    let injection = null;
    try { injection = window.WORLD_ENGINE_INJECT_INSPECTOR?.getLastSnapshot?.('outline'); } catch (_) {}
    const sharedViewer = window.WORLD_ENGINE_UI?.renderLastPromptViewer?.({ focus: 'outline' }) || '';
    return `<p>运行状态：${h(engine()?.getRunningLabel?.() || (engine()?.isRunning?.() ? '运行中' : '空闲'))}</p>
      <p>最近错误：${h(engine()?.getLastError?.() || '无')}</p>
      <p>最终提示词注入：${h(injection?.status || '尚无记录')}</p>
      ${sharedViewer ? `<div style="margin-top:8px;">${sharedViewer}</div>` : ''}
      <details><summary>最近大纲后台请求</summary><pre>${h(debug.prompt || debug.requestPrompt || '暂无请求')}</pre></details>
      <details><summary>最近大纲后台响应</summary><pre>${h(debug.rawResult || debug.response || debug.apiResponse || '暂无响应')}</pre></details>
      ${injection ? `<details><summary>最近注入检查原始摘要</summary><pre>${h(JSON.stringify(injection, null, 2))}</pre></details>` : ''}`;
  }

  function renderDebugBody() {
    return `<section class="we-section we-outline-debug">
      <div class="we-section-title">剧情运行与注入调试</div>
      <div class="we-outline-actions">${button('export-diag', '导出剧情诊断包')}</div>
      ${renderDebugContent()}
    </section>`;
  }

  function renderDebug() {
    return `${subTopbar('剧情调试', VIEW_META.debug.poem)}${renderDebugBody()}`;
  }

  function render() {
    const draft = draftFor(), current = state(), running = draft.busy || Boolean(engine()?.isRunning?.()) || isRebuilding(), enabled = settings().engineEnabled === true;
    const views = {
      home: () => renderHome(current, draft, running, enabled),
      tracks: () => renderTracks(current, draft),
      schedule: () => renderScheduleView(current),
      facts: () => renderFacts(current, draft),
      recovery: () => renderRecovery(),
      transfer: () => renderTransfer(current, draft),
      debug: () => renderDebug()
    };
    const body = draft.settingsOpen
      ? renderSettings(current, draft)
      : draft.editorOpen
        ? renderEditor(draft)
        : draft.textOpen
          ? renderTextImport(draft)
          : (views[draft.view] || views.home)();
    let statusText = '剧情模块当前关闭；仍可编辑与保存计划，启用后才检查和注入。';
    if (enabled) {
      const injectPrompt = settings().injectIntoPrompt !== false;
      const selectedCount = (schedule('narrative').nodeIds || []).length;
      statusText = injectPrompt
        ? `剧情模块已启用 · 每 ${settings().checkEveryX ?? 3} 轮自动检查 · 本轮拟向正文注入 ${selectedCount} 个节点`
        : `剧情模块已启用 · 每 ${settings().checkEveryX ?? 3} 轮自动检查 · 正文注入已暂停`;
    }

    return `<div class="we-outline-root">
      <div class="we-outline-status-strip${enabled ? ' is-enabled' : ''}">${h(statusText)}</div>
      ${draft.message ? `<p role="status" class="we-outline-message${draft.error ? ' is-error' : ''}">${h(draft.message)}</p>` : ''}
      ${renderTemporalNotice(current)}
      ${renderImportReview(draft)}
      ${body}
    </div>`;
  }

  function commitReviewedPlan(plan, revision, snapshot) {
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
    draft.inlineEdit = null;
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
    else if (element.id === 'we-outline-model-list') {
      if (!draft.settingsDraft) draft.settingsDraft = clone(settings());
      if (element.value) {
        draft.settingsDraft.model = element.value;
        const modelInput = typeof document !== 'undefined' ? document.getElementById('we-outline-model') : null;
        if (modelInput) modelInput.value = element.value;
      }
    }
    else if (element.id === 'we-outline-coordinationMode') {
      draft.coordinationMode = element.value === 'independent' ? 'independent' : 'stagger-serial';
    }
    else if (element.id === 'we-outline-import-progress' && draft.pendingJson) draft.pendingJson.includeProgress = element.checked;
    else if (ds.outlineSetting) {
      if (!draft.settingsDraft) draft.settingsDraft = clone(settings());
      const name = ds.outlineSetting;
      if (name === 'topP') {
        const raw = String(element.value ?? '').trim();
        draft.settingsDraft.topP = raw === '' ? null : (Number.isFinite(Number(raw)) ? Math.max(0, Math.min(1, Number(raw))) : null);
        return;
      }
      let value = element.type === 'checkbox' ? element.checked : element.value;
      if (element.type === 'number') {
        value = Number(element.value);
        if (!Number.isFinite(value)) return;
      }
      if (name === 'apiTimeoutSeconds') draft.settingsDraft.apiTimeoutMs = Math.max(0, Math.round(value * 1000));
      else if (name === 'streamIdleTimeoutSeconds') draft.settingsDraft.streamIdleTimeoutMs = Math.max(0, Math.round(value * 1000));
      else draft.settingsDraft[name] = value;
    } else if (ds.outlineInlineField && draft.inlineEdit?.data) {
      const name = ds.outlineInlineField;
      draft.inlineEdit.data[name] = element.type === 'checkbox' ? element.checked : element.type === 'number' ? Number(element.value) : element.value;
    } else if (ds.outlineInlineList && draft.inlineEdit?.data) {
      draft.inlineEdit.data[ds.outlineInlineList] = toggleChoice(draft.inlineEdit.data[ds.outlineInlineList], element.value, element.checked);
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
      if (!draft.editorOpen && draft.inlineEdit?.kind === 'node') {
        if (!draft.inlineEdit.entityPicks) draft.inlineEdit.entityPicks = {};
        draft.inlineEdit.entityPicks[ds.outlineNid] = element.value;
      } else {
        if (!draft.entityPicks) draft.entityPicks = {};
        draft.entityPicks[ds.outlineNid] = element.value;
      }
    } else if (ds.outlineNodeField) {
      const node = findDraftNode(draft, ds), planCtx = editingPlanContext(draft);
      if (node) {
        node[ds.outlineNodeField] = element.type === 'checkbox' ? element.checked : element.value;
        if (ds.outlineNodeField === 'trackId' && tracksOf(planCtx).find(track => track.id === element.value)?.kind === 'hidden') node.visibility = 'private';
      }
    }
  }

  function download(value, name) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function handleAction(action, element) {
    const draft = draftFor(), ds = element?.dataset || {}, current = state();
    const ci = Number(ds.outlineCi);
    if (['home', 'tracks', 'schedule', 'facts', 'recovery', 'transfer', 'debug'].some(view => action === 'view-' + view)) {
      const nextView = action.slice(5);
      draft.view = nextView;
      if (nextView === 'tracks' && !draft.tracksBoardMode) draft.tracksBoardMode = 'track';
      draft.selectedNavView = null;
      draft.settingsOpen = false;
      draft.editorOpen = false;
      draft.textOpen = false;
      draft.inlineEdit = null;
      draft.confirmDeleteTrackId = null;
    }
    else if (action === 'toggle-settings') { draft.settingsOpen = !draft.settingsOpen; if (draft.settingsOpen) { draft.editorOpen = false; draft.textOpen = false; draft.inlineEdit = null; draft.coordinationMode = window.STORY_ENGINE_BRIDGE?.getCoordinationMode?.() || null; } if (!draft.settingsDraft) draft.settingsDraft = clone(settings()); }
    else if (action === 'close-settings') draft.settingsOpen = false;
    else if (action === 'toggle-injection-preview') draft.injectionPreviewOpen = !draft.injectionPreviewOpen;
    else if (action === 'board-mode-chapter') { if (draft.view !== 'tracks') draft.view = 'tracks'; draft.tracksBoardMode = 'chapter'; draft.inlineEdit = null; draft.confirmDeleteTrackId = null; }
    else if (action === 'board-mode-track') { if (draft.view !== 'tracks') draft.view = 'tracks'; draft.tracksBoardMode = 'track'; draft.inlineEdit = null; draft.confirmDeleteTrackId = null; }
    else if (action === 'toggle-node') { draft.expandedNodes[ds.outlineNid] = !draft.expandedNodes[ds.outlineNid]; }
    else if (action === 'toggle-adv-fold') {
      if (draft.inlineEdit?.kind === 'node' && draft.inlineEdit.data?.id === ds.outlineNid) draft.inlineEdit.showAdvanced = !draft.inlineEdit.showAdvanced;
      else if (draft.editorOpen && ds.outlineNid) draft.expandedEditorAdv[ds.outlineNid] = !draft.expandedEditorAdv[ds.outlineNid];
      return; // 原生 <details> 自行展开，状态同步后不强制重绘以免丢失焦点
    }
    else if (action === 'quick-edit-cancel') { draft.inlineEdit = null; draft.confirmDeleteTrackId = null; }
    else if (action === 'quick-edit-plan') {
      if (!canCommitSavedPlan(draft)) return;
      if (draft.view === 'home') draft.view = 'tracks';
      const p = current.plan || {};
      draft.inlineEdit = { kind: 'plan', id: 'plan', isNew: false, data: { title: p.title || '', synopsis: p.synopsis || '', constraints: p.constraints || '', publicSynopsis: p.publicSynopsis || '', publicConstraints: p.publicConstraints || '' } };
    }
    else if (action === 'quick-save-plan') {
      const ed = draft.inlineEdit?.kind === 'plan' ? draft.inlineEdit.data : null;
      if (!ed) return;
      commitSavedPlan(draft, next => {
        next.title = clean(ed.title);
        next.synopsis = String(ed.synopsis || '');
        next.constraints = String(ed.constraints || '');
        next.publicSynopsis = String(ed.publicSynopsis || '');
        next.publicConstraints = String(ed.publicConstraints || '');
      }, '大纲基础信息已更新。');
    }
    else if (action === 'quick-add-chapter') {
      if (!canCommitSavedPlan(draft)) return;
      if (draft.view === 'home') draft.view = 'tracks';
      draft.tracksBoardMode = 'chapter';
      const cid = uid('chapter');
      draft.inlineEdit = { kind: 'chapter', id: cid, isNew: true, data: { id: cid, title: `第 ${chaptersOf(current.plan).length + 1} 章`, goal: '', exitNodeIds: [] } };
    }
    else if (action === 'quick-edit-chapter') {
      if (!canCommitSavedPlan(draft)) return;
      const ch = chaptersOf(current.plan).find(c => c.id === ds.outlineChapter);
      if (!ch) throw new Error('章节已不存在。');
      draft.inlineEdit = { kind: 'chapter', id: ch.id, isNew: false, data: clone(ch) };
    }
    else if (action === 'quick-save-chapter') {
      const edit = draft.inlineEdit;
      if (edit?.kind !== 'chapter') return;
      const title = clean(edit.data.title) || '新章节';
      commitSavedPlan(draft, next => {
        if (!Array.isArray(next.chapters)) next.chapters = [];
        const payload = { id: edit.data.id || edit.id, title, goal: String(edit.data.goal || ''), exitNodeIds: [...(edit.data.exitNodeIds || [])] };
        if (edit.isNew) {
          next.chapters.push(payload);
          draft.selectedChapterId = payload.id;
        } else {
          const idx = next.chapters.findIndex(c => c.id === edit.id);
          if (idx < 0) throw new Error('目标章节已不存在。');
          next.chapters[idx] = payload;
        }
      }, edit.isNew ? '已新增章节。' : '章节已保存。');
    }
    else if (action === 'quick-remove-chapter') {
      const ch = chaptersOf(current.plan).find(c => c.id === ds.outlineChapter);
      if (!ch) throw new Error('章节已不存在。');
      if (!window.confirm || window.confirm(`确定删除章节「${ch.title || '未命名章节'}」？（相关节点不会删除，仅解除与本章关联）`)) {
        commitSavedPlan(draft, next => {
          next.chapters = chaptersOf(next).filter(c => c.id !== ch.id);
          for (const n of nodesOf(next)) if (Array.isArray(n.chapterIds)) n.chapterIds = n.chapterIds.filter(id => id !== ch.id);
        }, '章节已删除，原有节点保留为跨章节点。');
        if (draft.selectedChapterId === ch.id) draft.selectedChapterId = '';
      }
    }
    else if (action === 'quick-chapter-up' || action === 'quick-chapter-down') {
      commitSavedPlan(draft, next => reorder(next.chapters, ci, action.endsWith('up') ? -1 : 1), '章节顺序已调整。');
    }
    else if (action === 'quick-add-track') {
      if (!canCommitSavedPlan(draft)) return;
      if (draft.view === 'home') draft.view = 'tracks';
      draft.tracksBoardMode = 'track';
      const tid = uid('track');
      draft.inlineEdit = { kind: 'track', id: tid, isNew: true, data: { id: tid, kind: tracksOf(current.plan).length ? 'side' : 'main', title: '', goal: '', priority: 0, paused: false } };
    }
    else if (action === 'quick-edit-track') {
      if (!canCommitSavedPlan(draft)) return;
      const track = tracksOf(current.plan).find(t => t.id === ds.outlineTrack);
      if (!track) throw new Error('剧情线已不存在。');
      draft.confirmDeleteTrackId = null;
      draft.inlineEdit = { kind: 'track', id: track.id, isNew: false, data: clone(track) };
    }
    else if (action === 'quick-save-track') {
      const edit = draft.inlineEdit;
      if (edit?.kind !== 'track') return;
      if (!clean(edit.data.title)) throw new Error('请输入剧情线名称。');
      commitSavedPlan(draft, next => {
        if (!Array.isArray(next.tracks)) next.tracks = [];
        const payload = { id: edit.data.id || edit.id, kind: ['main', 'side', 'hidden'].includes(edit.data.kind) ? edit.data.kind : 'side', title: clean(edit.data.title), goal: String(edit.data.goal || ''), priority: Number(edit.data.priority) || 0, paused: Boolean(edit.data.paused) };
        if (edit.isNew) next.tracks.push(payload);
        else {
          const idx = next.tracks.findIndex(t => t.id === edit.id);
          if (idx < 0) throw new Error('剧情线已不存在。');
          next.tracks[idx] = payload;
          if (payload.kind === 'hidden') trackNodes(next, payload.id).forEach(n => { n.visibility = 'private'; });
        }
      }, edit.isNew ? '已新增剧情线。' : '剧情线已保存。');
    }
    else if (action === 'quick-track-up' || action === 'quick-track-down') {
      commitSavedPlan(draft, next => reorder(next.tracks, Number(ds.outlineTi), action.endsWith('up') ? -1 : 1), '剧情线顺序已调整。');
    }
    else if (action === 'quick-remove-track') {
      const track = tracksOf(current.plan).find(t => t.id === ds.outlineTrack);
      if (!track) throw new Error('剧情线已不存在。');
      const peers = trackNodes(current.plan, track.id);
      if (!peers.length) {
        if (!window.confirm || window.confirm(`确定删除剧情线「${track.title || '未命名剧情线'}」？`)) {
          commitSavedPlan(draft, next => removeTrackFromPlan(next, track.id), '剧情线已删除。');
        }
      } else {
        draft.inlineEdit = null;
        draft.confirmDeleteTrackId = draft.confirmDeleteTrackId === track.id ? null : track.id;
      }
    }
    else if (action === 'quick-track-cancel-delete') { draft.confirmDeleteTrackId = null; }
    else if (action === 'quick-track-delete-all') {
      commitSavedPlan(draft, next => removeTrackFromPlan(next, ds.outlineTrack, 'delete-nodes'), '已连同线内节点删除剧情线。');
    }
    else if (action === 'quick-track-delete-move') {
      commitSavedPlan(draft, next => removeTrackFromPlan(next, ds.outlineTrack, 'move-nodes'), '剧情线已删除，节点已移入保留线。');
    }
    else if (action === 'quick-add-node') {
      if (!canCommitSavedPlan(draft)) return;
      if (draft.view === 'home') draft.view = 'tracks';
      const plan = current.plan || {}, chs = chaptersOf(plan);
      const track = tracksOf(plan).find(t => t.id === ds.outlineTrack) || tracksOf(plan)[0] || { id: 'main', kind: 'main' };
      const resolvedChapterId = chs.find(c => c.id === draft.selectedChapterId)?.id || chs.find(c => c.id === current.currentChapterId)?.id || chs[0]?.id || '';
      const chId = ds.outlineChapter || resolvedChapterId;
      const activeMode = draft.tracksBoardMode || 'track';
      const node = blankNodeFor(track, activeMode === 'track' && !ds.outlineChapter ? '' : chId);
      draft.confirmDeleteTrackId = null;
      draft.inlineEdit = { kind: 'node', id: node.id, isNew: true, showAdvanced: false, data: node, entityPicks: {} };
    }
    else if (action === 'quick-edit-node') {
      if (!canCommitSavedPlan(draft)) return;
      const node = nodesOf(current.plan).find(n => n.id === ds.outlineNid);
      if (!node) throw new Error('节点已不存在。');
      draft.expandedNodes[node.id] = true;
      draft.inlineEdit = { kind: 'node', id: node.id, isNew: false, showAdvanced: false, data: clone(node), entityPicks: {} };
    }
    else if (action === 'quick-save-node') {
      const edit = draft.inlineEdit;
      if (edit?.kind !== 'node') return;
      if (!clean(edit.data.title)) throw new Error('请输入节点标题。');
      const savedId = edit.data.id;
      commitSavedPlan(draft, next => {
        if (!Array.isArray(next.tracks) || !next.tracks.length) next.tracks = [{ id: edit.data.trackId || 'main', kind: 'main', title: '主线', goal: '', priority: 0, paused: false }];
        if (!next.tracks.some(t => t.id === edit.data.trackId)) edit.data.trackId = next.tracks[0].id;
        if (!Array.isArray(next.nodes)) next.nodes = [];
        const payload = clone(edit.data);
        payload.title = clean(payload.title);
        if (edit.isNew) next.nodes.push(payload);
        else {
          const idx = next.nodes.findIndex(n => n.id === edit.id);
          if (idx < 0) throw new Error('目标节点已不存在。');
          next.nodes[idx] = payload;
        }
      }, edit.isNew ? '节点已添加。' : '节点已保存。');
      if (edit.isNew && savedId) draft.expandedNodes[savedId] = false;
    }
    else if (action === 'quick-remove-node') {
      const node = nodesOf(current.plan).find(n => n.id === ds.outlineNid);
      if (!node) throw new Error('节点已不存在。');
      const usage = nodeUsageSummary(current.plan, node.id);
      const msg = usage.hasRefs
        ? `节点「${node.title || '未命名节点'}」正被 ${usage.depCount} 个前置依赖、${usage.exitCount} 个章末门槛引用。\n删除将自动解除这些引用，确定删除？`
        : `确定删除节点「${node.title || '未命名节点'}」？`;
      if (!window.confirm || window.confirm(msg)) {
        commitSavedPlan(draft, next => removeNodeFromPlan(next, node.id), usage.hasRefs ? '节点及关联引用已一并删除。' : '节点已删除。');
      }
    }
    else if (action === 'clear-outline') {
      const msg = '确定清空当前聊天的大纲计划？（清空前会自动生成一个恢复保存点，清空后所有章节、剧情线和节点均移除）';
      if (!window.confirm || window.confirm(msg)) {
        if (canCommitSavedPlan(draft)) {
          try { cache()?.createSnapshot?.('清空大纲前自动备份'); } catch (_) {}
          engine()?.abort?.();
          data().commitPlan({ title: '', synopsis: '', constraints: '', publicSynopsis: '', publicConstraints: '', chapters: [], tracks: [], nodes: [] }, current.revision);
          draft.inlineEdit = null; draft.confirmDeleteTrackId = null; draft.selectedChapterId = '';
          engine()?.applyInjection?.();
          notify('已清空当前大纲（已创建恢复备份点）。');
        }
      }
    }
    else if (action === 'quick-edit-fact') {
      const fact = (current.privateFacts || []).find(f => f.id === ds.outlineFact);
      if (!fact) throw new Error('该后台事实已不存在。');
      draft.inlineEdit = { kind: 'fact', id: fact.id, isNew: false, data: { text: fact.text || '' } };
    }
    else if (action === 'quick-save-fact') {
      const edit = draft.inlineEdit;
      if (edit?.kind !== 'fact') return;
      if (!clean(edit.data.text)) throw new Error('事实内容不能为空。');
      engine()?.abort?.();
      const next = state(), target = (next.privateFacts || []).find(f => f.id === edit.id);
      if (!target) throw new Error('该后台事实已不存在。');
      target.text = clean(edit.data.text);
      data().saveState(next); draft.inlineEdit = null; engine()?.applyInjection?.(); notify('后台事实已更新。');
    }
    else if (action === 'quick-remove-fact') {
      if (!window.confirm || window.confirm('确定删除这条后台私密事实？')) {
        engine()?.abort?.();
        const next = state();
        next.privateFacts = (next.privateFacts || []).filter(f => f.id !== ds.outlineFact);
        data().saveState(next);
        if (draft.inlineEdit?.kind === 'fact' && draft.inlineEdit.id === ds.outlineFact) draft.inlineEdit = null;
        engine()?.applyInjection?.(); notify('已删除该条后台事实。');
      }
    }
    else if (action === 'quick-add-clue') {
      draft.inlineEdit = { kind: 'clue', id: uid('clue'), isNew: true, data: { publicHint: '', available: true } };
    }
    else if (action === 'quick-edit-clue') {
      const clue = (current.clues || []).find(c => c.id === ds.outlineClue);
      if (!clue) throw new Error('该线索已不存在。');
      draft.inlineEdit = { kind: 'clue', id: clue.id, isNew: false, data: { publicHint: clue.publicHint || '', available: Boolean(clue.available) } };
    }
    else if (action === 'quick-save-clue') {
      const edit = draft.inlineEdit;
      if (edit?.kind !== 'clue') return;
      if (!clean(edit.data.publicHint)) throw new Error('请输入线索提示文本。');
      engine()?.abort?.();
      const next = state();
      if (!Array.isArray(next.clues)) next.clues = [];
      if (edit.isNew) {
        next.clues.push({ id: edit.id, publicHint: clean(edit.data.publicHint), available: Boolean(edit.data.available), status: 'available', validity: 'valid' });
      } else {
        const clue = next.clues.find(c => c.id === edit.id);
        if (!clue) throw new Error('线索已不存在。');
        clue.publicHint = clean(edit.data.publicHint);
        clue.available = Boolean(edit.data.available);
      }
      data().saveState(next); draft.inlineEdit = null; engine()?.applyInjection?.(); notify(edit.isNew ? '已新增线索。' : '线索已更新。');
    }
    else if (action === 'toggle-clue-available') {
      engine()?.abort?.();
      const next = state(), clue = (next.clues || []).find(c => c.id === ds.outlineClue);
      if (!clue) throw new Error('线索已不存在。');
      clue.available = !clue.available;
      data().saveState(next); engine()?.applyInjection?.(); notify(clue.available ? '已开放此线索。' : '已暂停此线索。');
    }
    else if (action === 'quick-remove-clue') {
      if (!window.confirm || window.confirm('确定删除这条线索？')) {
        engine()?.abort?.();
        const next = state();
        next.clues = (next.clues || []).filter(c => c.id !== ds.outlineClue);
        next.contacts = (next.contacts || []).filter(c => c.clueId !== ds.outlineClue);
        data().saveState(next);
        if (draft.inlineEdit?.kind === 'clue' && draft.inlineEdit.id === ds.outlineClue) draft.inlineEdit = null;
        engine()?.applyInjection?.(); notify('线索已删除。');
      }
    }
    else if (action === 'author-flag-remove') {
      engine()?.abort?.();
      const next = state();
      if (next.authorFlags) delete next.authorFlags[ds.outlineFlag];
      data().saveState(next); engine()?.applyInjection?.(); notify(`已删除作者标记「${ds.outlineFlag}」。`);
    }
    else if (action === 'edit-plan') startEditor();
    else if (action === 'close-editor') draft.editorOpen = false;
    else if (action === 'rebase-editor') { draft.expectedRevision = current.revision; draft.expectedPlanSnapshot = JSON.stringify(current.plan); draft.message = '已保留草稿并采用当前大纲作为保存基底。'; draft.error = false; }
    else if (action === 'discard-editor') { if (!window.confirm || window.confirm('放弃当前未保存的大纲草稿？')) { draft.editorOpen = false; draft.plan = null; draft.confirmBatchDeleteTrackId = null; } }
    else if (action === 'open-text') { draft.textOpen = true; draft.editorOpen = false; draft.settingsOpen = false; draft.inlineEdit = null; }
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
      if (trackNodes(draft.plan, track.id).length) {
        draft.confirmBatchDeleteTrackId = draft.confirmBatchDeleteTrackId === track.id ? null : track.id;
      } else {
        draft.plan.tracks.splice(Number(ds.outlineTi), 1);
      }
    }
    else if (action === 'track-remove-cancel') { draft.confirmBatchDeleteTrackId = null; }
    else if (action === 'track-remove-delete-all') {
      const track = draft.plan.tracks[Number(ds.outlineTi)];
      if (track) removeTrackFromPlan(draft.plan, track.id, 'delete-nodes');
      draft.confirmBatchDeleteTrackId = null;
    }
    else if (action === 'track-remove-move') {
      const track = draft.plan.tracks[Number(ds.outlineTi)];
      if (track) removeTrackFromPlan(draft.plan, track.id, 'move-nodes');
      draft.confirmBatchDeleteTrackId = null;
    }
    else if (action === 'track-pause') {
      if (!canCommitSavedPlan(draft)) return;
      const plan = clone(current.plan), track = tracksOf(plan).find(item => item.id === ds.outlineTrack);
      if (!track) throw new Error('剧情线已不存在。');
      track.paused = !track.paused; engine()?.abort?.(); data().commitPlan(plan, current.revision); engine()?.applyInjection?.();
    } else if (action === 'node-add') {
      if (!draft.plan.nodes) draft.plan.nodes = [];
      if (!tracksOf(draft.plan).length) draft.plan.tracks = [{ id: uid('track'), kind: 'main', title: '主线', goal: '', priority: 0, paused: false }];
      const track = tracksOf(draft.plan).find(item => item.id === ds.outlineTrack) || tracksOf(draft.plan)[0];
      const added = blankNodeFor(track, '');
      added.title = '新节点';
      draft.plan.nodes.push(added);
      draft.expandedEditorNodes[added.id] = true;
    } else if (action === 'node-remove') {
      const node = findDraftNode(draft, ds);
      if (!node) throw new Error('节点已不存在。');
      const usage = nodeUsageSummary(draft.plan, node.id);
      if (!usage.hasRefs || !window.confirm || window.confirm(`节点正被 ${usage.depCount} 个前置依赖与 ${usage.exitCount} 个章末门槛引用，删除将一并解除引用，确定删除？`)) {
        removeNodeFromPlan(draft.plan, node.id);
        delete draft.expandedEditorNodes[node.id];
      }
    } else if (action === 'node-up' || action === 'node-down') {
      const node = findDraftNode(draft, ds), peers = trackNodes(draft.plan, node.trackId), index = peers.findIndex(item => item.id === node.id), other = peers[index + (action.endsWith('up') ? -1 : 1)];
      if (other) { const a = draft.plan.nodes.findIndex(item => item.id === node.id), b = draft.plan.nodes.findIndex(item => item.id === other.id); [draft.plan.nodes[a], draft.plan.nodes[b]] = [draft.plan.nodes[b], draft.plan.nodes[a]]; }
    } else if (action === 'condition-add' || action === 'condition-remove') {
      const node = findDraftNode(draft, ds), path = JSON.parse(ds.outlineConditionPath || '[]'), slot = ds.outlineConditionSlot || 'trigger';
      if (!node) throw new Error('节点已不存在。');
      if (action === 'condition-add') { const condition = conditionAt(node, slot, path); const list = condition?.all || condition?.any; if (!list) throw new Error('请先选择全部或任一条件组。'); list.push(blankCondition('unconfigured')); }
      else replaceCondition(node, slot, path, undefined);
    } else if (action === 'entity-add') {
      const node = findDraftNode(draft, ds);
      const picks = (!draft.editorOpen && draft.inlineEdit?.kind === 'node') ? (draft.inlineEdit.entityPicks || {}) : (draft.entityPicks || {});
      const raw = picks[ds.outlineNid];
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
      draft.plan = null; draft.editorOpen = false; draft.confirmBatchDeleteTrackId = null; draft.message = '大纲已保存。'; draft.error = false;
      engine()?.applyInjection?.();
    } else if (action === 'copy-world-api') {
      const worldCfg = window.WORLD_ENGINE_API?.getSettings?.(true);
      if (!worldCfg) throw new Error('世界引擎设置尚未就绪。');
      if (!draft.settingsDraft) draft.settingsDraft = clone(settings());
      draft.settingsDraft.connectionMode = worldCfg.connectionMode === 'proxy' ? 'proxy' : 'direct';
      draft.settingsDraft.apiUrl = String(worldCfg.apiUrl || '');
      draft.settingsDraft.apiKey = String(worldCfg.apiKey || '');
      draft.message = '已填入世界引擎连接信息（仅一次性复制，需点「保存设置」生效）。';
      draft.error = false;
    } else if (action === 'test-api') {
      const api = window.WORLD_ENGINE_API;
      if (!api?.testConnection) throw new Error('连接测试接口尚未就绪。');
      const cfg = clone(draft.settingsDraft || settings());
      draft.testingApi = true;
      draft.apiTestStatus = '正在发送测试请求…';
      draft.apiTestError = false;
      refresh();
      try {
        const res = await api.testConnection(cfg, { module: 'outline' });
        draft.apiTestStatus = `连接成功（${res.durationMs}ms）：${res.preview || '已收到响应'}`;
        draft.apiTestError = false;
        draft.message = '剧情大纲 API 连接测试成功。';
        draft.error = false;
      } catch (err) {
        draft.apiTestStatus = `连接失败：${err?.message || err}`;
        draft.apiTestError = true;
        throw err;
      } finally {
        draft.testingApi = false;
      }
    } else if (action === 'fetch-models') {
      const api = window.WORLD_ENGINE_API;
      if (!api?.fetchModelList) throw new Error('模型列表接口尚未就绪。');
      const cfg = clone(draft.settingsDraft || settings());
      draft.fetchingModels = true;
      draft.message = '正在获取模型列表…';
      draft.error = false;
      refresh();
      try {
        api.setNextRequestMeta?.({ module: 'outline', purpose: '获取模型列表' });
        const models = await api.fetchModelList(cfg);
        draft.fetchedModels = Array.isArray(models) ? models : [];
        draft.message = draft.fetchedModels.length ? `获取到 ${draft.fetchedModels.length} 个模型。` : '模型列表为空。';
        draft.error = false;
      } finally {
        draft.fetchingModels = false;
      }
    } else if (action === 'save-settings') {
      const next = clone(draft.settingsDraft || settings());
      next.checkEveryX = Math.max(1, Math.floor(Number(next.checkEveryX) || 3));
      next.injectMaxChars = Math.max(200, Math.floor(Number(next.injectMaxChars) || 2500));
      next.maxTokens = Math.max(1, Math.floor(Number(next.maxTokens) || 65000));
      next.apiTimeoutMs = Math.max(0, Number(next.apiTimeoutMs) || 0);
      next.streamIdleTimeoutMs = Math.max(0, Number(next.streamIdleTimeoutMs) || 0);
      next.jsonMode = next.jsonMode === true;
      next.topP = (next.topP !== '' && next.topP != null && Number.isFinite(Number(next.topP)))
        ? Math.max(0, Math.min(1, Number(next.topP)))
        : null;
      const eff = String(next.reasoningEffort || '').trim().toLowerCase();
      next.reasoningEffort = ['low', 'medium', 'high', 'minimal', 'none'].includes(eff) ? eff : '';
      next.apiAutoRetries = Math.max(0, Math.min(10, Math.floor(Number(next.apiAutoRetries) || 0)));
      const previous = settings();
      const requestKeys = ['engineEnabled', 'firstLayerIsAiOpening', 'autoCheck', 'checkEveryX', 'allowProposals', 'injectIntoWorldEngine', 'useWorldReference', 'injectIntoMemoryEngine', 'useMemoryReference', 'narrativeLimit', 'worldLimit', 'cooldownTicks', 'apiUrl', 'apiKey', 'model', 'connectionMode', 'temperature', 'maxTokens', 'apiTimeoutMs', 'stream', 'streamIdleTimeoutMs', 'jsonMode', 'topP', 'reasoningEffort', 'apiAutoRetries'];
      if (requestKeys.some(key => previous[key] !== next[key])) engine()?.abort?.();
      window.OUTLINE_ENGINE_SETTINGS.patchSettings(next);
      if (draft.coordinationMode === 'independent' || draft.coordinationMode === 'stagger-serial') {
        window.STORY_ENGINE_BRIDGE?.setCoordinationMode?.(draft.coordinationMode);
      }
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
      draft.pendingJson = null; draft.inlineEdit = null; draft.message = '已按确认范围完成导入。'; engine()?.applyInjection?.();
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
        draft.inlineEdit = null; engine()?.applyInjection?.(); draft.message = '剧情存档已恢复。';
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
        } else if (element?.id === 'we-outline-theme-select') {
          applyOutlineTheme(element.value);
        } else if (['we-outline-text-file', 'we-outline-json-file', 'we-outline-snapshot-file', 'we-outline-history-file'].includes(element.id)) {
          await importFile(element.files?.[0], element.id === 'we-outline-text-file' ? 'text' : element.id === 'we-outline-snapshot-file' ? 'snapshot' : 'json');
          element.value = '';
        } else if (element?.dataset?.outlineConditionType || element?.dataset?.outlineConditionValueType || ['collection', 'entityId', 'basis'].includes(element?.dataset?.outlineConditionField) || element?.dataset?.outlineNodeList === 'dependencies' || element?.dataset?.outlineTrackField === 'kind' || element?.dataset?.outlineNodeField === 'trackId') refresh();
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
        const actionName = element.dataset.outlineAction;
        if (actionName === 'toggle-adv-fold') {
          try { await handleAction(actionName, element); } catch (_) {}
          return; // 不阻止原生 <details> toggle
        }
        event.preventDefault();
        try { await handleAction(actionName, element); }
        catch (error) { notify(error?.message || error, true); }
        return;
      }
      const sectionToggle = event.target?.closest?.('.we-section-toggle[data-section]');
      if (sectionToggle && root.contains(sectionToggle)) {
        const sectionId = sectionToggle.dataset.section;
        const draft = draftFor();
        if (!draft.collapsedSections) draft.collapsedSections = {};
        if (!sectionToggle.onclick) {
          draft.collapsedSections[sectionId] = !draft.collapsedSections[sectionId];
          const secBody = typeof document !== 'undefined' ? document.getElementById('we-section-body-' + sectionId) : null;
          const arrow = typeof document !== 'undefined' ? document.getElementById('we-section-arrow-' + sectionId) : null;
          if (secBody) secBody.style.display = draft.collapsedSections[sectionId] ? 'none' : '';
          if (arrow) arrow.textContent = draft.collapsedSections[sectionId] ? '▶' : '▼';
        } else {
          const arrow = typeof document !== 'undefined' ? document.getElementById('we-section-arrow-' + sectionId) : null;
          draft.collapsedSections[sectionId] = arrow?.textContent === '▶';
        }
        return;
      }
      const tabBtn = event.target?.closest?.('.we-settings-tab[data-tab]');
      if (tabBtn && root.contains(tabBtn) && !tabBtn.onclick) {
        const key = tabBtn.dataset.tab;
        draftFor().settingsTab = key;
        root.querySelectorAll('.we-settings-tab').forEach(t => t.classList.toggle('we-settings-tab--active', t.dataset.tab === key));
        root.querySelectorAll('.we-settings-panel').forEach(p => { p.style.display = p.dataset.tab === key ? '' : 'none'; });
        if (key === 'debug' && typeof document !== 'undefined') {
          const el = document.getElementById('we-outline-debug-render');
          if (el) { el.innerHTML = renderDebugContent(); window.WORLD_ENGINE_UI?.bindPromptSegToggle?.(el); }
        }
        return;
      }
      const draft = draftFor();
      if (draft.view === 'home' && !draft.settingsOpen && !draft.editorOpen && !draft.textOpen && draft.selectedNavView && !event.target?.closest?.('.we-nav-row, select, input, textarea, button, summary, details, label, a')) {
        draft.selectedNavView = null;
        refresh();
      }
    };
    // 同步折叠框的展开状态，避免同视图 refresh() 后重新折叠
    if (typeof root.querySelectorAll === 'function') {
      root.querySelectorAll('details.we-outline-edit-node[data-outline-editor-nid]').forEach(det => {
        if (typeof det.addEventListener === 'function') {
          det.addEventListener('toggle', () => {
            draftFor().expandedEditorNodes[det.dataset.outlineEditorNid] = det.open;
          });
        }
      });
      root.querySelectorAll('details.we-outline-adv-fold[data-outline-adv-key]').forEach(det => {
        if (typeof det.addEventListener === 'function') {
          det.addEventListener('toggle', () => {
            const d = draftFor(), nid = det.dataset.outlineAdvKey;
            if (d.inlineEdit?.kind === 'node' && d.inlineEdit.data?.id === nid) d.inlineEdit.showAdvanced = det.open;
            else if (d.editorOpen && nid) d.expandedEditorAdv[nid] = det.open;
          });
        }
      });
    }
    window.WORLD_ENGINE_UI?.bindPromptSegToggle?.(root);
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
        if (draft.settingsOpen) { draft.editorOpen = false; draft.textOpen = false; draft.inlineEdit = null; draft.coordinationMode = window.STORY_ENGINE_BRIDGE?.getCoordinationMode?.() || null; }
        if (!draft.settingsDraft) draft.settingsDraft = clone(settings());
      },
      isSettingsOpen: () => draftFor().settingsOpen,
      onSettingsTab: key => { draftFor().settingsTab = key; },
      getScrollKey: () => {
        const d = draftFor();
        return d.settingsOpen ? 'settings' : d.editorOpen ? 'editor' : d.textOpen ? 'text' : `view:${d.view}`;
      },
      isEditing: () => { const draft = draftFor(); return draft.editorOpen || draft.textOpen || Boolean(draft.pendingJson) || Boolean(draft.inlineEdit); },
      getHeaderText: () => {
        const current = state(), chapters = chaptersOf(current.plan);
        if (!chapters.length) return nodesOf(current.plan).length ? `${nodesOf(current.plan).length} 节点` : '尚未建纲';
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
        const chapterName = chapter ? (chapter.title || '未命名章节') : (nodesOf(current.plan).length ? '跨章大纲' : '尚未设置剧情大纲');
        if (enabled) {
          return { text: `${chapterName} · 每 ${settings().checkEveryX ?? 3} 轮检查`, color: 'var(--we-accent)' };
        }
        return { text: `${chapterName} · 模块未启用`, color: 'var(--we-text3)' };
      },
      getTheme: getStoredOutlineTheme,
      refreshDebug: () => {
        const el = typeof document !== 'undefined' ? document.getElementById('we-outline-debug-render') : null;
        if (el) {
          el.innerHTML = renderDebugContent();
          window.WORLD_ENGINE_UI?.bindPromptSegToggle?.(el);
        }
      },
      getVersion: () => window.OUTLINE_ENGINE_SETTINGS?.VERSION || '2.0.0',
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
