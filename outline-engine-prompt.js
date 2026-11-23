// outline-engine-prompt.js — 剧情大纲 v3 轻量化提示词与严格 JSON 容错解析（支持带错回灌纠错）
window.OUTLINE_ENGINE_PROMPT = (function() {
  'use strict';

  const clean = value => String(value == null ? '' : value).trim();
  const cut = (value, max) => {
    const text = clean(value);
    return !max || text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
  };

  function stripWrappers(raw) {
    let text = String(raw == null ? '' : raw);
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1');
    return text.trim();
  }

  function repairLooseJson(src) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      const next = src[i + 1];
      if (inStr) {
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') { out += ch; inStr = false; continue; }
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') continue;
        if (ch === '\t') { out += '\\t'; continue; }
        out += ch;
        continue;
      }
      if (ch === '"') { inStr = true; out += ch; continue; }
      if (ch === '/' && next === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i++;
        continue;
      }
      out += ch;
    }
    return out.replace(/,\s*([}\]])/g, '$1');
  }

  function extractJson(raw) {
    const cleaned = stripWrappers(raw);
    if (!cleaned) return { ok: false, error: '模型返回为空' };
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return { ok: false, error: '未找到合法的 JSON 对象边界 { ... }' };
    }
    const slice = cleaned.slice(start, end + 1);
    for (const candidate of [slice, repairLooseJson(slice)]) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ok: true, data: parsed };
        }
      } catch (_) {}
    }
    return { ok: false, error: 'JSON 语法解析失败，请检查引号转义与逗号格式' };
  }

  function buildOrganizePrompt(options = {}) {
    const text = clean(options.text);
    const roster = clean(options.roster);
    return `你是【剧情大纲整理员】，负责将用户提供的大纲草稿、故事梗概或章节设想整理为清晰、防剧透的轻量结构化 JSON。

## 核心规则
1. **严格忠于原文**：只做分章、分线与节点提炼，禁止擅自杜撰原文未提及的新人物、新阵营或新结局。
2. **三类剧情线（tracks.kind）**：
   - \`main\`：主线推进节点（绑定所属章节，章节内所有必做主线节点完成后自动进入下一章）；
   - \`side\`：支线剧情（可绑定起始章节并跨章持续，默认 \`required: false\`）；
   - \`hidden\`：幕后暗线/伏笔（默认 \`revealPublic: false\`，不向主聊天剧透）。
3. **严格防剧透分层**：
   - \`publicSynopsis\` / \`publicConstraints\` / \`publicHint\` 会注入给前台写文 AI，**绝不能剧透幕后黑手、未揭示真相或最终结局**，只写当前氛围、阶段方向与表面线索；
   - \`authorNotes\` 与节点的 \`secretNotes\` 只供核对进度与世界推演后台参考，可以放心地写幕后真相、反转和真实动机。
4. **节点字段简洁清晰**：
   - \`completionCriteria\`：用一句直白的话说明怎样算本节点达成（原文没明确写时可留空 ""）；
   - \`dependencies\`：仅当原文明确要求先后顺序时填写前置节点 ID 数组，否则填 \`[]\`；
   - \`actors\`：本节点直接涉及的关键人物姓名数组（可为 \`[]\`）。

## 输出格式（严格输出单个合法 JSON 对象，不要包含解释文字或 Markdown 围栏）
{
  "title": "大纲标题",
  "publicSynopsis": "不含剧透的公开故事脉络",
  "publicConstraints": "不含剧透的文风或叙事原则（可留空）",
  "authorNotes": "作者幕后总备忘与隐藏真相（绝不注入主聊天，可留空）",
  "chapters": [
    { "id": "ch_1", "title": "第一章标题", "goal": "本章公开核心目标" }
  ],
  "tracks": [
    { "id": "tr_main", "kind": "main", "title": "主线剧情", "goal": "主线方向", "paused": false }
  ],
  "nodes": [
    {
      "id": "n_1",
      "trackId": "tr_main",
      "chapterIds": ["ch_1"],
      "dependencies": [],
      "title": "节点简短标题",
      "publicHint": "给前台 AI 的不剧透推进提示",
      "completionCriteria": "明确的达成条件",
      "secretNotes": "幕后真相或隐藏备注（可留空）",
      "required": true,
      "revealPublic": false,
      "actors": ["相关角色名"]
    }
  ]
}
${roster ? `\n【已知人物与公开势力规范名参考（便于统一 actors 称呼）】\n${cut(roster, 1200)}\n` : ''}
【用户待整理原文】
${text || '（空）'}`;
  }

  function parseOrganizeResponse(raw) {
    const ext = extractJson(raw);
    if (!ext.ok) return { ok: false, errors: [ext.error], plan: null };
    const candidate = ext.data.plan && typeof ext.data.plan === 'object' ? ext.data.plan : ext.data;
    if (!Array.isArray(candidate.chapters) || !candidate.chapters.length) {
      return { ok: false, errors: ['返回的 JSON 必须包含至少一个章节（chapters 非空数组）'], plan: null };
    }
    const dataApi = window.OUTLINE_ENGINE_DATA;
    const plan = dataApi?.normalizePlan ? dataApi.normalizePlan(candidate) : candidate;
    if (dataApi?.validatePlan) {
      const check = dataApi.validatePlan(plan);
      if (!check.valid) return { ok: false, errors: check.errors, plan: null };
    }
    return { ok: true, errors: [], plan };
  }

  function buildCheckPrompt(options = {}) {
    const state = options.state || {};
    const plan = state.plan || {};
    const chapters = plan.chapters || [];
    const curChapter = chapters.find(c => c.id === state.currentChapterId) || chapters[0] || null;
    const trackMap = new Map((plan.tracks || []).map(t => [t.id, t]));
    const unlockedNodes = Array.isArray(options.unlockedNodes) ? options.unlockedNodes : [];
    const messages = Array.isArray(options.messages) ? options.messages : [];
    const referenceContext = clean(options.referenceContext);
    const dataApi = window.OUTLINE_ENGINE_DATA;

    const nodeLines = unlockedNodes.map(n => {
      const tr = trackMap.get(n.trackId);
      const kindLabel = tr?.kind === 'hidden' ? '暗线' : tr?.kind === 'side' ? '支线' : '主线';
      const st = dataApi?.getNodeStatus ? dataApi.getNodeStatus(state, n.id) : 'pending';
      const parts = [
        `- [${n.id}]（${kindLabel}${n.required ? '·必做' : ''}｜当前状态：${st}）${n.title}`,
        n.publicHint ? `  公开提示：${cut(n.publicHint, 180)}` : '',
        n.completionCriteria ? `  达成条件：${cut(n.completionCriteria, 180)}` : '  达成条件：（未配置，默认不自动标 completed，可标 active/blocked）',
        n.secretNotes ? `  幕后备注：${cut(n.secretNotes, 200)}` : '',
        tr?.kind === 'hidden' ? `  暗线台前已显露：${n.revealPublic ? '是' : '否'}` : ''
      ].filter(Boolean);
      return parts.join('\n');
    }).join('\n');

    const dialogueText = messages.map(m => {
      const speaker = m.is_user ? (m.name || '玩家') : (m.name || 'AI');
      return `[楼层 ${m.layer} · ${speaker}]\n${cut(m.mes, 2400)}`;
    }).join('\n\n');

    return `你是【剧情进度核对员】，请对照最新聊天正文判断候选剧情节点的真实进展。

## 核对规则
1. **只更新有明确进展的节点**：只允许使用下方候选列表里的 \`nodeId\`；无变化时输出 \`{"nodeUpdates": [], "note": ""}\`。
2. **状态含义（仅限 active / completed / blocked）**：
   - \`active\`：剧情已明确切入或正在推进该节点；
   - \`completed\`：正文里**已经真实发生**并满足该节点的「达成条件」（未写达成条件的节点不要标 completed）；
   - \`blocked\`：剧情走向明确导致该节点受阻或无法按原定方式进行。
3. **区分真实行动与非现实片段**：单纯的口头打算、梦境、回忆或假设不算真实完成；若同一楼层里既有梦境/回忆又有醒来后的真实行动，请正常判定真实行动部分。
4. **暗线显露判定**：仅对标注为「暗线」且「台前已显露：否」的节点，若最新正文已出现可被主角察觉的表面征兆或线索，可设 \`"revealPublic": true\`；否则保持 \`false\`。
5. **只读参考约束**：世界/记忆参考仅辅助理解背景称呼，节点完成必须以【最新聊天正文】中实际发生的剧情为准。

## 当前大纲上下文
- 大纲标题：${plan.title || '未命名大纲'}
- 当前章节：${curChapter ? `${curChapter.title}${curChapter.goal ? `（目标：${cut(curChapter.goal, 160)}）` : ''}` : '无'}
${plan.authorNotes ? `- 作者幕后备忘：${cut(plan.authorNotes, 500)}` : ''}

## 本轮待核对的已解锁节点（共 ${unlockedNodes.length} 个）
${nodeLines || '（当前无待核对节点）'}
${referenceContext ? `\n## 只读背景参考（世界 / 记忆）\n${cut(referenceContext, 2200)}\n` : ''}
## 最新聊天正文
${dialogueText || '（无新增对话）'}

## 输出格式（严格输出单个合法 JSON 对象，不要附加任何解释或 Markdown 围栏）
{
  "nodeUpdates": [
    {
      "nodeId": "候选列表中的节点ID",
      "status": "active 或 completed 或 blocked",
      "reason": "≤40字客观说明依据",
      "revealPublic": false
    }
  ],
  "note": "可选的一句话本轮总体说明（可留空）"
}`;
  }

  function parseCheckResponse(raw, validNodeIds) {
    const ext = extractJson(raw);
    if (!ext.ok) return { ok: false, errors: [ext.error], data: null };
    const obj = ext.data;
    if (obj.nodeUpdates !== undefined && !Array.isArray(obj.nodeUpdates)) {
      return { ok: false, errors: ['nodeUpdates 必须为数组'], data: null };
    }
    const allowedSet = validNodeIds instanceof Set
      ? validNodeIds
      : new Set(Array.isArray(validNodeIds) ? validNodeIds : []);
    const allowedStatus = new Set(['active', 'completed', 'blocked']);
    const updates = [];
    const seen = new Set();

    for (const item of Array.isArray(obj.nodeUpdates) ? obj.nodeUpdates : []) {
      if (!item || typeof item !== 'object') continue;
      const nodeId = clean(item.nodeId || item.id);
      const status = clean(item.status);
      if (!nodeId || (allowedSet.size && !allowedSet.has(nodeId))) continue;
      if (!allowedStatus.has(status) || seen.has(nodeId)) continue;
      seen.add(nodeId);
      updates.push({
        nodeId,
        status,
        reason: cut(item.reason || item.summary || '', 120),
        revealPublic: item.revealPublic === true
      });
    }

    return {
      ok: true,
      errors: [],
      data: {
        nodeUpdates: updates,
        note: cut(obj.note || '', 120)
      }
    };
  }

  function buildRetryCorrectionPrompt(basePrompt, retryHistory) {
    if (!Array.isArray(retryHistory) || !retryHistory.length) return basePrompt;
    const parts = [basePrompt];
    for (const turn of retryHistory) {
      if (clean(turn?.response)) {
        parts.push(`【上一次模型输出】\n${cut(turn.response, 4000)}`);
      }
      const errText = Array.isArray(turn?.errors) && turn.errors.length
        ? turn.errors.map((e, i) => `${i + 1}. ${clean(e)}`).join('\n')
        : clean(turn?.error || '输出格式不符合 JSON 规范');
      parts.push(`【纠错要求】\n你上一条输出未通过校验：\n${errText}\n\n请只返回一个完整合法的 JSON 对象，不要输出 Markdown 围栏或解释文字。`);
    }
    return parts.join('\n\n---\n\n');
  }

  return {
    extractJson,
    buildOrganizePrompt,
    parseOrganizeResponse,
    buildCheckPrompt,
    parseCheckResponse,
    buildRetryCorrectionPrompt
  };
})();
