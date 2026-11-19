const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
global.window = global; global.WORLD_ENGINE_STORE = { getItem: () => null, setItem() {} }; global.WORLD_ENGINE_CORE = { getChatId: () => 'prompts' };
for (const file of ['outline-engine-data.js', 'outline-engine-scheduler.js', 'outline-engine-prompt.js']) vm.runInThisContext(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'));
const data = OUTLINE_ENGINE_DATA, prompts = OUTLINE_ENGINE_PROMPT, state = data.defaultState();
state.plan = data.normalizePlan({ chapters: [{ id: 'stage' }], tracks: [{ id: 'front', kind: 'main' }, { id: 'secret', kind: 'hidden' }], nodes: [
  { id: 'keys', trackId: 'front', chapterIds: ['stage'], completionCriteria: '取得钥匙' },
  { id: 'cargo', trackId: 'front', chapterIds: ['stage'], completionCriteria: '读完真实货单' },
  { id: 'hidden', trackId: 'secret', completionCriteria: '暗中调换货单', intent: '私密幕后安排' }
] }); state.currentChapterId = 'stage';
state.privateFacts = [{ id: 'fact', text: '私密真相', validity: 'valid' }];
state.clues = [{ id: 'open', nodeId: 'hidden', publicHint: '封口信', factIds: ['fact'], available: true, validity: 'valid' },
  { id: 'closed', nodeId: 'hidden', factIds: ['fact'], available: false, validity: 'valid' }];
const messages = [{ messageId: 'm1', content: '她梦见拿到了钥匙。醒来后，她读完真实货单。' },
  { messageId: 'm2', content: '阿青亲手打开封口信，读到内奸调换货单的签名，确认此前的怀疑。' }];
const proof = (messageId, quote) => ({ messageId, quote });
const options = { state, nodes: state.plan.nodes, messages };
const before = JSON.stringify(state);
let result = prompts.parseCheckResponse({ nodeUpdates: [
  { nodeId: 'keys', status: 'completed', evidence: [proof('m1', '拿到了钥匙')] },
  { nodeId: 'cargo', status: 'completed', evidence: [proof('m1', '读完真实货单')] },
  { nodeId: 'hidden', status: 'completed', evidence: [proof('m2', '调换货单')] }
], timeAssessment: { kind: 'dream', reason: '只在梦中取得钥匙', evidence: [proof('m1', '她梦见拿到了钥匙。')] } }, options);
assert.deepStrictEqual(result.nodeUpdates.map(item => item.nodeId), ['cargo'], '梦境不能重判现实；同消息醒来后的实际行动仍可核实');
assert.strictEqual(result.timeAssessment.kind, 'dream');
assert.strictEqual(JSON.stringify(state), before, '时序核对不直接回退或改分支');
result = prompts.parseCheckResponse({ contacts: [
  { clueId: 'closed', actorId: '阿青', evidence: [proof('m2', '阿青亲手打开封口信')] },
  { clueId: 'open', actorId: '阿青', evidence: [proof('m2', '不存在的原文')] }
], reveals: [{ clueId: 'open', factId: 'fact', actorId: '阿青', evidence: [proof('m2', '确认此前的怀疑')] }] }, options);
assert.strictEqual(result.contacts.length, 0); assert.strictEqual(result.reveals.length, 0, '未实际接触不能仅因线索开放就知道真相');
result = prompts.parseCheckResponse({ contacts: [{ clueId: 'open', actorId: '阿青', evidence: [proof('m2', '阿青亲手打开封口信')] }],
  reveals: [{ clueId: 'open', factId: 'fact', actorId: '阿青', evidence: [proof('m2', '读到内奸调换货单的签名，确认此前的怀疑')] }] }, options);
assert.strictEqual(result.contacts.length, 1); assert.strictEqual(result.reveals.length, 1);
assert.strictEqual(JSON.stringify(state), before, '后台解析不能直接写角色知情或事实');
result = prompts.parseCheckResponse({ timeAssessment: { kind: 'contradiction', reason: '冲突', evidence: [proof('m1', '伪造的时序证据')] } }, options);
assert.strictEqual(result.timeAssessment, undefined);
result = prompts.parseCheckResponse({ timeAssessment: { kind: 'in_world_rewind', reason: '疑似时间回溯，仅提示核对', evidence: [proof('m1', '她梦见拿到了钥匙。')] } }, options);
assert.strictEqual(result.timeAssessment.kind, 'in_world_rewind');
assert.strictEqual(JSON.stringify(state), before);
const organized = prompts.parseOrganizeResponse({ title: '私密故事', synopsis: '幕后真相', chapters: [{ id: 's' }], tracks: [{ id: 'h', kind: 'hidden' }], nodes: [{ id: 'n', trackId: 'h', intent: '幕后谋划' }] });
assert.strictEqual(organized.publicSynopsis, '', 'v2不得把完整作者简介复制到正文投影');
assert.deepStrictEqual(organized.nodes[0].dependencies, []); assert.strictEqual(organized.nodes[0].completionCriteria, '');
assert.strictEqual(organized.nodes[0].disclosure.condition.type, 'unconfigured');

// 宽松 JSON 修复（<think> 块、字符串内裸换行、注释与尾逗号）与引文标点/省略容错校验
const looseRaw = `<think>模型思考中 {"fake": 1}</think>\n\`\`\`json\n{\n  // 核对结果注释\n  "nodeUpdates": [\n    {\n      "nodeId": "cargo",\n      "status": "completed",\n      "reason": "已读完\n第二行说明",\n      "evidence": [{ "messageId": "m1", "quote": "醒来后, 她读完真实货单." }],\n    },\n  ],\n  "contacts": [\n    {\n      "clueId": "open",\n      "actorId": "阿青",\n      "evidence": [{ "messageId": "m2", "quote": "阿青亲手打开……确认此前的怀疑" }],\n    },\n  ],\n}\n\`\`\``;
const looseChecked = prompts.parseCheckResponse(looseRaw, options);
assert.deepStrictEqual(looseChecked.nodeUpdates.map(item => item.nodeId), ['cargo'], '全半角标点与空白差异不应误杀真实引文，且宽松JSON应正常解析');
assert.ok(messages[0].content.includes(looseChecked.nodeUpdates[0].evidence[0].quote), '容错匹配后应还原为原文精确子串以便后续离线审计');
assert.strictEqual(looseChecked.contacts.length, 1, '长句中间带省略号衔接的真实引文应能按序命中');
assert.ok(messages[1].content.includes(looseChecked.contacts[0].evidence[0].quote), '省略号引文匹配后也应还原为原文精确切片');
assert.strictEqual(prompts.matchQuote('普通正文内容', '完全捏造……不存在的话'), false, '捏造的省略号引文必须拒绝');
const orgPrompt = prompts.buildOrganizePrompt('第一章：先找守门人打听黑篷船，再夜探旧宅夺回账簿。');
assert.ok(orgPrompt.includes('不得自行发明') && orgPrompt.includes('同义提炼') && orgPrompt.includes('publicHint'), '整理Prompt应引导从原文目标提炼可验证判据、先后依赖与公开提示');

console.log('outline v2 prompt/evidence/temporal tests passed');
