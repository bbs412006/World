const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const box = {
  OUTLINE_ENGINE_SETTINGS: { getSettings: () => ({ engineEnabled: true }) },
  OUTLINE_ENGINE_DATA: { SCHEMA_VERSION: 2 },
  OUTLINE_ENGINE: { ingestWorldCommit() {} },
  STORY_ENGINE_HISTORY: { getStatus: () => ({ blocked: false }) },
  WORLD_ENGINE_CORE: {}, WORLD_ENGINE_LEDGER: {},
  WORLD_ENGINE_API: { getSettings: () => ({ injectMaxChars: 20000 }) },
  WORLD_ENGINE_RULES: { getCoreRulesSummary: () => '' }
};
box.window = box;
for (const file of ['story-engine-projection.js', 'world-engine-inject.js']) vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), box, { filename: file });
const p = box.STORY_ENGINE_PROJECTION;
const packet = {
  world_digest: '港口照常营业',
  events: [{ id: 'public', name: '修桥', level: 3, stage: '执行', type: 'progress' }, { id: 'hidden', visibility: 'private', name: '绝密身份' }],
  privateEvents: [{ text: '绝密信件已送出', trackId: 'hidden-line', nodeId: 'hidden-node', knownBy: ['反派'] }],
  observations: [{ nodeId: 'hidden-node', status: 'completed', evidence: [{ privateEventIndex: 0 }] }],
  blackbox: { secretActions: [{ action: '旧版秘密行动' }], secretAssets: [{ name: '旧版秘密资产' }] },
  apiKey: 'forbidden-key', authorTruth: '未来转折'
};
const split = p.splitWorldResponse(packet);
assert.strictEqual(split.privateEvents.length, 3);
assert.strictEqual(split.observations[0].evidence[0].privateEventIndex, 0);
const publicText = JSON.stringify(split.publicUpdate);
for (const secret of ['绝密', '旧版秘密', 'forbidden-key', '未来转折']) assert.ok(!publicText.includes(secret));
const state = { round: 1, worldDigest: '港口照常营业', ...packet };
const injection = box.WORLD_ENGINE_INJECT.buildContext(state, []);
for (const secret of ['绝密', '旧版秘密', '未来转折']) assert.ok(!injection.includes(secret), 'private data must not reach the narrative prompt');
assert.ok(injection.includes('修桥'));
const memory = JSON.stringify(p.forMemory(packet));
for (const secret of ['绝密', '旧版秘密', '未来转折']) assert.ok(!memory.includes(secret));
assert.throws(() => p.splitWorldResponse({ world_digest: 'ok', privateEvents: [{ text: '计划行动', status: 'planned' }] }), /已发生/);
box.STORY_ENGINE_HISTORY.getStatus = () => ({ blocked: true });
assert.strictEqual(box.WORLD_ENGINE_INJECT.buildContext(state, []), '', 'unverified world is withdrawn during recovery');
console.log('story public/private projection tests passed');
