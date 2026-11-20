// 弱联动边界静态回归测试：node docs/manual-memory-link-test.js
// 验证方案 A：世界与大纲不再向记忆 7 表写入记录，仅保留单向只读参考、错峰调度与联合删楼回退。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const world = fs.readFileSync(path.join(root, 'world-engine.js'), 'utf8');
const outline = fs.readFileSync(path.join(root, 'outline-engine.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'world-engine-ui.js'), 'utf8');

assert.ok(!world.includes('window.MEMORY_ENGINE?.ingestWorldEvolution?.('), '世界推演流程不得再向记忆表写入记录');
assert.ok(!outline.includes('notifyOutlineCommitted?.('), '剧情大纲检查流程不得再向记忆表写入记录');
assert.ok(!ui.includes('id="we-memory-link-now"'), '世界设置不得再保留手动写记忆按钮');
assert.ok(!ui.includes('id="we-memory-link-enabled"'), '世界设置不得再保留自动写记忆开关');
assert.ok(!ui.includes('id="we-memory-world-link-mode"'), '记忆设置不得再保留世界写记忆模式下拉');
assert.ok(ui.includes('id="we-world-accept-memory"') && ui.includes('id="we-memory-accept-world-hint"') && ui.includes('id="we-memory-inject-outline"'), '三模块只读参考联动开关应保留');

console.log('weak coupling readonly link tests passed');
