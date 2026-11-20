// memory-engine-small-summary-prompt.js — 纪要表（chronicle）专用提示词（对齐 shujuku 纪要表规范）
window.MEMORY_ENGINE_SMALL_SUMMARY_PROMPT = (function() {
  const SYSTEM_PROMPT = `你是“记忆数据库”的纪要表（chronicle）记录员。你的工作不是评价剧情，而是留下客观中立、可还原现场的事件纪要。

【纪要表字段规范】
- code_index：编码索引，格式 AMXXXX（如 AM0001），严格使用输入提供的下一可用编号，不得重复。
- time_span：本段事件实际时间跨度（优先 "YYYY-MM-DD HH:MM ~ YYYY-MM-DD HH:MM"；正文未给出明确时间时可留空或按上下文如实标注）。
- summary：≤30 字的一句话客观概览，用于历史索引快速检索。
- chronicle_text：以第三方中立客观视角详实记录本段实际发生的一切，须满足【字数要求】下限。
  * 移除所有纯修辞、夸张比喻、情绪升华与主观评论；用词直白具体。
  * 写清“谁—做了什么/说了什么—作用于谁/什么—造成什么结果”，保留关键人物互动、物品/位置变化、决定与承诺。
  * 结尾必须开放自然停在事件流动处，严禁出现“故事仍在继续/新的篇章开启/关系迈入新阶段/未来等待着他们”等总结性收束。
- key_dialogue：仅摘录直接推动剧情转折、揭示关键信息、改变人物关系/决策或构成承诺/誓约的原文台词（标明说话人，通常 1~5 句，无则留空 ""）。
- keywords：3 至 6 个高辨识度检索关键词（核心地点、关键物品、人物/事件专有名词）。
- entities：本段直接出场或关键提及的人物姓名与重要地点/物品名称数组。
- impact：若本段发生关系质变、不可逆损失、重要揭秘或重大转折填 "key"，常规推进填 "normal"。

只依据【待总结对话】，禁止编造后续剧情或抄入【只读历史参考】。只输出一个合法 JSON 对象，顶层包含 chronicle 对象。`;

  const clean = value => String(value == null ? '' : value).trim();

  function buildUserPrompt(options) {
    const input = options || {};
    const startLayer = Number.isFinite(Number(input.startLayer)) ? Number(input.startLayer) : 0;
    const endLayer = Number.isFinite(Number(input.endLayer)) ? Number(input.endLayer) : startLayer;
    const minChars = Math.max(50, parseInt(input.minChars, 10) || 500);
    const aiCount = Math.max(1, parseInt(input.aiCount, 10) || 1);
    const targetMinChars = minChars * aiCount;
    const nextCode = clean(input.nextChronicleCode) || 'AM0001';
    const referenceContext = clean(input.referenceContext);
    const small = Array.isArray(input.historySmallSummaries) ? input.historySmallSummaries : [];
    const formatSpan = (s, e) => {
      const a = Number.isFinite(Number(s)) ? Number(s) : 0;
      const b = Number.isFinite(Number(e)) ? Number(e) : a;
      return a === b ? String(b) : `${a}-${b}`;
    };
    const history = small.length
      ? `【前置纪要】\n${small.map((item, index) =>
        `${index + 1}. [${clean(item?.code_index || item?.codeIndex) || `AM${String(index + 1).padStart(4, '0')}`} · 楼层 ${formatSpan(item?.startLayer, item?.endLayer)}] ${clean(item?.chronicle_text || item?.content)}`
      ).join('\n')}`
      : '';
    const reference = referenceContext || history;
    const outlineFocus = clean(input.outlineFocusHint);
    const conversation = input.reuseConversation === true
      ? '沿用同一请求前文中的【待提取对话】；该对话即为本次总结范围，不再重复附录。'
      : (clean(input.conversation) || '（空）');
    const rangeLabel = startLayer === endLayer ? `楼层 ${endLayer}` : `楼层 ${startLayer} 至 ${endLayer}`;
    return `${reference ? `【只读历史参考】\n${reference}\n\n` : ''}${outlineFocus ? `【当前公开章节与焦距提示（仅作主题对齐，未在正文中发生的内容不得写进纪要）】\n${outlineFocus}\n\n` : ''}【总结范围】\n${rangeLabel}\n下一可用编码索引：${nextCode}\n\n【字数要求】\nchronicle_text 正文最低不少于 ${targetMinChars} 字（单层最低 ${minChars} 字 × 本次 ${aiCount} 个 AI 层），请完整展开本段的关键对话原意、人物互动、细节与明确结果，切勿简略概括。\n\n【待总结对话】\n${conversation}`;
  }

  return { SYSTEM_PROMPT, buildUserPrompt };
})();
