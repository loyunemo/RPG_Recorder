/**
 * 《华渚》中式奇幻 · 匕首之心框架
 *
 * 这是一套**匕首之心的战役扩展**，不是独立规则：
 * 判定机制（双重骰、希望与恐惧、压力与护甲槽、伤害阈值）完全沿用匕首之心，
 * 本模块负责把华渚的 13 法门 / 55 宗门流派 / 27 种族 / 15 社群 / 15 领域 315 张领域卡
 * 以及位阶、道心经历、声望、九玄技等战役机制接进去。
 *
 * 数据由 scripts/build-huazhu-data.cjs 从 docx 提取产物生成，不要手改 data/*.gen.js。
 *
 * 版权：「华渚」框架著作权归原作者【虚拟人】所有，非商业用途；
 * 其基础规则出自 Daggerheart SRD 1.0，© Critical Role, LLC.，依 DPCGL 使用。
 */

import daggerheart, { DH_TRAITS, DH_TRAIT_ARRAY, damageSeverity, SEVERITY_LABEL } from '../daggerheart.js';
import { validator, makeBudgets } from '../../creation.js';

import classesData from './data/classes.gen.js';
import ancestriesData from './data/ancestries.gen.js';
import communitiesData from './data/communities.gen.js';
import domainsData from './data/domains.gen.js';
import equipmentData from './data/equipment.gen.js';
import mechanicsData from './data/mechanics.gen.js';
import statsData from './data/equipment-stats.gen.js';

/* ────────────────────────── 数据 ────────────────────────── */

export const HUAZHU_CLASSES = classesData.classes;
export const HUAZHU_ANCESTRIES = ancestriesData.ancestries;
export const HUAZHU_COMMUNITIES = communitiesData.communities;
export const HUAZHU_DOMAINS = domainsData.domains;
export const HUAZHU_CARDS = domainsData.cards;
export const HUAZHU_EQUIPMENT = equipmentData;
export const HUAZHU_MECHANICS = mechanicsData;

const CLASS_BY_NAME = new Map(HUAZHU_CLASSES.map(c => [c.name, c]));
const DOMAIN_BY_NAME = new Map(HUAZHU_DOMAINS.map(d => [d.name, d]));

/** 位阶：由等级推出，取自 mechanics.tiers */
export function tierFor(level) {
  const lv = Math.max(1, Math.min(10, level || 1));
  for (const t of HUAZHU_MECHANICS.tiers || []) {
    const m = /[（(]?\s*(\d+)\s*[-–—~至]\s*(\d+)\s*[）)]?/.exec(t.name + ' ' + (t.text || ''));
    if (m) {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      if (lv >= lo && lv <= hi) return t.name.replace(/[（(].*$/, '').trim();
    }
    const single = /[（(]\s*(\d+)\s*级\s*[）)]/.exec(t.name);
    if (single && Number(single[1]) === lv) return t.name.replace(/[（(].*$/, '').trim();
  }
  // 回退：按已知的位阶等级段
  if (lv <= 1) return '启微境';
  if (lv <= 4) return '贯枢境';
  if (lv <= 7) return '栖真境';
  if (lv <= 9) return '凌宸境';
  return '陆地神仙境';
}

/** 声望档位（善名 / 恶名），取自 mechanics.reputation */
export function reputationBand(value) {
  const v = Number(value) || 0;
  const items = HUAZHU_MECHANICS.reputation?.items || [];
  if (v > 0) return items.find(i => /善/.test(i.name))?.name || '善名远扬';
  if (v < 0) return items.find(i => /恶/.test(i.name))?.name || '恶名通缉';
  return '籍籍无名';
}

/** 某个法门可选的宗门流派 */
export function subclassesOf(className) {
  return CLASS_BY_NAME.get(className)?.subclasses || [];
}

/** 某张领域卡属于哪个领域 */
export function cardsOfDomain(domainName) {
  return HUAZHU_CARDS.filter(c => c.domain === domainName);
}

/**
 * 华渚装备在原文里只是「原版换皮更名」，本身没有数值。
 * 这里的数值来自匕首之心基础规则（英文 SRD × 官方中文规则书交叉核对），
 * 用官方中文原名与华渚表对齐。
 */
export const HUAZHU_WEAPONS = (statsData.weapons || []).map(w => ({
  name: w.hualName || w.originalName,
  originalName: w.originalName,
  originalNameEn: w.originalNameEn,
  tier: w.tier,
  trait: w.traitZh || w.trait,
  range: w.rangeZh || w.range,
  damage: w.damage,
  damageType: w.damageTypeZh || w.damageType,
  burden: w.burdenZh || w.burden,
  feature: w.featureZh || w.feature,
}));

export const HUAZHU_SECONDARY_WEAPONS = (statsData.secondaryWeapons || []).map(w => ({
  name: w.hualName || w.originalName,
  originalName: w.originalName,
  tier: w.tier,
  trait: w.traitZh || w.trait,
  range: w.rangeZh || w.range,
  damage: w.damage,
  damageType: w.damageTypeZh || w.damageType,
  burden: w.burdenZh || w.burden,
  feature: w.featureZh || w.feature,
}));

export const HUAZHU_ARMORS = (statsData.armors || []).map(a => ({
  name: a.hualName || a.originalName,
  originalName: a.originalName,
  originalNameEn: a.originalNameEn,
  tier: a.tier,
  major: a.major,
  severe: a.severe,
  score: a.score,
  evasion: a.evasionMod || 0,
  feature: a.featureZh || a.feature,
}));

/** 护甲选择器用华渚的 17 件；数据缺失时退回匕首之心基础表 */
export const ARMORS = HUAZHU_ARMORS.length ? HUAZHU_ARMORS : daggerheart.armors;

/* ────────────────────────── 角色卡 ────────────────────────── */

/** 起始属性分配：+2 / +1 / +1 / 0 / 0 / −1，与匕首之心一致 */
export { DH_TRAIT_ARRAY };

function createDefault(name = '新修行者') {
  const first = HUAZHU_CLASSES[0];
  return {
    name,
    pronouns: '',
    /* 华渚特有：出身由「法门 + 宗门」两级构成 */
    className: first?.name || '侠义',
    subclass: first?.subclasses?.[0]?.name || '',
    sectNature: first?.subclasses?.[0]?.sectNature || '',
    spellcastTrait: first?.subclasses?.[0]?.spellcastTrait || '',
    domain: first?.domain || '真武',
    level: 1,

    ancestry: HUAZHU_ANCESTRIES.find(a => a.playable !== false)?.name || '人类（华渚人）',
    community: HUAZHU_COMMUNITIES[0]?.name || '',

    traits: { agility: 1, strength: 2, finesse: 0, instinct: 0, presence: -1, knowledge: 1 },

    evasionBase: first?.evasion ?? 10,
    armorName: '皮甲',
    armorScore: 3,
    armorEvasion: 0,
    majorThreshold: 6,
    severeThreshold: 13,

    hpMax: first?.hp ?? 6,
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

    /* ── 华渚战役机制 ── */
    /** 道心经历：原文给的是 −2，且明确「无需花费希望点即可直接使用」 */
    daoHeart: { name: '道心', mod: -2, note: '' },
    /** 华渚声望：正数为善名、负数为恶名 */
    reputation: 0,
    /** 已领悟的九玄技（存名称） */
    nineMysteries: [],
    /** 已获得的领域卡 */
    domainCards: [],

    /** 战斗中可执行的行动 */
    actions: [],

    weapons: [],
    inventory: '',
    notes: '',
  };
}

function derive(data) {
  // 资源轨与匕首之心一致，直接复用它的推导
  const base = daggerheart.derive(data);
  const className = data.className || '';
  const cls = CLASS_BY_NAME.get(className);
  const sub = (cls?.subclasses || []).find(s => s.name === data.subclass);

  const tier = tierFor(data.level);
  const rep = Number(data.reputation) || 0;

  const stats = [
    ...base.stats,
    { key: 'tier', label: '位阶', value: tier },
    { key: 'domain', label: '领域', value: data.domain || cls?.domain || '—' },
    { key: 'sectNature', label: '宗门性质', value: data.sectNature || sub?.sectNature || '—' },
    { key: 'spellcastTrait', label: '施法属性', value: data.spellcastTrait || sub?.spellcastTrait || '—' },
    { key: 'reputation', label: '华渚声望', value: `${rep > 0 ? '+' : ''}${rep}（${reputationBand(rep)}）` },
    { key: 'daoHeart', label: '道心经历', value: `${(data.daoHeart?.mod ?? -2) >= 0 ? '+' : ''}${data.daoHeart?.mod ?? -2}` },
    { key: 'mysteries', label: '已悟九玄技', value: `${(data.nineMysteries || []).length} / 9` },
  ];

  return { ...base, stats, tier, className };
}

function rollTargets(data) {
  const groups = daggerheart.rollTargets(data);

  // 把道心经历与已有经历并入「经历」组，方便直接掷骰
  const expItems = (data.experiences || [])
    .filter(e => e.name)
    .map((e, i) => ({
      key: `exp:${i}`, label: `经历：${e.name}`, value: e.mod, signed: true, versus: true, adv: true,
    }));
  const dh = data.daoHeart;
  if (dh?.name) {
    expItems.push({
      key: 'daoheart',
      label: `道心：${dh.name}`,
      value: dh.mod ?? -2,
      signed: true, versus: true, adv: true,
    });
  }
  if (expItems.length) {
    groups.splice(1, 0, { title: '经历与道心', items: expItems });
  }

  return groups;
}

/** 判定机制原样沿用匕首之心 */
function roll(data, req, rng) {
  return daggerheart.roll(data, req, rng);
}

function resolveDamage(data, req) {
  return daggerheart.resolveDamage(data, req);
}

function initiative(data) {
  return daggerheart.initiative(data);
}

/* ────────────────────────── 导出 ────────────────────────── */

/* ────────────────────────── 车卡规则 ────────────────────────── */

const TRAIT_SET = DH_TRAIT_ARRAY;   // [+2, +1, +1, 0, 0, −1]

/**
 * 某个法门 + 宗门可用的领域列表。
 *
 * 入参统一接受角色数据对象；为与匕首心保持一致，也接受法门名（此时只有第一个领域）。
 * 两个规则集的 `creation.usableDomains` 必须是同一种签名 ——
 * 否则界面按一种约定调用、规则集按另一种实现，会静默返回空列表。
 */
function usableDomains(input) {
  const data = typeof input === 'string' ? { className: input } : (input || {});
  const cls = CLASS_BY_NAME.get(data.className);
  const sub = (cls?.subclasses || []).find(s => s.name === data.subclass);
  const list = [];
  if (cls?.domain) list.push(...String(cls.domain).split(/[、,，]/).map(s => s.trim()).filter(Boolean));
  // 宗门的领域有时写成「污秽或虔心」这样的二选一
  if (sub?.domain) {
    for (const part of String(sub.domain).split(/[、,，]|或/).map(s => s.trim()).filter(Boolean)) {
      if (!list.includes(part)) list.push(part);
    }
  }
  return list;
}

function creationBudgets(data) {
  const level = data.level || 1;
  const pool = [...TRAIT_SET];
  let matched = 0;
  for (const t of DH_TRAITS) {
    const i = pool.indexOf(data.traits?.[t.key]);
    if (i >= 0) { pool.splice(i, 1); matched++; }
  }

  const exps = (data.experiences || []).filter(e => (e.name || '').trim());
  const cards = data.domainCards || [];
  const usable = usableDomains(data);
  const inDomain = cards.filter(c => usable.includes(c.domain)).length;

  return makeBudgets([
    { key: 'traitSet', label: '起始属性数组', total: 6, used: matched, unit: '项',
      hint: `应恰好用掉 ${TRAIT_SET.map(v => (v > 0 ? `+${v}` : v)).join(' / ')} 各一次` },
    { key: 'experiences', label: '经历', total: 2 + Math.max(0, level - 1), used: exps.length, unit: '条',
      hint: '1 级 2 条，每条 +2；每升一级多 1 条' },
    { key: 'domainCards', label: '领域卡', total: 2 + Math.max(0, level - 1), used: cards.length, unit: '张',
      hint: usable.length ? `只能从 ${usable.join(' / ')} 两个领域里选` : '先选好法门与宗门' },
    ...(usable.length ? [{
      key: 'domainMatch', label: '其中属于本领域', total: cards.length || 1,
      used: inDomain, unit: '张', hint: '带进来的卡应都来自你的可用领域',
    }] : []),
  ]);
}

function creationValidate(data) {
  const v = validator();

  /* 属性数组 */
  const pool = [...TRAIT_SET];
  for (const t of DH_TRAITS) {
    const i = pool.indexOf(data.traits?.[t.key]);
    if (i >= 0) pool.splice(i, 1);
  }
  if (pool.length) {
    v.error('traitSet', '属性分配不合法：起始数组应恰好用掉 '
      + `${TRAIT_SET.map(x => (x > 0 ? `+${x}` : x)).join(' / ')}，还剩 `
      + `${pool.map(x => (x > 0 ? `+${x}` : x)).join(' / ')} 没用上`);
  }
  for (const t of DH_TRAITS) {
    if (!Number.isFinite(data.traits?.[t.key])) v.error(`trait.${t.key}`, `${t.label}未填写`);
  }

  /* 法门 */
  const cls = CLASS_BY_NAME.get(data.className);
  if (!data.className) v.error('className', '还没选择法门');
  else if (!cls) v.error('className', `「${data.className}」不在 13 法门之内`);
  else {
    if (data.evasionBase !== cls.evasion) {
      v.error('evasion', `${cls.name} 的起始闪避应为 ${cls.evasion}，当前 ${data.evasionBase}`);
    }
    if (data.hpMax !== cls.hp) {
      v.error('hp', `${cls.name} 的起始生命点应为 ${cls.hp}，当前 ${data.hpMax}`);
    }
    if (data.domain !== cls.domain) {
      v.error('domain', `${cls.name} 的领域应为「${cls.domain}」，当前「${data.domain}」`);
    }
  }

  /* 宗门（子职业） */
  const sub = (cls?.subclasses || []).find(s => s.name === data.subclass);
  if (!data.subclass) v.error('subclass', '还没选择宗门流派');
  else if (cls && !sub) {
    const names = (cls.subclasses || []).map(s => s.name);
    v.error('subclass', `「${data.subclass}」不属于 ${cls.name}。可选：${names.join('、')}`);
  } else if (sub) {
    if (sub.sectNature && data.sectNature !== sub.sectNature) {
      v.warn('sectNature', `宗门性质应为「${sub.sectNature}」，当前「${data.sectNature}」`);
    }
    if (sub.spellcastTrait && data.spellcastTrait !== sub.spellcastTrait) {
      v.error('spellcastTrait', `施法属性应为「${sub.spellcastTrait}」，当前「${data.spellcastTrait}」`);
    }
  }

  /* 领域卡必须来自可用领域 */
  const usable = usableDomains(data);
  const cards = data.domainCards || [];
  if (usable.length) {
    const bad = cards.filter(c => !usable.includes(c.domain));
    if (bad.length) {
      v.error('domainCards', `这些领域卡不在你的可用领域（${usable.join(' / ')}）内：`
        + bad.map(c => `${c.name}（${c.domain}）`).join('、'));
    }
  }

  /* 起始资源 */
  if ((data.hope ?? 0) !== 2) v.warn('hope', `起始希望应为 2 点，当前 ${data.hope}`);
  if ((data.stressMax ?? 6) !== 6) v.warn('stressMax', `起始压力上限应为 6，当前 ${data.stressMax}`);
  if ((data.armorSlotsMax ?? 0) !== (data.armorScore ?? 0)) {
    v.error('armorSlots', `护甲槽数量应等于护甲分数（${data.armorScore}），当前 ${data.armorSlotsMax}`);
  }
  if (!(data.majorThreshold > 0) || !(data.severeThreshold > data.majorThreshold)) {
    v.error('thresholds', '伤害阈值应满足：致命阈值 > 重伤阈值 > 0');
  }

  /* 经历与领域卡数量 */
  const level = data.level || 1;
  const exps = (data.experiences || []).filter(e => (e.name || '').trim());
  const needExp = 2 + Math.max(0, level - 1);
  if (exps.length < needExp) v.error('experiences', `${level} 级应有 ${needExp} 条经历，当前 ${exps.length} 条`);
  const needCards = 2 + Math.max(0, level - 1);
  if (cards.length < needCards) v.error('domainCards', `${level} 级应有 ${needCards} 张领域卡，当前 ${cards.length} 张`);

  /* 九玄技：起始不该领悟 */
  const mysteries = data.nineMysteries || [];
  if (mysteries.length && level < 5) {
    v.warn('nineMysteries', `刚建卡就带了 ${mysteries.length} 项九玄技；原文未给出起始领悟规则，请与主持人确认`);
  }

  /* 道心经历 */
  if (!data.daoHeart?.name) v.warn('daoHeart', '还没给道心经历起名');
  if ((data.daoHeart?.mod ?? -2) > 0) {
    v.warn('daoHeart', `道心经历是 +${data.daoHeart.mod}；原文写的是 −2，若你读作笔误请忽略这条`);
  }

  return v.result;
}

/**
 * 行动预设：沿用匕首心的那一套，另加华渚特有的炁与修真手段。
 * check 会被直接交给 roll()，与判定面板的写法一致。
 */
export const HUAZHU_ACTION_PRESETS = [
  ...daggerheart.actionPresets.map(p => ({ ...p })),
  { name: '运炁（斗气）', kind: 'action', target: 'enemy', check: { targetKey: 'trait:strength' }, damage: '1d10', cost: { stress: 1 }, note: '灌注斗气的刚猛一击' },
  { name: '驭炁（真气）', kind: 'action', target: 'enemy', check: { targetKey: 'spellcast' }, note: '以心法引导真气' },
  { name: '御剑', kind: 'action', target: 'enemy', check: { targetKey: 'trait:finesse' }, damage: '1d8', note: '剑修的飞剑手段' },
  { name: '布阵', kind: 'action', target: 'area', check: { targetKey: 'trait:knowledge' }, note: '结阵派的手段，为全队创造优势' },
  { name: '丹术', kind: 'action', target: 'ally', check: { targetKey: 'trait:knowledge' }, note: '以丹药救人' },
  { name: '观气', kind: 'action', target: 'none', check: { targetKey: 'trait:instinct' }, note: '辨明对手的修为与路数' },
  { name: '九玄技', kind: 'action', target: 'enemy', note: '动用已领悟的九玄技，具体效果由主持人裁定' },
  { name: '道心自问', kind: 'action', target: 'self', note: '动用道心经历，原文注明无需花费希望点' },
];

export const HUAZHU_CREATION = {
  summary: '在匕首之心的车卡基础上，法门决定第一个领域与闪避/生命点，'
    + '宗门流派再给出第二个领域、施法属性与初始物品；领域卡只能从这两个领域里选。',
  traits: {
    keys: DH_TRAITS.map(t => t.key),
    labels: Object.fromEntries(DH_TRAITS.map(t => [t.key, `${t.label} ${t.abbr}`])),
    array: TRAIT_SET,
  },
  fields: [
    { key: 'className', label: '法门', type: 'select', options: HUAZHU_CLASSES.map(c => c.name) },
    { key: 'subclass', label: '宗门流派', type: 'select', dependsOn: 'className' },
    { key: 'level', label: '等级', type: 'number', min: 1, max: 10, default: 1 },
    { key: 'ancestry', label: '种族', type: 'select', options: HUAZHU_ANCESTRIES.filter(a => a.playable !== false).map(a => a.name) },
    { key: 'community', label: '社群', type: 'select', options: HUAZHU_COMMUNITIES.map(c => c.name) },
  ],
  budgets: creationBudgets,
  validate: creationValidate,
  traitSet: TRAIT_SET,
  usableDomains,
  subclassesOf,
};

export default {
  id: 'huazhu',
  name: '华渚（中式奇幻·匕首之心）',
  short: '华渚',
  accent: '#b8860b',
  dieIcon: '2d12',
  /** 标记它派生自哪套基础规则，界面据此复用匕首心的卡面 */
  extends: 'daggerheart',

  /* 数据 */
  traits: DH_TRAITS,
  classes: HUAZHU_CLASSES,
  ancestries: HUAZHU_ANCESTRIES,
  communities: HUAZHU_COMMUNITIES,
  domains: HUAZHU_DOMAINS,
  domainCards: HUAZHU_CARDS,
  equipment: HUAZHU_EQUIPMENT,
  equipmentStats: statsData,
  weapons: HUAZHU_WEAPONS,
  secondaryWeapons: HUAZHU_SECONDARY_WEAPONS,
  mechanics: HUAZHU_MECHANICS,
  armors: ARMORS,
  commonDifficulties: daggerheart.commonDifficulties,

  /* 机制 */
  createDefault,
  derive,
  rollTargets,
  roll,
  resolveDamage,
  damageSeverity,
  initiative,
  creation: HUAZHU_CREATION,
  actionPresets: HUAZHU_ACTION_PRESETS,
  tierFor,
  reputationBand,
  subclassesOf,
  cardsOfDomain,
};
