/**
 * 行动（Action）。
 *
 * 类比《博德之门 3》角色状态栏里那排可选行动：角色卡与 NPC 上都有一组
 * **声明好的行动**，战斗轮到谁，就只从这组里挑一个来结算 ——
 * 而不是临时想起什么技能就掷什么。
 *
 * 一个行动就是「一次判定的完整描述」：
 *   check   传给 ruleset.roll() 的判定请求（各系统自己解释）
 *   damage  判定成功后追加掷的伤害骰（可选）
 *   cost    消耗的资源（可选，按系统而定）
 *   kind    行动经济：主要 / 附赠 / 反应 / 自由
 *
 * 这样它天然复用已有的判定与骰子引擎，不需要为每套规则再写一套结算。
 */

import { rollExpr } from './dice.js';

/** 行动经济：不同系统的分类 */
export const ACTION_KINDS = {
  dnd5e: [
    { id: 'action', label: '主要动作', hint: '每回合一次' },
    { id: 'bonus', label: '附赠动作', hint: '每回合最多一次' },
    { id: 'reaction', label: '反应', hint: '每轮一次，在别人的回合触发' },
    { id: 'free', label: '自由动作', hint: '不消耗行动经济' },
  ],
  coc7: [
    { id: 'action', label: '行动', hint: '一轮内可做一次主要行动' },
    { id: 'reaction', label: '反应', hint: '被攻击时的应对' },
    { id: 'free', label: '自由行动', hint: '顺带完成的小动作' },
  ],
  daggerheart: [
    { id: 'action', label: '行动判定', hint: '掷双重骰，产生希望/恐惧' },
    { id: 'reaction', label: '反应判定', hint: '不产生希望/恐惧' },
    { id: 'free', label: '自由行动', hint: '无需判定的描述性动作' },
  ],
  huazhu: [
    { id: 'action', label: '行动判定', hint: '掷双重骰，产生希望/恐惧' },
    { id: 'reaction', label: '反应判定', hint: '不产生希望/恐惧' },
    { id: 'free', label: '自由行动', hint: '无需判定的描述性动作' },
  ],
};

export function kindsFor(rulesetId) {
  return ACTION_KINDS[rulesetId] || ACTION_KINDS.daggerheart;
}

/** 目标范围，仅作提示，不影响结算 */
export const ACTION_TARGETS = [
  { id: 'enemy', label: '一个敌人' },
  { id: 'ally', label: '一个盟友' },
  { id: 'self', label: '自己' },
  { id: 'area', label: '范围内多个目标' },
  { id: 'none', label: '无目标' },
];

let seq = 0;
function newId() {
  seq += 1;
  return `act_${Date.now().toString(36)}${seq.toString(36)}`;
}

/** 造一个空白行动，字段齐全，避免下游拿到 undefined */
export function blankAction(overrides = {}) {
  return {
    id: newId(),
    name: '新行动',
    kind: 'action',
    target: 'enemy',
    /** 判定请求：各系统的 ruleset.roll() 直接吃这个对象 */
    check: {},
    /** 判定成功后追加掷的伤害骰 */
    damage: '',
    /** 资源消耗，键名按系统而定（hope / stress / armor / luck …） */
    cost: {},
    note: '',
    ...overrides,
  };
}

/** 从规则集给的预设生成一个行动实例 */
export function actionFromPreset(preset) {
  return blankAction({
    name: preset.name,
    kind: preset.kind || 'action',
    target: preset.target || 'enemy',
    check: { ...(preset.check || {}) },
    damage: preset.damage || '',
    cost: { ...(preset.cost || {}) },
    note: preset.note || '',
  });
}

/** 补齐旧数据里缺字段的行动 */
export function normalizeAction(a) {
  return {
    id: a?.id || newId(),
    name: a?.name || '未命名行动',
    kind: a?.kind || 'action',
    target: a?.target || 'none',
    check: a?.check && typeof a.check === 'object' ? a.check : {},
    damage: a?.damage || '',
    cost: a?.cost && typeof a.cost === 'object' ? a.cost : {},
    note: a?.note || '',
  };
}

export function normalizeActions(list) {
  return Array.isArray(list) ? list.map(normalizeAction) : [];
}

/** 某个行动属于哪一类（用于在界面上分组） */
export function kindLabel(rulesetId, kind) {
  return kindsFor(rulesetId).find(k => k.id === kind)?.label || kind;
}

/** 资源消耗的中文名 */
export const COST_LABELS = {
  hope: '希望',
  stress: '压力',
  armor: '护甲槽',
  luck: '幸运',
  hp: '生命',
};

/** 把消耗渲染成一行文字，没有消耗则返回空串 */
export function describeCost(cost) {
  const parts = Object.entries(cost || {})
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${COST_LABELS[k] || k} −${v}`);
  return parts.join('，');
}

/**
 * 行动的一句话摘要，用于列表与日志。
 * @param {object} action
 * @param {object} [opts] { checkLabel } 由界面把 targetKey 翻成可读名字
 */
export function describeAction(action, opts = {}) {
  const a = normalizeAction(action);
  const parts = [];
  if (opts.checkLabel) parts.push(opts.checkLabel);
  else if (a.check?.targetLabel) parts.push(a.check.targetLabel);
  if (a.damage) parts.push(`伤害 ${a.damage}`);
  const cost = describeCost(a.cost);
  if (cost) parts.push(`消耗 ${cost}`);
  return parts.join(' · ');
}

/* ────────────────────────── 伤害骰式里的符号 ────────────────────────── */

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把伤害骰式里的符号换成行动者的实际数值。
 *
 * 预设里写 `1d3+DB`（克苏鲁的伤害加值）或 `1d8+STR`（D&D 的力量调整值），
 * 规则集通过可选的 `damageVars(data)` 给出这些符号当前的值。
 * 替换后可能叠出 `++` / `+-` 这类符号，一并规整掉。
 */
export function expandDamageExpr(rs, data, expr) {
  let out = String(expr || '').trim();
  if (!out) return out;
  const vars = typeof rs.damageVars === 'function' ? rs.damageVars(data) : null;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      if (v == null) continue;
      out = out.replace(new RegExp(`\\b${escapeRe(k)}\\b`, 'gi'), String(v));
    }
  }
  return out.replace(/\s+/g, '').replace(/\+-|-\+/g, '-').replace(/\+\+|--/g, '+');
}

/* ────────────────────────── 行动经济的使用情况 ────────────────────────── */

/**
 * 行动经济的重置周期：
 *   turn  —— 每回合刷新（D&D 的主要动作、附赠动作）
 *   round —— 每轮刷新（反应；一轮里只能做一次，不分是谁的回合）
 *   none  —— 不消耗
 */
export const ACTION_KIND_SCOPE = { action: 'turn', bonus: 'turn', reaction: 'round', free: 'none' };

export function scopeOf(kind) {
  return ACTION_KIND_SCOPE[kind] || 'turn';
}

/** 某个参战者已经用掉的行动经济（usage 形如 { 参战者id: { action: true } }） */
export function spentKinds(usage, actorId) {
  const u = usage?.[actorId];
  return u && typeof u === 'object' ? u : {};
}

/** 这一类行动现在还能不能做 */
export function canUseKind(usage, actorId, kind) {
  if (scopeOf(kind) === 'none') return true;
  return !spentKinds(usage, actorId)[kind];
}

/** 记下用掉了一类行动经济；返回新的 usage，不改原对象 */
export function markKindUsed(usage, actorId, kind) {
  const next = { ...(usage || {}) };
  if (scopeOf(kind) === 'none' || actorId == null) return next;
  next[actorId] = { ...(next[actorId] || {}), [kind]: true };
  return next;
}

/**
 * 回合推进后刷新可用度：走进新一轮时所有人都拿回「每轮」类，
 * 轮到谁谁拿回「每回合」类。原地改 usage（它属于战斗状态）。
 */
export function refreshUsage(usage, actorId, advancedRound = false) {
  const u = usage || {};
  if (advancedRound) {
    for (const id of Object.keys(u)) {
      const own = { ...u[id] };
      delete own.reaction;
      u[id] = own;
    }
  }
  if (actorId != null) {
    const own = { ...(u[actorId] || {}) };
    delete own.action;
    delete own.bonus;
    u[actorId] = own;
  }
  return u;
}

/* ────────────────────────── 结算 ────────────────────────── */

/**
 * 执行一个行动。
 *
 * 完全复用规则集已有的 roll()：行动的 check 字段就是判定请求本身，
 * 所以不需要为每套规则再写一份结算逻辑。
 *
 * @param {object} rs      规则集
 * @param {object} data    行动者数据（角色或 NPC）
 * @param {object} action  行动
 * @param {object} rng     随机源
 * @returns {{action, check, damage, total, seed}}
 */
export function resolveAction(rs, data, action, rng) {
  const a = normalizeAction(action);

  const req = { ...a.check };
  // 反应类行动在匕首心/华渚里不产生希望与恐惧
  if (a.kind === 'reaction' && (rs.id === 'daggerheart' || rs.id === 'huazhu')) {
    req.rollType = 'reaction';
  }
  if (!req.targetKey && req.targetValue == null) {
    req.targetLabel = req.targetLabel || '无判定';
  }

  const check = rs.roll(data, req, rng);

  // 判定失败就不掷伤害；success 为 null（未设难度）时照常掷
  let damage = null;
  if (a.damage && check.success !== false) {
    // `1d3+DB` 这类符号先换成行动者的实际数值再掷
    const expr = expandDamageExpr(rs, data, a.damage);
    try {
      damage = rollExpr(expr, { rng });
    } catch {
      damage = { ok: false, error: `伤害骰式无效：${a.damage}` };
    }
  }

  return {
    action: a,
    check,
    damage,
    damageTotal: damage?.ok ? damage.total : null,
    seed: rng.seed,
  };
}

/** 把一次行动的结算渲染成日志用的一行文本 */
export function describeActionResult(res) {
  const parts = [res.check?.detail || ''];
  if (res.damage?.ok) parts.push(`伤害 ${res.damage.expr} = ${res.damage.total}`);
  else if (res.damage && !res.damage.ok) parts.push(res.damage.error);
  return parts.filter(Boolean).join(' · ');
}
