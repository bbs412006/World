// 有限条件解释器：三值逻辑、稳定实体引用和有限预算；绝不执行表达式或脚本。
window.OUTLINE_ENGINE_SCHEDULER = (function() {
  const clean = value => String(value == null ? '' : value).trim();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const data = () => window.OUTLINE_ENGINE_DATA;
  const output = (value, reason) => ({ value: value == null ? 'unknown' : value ? 'true' : 'false', eligible: value, reasons: Array.isArray(reason) ? reason : [reason] });
  const unknown = reason => output(null, reason);
  function combine(results, mode) {
    const values = results.map(item => item.eligible);
    const result = mode === 'all' ? values.includes(false) ? false : values.includes(null) ? null : true : values.includes(true) ? true : values.includes(null) ? null : false;
    return output(result, results.flatMap(item => item.reasons));
  }
  function compare(actual, op, expected) {
    if (op === 'exists') return output(expected === false ? actual === undefined : actual !== undefined, 'world_field_exists');
    if (actual === undefined) return unknown('world_field_missing');
    if (op === 'eq') return output(actual === expected, 'field_equality');
    if (op === 'ne') return output(actual !== expected, 'field_inequality');
    if (op === 'contains') return typeof actual === 'string' || Array.isArray(actual) ? output(actual.includes(expected), 'field_contains') : unknown('contains_requires_text_or_array');
    if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
      const numeric = value => typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value));
      if (!numeric(actual) || !numeric(expected)) return unknown('comparison_requires_numbers');
      const a = Number(actual), b = Number(expected);
      return output(op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b, 'numeric_comparison');
    }
    return unknown('unsupported_operator');
  }
  function absoluteTime(value) {
    const text = clean(value), match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
    const stamp = Date.parse(text.includes('T') && !/(Z|[+-]\d{2}:\d{2})$/.test(text) ? text + 'Z' : text);
    return Number.isFinite(stamp) ? stamp : null;
  }
  function evaluateConditions(value, context) {
    const ctx = context || {}, condition = data().normalizeCondition(value), state = ctx.state;
    if (condition == null) return output(true, 'no_extra_condition');
    if (condition.all) return combine(condition.all.map(item => evaluateConditions(item, ctx)), 'all');
    if (condition.any) return combine(condition.any.map(item => evaluateConditions(item, ctx)), 'any');
    switch (condition.type) {
      case 'literal': return output(condition.value, 'author_literal');
      case 'nodeStatus': {
        if (!data().getNode(state, condition.nodeId)) return unknown('dependency_node_missing:' + condition.nodeId);
        const status = data().getNodeStatus(state, condition.nodeId);
        return output(status === condition.status || (condition.status === 'completed' && status === 'skipped' && condition.allowSkipped), 'node_status:' + condition.nodeId + ':' + status);
      }
      case 'chapter': {
        const chapters = state?.plan?.chapters || [], current = chapters.findIndex(item => item.id === state?.currentChapterId);
        if (current < 0) return unknown('current_chapter_missing');
        if (condition.chapterIds.some(id => !chapters.some(item => item.id === id))) return unknown('condition_chapter_missing');
        let accepted = !condition.chapterIds.length || condition.chapterIds.includes(state.currentChapterId);
        for (const [key, side] of [['fromChapterId', 'from'], ['toChapterId', 'to']]) if (condition[key]) {
          const index = chapters.findIndex(item => item.id === condition[key]); if (index < 0) return unknown('condition_chapter_missing');
          accepted = accepted && (side === 'from' ? current >= index : current <= index);
        }
        return output(accepted, 'chapter_range');
      }
      case 'worldField': {
        if (!condition.collection || !condition.entityId || !condition.field) return unknown('world_reference_unconfigured');
        const collection = ctx.worldState?.[condition.collection];
        if (!Array.isArray(collection)) return unknown('world_collection_missing');
        const entity = collection.find(item => clean(item?.id) === condition.entityId);
        if (!entity) return unknown('world_entity_missing:' + condition.entityId);
        const path = condition.field.split('.');
        if (path.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) return unknown('unsafe_field_path');
        let actual = entity;
        for (const part of path) { if (!actual || typeof actual !== 'object' || !Object.prototype.hasOwnProperty.call(actual, part)) { actual = undefined; break; } actual = actual[part]; }
        return compare(actual, condition.op || 'eq', condition.value);
      }
      case 'clueContact': {
        if (!state?.clues?.some(item => item.id === condition.clueId && item.validity === 'valid')) return unknown('clue_missing:' + condition.clueId);
        return output((state.contacts || []).some(item => item.validity === 'valid' && item.clueId === condition.clueId && (!condition.actorId || item.actorId === condition.actorId)), 'actual_clue_contact');
      }
      case 'time': {
        if (condition.basis === 'storyDay') {
          const actual = ctx.worldState?.time;
          if (typeof actual !== 'number' || !Number.isFinite(actual)) return unknown('story_day_missing');
          if (typeof condition.value !== 'number' || !Number.isFinite(condition.value)) return unknown('story_day_target_unconfigured');
          return compare(actual, condition.op || 'gte', condition.value);
        }
        const source = ctx.storyTime;
        if (ctx.storyTimeReliable === false || (source && typeof source === 'object' && source.reliable !== true)) return unknown('story_time_unreliable');
        const actual = absoluteTime(typeof source === 'string' ? source : source?.value || source?.iso), expected = absoluteTime(condition.value);
        if (actual == null || expected == null) return unknown('absolute_story_time_missing');
        return compare(actual, condition.op || 'gte', expected);
      }
      case 'authorFlag': {
        const flags = ctx.authorFlags || state?.authorFlags;
        return flags && Object.prototype.hasOwnProperty.call(flags, condition.flagId) ? output(flags[condition.flagId] === condition.value, 'author_flag:' + condition.flagId) : unknown('author_flag_unconfigured:' + condition.flagId);
      }
      default: {
        // 自然语言条件只有在调用方提供可复核的原文证据时才有确定值。
        const record = ctx.conditionEvidence?.[condition.text], messages = new Map((ctx.messages || []).map(item => [item.messageId, String(item.content ?? item.mes ?? '')]));
        const proofs = record?.evidence;
        const matchFn = window.OUTLINE_ENGINE_PROMPT?.matchQuote || ((src, q) => String(src || '').includes(q));
        if (typeof record?.value === 'boolean' && Array.isArray(proofs) && proofs.length && proofs.every(proof => proof.messageId && clean(proof.quote) && matchFn(messages.get(proof.messageId), proof.quote))) return output(record.value, 'verified_condition_evidence');
        return unknown('condition_requires_configuration_or_evidence');
      }
    }
  }
  function select(state, options) {
    const opts = options || {}, channel = opts.channel === 'world' ? 'world' : 'narrative';
    const config = window.OUTLINE_ENGINE_SETTINGS?.getSettings?.() || {}, schedule = clone(state.scheduler || data().defaultState().scheduler);
    const advancing = opts.advanceTick === true, tick = Number(schedule.tick || 0) + (advancing ? 1 : 0);
    const limit = Math.max(1, Math.min(20, parseInt(opts.limit ?? (channel === 'world' ? config.worldLimit : config.narrativeLimit), 10) || 3));
    const context = { ...opts, state }, tracks = new Map((state.plan?.tracks || []).map(track => [track.id, track]));
    const currentIndex = (state.plan?.chapters || []).findIndex(chapter => chapter.id === state.currentChapterId);
    const urgent = new Set(opts.urgentNodeIds || []), relevant = new Set(opts.relevantEntityIds || []);
    const candidates = (state.plan?.nodes || []).map((node, index) => {
      const track = tracks.get(node.trackId), parts = [], status = data().getNodeStatus(state, node.id);
      if (!track) parts.push(unknown('track_missing'));
      else if (track.paused) parts.push(output(false, 'track_paused'));
      if (['completed', 'skipped'].includes(status)) parts.push(output(false, 'node_already_closed'));
      if (state.recovery?.status && !['ready', 'idle', 'ok'].includes(state.recovery.status)) parts.push(output(false, 'recovery_required'));
      if (track && node.chapterIds?.length) {
        const indices = node.chapterIds.map(id => state.plan.chapters.findIndex(chapter => chapter.id === id));
        if (indices.includes(-1)) parts.push(unknown('node_chapter_missing'));
        else if (track.kind === 'main') parts.push(output(node.chapterIds.includes(state.currentChapterId), 'main_chapter_gate'));
        else parts.push(output(currentIndex >= Math.min(...indices), 'cross_chapter_track_persists'));
      }
      for (const dependency of node.dependencies || []) parts.push(evaluateConditions({ type: 'nodeStatus', nodeId: dependency.nodeId, status: 'completed', allowSkipped: dependency.allowSkipped }, context));
      parts.push(evaluateConditions(node.trigger, context));
      if (channel === 'world' && (node.actorKind === 'player' || node.completionSource === 'dialogue')) parts.push(output(false, 'player_action_requires_dialogue'));
      if (channel === 'narrative' && node.visibility === 'private') {
        const clue = (state.clues || []).some(item => item.nodeId === node.id && item.available && item.validity === 'valid');
        parts.push(output(clue && Boolean(node.publicHint || (state.clues || []).some(item => item.nodeId === node.id && item.available && item.publicHint)), 'private_node_requires_available_public_clue'));
      }
      const cooldown = Number(schedule.cooldowns?.[channel + ':' + node.id] || 0);
      if (advancing && cooldown >= tick) parts.push(output(false, 'cooldown'));
      const condition = combine(parts, 'all'), waitTurns = Number(schedule.waiting?.[channel + ':' + node.id] || 0);
      const isRelevant = (node.entityRefs || []).some(ref => relevant.has(ref.id) || (ref.nameSnapshot && String(opts.recentText || '').includes(ref.nameSnapshot)));
      const score = (Number(track?.priority) || 0) + (track?.kind === 'main' ? 40 : 0) + (urgent.has(node.id) ? 100 : 0) + (isRelevant ? 60 : 0) + waitTurns * 25;
      return { node, nodeId: node.id, trackId: node.trackId, eligible: condition.eligible, condition: condition.value, selected: false, reasons: condition.reasons, score, waitTurns, index };
    });
    const ready = candidates.filter(item => item.eligible === true).sort((a, b) => b.score - a.score || a.index - b.index), chosen = [], served = new Set();
    for (const candidate of ready) if (chosen.length < limit && !served.has(candidate.trackId)) { chosen.push(candidate); served.add(candidate.trackId); }
    if (channel === 'narrative') for (const candidate of ready) if (chosen.length < limit && !chosen.includes(candidate)) chosen.push(candidate);
    const ids = new Set(chosen.map(item => item.nodeId));
    schedule.waiting = { ...(schedule.waiting || {}) }; schedule.lastServed = { ...(schedule.lastServed || {}) }; schedule.cooldowns = { ...(schedule.cooldowns || {}) };
    schedule.lastSelected = { narrative: [], world: [], ...(schedule.lastSelected || {}), [channel]: [...ids] };
    for (const candidate of candidates) {
      candidate.selected = ids.has(candidate.nodeId);
      if (candidate.eligible && !candidate.selected) candidate.reasons.push(served.has(candidate.trackId) && channel === 'world' ? 'one_node_per_track_tick' : 'budget_waiting');
      if (advancing && candidate.eligible) {
        schedule.waiting[channel + ':' + candidate.nodeId] = candidate.selected ? 0 : candidate.waitTurns + 1;
        if (candidate.selected) { schedule.lastServed[channel + ':' + candidate.trackId] = tick; schedule.cooldowns[channel + ':' + candidate.nodeId] = tick + Math.max(0, Number(config.cooldownTicks) || 0); }
      }
    }
    if (advancing) schedule.tick = tick;
    const explanations = candidates.map(({ node, index, condition, ...item }) => ({ ...item, channel }));
    schedule.explanations = explanations;
    return { candidates, selected: chosen.map(item => item.node), nodeIds: [...ids], selectedIds: [...ids], explanations, scheduler: schedule };
  }
  return { evaluateConditions, select };
})();
