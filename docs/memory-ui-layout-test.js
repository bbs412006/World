const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'world-engine-ui.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

assert.match(ui, /_memorySeenRecords = new Set\(\)/, '记忆数据需要记录首次展示状态');
assert.match(ui, /_memoryCollapsedRecords\.add\(key\)/, '记忆数据首次展示必须默认折叠');
assert.match(ui, /function renderMemoryTables\(state\)/, '记忆模块必须提供核心 7 表电子表格视图');
assert.match(ui, /we-db-tabs/, '核心 7 表视图必须具备分表切换标签栏');
assert.match(ui, /we-db-table/, '核心 7 表视图必须渲染标准表格');
assert.match(ui, /function renderMemoryTableRowEditor\(/, '必须支持通用表结构行内编辑器');
const dataJs = fs.readFileSync(path.join(root, 'memory-engine-data.js'), 'utf8');
for (const label of ['全局数据表', '主角信息表', '重要角色表', '主角技能表', '背包物品表', '任务与事件表', '纪要表']) {
  assert.ok(dataJs.includes(label), `核心 7 表 schema 缺少表名：${label}`);
}
assert.match(ui, /const cards = items\.map\(\(item, index\)/, '纪要必须渲染全部数据');
assert.ok(!ui.includes('renderMemoryOverview'), '去除总述后不应保留总述渲染视图');
assert.match(ui, /defaultCollapsed = index !== items\.length - 1/g, '纪要必须只默认展开最新一条');
assert.match(ui, /we-memory-record-head" data-memory-collapse-key=/, '记忆卡片标题栏必须支持整块点击');
assert.match(ui, /默认展开最新一条/, '纪要应提示默认展开最新数据');
assert.ok(
  ui.includes('we-memory-small-code') &&
  ui.includes('we-memory-small-timespan') &&
  ui.includes('we-memory-small-summary') &&
  ui.includes('we-memory-small-dialogue'),
  '纪要编辑器必须包含编号索引、时间跨度、概览与重要对话字段'
);
assert.ok(
  ui.includes('we-memory-skip-current-floor') &&
  ui.includes('we-memory-auto-refill-history') &&
  ui.includes('we-memory-small-summary-inject-limit') &&
  ui.includes('we-memory-catchup-now') &&
  ui.includes('we-memory-catchup-batch') &&
  ui.includes('we-memory-wave-preview') &&
  ui.includes('we-memory-fill-max-retries') &&
  ui.includes('we-memory-table-cfg-enabled') &&
  ui.includes('we-memory-table-cfg-freq') &&
  ui.includes('we-memory-range-fill-start') &&
  ui.includes('we-memory-range-start') &&
  ui.includes('we-memory-range-end') &&
  ui.includes('we-memory-home-fill-status'),
  '记忆界面应包含当前层不填表、Wave 计划预览、独立追平批大小、纠错重试、分表独立频率开关与指定范围填表控件'
);
const homeFn = ui.slice(ui.indexOf('function renderMemoryHomeView()'), ui.indexOf('const MEMORY_VIEW_META'));
assert.ok(homeFn.includes('renderMemoryCoreActions(') && homeFn.includes("view: 'fill'") && homeFn.includes("view: 'tables'"), '记忆首页只保留核心仪表、一键追平快捷按钮与包含「数据库表/纪要表/智能填表」的导航');
assert.ok(!homeFn.includes('renderMemoryFillPage('), '范围填表等完整工具不应平铺在记忆首页');
const actionsFn = ui.slice(ui.indexOf('function renderMemoryCoreActions('), ui.indexOf('function renderMemoryFillPage('));
assert.ok(actionsFn.includes('we-memory-catchup-now') && !actionsFn.includes('we-memory-range-fill-start'), '首页快捷区仅含一键追平，不含范围填表');
const fillFn = ui.slice(ui.indexOf('function renderMemoryFillPage('), ui.indexOf('function renderMemoryHomeView()'));
assert.ok(
  fillFn.includes('we-memory-catchup-include-current') &&
  fillFn.includes('we-memory-wave-preview') &&
  fillFn.includes('we-memory-catchup-batch') &&
  fillFn.includes('we-sheet-chip') &&
  fillFn.includes('we-memory-range-fill-start') &&
  fillFn.includes('we-memory-range-start') &&
  fillFn.includes('we-memory-home-fill-status'),
  '「智能填表」分页应集中提供 7 表水位勾选、零 Token Wave 计划预览、一键追平（独立批大小/含当前层）与范围填表'
);
assert.match(ui, /safeView === 'fill' \? renderMemoryFillPage\(/, '记忆分页路由必须接入「填表」分页');
for (const fn of ['function renderSubView(', 'function renderMemorySubView(', 'function renderMemorySettingsView(', 'function renderSettingsView(']) {
  const start = ui.indexOf(fn);
  assert.ok(start >= 0, `缺少 ${fn}`);
  const end = ui.indexOf('\n  function ', start + fn.length);
  const body = ui.slice(start, end > start ? end : undefined);
  assert.ok(body.includes('renderSubTopbar('), `${fn} 应使用三模块统一的分页顶栏 renderSubTopbar`);
}
const worldHomeFn = ui.slice(ui.indexOf('function renderHomeView('), ui.indexOf('function renderHomeViewExpanded('));
assert.ok(!worldHomeFn.includes('renderWorldDigest('), '世界首页不应再平铺世界摘要（已下沉至「局势」分页）');
assert.match(ui, /content = renderWorldDigest\(s, scope\)\s*\+ renderSection\('天下大势'/, '世界摘要应位于「局势」分页顶部');
const minutesFn = ui.slice(ui.indexOf('function renderMemoryMinutes(state)'), ui.indexOf('function renderMemorySubView(view)'));
assert.ok(
  !minutesFn.includes('we-memory-catchup-now') && !minutesFn.includes('we-memory-range-fill-start'),
  '纪要子页不应再重复放置全要素一键追平与范围填表工具栏'
);

assert.ok(ui.includes('we-memory-export-package') && ui.includes('we-memory-import-package'), '记忆设置应支持总结记忆包导入导出');
assert.ok(ui.includes('we-memory-delay-floors') && ui.includes('we-memory-coordination-mode'), '记忆设置应开放延迟楼层与三模块并发调度策略');
assert.ok(ui.includes('we-world-coordination-mode') && ui.includes('we-world-accept-outline') && ui.includes('we-world-sync-outline') && ui.includes('we-world-accept-memory'), '世界设置联动页应支持三模块协同策略及与记忆、大纲的双向配置');
assert.ok(ui.includes('we-memory-inject-outline') && ui.includes('we-memory-accept-outline') && ui.includes('we-memory-accept-world-hint'), '记忆设置联动页应支持与世界、大纲的双向配置');
assert.ok(ui.includes("key: 'recall'") && ui.includes('we-memory-embedding-url') && ui.includes('we-memory-rerank-model'), '记忆设置应提供 Embedding/Rerank 记忆检索选项卡');
assert.ok(
  ui.includes('we-memory-fetch-embedding-models') &&
  ui.includes('we-memory-embedding-model-list') &&
  ui.includes('we-memory-fetch-rerank-models') &&
  ui.includes('we-memory-rerank-model-list'),
  '记忆检索设置应提供 Embedding 与 Rerank 模型列表拉取及下拉选择控件'
);
assert.ok(
  ui.includes('we-memory-embedding-timeout-sec') &&
  ui.includes('we-memory-rerank-timeout-sec') &&
  ui.includes('we-memory-rerank-weight'),
  '记忆检索设置应提供独立 Embedding/Rerank 超时与混合权重调节控件'
);
assert.ok(
  ui.includes("sec('set-api', '世界引擎API'") &&
  !ui.includes("sec('set-api', 'API 配置'"),
  '世界引擎 API 分区标题应改为「世界引擎API」'
);
assert.ok(
  ui.includes('id="we-stream"') &&
  ui.includes('id="we-test-api"') &&
  ui.includes('id="we-memory-copy-world-api"') &&
  ui.includes('id="we-stream-idle-timeout-sec"') &&
  ui.includes('id="we-json-mode"') &&
  ui.includes('id="we-top-p"') &&
  ui.includes('id="we-reasoning-effort"'),
  '世界与记忆引擎 API 设置应包含流式、连接测试、预填世界连接、流式空闲超时、JSON 模式、top_p 与推理力度控件'
);
assert.match(css, /\.we-api-adv-fold/, 'CSS 应包含高级 API 参数折叠面板样式');
assert.match(css, /\.we-db-tabs/, 'CSS 应包含核心 7 表标签栏样式');
assert.match(css, /\.we-db-table/, 'CSS 应包含核心 7 表表格样式');
assert.match(css, /\.we-wave-preview/, 'CSS 应包含 Wave 追平计划预览框样式');
assert.match(css, /\.we-sheet-chip-grid/, 'CSS 应包含 7 表水位选择网格样式');
assert.match(css, /\.we-prompt-codearea/, 'CSS 应包含可编辑提示词代码文本域样式');
assert.match(css, /\.we-prompt-badge/, 'CSS 应包含提示词默认/自定义状态徽章样式');
assert.match(css, /\.we-memory-kw-tag/, 'CSS 应包含记忆关键词标签样式');
assert.match(css, /\.we-memory-recall-hit/, 'CSS 应包含向量/Rerank 召回预览样式');
assert.ok(
  ui.includes("key: 'prompts', label: '提示词'") &&
  ui.includes('we-memory-system-prompt') &&
  ui.includes('we-memory-sheet-rule-select') &&
  ui.includes('we-memory-sheet-rule-editor') &&
  ui.includes('we-memory-reset-system-prompt') &&
  ui.includes('we-memory-reset-sheet-rule') &&
  ui.includes('we-memory-reset-all-prompts'),
  '记忆设置应提供可编辑的底层填表 System Prompt 与 7 表规则选项卡及一键恢复默认按钮'
);
for (const obsoleteId of [
  'we-memory-enable-structured',
  'we-memory-max-per-character',
  'we-memory-inject-facts-limit',
  'we-memory-inject-arcs-limit'
]) {
  assert.ok(!ui.includes(obsoleteId), `记忆设置页不得再残留已失效的旧版 v2 控件：${obsoleteId}`);
}
assert.ok(
  ui.includes('id="we-memory-range-overwrite">') && !ui.includes('id="we-memory-range-overwrite" checked>'),
  '手动指定范围填表默认不应勾选覆盖重填（保持与自动填表一致的逐层纯增量补漏）'
);

// 1. 记忆模块首页纵向导航必须统一为两字格式（表格 / 纪要 / 填表），避免在 48px 栏位折行
assert.ok(
  homeFn.includes("label: '表格'") &&
  homeFn.includes("label: '纪要'") &&
  homeFn.includes("label: '填表'") &&
  !homeFn.includes("label: '数据库表'") &&
  !homeFn.includes("label: '纪要表'"),
  '记忆首页纵向导航标题必须统一采用两字格式（表格 / 纪要 / 填表）'
);

// 2. 记忆模块所有表格与纪要视图采用零横向滚动条、单屏自适应分页与行内展开详情
assert.match(ui, /function renderSingletonKvTable\(/, '单行模式表（全局状态/主角信息）应提供 KV 矩阵单屏视图');
assert.match(ui, /function renderKeyedFitTable\(/, '多行主键表应提供固定列宽单屏自适应与点击行内展开视图');
assert.match(ui, /we-db-table--fit/, '多行表格应启用 table-layout: fixed 零横向滚动样式');
assert.match(ui, /we-db-pager/, '表格与纪要视图应提供单屏翻页控件');
assert.match(ui, /we-chronicle-sheet/, '纪要视图应使用紧凑表格行列表');
assert.match(css, /\.we-db-table-wrap\s*\{[^}]*overflow-x:\s*hidden/, '表格外框必须禁用横向滚动条');
assert.match(css, /\.we-db-table--fit\s*\{[^}]*table-layout:\s*fixed/, '自适应表格必须使用 table-layout: fixed');

// 3. 三模块设置页统一样式：无横向滚动选项卡栏、统一主色调保存按钮与重置记忆入口
const outlineUi = fs.readFileSync(path.join(root, 'outline-engine-ui.js'), 'utf8');
assert.match(ui, /class="we-btn we-btn-primary" id="we-save-settings"/, '世界设置保存按钮应统一使用 we-btn-primary');
assert.match(ui, /class="we-btn we-btn-primary" id="we-save-memory-settings"/, '记忆设置保存按钮应统一使用 we-btn-primary');
assert.match(ui, /id="we-reset-memory"/, '记忆设置底部常驻栏应提供对称的重置记忆按钮');
assert.match(outlineUi, /button\('save-settings',\s*'保存设置',\s*'',\s*'primary'\)/, '大纲设置保存按钮应统一使用 primary 样式');
assert.match(css, /\.we-settings-tabs\s*\{[^}]*flex-wrap:\s*wrap/, '三模块设置选项卡栏应自动折行平铺而非横向滚动');

// 4. 清空所有表数据入口（表格分页底部 + 设置存档区）、冷热双层注入控件、角色卡读取开关以及去除选项表/角色交互选项
assert.ok(
  ui.includes('id="we-memory-clear-all-tables"') &&
  ui.includes('id="we-memory-archive-clear-all"') &&
  ui.includes('confirmAndClearAllMemoryTables'),
  '应在「状态表格」底部与「设置 → 存档」提供清空所有表数据入口并统一确认与自动备份逻辑'
);
assert.ok(
  ui.includes('id="we-memory-inject-layer-mode"') &&
  ui.includes('id="we-memory-hot-inject-pos"') &&
  ui.includes('id="we-memory-hot-inject-depth"') &&
  ui.includes('id="we-memory-cold-inject-pos"') &&
  ui.includes('id="we-memory-cold-inject-depth"') &&
  ui.includes('id="we-memory-include-card-context"'),
  '记忆设置页应提供冷热双层注入位置/深度配置与角色卡/用户人设填表读取开关'
);
assert.ok(!dataJs.includes('interaction_options') && !dataJs.includes('选项表'), '记忆核心 7 表不应包含选项表与角色表交互选项字段');

// 5. 防回归：模块级 const 变量不得被重新赋值（避免点击清空时出现 Assignment to constant variable）
for (const filename of ['world-engine-ui.js', 'memory-engine.js', 'memory-engine-data.js', 'memory-engine-prompt.js']) {
  const src = fs.readFileSync(path.join(root, filename), 'utf8');
  const lines = src.split(/\r?\n/);
  const constVars = new Set();
  for (const line of lines) {
    const m = line.match(/^\s{2}const\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m) constVars.add(m[1]);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*const\s+/.test(line)) continue;
    for (const v of constVars) {
      const re = new RegExp('(^|[^.\\w$])' + v + '\\s*(?:=(?!=)|\\+=|-=|\\*=|/=|\\+\\+|--)', 'g');
      assert.ok(!re.test(line), `${filename}:${i + 1} 不得对 const 变量 ${v} 重新赋值：${line.trim()}`);
    }
  }
}

// 6. 运行时实测 confirmAndClearAllMemoryTables（覆盖 _memoryTablePage 原地清空路径，确保无异常）
{
  const vm = require('vm');
  const fnStart = ui.indexOf('function confirmAndClearAllMemoryTables(');
  const fnEnd = ui.indexOf('\n  function bindMemoryView()', fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart, '应能定位 confirmAndClearAllMemoryTables');
  const fnSrc = ui.slice(fnStart, fnEnd);
  let clearedCalls = 0;
  let toastText = '';
  let toastErr = false;
  let refreshed = false;
  const ctx = vm.createContext({
    window: {
      MEMORY_ENGINE: {
        isRunning: () => false,
        clearAllTableData: (opts) => { clearedCalls++; return { cleared: true, removedRows: 5, opts }; }
      },
      MEMORY_ENGINE_DATA: {
        loadState: () => ({}),
        tableRowCounts: () => ({ totalRows: 5, chronicle: 2 })
      }
    },
    confirm: () => true,
    showToast: (msg, isErr) => { toastText = msg; toastErr = !!isErr; },
    clearMemoryEditing: () => {},
    refresh: () => { refreshed = true; },
    _memoryExpandedTableRows: new Set(['important_characters:char_000001']),
    _memoryCollapsedRecords: new Set(['am00001']),
    _memorySeenRecords: new Set(['am00001']),
    _memoryMinutesPage: 2
  });
  vm.runInContext(`
    const _memoryTablePage = { important_characters: 3, backpack_items: 1 };
    ${fnSrc}
    const ok = confirmAndClearAllMemoryTables({ clearCheckpoints: false });
    globalThis.__result = { ok, remainingKeys: Object.keys(_memoryTablePage).length, minutesPage: _memoryMinutesPage };
  `, ctx);
  assert.strictEqual(ctx.__result.ok, true, 'confirmAndClearAllMemoryTables 应成功返回 true');
  assert.strictEqual(ctx.__result.remainingKeys, 0, '_memoryTablePage 应原地清空所有分页键');
  assert.strictEqual(ctx.__result.minutesPage, -1, '_memoryMinutesPage 应重置为 -1');
  assert.strictEqual(clearedCalls, 1, '应调用一次 MEMORY_ENGINE.clearAllTableData');
  assert.strictEqual(toastErr, false, `不应弹出错误提示，实际：${toastText}`);
  assert.strictEqual(refreshed, true, '清空成功后应触发 UI refresh()');
}

console.log('memory UI layout tests passed');
