// 独立剧情界面：草稿留在当前页面内，只有明确确认后才写入剧情状态。
window.OUTLINE_ENGINE_UI = (function() {
  'use strict';
  const drafts = new Map();
  const STATUS_LABELS = { pending: '待推进', active: '进行中', completed: '完成', skipped: '跳过', blocked: '受阻' };
  let initialized = false;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const h = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const data = () => window.OUTLINE_ENGINE_DATA;
  const engine = () => window.OUTLINE_ENGINE;
  const settings = () => window.OUTLINE_ENGINE_SETTINGS?.getSettings?.(true) || {};
  const chatId = () => String(data()?.getChatId?.() || window.WORLD_ENGINE_CORE?.getChatId?.() || 'default');
  const cache = () => window.WORLD_ENGINE_CHATCACHE?.forScope?.('outline');
  const state = () => data()?.loadState?.() || { plan: { title: '', synopsis: '', constraints: '', chapters: [] }, revision: 0, proposals: [], progressEvents: [] };
  const refresh = () => window.WORLD_ENGINE_UI?.refresh?.();

  function draftFor(id) {
    id = id || chatId();
    if (!drafts.has(id)) drafts.set(id, {
      view: 'home', settingsOpen: false, settingsDraft: null, editorOpen: false,
      plan: null, expectedRevision: null, expectedPlanSnapshot: '', selectedChapterId: '', lastCurrentChapterId: '', sourceText: '',
      textOpen: false, preview: null, previewRevision: null, previewPlanSnapshot: '', pendingJson: null,
      snapshotName: '', message: '', error: false, busy: false
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

  function button(action, label, extra) {
    return `<button type="button" class="we-btn" data-outline-action="${h(action)}"${extra || ''}>${h(label)}</button>`;
  }
  function field(label, name, value, options) {
    const opt = options || {};
    const attrs = `id="we-outline-${h(name)}" data-outline-setting="${h(name)}"`;
    if (opt.type === 'checkbox') return `<label class="we-outline-check"><input ${attrs} type="checkbox"${value ? ' checked' : ''}>${h(label)}</label>`;
    if (opt.choices) return `<label class="we-outline-field"><span>${h(label)}</span><select ${attrs}>${opt.choices.map(([id, text]) => `<option value="${h(id)}"${String(value) === id ? ' selected' : ''}>${h(text)}</option>`).join('')}</select></label>`;
    return `<label class="we-outline-field"><span>${h(label)}</span><input ${attrs} type="${h(opt.type || 'text')}" value="${h(value)}"${opt.min != null ? ` min="${opt.min}"` : ''}${opt.step ? ` step="${opt.step}"` : ''}${opt.type === 'password' ? ' autocomplete="new-password"' : ''}></label>`;
  }
  function planText(value) { return Array.isArray(value) ? value.join('\n') : String(value || ''); }
  function nodeStatus(current, nodeId) {
    try { return data()?.getNodeStatus?.(current, nodeId) || 'pending'; }
    catch (_) { return 'pending'; }
  }
  function chaptersOf(plan) { return Array.isArray(plan?.chapters) ? plan.chapters : []; }

  function renderEvidence(current, node) {
    const manual = current.manualOverrides?.[node.id];
    const events = (current.progressEvents || []).filter(item => item.nodeId === node.id && !['stale', 'invalid'].includes(item.validity) && item.valid !== false && item.stale !== true && Number(item.planRevision) === Number(current.revision));
    const event = events[events.length - 1];
    const evidence = event?.evidence || [];
    return `${manual ? '<div class="we-outline-hint">当前状态由手动指定。</div>' : ''}${evidence.length ? `<details class="we-outline-evidence"><summary>判断证据 ${evidence.length} 条</summary>${evidence.map(item => `<blockquote><span>消息 ${h(item.messageId ?? '未标记')}</span><p>${h(item.quote || '')}</p></blockquote>`).join('')}</details>` : '<div class="we-outline-hint">暂无有效正文证据。</div>'}`;
  }

  function renderHome(current, draft) {
    const plan = current.plan || {}, chapters = chaptersOf(plan);
    if (draft.lastCurrentChapterId !== current.currentChapterId && draft.selectedChapterId === draft.lastCurrentChapterId) draft.selectedChapterId = '';
    draft.lastCurrentChapterId = current.currentChapterId;
    const selected = chapters.find(ch => ch.id === draft.selectedChapterId) || chapters.find(ch => ch.id === current.currentChapterId) || chapters[0];
    const sidebar = chapters.map((chapter, index) => {
      const required = (chapter.nodes || []).filter(node => node.required !== false);
      const done = required.filter(node => ['completed', 'skipped'].includes(nodeStatus(current, node.id))).length;
      return `<button type="button" class="we-outline-chapter${selected?.id === chapter.id ? ' is-selected' : ''}" data-outline-action="select-chapter" data-outline-chapter="${h(chapter.id)}"><span>${index + 1}. ${h(chapter.title || '未命名章节')}</span><small>${chapter.id === current.currentChapterId ? '当前章 · ' : ''}必要节点 ${done}/${required.length}</small></button>`;
    }).join('');
    const nodes = (selected?.nodes || []).map((node, index) => {
      const status = nodeStatus(current, node.id);
      return `<article class="we-outline-node" data-outline-node="${h(node.id)}"><div class="we-outline-node-head"><strong>${index + 1}. ${h(node.title || '未命名节点')}</strong><span class="we-outline-badge">${node.required === false ? '可选' : '必要'}</span><span class="we-outline-status we-outline-status-${h(status)}">${h(STATUS_LABELS[status] || status)}</span></div>${node.intent ? `<p>${h(node.intent)}</p>` : ''}<dl><dt>完成判据</dt><dd>${h(node.completionCriteria || '尚未填写；自动检查不会将此节点标记为完成。')}</dd>${node.notes ? `<dt>备注</dt><dd>${h(node.notes)}</dd>` : ''}</dl>${renderEvidence(current, node)}<label class="we-outline-status-select">手动指定状态 <select data-outline-status="${h(node.id)}" aria-label="${h(node.title)}状态"><option value="" selected>选择手动状态</option>${Object.entries(STATUS_LABELS).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}${current.manualOverrides?.[node.id] ? '<option value="auto">恢复自动判断</option>' : ''}</select></label></article>`;
    }).join('');
    return `<section class="we-outline-plan-heading"><h3>${h(plan.title || '还没有剧情大纲')}</h3>${plan.synopsis ? `<p>${h(plan.synopsis)}</p>` : ''}${plan.constraints ? `<details><summary>剧情约束</summary><p>${h(planText(plan.constraints))}</p></details>` : ''}</section>${chapters.length ? `<div class="we-outline-workspace"><nav class="we-outline-chapters" aria-label="章节列表">${sidebar}</nav><section class="we-outline-chapter-detail"><div class="we-outline-section-head"><h3>${h(selected?.title || '')}</h3>${selected && selected.id !== current.currentChapterId ? button('set-current-chapter', '指定为当前章', ` data-outline-chapter="${h(selected.id)}"`) : '<span class="we-outline-badge">当前章</span>'}</div>${selected?.goal ? `<p class="we-outline-goal">章节目标：${h(selected.goal)}</p>` : ''}${nodes || '<p class="we-outline-empty">本章暂无节点，可在结构编辑中添加。</p>'}</section></div>` : '<p class="we-outline-empty">先手工建立章节，或导入文本让 AI 整理为可编辑的大纲。</p>'}${renderSuggestions(current)}`;
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
    return `<section class="we-outline-suggestions"><h3>AI 调整建议</h3><p class="we-outline-hint">建议只在采纳后改动大纲。未来安排不会写成已发生的事实。</p>${suggestions.map(proposal => {
      const before = proposal.before && typeof proposal.before === 'object' ? proposal.before : { content: proposal.before };
      const after = proposal.after && typeof proposal.after === 'object' ? proposal.after : { content: proposal.after };
      const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
      const stale = proposal.status === 'stale' || Number(proposal.planRevision) !== Number(current.revision);
      return `<article class="we-outline-proposal"><div class="we-outline-section-head"><strong>${h(proposal.reason || '剧情调整')}</strong>${stale ? '<span class="we-outline-badge">已过期，请重新检查</span>' : ''}</div><div class="we-outline-table-scroll"><table><thead><tr><th>内容</th><th>原内容</th><th>建议内容</th></tr></thead><tbody>${keys.map(key => `<tr><th>${h(labels[key] || key)}</th><td><pre>${h(displayDiff(before[key]))}</pre></td><td><pre>${h(displayDiff(after[key]))}</pre></td></tr>`).join('') || '<tr><td colspan="3">没有可展示的改动</td></tr>'}</tbody></table></div>${proposal.evidence ? `<p class="we-outline-hint">依据：${h(displayDiff(proposal.evidence))}</p>` : ''}<div class="we-outline-actions">${button('accept-proposal', '采纳', ` data-outline-proposal="${h(proposal.id)}"${stale ? ' disabled' : ''}`)}${button('dismiss-proposal', '拒绝', ` data-outline-proposal="${h(proposal.id)}"`)}</div></article>`;
    }).join('')}</section>`;
  }

  function editorField(label, value, attributes, multiline) {
    return `<label class="we-outline-field"><span>${h(label)}</span>${multiline ? `<textarea ${attributes} rows="3">${h(planText(value))}</textarea>` : `<input type="text" ${attributes} value="${h(value)}">`}</label>`;
  }

  function renderEditor(draft) {
    const plan = draft.plan || { title: '', synopsis: '', constraints: '', chapters: [] };
    const saved = state();
    const changed = Number(draft.expectedRevision) !== Number(saved.revision) || draft.expectedPlanSnapshot !== JSON.stringify(saved.plan);
    const conflict = changed ? `<section class="we-outline-preview"><h4>当前保存的大纲已发生变化</h4><p>你的草稿已保留。继续保存会用草稿替换当前版本，请先核对下面的内容。</p><details><summary>查看当前版本：${h(saved.plan?.title || '未命名大纲')}</summary>${chaptersOf(saved.plan).map(chapter => `<h4>${h(chapter.title)}</h4><p>${h(chapter.goal)}</p><ol>${(chapter.nodes || []).map(node => `<li>${h(node.title)}<p>${h(node.completionCriteria)}</p></li>`).join('')}</ol>`).join('')}</details>${button('rebase-editor', '已核对，保留草稿继续保存')}</section>` : '';
    return `<section class="we-outline-editor"><div class="we-outline-section-head"><h3>编辑大纲结构</h3><span class="we-outline-hint">未保存的草稿会保留到关闭页面。</span></div>${conflict}${editorField('大纲标题', plan.title, 'data-outline-plan-field="title"')}${editorField('剧情梗概', plan.synopsis, 'data-outline-plan-field="synopsis"', true)}${editorField('全局约束', plan.constraints, 'data-outline-plan-field="constraints"', true)}${chaptersOf(plan).map((chapter, ci) => `<section class="we-outline-edit-chapter" data-outline-chapter-index="${ci}"><div class="we-outline-section-head"><strong>第 ${ci + 1} 章</strong><div class="we-outline-actions">${button('chapter-up', '上移', ` data-outline-ci="${ci}"${ci === 0 ? ' disabled' : ''}`)}${button('chapter-down', '下移', ` data-outline-ci="${ci}"${ci === plan.chapters.length - 1 ? ' disabled' : ''}`)}${button('chapter-remove', '删除章节', ` data-outline-ci="${ci}"`)}</div></div>${editorField('章节标题', chapter.title, `data-outline-chapter-field="title" data-outline-ci="${ci}"`)}${editorField('章节目标', chapter.goal, `data-outline-chapter-field="goal" data-outline-ci="${ci}"`, true)}${(chapter.nodes || []).map((node, ni) => `<article class="we-outline-edit-node"><div class="we-outline-section-head"><strong>节点 ${ni + 1}</strong><div class="we-outline-actions">${button('node-up', '上移', ` data-outline-ci="${ci}" data-outline-ni="${ni}"${ni === 0 ? ' disabled' : ''}`)}${button('node-down', '下移', ` data-outline-ci="${ci}" data-outline-ni="${ni}"${ni === chapter.nodes.length - 1 ? ' disabled' : ''}`)}${button('node-remove', '删除节点', ` data-outline-ci="${ci}" data-outline-ni="${ni}"`)}</div></div>${editorField('节点标题', node.title, `data-outline-node-field="title" data-outline-ci="${ci}" data-outline-ni="${ni}"`)}${editorField('节点意图', node.intent, `data-outline-node-field="intent" data-outline-ci="${ci}" data-outline-ni="${ni}"`, true)}${editorField('完成判据', node.completionCriteria, `data-outline-node-field="completionCriteria" data-outline-ci="${ci}" data-outline-ni="${ni}"`, true)}${editorField('备注', node.notes, `data-outline-node-field="notes" data-outline-ci="${ci}" data-outline-ni="${ni}"`, true)}<label class="we-outline-check"><input type="checkbox" data-outline-node-field="required" data-outline-ci="${ci}" data-outline-ni="${ni}"${node.required !== false ? ' checked' : ''}>必要节点</label></article>`).join('')}${button('node-add', '增加节点', ` data-outline-ci="${ci}"`)}</section>`).join('')}<div class="we-outline-actions">${button('chapter-add', '增加章节')}${button('save-plan', '确认保存大纲')}${button('close-editor', '收起编辑（保留草稿）')}${button('discard-editor', '放弃草稿')}</div></section>`;
  }

  function renderTextImport(draft) {
    return `<section class="we-outline-text-import"><h3>将文本整理成大纲</h3><label class="we-outline-field"><span>粘贴已有剧情计划，或选择 .txt / .md 文件</span><textarea id="we-outline-source-text" rows="9">${h(draft.sourceText)}</textarea></label><input id="we-outline-text-file" type="file" accept=".txt,.md,text/plain,text/markdown"><div class="we-outline-actions">${button('organize-text', draft.busy ? '正在整理…' : 'AI 整理并预览', draft.busy ? ' disabled' : '')}${button('close-text', '收起（保留文本）')}</div><p class="we-outline-hint">整理结果会先显示预览，确认后才替换当前大纲。</p>${draft.preview ? `<section class="we-outline-preview"><h4>整理预览：${h(draft.preview.title || '未命名大纲')}</h4><p>${h(draft.preview.synopsis || '')}</p>${chaptersOf(draft.preview).map(chapter => `<details open><summary>${h(chapter.title || '未命名章节')} · ${(chapter.nodes || []).length} 个节点</summary><p>${h(chapter.goal || '')}</p><ol>${(chapter.nodes || []).map(node => `<li><strong>${h(node.title)}</strong><p>${h(node.completionCriteria || '未设置完成判据')}</p></li>`).join('')}</ol></details>`).join('')}<div class="we-outline-actions">${button('adopt-preview', '确认采用整理结果')}${button('edit-preview', '先编辑此结果')}${button('discard-preview', '丢弃预览')}</div></section>` : ''}</section>`;
  }

  function renderSettings(draft) {
    const value = draft.settingsDraft || settings();
    return `<section class="we-outline-settings">
      <h3>剧情大纲设置</h3>
      <div class="we-outline-form-grid">
        ${field('启用剧情模块', 'engineEnabled', value.engineEnabled, { type: 'checkbox' })}
        ${field('自动检查新增正文', 'autoCheck', value.autoCheck !== false, { type: 'checkbox' })}
        ${field('每多少个新增轮次检查一次', 'checkEveryX', value.checkEveryX ?? 3, { type: 'number', min: 1, step: 1 })}
        ${field('允许 AI 提出结构调整建议', 'allowProposals', value.allowProposals !== false, { type: 'checkbox' })}
        ${field('注入正文指导', 'injectIntoPrompt', value.injectIntoPrompt !== false, { type: 'checkbox' })}
        ${field('将当前剧情指导提供给世界推演', 'injectIntoWorldEngine', value.injectIntoWorldEngine !== false, { type: 'checkbox' })}
        ${field('注入目标字数预算', 'injectMaxChars', value.injectMaxChars ?? 2500, { type: 'number', min: 200, step: 100 })}
      </div>
      <p class="we-outline-hint">超长核心约束和当前节点会完整保留，优先裁剪可选背景。</p>
      <h4>API 连接</h4>
      ${field('API 来源', 'apiSource', value.apiSource || 'world', { choices: [['world', '复用世界引擎 API'], ['custom', '剧情模块独立 API']] })}
      <p class="we-outline-hint">复用模式读取世界引擎已配置的连接；这里的保存不会改写世界或记忆的设置。</p>
      <fieldset class="we-outline-custom-api"${value.apiSource === 'custom' ? '' : ' disabled'}>
        <legend>独立 API 配置</legend><div class="we-outline-form-grid">
          ${field('API URL（含版本前缀）', 'apiUrl', value.apiUrl || '')}
          ${field('API Key', 'apiKey', value.apiKey || '', { type: 'password' })}
          ${field('模型', 'model', value.model || '')}
          ${field('连接方式', 'connectionMode', value.connectionMode || 'direct', { choices: [['direct', '浏览器直连'], ['proxy', '经酒馆服务端代理']] })}
          ${field('温度', 'temperature', value.temperature ?? 0.2, { type: 'number', min: 0, step: 0.1 })}
          ${field('最大输出 tokens', 'maxTokens', value.maxTokens ?? 8192, { type: 'number', min: 1, step: 1 })}
          ${field('请求超时（秒，0 为不限）', 'apiTimeoutSeconds', (value.apiTimeoutMs ?? 120000) / 1000, { type: 'number', min: 0, step: 1 })}
        </div>
      </fieldset>
      <h4>当前聊天存档</h4>
      ${field('实时同步到酒馆聊天', 'syncToChat', value.syncToChat, { type: 'checkbox' })}
      ${field('自动备份', 'autoBackup', value.autoBackup, { type: 'checkbox' })}
      <div class="we-outline-actions">${button('save-settings', '保存剧情设置')}${button('close-settings', '返回（保留设置草稿）')}${button('check-now', '立即检查正文')}</div>
    </section>`;
  }

  function renderTransfer(current, draft) {
    let cc, status, snapshots = [];
    try { cc = cache(); status = cc?.getStatus?.(); snapshots = cc?.listSnapshots?.() || []; } catch (_) {}
    const preview = draft.pendingJson;
    return `<section class="we-outline-transfer"><h3>导入导出与聊天存档</h3><div class="we-outline-actions">${button('export-full', '导出完整 JSON')}${button('export-plan', '只导出大纲 JSON')}</div><label class="we-outline-field"><span>导入大纲或完整 JSON</span><input id="we-outline-json-file" type="file" accept=".json,application/json"></label><p class="we-outline-hint">导入会先预览。跨聊天导入会清除原聊天的执行进度与证据。</p>${preview ? `<section class="we-outline-preview"><h4>待导入：${h(preview.plan?.title || '未命名大纲')}</h4><p>${chaptersOf(preview.plan).length} 个章节；${chaptersOf(preview.plan).reduce((sum, ch) => sum + (ch.nodes || []).length, 0)} 个节点。</p>${preview.sameChat ? `<label class="we-outline-check"><input id="we-outline-import-progress" type="checkbox"${preview.includeProgress ? ' checked' : ''}>恢复此聊天的原执行进度</label>` : '<p class="we-outline-hint">执行进度将从当前聊天重新开始。</p>'}<div class="we-outline-actions">${button('confirm-json-import', '确认导入')}${button('cancel-json-import', '取消导入')}</div></section>` : ''}<h4>聊天存档</h4><p class="we-outline-hint">${status ? `实时同步${status.syncEnabled ? '已开启' : '已关闭'} · 本地修订 ${h(status.localRev ?? 0)} / 聊天修订 ${h(status.liveRev ?? 0)} · ${snapshots.length} 份存档` : '当前未启用聊天存档接口。'}</p><div class="we-outline-actions"><input id="we-outline-snapshot-name" type="text" value="${h(draft.snapshotName)}" placeholder="存档名称">${button('snapshot-create', '新建命名存档', cc ? '' : ' disabled')}</div>${snapshots.map(snap => `<article class="we-outline-snapshot"><div><strong>${h(snap.name || '未命名存档')}</strong><small>${snap.auto ? '自动' : '手动'} · ${h(snap.createdAt ? new Date(snap.createdAt).toLocaleString() : '')}</small></div><div class="we-outline-actions">${button('snapshot-restore', '恢复', ` data-outline-snapshot="${h(snap.id)}"`)}${button('snapshot-rename', '重命名', ` data-outline-snapshot="${h(snap.id)}"`)}${button('snapshot-export', '导出', ` data-outline-snapshot="${h(snap.id)}"`)}${button('snapshot-delete', '删除', ` data-outline-snapshot="${h(snap.id)}"`)}</div></article>`).join('')}<label class="we-outline-field"><span>导入聊天存档 JSON</span><input id="we-outline-snapshot-file" type="file" accept=".json,application/json"></label></section>`;
  }

  function renderDebug() {
    const debug = engine()?.getLastDebug?.() || {};
    let injection = null;
    try { injection = window.WORLD_ENGINE_INJECT_INSPECTOR?.getLastSnapshot?.('outline'); } catch (_) {}
    return `<section class="we-outline-debug"><h3>剧情运行与注入调试</h3><p>运行状态：${h(engine()?.getRunningLabel?.() || (engine()?.isRunning?.() ? '运行中' : '空闲'))}</p><p>最近错误：${h(engine()?.getLastError?.() || '无')}</p><p>最终提示词注入：${h(injection?.status || '尚无记录')}</p><div class="we-outline-actions">${button('export-diag', '导出剧情诊断包')}</div><details><summary>最近请求</summary><pre>${h(debug.prompt || debug.requestPrompt || '暂无请求')}</pre></details><details><summary>最近响应</summary><pre>${h(debug.rawResult || debug.response || debug.apiResponse || '暂无响应')}</pre></details>${injection ? `<details><summary>最近注入检查</summary><pre>${h(JSON.stringify(injection, null, 2))}</pre></details>` : ''}</section>`;
  }

  function render() {
    const draft = draftFor(), current = state();
    const running = draft.busy || Boolean(engine()?.isRunning?.());
    const enabled = settings().engineEnabled === true;
    return `<div class="we-outline-root"><div class="we-outline-toolbar"><div class="we-outline-actions">${button('view-home', '章节与进度')}${button('edit-plan', draft.plan ? '继续编辑草稿' : '编辑大纲')}${button('open-text', '整理文本')}${button('view-transfer', '存档与导入导出')}${button('view-debug', '调试')}</div><div class="we-outline-actions">${button('toggle-settings', '剧情设置')}${button('check-now', running ? '检查中…' : '立即检查', running || !enabled ? ' disabled' : '')}${running ? button('abort', '停止') : ''}</div></div><p class="we-outline-hint">${enabled ? '剧情模块已启用' : '剧情模块当前关闭；可编辑和保存大纲，启用后才自动检查与注入。'}</p>${draft.message ? `<p role="status" class="we-outline-message${draft.error ? ' is-error' : ''}">${h(draft.message)}</p>` : ''}${draft.settingsOpen ? renderSettings(draft) : `${draft.editorOpen ? renderEditor(draft) : ''}${draft.textOpen ? renderTextImport(draft) : ''}${draft.view === 'transfer' ? renderTransfer(current, draft) : draft.view === 'debug' ? renderDebug() : renderHome(current, draft)}`}</div>`;
  }

  function commitReviewedPlan(plan, revision, snapshot) {
    // 导入或恢复存档可能带回相同修订号；还需比对用户开始审阅时的计划本身。
    if (snapshot && snapshot !== JSON.stringify(state().plan)) throw new Error('审阅期间大纲已变化。草稿已保留，请对照当前大纲后重试。');
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
    draft.settingsOpen = false;
  }

  function captureInput(element) {
    if (!element) return;
    const draft = draftFor(), ds = element.dataset || {};
    if (element.id === 'we-outline-source-text') draft.sourceText = element.value;
    else if (element.id === 'we-outline-snapshot-name') draft.snapshotName = element.value;
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
    } else if (ds.outlinePlanField && draft.plan) draft.plan[ds.outlinePlanField] = element.value;
    else if (ds.outlineChapterField && draft.plan?.chapters?.[Number(ds.outlineCi)]) draft.plan.chapters[Number(ds.outlineCi)][ds.outlineChapterField] = element.value;
    else if (ds.outlineNodeField) {
      const node = draft.plan?.chapters?.[Number(ds.outlineCi)]?.nodes?.[Number(ds.outlineNi)];
      if (node) node[ds.outlineNodeField] = element.type === 'checkbox' ? element.checked : element.value;
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

  function uid(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
  function reorder(list, index, step) {
    const next = index + step;
    if (list && next >= 0 && index >= 0 && index < list.length && next < list.length) [list[index], list[next]] = [list[next], list[index]];
  }

  async function handleAction(action, element) {
    const draft = draftFor(), ds = element?.dataset || {}, current = state();
    const ci = Number(ds.outlineCi), ni = Number(ds.outlineNi);
    if (action === 'view-home' || action === 'view-transfer' || action === 'view-debug') { draft.view = action.slice(5); draft.settingsOpen = false; }
    else if (action === 'toggle-settings') { draft.settingsOpen = !draft.settingsOpen; if (!draft.settingsDraft) draft.settingsDraft = clone(settings()); }
    else if (action === 'close-settings') draft.settingsOpen = false;
    else if (action === 'edit-plan') startEditor();
    else if (action === 'close-editor') draft.editorOpen = false;
    else if (action === 'rebase-editor') { draft.expectedRevision = current.revision; draft.expectedPlanSnapshot = JSON.stringify(current.plan); draft.message = '已保留草稿并采用当前大纲作为保存基底。'; draft.error = false; }
    else if (action === 'discard-editor') { if (!window.confirm || window.confirm('放弃当前未保存的大纲草稿？')) { draft.editorOpen = false; draft.plan = null; } }
    else if (action === 'open-text') { draft.textOpen = true; draft.settingsOpen = false; }
    else if (action === 'close-text') draft.textOpen = false;
    else if (action === 'select-chapter') draft.selectedChapterId = ds.outlineChapter === current.currentChapterId ? '' : ds.outlineChapter;
    else if (action === 'set-current-chapter') { engine()?.abort?.(); data().setCurrentChapter(ds.outlineChapter); draft.selectedChapterId = ''; engine()?.applyInjection?.(); notify('已指定当前章节。'); }
    else if (action === 'chapter-add') { draft.plan.chapters.push({ id: uid('chapter'), title: '新章节', goal: '', nodes: [] }); }
    else if (action === 'chapter-remove') { if (!window.confirm || window.confirm('从草稿删除此章节及其节点？')) draft.plan.chapters.splice(ci, 1); }
    else if (action === 'chapter-up' || action === 'chapter-down') reorder(draft.plan.chapters, ci, action.endsWith('up') ? -1 : 1);
    else if (action === 'node-add') draft.plan.chapters[ci].nodes.push({ id: uid('node'), title: '新节点', intent: '', completionCriteria: '', notes: '', required: true });
    else if (action === 'node-remove') draft.plan.chapters[ci].nodes.splice(ni, 1);
    else if (action === 'node-up' || action === 'node-down') reorder(draft.plan.chapters[ci].nodes, ni, action.endsWith('up') ? -1 : 1);
    else if (action === 'save-plan') {
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
      const requestKeys = ['engineEnabled', 'autoCheck', 'checkEveryX', 'allowProposals', 'apiSource', 'apiUrl', 'apiKey', 'model', 'connectionMode', 'temperature', 'maxTokens', 'apiTimeoutMs'];
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
    } else if (action === 'abort') { engine()?.abort?.(); notify('已发送停止信号。'); }
    else if (action === 'accept-proposal') { await engine().applyProposal(ds.outlineProposal, current.revision); notify('已采纳剧情调整建议。'); }
    else if (action === 'dismiss-proposal') { await engine().dismissProposal(ds.outlineProposal); notify('已拒绝此建议。'); }
    else if (action === 'export-full') download(data().exportData(), `outline-full-${Date.now()}.json`);
    else if (action === 'export-plan') download({ __outlineEnginePlan: true, schemaVersion: 1, plan: current.plan }, `outline-plan-${Date.now()}.json`);
    else if (action === 'cancel-json-import') draft.pendingJson = null;
    else if (action === 'confirm-json-import') {
      const preview = draft.pendingJson;
      if (!preview) throw new Error('请先选择待导入文件。');
      data().importData(preview.payload, { includeProgress: preview.sameChat && preview.includeProgress });
      draft.pendingJson = null; draft.message = '大纲数据已导入。'; engine()?.applyInjection?.();
    } else if (action === 'snapshot-create') {
      if (!cache()?.createSnapshot?.(draft.snapshotName.trim() || '剧情存档')) throw new Error('未能创建存档，请检查当前聊天与剧情数据。');
      draft.snapshotName = ''; draft.message = '剧情存档已创建。';
    } else if (action === 'snapshot-restore') {
      if (!window.confirm || window.confirm('恢复此剧情存档？当前剧情状态将替换为存档内容。')) {
        if (!cache()?.restoreSnapshot?.(ds.outlineSnapshot)) throw new Error('恢复存档失败。');
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
    } else if (action === 'export-diag') window.WORLD_ENGINE_DIAG?.download?.('outline');
    refresh();
  }

  async function importFile(file, kind) {
    const originId = chatId(), draft = draftFor(originId);
    if (!file) return;
    const allowed = kind === 'text' ? /\.(txt|md)$/i : /\.json$/i;
    if (!allowed.test(String(file.name || ''))) throw new Error(kind === 'text' ? '仅支持 .txt 和 .md 文本文件。' : '请选择 .json 文件。');
    if (Number(file.size) > 5 * 1024 * 1024) throw new Error('文件超过 5 MB，请先精简内容。');
    const text = await file.text();
    ensureCurrentChat(originId);
    if (kind === 'text') { draft.sourceText = text; draft.message = '文本已载入，点击 AI 整理并预览后再确认采用。'; }
    else {
      let payload;
      try { payload = JSON.parse(text); } catch (_) { throw new Error('JSON 格式无效，尚未导入任何内容。'); }
      if (kind === 'snapshot') {
        if (!window.confirm || window.confirm('将这份剧情快照导入当前聊天的存档列表？')) {
          if (!cache()?.importSnapshot?.(payload)) throw new Error('文件不是有效的剧情存档。');
          draft.message = '剧情存档已导入列表；点击恢复后才替换当前进度。';
        }
      } else {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('文件不包含有效的大纲对象。');
        const candidate = payload.plan || payload.state?.plan || payload;
        if (!Array.isArray(candidate.chapters)) throw new Error('文件中没有 chapters 章节列表。');
        const plan = data().normalizePlan(candidate);
        draft.pendingJson = { payload: clone(payload), plan, sameChat: String(payload.chatId || '') === originId, includeProgress: false };
        draft.message = 'JSON 已读取。请确认导入范围后再写入。';
      }
    }
    refresh();
  }

  function bind(body) {
    const root = body?.querySelector?.('.we-outline-root') || document.querySelector('.we-outline-root');
    if (!root) return;
    root.oninput = event => captureInput(event.target);
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
        } else if (element.id === 'we-outline-text-file' || element.id === 'we-outline-json-file' || element.id === 'we-outline-snapshot-file') {
          await importFile(element.files?.[0], element.id === 'we-outline-text-file' ? 'text' : element.id === 'we-outline-snapshot-file' ? 'snapshot' : 'json');
          element.value = '';
        } else if (element?.dataset?.outlineSetting === 'apiSource') refresh();
      } catch (error) { notify(error?.message || error, true); }
    };
    root.onclick = async event => {
      const element = event.target?.closest?.('[data-outline-action]');
      if (!element || !root.contains(element)) return;
      event.preventDefault();
      try { await handleAction(element.dataset.outlineAction, element); }
      catch (error) { notify(error?.message || error, true); }
    };
  }

  function init() {
    if (initialized) return;
    if (!window.WORLD_ENGINE_UI?.registerEngineFace) throw new Error('剧情界面需要共用 UI 注册入口。');
    window.WORLD_ENGINE_UI.registerEngineFace({
      id: 'outline', label: '剧情大纲', panelClass: 'we-outline-face', ballClass: 'we-ball-outline-face',
      render, bind,
      openSettings: () => { const draft = draftFor(); draft.settingsOpen = !draft.settingsOpen; if (!draft.settingsDraft) draft.settingsDraft = clone(settings()); },
      isSettingsOpen: () => { const draft = draftFor(); return draft.settingsOpen || draft.editorOpen || draft.textOpen || Boolean(draft.pendingJson); },
      isEditing: () => { const draft = draftFor(); return draft.editorOpen || draft.textOpen || Boolean(draft.pendingJson); },
      getHeaderText: () => { const current = state(); const chapter = chaptersOf(current.plan).find(item => item.id === current.currentChapterId); return chapter ? `当前章：${chapter.title || '未命名章节'}` : '尚未设置剧情大纲'; },
      getTheme: () => { try { return localStorage.getItem('we-theme') || 'default'; } catch (_) { return 'default'; } },
      getVersion: () => window.OUTLINE_ENGINE_SETTINGS?.VERSION || '1.0.0',
      getSettings: settings,
      setEnabled: enabled => { if (!enabled) engine()?.abort?.(); window.OUTLINE_ENGINE_SETTINGS.patchSettings({ engineEnabled: enabled }); if (draftFor().settingsDraft) draftFor().settingsDraft.engineEnabled = enabled; engine()?.applyInjection?.(); },
      isRunning: () => draftFor().busy || Boolean(engine()?.isRunning?.()),
      getRunningLabel: () => engine()?.getRunningLabel?.() || (draftFor().busy ? '剧情任务' : ''),
      showForward: true, showRedo: false, forwardTitle: '立即检查剧情进度',
      forward: () => handleAction('check-now'), redo: () => handleAction('check-now'), abort: () => engine()?.abort?.()
    });
    initialized = true;
  }

  return { init, render, bind, _test: { h, draftFor, captureInput, handleAction, importFile, renderSuggestions } };
})();
