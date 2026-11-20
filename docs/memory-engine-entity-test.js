const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const storage = new Map();
let injection = '';
let apiResponse = '';
let apiCalls = 0;
const chat = [
  { is_user: false, name: '角色', mes: '序章开场白。' },
  { is_user: true, name: '玩家', mes: '嘉宁三十年正月十五，沈鹤亭在黑礁湾代表听潮阁取出断潮剑。' },
  { is_user: false, name: '角色', mes: '断潮剑在交战中折损，沈鹤亭确信它还能修复，并在此觉醒听潮能力。' }
];

global.window = global;
global.document = { getElementById: () => null };
const injectionSlots = {};
global.SillyTavern = {
  getContext: () => ({
    chat,
    setExtensionPrompt: (name, content) => {
      injectionSlots[name] = content;
      injection = Object.values(injectionSlots).filter(Boolean).join('\n\n');
    }
  })
};
global.WORLD_ENGINE_STORE = {
  getItem: key => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key)
};
global.WORLD_ENGINE_CORE = {
  getChatId: () => 'entity-test',
  filterDialogue: value => value
};
global.WORLD_ENGINE_API = { callApi: async () => { apiCalls++; return apiResponse; } };
global.WORLD_ENGINE_UI = { setMemoryEvolvingUI: () => {} };

for (const file of ['memory-engine-settings.js', 'memory-engine-data.js', 'memory-engine-prompt.js',
  'memory-engine-small-summary-prompt.js', 'memory-engine.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
}
WORLD_ENGINE_STORE.setItem('memory_engine_settings', JSON.stringify({ apiAutoRetries: 0, tableFillMaxRetries: 1, injectIntoWorldEngine: true }));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  // 1. 旧版 v1/v2 存档自动无损迁移到核心 7 表
  storage.set('memory_engine_state_entity-test', JSON.stringify({
    personal_memory: [{ id: 'char_000001', names: ['旧角色'], profile: { basicInfo: { identity: '隐士' }, experiences: '隐居深山。' }, memory: {} }],
    knowledge_index: {},
    world_memory: {
      organization: [],
      item: [{ id: 'item_000001', name: '旧物', description: '旧结构传家宝。', history: [] }],
      ability: [{ id: 'ab_000001', name: '听潮术', description: '闻潮辩位。', history: [] }],
      location: []
    },
    ongoing_facts: [{ id: 'fact_1', category: '主线', subject: '旧任务', fact: '寻回古剑', status: 'active' }],
    round: 1, chatLayer: 2
  }));
  const migrated = MEMORY_ENGINE_DATA.loadState();
  assert(migrated.schemaVersion === 3, '旧存档应自动升级到 schemaVersion=3');
  assert(migrated.tables.important_characters[0].name === '旧角色', '旧 personal_memory 应迁入 important_characters');
  assert(migrated.tables.inventory[0].item_name === '旧物', '旧 world_memory.item 应迁入 inventory');
  assert(migrated.tables.protagonist_skills[0].skill_name === '听潮术', '旧 world_memory.ability 应迁入 protagonist_skills');
  assert(migrated.tables.quests_events[0].detail_desc === '寻回古剑', '旧 ongoing_facts 应迁入 quests_events');

  // 2. 清空后执行核心 7 表结构化填表（含全局/主角/角色/技能/背包/任务/纪要）
  storage.set('memory_engine_state_entity-test', JSON.stringify(MEMORY_ENGINE_DATA.defaultState()));
  apiResponse = JSON.stringify({
    global_state: {
      current_location: '黑礁湾',
      current_minor_region: '东海岸',
      current_major_region: '沧州',
      prev_scene_time: '',
      elapsed_time: '30分',
      cur_time: '嘉宁三十年正月十五 21:00'
    },
    protagonist_info: {
      name: '沈鹤亭',
      gender: '男',
      age: '26',
      appearance: '黑衣短发',
      identity_text: '听潮阁门人',
      current_condition: '激战后略显疲惫',
      location_name: '黑礁湾',
      belongings: '断潮剑'
    },
    important_characters: {
      upsert: [{
        name: '苏明月',
        gender: '女',
        age: '24',
        brief_intro: '听潮阁执事',
        appearance: '青衫佩玉',
        outfit_text: '月白劲装',
        location_name: '黑礁湾',
        presence_status: '在场',
        relation_text: '沈鹤亭:同门',
        past_experience: '随沈鹤亭赴黑礁湾迎敌。'
      }],
      delete: []
    },
    protagonist_skills: {
      upsert: [{ skill_name: '听潮', skill_type: '被动', skill_level: '初阶', effect_desc: '能够从潮声中分辨远处动静' }],
      delete: []
    },
    inventory: {
      upsert: [{ item_name: '断潮剑', quantity: '1', description: '剑格刻有海浪纹的旧剑，目前剑身折损', category: '武器' }],
      delete: []
    },
    quests_events: {
      upsert: [{ quest_name: '修复断潮剑', quest_type: '主线任务', issuer: '沈鹤亭', detail_desc: '寻找玄铁修复折损剑身', current_progress: '准备启程' }],
      delete: []
    },
    chronicle: {
      code_index: 'AM0001',
      time_span: '嘉宁三十年正月十五 20:30 ~ 21:00',
      summary: '黑礁湾激战断潮剑折损并觉醒听潮',
      chronicle_text: '沈鹤亭在黑礁湾经历交战，断潮剑折损，并觉醒听潮能力。',
      key_dialogue: '沈鹤亭：“此剑未绝，必能重铸。”',
      keywords: ['黑礁湾', '断潮剑', '听潮'],
      entities: ['沈鹤亭', '苏明月', '断潮剑'],
      impact: 'key'
    }
  });

  const first = await MEMORY_ENGINE.manualExtract();
  assert(first.added >= 7, '7 张核心表变更应全部计入 added');
  let state = MEMORY_ENGINE_DATA.loadState();
  assert(state.tables.global_state.length === 1 && state.tables.global_state[0].current_location === '黑礁湾', '全局状态表应写入唯一行');
  assert(state.tables.protagonist_info.length === 1 && state.tables.protagonist_info[0].name === '沈鹤亭', '主角信息表应写入唯一行');
  assert(state.tables.important_characters[0].name === '苏明月', '重要角色表应写入');
  assert(state.tables.protagonist_skills[0].skill_name === '听潮', '主角技能表应写入');
  assert(state.tables.inventory[0].item_name === '断潮剑', '背包物品表应写入');
  assert(state.tables.quests_events[0].quest_name === '修复断潮剑', '任务与事件表应写入');
  assert(state.tables.chronicle[0].code_index === 'AM0001', '纪要表应生成 AM0001');
  assert(injection.includes('<全局状态>') && injection.includes('黑礁湾'), '应注入全局状态');
  assert(injection.includes('<主角技能>') && injection.includes('听潮'), '应注入主角技能');
  assert(injection.includes('<背包物品>') && injection.includes('断潮剑'), '应注入背包物品');
  assert(MEMORY_ENGINE.buildWorldEngineContext().includes('修复断潮剑'), '世界引擎上下文应包含进行中任务');

  // 3. 增量合并：按主键原地更新（空字段保留原值）与删除（delete）
  chat.push(
    { is_user: true, name: '玩家', mes: '嘉宁三十年正月十六，沈鹤亭使用玄铁修复断潮剑。' },
    { is_user: false, name: '角色', mes: '断潮剑修复完成，任务完结。' }
  );
  apiResponse = JSON.stringify({
    global_state: { elapsed_time: '1天', cur_time: '嘉宁三十年正月十六 10:00' },
    protagonist_info: null,
    important_characters: {
      upsert: [{ name: '苏明月', presence_status: '离场', location_name: '听潮阁' }],
      delete: []
    },
    protagonist_skills: { upsert: [], delete: [] },
    inventory: {
      upsert: [{ item_name: '断潮剑', quantity: '', description: '剑身已用玄铁修复完好', category: '' }],
      delete: []
    },
    quests_events: { upsert: [], delete: ['修复断潮剑'] },
    chronicle: {
      code_index: 'AM0002',
      summary: '玄铁重铸断潮剑',
      chronicle_text: '断潮剑以玄铁修复完好，苏明月先行返回听潮阁。'
    }
  });
  await MEMORY_ENGINE.manualExtract();
  state = MEMORY_ENGINE_DATA.loadState();
  assert(state.tables.global_state[0].current_location === '黑礁湾', '单行表未变字段应保留原值');
  assert(state.tables.global_state[0].cur_time === '嘉宁三十年正月十六 10:00', '单行表变动字段应更新');
  assert(state.tables.important_characters[0].brief_intro === '听潮阁执事', '角色空字段应保留原值');
  assert(state.tables.important_characters[0].presence_status === '离场', '角色状态应更新为离场');
  assert(state.tables.inventory.length === 1 && state.tables.inventory[0].category === '武器' && state.tables.inventory[0].description.includes('玄铁修复'), '同主键物品应原地合并并保留未变列');
  assert(state.tables.quests_events.length === 0, 'delete 列表应删除已完结任务');
  assert(state.tables.chronicle.length === 2 && state.tables.chronicle[1].code_index === 'AM0002', '纪要编号应递增为 AM0002');

  // 4. 超长文本完整保留不重试 + 黑名单过滤
  chat.push(
    { is_user: true, name: '玩家', mes: '翌日继续记录长事件。' },
    { is_user: false, name: '角色', mes: '这是一段需要完整保留的长事件。' }
  );
  WORLD_ENGINE_STORE.setItem('memory_engine_settings', JSON.stringify({
    apiAutoRetries: 0, tableFillMaxRetries: 2, nameBlacklist: '屏蔽角色\n屏蔽物品'
  }));
  const longDesc = '事'.repeat(240);
  apiResponse = JSON.stringify({
    important_characters: {
      upsert: [
        { name: '屏蔽角色', brief_intro: '不应入库' },
        { name: '陆游侠', brief_intro: '过路刀客', presence_status: '在场' }
      ],
      delete: []
    },
    inventory: {
      upsert: [
        { item_name: '屏蔽物品', quantity: '1', description: '不应入库' },
        { item_name: '断潮剑', description: longDesc }
      ],
      delete: []
    },
    chronicle: { chronicle_text: '超长纪要记录：' + longDesc }
  });
  const callsBefore = apiCalls;
  await MEMORY_ENGINE.manualExtract();
  assert(apiCalls === callsBefore + 1, '合法超长文本不得触发额外重试');
  state = MEMORY_ENGINE_DATA.loadState();
  assert(!state.tables.important_characters.some(c => c.name === '屏蔽角色'), '黑名单角色应被忽略');
  assert(state.tables.important_characters.some(c => c.name === '陆游侠'), '非黑名单角色应照常入库');
  assert(!state.tables.inventory.some(i => i.item_name === '屏蔽物品'), '黑名单物品应被忽略');
  assert(state.tables.inventory.find(i => i.item_name === '断潮剑').description === longDesc, '超长描述应完整保留');

  console.log('memory-engine entity tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
