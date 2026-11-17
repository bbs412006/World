// 作者事实、后台指导与正文/记忆的公共内容走不同入口。
window.STORY_ENGINE_PROJECTION = (function() {
  'use strict';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const clean = value => String(value == null ? '' : value).trim();
  const PUBLIC_FIELDS = ['events', 'factions', 'worldTrends', 'winds', 'economy', 'reputation',
    'world_digest', 'enemies', 'influenceChain', 'regionalIncident'];
  function active() {
    return window.OUTLINE_ENGINE_SETTINGS?.getSettings?.().engineEnabled === true &&
      Boolean(window.STORY_ENGINE_HISTORY && window.OUTLINE_ENGINE_DATA?.SCHEMA_VERSION === 2 &&
        typeof window.OUTLINE_ENGINE?.ingestWorldCommit === 'function');
  }
  function publicValue(value) {
    if (value == null || typeof value !== 'object') return value;
    if (value.visibility === 'private' || value.authorOnly === true || value.private === true) return undefined;
    if (Array.isArray(value)) return value.map(publicValue).filter(item => item !== undefined);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (['privateEvents', 'privateFacts', 'privateUpdate', 'observations', 'outlineObservations',
        'blackbox', 'authorTruth', 'directorNotes', 'apiKey', 'apiUrl'].includes(key)) continue;
      const safe = publicValue(item); if (safe !== undefined) result[key] = safe;
    }
    return result;
  }
  function publicUpdate(value) {
    const input = value?.publicUpdate || value?.worldUpdate || value || {}, result = {};
    for (const key of PUBLIC_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input, key)) result[key] = publicValue(input[key]);
    }
    if (input.worldDigest != null && result.world_digest == null) result.world_digest = clean(input.worldDigest);
    return result;
  }
  function publicWorld(value) {
    const result = publicValue(clone(value || {})) || {};
    result.blackbox = { secretActions: [], secretAssets: [] };
    delete result.lastInjection;
    if (result.lastEvolveResult) result.lastEvolveResult = publicUpdate(result.lastEvolveResult);
    return result;
  }
  function privateEventsFromBlackbox(value) {
    const box = value?.blackbox || value || {}, result = [];
    for (const item of Array.isArray(box.secretActions) ? box.secretActions : []) {
      if (!clean(item?.action)) continue;
      result.push({ text: clean(item.action), knownBy: [], entityRefs: [],
        kind: 'legacy_secret_action', legacy: clone(item) });
    }
    for (const item of Array.isArray(box.secretAssets) ? box.secretAssets : []) {
      if (!clean(item?.name)) continue;
      result.push({ text: `秘密资源：${clean(item.name)}${item.status ? '（' + clean(item.status) + '）' : ''}`,
        knownBy: [], entityRefs: [], kind: 'legacy_secret_asset', legacy: clone(item) });
    }
    return result;
  }
  function splitWorldResponse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('世界返回不是有效对象');
    const entries = value.privateEvents || value.private_events || [];
    if (!Array.isArray(entries)) throw new Error('privateEvents 必须为数组');
    const privateEvents = entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || !clean(entry.text) || entry.occurred === false ||
          ['planned', 'proposed', 'future'].includes(entry.status)) throw new Error(`幕后事实 ${index + 1} 缺少已发生内容`);
      const fact = {
        id: clean(entry.id), text: clean(entry.text), nodeId: clean(entry.nodeId), trackId: clean(entry.trackId),
        knownBy: Array.isArray(entry.knownBy) ? entry.knownBy.map(clean).filter(Boolean) : [],
        entityRefs: Array.isArray(entry.entityRefs) ? clone(entry.entityRefs) : [], publicHint: clean(entry.publicHint)
      };
      if (entry.clue && clean(entry.clue.publicText)) fact.clue = {
        id: clean(entry.clue.id), publicText: clean(entry.clue.publicText), condition: clone(entry.clue.condition || null)
      };
      return fact;
    });
    privateEvents.push(...privateEventsFromBlackbox(value), ...privateEventsFromBlackbox(value.publicUpdate || {}));
    const observations = value.observations || value.outlineObservations || [];
    if (!Array.isArray(observations)) throw new Error('observations 必须为数组');
    return { publicUpdate: publicUpdate(value), privateEvents, observations: clone(observations) };
  }
  function worldOutputInstructions() {
    return `【多线联动输出协议：优先于旧示例中的黑盒格式】
仍返回现有世界 JSON 字段；这些字段和 world_digest 只能描述公共、安全的变化。
真正已经发生但未公开的幕后行动放 privateEvents，不得放进公共摘要、事件描述、实体描述或风声。
privateEvents:[{id:"可留空",text:"本轮实际发生的幕后事实",nodeId:"对应节点ID或空",trackId:"剧情线ID或空",knownBy:["实际知情者"],entityRefs:[],publicHint:"不泄露真相的安全提示或空",clue:{id:"可留空",publicText:"可被发现的痕迹描述",condition:{type:"authorFlag",flagId:"明确配置的标记"}}}]
clue 仅在本轮确实形成痕迹时返回；不要虚构作者未设置的条件或标记。没有可验证条件时省略clue，等待剧情调度判断。
observations:[{nodeId:"已就绪的后台节点ID",status:"active|completed|blocked",evidence:[{privateEventIndex:0}],reason:"本轮事实怎样满足条件"}]
observations 只引用本轮真实提交的事实，不能引用计划或推测。主角的行动、接触或知情只能由实际正文证明，不得后台代演。每条剧情线本轮最多完成一个节点；没有推进时返回空数组。`;
  }
  return { active, publicWorld, publicUpdate, forMemory: publicUpdate, privateEventsFromBlackbox,
    splitWorldResponse, worldOutputInstructions };
})();
