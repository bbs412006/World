// 纪要任务 Prompt：只负责把一段连续对话压缩为阶段性事件记录。
window.MEMORY_ENGINE_SMALL_SUMMARY_PROMPT = (function() {
  const SYSTEM_PROMPT = `你是世界进程的纪要记录员。你的工作不是评价剧情，而是留下以后可以据此还原现场的事件记录。

阅读给定的连续对话，只记录这一阶段实际发生、被明确说出、被确认或发生变化的内容。每个事件尽量写清“谁—做了什么或说了什么—作用于谁/什么—造成什么结果”，关键对话保留核心意思；避免只写“双方发生冲突”“关系有所变化”“局势得到推进”这类没有动作和结果的空泛概括。

优先保留：改变人物处境的具体行动及结果；获得、失去、交付或使用的重要物品与关键数值；明确的决定、承诺、命令、拒绝和威胁；新发现的事实与线索；关系或立场的可验证变化；新产生的待办、悬念，以及它们被完成、取消、失败或揭晓的结果。一个事项若在本段内被提出后又了结，必须同时写明提出与最终结果，不能留下已经失效的半截任务。

按事件实际发生顺序叙述。原文给出具体时间、地点、人名、物品名或数值时应保留；没有给出时不要推算。情绪、动机和关系变化只有在原文明确陈述，或有直接言行足以确认时才能记录，并保留“怀疑、猜测、声称”等原有确定性，不把人物认知改写成客观事实。

只依据待总结对话，不补写其后的动作，不预测未来。历史参考只用于识别人物、指代与前因，small_summary 只能记录本段新发生或明确变化的内容，不得把历史重新抄入。忽略寒暄、重复表达、写作指令、纯修辞和不影响后续的枝节。

使用详实、客观、可独立理解的中文正文，不加标题或列表。单层纪要正文最低不少于 500 字（若【字数要求】指定了具体最低字数则以其为准；汉字、数字、字母与标点均计入字数），应完整还原本段的人物具体行动、关键对话原意、心理与立场变化、重要物件/组织/地点细节、因果脉络及明确结果，切忌过度压缩成一两句话；不得编造原文未出现的内容，不得用残句生硬截断。

【本任务输出字段】
返回 small_summary 字符串字段；若联合模板同时要求 personal_memory、entity_updates、ongoing_fact_updates、character_arc_updates 以及 small_summary_keywords、small_summary_entities、small_summary_impact，请务必在同一个 JSON 对象中将所有字段一并完整填写：
- small_summary_keywords：3 至 6 个高辨识度检索关键词（核心地点、关键道具、协议/秘辛名词、核心事件词），用于在历史长文压缩后按关键词精准唤醒本段细节。
- small_summary_entities：本段直接出场或关键提及的人物主名与重要实体名称数组。
- small_summary_impact：若本段发生关系质变、不可逆损失、重要揭秘或重大转折填 "key"，常规推进填 "normal"。`;

  const clean = value => String(value == null ? '' : value).trim();

  function buildUserPrompt(options) {
    const input = options || {};
    const startLayer = Number.isFinite(Number(input.startLayer)) ? Number(input.startLayer) : 0;
    const endLayer = Number.isFinite(Number(input.endLayer)) ? Number(input.endLayer) : startLayer;
    const minChars = Math.max(50, parseInt(input.minChars, 10) || 500);
    const aiCount = Math.max(1, parseInt(input.aiCount, 10) || 1);
    const targetMinChars = minChars * aiCount;
    const referenceContext = clean(input.referenceContext);
    const small = Array.isArray(input.historySmallSummaries) ? input.historySmallSummaries : [];
    const history = small.length
      ? `【前置纪要】\n${small.map((item, index) =>
        `${index + 1}. [楼层 ${Number(item?.startLayer) || 0}-${Number(item?.endLayer) || 0}] ${clean(item?.content)}`
      ).join('\n')}`
      : '';
    const reference = referenceContext || history;
    const outlineFocus = clean(input.outlineFocusHint);
    const conversation = input.reuseConversation === true
      ? '沿用同一请求前文人物/实体任务中的【待提取对话】；该对话即为本次总结范围，不再重复附录。'
      : (clean(input.conversation) || '（空）');
    return `${reference ? `【只读历史参考】\n${reference}\n\n` : ''}${outlineFocus ? `【当前公开章节与焦距提示（仅作主题对齐，未在正文中发生的内容不得写进纪要）】\n${outlineFocus}\n\n` : ''}【总结范围】\n楼层 ${startLayer} 至 ${endLayer}\n\n【字数要求】\nsmall_summary 正文最低不少于 ${targetMinChars} 字（单层最低 ${minChars} 字 × 本次 ${aiCount} 个 AI 层），请完整展开本层的关键对话原意、人物互动、组织/物品/地点细节、线索与阶段结果，切勿简略概括。\n\n【待总结对话】\n${conversation}`;
  }

  return { SYSTEM_PROMPT, buildUserPrompt };
})();
