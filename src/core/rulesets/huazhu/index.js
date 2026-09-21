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
  tierFor,
  reputationBand,
  subclassesOf,
  cardsOfDomain,
};
