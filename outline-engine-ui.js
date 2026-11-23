// outline-engine-ui.js — 剧情大纲 v3 轻量化交互界面（单屏紧凑首页、三页两字导航、极简双视图看板、无条件树/无锁死横幅）
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
        collapsedSections: {},
        textOpen: false,
        sourceText: '',
        textPreview: null,
        boardMode: 'track',
        selectedChapterId: null,
        expandedNodes: {},
        inlineEdit: null,
        confirmDeleteTrackId: null,
        pendingImport: null,
        fetchedModels: [],
        testingApi: false,
        apiTestStatus: ''
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

  function button(action, label, extraAttr = '', variant = '') {
    const cls = variant === 'primary'
      ? 'we-btn we-btn-primary'
      : variant === 'danger'
        ? 'we-btn we-btn-danger'
        : 'we-btn';
    return `<button type="button" class="${cls}" data-outline-action="${h(action)}" ${extraAttr}>${label}</button>`;
  }

  function iconBtn(action, iconCls, title, extraAttr = '', danger = false) {
    return `<button type="button" class="we-icon-btn${danger ? ' we-outline-icon-danger' : ''}" data-outline-action="${h(action)}" title="${h(title)}" aria-label="${h(title)}" ${extraAttr}><i class="fa-solid ${iconCls}"></i></button>`;
  }

  function subTopbar(title, poem, backAction = 'view-home') {
    return `<div class="we-sub-topbar">
      <button type="button" class="we-icon-btn" data-outline-action="${h(backAction)}" title="返回" aria-label="返回"><i class="fa-solid fa-arrow-left"></i></button>
      <div class="we-sub-topbar-text">
        <div class="we-sub-topbar-title">${h(title)}</div>
        ${poem ? `<div class="we-sub-topbar-poem">${h(poem)}</div>` : ''}
      </div>
    </div>`;
  }

  function sec(id, title, bodyHtml) {
    const d = getDraft();
    const collapsed = d.collapsedSections[id] === true;
    return `<div class="we-section">
      <div class="we-section-title we-outline-sec-toggle" data-outline-sec="${h(id)}" role="button" tabindex="0" aria-expanded="${!collapsed}">
        <span>${h(title)}</span>
        <span class="we-outline-sec-arrow">${collapsed ? '▸' : '▾'}</span>
      </div>
      <div class="we-outline-sec-body" style="${collapsed ? 'display:none;' : ''}">${bodyHtml}</div>
    </div>`;
  }

  // ==================== 首页（单屏紧凑） ====================

  function renderHome(state, st) {
    const d = getDraft();
    const plan = state.plan || { chapters: [], tracks: [], nodes: [] };
    const chapters = plan.chapters || [];
    const tracks = plan.tracks || [];
    const nodes = plan.nodes || [];
    const totalDone = nodes.filter(n => data().isNodeClosed(state, n.id)).length;
    const curChapter = chapters.find(c => c.id === state.currentChapterId) || chapters[0] || null;
    const chProg = curChapter ? data().getChapterProgress(state, curChapter.id) : { doneCount: 0, totalCount: 0 };
    const ratio = chProg.totalCount > 0
      ? chProg.doneCount / chProg.totalCount
      : (nodes.length > 0 ? totalDone / nodes.length : 0);
    const pct = Math.round(ratio * 100);
    const radius = 58;
    const circ = 2 * Math.PI * radius;
    const offset = circ * (1 - ratio);
    const running = engine()?.isRunning?.() === true;
    const enabled = st.engineEnabled === true;
    const finished = data().isOutlineFinished(state);

    const statusLine = running
      ? `正在${engine().getRunningLabel() || '运行'}…`
      : !enabled
        ? '剧情大纲未启用（可在右上角齿轮设置中开启）'
        : !chapters.length
          ? '尚未建立大纲，可点下方「整理文本建纲」或进入「剧情」手动创建'
          : finished
            ? `已全部完结 · 共 ${chapters.length} 章 / ${nodes.length} 节点`
            : `当前：${curChapter?.title || '未命名章节'} · 第 ${chapters.findIndex(c => c.id === curChapter?.id) + 1}/${chapters.length} 章 · 每 ${st.checkEveryX || 3} 轮自动核对`;

    const coreHtml = `<div class="we-core we-outline-core">
      <div class="we-outline-ring-wrap">
        <svg viewBox="0 0 140 140" class="we-outline-ring-svg" aria-hidden="true">
          <circle cx="70" cy="70" r="${radius}" class="we-outline-ring-bg"></circle>
          <circle cx="70" cy="70" r="${radius}" class="we-outline-ring-fg"
            stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
        </svg>
        <div class="we-outline-ring-center">
          <div class="we-outline-ring-label">剧情脉络</div>
          <div class="we-outline-ring-val">${chProg.totalCount > 0 ? `${chProg.doneCount}/${chProg.totalCount}` : `${pct}%`}</div>
          <div class="we-outline-ring-sub">${curChapter ? h(curChapter.title.slice(0, 10)) : '待建纲'}</div>
        </div>
      </div>
      <div class="we-outline-kpi-row">
        <div class="we-outline-kpi"><span>${chapters.length}</span><small>章节</small></div>
        <div class="we-outline-kpi"><span>${tracks.length}</span><small>剧情线</small></div>
        <div class="we-outline-kpi"><span>${nodes.length}</span><small>节点</small></div>
        <div class="we-outline-kpi"><span>${totalDone}</span><small>已完成</small></div>
      </div>
      <div class="we-outline-core-actions">
        ${button('check-now', '<i class="fa-solid fa-compass"></i> 立即核对', (running || !enabled || !nodes.length) ? 'disabled' : '', 'primary')}
        ${running ? button('abort', '<i class="fa-solid fa-stop"></i> 停止', '', 'danger') : button('open-text', '<i class="fa-solid fa-wand-magic-sparkles"></i> 整理文本')}
      </div>
      <div class="we-outline-core-status">${h(statusLine)}</div>
    </div>`;

    const navHtml = `<div class="we-nav-list">${NAV_ITEMS.map(item => {
      const sel = d.selectedNavView === item.view;
      return `<div class="we-nav-row${sel ? ' is-selected' : ''}" data-outline-nav="${h(item.view)}" role="button" tabindex="0">
        <span class="we-nav-dot"></span>
        <div class="we-nav-title">${h(item.label)}</div>
        <div class="we-nav-body">
          <div class="we-nav-sub">${h(item.sub)}</div>
          <div class="we-nav-poem">${h(item.poem)}</div>
        </div>
        <span class="we-nav-chevron"><i class="fa-solid fa-chevron-right"></i></span>
      </div>`;
    }).join('')}</div>`;

    return coreHtml + navHtml;
  }

  // ==================== 节点卡片与表单（精简清晰） ====================

  function renderNodeCard(state, node, options = {}) {
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
    const expanded = d.expandedNodes[node.id] === true;
    const isEditingThis = d.inlineEdit?.kind === 'node' && d.inlineEdit.id === node.id;

    if (isEditingThis) {
      return renderNodeInlineForm(state, d.inlineEdit.data, false);
    }

    const chNames = (node.chapterIds || []).map(id => chMap.get(id)?.title).filter(Boolean);
    const depNames = (node.dependencies || []).map(id => data().getNode(state, id)?.title).filter(Boolean);

    return `<div class="we-outline-node-card is-${h(km.cls)} is-st-${h(sm.cls)}">
      <div class="we-outline-node-head">
        <button type="button" class="we-outline-node-expand" data-outline-action="toggle-node" data-id="${h(node.id)}" aria-expanded="${expanded}" title="${expanded ? '收起' : '展开'}">
          <i class="fa-solid fa-chevron-${expanded ? 'down' : 'right'}"></i>
        </button>
        <div class="we-outline-node-title-wrap" data-outline-action="toggle-node" data-id="${h(node.id)}" role="button" tabindex="0">
          <span class="we-outline-badge is-${h(km.cls)}">${h(km.label)}</span>
          <span class="we-outline-node-title">${h(node.title)}</span>
        </div>
        <select class="we-outline-status-select is-st-${h(sm.cls)}" data-outline-status="${h(node.id)}" aria-label="节点状态">
          ${Object.entries(STATUS_META).map(([k, m]) => `<option value="${k}" ${status === k ? 'selected' : ''}>${h(m.label)}${isManual && status === k ? '·手' : ''}</option>`).join('')}
          ${isManual ? '<option value="auto">↺ 恢复自动</option>' : ''}
        </select>
        ${options.editable ? `<div class="we-outline-node-ops">
          ${iconBtn('node-up', 'fa-arrow-up', '上移', `data-id="${h(node.id)}"`)}
          ${iconBtn('node-down', 'fa-arrow-down', '下移', `data-id="${h(node.id)}"`)}
          ${iconBtn('edit-node', 'fa-pen', '编辑', `data-id="${h(node.id)}"`)}
          ${iconBtn('remove-node', 'fa-trash', '删除', `data-id="${h(node.id)}"`, true)}
        </div>` : ''}
      </div>
      ${!expanded ? `<div class="we-outline-node-brief">
        ${kind === 'hidden' ? `<span class="we-outline-pill">${node.revealPublic ? '台前已显露' : '幕后隐藏'}</span>` : ''}
        ${!unlocked && !data().isNodeClosed(state, node.id) ? '<span class="we-outline-pill">未解锁</span>' : ''}
        ${node.required ? '<span class="we-outline-pill is-req">必做</span>' : ''}
        ${prog?.layer != null ? `<span class="we-outline-pill">L${prog.layer}</span>` : ''}
        <span>${h(node.publicHint || node.completionCriteria || node.secretNotes || '点击展开查看详情')}</span>
      </div>` : `<div class="we-outline-node-detail">
        ${chNames.length ? `<div><b>所属章节：</b>${h(chNames.join('、'))}</div>` : '<div><b>所属章节：</b>全篇跨章</div>'}
        ${node.publicHint ? `<div><b>公开提示（前台）：</b>${h(node.publicHint)}</div>` : ''}
        ${node.completionCriteria ? `<div><b>达成条件：</b>${h(node.completionCriteria)}</div>` : '<div class="we-hint">未写达成条件（自动核对不会标为已完成，仅支持手动切换）</div>'}
        ${node.secretNotes ? `<div class="we-outline-secret-box"><b>幕后备注（绝不进主聊天）：</b>${h(node.secretNotes)}</div>` : ''}
        ${depNames.length ? `<div><b>前置节点：</b>${h(depNames.join('、'))}</div>` : ''}
        ${node.actors?.length ? `<div><b>关联角色：</b>${h(node.actors.join('、'))}</div>` : ''}
        ${prog?.reason ? `<div class="we-hint">最近核对（L${prog.layer ?? '?'}）：${h(prog.reason)}</div>` : ''}
        ${kind === 'hidden' ? `<div style="margin-top:6px;">
          ${button('toggle-reveal', node.revealPublic ? '收起台前显露（恢复幕后隐藏）' : '允许台前显露公开提示', `data-id="${h(node.id)}"`)}
        </div>` : ''}
      </div>`}
    </div>`;
  }

  function renderNodeInlineForm(state, formData, isNew) {
    const plan = state.plan || { chapters: [], tracks: [], nodes: [] };
    const trackMap = new Map((plan.tracks || []).map(t => [t.id, t]));
    const selectedTrack = trackMap.get(formData.trackId) || plan.tracks[0];
    const isHidden = selectedTrack?.kind === 'hidden';
    const otherNodes = (plan.nodes || []).filter(n => n.id !== formData.id);
    const chSet = new Set(formData.chapterIds || []);
    const depSet = new Set(formData.dependencies || []);

    return `<div class="we-outline-inline-form">
      <div class="we-outline-form-title">${isNew ? '新增剧情节点' : '编辑剧情节点'}</div>
      <div class="we-outline-form-grid">
        <div class="we-input-group">
          <label>节点标题</label>
          <input type="text" data-inline-field="title" value="${h(formData.title || '')}" placeholder="例如：查明青石镇疫源">
        </div>
        <div class="we-input-group">
          <label>所属剧情线</label>
          <select data-inline-field="trackId">
            ${(plan.tracks || []).map(t => `<option value="${h(t.id)}" ${t.id === formData.trackId ? 'selected' : ''}>[${h(KIND_META[t.kind]?.label || '主线')}] ${h(t.title)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="we-input-group">
        <label>所属章节（主线按章门控；支线/暗线留空表示全篇跨章）</label>
        <div class="we-outline-check-row">
          ${(plan.chapters || []).map(c => `<label class="we-outline-check-chip"><input type="checkbox" data-inline-chapters="${h(c.id)}" ${chSet.has(c.id) ? 'checked' : ''}>${h(c.title)}</label>`).join('') || '<span class="we-hint">暂无章节</span>'}
        </div>
      </div>
      <div class="we-input-group">
        <label>前台公开提示（会注入主聊天，请勿剧透真相）</label>
        <textarea rows="2" data-inline-field="publicHint" placeholder="给写文 AI 的自然引导或表面线索">${h(formData.publicHint || '')}</textarea>
      </div>
      <div class="we-input-group">
        <label>达成条件（AI 自动判定 completed 的依据）</label>
        <input type="text" data-inline-field="completionCriteria" value="${h(formData.completionCriteria || '')}" placeholder="例如：主角在药铺找到账本并确认投毒者身份">
      </div>
      <div class="we-input-group">
        <label>幕后真相 / 作者备注（绝不进主聊天，仅核对 AI 与世界后台可见）</label>
        <textarea rows="2" data-inline-field="secretNotes" placeholder="隐藏动机、伏笔真相、暗线计划…">${h(formData.secretNotes || '')}</textarea>
      </div>
      <div class="we-outline-form-grid">
        <div class="we-input-group">
          <label>关联角色（逗号分隔，用于记忆热层联动）</label>
          <input type="text" data-inline-field="actorsText" value="${h((formData.actors || []).join(', '))}" placeholder="沈清秋, 周掌柜">
        </div>
        <div class="we-input-group" style="display:flex;flex-direction:column;justify-content:center;gap:4px;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" data-inline-bool="required" ${formData.required !== false ? 'checked' : ''}> 本章推进必做节点
          </label>
          ${isHidden ? `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" data-inline-bool="revealPublic" ${formData.revealPublic === true ? 'checked' : ''}> 台前已显露公开提示
          </label>` : ''}
        </div>
      </div>
      ${otherNodes.length ? `<div class="we-input-group">
        <label>前置节点（勾选的节点完成/跳过后本节点才解锁）</label>
        <div class="we-outline-check-row">
          ${otherNodes.map(n => `<label class="we-outline-check-chip"><input type="checkbox" data-inline-deps="${h(n.id)}" ${depSet.has(n.id) ? 'checked' : ''}>${h(n.title)}</label>`).join('')}
        </div>
      </div>` : ''}
      <div class="we-outline-form-actions">
        ${button('save-inline', '保存节点', '', 'primary')}
        ${button('cancel-inline', '取消')}
      </div>
    </div>`;
  }

  // ==================== 进度分页 ====================

  function renderProgressView(state) {
    const plan = state.plan || { chapters: [], tracks: [], nodes: [] };
    const chapters = plan.chapters || [];
    const header = subTopbar('剧情进度', '脉络所至，一目了然');

    if (!chapters.length) {
      return header + `<div class="we-section we-outline-empty">
        <div style="font-weight:600;margin-bottom:6px;">尚未创建剧情大纲</div>
        <div class="we-hint" style="margin-bottom:10px;">直接粘贴你的大纲文字让 AI 自动分章建线，或进入剧情看板手工添加。</div>
        <div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;">
          ${button('open-text', '<i class="fa-solid fa-wand-magic-sparkles"></i> AI 整理文本建纲', '', 'primary')}
          ${button('view-tracks', '前往剧情看板')}
        </div>
      </div>`;
    }

    const curIdx = Math.max(0, chapters.findIndex(c => c.id === state.currentChapterId));
    const curCh = chapters[curIdx] || chapters[0];
    const prog = data().getChapterProgress(state, curCh.id);
    const unlocked = engine()?.getUnlockedOpenNodes?.(state) || [];
    const chNodes = data().getChapterNodes(state, curCh.id);
    const focusIds = new Set(unlocked.map(n => n.id));
    const focusList = [
      ...unlocked,
      ...chNodes.filter(n => !focusIds.has(n.id))
    ];

    const prevCh = chapters[curIdx - 1];
    const nextCh = chapters[curIdx + 1];

    const posCard = `<div class="we-section">
      <div class="we-outline-bar">
        <div>
          <div style="font-weight:600;font-size:14px;">${h(plan.title || '未命名大纲')}</div>
          <div class="we-hint">第 ${curIdx + 1}/${chapters.length} 章 · <b>${h(curCh.title)}</b>（推进门槛 ${prog.doneCount}/${prog.totalCount}）</div>
        </div>
        ${button('view-tracks', '剧情看板 →')}
      </div>
      ${curCh.goal ? `<div style="font-size:12px;color:var(--we-text2);margin-top:6px;">阶段目标：${h(curCh.goal)}</div>` : ''}
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
        ${prevCh ? button('set-chapter', `← 上一章：${h(prevCh.title)}`, `data-id="${h(prevCh.id)}"`) : ''}
        ${nextCh ? button('set-chapter', `下一章：${h(nextCh.title)} →`, `data-id="${h(nextCh.id)}"`) : ''}
      </div>
    </div>`;

    const nodesHtml = `<div class="we-section">
      <div class="we-section-title">当前章节与已解锁节点（${focusList.length}）</div>
      ${focusList.length
        ? `<div class="we-outline-node-list">${focusList.map(n => renderNodeCard(state, n, { editable: false })).join('')}</div>`
        : '<div class="we-hint">当前章节暂无节点，请前往剧情看板添加。</div>'}
    </div>`;

    return header + posCard + nodesHtml;
  }

  // ==================== 剧情看板分页 ====================

  function renderTracksView(state) {
    const d = getDraft();
    const plan = state.plan || { chapters: [], tracks: [], nodes: [] };
    const chapters = plan.chapters || [];
    const tracks = plan.tracks || [];
    const nodes = plan.nodes || [];
    const header = subTopbar('剧情看板', '草蛇灰线，伏脉千里');

    let planHead = '';
    if (d.inlineEdit?.kind === 'plan') {
      const f = d.inlineEdit.data;
      planHead = `<div class="we-section we-outline-inline-form">
        <div class="we-outline-form-title">编辑大纲总览</div>
        <div class="we-input-group"><label>大纲标题</label><input type="text" data-inline-field="title" value="${h(f.title || '')}"></div>
        <div class="we-input-group"><label>公开脉络（注入前台，不剧透）</label><textarea rows="2" data-inline-field="publicSynopsis">${h(f.publicSynopsis || '')}</textarea></div>
        <div class="we-input-group"><label>叙事原则（注入前台，不剧透）</label><textarea rows="2" data-inline-field="publicConstraints">${h(f.publicConstraints || '')}</textarea></div>
        <div class="we-input-group"><label>作者幕后总备忘（绝不进主聊天）</label><textarea rows="2" data-inline-field="authorNotes">${h(f.authorNotes || '')}</textarea></div>
        <div class="we-outline-form-actions">${button('save-inline', '保存', '', 'primary')}${button('cancel-inline', '取消')}</div>
      </div>`;
    } else {
      planHead = `<div class="we-section">
        <div class="we-outline-bar">
          <div>
            <div style="font-weight:600;font-size:14px;">${h(plan.title || '未命名大纲')}</div>
            <div class="we-hint">${chapters.length} 章 · ${tracks.length} 线 · ${nodes.length} 节点 · r${state.revision || 0}</div>
          </div>
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
            ${iconBtn('edit-plan-meta', 'fa-pen', '编辑大纲总览')}
            ${(chapters.length || nodes.length) ? iconBtn('clear-outline', 'fa-trash', '清空大纲（自动备份）', '', true) : ''}
            ${button('open-text', '<i class="fa-solid fa-wand-magic-sparkles"></i> 整理文本')}
          </div>
        </div>
        ${(plan.publicSynopsis || plan.publicConstraints || plan.authorNotes) ? `<details class="we-outline-meta-fold">
          <summary>查看脉络与幕后备忘</summary>
          ${plan.publicSynopsis ? `<div><b>公开脉络：</b>${h(plan.publicSynopsis)}</div>` : ''}
          ${plan.publicConstraints ? `<div><b>叙事原则：</b>${h(plan.publicConstraints)}</div>` : ''}
          ${plan.authorNotes ? `<div class="we-outline-secret-box"><b>作者幕后备忘：</b>${h(plan.authorNotes)}</div>` : ''}
        </details>` : ''}
      </div>`;
    }

    const toolbar = `<div class="we-outline-toolbar">
      <div class="we-outline-seg">
        <button type="button" class="we-btn${d.boardMode === 'track' ? ' we-btn-primary' : ''}" data-outline-action="mode-track">按剧情线</button>
        <button type="button" class="we-btn${d.boardMode === 'chapter' ? ' we-btn-primary' : ''}" data-outline-action="mode-chapter">按章节</button>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;">
        ${button('add-chapter', '+ 章节')}
        ${button('add-track', '+ 剧情线')}
        ${button('add-node', '+ 节点', '', 'primary')}
      </div>
    </div>`;

    let newInlineHtml = '';
    if (d.inlineEdit?.isNew) {
      if (d.inlineEdit.kind === 'chapter') {
        const f = d.inlineEdit.data;
        newInlineHtml = `<div class="we-section we-outline-inline-form">
          <div class="we-outline-form-title">新增章节</div>
          <div class="we-input-group"><label>章节标题</label><input type="text" data-inline-field="title" value="${h(f.title || '')}" placeholder="例如：第一章 初抵青石镇"></div>
          <div class="we-input-group"><label>阶段目标</label><input type="text" data-inline-field="goal" value="${h(f.goal || '')}" placeholder="本章公开方向"></div>
          <div class="we-outline-form-actions">${button('save-inline', '保存章节', '', 'primary')}${button('cancel-inline', '取消')}</div>
        </div>`;
      } else if (d.inlineEdit.kind === 'track') {
        const f = d.inlineEdit.data;
        newInlineHtml = `<div class="we-section we-outline-inline-form">
          <div class="we-outline-form-title">新增剧情线</div>
          <div class="we-outline-form-grid">
            <div class="we-input-group"><label>名称</label><input type="text" data-inline-field="title" value="${h(f.title || '')}" placeholder="例如：药铺暗线"></div>
            <div class="we-input-group"><label>类型</label><select data-inline-field="kind">
              <option value="main" ${f.kind === 'main' ? 'selected' : ''}>主线（按章推进）</option>
              <option value="side" ${f.kind === 'side' ? 'selected' : ''}>支线（跨章常驻）</option>
              <option value="hidden" ${f.kind === 'hidden' ? 'selected' : ''}>暗线（幕后防剧透）</option>
            </select></div>
          </div>
          <div class="we-input-group"><label>长期目标</label><input type="text" data-inline-field="goal" value="${h(f.goal || '')}"></div>
          <div class="we-outline-form-actions">${button('save-inline', '保存剧情线', '', 'primary')}${button('cancel-inline', '取消')}</div>
        </div>`;
      } else if (d.inlineEdit.kind === 'node') {
        newInlineHtml = `<div class="we-section">${renderNodeInlineForm(state, d.inlineEdit.data, true)}</div>`;
      }
    }

    let boardHtml = '';
    if (d.boardMode === 'chapter') {
      const selChId = chapters.some(c => c.id === d.selectedChapterId)
        ? d.selectedChapterId
        : (state.currentChapterId || chapters[0]?.id || null);
      const selCh = chapters.find(c => c.id === selChId) || null;

      const chips = chapters.length
        ? `<div class="we-outline-chapter-chips">${chapters.map((c, idx) => {
            const isCur = c.id === state.currentChapterId;
            const isSel = c.id === selChId;
            const p = data().getChapterProgress(state, c.id);
            return `<button type="button" class="we-outline-chip${isSel ? ' is-selected' : ''}${isCur ? ' is-current' : ''}" data-outline-action="select-chapter" data-id="${h(c.id)}">
              <span>${idx + 1}. ${h(c.title)}</span>
              <small>${p.doneCount}/${p.totalCount}${isCur ? '·当前' : ''}</small>
            </button>`;
          }).join('')}</div>`
        : '<div class="we-section we-hint">暂无章节，请点击上方「+ 章节」创建。</div>';

      let chDetail = '';
      if (selCh) {
        const isEditingCh = d.inlineEdit?.kind === 'chapter' && !d.inlineEdit.isNew && d.inlineEdit.id === selCh.id;
        const chNodes = data().getChapterNodes(state, selCh.id);
        chDetail = `<div class="we-section">
          ${isEditingCh ? `<div class="we-outline-inline-form">
            <div class="we-outline-form-title">编辑章节</div>
            <div class="we-input-group"><label>章节标题</label><input type="text" data-inline-field="title" value="${h(d.inlineEdit.data.title || '')}"></div>
            <div class="we-input-group"><label>阶段目标</label><input type="text" data-inline-field="goal" value="${h(d.inlineEdit.data.goal || '')}"></div>
            <div class="we-outline-form-actions">${button('save-inline', '保存', '', 'primary')}${button('cancel-inline', '取消')}</div>
          </div>` : `<div class="we-outline-bar">
            <div>
              <div style="font-weight:600;">${h(selCh.title)} ${selCh.id === state.currentChapterId ? '<span class="we-outline-pill is-req">当前章</span>' : ''}</div>
              ${selCh.goal ? `<div class="we-hint">${h(selCh.goal)}</div>` : ''}
            </div>
            <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
              ${selCh.id !== state.currentChapterId ? button('set-chapter', '设为当前章', `data-id="${h(selCh.id)}"`) : ''}
              ${button('add-node', '+ 本章节点', `data-chapter="${h(selCh.id)}"`)}
              ${iconBtn('chapter-up', 'fa-arrow-up', '前移', `data-id="${h(selCh.id)}"`)}
              ${iconBtn('chapter-down', 'fa-arrow-down', '后移', `data-id="${h(selCh.id)}"`)}
              ${iconBtn('edit-chapter', 'fa-pen', '编辑章节', `data-id="${h(selCh.id)}"`)}
              ${iconBtn('remove-chapter', 'fa-trash', '删除章节', `data-id="${h(selCh.id)}"`, true)}
            </div>
          </div>`}
          <div class="we-outline-node-list" style="margin-top:8px;">
            ${chNodes.length ? chNodes.map(n => renderNodeCard(state, n, { editable: true })).join('') : '<div class="we-hint">本章暂无节点</div>'}
          </div>
        </div>`;
      }

      const globalNodes = nodes.filter(n => !(n.chapterIds || []).length);
      const globalSec = globalNodes.length
        ? `<div class="we-section"><div class="we-section-title">全篇跨章节点（${globalNodes.length}）</div><div class="we-outline-node-list">${globalNodes.map(n => renderNodeCard(state, n, { editable: true })).join('')}</div></div>`
        : '';

      boardHtml = chips + chDetail + globalSec;
    } else {
      boardHtml = tracks.length
        ? tracks.map(tr => {
            const km = KIND_META[tr.kind] || KIND_META.main;
            const trNodes = data().getTrackNodes(state, tr.id);
            const isEditingTr = d.inlineEdit?.kind === 'track' && !d.inlineEdit.isNew && d.inlineEdit.id === tr.id;
            const confirmingDel = d.confirmDeleteTrackId === tr.id;
            const otherTrack = tracks.find(other => other.id !== tr.id);

            return `<div class="we-section we-outline-track-sec is-${h(km.cls)}">
              ${isEditingTr ? `<div class="we-outline-inline-form">
                <div class="we-outline-form-title">编辑剧情线</div>
                <div class="we-outline-form-grid">
                  <div class="we-input-group"><label>名称</label><input type="text" data-inline-field="title" value="${h(d.inlineEdit.data.title || '')}"></div>
                  <div class="we-input-group"><label>类型</label><select data-inline-field="kind">
                    <option value="main" ${d.inlineEdit.data.kind === 'main' ? 'selected' : ''}>主线</option>
                    <option value="side" ${d.inlineEdit.data.kind === 'side' ? 'selected' : ''}>支线</option>
                    <option value="hidden" ${d.inlineEdit.data.kind === 'hidden' ? 'selected' : ''}>暗线</option>
                  </select></div>
                </div>
                <div class="we-input-group"><label>长期目标</label><input type="text" data-inline-field="goal" value="${h(d.inlineEdit.data.goal || '')}"></div>
                <div class="we-outline-form-actions">${button('save-inline', '保存', '', 'primary')}${button('cancel-inline', '取消')}</div>
              </div>` : `<div class="we-outline-bar">
                <div>
                  <span class="we-outline-badge is-${h(km.cls)}">${h(km.label)}</span>
                  <strong style="margin-left:4px;">${h(tr.title)}</strong>
                  ${tr.paused ? '<span class="we-outline-pill">已暂停</span>' : ''}
                  ${tr.goal ? `<div class="we-hint">${h(tr.goal)}</div>` : ''}
                </div>
                <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
                  ${button('add-node', '+ 节点', `data-track="${h(tr.id)}"`)}
                  ${button('track-pause', tr.paused ? '继续' : '暂停', `data-id="${h(tr.id)}"`)}
                  ${iconBtn('track-up', 'fa-arrow-up', '上移', `data-id="${h(tr.id)}"`)}
                  ${iconBtn('track-down', 'fa-arrow-down', '下移', `data-id="${h(tr.id)}"`)}
                  ${iconBtn('edit-track', 'fa-pen', '编辑剧情线', `data-id="${h(tr.id)}"`)}
                  ${iconBtn('remove-track', 'fa-trash', '删除剧情线', `data-id="${h(tr.id)}"`, true)}
                </div>
              </div>`}
              ${confirmingDel ? `<div class="we-outline-confirm-bar">
                <span>此线包含 ${trNodes.length} 个节点，请选择删除方式：</span>
                ${otherTrack ? button('confirm-track-del-move', `移至「${h(otherTrack.title)}」后删线`, `data-id="${h(tr.id)}"`) : ''}
                ${button('confirm-track-del-all', '连同节点一并删除', `data-id="${h(tr.id)}"`, 'danger')}
                ${button('cancel-track-del', '取消')}
              </div>` : ''}
              <div class="we-outline-node-list" style="margin-top:8px;">
                ${trNodes.length ? trNodes.map(n => renderNodeCard(state, n, { editable: true })).join('') : '<div class="we-hint">此线暂无节点</div>'}
              </div>
            </div>`;
          }).join('')
        : '<div class="we-section we-hint">暂无剧情线，请点击上方「+ 剧情线」或「整理文本」创建。</div>';
    }

    return header + planHead + toolbar + newInlineHtml + boardHtml;
  }

  // ==================== 注入预览分页（单份不重复） ====================

  function renderScheduleView(state, st) {
    const header = subTopbar('注入预览', '运筹帷幄之中');
    const narrative = engine()?.buildNarrativeGuidance?.(state) || '';
    const world = engine()?.buildWorldGuidance?.() || '';
    const posLabel = { 0: '主提示词内', 1: `聊天内深度 ${st.injectDepth ?? 1}`, 2: '主提示词之前' }[st.injectPosition ?? 1] || '聊天内深度 1';

    const frontSec = `<div class="we-section">
      <div class="we-section-title">主聊天前台指导（${h(posLabel)} · ${narrative.length}/${st.injectMaxChars || 2000} 字）</div>
      <div class="we-hint" style="margin-bottom:6px;">严格脱敏：仅包含当前章公开目标、公开提示与已显露暗线线索，绝不含幕后备注与作者总备忘。</div>
      <pre class="we-outline-pre">${h(narrative || '（当前未启用、无大纲或大纲已完结，本轮不向主聊天注入）')}</pre>
    </div>`;

    const backSec = `<div class="we-section">
      <div class="we-section-title">世界引擎后台指导（${world.length}/${st.worldInjectMaxChars || 2000} 字）</div>
      <div class="we-hint" style="margin-bottom:6px;">仅在世界引擎推演时作为只读背景提供（含暗线幕后备注），绝不进入主聊天。</div>
      <pre class="we-outline-pre">${h(world || '（未开启向世界提供后台指导，或当前无大纲）')}</pre>
    </div>`;

    const sharedViewer = window.WORLD_ENGINE_UI?.renderLastPromptViewer?.({ focus: 'outline' }) || '';
    return header + frontSec + backSec + sharedViewer;
  }

  // ==================== 整理文本浮层 ====================

  function renderTextOverlay() {
    const d = getDraft();
    const header = subTopbar('AI 整理文本建纲', '化繁为简，提纲挈领', 'close-text');
    const running = engine()?.isRunning?.() === true;

    let previewHtml = '';
    if (d.textPreview) {
      const p = d.textPreview;
      previewHtml = `<div class="we-section">
        <div class="we-section-title">整理预览：《${h(p.title || '未命名大纲')}》</div>
        <div class="we-hint" style="margin-bottom:8px;">共识别 ${(p.chapters || []).length} 章、${(p.tracks || []).length} 条剧情线、${(p.nodes || []).length} 个节点（尚未落盘，确认后覆盖当前大纲计划）。</div>
        ${(p.chapters || []).map((c, idx) => {
          const cNodes = (p.nodes || []).filter(n => (n.chapterIds || []).includes(c.id));
          return `<div class="we-outline-preview-ch">
            <div><b>第 ${idx + 1} 章 · ${h(c.title)}</b>${c.goal ? ` — ${h(c.goal)}` : ''}</div>
            ${cNodes.map(n => `<div class="we-outline-preview-node">· ${h(n.title)}${n.completionCriteria ? `（达成：${h(n.completionCriteria)}）` : ''}</div>`).join('')}
          </div>`;
        }).join('')}
        <div style="display:flex;gap:6px;margin-top:10px;">
          ${button('adopt-preview', '确认采用此大纲', '', 'primary')}
          ${button('discard-preview', '丢弃预览')}
        </div>
      </div>`;
    }

    return header + `<div class="we-section">
      <div class="we-input-group">
        <label>粘贴原始大纲 / 故事构想，或导入 .txt / .md 文件</label>
        <textarea id="we-outline-source-text" rows="8" placeholder="例如：\n第一章 初入青石镇：主角避雨入住客栈，结识药师沈清秋，发现镇上水源异常。\n暗线：镇长暗中与北境密使勾结。">${h(d.sourceText || '')}</textarea>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        ${button('organize-text', '<i class="fa-solid fa-wand-magic-sparkles"></i> AI 整理并预览', running ? 'disabled' : '', 'primary')}
        <label class="we-btn" style="cursor:pointer;">导入文本文件<input type="file" id="we-outline-text-file" accept=".txt,.md,text/plain,text/markdown" style="display:none;"></label>
        ${running ? button('abort', '停止', '', 'danger') : ''}
      </div>
    </div>` + previewHtml;
  }

  // ==================== 设置页（6 标签统一样式） ====================

  function renderSettings(st) {
    const d = getDraft();
    const s = d.settingsDraft || clone(st);
    const tab = d.settingsTab || 'common';
    const curTheme = getStoredOutlineTheme();
    const coordMode = window.STORY_ENGINE_BRIDGE?.getCoordinationMode?.() || 'stagger-serial';

    const apiHtml = `
      <div style="margin-bottom:8px;">${button('copy-world-api', '<i class="fa-solid fa-copy"></i> 预填世界引擎 API 地址/Key')}</div>
      <div class="we-input-group">
        <label>连接方式</label>
        <select data-outline-setting="connectionMode">
          <option value="direct" ${s.connectionMode !== 'proxy' ? 'selected' : ''}>浏览器直连（推荐）</option>
          <option value="proxy" ${s.connectionMode === 'proxy' ? 'selected' : ''}>经酒馆代理</option>
        </select>
      </div>
      <div class="we-input-group"><label>API URL</label><input type="text" data-outline-setting="apiUrl" value="${h(s.apiUrl || '')}" placeholder="https://api.openai.com/v1"></div>
      <div class="we-input-group"><label>API Key</label><input type="password" data-outline-setting="apiKey" value="${h(s.apiKey || '')}" placeholder="sk-..."></div>
      <div class="we-input-group">
        <label>模型名称</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <input type="text" data-outline-setting="model" value="${h(s.model || '')}" style="flex:1;min-width:140px;">
          ${button('fetch-models', '获取列表')}
          ${button('test-api', d.testingApi ? '测试中…' : '测试连接', d.testingApi ? 'disabled' : '')}
        </div>
        ${d.fetchedModels.length ? `<select id="we-outline-model-list" style="width:100%;margin-top:6px;">
          <option value="">— 选择模型 —</option>
          ${d.fetchedModels.map(m => `<option value="${h(m)}" ${m === s.model ? 'selected' : ''}>${h(m)}</option>`).join('')}
        </select>` : ''}
        ${d.apiTestStatus ? `<div class="we-hint" style="margin-top:4px;">${h(d.apiTestStatus)}</div>` : ''}
      </div>
      <div class="we-outline-form-grid">
        <div class="we-input-group"><label>温度</label><input type="number" step="0.05" min="0" max="2" data-outline-setting="temperature" value="${h(s.temperature ?? 0.2)}"></div>
        <div class="we-input-group"><label>最大输出 Token</label><input type="number" min="256" max="1000000" data-outline-setting="maxTokens" value="${h(s.maxTokens ?? 8192)}"></div>
      </div>
      <div class="we-outline-form-grid">
        <div class="we-input-group"><label>超时（秒）</label><input type="number" min="10" max="600" data-outline-setting="apiTimeoutSec" value="${Math.round((Number(s.apiTimeoutMs) || 120000) / 1000)}"></div>
        <div class="we-input-group" style="display:flex;align-items:flex-end;padding-bottom:6px;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-outline-setting="stream" ${s.stream ? 'checked' : ''}> 启用流式传输</label>
        </div>
      </div>
      <details class="we-api-adv-fold">
        <summary>高级 API 参数（JSON 模式 / top_p / 推理力度）</summary>
        <div class="we-input-group"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-outline-setting="jsonMode" ${s.jsonMode ? 'checked' : ''}> 强制 JSON 输出（json_object）</label></div>
        <div class="we-outline-form-grid">
          <div class="we-input-group"><label>top_p（留空默认）</label><input type="number" step="0.05" min="0" max="1" data-outline-setting="topP" value="${s.topP ?? ''}"></div>
          <div class="we-input-group"><label>推理力度</label><select data-outline-setting="reasoningEffort">
            ${['', 'minimal', 'low', 'medium', 'high'].map(v => `<option value="${v}" ${(s.reasoningEffort || '') === v ? 'selected' : ''}>${v || '默认'}</option>`).join('')}
          </select></div>
        </div>
      </details>`;

    const rhythmHtml = `
      <div class="we-input-group">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" data-outline-setting="engineEnabled" ${s.engineEnabled ? 'checked' : ''}> 启用剧情大纲模块</label>
        <div class="we-hint">轻量独立运行，不再强制接管或锁死世界引擎与记忆引擎。</div>
      </div>
      <div class="we-input-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" data-outline-setting="firstLayerIsAiOpening" ${s.firstLayerIsAiOpening !== false ? 'checked' : ''}> 首楼为 AI 开场白（从第 1 轮交互起计数）</label></div>
      <div class="we-input-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" data-outline-setting="autoCheck" ${s.autoCheck !== false ? 'checked' : ''}> 回复后自动核对剧情进度</label></div>
      <div class="we-outline-form-grid">
        <div class="we-input-group"><label>每 N 轮核对一次</label><input type="number" min="1" max="1000" data-outline-setting="checkEveryX" value="${h(s.checkEveryX ?? 3)}"></div>
        <div class="we-input-group"><label>JSON 纠错重试次数</label><input type="number" min="0" max="5" data-outline-setting="formatMaxRetries" value="${h(s.formatMaxRetries ?? 2)}"></div>
      </div>`;

    const injectHtml = `
      <div class="we-input-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" data-outline-setting="injectIntoPrompt" ${s.injectIntoPrompt !== false ? 'checked' : ''}> 向主聊天注入【剧情指导】（防剧透公开版）</label></div>
      <div class="we-outline-form-grid">
        <div class="we-input-group"><label>注入位置</label><select data-outline-setting="injectPosition">
          <option value="1" ${Number(s.injectPosition ?? 1) === 1 ? 'selected' : ''}>聊天内按深度（推荐）</option>
          <option value="0" ${Number(s.injectPosition) === 0 ? 'selected' : ''}>主提示词内（IN_PROMPT）</option>
          <option value="2" ${Number(s.injectPosition) === 2 ? 'selected' : ''}>主提示词之前</option>
        </select></div>
        <div class="we-input-group"><label>注入深度</label><input type="number" min="0" max="20" data-outline-setting="injectDepth" value="${h(s.injectDepth ?? 1)}" ${Number(s.injectPosition ?? 1) !== 1 ? 'disabled' : ''}></div>
      </div>
      <div class="we-outline-form-grid">
        <div class="we-input-group"><label>前台注入字数上限</label><input type="number" min="200" max="20000" step="100" data-outline-setting="injectMaxChars" value="${h(s.injectMaxChars ?? 2000)}"></div>
        <div class="we-input-group"><label>单轮最多安排节点</label><input type="number" min="1" max="20" data-outline-setting="narrativeLimit" value="${h(s.narrativeLimit ?? 4)}"></div>
      </div>`;

    const linkHtml = `
      <div class="we-input-group">
        <label>三模块后台调度策略（世界 · 大纲 · 记忆）</label>
        <select id="we-outline-coord-mode">
          <option value="stagger-serial" ${coordMode !== 'independent' ? 'selected' : ''}>串行错峰（推荐 · 世界 → 大纲 → 记忆，防限流）</option>
          <option value="independent" ${coordMode === 'independent' ? 'selected' : ''}>各自独立并行</option>
        </select>
      </div>
      <div class="we-input-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" data-outline-setting="injectIntoWorldEngine" ${s.injectIntoWorldEngine !== false ? 'checked' : ''}> 向世界引擎提供后台剧情指导（含暗线幕后备注）</label></div>
      <div class="we-input-group"><label>后台指导字数上限</label><input type="number" min="300" max="10000" step="100" data-outline-setting="worldInjectMaxChars" value="${h(s.worldInjectMaxChars ?? 2000)}"></div>
      <div class="we-input-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" data-outline-setting="useWorldReference" ${s.useWorldReference !== false ? 'checked' : ''}> 核对进度时参考世界公开动态（只读）</label></div>
      <div class="we-input-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" data-outline-setting="injectIntoMemoryEngine" ${s.injectIntoMemoryEngine !== false ? 'checked' : ''}> 向记忆引擎提供公开章节焦距与活跃角色（只读，不写表）</label></div>
      <div class="we-input-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" data-outline-setting="useMemoryReference" ${s.useMemoryReference !== false ? 'checked' : ''}> 核对进度时参考记忆 7 表摘要（只读）</label></div>`;

    const advHtml = `
      <div class="we-input-group"><label>网络异常自动重试次数</label><input type="number" min="0" max="10" data-outline-setting="apiAutoRetries" value="${h(s.apiAutoRetries ?? 0)}"></div>
      <div class="we-input-group">
        <label>面板主题（切换后立即生效）</label>
        <select id="we-outline-theme-select">
          ${THEMES.map(t => `<option value="${t.id}" ${t.id === curTheme ? 'selected' : ''}>${h(t.name)}</option>`).join('')}
        </select>
      </div>`;

    const snaps = chatCache()?.listSnapshots?.() || [];
    const archiveHtml = `
      <div class="we-input-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" data-outline-setting="syncToChat" ${s.syncToChat ? 'checked' : ''}> 实时同步大纲到酒馆聊天元数据</label></div>
      <div class="we-input-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" data-outline-setting="autoBackup" ${s.autoBackup ? 'checked' : ''}> 变更时自动留存聊天备份（最多 3 份）</label></div>
      <div style="display:flex;gap:6px;margin:8px 0;">
        <input type="text" id="we-outline-snap-name" placeholder="保存点名称（可选）" style="flex:1;">
        ${button('snap-create', '新建保存点')}
      </div>
      ${snaps.length ? `<div class="we-outline-snap-list">${[...snaps].reverse().map(sn => `<div class="we-outline-snap-row">
        <div><div>${h(sn.name)}</div><small class="we-hint">${sn.auto ? '自动' : '手动'} · ${new Date(sn.createdAt || 0).toLocaleString()}</small></div>
        <div style="display:flex;gap:4px;">
          ${button('snap-restore', '恢复', `data-id="${h(sn.id)}"`)}
          ${button('snap-delete', '删', `data-id="${h(sn.id)}"`, 'danger')}
        </div>
      </div>`).join('')}</div>` : '<div class="we-hint">当前聊天暂无大纲保存点</div>'}
      <hr style="border:none;border-top:1px solid var(--we-border);margin:10px 0;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${button('export-json', '导出大纲 JSON')}
        <label class="we-btn" style="cursor:pointer;">导入大纲 JSON<input type="file" id="we-outline-json-file" accept=".json,application/json" style="display:none;"></label>
        ${button('clear-outline', '清空当前大纲', '', 'danger')}
      </div>`;

    const dbg = engine()?.getLastDebug?.() || {};
    const errText = engine()?.getLastError?.() || '';
    const debugHtml = `
      <div style="margin-bottom:8px;">${button('export-diag', '导出大纲诊断包')}</div>
      ${errText ? `<div class="we-outline-err-box">最近错误：${h(errText)}</div>` : '<div class="we-hint">当前无运行错误</div>'}
      ${dbg.request ? `<details style="margin-top:8px;"><summary>最近一次请求（${h(dbg.request.label)} · 第 ${dbg.request.attempt} 次 · ${dbg.request.ok ? '成功' : '失败'}）</summary>
        <pre class="we-outline-pre">${h(dbg.request.rawResult || '')}</pre>
      </details>` : ''}
      ${window.WORLD_ENGINE_UI?.renderLastPromptViewer?.({ focus: 'outline' }) || ''}`;

    const aboutHtml = `<div class="we-about-current"><span class="we-changelog-cur">剧情大纲 v${h(settingsApi()?.VERSION || '3.0.0')}</span></div>
      <div class="we-section-title" style="margin-top:10px;">v3.0.0 · 轻量化架构重构与 0ms 楼层回退（2026-11-23）</div>
      <ul class="we-changelog-items">
        <li>砍除 11 类嵌套布尔条件树、五层线索知情表与强耦合联合历史锁；收敛为直观三层结构（章节 → 主/支/暗线 → 节点），自动无损迁移旧版 v1/v2 存档。</li>
        <li>改用按楼层号 0ms 本地回退，删楼/滑动/重 Roll 秒级撤回失效自动进度并保留手动覆盖，彻底消灭 blocked 红牌锁死，不再影响世界与记忆引擎运行。</li>
        <li>修复冷却漏检主线节点与空门槛卡章问题；补齐 JSON 带错回灌纠错重试、防剧透双轨注入（前台公开指导 + 世界后台幕后备忘硬预算控制）与三页两字单屏 UI（进度 / 剧情 / 注入）。</li>
      </ul>`;

    const panels = {
      common: sec('set-ol-api', '剧情大纲 API', apiHtml)
        + sec('set-ol-rhythm', '检查节奏与重试', rhythmHtml)
        + sec('set-ol-inject', '前台指导注入', injectHtml),
      link: sec('set-ol-link', '三模块弱联动与协同调度', linkHtml),
      advanced: sec('set-ol-adv', '高级与外观', advHtml),
      archive: sec('set-ol-archive', '同步、备份与数据管理', archiveHtml),
      debug: sec('set-ol-debug', '调试与日志', debugHtml),
      about: `<div class="we-section">${aboutHtml}</div>`
    };

    const tabsHtml = `<div class="we-settings-tabs-shell"><div class="we-settings-tabs">${SETTINGS_TABS.map(t =>
      `<button type="button" class="we-settings-tab${t.key === tab ? ' active' : ''}" data-outline-tab="${t.key}">${h(t.label)}</button>`
    ).join('')}</div></div>`;

    return subTopbar('设置', '工欲善其事，必先利其器', 'close-settings')
      + tabsHtml
      + (panels[tab] || panels.common)
      + `<div class="we-settings-save-actions we-settings-save-sticky">${button('save-settings', '保存设置', '', 'primary')}${button('clear-outline', '清空大纲', '', 'danger')}</div>`;
  }

  function renderImportReview() {
    const d = getDraft();
    if (!d.pendingImport) return '';
    const p = d.pendingImport;
    const plan = p.payload?.state?.plan || p.payload?.plan || p.payload;
    return `<div class="we-section we-outline-import-box">
      <div style="font-weight:600;margin-bottom:4px;">确认导入大纲：${h(plan?.title || p.fileName || '未命名')}</div>
      <div class="we-hint" style="margin-bottom:6px;">包含 ${(plan?.chapters || []).length} 章、${(plan?.nodes || []).length} 个节点。</div>
      ${p.sameChat ? `<label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;cursor:pointer;font-size:12px;">
        <input type="checkbox" id="we-outline-import-keep-progress" checked> 保留同聊天原进度
      </label>` : ''}
      <div style="display:flex;gap:6px;">
        ${button('confirm-import', '确认导入', '', 'primary')}
        ${button('cancel-import', '取消')}
      </div>
    </div>`;
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

  // ==================== 计划原子修改与事件绑定 ====================

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
    if (el.dataset.inlineField) {
      const k = el.dataset.inlineField;
      if (k === 'actorsText') {
        f.actors = String(el.value || '').split(/[,，、\n]/).map(clean).filter(Boolean);
      } else {
        f[k] = el.value;
        if (k === 'trackId' && d.inlineEdit.kind === 'node') refresh();
      }
    } else if (el.dataset.inlineBool) {
      f[el.dataset.inlineBool] = Boolean(el.checked);
    } else if (el.dataset.inlineChapters) {
      const cid = el.dataset.inlineChapters;
      const set = new Set(f.chapterIds || []);
      if (el.checked) set.add(cid); else set.delete(cid);
      f.chapterIds = [...set];
    } else if (el.dataset.inlineDeps) {
      const nid = el.dataset.inlineDeps;
      const set = new Set(f.dependencies || []);
      if (el.checked) set.add(nid); else set.delete(nid);
      f.dependencies = [...set];
    }
  }

  function captureSettingField(el) {
    const d = getDraft();
    if (!d.settingsDraft) d.settingsDraft = clone(loadSettings());
    const key = el.dataset.outlineSetting;
    if (!key) return;
    if (el.type === 'checkbox') {
      d.settingsDraft[key] = Boolean(el.checked);
      return;
    }
    const raw = String(el.value ?? '').trim();
    if (key === 'apiTimeoutSec') {
      const n = parseInt(raw, 10);
      d.settingsDraft.apiTimeoutMs = (Number.isFinite(n) ? Math.max(10, Math.min(600, n)) : 120) * 1000;
      return;
    }
    if (key === 'topP') {
      d.settingsDraft.topP = raw === '' ? null : (Number.isFinite(Number(raw)) ? Number(raw) : null);
      return;
    }
    if (['temperature'].includes(key)) {
      d.settingsDraft[key] = raw === '' ? 0.2 : (Number.isFinite(Number(raw)) ? Number(raw) : 0.2);
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
      const ta = document.getElementById('we-outline-source-text');
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
      showToast('已预填世界引擎 API 地址/Key，请点「保存设置」生效');
      refresh();
      return;
    }
    if (action === 'fetch-models') {
      const s = d.settingsDraft || loadSettings();
      try {
        const models = await window.WORLD_ENGINE_API?.fetchModelList?.({ apiUrl: s.apiUrl, apiKey: s.apiKey, connectionMode: s.connectionMode });
        d.fetchedModels = Array.isArray(models) ? models : [];
        showToast(`已获取 ${d.fetchedModels.length} 个模型`);
      } catch (err) {
        showToast(`获取模型列表失败：${err?.message || err}`, true);
      }
      refresh();
      return;
    }
    if (action === 'test-api') {
      const s = d.settingsDraft || loadSettings();
      d.testingApi = true;
      d.apiTestStatus = '正在测试连接…';
      refresh();
      try {
        const res = await window.WORLD_ENGINE_API?.testConnection?.({ apiUrl: s.apiUrl, apiKey: s.apiKey, model: s.model, connectionMode: s.connectionMode });
        d.apiTestStatus = res?.ok !== false ? `连接正常（${res?.latencyMs || 0}ms）` : `测试失败：${res?.error || '未知错误'}`;
      } catch (err) {
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
      const coordEl = document.getElementById('we-outline-coord-mode');
      if (coordEl) window.STORY_ENGINE_BRIDGE?.setCoordinationMode?.(coordEl.value === 'independent' ? 'independent' : 'stagger-serial');
      d.settingsDraft = null;
      engine()?.applyInjection?.();
      showToast('剧情大纲设置已保存');
      refresh();
      return;
    }

    // 存档与导入导出
    if (action === 'snap-create') {
      const nameEl = document.getElementById('we-outline-snap-name');
      const snap = chatCache()?.createSnapshot?.(clean(nameEl?.value) || `手动存档 ${new Date().toLocaleTimeString()}`);
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
      const keepEl = document.getElementById('we-outline-import-keep-progress');
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

  function bind(root) {
    if (!root) return;
    const d = getDraft();

    root.querySelectorAll('[data-outline-action]').forEach(el => {
      el.onclick = e => {
        e.stopPropagation();
        handleAction(el.dataset.outlineAction, el);
      };
    });

    root.querySelectorAll('[data-outline-nav]').forEach(el => {
      el.onclick = () => {
        const target = el.dataset.outlineNav;
        if (d.selectedNavView === target) {
          d.selectedNavView = null;
          d.view = target;
        } else {
          d.selectedNavView = target;
        }
        refresh();
      };
    });

    root.querySelectorAll('[data-outline-tab]').forEach(el => {
      el.onclick = () => {
        d.settingsTab = el.dataset.outlineTab;
        refresh();
      };
    });

    root.querySelectorAll('[data-outline-sec]').forEach(el => {
      el.onclick = () => {
        const k = el.dataset.outlineSec;
        d.collapsedSections[k] = !d.collapsedSections[k];
        refresh();
      };
    });

    root.querySelectorAll('[data-outline-status]').forEach(el => {
      el.onclick = e => e.stopPropagation();
      el.onchange = () => {
        data().setNodeStatus(el.dataset.outlineStatus, el.value);
        engine()?.applyInjection?.();
        showToast('已更新节点状态');
        refresh();
      };
    });

    root.querySelectorAll('[data-inline-field], [data-inline-bool], [data-inline-chapters], [data-inline-deps]').forEach(el => {
      const ev = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'onchange' : 'oninput';
      el[ev] = () => captureInlineField(el);
    });

    root.querySelectorAll('[data-outline-setting]').forEach(el => {
      const ev = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'onchange' : 'oninput';
      el[ev] = () => captureSettingField(el);
    });

    const modelList = root.querySelector('#we-outline-model-list');
    if (modelList) {
      modelList.onchange = () => {
        if (!modelList.value) return;
        if (!d.settingsDraft) d.settingsDraft = clone(loadSettings());
        d.settingsDraft.model = modelList.value;
        refresh();
      };
    }

    const themeSel = root.querySelector('#we-outline-theme-select');
    if (themeSel) {
      themeSel.onchange = () => {
        setStoredOutlineTheme(themeSel.value);
        window.WORLD_ENGINE_UI?.refresh?.();
      };
    }

    const ta = root.querySelector('#we-outline-source-text');
    if (ta) ta.oninput = () => { d.sourceText = ta.value; };

    const textFile = root.querySelector('#we-outline-text-file');
    if (textFile) {
      textFile.onchange = async () => {
        const file = textFile.files?.[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { showToast('文本文件不得超过 5MB', true); return; }
        d.sourceText = await file.text();
        refresh();
      };
    }

    const jsonFile = root.querySelector('#we-outline-json-file');
    if (jsonFile) {
      jsonFile.onchange = async () => {
        const file = jsonFile.files?.[0];
        if (!file) return;
        if (file.size > 32 * 1024 * 1024) { showToast('JSON 文件过大', true); return; }
        try {
          const parsed = JSON.parse(await file.text());
          const plan = parsed?.state?.plan || parsed?.plan || (Array.isArray(parsed?.chapters) ? parsed : null);
          if (!plan || !Array.isArray(plan.chapters)) throw new Error('缺少 plan.chapters 数组');
          const check = data().validatePlan(plan);
          if (!check.valid) throw new Error(check.errors.join('；'));
          const srcChat = clean(parsed?.chatId || parsed?.state?.originChatId);
          d.pendingImport = { payload: parsed, fileName: file.name, sameChat: Boolean(srcChat && srcChat === chatId()) };
          refresh();
        } catch (err) {
          showToast(`读取导入文件失败：${err?.message || err}`, true);
        }
      };
    }

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
        if (!d.settingsOpen) d.settingsDraft = null;
        else d.settingsDraft = clone(loadSettings());
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
        if (!chs.length) return '尚未建纲';
        const idx = Math.max(0, chs.findIndex(c => c.id === st.currentChapterId));
        return `第 ${idx + 1}/${chs.length} 章 · ${(st.plan?.nodes || []).length} 节点`;
      },
      getHeaderMood: () => {
        if (engine()?.isRunning?.()) return { text: engine().getRunningLabel() || '运行中', color: 'var(--we-gold)' };
        const st = loadState();
        const cfg = loadSettings();
        if (cfg.engineEnabled !== true) return { text: '未启用', color: 'var(--we-text3)' };
        if (!(st.plan?.chapters || []).length) return { text: '尚未设置剧情大纲', color: 'var(--we-text3)' };
        if (data().isOutlineFinished(st)) return { text: '已完结', color: 'var(--we-success, #4caf78)' };
        return { text: '推进中', color: 'var(--we-accent)' };
      },
      getTheme: () => getStoredOutlineTheme(),
      refreshDebug: () => refresh(),
      getVersion: () => settingsApi()?.VERSION || '3.0.0',
      getSettings: () => loadSettings(),
      setEnabled: on => {
        settingsApi()?.patchSettings?.({ engineEnabled: Boolean(on) });
        engine()?.applyInjection?.();
        refresh();
      },
      isRunning: () => engine()?.isRunning?.() === true,
      getRunningLabel: () => engine()?.getRunningLabel?.() || '',
      showForward: true,
      showRedo: false,
      forwardTitle: '立即核对剧情进度',
      forward: () => engine()?.checkNow?.(),
      redo: () => engine()?.checkNow?.(),
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
      captureInput: el => {
        if (el?.id === 'we-outline-theme-select') { setStoredOutlineTheme(el.value); return; }
        if (el?.id === 'we-outline-model-list') {
          const d = getDraft();
          if (!d.settingsDraft) d.settingsDraft = clone(loadSettings());
          d.settingsDraft.model = el.value;
          return;
        }
        captureInlineField(el);
        captureSettingField(el);
      },
      getDraft
    }
  };
})();
