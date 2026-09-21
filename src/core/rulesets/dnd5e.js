/**
 * 龙与地下城 5 版（Dungeons & Dragons 5th Edition）规则适配层。
 *
 * 判定核心：d20 + 属性调整值 + 熟练加值 对抗 DC，含优势 / 劣势与天然 20 / 天然 1。
 */

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
    proficiency: { skills: [], saves: [], expertise: [] },
    combat: {
      hpMax: 10, hp: null, tempHp: 0, hitDice: '1d8', hitDiceUsed: 0,
      armorBase: 10, dexCap: null, shield: 0, miscAC: 0, speed: 30,
      deathSuccess: 0, deathFail: 0,
    },
    spell: { ability: 'int', slotsUsed: {}, prepared: '', notes: '' },
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
  abilityMod,
  proficiencyBonus,
};
