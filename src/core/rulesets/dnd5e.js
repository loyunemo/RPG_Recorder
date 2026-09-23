/**
 * 龙与地下城 5 版（Dungeons & Dragons 5th Edition）规则适配层。
 *
 * 判定核心：d20 + 属性调整值 + 熟练加值 对抗 DC，含优势 / 劣势与天然 20 / 天然 1。
 */

import {
  validator, roll4d6dl1, STANDARD_ARRAY, pointBuyCost, POINT_BUY_BUDGET,
  makeBudgets, sameMultiset,
} from '../creation.js';

export const DND_ABILITIES = [
  { key: 'str', label: '力量', abbr: 'STR' },
  { key: 'dex', label: '敏捷', abbr: 'DEX' },
  { key: 'con', label: '体质', abbr: 'CON' },
  { key: 'int', label: '智力', abbr: 'INT' },
  { key: 'wis', label: '感知', abbr: 'WIS' },
  { key: 'cha', label: '魅力', abbr: 'CHA' },
];

export const DND_SKILLS = [
  { key: 'acrobatics', label: '体操', ability: 'dex' },
  { key: 'animalHandling', label: '驯兽', ability: 'wis' },
  { key: 'arcana', label: '奥秘', ability: 'int' },
  { key: 'athletics', label: '运动', ability: 'str' },
  { key: 'deception', label: '欺骗', ability: 'cha' },
  { key: 'history', label: '历史', ability: 'int' },
  { key: 'insight', label: '洞悉', ability: 'wis' },
  { key: 'intimidation', label: '威吓', ability: 'cha' },
  { key: 'investigation', label: '调查', ability: 'int' },
  { key: 'medicine', label: '医药', ability: 'wis' },
  { key: 'nature', label: '自然', ability: 'int' },
  { key: 'perception', label: '察觉', ability: 'wis' },
  { key: 'performance', label: '表演', ability: 'cha' },
  { key: 'persuasion', label: '说服', ability: 'cha' },
  { key: 'religion', label: '宗教', ability: 'int' },
  { key: 'sleightOfHand', label: '巧手', ability: 'dex' },
  { key: 'stealth', label: '隐匿', ability: 'dex' },
  { key: 'survival', label: '生存', ability: 'wis' },
];

/** 施法者法术位表（1~20 级，按施法者等级） */
const FULL_CASTER_SLOTS = {
  1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3, 1],
  8: [4, 3, 3, 2], 9: [4, 3, 3, 3, 1], 10: [4, 3, 3, 3, 2], 11: [4, 3, 3, 3, 2, 1],
  12: [4, 3, 3, 3, 2, 1], 13: [4, 3, 3, 3, 2, 1, 1], 14: [4, 3, 3, 3, 2, 1, 1],
  15: [4, 3, 3, 3, 2, 1, 1, 1], 16: [4, 3, 3, 3, 2, 1, 1, 1], 17: [4, 3, 3, 3, 2, 1, 1, 1, 1],
  18: [4, 3, 3, 3, 3, 1, 1, 1, 1], 19: [4, 3, 3, 3, 3, 2, 1, 1, 1], 20: [4, 3, 3, 3, 3, 2, 2, 1, 1],
};

export function proficiencyBonus(level) {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

export function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

function createDefault(name = '新冒险者') {
  const abilities = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  return {
    name,
    player: '',
    className: '',
    level: 1,
    race: '',
    backgroundName: '',
    alignment: '',
    abilities,
    /** 车卡时记录的「加种族加值之前」的属性，用于校验点数购买是否超支 */
    baseAbilities: { ...abilities },
    /** 已应用的种族加值，便于在校验时反推基础值 */
    raceBonuses: {},
    proficiency: { skills: [], saves: [], expertise: [] },
    combat: {
      hpMax: 10, hp: null, tempHp: 0, hitDice: '1d8', hitDiceUsed: 0,
      armorBase: 10, dexCap: null, shield: 0, miscAC: 0, speed: 30,
      deathSuccess: 0, deathFail: 0,
    },
    spell: { ability: 'int', slotsUsed: {}, prepared: '', notes: '' },
    /** 战斗中可执行的行动 */
    actions: [],
    weapons: [],
    gear: '',
    features: '',
    notes: '',
  };
}

function derive(data) {
  const lvl = Math.max(1, data.level || 1);
  const prof = proficiencyBonus(lvl);
  const mods = Object.fromEntries(DND_ABILITIES.map(a => [a.key, abilityMod(data.abilities[a.key])]));

  const armorBase = data.combat.armorBase ?? 10;
  const dexCap = data.combat.dexCap;
  const dexForAc = dexCap == null ? mods.dex : Math.min(mods.dex, dexCap);
  const ac = armorBase + dexForAc + (data.combat.shield || 0) + (data.combat.miscAC || 0);

  const hpMax = data.combat.hpMax || 1;
  const tracks = [
    { key: 'hp', label: '生命值', current: data.combat.hp ?? hpMax, max: hpMax, tone: 'hp' },
    { key: 'tempHp', label: '临时生命', current: data.combat.tempHp || 0, max: Math.max(data.combat.tempHp || 0, 1), tone: 'temp' },
  ];

  const stats = [
    { key: 'ac', label: '护甲等级', value: ac },
    { key: 'prof', label: '熟练加值', value: `+${prof}` },
    { key: 'initiative', label: '先攻', value: (mods.dex >= 0 ? '+' : '') + mods.dex },
    { key: 'speed', label: '速度', value: `${data.combat.speed || 30} 尺` },
    { key: 'hitDice', label: '生命骰', value: `${data.combat.hitDice || '1d8'}（已用 ${data.combat.hitDiceUsed || 0}）` },
    {
      key: 'passivePerception',
      label: '被动察觉',
      value: 10 + mods.wis + (isProficient(data, 'perception') ? prof : 0),
    },
    {
      key: 'spellSaveDC',
      label: '法术豁免 DC',
      value: 8 + prof + mods[data.spell.ability || 'int'],
    },
    {
      key: 'spellAttack',
      label: '法术攻击加值',
      value: `+${prof + mods[data.spell.ability || 'int']}`,
    },
  ];

  const slots = FULL_CASTER_SLOTS[lvl] || [];
  const spellSlots = slots.map((max, i) => ({
    level: i + 1,
    max,
    used: data.spell.slotsUsed?.[i + 1] || 0,
  }));

  const skills = DND_SKILLS.map(s => {
    const m = mods[s.ability];
    const p = isProficient(data, s.key) ? prof : 0;
    const e = isExpertise(data, s.key) ? prof : 0;
    return { ...s, mod: m, prof: p, expertise: e, total: m + p + e };
  });

  const saves = DND_ABILITIES.map(a => {
    const p = (data.proficiency.saves || []).includes(a.key) ? prof : 0;
    return { key: a.key, label: `${a.label}豁免`, mod: mods[a.key], prof: p, total: mods[a.key] + p };
  });

  return { tracks, stats, spellSlots, skills, saves, mods, prof, ac, hpMax, passivePerception: 10 + mods.wis + (isProficient(data, 'perception') ? prof : 0) };
}

function isProficient(data, skillKey) {
  return (data.proficiency.skills || []).includes(skillKey);
}
function isExpertise(data, skillKey) {
  return (data.proficiency.expertise || []).includes(skillKey);
}

function rollTargets(data) {
  const d = derive(data);
  return [
    {
      title: '属性检定',
      items: DND_ABILITIES.map(a => ({
        key: `ability:${a.key}`,
        label: `${a.label}检定`,
        value: d.mods[a.key],
        signed: true,
        versus: true,
        adv: true,
      })),
    },
    {
      title: '豁免检定',
      items: d.saves.map(s => ({
        key: `save:${s.key}`,
        label: s.label,
        value: s.total,
        signed: true,
        versus: true,
        adv: true,
      })),
    },
    {
      title: '技能检定',
      items: d.skills
        .slice()
        .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
        .map(s => ({
          key: `skill:${s.key}`,
          label: `${s.label}${s.expertise ? '（专精）' : s.prof ? '（熟练）' : ''}`,
          value: s.total,
          signed: true,
          versus: true,
          adv: true,
        })),
    },
    {
      title: '其他',
      items: [
        { key: 'initiative', label: '先攻', value: d.mods.dex, signed: true, versus: false, adv: true },
        { key: 'spellAttack', label: '法术攻击', value: d.prof + d.mods[data.spell.ability || 'int'], signed: true, versus: true, adv: true },
      ],
    },
  ];
}

function resolveBonus(data, req) {
  const d = derive(data);
  const key = req.targetKey || '';
  if (key === 'initiative') return { label: '先攻', bonus: d.mods.dex };
  if (key === 'spellAttack') return { label: '法术攻击', bonus: d.prof + d.mods[data.spell.ability || 'int'] };
  if (key.startsWith('ability:')) {
    const k = key.slice(8);
    const a = DND_ABILITIES.find(x => x.key === k);
    return { label: `${a ? a.label : k}检定`, bonus: d.mods[k] };
  }
  if (key.startsWith('save:')) {
    const k = key.slice(5);
    const s = d.saves.find(x => x.key === k);
    return { label: s ? s.label : `${k} 豁免`, bonus: s ? s.total : 0 };
  }
  if (key.startsWith('skill:')) {
    const k = key.slice(6);
    const s = d.skills.find(x => x.key === k);
    return { label: s ? s.label : k, bonus: s ? s.total : 0 };
  }
  return { label: req.targetLabel || '自定义检定', bonus: req.targetValue ?? 0 };
}

/**
 * d20 检定。
 * @param {object} req { targetKey, targetValue, targetLabel, dc, advantage, disadvantage, reason, extraMod }
 */
function roll(data, req, rng) {
  const { label, bonus } = req.targetKey || req.targetValue != null
    ? resolveBonus(data, req)
    : { label: '检定', bonus: 0 };

  const extra = req.extraMod || 0;
  const adv = !!req.advantage && !req.disadvantage;
  const dis = !!req.disadvantage && !req.advantage;

  const rolls = [rng.int(1, 20)];
  if (adv || dis) rolls.push(rng.int(1, 20));
  const kept = adv ? Math.max(...rolls) : dis ? Math.min(...rolls) : rolls[0];
  const dropped = rolls.length > 1 ? rolls.find(r => r !== kept) ?? null : null;

  const total = kept + bonus + extra;
  const dc = req.dc ?? null;

  let outcome = 'normal';
  if (kept === 20) outcome = 'critical';
  else if (kept === 1) outcome = 'fumble';

  let success = null;
  if (dc != null) {
    if (outcome === 'critical') success = true;
    else if (outcome === 'fumble') success = false;
    else success = total >= dc;
  }

  const outcomeLabel =
    outcome === 'critical' ? '天然 20 · 大成功'
      : outcome === 'fumble' ? '天然 1 · 大失败'
        : success == null ? '' : success ? '成功' : '失败';

  const modText = [
    bonus !== 0 ? `${bonus >= 0 ? '+' : ''}${bonus}` : '',
    extra !== 0 ? `${extra >= 0 ? '+' : ''}${extra}` : '',
  ].filter(Boolean).join(' ');

  const rollText = adv
    ? `d20 优势 [${rolls.join(', ')}] 取高 ${kept}`
    : dis
      ? `d20 劣势 [${rolls.join(', ')}] 取低 ${kept}`
      : `d20 = ${kept}`;

  const detail = [
    rollText,
    `${label}${modText ? ` ${modText}` : ''}`,
    dc != null ? `DC ${dc}` : '',
    `总计 ${total}`,
    outcomeLabel ? `结果：${outcomeLabel}` : '',
  ].filter(Boolean).join(' · ');

  return {
    ok: true,
    kind: 'check',
    system: 'dnd5e',
    title: `${label}${adv ? '（优势）' : dis ? '（劣势）' : ''}`,
    formula: `1d20${modText ? ` ${modText}` : ''}${dc != null ? ` vs DC ${dc}` : ''}`,
    rolls,
    kept,
    dropped,
    bonus: bonus + extra,
    total,
    dc,
    advantage: adv,
    disadvantage: dis,
    outcome,
    outcomeLabel: outcomeLabel || `${total}`,
    success,
    reason: req.reason || '',
    seed: rng.seed,
    consumed: rolls.length,
    detail,
    request: {
      targetKey: req.targetKey,
      targetLabel: label,
      targetValue: req.targetValue,
      dc,
      advantage: !!req.advantage,
      disadvantage: !!req.disadvantage,
      extraMod: extra,
      reason: req.reason || '',
    },
  };
}

/** 先攻：1d20 + 敏捷调整值 */
function initiative(data) {
  const mod = abilityMod(data.abilities.dex);
  return { kind: 'roll', expr: '1d20', mod, label: `1d20 ${mod >= 0 ? '+' : ''}${mod}（敏捷）` };
}

/**
 * 死亡豁免。角色在 0 生命值时每回合开始时投掷。
 * 10 以上记 1 次成功，9 以下记 1 次失败；天然 20 恢复 1 点生命并苏醒，天然 1 记 2 次失败。
 * 累计 3 次成功则伤势稳定，3 次失败则死亡。
 */
function deathSave(rng, state = {}) {
  const roll = rng.int(1, 20);
  let successes = state.successes || 0;
  let failures = state.failures || 0;

  let delta = '';
  if (roll === 20) {
    successes = 0;
    failures = 0;
    delta = '天然 20：恢复 1 点生命值并立刻苏醒';
  } else if (roll === 1) {
    failures += 2;
    delta = '天然 1：记 2 次失败';
  } else if (roll >= 10) {
    successes += 1;
    delta = '10 以上：记 1 次成功';
  } else {
    failures += 1;
    delta = '9 以下：记 1 次失败';
  }

  successes = Math.min(3, successes);
  failures = Math.min(3, failures);

  let status = 'rolling';
  let statusLabel = '继续投掷';
  if (roll === 20) { status = 'revived'; statusLabel = '苏醒'; }
  else if (successes >= 3) { status = 'stable'; statusLabel = '伤势稳定'; }
  else if (failures >= 3) { status = 'dead'; statusLabel = '死亡'; }

  return {
    ok: true,
    kind: 'deathsave',
    system: 'dnd5e',
    title: '死亡豁免',
    roll,
    successes,
    failures,
    status,
    statusLabel,
    success: status === 'stable' || status === 'revived' ? true : status === 'dead' ? false : null,
    outcomeLabel: statusLabel,
    seed: rng.seed,
    consumed: 1,
    detail: `d20 = ${roll} · ${delta} · 成功 ${successes}/3 · 失败 ${failures}/3 · ${statusLabel}`,
  };
}

/* ────────────────────────── 车卡规则 ────────────────────────── */

/** 12 个基础职业：生命骰、豁免熟练、可选技能数与技能表 */
export const DND_CLASSES = [
  { name: '野蛮人', hitDie: 12, saves: ['str', 'con'], skillCount: 2, skills: ['驯兽', '运动', '威吓', '自然', '察觉', '生存'] },
  { name: '吟游诗人', hitDie: 8, saves: ['dex', 'cha'], skillCount: 3, skills: 'any' },
  { name: '牧师', hitDie: 8, saves: ['wis', 'cha'], skillCount: 2, skills: ['历史', '洞悉', '医药', '说服', '宗教'] },
  { name: '德鲁伊', hitDie: 8, saves: ['int', 'wis'], skillCount: 2, skills: ['奥秘', '驯兽', '洞悉', '医药', '自然', '察觉', '宗教', '生存'] },
  { name: '战士', hitDie: 10, saves: ['str', 'con'], skillCount: 2, skills: ['体操', '驯兽', '运动', '历史', '洞悉', '威吓', '察觉', '生存'] },
  { name: '武僧', hitDie: 8, saves: ['str', 'dex'], skillCount: 2, skills: ['体操', '运动', '历史', '洞悉', '宗教', '隐匿'] },
  { name: '圣武士', hitDie: 10, saves: ['wis', 'cha'], skillCount: 2, skills: ['体操', '运动', '洞悉', '威吓', '医药', '说服', '宗教'] },
  { name: '游侠', hitDie: 10, saves: ['str', 'dex'], skillCount: 3, skills: ['驯兽', '运动', '洞悉', '调查', '自然', '察觉', '隐匿', '生存'] },
  { name: '游荡者', hitDie: 8, saves: ['dex', 'int'], skillCount: 4, skills: ['体操', '运动', '欺骗', '洞悉', '威吓', '调查', '察觉', '表演', '说服', '巧手', '隐匿'] },
  { name: '术士', hitDie: 6, saves: ['con', 'cha'], skillCount: 2, skills: ['奥秘', '欺骗', '洞悉', '威吓', '说服', '宗教'] },
  { name: '邪术师', hitDie: 8, saves: ['wis', 'cha'], skillCount: 2, skills: ['奥秘', '欺骗', '历史', '威吓', '调查', '自然', '宗教'] },
  { name: '法师', hitDie: 6, saves: ['int', 'wis'], skillCount: 2, skills: ['奥秘', '历史', '洞悉', '调查', '医药', '宗教'] },
];

/** 常见种族及其属性加值；半精灵的 +1×2 由玩家自选 */
export const DND_RACES = [
  { name: '人类', bonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 } },
  { name: '高等精灵', bonuses: { dex: 2, int: 1 } },
  { name: '木精灵', bonuses: { dex: 2, wis: 1 } },
  { name: '卓尔精灵', bonuses: { dex: 2, cha: 1 } },
  { name: '丘陵矮人', bonuses: { con: 2, wis: 1 } },
  { name: '山地矮人', bonuses: { con: 2, str: 2 } },
  { name: '轻足半身人', bonuses: { dex: 2, cha: 1 } },
  { name: '龙裔', bonuses: { str: 2, cha: 1 } },
  { name: '森林侏儒', bonuses: { int: 2, dex: 1 } },
  { name: '岩侏儒', bonuses: { int: 2, con: 1 } },
  { name: '半精灵', bonuses: { cha: 2 }, choices: { count: 2, amount: 1 } },
  { name: '半兽人', bonuses: { str: 2, con: 1 } },
  { name: '提夫林', bonuses: { cha: 2, int: 1 } },
];

const classOf = (name) => DND_CLASSES.find(c => c.name === name) || null;
const raceOf = (name) => DND_RACES.find(r => r.name === name) || null;

/** 把种族加值叠加到属性上，并记录加值便于反推 */
function applyRace(data, raceName, extraChoices = []) {
  const race = raceOf(raceName);
  const base = { ...(data.baseAbilities || data.abilities) };
  const bonuses = {};
  if (race) {
    for (const [k, v] of Object.entries(race.bonuses)) bonuses[k] = (bonuses[k] || 0) + v;
    if (race.choices) {
      for (const k of extraChoices.slice(0, race.choices.count)) {
        bonuses[k] = (bonuses[k] || 0) + race.choices.amount;
      }
    }
  }
  const abilities = { ...base };
  for (const [k, v] of Object.entries(bonuses)) abilities[k] = (abilities[k] || 0) + v;
  return { baseAbilities: base, abilities, raceBonuses: bonuses };
}

/** 1 级生命值 = 生命骰满值 + 体质调整值；更高等级按「取半+1」估算 */
function expectedHp(className, level, abilities) {
  const cls = classOf(className);
  if (!cls) return null;
  const conMod = abilityMod(abilities.con || 10);
  const avg = Math.floor(cls.hitDie / 2) + 1;
  return cls.hitDie + (level - 1) * avg + level * conMod;
}

function creationBudgets(data) {
  const cls = classOf(data.className);
  const n = (data.proficiency?.skills || []).length;
  const budget = [];

  if (data.creationMethod === 'pointbuy') {
    const base = data.baseAbilities || data.abilities;
    const cost = pointBuyCost(Object.values(base));
    budget.push({
      key: 'pointBuy', label: '点数购买', total: POINT_BUY_BUDGET,
      used: cost ?? 0, hint: cost == null ? '属性需在 8~15 之间' : '8~13 每点 1 分，14 需 7 分，15 需 9 分',
    });
  }

  if (cls) {
    budget.push({
      key: 'skillPicks', label: `${cls.name} 技能选择`,
      total: cls.skillCount, used: n, unit: '项',
      hint: cls.skills === 'any' ? '可从全部 18 项技能中选择' : `限：${cls.skills.join('、')}`,
    });
  }
  return makeBudgets(budget);
}

function creationValidate(data) {
  const v = validator();
  const abilities = data.abilities || {};
  const base = data.baseAbilities || abilities;

  /* 属性值 */
  for (const a of DND_ABILITIES) {
    const val = abilities[a.key];
    if (!Number.isFinite(val)) v.error(`attr.${a.key}`, `${a.label}未填写`);
    else if (val < 1 || val > 30) v.error(`attr.${a.key}`, `${a.label} ${val} 超出 1~30`);
    else if (val > 20 && (data.level || 1) <= 20) v.warn(`attr.${a.key}`, `${a.label} ${val} 超过 20，通常只有魔法物品或传奇恩赐能突破`);
  }

  /* 生成方式 */
  const method = data.creationMethod;
  if (method === 'standard') {
    if (!sameMultiset(Object.values(base), STANDARD_ARRAY)) {
      v.error('abilities', `标准数组必须是 ${STANDARD_ARRAY.join(' / ')} 的重新排列，当前为 ${Object.values(base).join(' / ')}`);
    }
  } else if (method === 'pointbuy') {
    const cost = pointBuyCost(Object.values(base));
    if (cost == null) v.error('abilities', '点数购买的属性值必须在 8~15 之间');
    else if (cost > POINT_BUY_BUDGET) v.error('abilities', `点数超出预算：已用 ${cost} / ${POINT_BUY_BUDGET}`);
  } else if (method === 'roll') {
    for (const val of Object.values(base)) {
      if (val < 3 || val > 18) v.warn('abilities', `掷骰生成的属性应在 3~18，当前有 ${val}`);
    }
  }

  /* 职业与技能 */
  const cls = classOf(data.className);
  if (!data.className) v.error('className', '还没选择职业');
  else if (!cls) v.warn('className', `「${data.className}」不在内置职业表里，无法校验技能与豁免`);

  if (cls) {
    const picked = data.proficiency?.skills || [];
    if (picked.length !== cls.skillCount) {
      v.error('skillPicks', `${cls.name} 需要恰好选 ${cls.skillCount} 项技能，当前 ${picked.length} 项`);
    }
    if (cls.skills !== 'any') {
      const allowed = new Set(cls.skills);
      // 只要不在本职业的技能表里就该拦下 —— 不能拿「是不是已知技能名」去豁免
      const bad = picked.filter(s => !allowed.has(s));
      if (bad.length) v.error('skillPicks', `这些技能不在 ${cls.name} 的技能表里：${bad.join('、')}`);
    }
    const saves = [...(data.proficiency?.saves || [])].sort().join(',');
    const expect = [...cls.saves].sort().join(',');
    if (saves !== expect) {
      v.error('saves', `${cls.name} 的豁免熟练应为 ${cls.saves.map(k => DND_ABILITIES.find(a => a.key === k)?.label).join('、')}`);
    }

    const hp = data.combat?.hpMax;
    const want = expectedHp(data.className, data.level || 1, abilities);
    if (Number.isFinite(hp) && want != null && hp !== want) {
      const msg = `生命上限应为 ${want}（${cls.hitDie} 面生命骰${(data.level || 1) > 1 ? '按升级取半+1' : '满值'} + 体质调整值 ${abilityMod(abilities.con || 10)}）`;
      if ((data.level || 1) === 1) v.error('hpMax', msg);
      else v.warn('hpMax', `${msg}；当前 ${hp}（升级时若选择掷骰，数值可以不同）`);
    }
  }

  /* 种族 */
  if (!data.race) v.warn('race', '还没选择种族');
  else if (!raceOf(data.race)) v.warn('race', `「${data.race}」不在内置种族表里，属性加值需自行确认`);
  else {
    const race = raceOf(data.race);
    for (const [k, want] of Object.entries(data.raceBonuses || {})) {
      const got = (abilities[k] || 0) - (base[k] || 0);
      if (got !== want) v.warn(`race.${k}`, `种族加值与记录不符：${k} 记的是 +${want}，实际 +${got}`);
    }
    if (race.choices) {
      const chosen = Object.keys(data.raceBonuses || {}).filter(k => !(k in race.bonuses));
      if (chosen.length !== race.choices.count) {
        v.error('race.choice', `${race.name} 需要自选 ${race.choices.count} 项属性各 +${race.choices.amount}，当前选了 ${chosen.length} 项`);
      }
    }
  }

  for (const b of creationBudgets(data)) {
    if (b.over) v.error(b.key, `${b.label}超出上限：${b.used} / ${b.total} ${b.unit}`);
  }

  return v.result;
}

const ALL_SKILL_LABELS = new Set(DND_SKILLS.map(s => s.label));

/** 行动预设。战斗轮到这个角色时，只能从已声明的行动里挑一个来结算。 */
export const DND_ACTION_PRESETS = [
  { name: '攻击', kind: 'action', target: 'enemy', check: { targetKey: 'ability:str' }, damage: '1d8+STR', note: '用长剑等力量武器攻击（改武器骰或换成 DEX 即可适用灵巧/远程武器）' },
  { name: '施法', kind: 'action', target: 'enemy', check: { targetKey: 'spellAttack' }, note: '施放一个法术' },
  { name: '疾跑', kind: 'action', target: 'self', note: '本回合获得额外移动力' },
  { name: '脱离', kind: 'action', target: 'self', note: '本回合的移动不引发借机攻击' },
  { name: '闪避', kind: 'action', target: 'self', note: '本回合针对你的攻击具有劣势' },
  { name: '协助', kind: 'action', target: 'ally', note: '给盟友下一次检定一次优势' },
  { name: '隐藏', kind: 'action', target: 'self', check: { targetKey: 'skill:stealth' } },
  { name: '搜索', kind: 'action', target: 'none', check: { targetKey: 'skill:investigation' } },
  { name: '准备', kind: 'action', target: 'none', note: '设定触发条件，届时用反应执行' },
  { name: '使用物品', kind: 'action', target: 'none' },
  { name: '附赠：二次攻击', kind: 'bonus', target: 'enemy', check: { targetKey: 'ability:str' }, damage: '1d8+STR' },
  { name: '借机攻击', kind: 'reaction', target: 'enemy', check: { targetKey: 'ability:str' }, damage: '1d8+STR' },
];

/**
 * 伤害骰式里的符号取值。预设写 `1d8+STR`，这里给出该角色当前的力量调整值。
 * 调整值自带正负号，展开时和模板里的运算符合并。
 */
export function damageVars(data) {
  const ab = data?.abilities || {};
  const signed = (key) => {
    const m = abilityMod(ab[key] ?? 10);
    return m >= 0 ? `+${m}` : `${m}`;
  };
  return { STR: signed('str'), DEX: signed('dex') };
}

export const DND_CREATION = {
  summary: '属性用「标准数组 / 点数购买 / 4d6 弃最低」三选一，再叠加种族加值；'
    + '职业决定生命骰、两项豁免熟练与可选技能数量，1 级生命值取生命骰满值加体质调整值。',
  attributes: {
    keys: DND_ABILITIES.map(a => a.key),
    labels: Object.fromEntries(DND_ABILITIES.map(a => [a.key, `${a.label} ${a.abbr}`])),
    min: 3,
    max: 20,
    methods: [
      { id: 'standard', label: '标准数组', hint: `${STANDARD_ARRAY.join(' / ')} 六个数值自行分配到属性上` },
      { id: 'pointbuy', label: `点数购买（${POINT_BUY_BUDGET} 点）`, hint: '基础值 8~15；8~13 每点 1 分，14 花 7 分，15 花 9 分' },
      { id: 'roll', label: '掷骰 4d6 弃最低', hint: '每个属性掷 4d6 去掉最低的一颗，再分配到属性上' },
    ],
    /** 标准数组可直接分配的数值池 */
    pool: STANDARD_ARRAY,
    roll(rng) { return Array.from({ length: 6 }, () => roll4d6dl1(rng)); },
    applyRace,
  },
  fields: [
    { key: 'className', label: '职业', type: 'select', options: DND_CLASSES.map(c => c.name) },
    { key: 'race', label: '种族', type: 'select', options: DND_RACES.map(r => r.name) },
    { key: 'level', label: '等级', type: 'number', min: 1, max: 20, default: 1 },
    { key: 'backgroundName', label: '背景', type: 'text', placeholder: '例如：智者、士兵' },
    { key: 'alignment', label: '阵营', type: 'text', placeholder: '例如：中立善良' },
  ],
  classTable: DND_CLASSES,
  raceTable: DND_RACES,
  budgets: creationBudgets,
  validate: creationValidate,
  expectedHp,
};

export default {
  id: 'dnd5e',
  name: '龙与地下城 5版',
  short: 'DND 5e',
  accent: '#8c3b3b',
  dieIcon: 'd20',
  abilities: DND_ABILITIES,
  skills: DND_SKILLS,
  commonDCs: [
    { id: 5, label: '非常简单' }, { id: 10, label: '简单' }, { id: 15, label: '中等' },
    { id: 20, label: '困难' }, { id: 25, label: '非常困难' }, { id: 30, label: '几乎不可能' },
  ],
  supportsDeathSave: true,
  createDefault,
  derive,
  rollTargets,
  roll,
  deathSave,
  initiative,
  creation: DND_CREATION,
  actionPresets: DND_ACTION_PRESETS,
  damageVars,
  abilityMod,
  proficiencyBonus,
};
