/**
 * 生成演示数据，方便第一次打开时就能看到完整界面。
 *
 * 用法：node scripts/seed-demo.cjs
 * 数据写入 RW_DATA_DIR（默认为项目下的 data/ 目录）。
 * 想区分演示数据与正式数据，可先设 RW_DATA_DIR 指向别的目录。
 */

const path = require('node:path');
const { Store } = require('../electron/store.cjs');

const ROOT = process.env.RW_DATA_DIR
  ? path.resolve(process.env.RW_DATA_DIR)
  : path.join(__dirname, '..', 'data');

const store = new Store(ROOT);
console.log('数据目录：', store.root);

/* ── 克苏鲁的呼唤 7 版 ── */

const coc = store.createCampaign({
  name: '阿卡姆之夜',
  system: 'coc7',
  description: '1928 年，一群调查员受雇调查失踪的古董商，线索指向阿卡姆郊外的一座废弃农庄。',
});
const cocSession = store.createSession(coc.id, { name: '第一夜：失踪的古董商' });

const cocSheet = {
  name: '亨利·阿米蒂奇', occupation: '古物学者', age: 42, gender: '男',
  residence: '波士顿', birthPlace: '塞勒姆',
  attributes: { str: 45, con: 55, siz: 60, dex: 50, app: 50, int: 80, pow: 65, edu: 85 },
  luck: 55,
  state: { hp: null, mp: null, san: null, luck: null, mythos: 2 },
  skills: {
    会计: 35, 人类学: 21, 估价: 45, 考古学: 51, 取悦: 15, 攀爬: 20,
    计算机使用: 5, 信用评级: 60, 克苏鲁神话: 2, 乔装: 5, 闪避: 25,
    汽车驾驶: 20, 电气维修: 10, 电子学: 1, 话术: 5, '格斗（斗殴）': 25,
    '射击（手枪）': 45, '射击（步枪/霰弹枪）': 25, 急救: 30, 历史: 55, 恐吓: 15,
    跳跃: 20, 母语: 85, '外语（拉丁语）': 41, 法律: 25, 图书馆使用: 70,
    聆听: 45, 锁匠: 1, 机械维修: 10, 医学: 1, 博物学: 30, 导航: 10,
    神秘学: 45, 操作重型机械: 1, 说服: 40, 精神分析: 21, 心理学: 50,
    骑术: 5, '科学（生物学）': 21, 妙手: 10, 侦察: 55, 潜行: 40,
    生存: 10, 游泳: 20, 投掷: 20, 追踪: 30, 潜水: 1, 爆破: 1, 读唇: 1, 催眠: 1, 炮术: 1,
  },
  weapons: [
    { name: '.38 左轮手枪', damage: '1d10', range: '15 码', note: '6 发装填' },
    { name: '折叠刀', damage: '1d4+DB', range: '接触', note: '' },
  ],
  gear: '笔记本与钢笔、怀表、阿司匹林、手电筒、密斯卡托尼克大学图书馆借书证',
  background: {
    description: '身材瘦高，戴圆框眼镜，风衣口袋里永远塞满便签纸。',
    belief: '任何现象都有其可被记录与解释的规律——哪怕那规律令人作呕。',
    significantPeople: '导师：密斯卡托尼克大学的埃弗里特教授。',
    meaningfulLocations: '大学图书馆的地下书库。',
    treasuredPossessions: '亡妻留下的一枚银质怀表。',
    traits: '刨根问底，越是被劝阻越要一探究竟。',
    injuries: '左腿旧伤，长时间奔跑后需要休息。',
    phobias: '密闭空间（幽闭恐惧）。',
    arcaneTomes: '《格拉基启示录》残页（未通读）。',
  },
  notes: '调查员编号 A-01。',
};

const cocChar = store.saveCharacter(coc.id, {
  name: cocSheet.name, system: 'coc7', data: cocSheet,
}, { sessionId: cocSession.id });

store.saveCharacter(coc.id, {
  name: '玛格丽特·凯恩', system: 'coc7',
  data: {
    ...structuredClone(cocSheet),
    name: '玛格丽特·凯恩', occupation: '私家侦探', age: 33, gender: '女',
    attributes: { str: 55, con: 60, siz: 55, dex: 75, app: 65, int: 70, pow: 60, edu: 65 },
    luck: 70,
    state: { hp: null, mp: null, san: null, luck: null, mythos: 0 },
    skills: { ...cocSheet.skills, 侦察: 75, 聆听: 65, 心理学: 70, 潜行: 60, '射击（手枪）': 60, 恐吓: 45, 说服: 55, 图书馆使用: 40 },
    weapons: [{ name: '柯尔特 M1911', damage: '1d10+2', range: '15 码', note: '' }],
    notes: '调查员编号 A-02。',
  },
}, { sessionId: cocSession.id });

/* 一场已发生的判定流水 */
const cocRolls = [
  { t: '图书馆使用 检定', d: '1d100 = 23 · 目标 图书馆使用 70（困难 35 / 极难 14） · 难度：常规 · 结果：困难成功', s: 'KJ3M9PQ2RT5V' },
  { t: '侦察 检定', d: '1d100 = 77 · 目标 侦察 55（困难 27 / 极难 11） · 难度：常规 · 结果：失败', s: 'WD7H2NK4YX8B' },
  { t: '理智 检定', d: '1d100 = 91 · 目标 理智 63（困难 31 / 极难 12） · 难度：常规 · 结果：失败', s: 'BQ5R8TM3ZP6L' },
  { t: '话术 检定（孤注一掷）', d: '1d100 = 12 · 目标 话术 45（困难 22 / 极难 9） · 难度：常规 · 结果：极难成功', s: 'NV6Y4KQ9WS2D' },
];
for (const r of cocRolls) {
  store.appendEvents(coc.id, cocSession.id, [{
    type: 'roll', actor: cocChar.id, actorName: cocSheet.name,
    title: r.t, detail: r.d, seed: r.s,
    data: { system: 'coc7', kind: 'check', seed: r.s },
  }]);
}
store.appendEvents(coc.id, cocSession.id, [{
  type: 'scene', title: '抵达废弃农庄',
  detail: '雨夜。农庄的谷仓门虚掩着，里面飘出消毒水与腐肉混合的气味。院里的泥土有新鲜翻动过的痕迹。',
}]);
store.appendEvents(coc.id, cocSession.id, [{
  type: 'note', title: '线索：地窖入口藏在谷仓饲料槽下方',
  detail: '玩家通过「侦察」困难成功发现了暗门；玛格丽特记下了墙角的一串脚印——不是人类的尺码。',
}]);

/* ── DND 5e ── */

const dnd = store.createCampaign({
  name: '灰鹰地窟',
  system: 'dnd5e',
  description: '一支四人小队深入灰鹰山下的废弃矿坑，寻找失踪的矿工与传说中的秘银矿脉。',
});
const dndSession = store.createSession(dnd.id, { name: '第一回：矿坑入口' });

const dndChar = store.saveCharacter(dnd.id, {
  name: '塞拉菲娜', system: 'dnd5e',
  data: {
    name: '塞拉菲娜', player: '小雨', race: '高等精灵', className: '法师', level: 5,
    backgroundName: '智者', alignment: '中立善良',
    abilities: { str: 8, dex: 16, con: 14, int: 18, wis: 12, cha: 10 },
    proficiency: { skills: ['arcana', 'history', 'investigation', 'perception'], saves: ['int', 'wis'], expertise: [] },
    combat: {
      hpMax: 32, hp: 27, tempHp: 0, hitDice: '5d6', hitDiceUsed: 1,
      armorBase: 12, dexCap: null, shield: 0, miscAC: 0, speed: 30, deathSuccess: 0, deathFail: 0,
    },
    spell: { ability: 'int', slotsUsed: { 1: 2 }, prepared: '魔法飞弹、护盾、火球术、侦测魔法', notes: '' },
    weapons: [
      { name: '火焰法杖', damage: '1d6', note: '可施放燃烧之手' },
      { name: '匕首', damage: '1d4+3', note: '' },
    ],
    gear: '法术书、材料包、精灵斗篷、旅者服装、50 尺绳索、治疗药水 ×2、127 金币',
    features: '奥术恢复、法术塑造、精灵血统（魅惑免疫、无需睡眠）、黑暗视觉 60 尺',
    notes: '',
  },
}, { sessionId: dndSession.id });

const dndRolls = [
  { t: '察觉检定', d: 'd20 = 17 · 察觉 +4 · 总计 21 · DC 15 · 结果：成功', s: 'QT9W3EM6RB1N' },
  { t: '调查检定（优势）', d: 'd20 优势 [8, 19] 取高 19 · 调查 +7 · 总计 26 · DC 20 · 结果：成功', s: 'HF4P7ZK2XM5C' },
  { t: '智力豁免', d: 'd20 = 6 · 智力豁免 +7 · 总计 13 · DC 15 · 结果：失败', s: 'LA8D3NV7UY9Q' },
];
for (const r of dndRolls) {
  store.appendEvents(dnd.id, dndSession.id, [{
    type: 'roll', actor: dndChar.id, actorName: '塞拉菲娜',
    title: r.t, detail: r.d, seed: r.s,
    data: { system: 'dnd5e', kind: 'check', seed: r.s },
  }]);
}

/* ── 匕首心 ── */

const dh = store.createCampaign({
  name: '裂谷之下',
  system: 'daggerheart',
  description: '希望与恐惧在裂谷边缘拉锯。英雄们必须先弄清楚：是什么在夜里敲打城门的铰链。',
});
const dhSession = store.createSession(dh.id, { name: '第一幕：敲门的東西' });

const dhChar = store.saveCharacter(dh.id, {
  name: '莉安·半月', system: 'daggerheart',
  data: {
    name: '莉安·半月', pronouns: '她', className: '战士', subclass: '勇者之召', level: 1,
    ancestry: '人类', community: '高地人',
    traits: { agility: 1, strength: 2, finesse: 0, instinct: 0, presence: -1, knowledge: 1 },
    evasionBase: 11, armorName: '皮甲', armorScore: 3, armorEvasion: 0,
    majorThreshold: 6, severeThreshold: 13,
    hpMax: 6, hpMarked: 2, stressMax: 6, stressMarked: 1,
    armorSlotsMax: 3, armorMarked: 1, hope: 3, fear: 2,
    experiences: [
      { name: '边境守卫', mod: 2 },
      { name: '读懂人心', mod: 2 },
      { name: '野外求生', mod: 2 },
      { name: '', mod: 2 },
    ],
    weapons: [
      { name: '双手大剑', damage: '2d10', trait: '力量', note: '近战 · 双手' },
      { name: '手斧', damage: '1d8', trait: '力量', note: '近战 · 可投掷' },
    ],
    domainCards: ['利刃：破阵斩', '骸骨：不屈', '利刃：猛击'],
    inventory: '冒险者行囊、磨刀石、家族徽记、3 枚金币、干粮 5 份',
    notes: '',
  },
}, { sessionId: dhSession.id });

const dhRolls = [
  { t: '力量判定（优势）', d: '希望骰 11 + 恐惧骰 4 = 15 · 属性 +2 · 优势 d6 = +5 · 总计 22 · 难度 14 · 结果：成功（带希望）', s: 'ZP2M8QK4VX7W' },
  { t: '直觉判定', d: '希望骰 3 + 恐惧骰 10 = 13 · 属性 +0 · 总计 13 · 难度 15 · 结果：失败（带恐惧）', s: 'RN5T9WB3HC6J' },
  { t: '敏捷判定（反应）', d: '希望骰 8 + 恐惧骰 8 = 16 · 双骰同点：自动成功并获额外好处、+1 希望、清除 1 点压力', s: 'YE4K7DS2UM8A' },
];
for (const r of dhRolls) {
  store.appendEvents(dh.id, dhSession.id, [{
    type: 'roll', actor: dhChar.id, actorName: '莉安·半月',
    title: r.t, detail: r.d, seed: r.s,
    data: { system: 'daggerheart', kind: 'check', seed: r.s },
  }]);
}
store.appendEvents(dh.id, dhSession.id, [{
  type: 'combat', actor: dhChar.id, actorName: '莉安·半月',
  title: '受到伤害 9 → 重伤（2 HP）',
  detail: '伤害 9 对比阈值 6 / 13 · 严重程度：重伤（2 点 HP） · 标记 1 个护甲槽 → 降为轻微（1 点 HP）',
}]);
store.appendEvents(dh.id, dhSession.id, [{
  type: 'scene', title: '城门前的对峙',
  detail: '凌晨三刻。敲击声又响起，这次是七下。莉安举着火把走到门后——门缝里塞进来一片湿漉漉的、覆着青苔的鳞片。',
}]);

/* ── 汇总 ── */

console.log('\n已生成演示数据：');
for (const c of store.listCampaigns()) {
  const s = store.stats(c.id);
  console.log(`  · ${c.name.padEnd(10, '　')} [${c.system}]  角色 ${s.characters} · 场次 ${s.sessions} · 事件 ${s.events}`);
}
console.log('\n直接运行 npm start 即可看到以上内容。');
