// outline-engine-ui.js — 剧情大纲 v3 交互界面（完整保留原版墨玉宋体视觉体系与三模块共享布局 + v3 轻量化逻辑）
window.OUTLINE_ENGINE_UI = (function() {
  'use strict';

  const THEME_STORAGE_KEY = 'outline_engine_theme';
  const THEMES = [
    { id: 'default', name: '墨玉 · 默认' },
    { id: 'night',   name: '夜阑 · 近黑' },
    { id: 'deepsea', name: '深海 · 幽蓝' },
    { id: 'plum',    name: '夜合 · 暗紫' },
    { id: 'paper',   name: '云白 · 清爽' },
    { id: 'sakura',  name: '早樱 · 浅粉' }
  ];

  function getStoredOutlineTheme() {
    try {
      const saved = window.WORLD_ENGINE_STORE?.getItem?.(THEME_STORAGE_KEY) || '';
      return THEMES.some(t => t.id === saved) ? saved : 'default';
    } catch (_) {
      return 'default';
    }
  }

  function setStoredOutlineTheme(themeId) {
    const id = THEMES.some(t => t.id === themeId) ? themeId : 'default';
    try { window.WORLD_ENGINE_STORE?.setItem?.(THEME_STORAGE_KEY, id); } catch (_) {}
    try {
      if (id === 'default') document.documentElement?.removeAttribute?.('data-we-theme');
      else document.documentElement?.setAttribute?.('data-we-theme', id);
    } catch (_) {}
    return id;
  }

  const NAV_ITEMS = [
    { view: 'progress', label: '进度', sub: '当前章节 · 节点推进 · 快捷切态', poem: '脉络所至，一目了然' },
    { view: 'tracks',   label: '剧情', sub: '主线 · 支线 · 暗线 · 章节看板', poem: '草蛇灰线，伏脉千里' },
    { view: 'schedule', label: '注入', sub: '前台指导 · 后台备忘 · 提示词',   poem: '运筹帷幄之中' }
  ];

  const SETTINGS_TABS = [
    { key: 'common',   label: '常用' },
    { key: 'link',     label: '联动' },
    { key: 'advanced', label: '高级' },
    { key: 'archive',  label: '存档' },
    { key: 'debug',    label: '调试' },
    { key: 'about',    label: '关于' }
  ];

  const STATUS_META = {
    pending:   { label: '待推进', cls: 'pending' },
    active:    { label: '进行中', cls: 'active' },
    completed: { label: '已完成', cls: 'completed' },
    skipped:   { label: '已跳过', cls: 'skipped' },
    blocked:   { label: '受阻',   cls: 'blocked' }
  };

  const KIND_META = {
    main:   { label: '主线', cls: 'main' },
    side:   { label: '支线', cls: 'side' },
    hidden: { label: '暗线', cls: 'hidden' }
  };

  const clean = v => String(v == null ? '' : v).trim();
  const h = v => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const clone = v => JSON.parse(JSON.stringify(v));

  const data = () => window.OUTLINE_ENGINE_DATA;
  const engine = () => window.OUTLINE_ENGINE;
  const settingsApi = () => window.OUTLINE_ENGINE_SETTINGS;
  const chatCache = () => window.WORLD_ENGINE_CHATCACHE?.forScope?.('outline') || null;
  const chatId = () => data()?.getChatId?.() || 'default';
  const loadState = () => data()?.loadState?.() || { schemaVersion: 3, revision: 0, plan: { chapters: [], tracks: [], nodes: [] }, progress: {}, manualOverrides: {}, tracking: {} };
  const loadSettings = () => settingsApi()?.getSettings?.(true) || {};

  const drafts = new Map();
  let registered = false;

  function getDraft() {
    const id = chatId();
    if (!drafts.has(id)) {
      drafts.set(id, {
        view: 'home',
        selectedNavView: null,
        settingsOpen: false,
        settingsTab: 'common',
        settingsDraft: null,
        coordinationMode: null,
        collapsedSections: {},
        textOpen: false,
        sourceText: '',
        textPreview: null,
        boardMode: 'track',
        selectedChapterId: null,
        lastCurrentChapterId: '',
        expandedNodes: {},
        inlineEdit: null,
        confirmDeleteTrackId: null,
        pendingImport: null,
        snapshotName: '',
        fetchedModels: [],
        fetchingModels: false,
        testingApi: false,
        apiTestStatus: '',
        apiTestError: false
      });
    }
    return drafts.get(id);
  }

  function showToast(msg, isError) {
    try { window.WORLD_ENGINE_UI?.showToast?.(msg, Boolean(isError)); } catch (_) {}
  }

  function refresh() {
    try { window.WORLD_ENGINE_UI?.refresh?.(); } catch (_) {}
  }

  // ==================== 共享控件辅助函数（严格复用 style.css 与原版 outline-engine.css 类名） ====================

  function button(action, label, extra = '', variant = '') {
    const cls = variant === 'primary'
      ? 'we-btn we-btn-primary'
      : variant === 'danger'
        ? 'we-btn we-btn-danger'
        : 'we-btn';
    return `<button type="button" class="${cls}" data-outline-action="${h(action)}"${extra || ''}>${h(label)}</button>`;
  }

  function iconBtn(action, iconCls, title, extra = '', danger = false) {
    return `<button type="button" class="we-icon-btn${danger ? ' we-outline-icon-danger' : ''}" data-outline-action="${h(action)}" title="${h(title)}" aria-label="${h(title)}"${extra || ''}><i class="fa-solid ${h(iconCls)}"></i></button>`;
  }

  function subTopbar(title, poem, backAction = 'view-home') {
    return `<div class="we-sub-topbar">
      <button class="we-icon-btn" type="button" data-outline-action="${h(backAction)}" title="返回" aria-label="返回"><i class="fa-solid fa-arrow-left"></i></button>
      <span class="we-sub-title">${h(title)}</span>
      ${poem ? `<span class="we-sub-poem we-memory-sub-poem">${h(poem)}</span>` : ''}
    </div>`;
  }

  function settingHint(hint) {
    return hint ? `<div class="we-outline-field-hint">${h(hint)}</div>` : '';
  }

  function settingsSection(draft, id, title, bodyHtml) {
    const collapsed = draft?.collapsedSections?.[id] === true;
    return `<div class="we-section">
      <div class="we-section-title">
        <span class="we-outline-sec-toggle" data-outline-sec="${h(id)}" role="button" tabindex="0" aria-expanded="${!collapsed}">
          <span class="we-section-arrow" id="we-section-arrow-${h(id)}">${collapsed ? '▶' : '▼'}</span>${h(title)}
        </span>
      </div>
      <div class="we-section-body" id="we-section-body-${h(id)}"${collapsed ? ' style="display:none"' : ''}>${bodyHtml}</div>
    </div>`;
  }

  function settingCheck(label, name, checked, hint) {
    return `<div class="we-input-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input id="we-outline-${h(name)}" data-outline-setting="${h(name)}" type="checkbox"${checked ? ' checked' : ''}>${h(label)}</label>${settingHint(hint)}</div>`;
  }

  function settingInput(label, name, value, opts = {}) {
    const numAttrs = `${opts.min != null ? ` min="${opts.min}"` : ''}${opts.max != null ? ` max="${opts.max}"` : ''}${opts.step ? ` step="${opts.step}"` : ''}`;
    const placeholder = opts.placeholder ? ` placeholder="${h(opts.placeholder)}"` : '';
    const auto = opts.type === 'password' ? ' autocomplete="new-password"' : '';
    const dis = opts.disabled ? ' disabled' : '';
    return `<div class="we-input-group"><label>${h(label)}</label><input id="we-outline-${h(name)}" data-outline-setting="${h(name)}" type="${h(opts.type || 'text')}" value="${h(value)}"${placeholder}${numAttrs}${auto}${dis} style="width:100%;">${settingHint(opts.hint)}</div>`;
  }

  function settingSelect(label, name, value, choices, hint) {
    return `<div class="we-input-group"><label>${h(label)}</label><select id="we-outline-${h(name)}" data-outline-setting="${h(name)}" style="width:100%;">${choices.map(([id, text]) => `<option value="${h(id)}"${String(value) === String(id) ? ' selected' : ''}>${h(text)}</option>`).join('')}</select>${settingHint(hint)}</div>`;
  }

  function settingCompactField(label, name, value, opts = {}) {
    const numAttrs = `${opts.min != null ? ` min="${opts.min}"` : ''}${opts.max != null ? ` max="${opts.max}"` : ''}${opts.step ? ` step="${opts.step}"` : ''}`;
    const dis = opts.disabled ? ' disabled' : '';
    return `<div style="flex:1;"><label>${h(label)}</label><input id="we-outline-${h(name)}" data-outline-setting="${h(name)}" type="${h(opts.type || 'number')}" value="${h(value)}"${numAttrs}${dis} style="width:100%;"></div>`;
  }

  function editorField(label, value, attrs, multiline = false, placeholder = '') {
    const ph = placeholder ? ` placeholder="${h(placeholder)}"` : '';
    return `<label class="we-outline-field"><span>${h(label)}</span>${multiline
      ? `<textarea rows="2" ${attrs}${ph}>${h(value || '')}</textarea>`
      : `<input type="text" ${attrs} value="${h(value || '')}"${ph}>`}</label>`;
  }

  // ==================== 首页（完全沿用三模块共享 .we-core + .we-nav-list 纵轴设计） ====================

  function renderOutlineCore(state, st) {
    const plan = state.plan || { chapters: [], tracks: [], nodes: [] };
    const chapters = plan.chapters || [];
    const tracks = plan.tracks || [];
    const allNodes = plan.nodes || [];
    const curIndex = chapters.findIndex(c => c.id === state.currentChapterId);
    const curChapter = curIndex >= 0 ? chapters[curIndex] : (chapters[0] || null);
    const chProg = curChapter ? data().getChapterProgress(state, curChapter.id) : { doneCount: 0, totalCount: 0 };
    const doneAll = allNodes.filter(n => data().isNodeClosed(state, n.id)).length;
    const ratio = chProg.totalCount > 0
      ? chProg.doneCount / chProg.totalCount
      : (allNodes.length > 0 ? doneAll / allNodes.length : 0);
    const clamped = Math.max(0, Math.min(1, ratio));
    const R = 64;
    const C = 2 * Math.PI * R;
    const dash = (clamped * C).toFixed(1);
    const ringColor = clamped >= 1 ? 'var(--we-accent)' : 'var(--we-gold)';
    const theta = (clamped * 360 - 90) * Math.PI / 180;
    const dotX = (80 + R * Math.cos(theta)).toFixed(1);
    const dotY = (80 + R * Math.sin(theta)).toFixed(1);
    const pctNum = chProg.totalCount > 0 ? chProg.doneCount : Math.round(clamped * 100);
    const pctUnit = chProg.totalCount > 0 ? `<span>/${chProg.totalCount}</span>` : '<span>%</span>';
    const subLabel = curChapter ? (curChapter.title || '未命名章节') : (allNodes.length ? '跨章无章界大纲' : '尚未建立大纲');
    const tierLabel = !chapters.length
      ? (allNodes.length ? `共 ${allNodes.length} 个节点` : '待建大纲')
      : (curIndex >= 0 ? `第 ${curIndex + 1}/${chapters.length} 章` : `共 ${chapters.length} 章`);

    const running = engine()?.isRunning?.() === true;
    const enabled = st.engineEnabled === true;
    const finished = data().isOutlineFinished(state);
    const unlockedCount = (engine()?.getUnlockedOpenNodes?.(state) || []).length;

    const statusText = running
      ? `正在${engine().getRunningLabel() || '检查剧情'}…`
      : !enabled
        ? '剧情模块当前关闭；仍可编辑与保存计划，启用后才检查和注入。'
        : !allNodes.length
          ? '已启用 · 尚未建立大纲，可进入「剧情」整理文本或手动创建。'
          : finished
            ? `已全部完结 · 共 ${chapters.length} 章 / ${allNodes.length} 节点`
            : st.injectIntoPrompt !== false
              ? `已启用 · 每 ${st.checkEveryX ?? 3} 轮自动检查 · 待推进 ${unlockedCount} 个节点`
              : `已启用 · 每 ${st.checkEveryX ?? 3} 轮自动检查 · 正文注入已暂停`;

    const stats = [
      ['章节', chapters.length],
      ['剧情线', tracks.length],
      ['节点', allNodes.length],
      ['已完成', doneAll]
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
        <div class="we-core-actions we-outline-core-actions">
          ${button('check-now', running ? '检查中…' : '立即检查', running || !enabled || !allNodes.length ? ' disabled' : '', 'primary')}
          ${running ? button('abort', '停止', '', 'danger') : ''}
        </div>
        <div class="we-core-status${enabled ? ' is-active' : ''}">${h(statusText)}</div>
      </div>
    </div>`;
  }

  function renderOutlineNavList(d) {
    const html = NAV_ITEMS.map((row, index) => {
      const selected = d.selectedNavView === row.view ? ' we-nav-row--selected' : '';
      const topLine = index === 0 ? '<div class="we-nav-line we-nav-line-hidden"></div>' : '<div class="we-nav-line"></div>';
      const bottomLine = index === NAV_ITEMS.length - 1 ? '<div class="we-nav-line we-nav-line-hidden"></div>' : '<div class="we-nav-line"></div>';
      return `<div class="we-nav-row we-outline-nav-row${selected}" data-outline-nav="${h(row.view)}" role="button" tabindex="0">
        <div class="we-nav-label">${h(row.label)}</div>
        <div class="we-nav-track">${topLine}<div class="we-nav-dot"></div>${bottomLine}</div>
        <div class="we-nav-content"><span class="we-nav-sub">${h(row.sub)}</span><span class="we-nav-poem">${h(row.poem)}</span></div>
        <i class="fa-solid fa-chevron-right we-nav-arrow"></i>
      </div>`;
    }).join('');
    return `<div class="we-nav-list we-outline-nav-list">${html}</div>`;
  }

  function renderHome(state, st) {
    const d = getDraft();
    return `<div class="we-outline-home">
      ${renderOutlineCore(state, st)}
      ${renderOutlineNavList(d)}
    </div>`;
  }

  // ==================== 节点卡片与原地表单（原版顶部微光卡片 + v3 极简字段） ====================

  function renderNodeInlineForm(state, formData, isNew) {
    const plan = state.plan || { chapters: [], tracks: [], nodes: [] };
    const trackMap = new Map((plan.tracks || []).map(t => [t.id, t]));
    const selectedTrack = trackMap.get(formData.trackId) || plan.tracks[0];
    const isHidden = selectedTrack?.kind === 'hidden';
    const otherNodes = (plan.nodes || []).filter(n => n.id !== formData.id);
    const chSet = new Set(formData.chapterIds || []);
    const depSet = new Set(formData.dependencies || []);

    return `<div class="we-outline-inline-editor">
      <div class="we-outline-section-head"><strong>${isNew ? '新增剧情节点' : '编辑剧情节点'}</strong></div>
      <div class="we-outline-form-grid">
        ${editorField('节点标题', formData.title, 'data-inline-field="title"', false, '例如：查明青石镇疫源')}
        <label class="we-outline-field">
          <span>所属剧情线</span>
          <select data-inline-field="trackId">
            ${(plan.tracks || []).map(t => `<option value="${h(t.id)}"${t.id === formData.trackId ? ' selected' : ''}>[${h(KIND_META[t.kind]?.label || '主线')}] ${h(t.title || '未命名')}</option>`).join('')}
          </select>
        </label>
      </div>
      ${(plan.chapters || []).length ? `<fieldset class="we-outline-choices">
        <legend>所属章节（主线按章门控；支线/暗线留空表示全篇跨章）</legend>
        ${(plan.chapters || []).map(c => `<label class="we-outline-check"><input type="checkbox" data-inline-chapters="${h(c.id)}"${chSet.has(c.id) ? ' checked' : ''}><span>${h(c.title || '未命名章节')}</span></label>`).join('')}
      </fieldset>` : ''}
      ${editorField('前台公开提示（会注入主聊天，请勿剧透真相）', formData.publicHint, 'data-inline-field="publicHint"', true, '给写文 AI 的自然引导或表面线索')}
      ${editorField('达成条件（AI 自动判定 completed 的依据）', formData.completionCriteria, 'data-inline-field="completionCriteria"', false, '例如：主角在药铺找到账本并确认投毒者身份')}
      ${editorField('幕后真相 / 作者备注（绝不进主聊天，仅核对 AI 与世界后台可见）', formData.secretNotes, 'data-inline-field="secretNotes"', true, '隐藏动机、伏笔真相、暗线计划…')}
      <div class="we-outline-form-grid">
        ${editorField('关联角色（逗号分隔，用于记忆热层联动）', (formData.actors || []).join(', '), 'data-inline-field="actorsText"', false, '沈清秋, 周掌柜')}
        <div class="we-outline-check-inline">
          <label class="we-outline-check"><input type="checkbox" data-inline-bool="required"${formData.required !== false ? ' checked' : ''}><span>本章推进必做节点</span></label>
          ${isHidden ? `<label class="we-outline-check"><input type="checkbox" data-inline-bool="revealPublic"${formData.revealPublic === true ? ' checked' : ''}><span>台前已显露公开提示</span></label>` : ''}
        </div>
      </div>
      ${otherNodes.length ? `<fieldset class="we-outline-choices">
        <legend>前置节点（勾选的节点完成/跳过后本节点才解锁）</legend>
        ${otherNodes.map(n => `<label class="we-outline-check"><input type="checkbox" data-inline-deps="${h(n.id)}"${depSet.has(n.id) ? ' checked' : ''}><span>${h(n.title || '未命名节点')}</span></label>`).join('')}
      </fieldset>` : ''}
      <div class="we-outline-actions we-outline-inline-actions">
        ${button('cancel-inline', '取消')}
        ${button('save-inline', isNew ? '添加节点' : '保存节点', '', 'primary')}
      </div>
    </div>`;
  }

  function renderNodeCard(state, node, index, options = {}) {
    const d = getDraft();
    const trackMap = new Map((state.plan.tracks || []).map(t => [t.id, t]));
    const chMap = new Map((state.plan.chapters || []).map(c => [c.id, c]));
    const track = trackMap.get(node.trackId);
    const kind = track?.kind || 'main';
    const km = KIND_META[kind] || KIND_META.main;
    const status = data().getNodeStatus(state, node.id);
    const sm = STATUS_META[status] || STATUS_META.pending;
    const isManual = Boolean(state.manualOverrides?.[node.id]);
    const prog = state.progress?.[node.id];
    const unlocked = data().isNodeUnlocked(state, node.id);
    const isClosed = data().isNodeClosed(state, node.id);
    const manualOnly = !isClosed && !clean(node.completionCriteria);
    const isEditing = d.inlineEdit?.kind === 'node' && !d.inlineEdit.isNew && d.inlineEdit.id === node.id;
    const expanded = isEditing || d.expandedNodes[node.id] === true;

    const chNames = (node.chapterIds || []).map(id => chMap.get(id)?.title).filter(Boolean);
    const depNames = (node.dependencies || []).map(id => data().getNode(state, id)?.title).filter(Boolean);
    const snippet = clean(node.publicHint || node.completionCriteria || node.secretNotes || '');

    return `<article class="we-outline-node we-outline-node-${h(kind)} we-outline-node-status-${h(status)}${expanded ? '' : ' is-collapsed'}" data-outline-node="${h(node.id)}">
      <div class="we-outline-node-head">
        <button type="button" class="we-icon-btn we-outline-node-toggle" data-outline-action="toggle-node" data-id="${h(node.id)}" title="${expanded ? '收起详情' : '展开详情'}" aria-expanded="${expanded ? 'true' : 'false'}"><i class="fa-solid fa-chevron-${expanded ? 'down' : 'right'}"></i></button>
        <div class="we-outline-node-title-wrap" data-outline-action="toggle-node" data-id="${h(node.id)}">
          <strong>${index + 1}. ${h(node.title || '未命名节点')}</strong>
          <div class="we-outline-node-badges">
            <span class="we-outline-badge we-outline-badge-${h(kind)}">${h(km.label)}</span>
            <span class="we-outline-status we-outline-status-${h(status)}">${h(sm.label)}${isManual ? ' · 手动' : ''}</span>
            ${node.required === false ? '<span class="we-outline-badge">可选</span>' : ''}
            ${kind === 'hidden' ? `<span class="we-outline-badge">${node.revealPublic ? '台前已显露' : '幕后隐藏'}</span>` : ''}
            ${!unlocked && !isClosed ? '<span class="we-outline-badge">未解锁</span>' : ''}
            ${manualOnly ? '<span class="we-outline-badge" title="未填写达成条件，后台不会自动判完成；可在编辑中补填或手动切换状态">仅手动完成</span>' : ''}
            ${prog?.layer != null ? `<span class="we-outline-sched-pill is-muted">L${h(prog.layer)}</span>` : ''}
          </div>
        </div>
        ${options.editable && !isEditing ? `<div class="we-outline-node-ops">
          ${iconBtn('node-up', 'fa-arrow-up', '上移节点', ` data-id="${h(node.id)}"`)}
          ${iconBtn('node-down', 'fa-arrow-down', '下移节点', ` data-id="${h(node.id)}"`)}
          ${iconBtn('edit-node', 'fa-pen', '编辑节点', ` data-id="${h(node.id)}"`)}
          ${iconBtn('remove-node', 'fa-trash', '删除节点', ` data-id="${h(node.id)}"`, true)}
        </div>` : ''}
      </div>
      ${!expanded && snippet ? `<p class="we-outline-node-snippet">${h(snippet)}</p>` : ''}
      <div class="we-outline-node-body"${expanded ? '' : ' hidden'}>
        ${isEditing
          ? renderNodeInlineForm(state, d.inlineEdit.data, false)
          : `${chNames.length ? `<p class="we-outline-hint">关联章节：${h(chNames.join(' / '))}</p>` : '<p class="we-outline-hint">全篇跨章节点</p>'}
            ${node.publicHint ? `<p class="we-outline-public-hint"><strong>公开提示：</strong>${h(node.publicHint)}</p>` : ''}
            <details class="we-outline-author-content" open>
              <summary>${kind === 'hidden' ? '作者幕后内容与判据' : '达成条件与细节'}</summary>
              <dl>
                <dt>达成条件</dt>
                <dd>${h(node.completionCriteria || '尚未填写；自动核对不会标为已完成，仅支持手动切换。')}</dd>
                ${node.secretNotes ? `<dt>幕后备注（绝不进主聊天）</dt><dd class="we-outline-secret-box">${h(node.secretNotes)}</dd>` : ''}
                ${depNames.length ? `<dt>前置节点</dt><dd>${h(depNames.join(' / '))}</dd>` : ''}
                ${node.actors?.length ? `<dt>关联角色</dt><dd>${h(node.actors.join('、'))}</dd>` : ''}
                ${prog?.reason ? `<dt>最近核对依据（L${h(prog.layer ?? '?')}）</dt><dd>${h(prog.reason)}</dd>` : ''}
              </dl>
              ${kind === 'hidden' ? `<div class="we-outline-actions">${button('toggle-reveal', node.revealPublic ? '收起台前显露（恢复幕后隐藏）' : '允许台前显露公开提示', ` data-id="${h(node.id)}"`)}</div>` : ''}
            </details>
            <label class="we-outline-status-select">
              <span>节点状态${isManual ? '（已手动锁定）' : ''}</span>
              <select data-outline-status="${h(node.id)}" aria-label="${h(node.title || '节点')}状态">
                ${Object.entries(STATUS_META).map(([k, m]) => `<option value="${k}"${status === k ? ' selected' : ''}>${h(m.label)}</option>`).join('')}
                ${isManual ? '<option value="auto">↺ 恢复自动判断</option>' : ''}
              </select>
            </label>`}
      </div>
    </article>`;
  }

  // ==================== 进度分页 ====================

  function renderProgressView(state) {
    const plan = state.plan || { chapters: [], tracks: [], nodes: [] };
    const chapters = plan.chapters || [];
    const tracks = plan.tracks || [];
    const allNodes = plan.nodes || [];
    const header = subTopbar('剧情进度', '脉络所至，一目了然');
    const hasAnyContent = Boolean(clean(plan.title) || chapters.length || tracks.length || allNodes.length);

    if (!hasAnyContent) {
      return `${header}<section class="we-section we-outline-pos-section">
        <div class="we-outline-section-head">
          <div class="we-section-title we-outline-sec-title" style="margin-bottom:0;border:none;padding:0;">当前位置</div>
          <div class="we-outline-actions">${button('view-tracks', '进入剧情看板 →')}</div>
        </div>
        <div class="we-outline-empty-box">
          <p class="we-outline-empty">尚未建立剧情大纲。可点「整理文本」由 AI 拆解，或进入「剧情」页新建章节与剧情线。</p>
          <div class="we-outline-actions">
            ${button('open-text', '整理文本导入', '', 'primary')}
            ${button('view-tracks', '前往剧情看板')}
          </div>
        </div>
      </section>`;
    }

    const doneAll = allNodes.filter(n => data().isNodeClosed(state, n.id)).length;
    const curIdx = chapters.findIndex(c => c.id === state.currentChapterId);
    const curCh = curIdx >= 0 ? chapters[curIdx] : (chapters[0] || null);
    const prog = curCh ? data().getChapterProgress(state, curCh.id) : { doneCount: 0, totalCount: 0 };
    const unlocked = engine()?.getUnlockedOpenNodes?.(state) || [];
    const chNodes = curCh ? data().getChapterNodes(state, curCh.id) : allNodes;
    const focusIds = new Set(unlocked.map(n => n.id));
    const focusList = [...unlocked, ...chNodes.filter(n => !focusIds.has(n.id))];
    const prevCh = curIdx > 0 ? chapters[curIdx - 1] : null;
    const nextCh = curIdx >= 0 && curIdx < chapters.length - 1 ? chapters[curIdx + 1] : null;

    const chapterLine = curCh
      ? `<div class="we-outline-pos-chapter">
          <div class="we-outline-track-title-row">
            <strong>第 ${curIdx + 1}/${chapters.length} 章 · ${h(curCh.title || '未命名章节')}</strong>
            <span class="we-outline-badge we-outline-badge-current">当前章</span>
            ${prog.totalCount ? `<span class="we-outline-hint">推进门槛 ${prog.doneCount}/${prog.totalCount}</span>` : ''}
          </div>
          ${curCh.goal ? `<p class="we-outline-goal">${h(curCh.goal)}</p>` : ''}
          ${(prevCh || nextCh) ? `<div class="we-outline-actions">
            ${prevCh ? button('set-chapter', `← 上一章：${prevCh.title}`, ` data-id="${h(prevCh.id)}"`) : ''}
            ${nextCh ? button('set-chapter', `下一章：${nextCh.title} →`, ` data-id="${h(nextCh.id)}"`) : ''}
          </div>` : ''}
        </div>`
      : '<div class="we-outline-pos-chapter"><strong>跨章自由推进中</strong></div>';

    return `${header}<section class="we-section we-outline-pos-section">
      <div class="we-outline-section-head">
        <div class="we-section-title we-outline-sec-title" style="margin-bottom:0;border:none;padding:0;">当前位置</div>
        <div class="we-outline-actions">${button('view-tracks', '进入剧情看板 →')}</div>
      </div>
      ${plan.title ? `<div class="we-outline-pos-plan">《${h(plan.title)}》</div>` : ''}
      ${chapterLine}
      <div class="we-outline-pos-nodes">
        ${focusList.map((node, idx) => renderNodeCard(state, node, idx, { editable: false })).join('') || '<p class="we-outline-empty">当前位置暂无待推进节点。</p>'}
      </div>
      <div class="we-outline-pos-foot">全书共 ${chapters.length} 章 · ${tracks.length} 条剧情线 · 已完成 ${doneAll}/${allNodes.length} 个节点</div>
    </section>`;
  }

  // ==================== 剧情看板分页 ====================

  function renderInlinePlanForm(f) {
    return `<div class="we-outline-inline-editor">
      <div class="we-outline-section-head"><strong>编辑大纲总览</strong></div>
      ${editorField('大纲标题', f.title, 'data-inline-field="title"')}
      ${editorField('公开脉络（注入前台，不剧透）', f.publicSynopsis, 'data-inline-field="publicSynopsis"', true)}
      ${editorField('叙事原则（注入前台，不剧透）', f.publicConstraints, 'data-inline-field="publicConstraints"', true)}
      ${editorField('作者幕后总备忘（绝不进主聊天）', f.authorNotes, 'data-inline-field="authorNotes"', true)}
      <div class="we-outline-actions we-outline-inline-actions">
        ${button('cancel-inline', '取消')}
        ${button('save-inline', '保存大纲信息', '', 'primary')}
      </div>
    </div>`;
  }

  function renderInlineChapterForm(f, isNew) {
    return `<div class="we-outline-inline-editor">
      <div class="we-outline-section-head"><strong>${isNew ? '新增章节' : '编辑章节'}</strong></div>
      ${editorField('章节标题', f.title, 'data-inline-field="title"', false, '例如：第一章 初抵青石镇')}
      ${editorField('章节目标', f.goal, 'data-inline-field="goal"', true, '本章主要推进方向')}
      <div class="we-outline-actions we-outline-inline-actions">
        ${button('cancel-inline', '取消')}
        ${button('save-inline', isNew ? '创建章节' : '保存章节', '', 'primary')}
      </div>
    </div>`;
  }

  function renderInlineTrackForm(f, isNew) {
    return `<div class="we-outline-inline-editor">
      <div class="we-outline-section-head"><strong>${isNew ? '新增剧情线' : '编辑剧情线'}</strong></div>
      <div class="we-outline-form-grid">
        ${editorField('剧情线名称', f.title, 'data-inline-field="title"', false, '例如：药铺暗线')}
        <label class="we-outline-field">
          <span>类型（决定是否防剧透隔离）</span>
          <select data-inline-field="kind">
            <option value="main"${f.kind === 'main' ? ' selected' : ''}>主线（按章推进）</option>
            <option value="side"${f.kind === 'side' ? ' selected' : ''}>支线（跨章常驻）</option>
            <option value="hidden"${f.kind === 'hidden' ? ' selected' : ''}>暗线（幕后防剧透）</option>
          </select>
        </label>
      </div>
      ${editorField('长期目标', f.goal, 'data-inline-field="goal"', true)}
      <div class="we-outline-actions we-outline-inline-actions">
        ${button('cancel-inline', '取消')}
        ${button('save-inline', isNew ? '创建剧情线' : '保存剧情线', '', 'primary')}
      </div>
    </div>`;
  }

  function renderTracksView(state) {
    const d = getDraft();
    const plan = state.plan || { chapters: [], tracks: [], nodes: [] };
    const chapters = plan.chapters || [];
    const tracks = plan.tracks || [];
    const allNodes = plan.nodes || [];
    const mode = d.boardMode === 'chapter' ? 'chapter' : 'track';
    const hasAnyContent = Boolean(clean(plan.title) || clean(plan.publicSynopsis) || chapters.length || tracks.length || allNodes.length);

    if (d.lastCurrentChapterId !== state.currentChapterId && d.selectedChapterId === d.lastCurrentChapterId) {
      d.selectedChapterId = null;
    }
    d.lastCurrentChapterId = state.currentChapterId || '';

    const editingPlan = d.inlineEdit?.kind === 'plan';
    const addingChapter = d.inlineEdit?.kind === 'chapter' && d.inlineEdit.isNew;
    const addingTrack = d.inlineEdit?.kind === 'track' && d.inlineEdit.isNew;
    const addingNode = d.inlineEdit?.kind === 'node' && d.inlineEdit.isNew;

    let boardBody = '';
    if (!hasAnyContent && !d.inlineEdit) {
      boardBody = `<div class="we-outline-empty-box">
        <p class="we-outline-empty">暂无剧情大纲。大纲会在生成正文前注入柔和的【剧情指导】，帮 AI 稳定推进剧情又不剧透暗线。</p>
        <div class="we-outline-actions">
          ${button('open-text', '导入文本由 AI 整理', '', 'primary')}
          ${button('add-chapter', '+ 新建章节')}
          ${button('add-node', '+ 新建节点')}
        </div>
      </div>`;
    } else if (mode === 'track') {
      const orphanAddingNode = addingNode && !tracks.some(t => t.id === d.inlineEdit.data.trackId)
        ? `<div class="we-outline-node we-outline-node-new">${renderNodeInlineForm(state, d.inlineEdit.data, true)}</div>`
        : '';

      boardBody = `${addingChapter ? renderInlineChapterForm(d.inlineEdit.data, true) : ''}
        ${addingTrack ? renderInlineTrackForm(d.inlineEdit.data, true) : ''}
        ${orphanAddingNode}
        ${tracks.map((tr, ti) => {
          const km = KIND_META[tr.kind] || KIND_META.main;
          const trNodes = data().getTrackNodes(state, tr.id);
          const editingTr = d.inlineEdit?.kind === 'track' && !d.inlineEdit.isNew && d.inlineEdit.id === tr.id;
          const addingNodeHere = addingNode && d.inlineEdit.data.trackId === tr.id;
          const confirmDel = d.confirmDeleteTrackId === tr.id;
          const otherTrack = tracks.find(t => t.id !== tr.id && t.kind === 'main') || tracks.find(t => t.id !== tr.id);

          return `<section class="we-section we-outline-track we-outline-track-${h(km.cls)}">
            <div class="we-outline-section-head">
              <div class="we-outline-track-title-row">
                <span class="we-outline-badge we-outline-badge-${h(km.cls)}">${h(km.label)}</span>
                <h3>${h(tr.title || '未命名剧情线')}</h3>
                ${tr.paused ? '<span class="we-outline-badge">作者暂停</span>' : ''}
              </div>
              <div class="we-outline-track-ops">
                ${button('add-node', '+ 节点', ` data-track="${h(tr.id)}"`)}
                ${button('track-pause', tr.paused ? '继续此线' : '暂停此线', ` data-id="${h(tr.id)}"`)}
                ${iconBtn('track-up', 'fa-arrow-up', '上移剧情线', ` data-id="${h(tr.id)}"${ti === 0 ? ' disabled' : ''}`)}
                ${iconBtn('track-down', 'fa-arrow-down', '下移剧情线', ` data-id="${h(tr.id)}"${ti === tracks.length - 1 ? ' disabled' : ''}`)}
                ${iconBtn('edit-track', 'fa-pen', '编辑剧情线', ` data-id="${h(tr.id)}"`)}
                ${iconBtn('remove-track', 'fa-trash', '删除剧情线', ` data-id="${h(tr.id)}"`, true)}
              </div>
            </div>
            ${confirmDel ? `<div class="we-outline-confirm-bar">
              <span>此剧情线仍有 ${trNodes.length} 个节点，请选择处理方式：</span>
              <div class="we-outline-actions">
                ${otherTrack ? button('confirm-track-del-move', `节点移至「${otherTrack.title || '主线'}」并删线`, ` data-id="${h(tr.id)}"`) : ''}
                ${button('confirm-track-del-all', `连同 ${trNodes.length} 个节点一并删除`, ` data-id="${h(tr.id)}"`, 'danger')}
                ${button('cancel-track-del', '取消')}
              </div>
            </div>` : ''}
            ${editingTr ? renderInlineTrackForm(d.inlineEdit.data, false) : ''}
            ${tr.goal ? `<p class="we-outline-goal">${h(tr.goal)}</p>` : ''}
            ${tr.paused ? '<p class="we-outline-message">此线已由作者暂停；恢复前不会进入前台或后台指导。</p>' : ''}
            ${addingNodeHere ? `<div class="we-outline-node we-outline-node-new">${renderNodeInlineForm(state, d.inlineEdit.data, true)}</div>` : ''}
            ${trNodes.map((n, idx) => renderNodeCard(state, n, idx, { editable: true })).join('') || (addingNodeHere ? '' : '<p class="we-outline-empty">此线暂无节点，点击右上「+ 节点」即可随手添加。</p>')}
          </section>`;
        }).join('') || (addingTrack || orphanAddingNode ? '' : '<div class="we-outline-empty-box"><p class="we-outline-empty">尚未建立剧情线，可点击上方「+ 线」新建，或使用「整理文本」一键生成。</p></div>')}`;
    } else {
      const selected = chapters.find(c => c.id === d.selectedChapterId)
        || chapters.find(c => c.id === state.currentChapterId)
        || chapters[0]
        || null;
      const selectedIdx = chapters.findIndex(c => c.id === selected?.id);
      const editingCh = d.inlineEdit?.kind === 'chapter' && !d.inlineEdit.isNew && d.inlineEdit.id === selected?.id;
      const chNodes = selected ? data().getChapterNodes(state, selected.id) : [];
      const unchaptered = allNodes.filter(n => !Array.isArray(n.chapterIds) || !n.chapterIds.length);

      const chapterTabs = chapters.map((ch, idx) => {
        const p = data().getChapterProgress(state, ch.id);
        const isCur = ch.id === state.currentChapterId;
        const isSel = selected?.id === ch.id;
        return `<button type="button" class="we-outline-chapter${isSel ? ' is-selected' : ''}${isCur ? ' is-current' : ''}" data-outline-action="select-chapter" data-id="${h(ch.id)}">
          <span>${idx + 1}. ${h(ch.title || '未命名章节')}</span>
          <small>${isCur ? '当前章 · ' : ''}门槛 ${p.doneCount}/${p.totalCount}</small>
        </button>`;
      }).join('');

      boardBody = `${addingChapter ? renderInlineChapterForm(d.inlineEdit.data, true) : ''}
        ${addingTrack ? renderInlineTrackForm(d.inlineEdit.data, true) : ''}
        ${chapters.length ? `<nav class="we-outline-chapters" aria-label="章节列表">${chapterTabs}</nav>
          <div class="we-outline-chapter-detail">
            <div class="we-outline-section-head">
              <div class="we-outline-track-title-row">
                <h3>${h(selected?.title || '')}</h3>
                ${selected && selected.id !== state.currentChapterId
                  ? button('set-chapter', '设为当前章', ` data-id="${h(selected.id)}"`)
                  : '<span class="we-outline-badge we-outline-badge-current">当前章</span>'}
              </div>
              <div class="we-outline-track-ops">
                ${button('add-node', '+ 本章加节点', ` data-chapter="${h(selected?.id || '')}"`)}
                ${iconBtn('chapter-up', 'fa-arrow-up', '前移章节', ` data-id="${h(selected?.id || '')}"${selectedIdx <= 0 ? ' disabled' : ''}`)}
                ${iconBtn('chapter-down', 'fa-arrow-down', '后移章节', ` data-id="${h(selected?.id || '')}"${selectedIdx < 0 || selectedIdx >= chapters.length - 1 ? ' disabled' : ''}`)}
                ${iconBtn('edit-chapter', 'fa-pen', '编辑章节', ` data-id="${h(selected?.id || '')}"`)}
                ${iconBtn('remove-chapter', 'fa-trash', '删除章节', ` data-id="${h(selected?.id || '')}"`, true)}
              </div>
            </div>
            ${editingCh ? renderInlineChapterForm(d.inlineEdit.data, false) : ''}
            ${selected?.goal ? `<p class="we-outline-goal">章节目标：${h(selected.goal)}</p>` : ''}
            ${addingNode ? `<div class="we-outline-node we-outline-node-new">${renderNodeInlineForm(state, d.inlineEdit.data, true)}</div>` : ''}
            ${chNodes.map((n, idx) => renderNodeCard(state, n, idx, { editable: true })).join('') || (addingNode ? '' : '<p class="we-outline-empty">本章暂无节点，点上方「+ 本章加节点」即可创建。</p>')}
          </div>`
          : (addingNode ? `<div class="we-outline-node we-outline-node-new">${renderNodeInlineForm(state, d.inlineEdit.data, true)}</div>` : '<p class="we-outline-empty">暂无章节，点击上方「+ 章节」创建。</p>')}
        ${unchaptered.length ? `<div class="we-outline-unchaptered"><div class="we-outline-section-head"><strong>跨章常驻节点（未绑定特定章节）</strong></div>${unchaptered.map((n, idx) => renderNodeCard(state, n, idx, { editable: true })).join('')}</div>` : ''}`;
    }

    return `${subTopbar('跨章剧情线', '草蛇灰线，伏脉千里')}
      <section class="we-section we-outline-home-chapter">
        <div class="we-section-title we-outline-sec-title">剧情看板</div>
        <div class="we-outline-plan-heading">
          <div class="we-outline-section-head">
            <div class="we-outline-plan-title">${h(plan.title || '还没有剧情大纲')}</div>
            <div class="we-outline-node-ops">
              ${iconBtn('edit-plan-meta', 'fa-pen', '编辑大纲标题与脉络')}
              ${hasAnyContent ? iconBtn('clear-outline', 'fa-trash', '清空当前大纲', '', true) : ''}
            </div>
          </div>
          <div class="we-outline-actions we-outline-plan-tools">
            ${button('open-text', '整理文本')}
          </div>
          ${editingPlan ? renderInlinePlanForm(d.inlineEdit.data) : `
            ${plan.publicSynopsis ? `<details class="we-outline-plan-detail"><summary>公开脉络</summary><p>${h(plan.publicSynopsis)}</p></details>` : ''}
            ${plan.publicConstraints ? `<details class="we-outline-plan-detail"><summary>叙事原则</summary><p>${h(plan.publicConstraints)}</p></details>` : ''}
            ${plan.authorNotes ? `<details class="we-outline-plan-detail"><summary>作者幕后总备忘（绝不进主聊天）</summary><p>${h(plan.authorNotes)}</p></details>` : ''}
          `}
        </div>
        <div class="we-outline-board-toolbar">
          <div class="we-outline-seg" role="group" aria-label="看板分组模式">
            <button type="button" class="we-outline-seg-btn${mode === 'chapter' ? ' is-active' : ''}" data-outline-action="mode-chapter">按章节</button>
            <button type="button" class="we-outline-seg-btn${mode === 'track' ? ' is-active' : ''}" data-outline-action="mode-track">按剧情线</button>
          </div>
          <div class="we-outline-actions">
            ${button('add-chapter', '+ 章节')}
            ${button('add-track', '+ 线')}
            ${button('add-node', '+ 节点', '', 'primary')}
          </div>
        </div>
        ${boardBody}
      </section>`;
  }

  // ==================== 注入预览分页（单份不重复） ====================

  function renderScheduleView(state, st) {
    const header = subTopbar('注入与调度', '运筹帷幄之中');
    const narrative = engine()?.buildNarrativeGuidance?.(state) || '';
    const world = engine()?.buildWorldGuidance?.() || '';
    const posLabel = { 0: '主提示词内', 1: `聊天内深度 ${st.injectDepth ?? 1}`, 2: '主提示词之前' }[st.injectPosition ?? 1] || '聊天内深度 1';
    const lastFull = window.WORLD_ENGINE_INJECT_INSPECTOR?.getLastFullPrompt?.();
    const orderLine = lastFull
      ? `上次正文三模块实际顺序：${(lastFull.order || []).map(item => item.label).join(' → ') || '均未注入'}（共 ${lastFull.promptLength || 0} 字）`
      : '尚未捕获上次正文生成；生成一次正文后可在下方核对三模块全文与顺序。';

    const frontSec = `<section class="we-section we-outline-inject-preview">
      <div class="we-section-title">正文注入实时预览（${h(posLabel)} · ${narrative.length}/${st.injectMaxChars || 2000} 字）</div>
      <p class="we-outline-hint">大纲以【剧情指导】柔性注入主聊天，严格脱敏，仅含公开目标、公开提示与已显露暗线线索，绝不含幕后备注与作者总备忘。</p>
      <p class="we-outline-hint">${h(orderLine)}</p>
      <pre>${h(narrative || '（当前未启用、无大纲或大纲已完结，本轮不向主聊天注入）')}</pre>
    </section>`;

    const backSec = `<section class="we-section we-outline-inject-preview">
      <div class="we-section-title">世界引擎后台指导（${world.length}/${st.worldInjectMaxChars || 2000} 字）</div>
      <p class="we-outline-hint">仅在世界引擎后台推演时作为只读背景提供（含暗线幕后备注），绝不进入主聊天。</p>
      <pre>${h(world || '（未开启向世界提供后台指导，或当前无大纲）')}</pre>
    </section>`;

    const sharedViewer = window.WORLD_ENGINE_UI?.renderLastPromptViewer?.({ focus: 'outline' }) || '';
    const promptSec = sharedViewer ? `<section class="we-section we-outline-last-prompt">
      <div class="we-section-title">上次正文生成完整提示词（含三模块顺序）</div>
      ${sharedViewer}
    </section>` : '';

    return header + frontSec + backSec + promptSec;
  }

  // ==================== 整理文本浮层 ====================

  function renderPlanPreview(plan) {
    const chapters = plan?.chapters || [];
    const tracks = plan?.tracks || [];
    const nodes = plan?.nodes || [];
    return `<div class="we-outline-plan-preview">
      <h4>${h(plan?.title || '未命名大纲')}</h4>
      ${plan?.publicSynopsis ? `<p>${h(plan.publicSynopsis)}</p>` : ''}
      <p class="we-outline-hint">${chapters.length} 章 · ${tracks.length} 条剧情线 · ${nodes.length} 个节点（尚未落盘，确认采用后覆盖当前大纲计划）</p>
      ${chapters.map((ch, idx) => {
        const cNodes = nodes.filter(n => (n.chapterIds || []).includes(ch.id));
        return `<details open><summary>第 ${idx + 1} 章 · ${h(ch.title || '未命名章节')}</summary>
          ${ch.goal ? `<p>${h(ch.goal)}</p>` : ''}
          <ol>${cNodes.map(n => `<li><strong>${h(n.title)}</strong>${n.publicHint ? `<p>公开提示：${h(n.publicHint)}</p>` : ''}${n.completionCriteria ? `<p>达成条件：${h(n.completionCriteria)}</p>` : ''}</li>`).join('') || '<li>暂无绑定节点</li>'}</ol>
        </details>`;
      }).join('')}
    </div>`;
  }

  function renderTextOverlay() {
    const d = getDraft();
    const running = engine()?.isRunning?.() === true;
    return `${subTopbar('整理文本', '删繁就简', 'close-text')}
      <section class="we-section we-outline-text-import">
        <div class="we-section-title">将大纲文本智能拆分为多线节点</div>
        <p class="we-outline-hint">支持粘贴自然语言大纲或导入 .txt / .md。AI 只做结构化拆分，不私自扩写剧情，整理结果需你确认后才覆盖生效。</p>
        <label class="we-outline-field">
          <span>粘贴主线、支线、暗线及章节安排，或选择文件</span>
          <textarea id="we-outline-source-text" rows="9" placeholder="例如：\n第一章 初入青石镇：主角避雨入住客栈，结识药师沈清秋，发现镇上水源异常。\n暗线：镇长暗中与北境密使勾结。">${h(d.sourceText || '')}</textarea>
        </label>
        <input id="we-outline-text-file" type="file" accept=".txt,.md,text/plain,text/markdown">
        <div class="we-outline-actions">
          ${button('organize-text', running ? '正在整理…' : 'AI整理并预览', running ? ' disabled' : '', 'primary')}
          ${button('close-text', '收起（保留文本）')}
          ${running ? button('abort', '停止', '', 'danger') : ''}
        </div>
      </section>
      ${d.textPreview ? `<section class="we-section we-outline-preview">
        ${renderPlanPreview(d.textPreview)}
        <div class="we-outline-actions">
          ${button('adopt-preview', '确认采用整理结果', '', 'primary')}
          ${button('discard-preview', '丢弃预览', '', 'danger')}
        </div>
      </section>` : ''}`;
  }

  // ==================== 调试内容（局部刷新用） ====================

  function renderDebugContent() {
    const dbg = engine()?.getLastDebug?.() || {};
    const errText = engine()?.getLastError?.() || '';
    const sharedViewer = window.WORLD_ENGINE_UI?.renderLastPromptViewer?.({ focus: 'outline' }) || '';
    return `<div class="we-outline-debug">
      ${errText ? `<p class="we-outline-message is-error">最近错误：${h(errText)}</p>` : '<p class="we-outline-hint">当前无运行错误</p>'}
      ${dbg.request ? `<details><summary>最近一次请求（${h(dbg.request.label)} · 第 ${h(dbg.request.attempt)} 次 · ${dbg.request.ok ? '成功' : '失败'}）</summary><pre>${h(dbg.request.rawResult || '')}</pre></details>` : ''}
      ${sharedViewer}
    </div>`;
  }

  // ==================== 设置页（与世界/记忆 100% 统一的 6 标签页布局） ====================

  function renderSettings(st) {
    const d = getDraft();
    const s = d.settingsDraft || clone(st);
    const activeTab = SETTINGS_TABS.some(t => t.key === d.settingsTab) ? d.settingsTab : 'common';
    d.settingsTab = activeTab;
    const outlineVersion = settingsApi()?.VERSION || '3.0.0';
    const curTheme = getStoredOutlineTheme();
    const runningLabel = engine()?.getRunningLabel?.() || '';
    const apiTimeoutSec = Math.max(0, Math.round((Number.isFinite(Number(s.apiTimeoutMs)) ? Number(s.apiTimeoutMs) : 120000) / 1000));
    const idleTimeoutSec = Math.max(0, Math.round((Number.isFinite(Number(s.streamIdleTimeoutMs)) ? Number(s.streamIdleTimeoutMs) : 90000) / 1000));
    const effortVal = String(s.reasoningEffort || '').trim().toLowerCase();

    const apiBody = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
        ${button('copy-world-api', '填入世界引擎地址/Key')}
      </div>
      ${settingSelect('连接方式', 'connectionMode', s.connectionMode || 'direct', [['direct', '直连（默认）'], ['proxy', '经酒馆代理（解决跨域 CORS）']], '连不上或控制台报 CORS 错误时，切到「经酒馆代理」由酒馆服务端转发。')}
      ${settingInput('剧情大纲 API URL（OpenAI 兼容）', 'apiUrl', s.apiUrl || '', { placeholder: 'https://api.openai.com/v1', hint: '填到「版本前缀」一级即可，/chat/completions 可加可不加。' })}
      ${settingInput('剧情大纲 API Key', 'apiKey', s.apiKey || '', { type: 'password' })}
      <div class="we-input-group" style="display:flex;gap:6px;align-items:end;">
        <div style="flex:1;">
          <label>模型</label>
          <input id="we-outline-model" data-outline-setting="model" type="text" value="${h(s.model || '')}" placeholder="模型名称" style="width:100%;">
        </div>
        ${button('fetch-models', d.fetchingModels ? '获取中…' : '获取列表', ` id="we-outline-fetch-models"${d.fetchingModels ? ' disabled' : ''} style="white-space:nowrap;flex-shrink:0;"`)}
        ${button('test-api', d.testingApi ? '测试中…' : '测试请求', ` id="we-outline-test-api"${d.testingApi ? ' disabled' : ''} style="white-space:nowrap;flex-shrink:0;"`)}
      </div>
      <div class="we-input-group">
        <select id="we-outline-model-list" style="${Array.isArray(d.fetchedModels) && d.fetchedModels.length ? '' : 'display:none;'}width:100%;margin-top:4px;">
          <option value="">-- 选择模型${Array.isArray(d.fetchedModels) && d.fetchedModels.length ? `（共 ${d.fetchedModels.length} 个）` : ''} --</option>
          ${(d.fetchedModels || []).map(m => `<option value="${h(m)}"${String(s.model || '') === String(m) ? ' selected' : ''}>${h(m)}</option>`).join('')}
        </select>
      </div>
      ${d.apiTestStatus ? `<div class="we-outline-field-hint" id="we-outline-api-test-status" style="margin-bottom:6px;${d.apiTestError ? 'color:var(--we-danger);' : ''}">${h(d.apiTestStatus)}</div>` : ''}
      <div class="we-input-group" style="display:flex;gap:6px;">
        ${settingCompactField('温度', 'temperature', s.temperature ?? 0.2, { type: 'number', min: 0, max: 2, step: 0.05 })}
        ${settingCompactField('最大输出 token', 'maxTokens', s.maxTokens ?? 8192, { type: 'number', min: 1, max: 1000000, step: 1 })}
      </div>
      ${settingInput('请求超时（秒）', 'apiTimeoutSec', apiTimeoutSec, { type: 'number', min: 0, max: 600, step: 1, hint: '超过该时间仍未收到完整响应会自动中止。0 = 不超时。' })}
      ${settingCheck('流式传输（stream）', 'stream', s.stream === true, '开启后按 SSE 流式增量接收响应，适合易等待超时或仅推荐流式的反代渠道。')}
      <details class="we-api-adv-fold">
        <summary>高级请求参数（流式空闲超时 / JSON 模式 / top_p / 推理力度）</summary>
        <div class="we-api-adv-body">
          ${settingInput('流式分片空闲超时（秒）', 'streamIdleTimeoutSec', idleTimeoutSec, { type: 'number', min: 0, max: 600, step: 1, hint: '开始收到流式数据后，超过该时间无新分片自动中止；0 = 仅用总超时。' })}
          ${settingCheck('强制 JSON 输出（response_format）', 'jsonMode', s.jsonMode === true, '在支持 OpenAI JSON 模式的渠道附带 response_format: json_object；部分反代若报 400 请关闭。')}
          <div class="we-input-group" style="display:flex;gap:6px;">
            <div style="flex:1;">
              <label>top_p（0–1，留空=默认）</label>
              <input id="we-outline-topP" data-outline-setting="topP" type="number" min="0" max="1" step="0.05" value="${s.topP == null ? '' : h(s.topP)}" placeholder="留空不传" style="width:100%;">
            </div>
            <div style="flex:1;">
              <label>推理力度（reasoning_effort）</label>
              <select id="we-outline-reasoningEffort" data-outline-setting="reasoningEffort" style="width:100%;">
                <option value=""${!effortVal ? ' selected' : ''}>默认（不传）</option>
                <option value="minimal"${effortVal === 'minimal' ? ' selected' : ''}>极低（minimal）</option>
                <option value="low"${effortVal === 'low' ? ' selected' : ''}>低（low）</option>
                <option value="medium"${effortVal === 'medium' ? ' selected' : ''}>中（medium）</option>
                <option value="high"${effortVal === 'high' ? ' selected' : ''}>高（high）</option>
              </select>
            </div>
          </div>
        </div>
      </details>`;

    const rhythmBody = `
      ${settingCheck('启用剧情模块', 'engineEnabled', s.engineEnabled === true, '关闭后仅停用自动检查与正文注入，仍可随时新建、编辑或删除大纲，不影响世界引擎与记忆引擎。')}
      ${settingCheck('首楼为 AI 开场白', 'firstLayerIsAiOpening', s.firstLayerIsAiOpening !== false, '默认勾选：第 0 层不计入自动检查轮次与进度核对；取消勾选后，第 0 层按普通对话参与核对。')}
      ${settingCheck('自动检查新增正文', 'autoCheck', s.autoCheck !== false, '开启后每累积指定新增 AI 轮次自动调用 API 核对节点状态；关闭则仅手动触发。')}
      <div class="we-input-group" style="display:flex;gap:6px;">
        ${settingCompactField('每 N 轮核对一次', 'checkEveryX', s.checkEveryX ?? 3, { type: 'number', min: 1, max: 1000, step: 1 })}
        ${settingCompactField('JSON 纠错重试次数', 'formatMaxRetries', s.formatMaxRetries ?? 2, { type: 'number', min: 0, max: 5, step: 1 })}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${button('check-now', '立即检查正文', '', 'primary')}
      </div>
      <div class="we-hint" id="we-outline-task-status" style="margin-top:8px;">${runningLabel ? `正在进行${h(runningLabel)}` : '当前没有运行中的剧情任务'}</div>`;

    const injectBody = `
      ${settingCheck('注入正文指导', 'injectIntoPrompt', s.injectIntoPrompt !== false, '按当前章节与已解锁节点注入防剧透公开版【剧情指导】，绝不泄露幕后备注与暗线真相。')}
      ${settingSelect('注入位置', 'injectPosition', s.injectPosition ?? 1, [['1', '聊天内按深度（推荐）'], ['0', '主提示词内（IN_PROMPT）'], ['2', '主提示词之前']])}
      <div class="we-input-group" style="display:flex;gap:6px;">
        ${settingCompactField('注入深度', 'injectDepth', s.injectDepth ?? 1, { type: 'number', min: 0, max: 20, step: 1, disabled: Number(s.injectPosition ?? 1) !== 1 })}
        ${settingCompactField('每轮最多安排节点', 'narrativeLimit', s.narrativeLimit ?? 4, { type: 'number', min: 1, max: 20, step: 1 })}
      </div>
      ${settingInput('前台注入字数上限', 'injectMaxChars', s.injectMaxChars ?? 2000, { type: 'number', min: 200, max: 20000, step: 100, hint: '限制注入正文的剧情指导篇幅，优先保留主线节点与当前章焦点。' })}`;

    const bridgeSummary = window.STORY_ENGINE_BRIDGE?.getStatusSummary?.() || null;
    const effectiveCoordMode = (d.coordinationMode === 'independent' || d.coordinationMode === 'stagger-serial')
      ? d.coordinationMode
      : (window.STORY_ENGINE_BRIDGE?.getCoordinationMode?.() || 'stagger-serial');
    const bridgeHint = bridgeSummary
      ? `当前已开启模块：${[bridgeSummary.worldEnabled && '世界', bridgeSummary.memoryEnabled && '记忆', bridgeSummary.outlineEnabled && '大纲'].filter(Boolean).join(' · ') || '无'} · 正文注入顺序：世界 → 记忆 → 大纲`
      : '未加载协同桥（当前处于严格独立模式；停用任一模块不影响其余模块工作）';

    const bridgeBody = `
      <div class="we-hint" style="margin-bottom:8px;">${h(bridgeHint)}</div>
      <div class="we-input-group">
        <label>同轮多模块 API 并发调度策略</label>
        <select id="we-outline-coordinationMode" style="width:100%;">
          <option value="stagger-serial"${effectiveCoordMode !== 'independent' ? ' selected' : ''}>串行错峰管道（推荐 · 世界 → 大纲 → 记忆，防限流）</option>
          <option value="independent"${effectiveCoordMode === 'independent' ? ' selected' : ''}>各自独立并发（无排队，按各自原定时器直发）</option>
        </select>
        <div class="we-outline-field-hint">三个模块共享此调度策略，启用 ≥2 个后台引擎时自动错峰，仅启用单个引擎时始终立即直通。</div>
      </div>`;

    const worldLinkBody = `
      ${settingCheck('提供后台指导给世界引擎', 'injectIntoWorldEngine', s.injectIntoWorldEngine !== false, '开启后，世界后台推演会收到含暗线幕后备注的只读指导，绝不进入主聊天。')}
      ${settingInput('后台指导字数上限', 'worldInjectMaxChars', s.worldInjectMaxChars ?? 2000, { type: 'number', min: 300, max: 10000, step: 100 })}
      ${settingCheck('核对进度时参考世界公开动态（只读）', 'useWorldReference', s.useWorldReference !== false, '允许大纲后台核对参考世界公开摘要与大势；关闭后完全脱离世界状态独立判定。')}`;

    const memoryLinkBody = `
      ${settingCheck('向记忆引擎提供公开章节焦距与活跃角色（只读）', 'injectIntoMemoryEngine', s.injectIntoMemoryEngine !== false, '仅提供公开章节与关联角色用于记忆热层焦距对齐，不向记忆 7 表写数据，未显露暗线始终隔离。')}
      ${settingCheck('核对进度时参考记忆 7 表摘要（只读）', 'useMemoryReference', s.useMemoryReference !== false, '允许核对时单向只读参考记忆引擎摘要作为背景参考。')}`;

    const retryBody = settingInput('API 异常自动重试次数（X）', 'apiAutoRetries', s.apiAutoRetries ?? 0, { type: 'number', min: 0, max: 10, step: 1, hint: '仅连接、HTTP、超时或空返回等故障才重试；正常解析为空变更不算错误。' });
    const displayBody = `
      <div class="we-input-group">
        <label>剧情大纲主题配色</label>
        <select id="we-outline-theme-select" style="width:100%;">
          ${THEMES.map(t => `<option value="${t.id}"${t.id === curTheme ? ' selected' : ''}>${h(t.name)}</option>`).join('')}
        </select>
        <div class="we-outline-field-hint">只影响剧情大纲面板并独立记忆；切回世界或记忆引擎时自动恢复对应模块自己的配色。</div>
      </div>`;

    const syncBody = `
      ${settingCheck('实时同步到酒馆聊天', 'syncToChat', s.syncToChat === true, '开启同步后，大纲计划与进度会随酒馆聊天保存；API Key 等全局设置不会写入聊天。')}
      ${settingCheck('自动备份', 'autoBackup', s.autoBackup === true, '变更时自动留存聊天备份保存点（最多 3 份）。')}`;

    const cc = chatCache();
    const snaps = cc?.listSnapshots?.() || [];
    const snapshotBody = `
      <div class="we-outline-actions we-outline-snap-create">
        <input id="we-outline-snap-name" value="${h(d.snapshotName || '')}" placeholder="保存点名称（可选）">
        ${button('snap-create', '新建命名保存点', cc ? '' : ' disabled', 'primary')}
      </div>
      <div class="we-chatcache-list">
        ${snaps.length ? [...snaps].reverse().map(sn => `<div class="we-snapshot-row">
          <div class="we-snapshot-main">
            <div class="we-snapshot-name"><span class="we-snapshot-badge${sn.auto ? ' is-auto' : ''}">${sn.auto ? '自动' : '手动'}</span>${h(sn.name || '未命名保存点')}</div>
            <div class="we-snapshot-meta">${h(sn.createdAt ? new Date(sn.createdAt).toLocaleString() : '')}</div>
          </div>
          <div class="we-snapshot-actions">
            ${button('snap-restore', '恢复', ` data-id="${h(sn.id)}"`)}
            ${button('snap-delete', '删除', ` data-id="${h(sn.id)}"`, 'danger')}
          </div>
        </div>`).join('') : '<div class="we-empty" style="padding:10px;">暂无剧情保存点</div>'}
      </div>`;

    const dataBody = `
      <div class="we-outline-actions">
        ${button('export-json', '导出大纲 JSON')}
        ${button('clear-outline', '清空当前大纲', '', 'danger')}
      </div>
      <div class="we-input-group" style="margin-top:8px;margin-bottom:0;">
        <label>导入大纲 JSON（兼容 v1/v2/v3，先预览再写入）</label>
        <input id="we-outline-json-file" type="file" accept=".json,application/json" style="width:100%;">
        <div class="we-outline-field-hint">清空前会自动留存一份聊天备份保存点；跨聊天导入会清除来源聊天的运行进度。</div>
      </div>`;

    const debugBody = `<button class="we-btn" type="button" data-outline-action="export-diag" style="width:100%;margin-bottom:8px;">导出诊断包</button><div id="we-outline-debug-render">${renderDebugContent()}</div>`;

    const aboutBody = `
      <div class="we-about-current"><span class="we-changelog-cur">剧情大纲 v${h(outlineVersion)}</span></div>
      <div class="we-section" style="margin-top:10px;">
        <div class="we-section-title">剧情大纲 ${h(outlineVersion)}</div>
        <div style="font-size:12px;color:var(--we-text2);line-height:1.7;">
          轻量化跨章节多线剧情引擎。围绕「章节 → 主/支/暗线 → 节点」三层极简结构运行，支持按楼层号 0ms 本地回退与防剧透双轨注入（前台公开指导 + 世界后台幕后备忘），与世界和记忆引擎保持弱联动、互不锁死。
        </div>
      </div>
      <div class="we-section" style="margin-top:10px;">
        <div class="we-section-title">v3.0.0 · 轻量化架构重构与 0ms 楼层回退（2026-11-23）</div>
        <ul class="we-changelog-items">
          <li>砍除 11 类嵌套布尔条件树、五层线索知情表与强耦合联合历史锁；收敛为直观三层结构（章节 → 主/支/暗线 → 节点），自动无损迁移旧版 v1/v2 存档。</li>
          <li>改用按楼层号 0ms 本地回退，删楼/滑动/重 Roll 秒级撤回失效自动进度并保留手动覆盖，彻底消灭 blocked 红牌锁死，不再影响世界与记忆引擎运行。</li>
          <li>修复冷却漏检主线节点与空门槛卡章问题；补齐 JSON 带错回灌纠错重试、防剧透双轨注入硬预算控制与三页两字单屏 UI（进度 / 剧情 / 注入）。</li>
        </ul>
      </div>`;

    const panelContent = {
      common: settingsSection(d, 'set-outline-api', '剧情大纲 API', apiBody)
        + settingsSection(d, 'set-outline-evolve', '剧情检查与节奏', rhythmBody)
        + settingsSection(d, 'set-outline-inject', '剧情指导注入', injectBody),
      link: settingsSection(d, 'set-outline-bridge', '三模块协同调度', bridgeBody)
        + settingsSection(d, 'set-outline-world-link', '与世界引擎联动', worldLinkBody)
        + settingsSection(d, 'set-outline-memory-link', '与记忆引擎联动', memoryLinkBody),
      advanced: settingsSection(d, 'set-outline-retry', 'API 自动重试', retryBody)
        + settingsSection(d, 'set-outline-display', '界面显示', displayBody),
      archive: settingsSection(d, 'set-outline-sync', '同步与缓存', syncBody)
        + settingsSection(d, 'set-outline-snapshots', '聊天备份保存点', snapshotBody)
        + settingsSection(d, 'set-outline-data', '剧情数据导入 / 导出', dataBody),
      debug: settingsSection(d, 'set-outline-debug', '剧情推演调试', debugBody),
      about: aboutBody
    };

    const tabBar = `<div class="we-settings-tabs-shell">
      <button type="button" class="we-settings-tab-scroll" data-dir="-1" title="向左滚动"><i class="fa-solid fa-chevron-left"></i></button>
      <div class="we-settings-tabs" id="we-settings-tabs">
        ${SETTINGS_TABS.map(tab => `<button type="button" class="we-settings-tab${tab.key === activeTab ? ' we-settings-tab--active' : ''}" data-tab="${tab.key}">${h(tab.label)}</button>`).join('')}
      </div>
      <button type="button" class="we-settings-tab-scroll" data-dir="1" title="向右滚动"><i class="fa-solid fa-chevron-right"></i></button>
    </div>`;

    const panels = SETTINGS_TABS.map(tab =>
      `<div class="we-settings-panel" data-tab="${tab.key}"${tab.key === activeTab ? '' : ' style="display:none;"'}>${panelContent[tab.key] || ''}</div>`
    ).join('');

    return `${subTopbar('设置', '工欲善其事，必先利其器', 'close-settings')}
      ${tabBar}${panels}
      <div class="we-settings-save-actions we-settings-save-sticky">
        ${button('save-settings', '保存设置', '', 'primary')}
      </div>`;
  }

  function renderImportReview() {
    const d = getDraft();
    if (!d.pendingImport) return '';
    const p = d.pendingImport;
    const plan = p.payload?.state?.plan || p.payload?.plan || p.payload;
    return `<section class="we-section we-outline-preview we-outline-import-review">
      <h3>确认大纲导入</h3>
      <p class="we-outline-hint">来源：${h(plan?.title || p.fileName || '未命名')} · ${(plan?.chapters || []).length} 章 / ${(plan?.nodes || []).length} 节点</p>
      ${p.sameChat ? `<label class="we-outline-check"><input type="checkbox" id="we-outline-import-keep-progress" checked><span>保留此聊天的原执行进度</span></label>` : '<p class="we-outline-hint">跨聊天导入：执行进度将从当前聊天重新开始。</p>'}
      <div class="we-outline-actions">
        ${button('confirm-import', '确认导入', '', 'primary')}
        ${button('cancel-import', '取消导入')}
      </div>
    </section>`;
  }

  function render() {
    const d = getDraft();
    const state = loadState();
    const st = loadSettings();
    let body = '';
    if (d.settingsOpen) body = renderSettings(st);
    else if (d.textOpen) body = renderTextOverlay();
    else if (d.view === 'progress') body = renderProgressView(state);
    else if (d.view === 'tracks') body = renderTracksView(state);
    else if (d.view === 'schedule') body = renderScheduleView(state, st);
    else body = renderHome(state, st);

    return `<div class="we-outline-root">${renderImportReview()}${body}</div>`;
  }

  // ==================== 计划原子修改与事件处理 ====================

  function mutatePlan(mutator, toastMsg) {
    const state = loadState();
    const nextPlan = clone(state.plan || data().emptyPlan());
    mutator(nextPlan, state);
    engine()?.abort?.();
    data().commitPlan(nextPlan, state.revision);
    engine()?.applyInjection?.();
    if (toastMsg) showToast(toastMsg);
  }

  function moveInArray(arr, index, delta) {
    const target = index + delta;
    if (index < 0 || target < 0 || target >= arr.length) return false;
    const [item] = arr.splice(index, 1);
    arr.splice(target, 0, item);
    return true;
  }

  function captureInlineField(el) {
    const d = getDraft();
    if (!d.inlineEdit) return;
    const f = d.inlineEdit.data;
    if (el.dataset?.inlineField) {
      const k = el.dataset.inlineField;
      if (k === 'actorsText') {
        f.actors = String(el.value || '').split(/[,，、\n]/).map(clean).filter(Boolean);
      } else {
        f[k] = el.value;
        if (k === 'trackId' && d.inlineEdit.kind === 'node') refresh();
      }
    } else if (el.dataset?.inlineBool) {
      f[el.dataset.inlineBool] = Boolean(el.checked);
    } else if (el.dataset?.inlineChapters) {
      const cid = el.dataset.inlineChapters;
      const set = new Set(f.chapterIds || []);
      if (el.checked) set.add(cid); else set.delete(cid);
      f.chapterIds = [...set];
    } else if (el.dataset?.inlineDeps) {
      const nid = el.dataset.inlineDeps;
      const set = new Set(f.dependencies || []);
      if (el.checked) set.add(nid); else set.delete(nid);
      f.dependencies = [...set];
    }
  }

  function captureSettingField(el) {
    const d = getDraft();
    if (!d.settingsDraft) d.settingsDraft = clone(loadSettings());
    const key = el.dataset?.outlineSetting;
    if (!key) return;
    if (el.type === 'checkbox') {
      d.settingsDraft[key] = Boolean(el.checked);
      return;
    }
    const raw = String(el.value ?? '').trim();
    if (key === 'apiTimeoutSec') {
      const n = parseInt(raw, 10);
      d.settingsDraft.apiTimeoutMs = (Number.isFinite(n) ? Math.max(0, Math.min(600, n)) : 120) * 1000;
      return;
    }
    if (key === 'streamIdleTimeoutSec') {
      const n = parseInt(raw, 10);
      d.settingsDraft.streamIdleTimeoutMs = (Number.isFinite(n) ? Math.max(0, Math.min(600, n)) : 90) * 1000;
      return;
    }
    if (key === 'topP') {
      d.settingsDraft.topP = raw === '' ? null : (Number.isFinite(Number(raw)) ? Number(raw) : null);
      return;
    }
    if (key === 'temperature') {
      d.settingsDraft.temperature = raw === '' ? 0.2 : (Number.isFinite(Number(raw)) ? Number(raw) : 0.2);
      return;
    }
    if (['maxTokens', 'checkEveryX', 'formatMaxRetries', 'injectPosition', 'injectDepth', 'injectMaxChars', 'narrativeLimit', 'worldInjectMaxChars', 'apiAutoRetries'].includes(key)) {
      const fallback = settingsApi()?.DEFAULTS?.[key] ?? 0;
      const n = parseInt(raw, 10);
      d.settingsDraft[key] = raw === '' || !Number.isFinite(n) ? fallback : n;
      if (key === 'injectPosition') refresh();
      return;
    }
    d.settingsDraft[key] = el.value;
  }

  function captureInput(el) {
    if (!el) return;
    const d = getDraft();
    if (el.id === 'we-outline-theme-select') { setStoredOutlineTheme(el.value); return; }
    if (el.id === 'we-outline-coordinationMode') {
      d.coordinationMode = el.value === 'independent' ? 'independent' : 'stagger-serial';
      return;
    }
    if (el.id === 'we-outline-snap-name') { d.snapshotName = el.value || ''; return; }
    if (el.id === 'we-outline-source-text') { d.sourceText = el.value || ''; return; }
    if (el.id === 'we-outline-model-list') {
      if (!el.value) return;
      if (!d.settingsDraft) d.settingsDraft = clone(loadSettings());
      d.settingsDraft.model = el.value;
      const modelInput = typeof document !== 'undefined' ? document.getElementById('we-outline-model') : null;
      if (modelInput) modelInput.value = el.value;
      return;
    }
    captureInlineField(el);
    captureSettingField(el);
  }

  async function handleAction(action, el = { dataset: {} }) {
    const d = getDraft();
    const id = el?.dataset?.id || '';

    if (action === 'view-home') { d.view = 'home'; d.settingsOpen = false; d.textOpen = false; d.inlineEdit = null; refresh(); return; }
    if (action === 'view-progress') { d.view = 'progress'; d.settingsOpen = false; d.textOpen = false; d.inlineEdit = null; refresh(); return; }
    if (action === 'view-tracks') { d.view = 'tracks'; d.settingsOpen = false; d.textOpen = false; d.inlineEdit = null; refresh(); return; }
    if (action === 'view-schedule') { d.view = 'schedule'; d.settingsOpen = false; d.textOpen = false; d.inlineEdit = null; refresh(); return; }
    if (action === 'toggle-settings') {
      d.settingsOpen = !d.settingsOpen;
      d.settingsDraft = d.settingsOpen ? clone(loadSettings()) : null;
      d.coordinationMode = d.settingsOpen ? (window.STORY_ENGINE_BRIDGE?.getCoordinationMode?.() || null) : null;
      refresh();
      return;
    }
    if (action === 'close-settings') { d.settingsOpen = false; d.settingsDraft = null; refresh(); return; }
    if (action === 'open-text') { d.textOpen = true; d.settingsOpen = false; refresh(); return; }
    if (action === 'close-text') { d.textOpen = false; refresh(); return; }
    if (action === 'mode-track') { d.boardMode = 'track'; d.inlineEdit = null; refresh(); return; }
    if (action === 'mode-chapter') { d.boardMode = 'chapter'; d.inlineEdit = null; refresh(); return; }
    if (action === 'select-chapter') { d.selectedChapterId = id; d.inlineEdit = null; refresh(); return; }
    if (action === 'toggle-node') { d.expandedNodes[id] = !d.expandedNodes[id]; refresh(); return; }
    if (action === 'cancel-inline') { d.inlineEdit = null; refresh(); return; }
    if (action === 'cancel-track-del') { d.confirmDeleteTrackId = null; refresh(); return; }
    if (action === 'discard-preview') { d.textPreview = null; refresh(); return; }
    if (action === 'cancel-import') { d.pendingImport = null; refresh(); return; }
    if (action === 'abort') { engine()?.abort?.(); showToast('已停止大纲任务'); return; }

    if (action === 'check-now') {
      try {
        const res = await engine().checkNow();
        if (res?.skipped) showToast(`已跳过核对（${res.reason}）`);
        else showToast(`核对完成：${res?.applied?.length || 0} 项节点更新`);
      } catch (err) {
        if (err?.name !== 'AbortError') showToast(`核对失败：${err?.message || err}`, true);
      }
      refresh();
      return;
    }

    if (action === 'set-chapter') {
      data().setCurrentChapter(id);
      d.selectedChapterId = id;
      engine()?.applyInjection?.();
      showToast('已切换当前章节');
      refresh();
      return;
    }

    if (action === 'toggle-reveal') {
      mutatePlan(plan => {
        const node = plan.nodes.find(n => n.id === id);
        if (node) node.revealPublic = !node.revealPublic;
      }, '已更新暗线台前显露状态');
      refresh();
      return;
    }

    // 快捷新增 / 编辑表单
    if (action === 'edit-plan-meta') {
      const p = loadState().plan;
      d.inlineEdit = {
        kind: 'plan', isNew: false, id: 'plan',
        data: { title: p.title, publicSynopsis: p.publicSynopsis, publicConstraints: p.publicConstraints, authorNotes: p.authorNotes }
      };
      refresh();
      return;
    }
    if (action === 'add-chapter') {
      d.inlineEdit = { kind: 'chapter', isNew: true, id: '', data: { title: `第 ${(loadState().plan.chapters?.length || 0) + 1} 章`, goal: '' } };
      refresh();
      return;
    }
    if (action === 'edit-chapter') {
      const ch = (loadState().plan.chapters || []).find(c => c.id === id);
      if (!ch) return;
      d.inlineEdit = { kind: 'chapter', isNew: false, id, data: clone(ch) };
      refresh();
      return;
    }
    if (action === 'add-track') {
      d.inlineEdit = { kind: 'track', isNew: true, id: '', data: { title: '', kind: 'side', goal: '' } };
      refresh();
      return;
    }
    if (action === 'edit-track') {
      const tr = (loadState().plan.tracks || []).find(t => t.id === id);
      if (!tr) return;
      d.inlineEdit = { kind: 'track', isNew: false, id, data: clone(tr) };
      refresh();
      return;
    }
    if (action === 'add-node') {
      const st = loadState();
      const tracks = st.plan.tracks || [];
      const defaultTrackId = el.dataset.track || (tracks.find(t => t.kind === 'main') || tracks[0])?.id || '';
      const defaultChId = el.dataset.chapter || d.selectedChapterId || st.currentChapterId || st.plan.chapters?.[0]?.id || '';
      d.inlineEdit = {
        kind: 'node', isNew: true, id: '',
        data: {
          title: '',
          trackId: defaultTrackId,
          chapterIds: defaultChId ? [defaultChId] : [],
          dependencies: [],
          publicHint: '',
          completionCriteria: '',
          secretNotes: '',
          required: true,
          revealPublic: false,
          actors: []
        }
      };
      refresh();
      return;
    }
    if (action === 'edit-node') {
      const node = data().getNode(loadState(), id);
      if (!node) return;
      d.expandedNodes[id] = true;
      d.inlineEdit = { kind: 'node', isNew: false, id, data: clone(node) };
      refresh();
      return;
    }

    if (action === 'save-inline') {
      if (!d.inlineEdit) return;
      const { kind, isNew, id: editId, data: form } = d.inlineEdit;
      try {
        mutatePlan(plan => {
          if (kind === 'plan') {
            plan.title = clean(form.title);
            plan.publicSynopsis = clean(form.publicSynopsis);
            plan.publicConstraints = clean(form.publicConstraints);
            plan.authorNotes = clean(form.authorNotes);
          } else if (kind === 'chapter') {
            if (isNew) plan.chapters.push({ id: '', title: clean(form.title) || `第 ${plan.chapters.length + 1} 章`, goal: clean(form.goal) });
            else {
              const target = plan.chapters.find(c => c.id === editId);
              if (target) { target.title = clean(form.title) || target.title; target.goal = clean(form.goal); }
            }
          } else if (kind === 'track') {
            if (isNew) plan.tracks.push({ id: '', kind: form.kind || 'side', title: clean(form.title) || '新剧情线', goal: clean(form.goal), paused: false });
            else {
              const target = plan.tracks.find(t => t.id === editId);
              if (target) { target.title = clean(form.title) || target.title; target.kind = form.kind || target.kind; target.goal = clean(form.goal); }
            }
          } else if (kind === 'node') {
            if (!plan.tracks.length) plan.tracks.push({ id: 'main', kind: 'main', title: '主线剧情', goal: '', paused: false });
            const payload = { ...form, title: clean(form.title) || '未命名节点', trackId: form.trackId || plan.tracks[0].id };
            if (isNew) plan.nodes.push(payload);
            else {
              const idx = plan.nodes.findIndex(n => n.id === editId);
              if (idx >= 0) plan.nodes[idx] = { ...plan.nodes[idx], ...payload, id: editId };
            }
          }
        }, '已保存');
        d.inlineEdit = null;
      } catch (err) {
        showToast(err?.message || String(err), true);
      }
      refresh();
      return;
    }

    // 排序与删除
    if (action === 'chapter-up' || action === 'chapter-down') {
      mutatePlan(plan => {
        const idx = plan.chapters.findIndex(c => c.id === id);
        moveInArray(plan.chapters, idx, action === 'chapter-up' ? -1 : 1);
      });
      refresh();
      return;
    }
    if (action === 'track-up' || action === 'track-down') {
      mutatePlan(plan => {
        const idx = plan.tracks.findIndex(t => t.id === id);
        moveInArray(plan.tracks, idx, action === 'track-up' ? -1 : 1);
      });
      refresh();
      return;
    }
    if (action === 'node-up' || action === 'node-down') {
      mutatePlan(plan => {
        const idx = plan.nodes.findIndex(n => n.id === id);
        moveInArray(plan.nodes, idx, action === 'node-up' ? -1 : 1);
      });
      refresh();
      return;
    }
    if (action === 'track-pause') {
      mutatePlan(plan => {
        const tr = plan.tracks.find(t => t.id === id);
        if (tr) tr.paused = !tr.paused;
      }, '已切换剧情线暂停状态');
      refresh();
      return;
    }
    if (action === 'remove-chapter') {
      if (!confirm('确认删除该章节？章内节点将保留为全篇跨章节点。')) return;
      mutatePlan(plan => {
        plan.chapters = plan.chapters.filter(c => c.id !== id);
        for (const n of plan.nodes) n.chapterIds = (n.chapterIds || []).filter(cid => cid !== id);
      }, '已删除章节');
      refresh();
      return;
    }
    if (action === 'remove-node') {
      if (!confirm('确认删除该剧情节点？')) return;
      mutatePlan(plan => {
        plan.nodes = plan.nodes.filter(n => n.id !== id);
        for (const n of plan.nodes) n.dependencies = (n.dependencies || []).filter(dep => dep !== id);
      }, '已删除节点');
      refresh();
      return;
    }
    if (action === 'remove-track') {
      const trNodes = data().getTrackNodes(loadState(), id);
      if (trNodes.length) {
        d.confirmDeleteTrackId = id;
        refresh();
        return;
      }
      if (!confirm('确认删除该空剧情线？')) return;
      mutatePlan(plan => { plan.tracks = plan.tracks.filter(t => t.id !== id); }, '已删除剧情线');
      refresh();
      return;
    }
    if (action === 'confirm-track-del-move' || action === 'confirm-track-del-all') {
      mutatePlan(plan => {
        const other = plan.tracks.find(t => t.id !== id);
        if (action === 'confirm-track-del-move' && other) {
          for (const n of plan.nodes) if (n.trackId === id) n.trackId = other.id;
        } else {
          const drop = new Set(plan.nodes.filter(n => n.trackId === id).map(n => n.id));
          plan.nodes = plan.nodes.filter(n => !drop.has(n.id));
          for (const n of plan.nodes) n.dependencies = (n.dependencies || []).filter(dep => !drop.has(dep));
        }
        plan.tracks = plan.tracks.filter(t => t.id !== id);
      }, '已删除剧情线');
      d.confirmDeleteTrackId = null;
      refresh();
      return;
    }

    if (action === 'clear-outline') {
      if (!confirm('确认清空当前聊天的全部剧情大纲与进度？\n清空前会自动留存一份聊天备份保存点，不会删除任何聊天记录。')) return;
      engine().clearAllOutlineData({ backup: true });
      d.inlineEdit = null;
      d.selectedChapterId = null;
      showToast('已清空剧情大纲（已自动备份）');
      refresh();
      return;
    }

    // 整理文本
    if (action === 'organize-text') {
      const ta = typeof document !== 'undefined' ? document.getElementById('we-outline-source-text') : null;
      if (ta) d.sourceText = ta.value;
      try {
        const res = await engine().organizeText(d.sourceText);
        if (res?.ok && res.plan) {
          d.textPreview = res.plan;
          showToast('整理完成，请核对预览后采用');
        }
      } catch (err) {
        if (err?.name !== 'AbortError') showToast(`整理失败：${err?.message || err}`, true);
      }
      refresh();
      return;
    }
    if (action === 'adopt-preview') {
      if (!d.textPreview) return;
      try {
        engine()?.abort?.();
        data().commitPlan(d.textPreview, loadState().revision);
        engine()?.applyInjection?.();
        d.textPreview = null;
        d.textOpen = false;
        d.view = 'tracks';
        showToast('已采用新剧情大纲');
      } catch (err) {
        showToast(err?.message || String(err), true);
      }
      refresh();
      return;
    }

    // 设置页动作
    if (action === 'copy-world-api') {
      const ws = window.WORLD_ENGINE_API?.getSettings?.(true) || {};
      if (!d.settingsDraft) d.settingsDraft = clone(loadSettings());
      d.settingsDraft.apiUrl = ws.apiUrl || '';
      d.settingsDraft.apiKey = ws.apiKey || '';
      if (ws.model) d.settingsDraft.model = ws.model;
      d.settingsDraft.connectionMode = ws.connectionMode === 'proxy' ? 'proxy' : 'direct';
      showToast('已填入世界引擎 API 地址/Key，请点「保存设置」生效');
      refresh();
      return;
    }
    if (action === 'fetch-models') {
      const s = d.settingsDraft || loadSettings();
      d.fetchingModels = true;
      refresh();
      try {
        const models = await window.WORLD_ENGINE_API?.fetchModelList?.({ apiUrl: s.apiUrl, apiKey: s.apiKey, connectionMode: s.connectionMode });
        d.fetchedModels = Array.isArray(models) ? models : [];
        showToast(`已获取 ${d.fetchedModels.length} 个模型`);
      } catch (err) {
        showToast(`获取模型列表失败：${err?.message || err}`, true);
      } finally {
        d.fetchingModels = false;
      }
      refresh();
      return;
    }
    if (action === 'test-api') {
      const s = d.settingsDraft || loadSettings();
      d.testingApi = true;
      d.apiTestError = false;
      d.apiTestStatus = '正在测试连接…';
      refresh();
      try {
        const res = await window.WORLD_ENGINE_API?.testConnection?.({ apiUrl: s.apiUrl, apiKey: s.apiKey, model: s.model, connectionMode: s.connectionMode });
        const ok = res?.ok !== false;
        d.apiTestError = !ok;
        d.apiTestStatus = ok ? `连接正常（${res?.latencyMs || 0}ms）` : `测试失败：${res?.error || '未知错误'}`;
      } catch (err) {
        d.apiTestError = true;
        d.apiTestStatus = `测试失败：${err?.message || err}`;
      } finally {
        d.testingApi = false;
      }
      refresh();
      return;
    }
    if (action === 'save-settings') {
      const next = d.settingsDraft || loadSettings();
      engine()?.abort?.();
      settingsApi().saveSettings(next);
      const coordEl = typeof document !== 'undefined' ? document.getElementById('we-outline-coordinationMode') : null;
      const modeVal = coordEl?.value || d.coordinationMode;
      if (modeVal === 'independent' || modeVal === 'stagger-serial') {
        window.STORY_ENGINE_BRIDGE?.setCoordinationMode?.(modeVal);
      }
      d.settingsDraft = null;
      d.coordinationMode = null;
      engine()?.applyInjection?.();
      showToast('剧情大纲设置已保存');
      refresh();
      return;
    }

    // 存档与导入导出
    if (action === 'snap-create') {
      const nameEl = typeof document !== 'undefined' ? document.getElementById('we-outline-snap-name') : null;
      const label = clean(nameEl?.value || d.snapshotName) || `手动存档 ${new Date().toLocaleTimeString()}`;
      const snap = chatCache()?.createSnapshot?.(label);
      if (snap) d.snapshotName = '';
      showToast(snap ? '已创建大纲保存点' : '创建保存点失败（当前聊天不可用）', !snap);
      refresh();
      return;
    }
    if (action === 'snap-restore') {
      if (!confirm('确认恢复此大纲保存点？当前状态会自动备份。')) return;
      const ok = await chatCache()?.restoreSnapshot?.(id);
      showToast(ok ? '已恢复保存点' : '恢复保存点失败', !ok);
      refresh();
      return;
    }
    if (action === 'snap-delete') {
      if (!confirm('确认删除此保存点？')) return;
      chatCache()?.deleteSnapshot?.(id);
      showToast('已删除保存点');
      refresh();
      return;
    }
    if (action === 'export-json') {
      const payload = data().exportData();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `outline-v3-${chatId().replace(/[^\w.-]+/g, '_').slice(0, 32)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if (action === 'confirm-import') {
      if (!d.pendingImport) return;
      const keepEl = typeof document !== 'undefined' ? document.getElementById('we-outline-import-keep-progress') : null;
      try {
        engine()?.abort?.();
        data().importData(d.pendingImport.payload, { includeProgress: keepEl ? keepEl.checked : false });
        engine()?.applyInjection?.();
        d.pendingImport = null;
        showToast('大纲导入成功');
      } catch (err) {
        showToast(`导入失败：${err?.message || err}`, true);
      }
      refresh();
      return;
    }
    if (action === 'export-diag') {
      window.WORLD_ENGINE_DIAG?.download?.('outline');
      return;
    }
  }

  function bind(body) {
    const root = body?.querySelector?.('.we-outline-root') || (typeof document !== 'undefined' ? document.querySelector('.we-outline-root') : null);
    if (!root) return;

    root.oninput = e => {
      try { captureInput(e.target); } catch (err) { showToast(err?.message || String(err), true); }
    };

    root.onchange = async e => {
      const el = e.target;
      if (!el) return;
      try {
        captureInput(el);
        if (el.dataset?.outlineStatus && el.value) {
          engine()?.abort?.();
          data().setNodeStatus(el.dataset.outlineStatus, el.value);
          engine()?.applyInjection?.();
          showToast('已更新节点状态');
          refresh();
          return;
        }
        if (el.id === 'we-outline-theme-select') {
          window.WORLD_ENGINE_UI?.refresh?.();
          return;
        }
        if (el.id === 'we-outline-text-file') {
          const file = el.files?.[0];
          if (!file) return;
          if (file.size > 5 * 1024 * 1024) { showToast('文本文件不得超过 5MB', true); return; }
          getDraft().sourceText = await file.text();
          el.value = '';
          refresh();
          return;
        }
        if (el.id === 'we-outline-json-file') {
          const file = el.files?.[0];
          if (!file) return;
          if (file.size > 32 * 1024 * 1024) { showToast('JSON 文件过大', true); return; }
          const parsed = JSON.parse(await file.text());
          const plan = parsed?.state?.plan || parsed?.plan || (Array.isArray(parsed?.chapters) ? parsed : null);
          if (!plan || !Array.isArray(plan.chapters)) throw new Error('缺少 plan.chapters 数组');
          const check = data().validatePlan(plan);
          if (!check.valid) throw new Error(check.errors.join('；'));
          const srcChat = clean(parsed?.chatId || parsed?.state?.originChatId);
          getDraft().pendingImport = { payload: parsed, fileName: file.name, sameChat: Boolean(srcChat && srcChat === chatId()) };
          el.value = '';
          refresh();
        }
      } catch (err) {
        showToast(`操作失败：${err?.message || err}`, true);
      }
    };

    root.onclick = async e => {
      const d = getDraft();

      const navRow = e.target?.closest?.('.we-outline-nav-row[data-outline-nav]');
      if (navRow && root.contains(navRow)) {
        e.preventDefault();
        const target = navRow.dataset.outlineNav;
        if (d.selectedNavView === target) {
          d.selectedNavView = null;
          await handleAction('view-' + target, navRow);
        } else {
          d.selectedNavView = target;
          refresh();
        }
        return;
      }

      const secToggle = e.target?.closest?.('.we-outline-sec-toggle[data-outline-sec]');
      if (secToggle && root.contains(secToggle)) {
        e.preventDefault();
        const k = secToggle.dataset.outlineSec;
        d.collapsedSections[k] = !d.collapsedSections[k];
        const secBody = typeof document !== 'undefined' ? document.getElementById('we-section-body-' + k) : null;
        const arrow = typeof document !== 'undefined' ? document.getElementById('we-section-arrow-' + k) : null;
        if (secBody) secBody.style.display = d.collapsedSections[k] ? 'none' : '';
        if (arrow) arrow.textContent = d.collapsedSections[k] ? '▶' : '▼';
        secToggle.setAttribute?.('aria-expanded', String(!d.collapsedSections[k]));
        return;
      }

      const tabBtn = e.target?.closest?.('.we-settings-tab[data-tab]');
      if (tabBtn && root.contains(tabBtn) && !tabBtn.onclick) {
        const key = tabBtn.dataset.tab;
        d.settingsTab = key;
        root.querySelectorAll('.we-settings-tab').forEach(t => t.classList.toggle('we-settings-tab--active', t.dataset.tab === key));
        root.querySelectorAll('.we-settings-panel').forEach(p => { p.style.display = p.dataset.tab === key ? '' : 'none'; });
        if (key === 'debug' && typeof document !== 'undefined') {
          const el = document.getElementById('we-outline-debug-render');
          if (el) { el.innerHTML = renderDebugContent(); window.WORLD_ENGINE_UI?.bindPromptSegToggle?.(el); }
        }
        return;
      }

      const actionEl = e.target?.closest?.('[data-outline-action]');
      if (actionEl && root.contains(actionEl)) {
        e.preventDefault();
        try { await handleAction(actionEl.dataset.outlineAction, actionEl); }
        catch (err) { showToast(err?.message || String(err), true); }
        return;
      }

      if (d.view === 'home' && !d.settingsOpen && !d.textOpen && d.selectedNavView && !e.target?.closest?.('.we-nav-row, select, input, textarea, button, summary, details, label, a')) {
        d.selectedNavView = null;
        refresh();
      }
    };

    window.WORLD_ENGINE_UI?.bindPromptSegToggle?.(root);
  }

  function init() {
    if (registered || !window.WORLD_ENGINE_UI?.registerEngineFace) return false;
    registered = true;
    window.WORLD_ENGINE_UI.registerEngineFace({
      id: 'outline',
      label: '剧情大纲',
      panelClass: 'we-outline-face',
      ballClass: 'we-ball-outline-face',
      render,
      bind,
      openSettings: () => {
        const d = getDraft();
        d.settingsOpen = !d.settingsOpen;
        if (!d.settingsOpen) {
          d.settingsDraft = null;
          d.coordinationMode = null;
        } else {
          d.textOpen = false;
          d.inlineEdit = null;
          d.settingsDraft = clone(loadSettings());
          d.coordinationMode = window.STORY_ENGINE_BRIDGE?.getCoordinationMode?.() || null;
        }
      },
      isSettingsOpen: () => getDraft().settingsOpen === true,
      onSettingsTab: tab => { getDraft().settingsTab = tab; },
      getScrollKey: () => {
        const d = getDraft();
        if (d.settingsOpen) return 'settings';
        if (d.textOpen) return 'text';
        return `view:${d.view}`;
      },
      isEditing: () => {
        const d = getDraft();
        return Boolean(d.inlineEdit || d.textOpen || d.pendingImport || d.settingsOpen);
      },
      getHeaderText: () => {
        const st = loadState();
        const chs = st.plan?.chapters || [];
        if (!chs.length) return (st.plan?.nodes || []).length ? `${st.plan.nodes.length} 节点` : '尚未建纲';
        const idx = chs.findIndex(c => c.id === st.currentChapterId);
        return idx >= 0 ? `第 ${idx + 1}/${chs.length} 章` : `共 ${chs.length} 章`;
      },
      getHeaderMood: () => {
        if (engine()?.isRunning?.()) return { text: engine().getRunningLabel() || '运行中', color: 'var(--we-gold)' };
        const st = loadState();
        const cfg = loadSettings();
        if (cfg.engineEnabled !== true) return { text: '未启用', color: 'var(--we-text3)' };
        const chs = st.plan?.chapters || [];
        if (!chs.length && !(st.plan?.nodes || []).length) return { text: '尚未设置剧情大纲', color: 'var(--we-text3)' };
        if (data().isOutlineFinished(st)) return { text: '已完结', color: 'var(--we-success, #4caf78)' };
        const cur = chs.find(c => c.id === st.currentChapterId) || chs[0];
        return { text: `${cur ? (cur.title || '未命名章节') : '跨章大纲'} · 每 ${cfg.checkEveryX ?? 3} 轮检查`, color: 'var(--we-accent)' };
      },
      getTheme: () => getStoredOutlineTheme(),
      refreshDebug: () => {
        const el = typeof document !== 'undefined' ? document.getElementById('we-outline-debug-render') : null;
        if (el) {
          el.innerHTML = renderDebugContent();
          window.WORLD_ENGINE_UI?.bindPromptSegToggle?.(el);
        }
      },
      getVersion: () => settingsApi()?.VERSION || '3.0.0',
      getSettings: () => loadSettings(),
      setEnabled: on => {
        if (!on) engine()?.abort?.();
        settingsApi()?.patchSettings?.({ engineEnabled: Boolean(on) });
        const d = getDraft();
        if (d.settingsDraft) d.settingsDraft.engineEnabled = Boolean(on);
        engine()?.applyInjection?.();
        refresh();
      },
      isRunning: () => engine()?.isRunning?.() === true,
      getRunningLabel: () => engine()?.getRunningLabel?.() || '',
      showForward: true,
      showRedo: false,
      forwardTitle: '立即检查剧情进度',
      forward: () => handleAction('check-now'),
      redo: () => handleAction('check-now'),
      abort: () => engine()?.abort?.()
    });
    return true;
  }

  return {
    init,
    render,
    bind,
    getDraft,
    _test: {
      handleAction,
      captureInput,
      getDraft
    }
  };
})();
