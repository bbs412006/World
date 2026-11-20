// memory-engine-prompt.js — 核心 7 表底层填表提示词（完整采用 shujuku 底层 System Prompt 与各表 Note 约束，支持自由编辑与一键恢复默认）
window.MEMORY_ENGINE_PROMPT = (function() {
  const clean = value => String(value == null ? '' : value).trim();

  const ALL_TABLES = Object.freeze([
    'global_state',
    'protagonist_info',
    'important_characters',
    'protagonist_skills',
    'inventory',
    'quests_events',
    'chronicle'
  ]);

  // 完整移植自 shujuku（romance-overrides + 核心 7 表 table-defaults）各表原版 Note 与增删改规则
  const DEFAULT_SHEET_RULES = Object.freeze({
    global_state: `【1. 全局数据表 (global_state)｜此表有且仅有一行，禁止新增第二行，禁止删除】
记录当前主角所在地点及时间相关参数。

【列定义】
- current_location: 当前详细地点
- current_minor_region: 当前次要地区
- current_major_region: 当前主要地区
- prev_scene_time: 上轮场景时间（初始化时留空 ""）
- elapsed_time: 经过的时间
- cur_time: 当前时间

【强制约束】
1. 地点层级从小到大：详细地点 < 次要地区 < 主要地区。每个字段只写本级名称，不拼上级前缀。
   √ 当前详细地点填 "御苑"
   × 当前详细地点填 "东京-新宿区-御苑"
2. 时间格式：
   prev_scene_time / cur_time 优先使用 "YYYY-MM-DD HH:MM"（架空历法可保留清晰绝对时间）
   elapsed_time: {数值}{单位}，多单位用空格连。单位集合：[纪元, 千年, 百年, 年, 月, 周, 天, 小时, 分]
   示例："3小时20分" | "2天" | "3年6月"
3. 时间计算公式：cur_time = prev_scene_time + elapsed_time
   - 初始化时 prev_scene_time 留空 ""，cur_time 直接填写初始时间，禁止照搬示例中的地点和日期。
   - 每轮推进时，将上一轮的 cur_time 赋值给 prev_scene_time，再填写本次 elapsed_time，计算得到新的 cur_time；若地点变动则同步更新三级地点字段。
4. 若本段对话地点与时间均无变化，输出 null 或 {}；填写非空字段将合并更新该唯一行。`,

    protagonist_info: `【2. 主角信息表 (protagonist_info)｜此表有且仅有一行，禁止新增第二行，禁止删除】
记录主角的核心身份信息。

【列定义】
- name: 姓名
- gender: 性别
- age: 年龄
- appearance: 外貌特征（含日常穿衣风格，写出整体印象，避免罗列数据）
- identity_text: 身份（逗号分隔）
- current_condition: 近况
- location_name: 所在地点
- belongings: 随身财物（可留空）

【强制约束】
1. 所在地点只写地点名不带层级前缀。位置变化时同步更新。
2. 近况用一句话描述主角当前的身体感觉、情绪状态或心头惦记的事。
   正常时期填 "一切如常"，有异常时直接写具体感受，不用标签堆叠。
   √ 昨晚没睡好，脑子有点沉
   √ 刚从雨里跑回来，衣服还湿着
3. 随身财物只写当前身上带着的有意义物品，不写游戏化资源。
   √ 钱包里夹着第一次看电影的票根
   √ 口袋里剩两颗橘子糖
4. 仅在有新披露或字段变化时输出对应字段（未变化字段留空 "" 以保留本地原值）；完全无变化输出 null。`,

    important_characters: `【3. 重要角色表 (important_characters)｜按 name 主键，默认禁止删除】
记录所有对当前剧情产生作用的重要角色。结构：{ "upsert": [ {...} ], "delete": ["明确永久退场且不再追踪的角色名"] }。

【列定义】
- name: 姓名（唯一主键，必填，不得与表中已有角色重名；更新已有角色时必须严格沿用原名）
- gender: 性别
- age: 年龄
- brief_intro: 一句话介绍
- appearance: 外貌特征
- outfit_text: 穿着打扮
- location_name: 所在地点
- presence_status: 在场状态（仅限 "在场" 或 "离场"）
- relation_text: 人际关系
- past_experience: 过往经历

【强制约束】
1. brief_intro 仅允许客观事实类内容，严禁出现任何性格标签概述（如"开朗""冷漠""温柔"等）；客观内容范畴包括：角色核心身份、与剧情强相关的客观行为、与关键人物的客观关联、非性格类核心特征。
   √ 经营城南杂货铺 / 曾救过主角的性命 / 艾莉丝的亲生兄长
   × 性格孤僻的杂货铺老板 / 温柔且救过主角 / 偏执的艾莉丝兄长
2. outfit_text 仅写外在可见的服饰、饰品、妆容、持握物等可视元素，禁止写固有的长相特征、气质、气场等非视觉内容。
   √ 深灰立领风衣配黑皮手套 / 左手无名指戴着一枚银色蛇纹戒
   × 散发出高贵的气场、看起来像个军人
3. 【relation_text 格式规则】（强制）：
   - 格式必须是：角色名:关系描述（必须显式写出"角色名:"前缀，禁止省略角色名直接写关系内容）。
   - 同一角色有多个关系标签/描述时，用英文逗号 , 分隔；不同角色之间用英文分号 ; 分隔；关系描述去除人称，使用简短陈述。
   - 至少包含与主角的关系。
   √ 主角:曾帮其修过自行车,旧识
   √ 主角:认识;艾莉丝:室友兼闺蜜
   √ 主角:校长身份,从未直接交谈;艾莉丝:监护人
   × 曾帮主角修过自行车                  ← 缺少角色名前缀
   × 主角:认识;室友兼闺蜜                ← 第二段缺少角色名
   × 主角:旧识,艾莉丝:室友               ← 不同角色错用逗号
   × 主角:曾帮其修过自行车;旧识          ← 同一角色多标签错用分号
4. past_experience 增量整合角色背景与本段关键事件，控制在 300 字以内，超过时精炼压缩。
5. 删除约束：默认禁止删除。已出场但暂时无剧情、暂时离场、关系或身份变化的角色，必须保留在本表，只更新 presence_status、relation_text、past_experience 等字段；仅当角色明确永久离开当前剧情且后续不再需要追踪时，才允许放入 delete。
6. 更新已有角色时，未变化字段留空 "" 即可自动保留原值；无变化输出 { "upsert": [], "delete": [] }。`,

    protagonist_skills: `【4. 主角技能表 (protagonist_skills)｜按 skill_name 主键】
记录主角获得的所有技能项目。结构：{ "upsert": [ {...} ], "delete": ["被剥夺或替换的技能名"] }。

【列定义】
- skill_name: 技能名称（唯一主键，不得与表中已有技能重名）
- skill_type: 技能类型（"被动" 或 "主动"）
- skill_level: 等级/阶段（当前等级或阶段）
- effect_desc: 效果描述（当前等级下的具体效果）

【增删改规则】
- 初始化（当前表为空时）：游戏初始化时，根据<背景设定>（用户人设、角色卡设定、世界书）与开局剧情为主角添加全部初始技能/天赋/能力写入 upsert。
- 新增：主角获得新的技能时写入 upsert。
- 更新：已有技能升级或效果变化时写入 upsert 更新其 skill_level 与 effect_desc。
- 删除：仅在技能因剧情被剥夺、遗忘或替换时写入 delete。
- 已有数据且本轮无变化输出 { "upsert": [], "delete": [] }。`,

    inventory: `【5. 背包物品表 (inventory)｜按 item_name 主键】
记录主角拥有的所有物品、装备。结构：{ "upsert": [ {...} ], "delete": ["已完全消耗/丢弃/摧毁的物品名"] }。

【列定义】
- item_name: 物品名称（唯一主键，不得与表中已有物品重名）
- quantity: 数量（当前拥有的数量）
- description: 描述/效果（物品的功能、状态或背景描述）
- category: 类别（如"武器"、"消耗品"、"关键物品"、"杂物"等）

【增删改规则】
- 初始化（当前表为空时）：游戏初始化时，根据<背景设定>（用户人设、角色卡设定、世界书）与开局剧情添加主角的初始携带物品、武器、装备或关键道具写入 upsert。
- 新增：主角获得背包中没有的全新物品时写入 upsert。
- 更新：已有物品数量增减或状态变化（如损坏/修复）时写入 upsert。
- 删除：物品被完全消耗、交出、丢弃或摧毁（数量归零）时写入 delete。
- 已有数据且本轮无变化输出 { "upsert": [], "delete": [] }。`,

    quests_events: `【6. 任务与事件表 (quests_events)｜按 quest_name 主键】
记录所有当前正在进行的任务、约定与待解事件。结构：{ "upsert": [ {...} ], "delete": ["已完成/失败/过期的任务名"] }。

【列定义】
- quest_name: 任务名称（唯一主键，不得与表中已有任务重名）
- quest_type: 任务类型（"主线任务" 或 "支线任务"）
- issuer: 发布者（发布该任务的角色或势力）
- detail_desc: 详细描述（任务的目标和要求）
- current_progress: 当前进度（对任务完成度的简要描述）
- time_limit: 任务时限（完成任务的剩余时间）
- reward: 奖励（完成任务可获得的奖励）
- penalty: 惩罚（任务失败的后果）

【增删改规则】
- 初始化（当前表为空时）：游戏初始化时，根据<背景设定>与开局剧情提取并添加核心主线任务/目标及已明确触发的支线任务写入 upsert。
- 新增：主角接取或触发新的主线或支线任务时写入 upsert。
- 更新：任务取得关键进展或时限变动时写入 upsert 更新 current_progress 等字段。
- 删除：任务完成、失败或过期失效时写入 delete。
- 已有数据且本轮无变化输出 { "upsert": [], "delete": [] }。`,

    chronicle: `【7. 纪要表 (chronicle)｜轮次日志，每轮交互结束后必须独立插入一条新记录，禁止删除与修改旧行】
记录剧情推进的客观编年纪要。
- 单轮填表时结构：{ "floor": 楼层号, "code_index": "AMXXXX", "time_span": "时间跨度", "summary": "≤30字概览", "chronicle_text": "详细纪要正文", "key_dialogue": "关键原文台词（可留空）", "keywords": ["检索关键词"], "entities": ["涉及实体"], "impact": "key 或 normal" }。
- 多轮合并填表时结构：必须按用户提示中的【纪要分轮清单】输出数组 [ { 第1轮纪要 }, { 第2轮纪要 }, ... ]，每个待填纪要轮次各自独立生成 1 条记录，严禁把多个轮次/楼层合并成 1 条记录！

【列定义】
- floor: 本条纪要对应的 AI 回复楼层号（纯数字，如 2、4）
- code_index: 编码索引（AM0001 起按轮递增，严格使用用户提示分配的编号，不得与已有编号重复）
- time_span: 时间跨度（优先 "YYYY-MM-DD HH:MM ~ YYYY-MM-DD HH:MM"，覆盖本轮事件的实际时间范围；正文未给出明确时间时可留空或如实标注）
- summary: 概览（一句话概括本轮纪要内容，≤30 字）
- chronicle_text: 纪要正文（须满足用户提示中的【纪要字数要求】单条下限）
- key_dialogue: 重要对话（可留空 ""）
- keywords / entities / impact: 3~6 个检索关键词、涉及人物地点物品名、是否重大转折（"key" 或 "normal"）

【强制约束】
1. 纪要规范：
   - 以第三方视角中立客观记录正文发生的一切，移除所有修辞与闲聊对话。不滥用环境描写、不进行动作细节分析、不加评论，不抒情，不升华。
   - 用词直白生活化，避免正式官腔措辞（如"达成协议""确立计划"）。
   - 结尾必须开放，在事件自然流动中结束，不得归纳状态或做出封闭式收束。
     违例：故事仍在继续 / 新的篇章开启 / 二人关系迈入新阶段 / 未来等待着他们。
   - 每轮交互（每个纪要单元）独立成条：若本次对话包含多轮 AI 回复（例如楼层 2 与楼层 4），必须按楼层逐条拆分生成多条独立纪要（AM0001、AM0002…），绝不允许将多楼层揉成一条合并纪要。
   - 禁止内容：极端情绪（崩溃、狂喜、绝望等）、夸张、比喻、升华、情绪总结、支配欲、掌控欲、总结性收尾。
2. 重要对话（key_dialogue）：仅摘录直接推动剧情转折、揭示关键信息、改变人物关系/决策或构成承诺/誓约/约定的原文台词，标明说话人。排除寒暄、重复、情绪感叹。通常 1~3 句，最多 5 句，总长度简洁克制。`
  });

  // 对齐 shujuku 各表原版 initNode（当表为空时自动注入 Init Trigger 引导初始化）
  const DEFAULT_SHEET_INIT_TRIGGERS = Object.freeze({
    global_state: '游戏初始化时，根据<背景设定>、开局对话与【待提取对话】初始化主角当前所在三级地点与初始时间（prev_scene_time 留空 ""）。',
    protagonist_info: '游戏初始化时，根据<User基础设定>、<角色卡设定>与开局对话初始化主角的姓名、性别、年龄、外貌、身份、所在地点、近况与随身财物。',
    important_characters: '游戏初始化时，记录开局设定或当前对话中已正式登场、对剧情产生直接作用的重要角色。',
    protagonist_skills: '游戏初始化时，根据<背景设定>（用户人设、角色卡设定、世界书）与开局剧情为主角添加全部初始技能/能力。',
    inventory: '游戏初始化时，根据<背景设定>（用户人设、角色卡设定、世界书）与开局剧情添加主角的初始携带物品、武器或装备。',
    quests_events: '游戏初始化时，根据<背景设定>与开局剧情添加当前核心主线任务/目标及已触发的支线任务。',
    chronicle: '按【纪要分轮清单】客观记录【待提取对话】中实际发生的剧情，不得把静态背景设定写成新事件。'
  });

  // 完整对齐 shujuku 默认填表主提示词（DEFAULT_CHAR_CARD_PROMPT_ACU + 严格 JSON 协议）
  const DEFAULT_MAIN_SYSTEM_PROMPT = `你是【填表AI】，负责根据用户提供的资料对表格数据执行增删改操作。

## 核心任务
依据三类资料来源执行表格编辑：
- <背景设定>（含<User基础设定>、<角色卡设定>与<世界书背景>）：故事及人物初始设定（空表初始化时须据此提取主角初始属性、初始技能、初始携带物品与开局主线任务；但不得把静态设定编造成新发生的剧情纪要）
- 【待提取对话】：本轮/本批实际发生的故事正文
- 【当前数据库表状态】：之前的数据作为填表基础（标注「当前为空（请进行初始化）」的表必须执行 Init Trigger 初始化）

## 内部思考与语气校准（在内部完成，不要把思考过程写入最终 JSON 回复）
1. 分析当前轮次的剧情变化，并检查哪些目标表当前为空需要初始化
2. 逐表阅读本次所有目标表的 Note 与填表规则（含空表 Init Trigger）
3. 根据规则确定需要初始化、新增、更新或删除的表格和字段
4. 核对每项写入是否有<背景设定>（仅限空表初始化/设定核对）或【待提取对话】支持
5. 针对纪要表的额外规则：如果本次目标表包含纪要表 (chronicle)，必须严格按【纪要分轮清单】为每一个待填轮次各插入一条独立的总结记录（单轮输出 1 条，N 轮输出含 N 条记录的数组），严禁把多轮 AI 回复合并成 1 条，也不得遗漏或留空。
6. 日志与纪要语气校准：你在思考纪要时，必须区分“正常恋爱互动”与“暗黑主从文风”。你可以使用正常的交流词汇（如：提议、要求、同意、拒绝、引导、配合、安抚），但【绝对禁止】将情侣间的普通调情与互动过度解读为“权力掌控”、“剥夺反抗”、“精神支配”、“屈服”等单向压迫词汇！

## 关键规则
1. 必须逐表阅读下方每张表的 Note 约束，严格遵守其中的列定义、正反例与格式规则。
2. 单表 Note 的约束优先级最高，高于通用填表经验。
3. 若 Note 要求禁止修改、禁止删除、格式固定或编码递增，必须严格执行。
4. 空表初始化优先：当状态表（global_state / protagonist_info / important_characters / protagonist_skills / inventory / quests_events）在【当前数据库表状态】中标明「当前为空（请进行初始化）」时，必须主动结合<背景设定>、开局开场白/前置参考与【待提取对话】，按该表的 Init Trigger 提取主角初始信息、初始技能、初始物品与开局主线任务；不要因为它们出自角色卡设定或开场白而非本轮新获得就留空！
5. 增量事实严谨：已初始化的状态表仅按最新变化增删改；纪要表 (chronicle) 始终严格只记录【待提取对话】中实际发生的剧情，严禁编造未发生情节，严禁把静态背景设定或【前置对话参考】中的旧事重复写成纪要。
6. 增量保留：单行表和主键表更新已有记录时，未变化的字段填 "" 即可保留本地原值，只填写新增或变化字段；已有数据且完全没有变化的表输出 null（单行表）或 { "upsert": [], "delete": [] }（主键表）。
7. 精准范围：本次仅允许输出指定目标表的顶层字段：[{{TARGET_SHEETS}}]，不要输出未要求的表，也不要增加未声明字段。

## 本次目标表规则（Note 约束，优先级最高）
{{SHEET_RULES}}{{TONE_PROMPT}}

## 输出格式（严格执行）
回复内容必须是一个合法 JSON 对象，且只能包含这个 JSON 对象本身；不要输出 <thought>、<content>、<tableEdit>、Markdown 代码围栏、解释前言或结语。

## JSON 格式要点
- 必须输出合法 JSON 对象，不能在 JSON 前后添加任何说明文字
- JSON 字符串必须使用双引号
- 字段值内部需要出现双引号时必须按 JSON 规则转义为 \\"
- 字段值内部需要换行时必须写成 \\n，不能直接输出真实换行
- 如果一句话里含有很多引号，优先改写措辞，尽量避免在 JSON 值里直接嵌套引号

{{JSON_TEMPLATE}}

现在开始按此 JSON 格式执行填表任务。`;

  const SHEET_JSON_TEMPLATES = Object.freeze({
    global_state: `  "global_state": {
    "current_location": "当前详细地点",
    "current_minor_region": "次要地区",
    "current_major_region": "主要地区",
    "prev_scene_time": "上轮时间或空字符串",
    "elapsed_time": "经过的时间",
    "cur_time": "当前时间"
  }`,
    protagonist_info: `  "protagonist_info": {
    "name": "主角姓名",
    "gender": "性别",
    "age": "年龄",
    "appearance": "外貌特征",
    "identity_text": "身份",
    "current_condition": "近况",
    "location_name": "所在地点",
    "belongings": "随身财物"
  }`,
    important_characters: `  "important_characters": {
    "upsert": [
      {
        "name": "角色姓名",
        "gender": "性别",
        "age": "年龄",
        "brief_intro": "客观事实一句话介绍（禁性格词）",
        "appearance": "外貌特征",
        "outfit_text": "可视穿着打扮",
        "location_name": "所在地点",
        "presence_status": "在场或离场",
        "relation_text": "主角:关系1,关系2;另一角色:关系",
        "past_experience": "过往经历"
      }
    ],
    "delete": []
  }`,
    protagonist_skills: `  "protagonist_skills": {
    "upsert": [
      { "skill_name": "技能名", "skill_type": "主动或被动", "skill_level": "等级/阶段", "effect_desc": "当前等级效果描述" }
    ],
    "delete": []
  }`,
    inventory: `  "inventory": {
    "upsert": [
      { "item_name": "物品名", "quantity": "数量", "description": "功能/状态描述", "category": "类别" }
    ],
    "delete": []
  }`,
    quests_events: `  "quests_events": {
    "upsert": [
      { "quest_name": "任务名", "quest_type": "主线任务或支线任务", "issuer": "发布者", "detail_desc": "详细描述", "current_progress": "当前进度", "time_limit": "时限", "reward": "奖励", "penalty": "惩罚" }
    ],
    "delete": []
  }`,
    chronicle: `  "chronicle": {
    "floor": 2,
    "code_index": "AM0001",
    "time_span": "YYYY-MM-DD HH:MM ~ YYYY-MM-DD HH:MM",
    "summary": "≤30字一句话概览",
    "chronicle_text": "第三方客观中立的详细纪要正文（结尾保持开放）",
    "key_dialogue": "关键原文台词或空字符串",
    "keywords": ["关键词1", "关键词2"],
    "entities": ["人物或地点名"],
    "impact": "normal"
  }`
  });

  function buildChronicleJsonTemplate(chronicleGroups, fallbackNextCode, fallbackFloor) {
    const groups = Array.isArray(chronicleGroups) && chronicleGroups.length ? chronicleGroups : null;
    if (!groups || groups.length <= 1) {
      const g = groups ? groups[0] : null;
      const code = clean(g?.codeIndex || fallbackNextCode) || 'AM0001';
      const fl = Number.isFinite(Number(g?.endLayer ?? fallbackFloor)) ? Number(g?.endLayer ?? fallbackFloor) : 2;
      return `  "chronicle": {
    "floor": ${fl},
    "code_index": "${code}",
    "time_span": "YYYY-MM-DD HH:MM ~ YYYY-MM-DD HH:MM",
    "summary": "≤30字一句话概览",
    "chronicle_text": "第三方客观中立的详细纪要正文（结尾保持开放）",
    "key_dialogue": "关键原文台词或空字符串",
    "keywords": ["关键词1", "关键词2"],
    "entities": ["人物或地点名"],
    "impact": "normal"
  }`;
    }
    const items = groups.map((g, idx) => {
      const code = clean(g?.codeIndex) || `AM${String(idx + 1).padStart(4, '0')}`;
      const fl = Number.isFinite(Number(g?.endLayer)) ? Number(g.endLayer) : (idx + 1) * 2;
      const spanDesc = g.startLayer !== g.endLayer ? `楼层 ${g.startLayer}-${g.endLayer}` : `楼层 ${fl}`;
      return `    {
      "floor": ${fl},
      "code_index": "${code}",
      "time_span": "YYYY-MM-DD HH:MM ~ YYYY-MM-DD HH:MM",
      "summary": "${spanDesc} 一句话概览（≤30字）",
      "chronicle_text": "${spanDesc} 第三方客观中立的详细纪要正文（结尾保持开放）",
      "key_dialogue": "关键原文台词或空字符串",
      "keywords": ["关键词1", "关键词2"],
      "entities": ["人物或地点名"],
      "impact": "normal"
    }`;
    }).join(',\n');
    return `  "chronicle": [\n${items}\n  ]`;
  }

  function resolveTargetSheets(targetSheets) {
    const list = Array.isArray(targetSheets) ? targetSheets.filter(k => ALL_TABLES.includes(k)) : [];
    return list.length ? Array.from(new Set(list)) : [...ALL_TABLES];
  }

  function readSettingsSafe() {
    try { return window.MEMORY_ENGINE_SETTINGS?.getSettings?.() || {}; }
    catch (_) { return {}; }
  }

  function isLegacyDefaultMainPrompt(text) {
    if (!text.includes('你是【填表AI】，负责根据用户提供的资料对表格数据执行增删改操作。')) return false;
    return text.includes('那么本轮就必须插入一条新的总结记录，不得遗漏或留空。')
      || (text.includes('- <背景设定> / 【世界书背景】：故事及人物设定（仅作称呼与背景辨认，不得把历史设定抄写成新事件）')
        && text.includes('4. 事实严谨：所有新增与修改必须由【待提取对话】直接支持'));
  }

  function isLegacyMergedDefaultChronicleRule(text) {
    return text.startsWith('【7. 纪要表 (chronicle)｜轮次日志，每批必填追加 1 条，禁止删除与修改旧行】')
      && text.includes('- 多轮交互整合为一条记录。');
  }

  function isLegacyImportantCharsRule(text) {
    return text.startsWith('【3. 重要角色表 (important_characters)｜按 name 主键，默认禁止删除】')
      && text.includes('- interaction_options: 交互选项')
      && text.includes('3. interaction_options 必须同时遵循下述要求：');
  }

  function isLegacyNoInitRule(sheetKey, text) {
    if (sheetKey === 'protagonist_skills') {
      return text.startsWith('【4. 主角技能表 (protagonist_skills)｜按 skill_name 主键】')
        && !text.includes('初始化（当前表为空时）')
        && text.includes('- 无变化输出 { "upsert": [], "delete": [] }。');
    }
    if (sheetKey === 'inventory') {
      return text.startsWith('【5. 背包物品表 (inventory)｜按 item_name 主键】')
        && !text.includes('初始化（当前表为空时）')
        && text.includes('- 无变化输出 { "upsert": [], "delete": [] }。');
    }
    if (sheetKey === 'quests_events') {
      return text.startsWith('【6. 任务与事件表 (quests_events)｜按 quest_name 主键】')
        && !text.includes('初始化（当前表为空时）')
        && text.includes('- 无变化输出 { "upsert": [], "delete": [] }。');
    }
    return false;
  }

  function getEffectiveMainSystemPrompt(customOverride) {
    const override = clean(customOverride);
    if (override && !isLegacyDefaultMainPrompt(override)) return override;
    const saved = clean(readSettingsSafe().tableFillSystemPrompt);
    if (saved && !isLegacyDefaultMainPrompt(saved)) return saved;
    return DEFAULT_MAIN_SYSTEM_PROMPT;
  }

  function getEffectiveSheetRule(sheetKey, customRulesOverride) {
    if (!ALL_TABLES.includes(sheetKey)) return '';
    const isStaleDefault = text => (sheetKey === 'chronicle' && isLegacyMergedDefaultChronicleRule(text))
      || (sheetKey === 'important_characters' && isLegacyImportantCharsRule(text))
      || isLegacyNoInitRule(sheetKey, text);
    const fromOpt = clean(customRulesOverride?.[sheetKey]);
    if (fromOpt && !isStaleDefault(fromOpt)) return fromOpt;
    const fromSettings = clean(readSettingsSafe().tableFillSheetRules?.[sheetKey]);
    if (fromSettings && !isStaleDefault(fromSettings)) return fromSettings;
    return DEFAULT_SHEET_RULES[sheetKey] || '';
  }

  function buildTableFillSystemPrompt(targetSheets, options) {
    const sheets = resolveTargetSheets(targetSheets);
    const opts = options || {};
    const rulesText = sheets
      .map(key => getEffectiveSheetRule(key, opts.customSheetRules))
      .filter(Boolean)
      .join('\n\n');
    const jsonTemplate = `{\n${sheets.map(key => key === 'chronicle'
      ? buildChronicleJsonTemplate(opts.chronicleGroups, opts.nextChronicleCode, opts.endLayer)
      : SHEET_JSON_TEMPLATES[key]).join(',\n')}\n}`;
    const toneBlock = clean(opts.tonePrompt) ? `\n\n【附加风格与领域补充要求】\n${clean(opts.tonePrompt)}` : '';
    const template = getEffectiveMainSystemPrompt(opts.customSystemPrompt);

    let out = template;
    const hasTargetPh = out.includes('{{TARGET_SHEETS}}');
    const hasRulesPh = out.includes('{{SHEET_RULES}}');
    const hasJsonPh = out.includes('{{JSON_TEMPLATE}}');
    const hasTonePh = out.includes('{{TONE_PROMPT}}');

    if (hasTargetPh) out = out.split('{{TARGET_SHEETS}}').join(sheets.join(', '));
    if (hasRulesPh) out = out.split('{{SHEET_RULES}}').join(rulesText);
    if (hasJsonPh) out = out.split('{{JSON_TEMPLATE}}').join(jsonTemplate);
    if (hasTonePh) out = out.split('{{TONE_PROMPT}}').join(toneBlock);

    // 防护：即使作者自定义主提示词时删掉了占位符，仍自动附带本次目标表规则与严格 JSON 模板，防止解析失效
    const missingParts = [];
    if (!hasRulesPh && rulesText) {
      missingParts.push(`## 本次目标表规则（[${sheets.join(', ')}]）\n${rulesText}`);
    }
    if (!hasTonePh && toneBlock) {
      missingParts.push(toneBlock.trim());
    }
    if (!hasJsonPh) {
      missingParts.push(`## 本次输出 JSON 模板（仅输出以下顶层字段：[${sheets.join(', ')}]）\n${jsonTemplate}`);
    }
    return missingParts.length ? `${out.trim()}\n\n${missingParts.join('\n\n')}` : out;
  }

  const SYSTEM_PROMPT = buildTableFillSystemPrompt(ALL_TABLES);
  const TASK_PROMPT = SYSTEM_PROMPT;

  function cellEsc(val) {
    return clean(val).replace(/\|/g, '｜').replace(/\r?\n/g, ' ');
  }

  function formatTablesMarkdown(tables, targetSheets, options) {
    const dataApi = window.MEMORY_ENGINE_DATA;
    const schemas = dataApi?.TABLE_SCHEMAS || {};
    const src = tables && typeof tables === 'object' ? tables : {};
    const opts = options || {};
    const chronicleLimit = Math.max(1, parseInt(opts.referenceChronicleCount, 10) || 5);
    const resolvedTargets = resolveTargetSheets(targetSheets);
    const targetSet = new Set(resolvedTargets);
    const displaySheets = Array.from(new Set(['global_state', 'protagonist_info', ...resolvedTargets]));
    const blocks = [];

    for (const key of displaySheets) {
      const schema = schemas[key];
      if (!schema) continue;
      let rows = Array.isArray(src[key]) ? src[key] : [];
      if (key === 'chronicle') {
        rows = rows.filter(r => {
          if (!r || r.status === 'stale' || r.status === 'failed') return false;
          if (opts.beforeLayer !== undefined && Number.isFinite(Number(opts.beforeLayer)) && Number.isFinite(Number(r.endLayer)) && Number(r.endLayer) >= Number(opts.beforeLayer)) {
            return false;
          }
          return true;
        }).slice(-chronicleLimit);
      }
      const cols = schema.columns || [];
      const header = `| row_id | ${cols.map(c => c.label).join(' | ')} |`;
      const sep = `| --- | ${cols.map(() => '---').join(' | ')} |`;
      if (!rows.length) {
        if (targetSet.has(key) && key !== 'chronicle') {
          const initTrigger = DEFAULT_SHEET_INIT_TRIGGERS[key] || '该表格为空，请根据背景设定与开局剧情进行初始化。';
          blocks.push(`### ${schema.name} (${key}) — 当前为空（请进行初始化）\n- Init Trigger（初始化触发规则）：${initTrigger}\n${header}\n${sep}`);
        } else {
          blocks.push(`### ${schema.name} (${key}) — 当前为空\n${header}\n${sep}`);
        }
        continue;
      }
      const body = rows.map(row => {
        const vals = cols.map(c => {
          let v = row[c.key];
          if (key === 'chronicle' && c.key === 'chronicle_text' && clean(v).length > 800) {
            v = clean(v).slice(0, 800) + '…';
          }
          return cellEsc(v);
        });
        return `| ${row.rowId || 1} | ${vals.join(' | ')} |`;
      }).join('\n');
      const note = key === 'chronicle' ? `（仅展示最近 ${rows.length} 条供衔接）` : '';
      blocks.push(`### ${schema.name} (${key})${note}\n${header}\n${sep}\n${body}`);
    }
    return blocks.join('\n\n');
  }

  function buildUserPrompt(options) {
    const input = options || {};
    const targetSheets = resolveTargetSheets(input.targetSheets);
    const tables = input.tables || {};
    const currentStoryTime = clean(input.currentStoryTime);
    const personaDescription = clean(input.personaDescription);
    const characterCard = clean(input.characterCard);
    const openingContext = clean(input.openingContext);
    const worldbook = clean(input.worldbook);
    const outlineFocusHint = clean(input.outlineFocusHint);
    const worldContextHint = clean(input.worldContextHint);
    const referenceContext = clean(input.referenceContext);
    const conversation = clean(input.conversation);
    const startLayer = Number.isFinite(Number(input.startLayer)) ? Number(input.startLayer) : 0;
    const endLayer = Number.isFinite(Number(input.endLayer)) ? Number(input.endLayer) : startLayer;
    const aiCount = Math.max(1, parseInt(input.aiCount, 10) || 1);
    const minChars = Math.max(50, parseInt(input.minChars, 10) || 500);
    const nextCode = clean(input.nextChronicleCode) || window.MEMORY_ENGINE_DATA?.nextChronicleCode?.(tables.chronicle) || 'AM0001';
    const rangeLabel = startLayer === endLayer ? `楼层 ${endLayer}` : `楼层 ${startLayer} 至 ${endLayer}`;
    const hasEmptyStatusSheets = targetSheets.some(k => k !== 'chronicle' && (!Array.isArray(tables[k]) || tables[k].length === 0));

    const chronGroups = Array.isArray(input.chronicleGroups) && input.chronicleGroups.length ? input.chronicleGroups : null;

    const sections = [
      `【本次填表范围与目标表】\n楼层范围：${rangeLabel}（共 ${aiCount} 条 AI 回复）\n本次待填表：[${targetSheets.join(', ')}]${targetSheets.includes('chronicle') ? `\n下一可用纪要编码索引：${nextCode}` : ''}`
    ];

    if (targetSheets.includes('chronicle')) {
      if (chronGroups && chronGroups.length > 1) {
        const groupLines = chronGroups.map((g, idx) => {
          const gSpan = g.startLayer === g.endLayer ? `楼层 ${g.endLayer}` : `楼层 ${g.startLayer}-${g.endLayer}`;
          const gCount = Array.isArray(g.aiLayers) && g.aiLayers.length ? g.aiLayers.length : 1;
          return `${idx + 1}. 对应 [${gSpan}] → floor: ${g.endLayer}, code_index: "${g.codeIndex}"（本条正文最低不少于 ${minChars * gCount} 字）`;
        }).join('\n');
        sections.push(`【纪要分轮清单与字数要求（必须逐轮独立生成 ${chronGroups.length} 条，严禁合并）】\n本次对话包含 ${chronGroups.length} 个独立纪要轮次，chronicle 字段必须输出长度为 ${chronGroups.length} 的 JSON 数组，逐条对应如下：\n${groupLines}\n每条均须详实客观展开对应楼层行动、关键台词原意、细节与结果，禁止把多轮合并成 1 条，禁止总结性收尾。`);
      } else {
        sections.push(`【纪要字数要求】\nchronicle.chronicle_text 正文最低不少于 ${minChars * aiCount} 字（单层最低 ${minChars} 字 × ${aiCount} 层），须详实客观展开本段行动、关键台词原意、细节与结果，禁止空泛敷衍或总结性收尾。`);
      }
    }

    if (currentStoryTime) {
      sections.push(`【当前故事时间参考】\n${currentStoryTime}`);
    }

    const mdTables = formatTablesMarkdown(tables, targetSheets, {
      referenceChronicleCount: input.referenceChronicleCount,
      beforeLayer: input.beforeLayer
    });
    if (mdTables) {
      sections.push(`【当前数据库表状态（基线；标明「当前为空（请进行初始化）」的表请结合背景设定与开局剧情初始化，已有数据的表仅输出新增/变动）】\n${mdTables}`);
    }

    // 对齐 shujuku 的 <背景设定> 区块（$U 用户人设 + $C 角色卡设定 + $4 世界书背景 + 可选开场白参考）
    const bgParts = [];
    if (personaDescription) {
      bgParts.push(`<User基础设定>\n${personaDescription}\n</User基础设定>`);
    }
    if (characterCard) {
      bgParts.push(`<角色卡设定>\n${characterCard}\n</角色卡设定>`);
    }
    if (worldbook) {
      bgParts.push(`<世界书背景>\n${worldbook}\n</世界书背景>`);
    }
    if (openingContext && hasEmptyStatusSheets) {
      bgParts.push(`<开局开场白参考>\n${openingContext}\n</开局开场白参考>`);
    }
    if (bgParts.length) {
      const bgNote = hasEmptyStatusSheets
        ? '以下为故事与人物基础设定：请用于称呼辨认，并在上方状态表当前为空时主动提取主角初始信息、初始技能、初始携带物品与开局主线任务；但不得把静态设定写成新的剧情纪要。'
        : '以下为故事与人物基础设定（仅用于辨认设定与称呼，不得把静态设定抄写成新发生的剧情纪要）。';
      sections.push(`<背景设定>\n${bgNote}\n\n${bgParts.join('\n\n')}\n</背景设定>`);
    }

    if (worldContextHint) {
      sections.push(`【世界客观动态参考（仅作实体与事实核对）】\n${worldContextHint}`);
    }
    if (outlineFocusHint) {
      sections.push(`【当前公开剧情焦距（仅作主题对齐，未发生情节不得写入）】\n${outlineFocusHint}`);
    }
    if (referenceContext) {
      const refHeader = hasEmptyStatusSheets
        ? '【前置对话参考（用于理解前因指代；若上方状态表当前为空需要初始化，可从中提取初始地点、主角、技能、物品与主线任务；纪要表严禁将前置对话重复入库）】'
        : '【只读前置对话参考（仅用于理解前因指代，勿重复填表）】';
      sections.push(`${refHeader}\n${referenceContext}`);
    }

    sections.push(`【待提取对话】\n${conversation || '（空）'}`);
    sections.push(`请严格按照系统规则，针对 [${targetSheets.join(', ')}] 输出单个合法 JSON 对象。`);
    return sections.join('\n\n');
  }

  function buildMessages(options) {
    const opts = options || {};
    return [
      { role: 'system', content: buildTableFillSystemPrompt(opts.targetSheets, opts) },
      { role: 'user', content: buildUserPrompt(opts) }
    ];
  }

  // 对齐 shujuku 的 table-fill-retry：解析或字段校验失败时，把上轮失败回复与具体错误清单回灌给模型定向修正
  function buildRetryCorrectionMessages(baseMessages, retryHistory, targetSheets) {
    if (!Array.isArray(retryHistory) || !retryHistory.length) return baseMessages;
    const sheets = resolveTargetSheets(targetSheets);
    const extra = [];
    for (const turn of retryHistory) {
      if (clean(turn?.response)) {
        extra.push({ role: 'assistant', content: String(turn.response).slice(0, 6000) });
      }
      const errList = Array.isArray(turn?.errors) && turn.errors.length
        ? turn.errors.map((e, i) => `${i + 1}. ${clean(e)}`).join('\n')
        : clean(turn?.error || '输出格式不符合 JSON 规范');
      extra.push({
        role: 'user',
        content: `【填表纠错】\n你上一条回复未通过结构校验，具体报错如下：\n${errList}\n\n修正要求：\n1. 仅输出一个完整合法的 JSON 对象，不要包含 Markdown 代码围栏或多余文字。\n2. 顶层字段严格限定在本次目标表 [${sheets.join(', ')}] 内；主键字段（如 name / skill_name / item_name / quest_name / code_index）不得为空。\n3. 保留上一轮所有有效提取内容，针对报错逐项修复，禁止编造未发生的剧情。`
      });
    }
    return [...baseMessages, ...extra];
  }

  function messagesToPromptString(messages) {
    if (!Array.isArray(messages)) return String(messages == null ? '' : messages);
    return messages.map(m => {
      const role = clean(m?.role);
      const body = String(m?.content == null ? '' : m.content).trim();
      if (!body) return '';
      if (role === 'assistant') return `【上一次模型输出】\n${body}`;
      return body;
    }).filter(Boolean).join('\n\n---\n\n');
  }

  return {
    ALL_TABLES,
    DEFAULT_MAIN_SYSTEM_PROMPT,
    DEFAULT_SHEET_RULES,
    DEFAULT_SHEET_INIT_TRIGGERS,
    SYSTEM_PROMPT,
    TASK_PROMPT,
    getEffectiveMainSystemPrompt,
    getEffectiveSheetRule,
    buildTableFillSystemPrompt,
    formatTablesMarkdown,
    buildUserPrompt,
    buildMessages,
    buildRetryCorrectionMessages,
    messagesToPromptString
  };
})();
