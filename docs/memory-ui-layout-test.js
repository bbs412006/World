const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'world-engine-ui.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

assert.match(ui, /_memorySeenRecords = new Set\(\)/, '记忆数据需要记录首次展示状态');
assert.match(ui, /_memoryCollapsedRecords\.add\(key\)/, '记忆数据首次展示必须默认折叠');
assert.match(ui, /entity-category:\$\{type\}/, '实体必须按类型生成独立分类');
for (const label of ['组织', '物品', '能力', '地点']) assert.ok(ui.includes(label), `缺少实体分类：${label}`);
assert.match(ui, /const cards = items\.map\(\(item, index\)/, '纪要必须渲染全部数据');
assert.match(ui, /const cards = items\.map\(\(big, index\)/, '总述必须渲染全部数据');
assert.match(ui, /defaultCollapsed = index !== items\.length - 1/g, '纪要和总述必须只默认展开最新一条');
assert.match(ui, /we-memory-record-head" data-memory-collapse-key=/, '记忆卡片标题栏必须支持整块点击');
assert.match(ui, /默认展开最新一条/, '纪要和总述应提示默认展开最新数据');
assert.match(css, /\.we-memory-entity-group > \.we-memory-record-body/, '实体分类需要独立布局样式');

assert.ok(ui.includes('持续事实') && ui.includes('角色弧光'), '记忆界面应集成持续事实与角色弧光视图');
assert.ok(ui.includes('we-memory-export-package') && ui.includes('we-memory-import-package'), '记忆设置应支持总结记忆包导入导出');
assert.ok(ui.includes('we-memory-delay-floors') && ui.includes('we-memory-coordination-mode'), '记忆设置应开放延迟楼层与三模块并发调度策略');
assert.match(css, /\.we-memory-arc-card/, 'CSS 应包含角色弧光卡片样式');
assert.match(css, /\.we-memory-kw-tag/, 'CSS 应包含记忆关键词标签样式');

console.log('memory UI layout tests passed');
