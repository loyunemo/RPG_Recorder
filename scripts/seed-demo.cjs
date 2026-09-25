/**
 * 生成演示数据，方便第一次打开时就能看到完整界面。
 *
 * 用法：node scripts/seed-demo.cjs
 * 数据写入 RW_DATA_DIR（默认为项目下的 data/ 目录）。
 * 想区分演示数据与正式数据，可先设 RW_DATA_DIR 指向别的目录。
 *
 * 演示内容里特意留了一场**进行中的战斗**（见文件末尾的 DEMO_BATTLE），
 * 每个参战者都声明过行动、且已经用掉了一个主要动作 ——
 * 打开「灰鹰地窟」就能直接看到行动条怎么用，不用先自己配。
 */

const path = require('node:path');
const { Store } = require('../electron/store.cjs');

const ROOT = process.env.RW_DATA_DIR
  ? path.resolve(process.env.RW_DATA_DIR)
  : path.join(__dirname, '..', 'data');

const store = new Store(ROOT);
console.log('数据目录：', store.root);

/* ── 演示用的行动 ──
 * 与各规则集 src/core/rulesets/* 里的 actionPresets 对应。
 * 这里写死不引 ESM 预设，是为了让种子脚本保持纯同步；
 * 数值与预设同源，改了预设这里不跟也不会坏 —— 演示角色本来就可以随便改。
 */
let actSeq = 0;
const act = (name, kind, target, check, damage, note) => ({
  id: `act_demo${++actSeq}`,
  name, kind, target,
  check: check || {},
  damage: damage || '',
  cost: {},
  note: note || '',
});

const DEMO_ACTIONS = {
  coc7: [
    act('格斗攻击', 'action', 'enemy', { targetKey: 'skill:格斗（斗殴）', difficulty: 'regular' }, '1d3+DB', '近身肉搏，伤害加值取自 STR+SIZ'),
    act('手枪射击', 'action', 'enemy', { targetKey: 'skill:射击（手枪）' }, '1d10', '射程内单发射击'),
    act('闪避', 'reaction', 'self', { targetKey: 'skill:闪避' }, '', '被攻击时与之对抗'),
    act('侦察', 'action', 'none', { targetKey: 'skill:侦察' }),
    act('理智检定', 'reaction', 'self', { targetKey: 'san' }, '', '目击可怖之物时'),
  ],
  dnd5e: [
    act('攻击', 'action', 'enemy', { targetKey: 'ability:str' }, '1d8+STR', '用长剑等力量武器攻击'),
    act('施法', 'action', 'enemy', { targetKey: 'spellAttack' }, '', '施放一个法术'),
    act('闪避', 'action', 'self', '', '', '本回合针对你的攻击具有劣势'),
    act('附赠：二次攻击', 'bonus', 'enemy', { targetKey: 'ability:str' }, '1d8+STR'),
    act('借机攻击', 'reaction', 'enemy', { targetKey: 'ability:str' }, '1d8+STR'),
  ],
  daggerheart: [
    act('攻击判定', 'action', 'enemy', { targetKey: 'trait:strength' }, '1d8'),
    act('施法判定', 'action', 'enemy', { targetKey: 'spellcast' }),
    act('反应判定', 'reaction', 'self', { targetKey: 'trait:instinct' }),
    act('全力一击', 'action', 'enemy', '', '2d8'),
  ],
  huazhu: [
    act('运炁（斗气）', 'action', 'enemy', { targetKey: 'trait:strength' }, '1d10'),
    act('御剑', 'action', 'enemy', { targetKey: 'trait:finesse' }, '1d8'),
    act('观气', 'action', 'none', { targetKey: 'trait:instinct' }),
    act('反应判定', 'reaction', 'self', { targetKey: 'trait:instinct' }),
  ],
};

/** 给一份角色数据挂上该系统的演示行动（已经有了就不动） */
const withActions = (data, system) => {
  if (!data.actions || !data.actions.length) data.actions = DEMO_ACTIONS[system].map(a => ({ ...a }));
  return data;
};

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
  name: cocSheet.name, system: 'coc7', data: withActions(cocSheet, 'coc7'),
}, { sessionId: cocSession.id });

store.saveCharacter(coc.id, {
  name: '玛格丽特·凯恩', system: 'coc7',
  data: withActions({
    ...structuredClone(cocSheet),
    name: '玛格丽特·凯恩', occupation: '私家侦探', age: 33, gender: '女',
    attributes: { str: 55, con: 60, siz: 55, dex: 75, app: 65, int: 70, pow: 60, edu: 65 },
    luck: 70,
    state: { hp: null, mp: null, san: null, luck: null, mythos: 0 },
    skills: { ...cocSheet.skills, 侦察: 75, 聆听: 65, 心理学: 70, 潜行: 60, '射击（手枪）': 60, 恐吓: 45, 说服: 55, 图书馆使用: 40 },
    weapons: [{ name: '柯尔特 M1911', damage: '1d10+2', range: '15 码', note: '' }],
    notes: '调查员编号 A-02。',
  }, 'coc7'),
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
  data: withActions({
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
  }, 'dnd5e'),
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

// 用官方车卡数据填充演示角色，顺便验证血统 / 社群 / 领域卡确实接通了
const dhDemo = (() => {
  try {
    const rules = require(path.join(__dirname, '..', 'src', 'core', 'rulesets', 'daggerheart', 'data', 'classes.json'));
    const anc = require(path.join(__dirname, '..', 'src', 'core', 'rulesets', 'daggerheart', 'data', 'ancestries.json'));
    const com = require(path.join(__dirname, '..', 'src', 'core', 'rulesets', 'daggerheart', 'data', 'communities.json'));
    const dom = require(path.join(__dirname, '..', 'src', 'core', 'rulesets', 'daggerheart', 'data', 'domains.json'));

    const cls = rules.classes.find(c => c.name === '战士') || rules.classes[0];
    const pick = (name) => dom.cards.find(c => c.domain === name && c.level === 1);
    const cards = (cls.domains || [])
      .map(d => pick(d))
      .filter(Boolean)
      .map(c => ({ name: c.name, domain: c.domain, level: c.level, text: c.text }));

    return {
      className: cls.name,
      subclass: cls.subclasses[0]?.name || '',
      ancestry: anc.ancestries[0]?.name || '',
      community: com.communities[0]?.name || '',
      evasionBase: cls.evasion,
      hpMax: cls.hp,
      classItems: cls.classItems,
      domainCards: cards,
    };
  } catch (err) {
    console.warn('  （匕首心数据未构建，演示角色改用最小字段：' + err.message + '）');
    return null;
  }
})();

const dhChar = store.saveCharacter(dh.id, {
  name: '莉安·半月', system: 'daggerheart',
  data: withActions({
    name: '莉安·半月', pronouns: '她', level: 1,
    className: dhDemo?.className ?? '战士',
    subclass: dhDemo?.subclass ?? '勇气呼唤',
    ancestry: dhDemo?.ancestry ?? '人类',
    community: dhDemo?.community ?? '高城之民',
    traits: { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 },
    evasionBase: dhDemo?.evasionBase ?? 11, armorName: '皮甲', armorScore: 3, armorEvasion: 0,
    majorThreshold: 6, severeThreshold: 13,
    hpMax: dhDemo?.hpMax ?? 6, hpMarked: 2, stressMax: 6, stressMarked: 1,
    armorSlotsMax: 3, armorMarked: 1, hope: 2, fear: 2,
    experiences: [
      { name: '边境守卫', mod: 2 },
      { name: '读懂人心', mod: 2 },
      { name: '', mod: 2 },
      { name: '', mod: 2 },
    ],
    weapons: [
      { name: '双手大剑', damage: '2d10', trait: '力量', note: '近战 · 双手' },
      { name: '手斧', damage: '1d8', trait: '力量', note: '近战 · 可投掷' },
    ],
    domainCards: dhDemo?.domainCards ?? [],
    inventory: `${dhDemo?.classItems || ''}冒险者行囊、磨刀石、家族徽记、3 枚金币、干粮 5 份`.trim(),
    notes: '',
  }, 'daggerheart'),
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

/* ── 华渚（匕首之心扩展） ── */

const hz = store.createCampaign({
  name: '华渚·问道',
  system: 'huazhu',
  description: '修真与武道并存的东方大陆。一桩灭门案把你们引向昆仑山脚下的废弃道观。',
});
const hzSession = store.createSession(hz.id, { name: '第一幕：青石镇的血案' });

const hzData = (() => {
  try {
    const rules = require(path.join(__dirname, '..', 'src', 'core', 'rulesets', 'huazhu', 'data', 'classes.json'));
    const cls = rules.classes.find(c => c.name === '剑修') || rules.classes[0];
    const sub = cls.subclasses[0];
    return {
      name: '沈青崖', pronouns: '他',
      className: cls.name, subclass: sub.name,
      sectNature: sub.sectNature, spellcastTrait: sub.spellcastTrait,
      domain: cls.domain, level: 3,
      ancestry: '人类（华渚人）', community: '山野村落',
      traits: { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 },
      evasionBase: cls.evasion,
      armorName: '流云衣', armorScore: 4, armorEvasion: 0,
      majorThreshold: 9, severeThreshold: 20,
      hpMax: cls.hp, hpMarked: 2,
      stressMax: 6, stressMarked: 1,
      armorSlotsMax: 4, armorMarked: 1,
      hope: 3, fear: 2,
      experiences: [
        { name: '山野求生', mod: 2 }, { name: '辨认真气', mod: 2 },
        { name: '旧案追查', mod: 2 }, { name: '', mod: 2 },
      ],
      daoHeart: { name: '剑心通明', mod: -2, note: '原文给的是 −2' },
      reputation: 3,
      nineMysteries: ['太虚引'],
      domainCards: [],
      weapons: [
        { name: '青崖剑', damage: '1d10+3', trait: '敏捷', range: '近战', note: '本命剑器' },
        { name: '袖箭', damage: '1d8', trait: '灵巧', range: '近距离', note: '暗器' },
      ],
      inventory: sub.startingItems || '行者行囊、干粮、火折子',
      notes: '剑修门下弟子。',
    };
  } catch (err) {
    console.warn('  （华渚数据未构建，跳过角色卡：' + err.message + '）');
    return null;
  }
})();

const hzChar = hzData ? store.saveCharacter(hz.id, {
  name: hzData.name, system: 'huazhu', data: withActions(hzData, 'huazhu'),
}, { sessionId: hzSession.id }) : null;

if (hzChar) {
  for (const r of [
    { t: '青崖剑 攻击判定', d: '希望骰 10 + 恐惧骰 3 = 13 · 属性 +2 · 总计 15 · 难度 12 · 结果：成功（带希望）', s: 'HZ7K2M9QW4RT' },
    { t: '知识判定（辨识古篆）', d: '希望骰 2 + 恐惧骰 11 = 13 · 属性 −1 · 总计 12 · 难度 15 · 结果：失败（带恐惧）', s: 'HZ3P8NV5YX2B' },
    { t: '敏捷判定（反应）', d: '希望骰 6 + 恐惧骰 6 = 12 · 双骰同点：自动成功并获额外好处、+1 希望、清除 1 点压力', s: 'HZ9D4WM7UQ1E' },
  ]) {
    store.appendEvents(hz.id, hzSession.id, [{
      type: 'roll', actor: hzChar.id, actorName: hzData.name,
      title: r.t, detail: r.d, seed: r.s,
      data: { system: 'huazhu', kind: 'check', seed: r.s },
    }]);
  }
  store.appendEvents(hz.id, hzSession.id, [{
    type: 'scene', title: '抵达青石镇',
    detail: '镇口的告示牌上贴着三张画像，都被雨水泡烂了。客栈掌柜说，出事那晚「天上没有月亮，可井里有光」。',
  }]);
  store.appendEvents(hz.id, hzSession.id, [{
    type: 'roll', actor: hzChar.id, actorName: '主持人',
    title: '暗骰：道观里的东西是否察觉你们',
    detail: '1d100 = 23 · 未察觉',
    visibility: 'gm',
    seed: 'HZSECRET0001',
  }]);
}

/* ── 一场进行中的战斗（演示「行动系统」） ──
 *
 * 这是刻意留下的**唯一**一个进行中战斗：打开「灰鹰地窟 → 战斗」就能看到
 * 行动条长什么样 —— 当前行动者的行动按行动经济分组，用掉的那一类已经置灰。
 * 所有参战者（PC 与 NPC）都声明过行动，不会有人轮到时空转。
 */

let npcSeq = 0;
const demoNpc = (name, hp, ac, init, actions, extra = {}) => ({
  // 中文名字滤掉非 ASCII 后会变成空串，所以序号必须自己带
  id: `cb_demo_npc${++npcSeq}`,
  name, kind: 'npc', refId: null,
  initiative: init,
  hp, maxHp: hp,
  defenseLabel: 'AC', defense: ac,
  conditions: extra.conditions || '',
  note: extra.note || '',
  defeated: !!extra.defeated,
  actions: actions.map(a => ({ ...a })),
  // NPC 的判定数据用规则集默认值；这里直接摆一份最小可用的 D&D 数据
  data: {
    name,
    abilities: { str: 12, dex: 14, con: 12, int: 8, wis: 10, cha: 8 },
    proficiency: { skills: [], saves: [], expertise: [] },
    level: 1,
    combat: { hpMax: hp, hp, tempHp: 0, hitDice: '1d8', armorBase: ac, shield: 0, miscAC: 0, speed: 30, deathSuccess: 0, deathFail: 0 },
    actions: actions.map(a => ({ ...a })),
    ...extra.data,
  },
});

const goblinActions = [
  act('弯刀劈砍', 'action', 'enemy', { targetKey: 'ability:str' }, '1d6+1', '近战 · 弯刀'),
  act('短弓射击', 'action', 'enemy', { targetKey: 'ability:dex' }, '1d6+2', '远程 · 80/320 尺'),
  act('撤离', 'bonus', 'self', '', '', '附赠动作：脱离近战而不引发借机攻击'),
];

const bossActions = [
  act('巨斧劈砍', 'action', 'enemy', { targetKey: 'ability:str' }, '1d12+2', '近战 · 巨斧'),
  act('威吓咆哮', 'action', 'area', { targetKey: 'ability:cha' }, '', '范围内敌人做感知豁免，失败则恐慌'),
  act('格挡', 'reaction', 'self', '', '', '被击中时用反应减少 1d10 伤害'),
];

const DEMO_BATTLE = {
  active: true,
  round: 1,
  turnIndex: 0,
  combatants: [
    {
      id: 'cb_demo_serafina',
      name: '塞拉菲娜', kind: 'pc', refId: dndChar.id,
      initiative: 19,
      hp: 27, maxHp: 32,
      defenseLabel: 'AC', defense: 15,
      conditions: '', note: '',
      defeated: false,
      actions: [],
    },
    demoNpc('哥布林头目', 21, 17, 16, bossActions),
    demoNpc('哥布林 A', 7, 15, 11, goblinActions, {
      defeated: true,
      conditions: '已倒地',
      note: '被塞拉菲娜的魔法飞弹打翻，还剩 0 点生命',
    }),
    demoNpc('哥布林 B', 7, 15, 9, goblinActions),
  ],
  // 塞拉菲娜这一回合已经用掉了主要动作，所以「攻击」按钮是置灰的
  used: { cb_demo_serafina: { action: true } },
};

store.saveState(dnd.id, { combat: DEMO_BATTLE });

for (const e of [
  {
    type: 'combat', actor: dndChar.id, actorName: '塞拉菲娜',
    title: '战斗开始',
    detail: '1. 塞拉菲娜（先攻 19）\n2. 哥布林头目（先攻 16）\n3. 哥布林 A（先攻 11）\n4. 哥布林 B（先攻 9）',
  },
  {
    type: 'combat', actor: dndChar.id, actorName: '塞拉菲娜',
    title: '战斗开始 · 掷先攻',
    detail: '塞拉菲娜 18 + 1 = 19\n哥布林头目 16\n哥布林 A 11\n哥布林 B 9',
  },
]) store.appendEvents(dnd.id, dndSession.id, [e]);

store.appendEvents(dnd.id, dndSession.id, [{
  type: 'combat', actor: dndChar.id, actorName: '塞拉菲娜',
  title: '塞拉菲娜 使用【施法】 → 哥布林 A',
  detail: [
    '目标：哥布林 A（AC 15）',
    '行动经济：主要动作',
    '施放一个法术',
    'd20 = 16 · 法术攻击 +7 · 总计 23 · DC 15 · 结果：成功',
    '伤害 3d4+4 = 13',
  ].join('\n'),
  seed: 'DEMOBATTLE001',
  data: {
    kind: 'action',
    action: { name: '施法', kind: 'action', target: 'enemy', check: { targetKey: 'spellAttack' }, damage: '3d4+4', cost: {}, note: '魔法飞弹' },
    result: { roll: 16, total: 23, dc: 15, success: true },
    damage: { ok: true, expr: '3d4+4', total: 13 },
  },
}]);

store.appendEvents(dnd.id, dndSession.id, [{
  type: 'combat', actor: null, actorName: null,
  title: '哥布林 A 受到伤害 13 点',
  detail: '生命值 0/7（已倒地）',
  tags: ['伤害'],
}]);

store.appendEvents(dnd.id, dndSession.id, [{
  type: 'combat', actor: null, actorName: null,
  title: '哥布林 A 倒地',
  detail: '剩余生命 0/7',
}]);

store.appendEvents(dnd.id, dndSession.id, [{
  type: 'combat', actor: dndChar.id, actorName: '塞拉菲娜',
  title: '塞拉菲娜 使用【附赠：二次攻击】 → 哥布林头目',
  detail: [
    '目标：哥布林头目（AC 17）',
    '行动经济：附赠动作',
    'd20 = 4 · 力量检定 +2 · 总计 6 · DC 17 · 结果：失败',
  ].join('\n'),
  seed: 'DEMOBATTLE002',
  data: {
    kind: 'action',
    action: { name: '附赠：二次攻击', kind: 'bonus', target: 'enemy', check: { targetKey: 'ability:str' }, damage: '1d8+STR', cost: {}, note: '' },
    result: { roll: 4, total: 6, dc: 17, success: false },
    damage: null,
  },
}]);

store.appendEvents(dnd.id, dndSession.id, [{
  type: 'scene', title: '矿坑第一层：塌方的岔道',
  detail: '支撑木已经朽了，头顶不断落下细沙。哥布林把俘虏拖进了左边的深坑——地上拖行的血迹还很新鲜。',
}]);

store.appendEvents(dnd.id, dndSession.id, [{
  type: 'note', title: '提示：战斗中的判定只能按已声明的行动来',
  detail: '演示战斗里每个人的行动都声明好了。用掉的那一类行动经济会置灰，点「下一回合」刷新；'
    + '倒地的参战者会被自动跳过。要自由掷骰（伤害、暗骰）用「判定」页下方的自由骰式。',
}]);

/* ── 汇总 ── */

console.log('\n已生成演示数据：');
for (const c of store.listCampaigns()) {
  const s = store.stats(c.id);
  console.log(`  · ${c.name.padEnd(10, '　')} [${c.system}]  角色 ${s.characters} · 场次 ${s.sessions} · 事件 ${s.events}`);
}
console.log('\n直接运行 npm start 即可看到以上内容。');
console.log('「灰鹰地窟 → 战斗」里留了一场进行中的示范战斗，每个参战者都声明过行动，');
console.log('当前行动者塞拉菲娜的主要动作已经用掉（按钮置灰），点「下一回合 →」就能看到它刷新。');
