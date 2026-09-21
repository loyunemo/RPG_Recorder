/**
 * 克苏鲁的呼唤 7 版（Call of Cthulhu 7th Edition）规则适配层。
 *
 * 判定核心：d100 对比目标值，含奖励骰 / 惩罚骰、三档难度、大成功与大失败。
 */

import { rollPercentile } from '../dice.js';

export const COC_ATTRIBUTES = [
  { key: 'str', label: '力量', abbr: 'STR' },
  { key: 'con', label: '体质', abbr: 'CON' },
  { key: 'siz', label: '体型', abbr: 'SIZ' },
  { key: 'dex', label: '敏捷', abbr: 'DEX' },
  { key: 'app', label: '外貌', abbr: 'APP' },
  { key: 'int', label: '智力', abbr: 'INT' },
  { key: 'pow', label: '意志', abbr: 'POW' },
  { key: 'edu', label: '教育', abbr: 'EDU' },
];

/** 7 版标准技能表（默认值；闪避/母语/信用评级在生成时按属性计算） */
export const COC_SKILLS = [
  ['会计', 5], ['人类学', 1], ['估价', 5], ['考古学', 1], ['取悦', 15], ['攀爬', 20],
  ['计算机使用', 5], ['信用评级', 0], ['克苏鲁神话', 0], ['乔装', 5], ['闪避', 0],
  ['汽车驾驶', 20], ['电气维修', 10], ['电子学', 1], ['话术', 5], ['格斗（斗殴）', 25],
  ['射击（手枪）', 20], ['射击（步枪/霰弹枪）', 25], ['急救', 30], ['历史', 5], ['恐吓', 15],
  ['跳跃', 20], ['母语', 0], ['外语（拉丁语）', 1], ['法律', 5], ['图书馆使用', 20],
  ['聆听', 20], ['锁匠', 1], ['机械维修', 10], ['医学', 1], ['博物学', 10], ['导航', 10],
  ['神秘学', 5], ['操作重型机械', 1], ['说服', 10], ['精神分析', 1], ['心理学', 10],
  ['骑术', 5], ['科学（生物学）', 1], ['妙手', 10], ['侦察', 25], ['潜行', 20],
  ['生存', 10], ['游泳', 20], ['投掷', 20], ['追踪', 10], ['潜水', 1], ['爆破', 1],
  ['读唇', 1], ['催眠', 1], ['炮术', 1],
];

export const COC_DIFFICULTIES = [
  { id: 'regular', label: '常规', level: 1, divisor: 1 },
  { id: 'hard', label: '困难', level: 2, divisor: 2 },
  { id: 'extreme', label: '极难', level: 3, divisor: 5 },
];

const LEVEL_OF = { fumble: 0, fail: 0, regular: 1, hard: 2, extreme: 3, critical: 4 };
const OUTCOME_LABEL = {
  critical: '大成功',
  extreme: '极难成功',
  hard: '困难成功',
  regular: '常规成功',
  fail: '失败',
  fumble: '大失败',
};

/** 伤害加值 / 体格 表（7 版规则书） */
export function buildAndDB(strSiz) {
  if (strSiz <= 64) return { build: -2, db: '-2' };
  if (strSiz <= 84) return { build: -1, db: '-1' };
  if (strSiz <= 124) return { build: 0, db: '0' };
  if (strSiz <= 164) return { build: 1, db: '+1D4' };
  if (strSiz <= 204) return { build: 2, db: '+1D6' };
  if (strSiz <= 284) return { build: 3, db: '+2D6' };
  if (strSiz <= 364) return { build: 4, db: '+3D6' };
  if (strSiz <= 444) return { build: 5, db: '+4D6' };
  const extra = Math.floor((strSiz - 445) / 80);
  return { build: 6 + extra, db: `+${5 + extra}D6` };
}

/** 移动力：先看 STR/DEX 与 SIZ 的关系，再按年龄扣减 */
export function movement(str, dex, siz, age = 30) {
  let mov;
  if (dex < siz && str < siz) mov = 7;
  else if (str > siz && dex > siz) mov = 9;
  else mov = 8;
  if (age >= 80) mov -= 5;
  else if (age >= 70) mov -= 4;
  else if (age >= 60) mov -= 3;
  else if (age >= 50) mov -= 2;
  else if (age >= 40) mov -= 1;
  return Math.max(1, mov);
}

/** 年龄对属性的调整点数（用于提示，不自动改写属性） */
export function ageModifier(age) {
  if (age <= 19) return { strConDex: -5, app: 0, edu: -5, note: 'STR/CON/DEX −5，EDU −5（幸运重掷一次）' };
  if (age <= 39) return { strConDex: 0, app: 0, edu: 0, note: '无年龄修正' };
  if (age <= 49) return { strConDex: -5, app: -5, edu: 0, note: 'STR/CON/DEX 合计 −5，APP −5，MOV −1' };
  if (age <= 59) return { strConDex: -10, app: -10, edu: 0, note: 'STR/CON/DEX 合计 −10，APP −10，MOV −2' };
  if (age <= 69) return { strConDex: -20, app: -15, edu: 0, note: 'STR/CON/DEX 合计 −20，APP −15，MOV −3' };
  if (age <= 79) return { strConDex: -40, app: -20, edu: 0, note: 'STR/CON/DEX 合计 −40，APP −20，MOV −4' };
  return { strConDex: -80, app: -25, edu: 0, note: 'STR/CON/DEX 合计 −80，APP −25，MOV −5' };
}

function createDefault(name = '新调查员') {
  return {
    name,
    occupation: '',
    age: 30,
    gender: '',
    residence: '',
    birthPlace: '',
    attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50 },
    luck: 50,
    state: { hp: null, mp: null, san: null, luck: null, mythos: 0 },
    skills: Object.fromEntries(
      COC_SKILLS.map(([n, v]) => {
        if (n === '闪避') return [n, 25];
        if (n === '母语') return [n, 50];
        return [n, v];
      })
    ),
    weapons: [],
    gear: '',
    background: {
      description: '', belief: '', significantPeople: '', meaningfulLocations: '',
      treasuredPossessions: '', traits: '', injuries: '', phobias: '', arcaneTomes: '',
    },
    notes: '',
  };
}

/** 计算所有派生数值 */
function derive(data) {
  const a = data.attributes;
  const hpMax = Math.floor((a.con + a.siz) / 10);
  const mpMax = Math.floor(a.pow / 5);
  const mythos = data.state.mythos ?? 0;
  const sanMax = 99 - mythos;
  const { build, db } = buildAndDB(a.str + a.siz);
  const mov = movement(a.str, a.dex, a.siz, data.age);

  const st = data.state;
  const tracks = [
    { key: 'hp', label: '生命值', current: st.hp ?? hpMax, max: hpMax, tone: 'hp' },
    { key: 'mp', label: '魔法值', current: st.mp ?? mpMax, max: mpMax, tone: 'mp' },
    { key: 'san', label: '理智', current: st.san ?? a.pow, max: sanMax, tone: 'san' },
    { key: 'luck', label: '幸运', current: st.luck ?? data.luck, max: 99, tone: 'luck' },
  ];

  const stats = [
    { key: 'hpMax', label: '生命上限', value: hpMax },
    { key: 'mpMax', label: '魔法上限', value: mpMax },
    { key: 'sanMax', label: '理智上限', value: sanMax },
    { key: 'mov', label: '移动力', value: mov },
    { key: 'build', label: '体格', value: build >= 0 ? `+${build}` : `${build}` },
    { key: 'db', label: '伤害加值', value: db },
    { key: 'mythos', label: '克苏鲁神话', value: mythos },
    { key: 'dodge', label: '闪避', value: Math.floor(a.dex / 2) },
  ];

  return { tracks, stats, hpMax, mpMax, sanMax, mov, build, db };
}

/** 可掷骰目标列表（供 UI 生成下拉/按钮） */
function rollTargets(data) {
  const groups = [];
  groups.push({
    title: '属性',
    items: COC_ATTRIBUTES.map(attr => ({
      key: `attr:${attr.key}`,
      label: `${attr.label}（${attr.abbr}）`,
      value: data.attributes[attr.key],
      difficulty: true,
      bonusDice: true,
    })),
  });
  groups.push({
    title: '技能',
    items: Object.entries(data.skills)
      .filter(([, v]) => v > 0 || true)
      .map(([name, value]) => ({
        key: `skill:${name}`,
        label: name,
        value,
        difficulty: true,
        bonusDice: true,
      }))
      .sort((x, y) => x.label.localeCompare(y.label, 'zh-Hans-CN')),
  });
  groups.push({
    title: '其他',
    items: [
      { key: 'luck', label: '幸运', value: data.state.luck ?? data.luck, difficulty: true, bonusDice: true },
      { key: 'san', label: '理智', value: data.state.san ?? data.attributes.pow, difficulty: true, bonusDice: true },
    ],
  });
  return groups;
}

function resolveTarget(data, req) {
  const key = req.targetKey || '';
  if (key.startsWith('attr:')) {
    const k = key.slice(5);
    const attr = COC_ATTRIBUTES.find(x => x.key === k);
    return { label: attr ? `${attr.label}（${attr.abbr}）` : k, value: data.attributes[k] };
  }
  if (key.startsWith('skill:')) {
    const name = key.slice(6);
    return { label: name, value: data.skills[name] ?? 0 };
  }
  if (key === 'luck') return { label: '幸运', value: data.state.luck ?? data.luck };
  if (key === 'san') return { label: '理智', value: data.state.san ?? data.attributes.pow };
  return { label: req.targetLabel || '自定义检定', value: req.targetValue ?? 0 };
}

/**
 * 执行一次 d100 检定。
 * @param {object} data 角色数据
 * @param {object} req  { targetKey, targetValue, targetLabel, bonus, penalty, difficulty, pushed, reason }
 * @param {import('../rng.js').RNG} rng
 */
function roll(data, req, rng) {
  const target = req.targetValue != null && !req.targetKey
    ? { label: req.targetLabel || '自定义检定', value: req.targetValue }
    : resolveTarget(data, req);

  const bonus = req.bonus || 0;
  const penalty = req.penalty || 0;
  const pct = rollPercentile(rng, { bonus, penalty });

  const rollValue = pct.value;
  const tv = target.value;
  const hard = Math.floor(tv / 2);
  const extreme = Math.floor(tv / 5);

  let outcome;
  if (rollValue === 1) outcome = 'critical';
  else if (rollValue === 100 || (tv < 50 && rollValue >= 96)) outcome = 'fumble';
  else if (rollValue <= extreme) outcome = 'extreme';
  else if (rollValue <= hard) outcome = 'hard';
  else if (rollValue <= tv) outcome = 'regular';
  else outcome = 'fail';

  const difficulty = COC_DIFFICULTIES.find(d => d.id === (req.difficulty || 'regular')) || COC_DIFFICULTIES[0];
  const success = LEVEL_OF[outcome] >= difficulty.level;

  const diceNote = [];
  if (bonus || penalty) {
    const net = bonus - penalty;
    const tensShown = pct.rawTens.map((t, i) => (i === 0 ? `${t}` : `${t}`)).join('/');
    diceNote.push(
      net > 0
        ? `奖励骰 ×${net}：十位骰 [${tensShown}] 取最小 ${pct.chosen}`
        : `惩罚骰 ×${-net}：十位骰 [${tensShown}] 取最大 ${pct.chosen}`
    );
    diceNote.push(`个位骰 ${pct.units}`);
  }

  const detail = [
    `1d100 = ${rollValue}${bonus || penalty ? `（十位 ${pct.chosen} / 个位 ${pct.units}）` : ''}`,
    `目标 ${target.label} ${tv}（困难 ${hard} / 极难 ${extreme}）`,
    `难度：${difficulty.label}`,
    `结果：${OUTCOME_LABEL[outcome]}`,
    ...diceNote,
  ].join(' · ');

  return {
    ok: true,
    kind: 'check',
    system: 'coc7',
    title: `${target.label} 检定${req.pushed ? '（孤注一掷）' : ''}`,
    formula: `1d100 ≤ ${tv}${difficulty.id !== 'regular' ? `（${difficulty.label}）` : ''}`,
    roll: rollValue,
    target: tv,
    targetLabel: target.label,
    hard,
    extreme,
    bonus,
    penalty,
    percentile: pct,
    difficulty: difficulty.id,
    difficultyLabel: difficulty.label,
    outcome,
    outcomeLabel: OUTCOME_LABEL[outcome],
    success,
    reason: req.reason || '',
    pushed: !!req.pushed,
    seed: rng.seed,
    consumed: 1 + Math.abs(bonus - penalty),
    detail,
    /** 回显这次判定的参数，便于「孤注一掷」用同样条件重掷 */
    request: {
      targetKey: req.targetKey,
      targetLabel: target.label,
      targetValue: tv,
      bonus, penalty,
      difficulty: difficulty.id,
      reason: req.reason || '',
    },
  };
}

/**
 * 对抗检定：双方各掷一次 d100，比较成功等级。
 * 规则：成功等级高者胜；等级相同则目标值高者胜；一方成功一方失败则成功者胜。
 * @param {object} req { targetKey, bonus, penalty, opponent: { label, value, bonus, penalty } }
 */
function rollOpposed(data, req, rng) {
  const opp = req.opponent || {};
  const self = roll(data, { ...req, difficulty: 'regular' }, rng);
  const foe = roll(data, {
    targetLabel: opp.label || '对手',
    targetValue: opp.value ?? 0,
    bonus: opp.bonus || 0,
    penalty: opp.penalty || 0,
    difficulty: 'regular',
  }, rng);

  const selfLevel = LEVEL_OF[self.outcome];
  const foeLevel = LEVEL_OF[foe.outcome];

  let winner;
  if (selfLevel !== foeLevel) winner = selfLevel > foeLevel ? 'self' : 'foe';
  else winner = self.target >= foe.target ? 'self' : 'foe';

  const tie = selfLevel === foeLevel && self.target === foe.target;
  const detail = [
    `我方 ${self.targetLabel}：1d100 = ${self.roll} → ${self.outcomeLabel}`,
    `对手 ${foe.targetLabel}：1d100 = ${foe.roll} → ${foe.outcomeLabel}`,
    tie ? '双方完全平手，由守秘人裁定' : `胜者：${winner === 'self' ? self.targetLabel : foe.targetLabel}`,
  ].join(' · ');

  return {
    ok: true,
    kind: 'opposed',
    system: 'coc7',
    title: `对抗检定：${self.targetLabel} vs ${foe.targetLabel}`,
    self,
    foe,
    winner,
    tie,
    success: tie ? null : winner === 'self',
    outcomeLabel: tie ? '平手' : winner === 'self' ? '我方胜' : '对手胜',
    reason: req.reason || '',
    seed: rng.seed,
    consumed: self.consumed + foe.consumed,
    detail,
    request: { ...req },
  };
}

/** 先攻：COC 不掷骰，直接按 DEX 从高到低行动 */
function initiative(data) {
  return { kind: 'static', value: data.attributes.dex, label: '按 DEX 排序' };
}

export default {
  id: 'coc7',
  name: '克苏鲁的呼唤 7版',
  short: 'COC 7e',
  accent: '#5b8c6e',
  dieIcon: 'd100',
  attributes: COC_ATTRIBUTES,
  skills: COC_SKILLS,
  difficulties: COC_DIFFICULTIES,
  supportsOpposed: true,
  supportsPush: true,
  createDefault,
  derive,
  rollTargets,
  roll,
  rollOpposed,
  initiative,
  buildAndDB,
  movement,
  ageModifier,
};
