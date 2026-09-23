/**
 * 匕首心（Daggerheart）规则适配层。
 *
 * 判定核心：双重骰（Duality Dice）—— 掷 2 个 d12，一为希望骰、一为恐惧骰，
 * 两者相加再加属性调整值，与难度（或目标闪避）比较；两骰同点为会心一击。
 *
 * 护甲与阈值数据来自 Daggerheart System Reference Document 1.0
 * （© Critical Role, LLC.，依 Darrington Press Community Gaming License 使用）。
 */

import { validator, makeBudgets } from '../creation.js';
import classesData from './daggerheart/data/classes.gen.js';
import ancestriesData from './daggerheart/data/ancestries.gen.js';
import communitiesData from './daggerheart/data/communities.gen.js';
import domainsData from './daggerheart/data/domains.gen.js';
import sourceData from './daggerheart/data/source.gen.js';

export const DH_TRAITS = [
  { key: 'agility', label: '敏捷', abbr: 'AGI' },
  { key: 'strength', label: '力量', abbr: 'STR' },
  { key: 'finesse', label: '灵巧', abbr: 'FIN' },
  { key: 'instinct', label: '直觉', abbr: 'INS' },
  { key: 'presence', label: '风度', abbr: 'PRE' },
  { key: 'knowledge', label: '知识', abbr: 'KNO' },
];

/** 起始属性分配：+2 / +1 / +1 / 0 / 0 / −1 */
export const DH_TRAIT_ARRAY = [2, 1, 1, 0, 0, -1];

/** 基础护甲表（阈值 = 重伤 / 致命，分数 = 护甲槽数量） */
export const DH_ARMORS = [
  { name: '棉甲', tier: 1, major: 5, severe: 11, score: 3, evasion: 1, feature: '灵活：闪避 +1' },
  { name: '皮甲', tier: 1, major: 6, severe: 13, score: 3, evasion: 0, feature: '—' },
  { name: '锁子甲', tier: 1, major: 7, severe: 15, score: 4, evasion: -1, feature: '沉重：闪避 −1' },
  { name: '全身板甲', tier: 1, major: 8, severe: 17, score: 4, evasion: -2, feature: '极重：闪避 −2，敏捷 −1' },

  { name: '改良棉甲', tier: 2, major: 7, severe: 16, score: 4, evasion: 1, feature: '灵活：闪避 +1' },
  { name: '改良皮甲', tier: 2, major: 9, severe: 20, score: 4, evasion: 0, feature: '—' },
  { name: '改良锁子甲', tier: 2, major: 11, severe: 24, score: 5, evasion: -1, feature: '沉重：闪避 −1' },
  { name: '改良全身板甲', tier: 2, major: 13, severe: 28, score: 5, evasion: -2, feature: '极重：闪避 −2，敏捷 −1' },
  { name: '埃伦德林链甲', tier: 2, major: 9, severe: 21, score: 4, evasion: 0, feature: '守护：承受魔法伤害时先减去护甲分数' },
  { name: '枯骨甲', tier: 2, major: 9, severe: 21, score: 4, evasion: 0, feature: '坚韧：标记最后一个护甲槽前掷 d6，出 6 则免标记' },
  { name: '铁树胸甲', tier: 2, major: 9, severe: 20, score: 4, evasion: 0, feature: '强化：标记最后一个护甲槽时阈值 +2' },
  { name: '萝丝薇尔德甲', tier: 2, major: 11, severe: 23, score: 5, evasion: 0, feature: '希望：花费希望时可改为标记护甲槽' },
  { name: '鲁内坦浮空甲', tier: 2, major: 9, severe: 20, score: 4, evasion: 0, feature: '流转：被攻击时可标记护甲槽使该攻击获得劣势' },
  { name: '提里斯软甲', tier: 2, major: 8, severe: 18, score: 5, evasion: 0, feature: '静音：潜行移动 +2' },

  { name: '精制棉甲', tier: 3, major: 9, severe: 23, score: 5, evasion: 1, feature: '灵活：闪避 +1' },
  { name: '精制皮甲', tier: 3, major: 11, severe: 27, score: 5, evasion: 0, feature: '—' },
  { name: '精制锁子甲', tier: 3, major: 13, severe: 31, score: 6, evasion: -1, feature: '沉重：闪避 −1' },
  { name: '精制全身板甲', tier: 3, major: 15, severe: 35, score: 6, evasion: -2, feature: '极重：闪避 −2，敏捷 −1' },
  { name: '锋刃甲', tier: 3, major: 16, severe: 39, score: 6, evasion: 0, feature: '物理：不能标记护甲槽来减免魔法伤害' },
  { name: '龙鳞甲', tier: 3, major: 11, severe: 27, score: 5, evasion: 0, feature: '坚不可摧：每次短休一次，可将最后一点 HP 改为标记压力' },
  { name: '贝拉莫伊精制甲', tier: 3, major: 11, severe: 27, score: 5, evasion: 0, feature: '鎏金：风度 +1' },
  { name: '莫内特斗篷', tier: 3, major: 16, severe: 39, score: 6, evasion: 0, feature: '魔法：不能标记护甲槽来减免物理伤害' },
  { name: '强化符文', tier: 3, major: 17, severe: 43, score: 6, evasion: 0, feature: '痛苦：每次标记护甲槽时须标记 1 点压力' },
  { name: '尖刺板甲', tier: 3, major: 10, severe: 25, score: 5, evasion: 0, feature: '锋利：近战命中后伤害 +d4' },

  { name: '传说棉甲', tier: 4, major: 11, severe: 32, score: 6, evasion: 1, feature: '灵活：闪避 +1' },
  { name: '传说皮甲', tier: 4, major: 13, severe: 36, score: 6, evasion: 0, feature: '—' },
  { name: '传说锁子甲', tier: 4, major: 15, severe: 40, score: 7, evasion: -1, feature: '沉重：闪避 −1' },
  { name: '传说全身板甲', tier: 4, major: 17, severe: 44, score: 7, evasion: -2, feature: '极重：闪避 −2，敏捷 −1' },
  { name: '杜纳米斯丝链', tier: 4, major: 13, severe: 36, score: 7, evasion: 0, feature: '缓时：标记护甲槽，掷 d4 加到闪避上' },
  { name: '烬织甲', tier: 4, major: 13, severe: 36, score: 6, evasion: 0, feature: '灼烧：近战范围内攻击你的敌人标记压力' },
  { name: '全面强化甲', tier: 4, major: 15, severe: 40, score: 4, evasion: 0, feature: '巩固：标记护甲槽时严重程度降低两级' },
  { name: '救主锁子甲', tier: 4, major: 18, severe: 48, score: 8, evasion: 0, feature: '困难：所有属性与闪避 −1' },
  { name: '维里塔斯猫眼石甲', tier: 4, major: 13, severe: 36, score: 6, evasion: 0, feature: '求真：附近生物说谎时发光' },
];

/**
 * 职业数据来自 DHSheet 的卡牌表（派生自官方 SRD 的中文翻译）。
 * 这里保留完整字段；下游用得到的 name / evasion / hp / domains 都在。
 */
export const DH_CLASSES = classesData.classes;

/** 血统：18 个种族，每个 2 条特性 */
export const DH_ANCESTRIES = ancestriesData.ancestries;

/** 社群：9 个，每个 1 条特性 */
export const DH_COMMUNITIES = communitiesData.communities;

/** 领域与领域卡：9 个领域，每个 21 张卡 */
export const DH_DOMAINS = domainsData.domains;
export const DH_DOMAIN_CARDS = domainsData.cards;

/** 数据来源与署名 */
export const DH_DATA_SOURCE = sourceData;

const DH_CLASS_BY_NAME = new Map(DH_CLASSES.map(c => [c.name, c]));

/**
 * 某个职业的两个领域。
 *
 * 入参既接受角色数据对象（界面向导与卡面都是这么调的），
 * 也接受职业名字符串（方便测试与直接查询）。
 * 之前只接受字符串，而界面传的是数据对象，导致领域卡列表恒为空 ——
 * 玩家选不到领域卡，车卡就永远完不成。
 */
export function domainsOfClass(input) {
  const name = typeof input === 'string' ? input : input?.className;
  return DH_CLASS_BY_NAME.get(name)?.domains || [];
}

/** 某个职业的子职业 */
export function subclassesOf(className) {
  return DH_CLASS_BY_NAME.get(className)?.subclasses || [];
}

/** 某个领域下的领域卡，按等级排序 */
export function cardsOfDomain(domainName) {
  return DH_DOMAIN_CARDS
    .filter(c => c.domain === domainName)
    .sort((a, b) => (a.level ?? 99) - (b.level ?? 99));
}

/** 伤害严重程度 */
export function damageSeverity(total, major, severe) {
  if (total >= severe) return 3;
  if (total >= major) return 2;
  return 1;
}

export const SEVERITY_LABEL = { 1: '轻微', 2: '重伤', 3: '致命' };

function createDefault(name = '新英雄') {
  return {
    name,
    pronouns: '',
    className: '战士',
    subclass: '',
    level: 1,
    ancestry: '',
    community: '',
    traits: { agility: 1, strength: 2, finesse: 0, instinct: 0, presence: -1, knowledge: 1 },
    evasionBase: 11,
    armorName: '皮甲',
    armorScore: 3,
    armorEvasion: 0,
    majorThreshold: 6,
    severeThreshold: 13,
    hpMax: 6,
    hpMarked: 0,
    stressMax: 6,
    stressMarked: 0,
    armorSlotsMax: 3,
    armorMarked: 0,
    hope: 2,
    fear: 0,
    experiences: [
      { name: '', mod: 2 }, { name: '', mod: 2 },
      { name: '', mod: 2 }, { name: '', mod: 2 },
    ],
    /** 战斗中可执行的行动 */
    actions: [],
    weapons: [],
    domainCards: [],
    inventory: '',
    notes: '',
  };
}

function derive(data) {
  const evasion = (data.evasionBase ?? 10) + (data.armorEvasion ?? 0);
  const hpMax = data.hpMax ?? 6;
  const stressMax = data.stressMax ?? 6;
  const armorSlotsMax = data.armorSlotsMax ?? 0;

  const tracks = [
    { key: 'hp', label: '生命值', current: hpMax - (data.hpMarked || 0), max: hpMax, tone: 'hp', markStyle: true, marked: data.hpMarked || 0 },
    { key: 'stress', label: '压力', current: stressMax - (data.stressMarked || 0), max: stressMax, tone: 'stress', markStyle: true, marked: data.stressMarked || 0 },
    { key: 'armorSlots', label: '护甲槽', current: armorSlotsMax - (data.armorMarked || 0), max: armorSlotsMax, tone: 'armor', markStyle: true, marked: data.armorMarked || 0 },
    { key: 'hope', label: '希望', current: data.hope ?? 0, max: 6, tone: 'hope' },
    { key: 'fear', label: '恐惧（GM）', current: data.fear ?? 0, max: 12, tone: 'fear' },
  ];

  const stats = [
    { key: 'evasion', label: '闪避', value: evasion },
    { key: 'thresholds', label: '伤害阈值', value: `${data.majorThreshold} / ${data.severeThreshold}` },
    { key: 'armorScore', label: '护甲分数', value: data.armorScore },
    { key: 'level', label: '等级', value: data.level },
  ];

  return { tracks, stats, evasion, hpMax, stressMax, armorSlotsMax };
}

function rollTargets(data) {
  return [
    {
      title: '属性判定',
      items: DH_TRAITS.map(t => ({
        key: `trait:${t.key}`,
        label: `${t.label}（${t.abbr}）`,
        value: data.traits[t.key],
        signed: true,
        versus: true,
        adv: true,
      })),
    },
    {
      title: '其他',
      items: [
        { key: 'spellcast', label: '施法判定', value: 0, signed: true, versus: true, adv: true },
        { key: 'attack', label: '攻击判定（对抗闪避）', value: 0, signed: true, versus: true, adv: true },
      ],
    },
  ];
}

function resolveTrait(data, req) {
  const key = req.targetKey || '';
  if (key.startsWith('trait:')) {
    const k = key.slice(6);
    const t = DH_TRAITS.find(x => x.key === k);
    return { label: t ? t.label : k, mod: data.traits[k] ?? 0 };
  }
  if (key === 'spellcast') return { label: '施法判定', mod: 0 };
  if (key === 'attack') return { label: '攻击判定', mod: 0 };
  return { label: req.targetLabel || '行动判定', mod: req.targetValue ?? 0 };
}

/**
 * 双重骰判定。
 *
 * 规则要点（依 SRD 核实）：
 *   · 达到或超过难度即成功（meets or beats）
 *   · 双骰同点 = 会心一击：自动成功并获得额外好处、+1 希望、清除 1 点压力
 *   · 希望骰更高 → 玩家 +1 希望；恐惧骰更高 → GM +1 恐惧；**失败时同样结算**
 *   · 反应判定（reaction）不产生希望/恐惧
 *   · 自身骰池的优势/劣势各掷 1 个 d6，且一对一抵消；
 *     协助（Help an Ally）掷多个 d6 取最高，属池外来源，可与自身结果叠加
 *
 * @param {object} req { targetKey, targetValue, targetLabel, difficulty, advantage, disadvantage,
 *                       help, rollType, hopeDie, fearDie, reason }
 */
function roll(data, req, rng) {
  const { label, mod } = req.targetKey || req.targetValue != null
    ? resolveTrait(data, req)
    : { label: '行动判定', mod: 0 };

  const hopeDie = req.hopeDie ?? rng.int(1, 12);
  const fearDie = req.fearDie ?? rng.int(1, 12);
  const base = hopeDie + fearDie;

  // 自身骰池：优势与劣势一对一抵消，净额最多 1 个 d6
  const advRaw = Math.max(0, req.advantage || 0);
  const disRaw = Math.max(0, req.disadvantage || 0);
  const net = advRaw - disRaw;
  const poolDie = net !== 0 ? rng.int(1, 6) : 0;
  const poolSigned = net > 0 ? poolDie : net < 0 ? -poolDie : 0;
  const poolLabel = net > 0 ? '优势' : net < 0 ? '劣势' : '';

  // 协助：池外来源，掷 N 个 d6 取最高后相加（不抵消劣势）
  const helpCount = Math.max(0, req.help || 0);
  const helpDice = helpCount > 0 ? Array.from({ length: helpCount }, () => rng.int(1, 6)) : [];
  const helpBonus = helpDice.length ? Math.max(...helpDice) : 0;

  const total = base + mod + poolSigned + helpBonus;
  const critical = hopeDie === fearDie;
  const rollType = req.rollType === 'reaction' ? 'reaction' : 'action';
  const difficulty = req.difficulty ?? null;

  let success = null;
  if (critical) success = true;
  else if (difficulty != null) success = total >= difficulty;

  const duality = hopeDie > fearDie ? 'hope' : fearDie > hopeDie ? 'fear' : 'critical';
  // 会心算作「带希望」，但反应判定不产生希望/恐惧
  const generatesTokens = rollType === 'action';
  const token = !generatesTokens ? null : duality === 'hope' ? 'hope' : duality === 'fear' ? 'fear' : 'hope';

  let outcomeLabel;
  if (critical) outcomeLabel = '会心一击';
  else if (success == null) outcomeLabel = duality === 'hope' ? '带希望' : '带恐惧';
  else if (success) outcomeLabel = duality === 'hope' ? '成功（带希望）' : '成功（带恐惧）';
  else outcomeLabel = duality === 'hope' ? '失败（带希望）' : '失败（带恐惧）';

  const parts = [
    `希望骰 ${hopeDie} + 恐惧骰 ${fearDie} = ${base}`,
    mod ? `属性 ${mod >= 0 ? '+' : ''}${mod}` : '',
    poolDie ? `${poolLabel} d6 = ${poolSigned >= 0 ? '+' : ''}${poolSigned}` : '',
    helpDice.length ? `协助 d6 [${helpDice.join(', ')}] 取最高 +${helpBonus}` : '',
    `总计 ${total}`,
    difficulty != null ? `难度 ${difficulty}` : '',
    critical
      ? '双骰同点：自动成功并获额外好处、+1 希望、清除 1 点压力'
      : rollType === 'reaction'
        ? `结果：${success ? '成功' : '失败'}（反应判定，不产生希望/恐惧）`
        : `结果：${outcomeLabel}`,
  ].filter(Boolean);

  return {
    ok: true,
    kind: 'check',
    system: 'daggerheart',
    title: `${label}${rollType === 'reaction' ? '（反应）' : ''}${poolLabel ? `（${poolLabel}）` : ''}`,
    formula: `2d12${mod ? ` ${mod >= 0 ? '+' : ''}${mod}` : ''}${difficulty != null ? ` vs 难度 ${difficulty}` : ''}`,
    hopeDie,
    fearDie,
    base,
    mod,
    poolDie,
    poolSigned,
    poolLabel,
    helpDice,
    helpBonus,
    total,
    difficulty,
    critical,
    duality,
    dualityLabel: critical ? '会心一击' : duality === 'hope' ? '希望' : '恐惧',
    outcomeLabel,
    token,
    rollType,
    success,
    reason: req.reason || '',
    seed: rng.seed,
    consumed: 2 + (poolDie ? 1 : 0) + helpDice.length,
    detail: parts.join(' · '),
  };
}

/**
 * 伤害结算：把伤害总值对照阈值换算成 HP 标记数。
 * 标记 1 个护甲槽可让严重程度降一级（致命→重伤→轻微→无）。
 * @param {object} req { total, markArmor }
 */
function resolveDamage(data, req) {
  const total = req.total || 0;
  const major = data.majorThreshold;
  const severe = data.severeThreshold;
  const before = damageSeverity(total, major, severe);
  const slotsLeft = (data.armorSlotsMax || 0) - (data.armorMarked || 0);
  const canReduce = !!req.markArmor && (data.armorScore || 0) > 0 && slotsLeft > 0;
  const severity = canReduce ? Math.max(0, before - 1) : before;

  const SEV_DESC = { 0: '无伤', 1: '轻微', 2: '重伤', 3: '致命' };
  const parts = [
    `伤害 ${total} 对比阈值 ${major} / ${severe}`,
    `严重程度：${SEV_DESC[before]}（${before} 点 HP）`,
    canReduce ? `标记 1 个护甲槽 → 降为${SEV_DESC[severity]}（${severity} 点 HP）` : '',
    req.markArmor && !canReduce && (data.armorScore || 0) === 0 ? '护甲分数为 0，无法标记护甲槽' : '',
  ].filter(Boolean);

  return {
    ok: true,
    kind: 'damage',
    system: 'daggerheart',
    title: '伤害结算',
    total,
    severity,
    severityBefore: before,
    severityLabel: SEV_DESC[severity],
    markArmor: canReduce,
    hp: severity,
    detail: parts.join(' · '),
  };
}

/** 先攻：匕首心本身不规定先攻，这里用「1d20 + 敏捷」作为可选的值班方案 */
function initiative(data) {
  const mod = data.traits.agility ?? 0;
  return { kind: 'roll', expr: '1d20', mod, label: `1d20 ${mod >= 0 ? '+' : ''}${mod}（敏捷）` };
}

/* ────────────────────────── 车卡规则 ────────────────────────── */

/** 起始属性是固定的六个调整值，玩家把它们各用一次分配到六项属性上 */
const TRAIT_SET = [2, 1, 1, 0, 0, -1];

function creationBudgets(data) {
  const level = data.level || 1;
  const traits = DH_TRAITS.map(t => data.traits?.[t.key] ?? 0);
  const exps = (data.experiences || []).filter(e => (e.name || '').trim());
  const cards = data.domainCards || [];

  // 起始数组要「原样用完」，所以按多重集匹配算已用个数
  const pool = [...TRAIT_SET];
  let matched = 0;
  for (const v of traits) {
    const i = pool.indexOf(v);
    if (i >= 0) { pool.splice(i, 1); matched++; }
  }

  return makeBudgets([
    { key: 'traitSet', label: '起始属性数组', total: 6, used: matched, unit: '项',
      hint: `应恰好用掉 ${TRAIT_SET.map(v => (v > 0 ? `+${v}` : v)).join(' / ')} 各一次` },
    { key: 'experiences', label: '经历', total: 2 + Math.max(0, level - 1), used: exps.length, unit: '条',
      hint: '1 级 2 条，每条 +2；每升一级多 1 条' },
    { key: 'domainCards', label: '领域卡', total: 2 + Math.max(0, level - 1), used: cards.length, unit: '张',
      hint: '1 级 2 张；每升一级多 1 张' },
  ]);
}

function creationValidate(data) {
  const v = validator();

  /* 起始数组必须恰好用完 */
  const pool = [...TRAIT_SET];
  for (const t of DH_TRAITS) {
    const val = data.traits?.[t.key];
    const i = pool.indexOf(val);
    if (i >= 0) pool.splice(i, 1);
  }
  if (pool.length) {
    v.error('traitSet', '属性分配不合法：起始数组应恰好用掉 '
      + `${TRAIT_SET.map(x => (x > 0 ? `+${x}` : x)).join(' / ')}，还剩 `
      + `${pool.map(x => (x > 0 ? `+${x}` : x)).join(' / ')} 没用上`);
  }
  for (const t of DH_TRAITS) {
    const val = data.traits?.[t.key];
    if (!Number.isFinite(val)) v.error(`trait.${t.key}`, `${t.label}未填写`);
  }

  /* 职业决定闪避与生命点 */
  const cls = DH_CLASSES.find(c => c.name === data.className);
  if (!data.className) v.error('className', '还没选择职业');
  else if (!cls) v.warn('className', `「${data.className}」不在内置职业表里`);
  else {
    if (data.evasionBase !== cls.evasion) {
      v.error('evasion', `${cls.name} 的起始闪避应为 ${cls.evasion}，当前 ${data.evasionBase}`);
    }
    if (data.hpMax !== cls.hp) {
      v.error('hp', `${cls.name} 的起始生命点应为 ${cls.hp}，当前 ${data.hpMax}`);
    }
  }

  if ((data.hope ?? 0) !== 2) v.warn('hope', `起始希望应为 2 点，当前 ${data.hope}`);
  if ((data.stressMax ?? 6) !== 6) v.warn('stressMax', `起始压力上限应为 6，当前 ${data.stressMax}`);

  if ((data.armorSlotsMax ?? 0) !== (data.armorScore ?? 0)) {
    v.error('armorSlots', `护甲槽数量应等于护甲分数（${data.armorScore}），当前 ${data.armorSlotsMax}`);
  }
  if (!(data.majorThreshold > 0) || !(data.severeThreshold > data.majorThreshold)) {
    v.error('thresholds', '伤害阈值应满足：致命阈值 > 重伤阈值 > 0');
  }

  const level = data.level || 1;
  const exps = (data.experiences || []).filter(e => (e.name || '').trim());
  const needExp = 2 + Math.max(0, level - 1);
  if (exps.length < needExp) v.error('experiences', `${level} 级应有 ${needExp} 条经历，当前 ${exps.length} 条`);
  for (const e of exps) {
    if (e.mod !== 2) v.warn('experiences', `经历「${e.name}」的加值通常是 +2，当前 +${e.mod}`);
  }

  const needCards = 2 + Math.max(0, level - 1);
  const cards = data.domainCards || [];
  if (cards.length < needCards) v.error('domainCards', `${level} 级应有 ${needCards} 张领域卡，当前 ${cards.length} 张`);

  // 领域卡只能从职业的两个领域里选
  const usable = domainsOfClass(data.className);
  if (usable.length) {
    const bad = cards.filter(c => c.domain && !usable.includes(c.domain));
    if (bad.length) {
      v.error('domainCards', `这些领域卡不在 ${data.className} 的领域（${usable.join(' / ')}）内：`
        + bad.map(c => `${c.name}（${c.domain}）`).join('、'));
    }
  }

  // 血统与社群
  if (!data.ancestry) v.warn('ancestry', '还没选择血统');
  else if (!DH_ANCESTRIES.some(a => a.name === data.ancestry)) {
    v.warn('ancestry', `「${data.ancestry}」不在内置血统表里`);
  }
  if (!data.community) v.warn('community', '还没选择社群');
  else if (!DH_COMMUNITIES.some(c => c.name === data.community)) {
    v.warn('community', `「${data.community}」不在内置社群表里`);
  }

  return v.result;
}

/** 行动预设。战斗轮到这个角色时，只能从已声明的行动里挑一个来结算。 */
export const DH_ACTION_PRESETS = [
  { name: '攻击判定', kind: 'action', target: 'enemy', check: { targetKey: 'trait:strength' }, damage: '1d8', note: '对抗目标闪避' },
  { name: '施法判定', kind: 'action', target: 'enemy', check: { targetKey: 'spellcast' } },
  { name: '行动判定', kind: 'action', target: 'none', check: { targetKey: 'trait:agility' } },
  { name: '反应判定', kind: 'reaction', target: 'self', check: { targetKey: 'trait:instinct' }, note: '不产生希望与恐惧' },
  { name: '协助盟友', kind: 'action', target: 'ally', cost: { hope: 1 }, note: '花费 1 希望，为盟友的判定加一个 d6' },
  { name: '全力一击', kind: 'action', target: 'enemy', cost: { stress: 1 }, damage: '2d8', note: '标记 1 压力换取额外伤害' },
  { name: '重整旗鼓', kind: 'action', target: 'self', cost: { hope: 1 }, note: '花费 1 希望清除 1 点压力' },
  { name: '鼓起勇气', kind: 'action', target: 'ally', cost: { hope: 1 }, note: '给盟友 1 点希望' },
];

export const DH_CREATION = {
  summary: '起始六项属性从固定数组（+2 / +1 / +1 / 0 / 0 / −1）里各取一次分配；'
    + '职业决定起始闪避、生命点与两个领域，1 级带 2 条经历与 2 张领域卡，'
    + '起始希望 2 点、压力上限 6 格。',
  traits: {
    keys: DH_TRAITS.map(t => t.key),
    labels: Object.fromEntries(DH_TRAITS.map(t => [t.key, `${t.label} ${t.abbr}`])),
    array: TRAIT_SET,
  },
  fields: [
    { key: 'className', label: '职业', type: 'select', options: DH_CLASSES.map(c => c.name) },
    { key: 'subclass', label: '子职业', type: 'select', dependsOn: 'className' },
    { key: 'level', label: '等级', type: 'number', min: 1, max: 10, default: 1 },
    { key: 'ancestry', label: '血统', type: 'select', options: DH_ANCESTRIES.map(a => a.name) },
    { key: 'community', label: '社群', type: 'select', options: DH_COMMUNITIES.map(c => c.name) },
  ],
  budgets: creationBudgets,
  validate: creationValidate,
  traitSet: TRAIT_SET,
  usableDomains: domainsOfClass,
  subclassesOf,
};

export default {
  id: 'daggerheart',
  name: '匕首心',
  short: 'Daggerheart',
  accent: '#7a5ba8',
  dieIcon: '2d12',
  traits: DH_TRAITS,
  classes: DH_CLASSES,
  armors: DH_ARMORS,
  commonDifficulties: [
    { id: 5, label: '非常简单' }, { id: 10, label: '简单' }, { id: 12, label: '中等' },
    { id: 15, label: '困难' }, { id: 20, label: '非常困难' }, { id: 25, label: '几乎不可能' },
  ],
  createDefault,
  derive,
  rollTargets,
  roll,
  resolveDamage,
  damageSeverity,
  initiative,
  creation: DH_CREATION,
  actionPresets: DH_ACTION_PRESETS,
  /* 车卡数据（来自 DHSheet 的 SRD 中文卡表） */
  ancestries: DH_ANCESTRIES,
  communities: DH_COMMUNITIES,
  domains: DH_DOMAINS,
  domainCards: DH_DOMAIN_CARDS,
  domainsOfClass,
  subclassesOf,
  cardsOfDomain,
  dataSource: DH_DATA_SOURCE,
};
