/**
 * 车卡（角色创建）的共用工具。
 *
 * 每套规则在 `ruleset.creation` 里描述自己的车卡规则，界面据此生成向导并校验。
 * 本模块只放与具体规则无关的部分：属性生成方式、点数购买换算、校验结果的组装。
 */

/* ────────────────────────── 校验结果 ────────────────────────── */

/**
 * 收集校验结果。
 *   error   违规，会阻止「完成车卡」
 *   warning 可疑，允许继续但会提示
 */
export function validator() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error(field, message) { errors.push({ field, message }); return this; },
    warn(field, message) { warnings.push({ field, message }); return this; },
    /** 条件成立时记一条 error */
    require(cond, field, message) { if (!cond) errors.push({ field, message }); return this; },
    get ok() { return errors.length === 0; },
    get result() { return { ok: errors.length === 0, errors, warnings }; },
  };
}

/* ────────────────────────── 属性生成 ────────────────────────── */

/** 3d6 × 5（COC 的常规属性） */
export function roll3d6x5(rng) {
  return (rng.int(1, 6) + rng.int(1, 6) + rng.int(1, 6)) * 5;
}

/** (2d6+6) × 5（COC 的体型 / 智力 / 教育） */
export function roll2d6p6x5(rng) {
  return (rng.int(1, 6) + rng.int(1, 6) + 6) * 5;
}

/** 4d6 弃最低（DND 经典） */
export function roll4d6dl1(rng) {
  const dice = [rng.int(1, 6), rng.int(1, 6), rng.int(1, 6), rng.int(1, 6)].sort((a, b) => b - a);
  return dice[0] + dice[1] + dice[2];
}

/** DND 标准数组 */
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

/** DND 5e 点数购买：单点花费 */
const POINT_BUY_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
export const POINT_BUY_BUDGET = 27;

/** 一组属性值在点数购买下的总花费；超出 8~15 范围返回 null */
export function pointBuyCost(values) {
  let total = 0;
  for (const v of values) {
    if (POINT_BUY_COST[v] === undefined) return null;
    total += POINT_BUY_COST[v];
  }
  return total;
}

/* ────────────────────────── 预算统计 ────────────────────────── */

/**
 * 把一组「已用 / 总额」整理成统一的展示结构。
 * @param {Array} items [{ key, label, total, used, unit?, hint? }]
 */
export function makeBudgets(items) {
  return items.map(b => ({
    ...b,
    unit: b.unit ?? '点',
    remaining: b.total - b.used,
    over: b.used > b.total,
  }));
}

/** 汇总若干预算，供校验用 */
export function checkBudgets(budgets, v) {
  for (const b of budgets) {
    if (b.over) {
      v.error(b.key, `${b.label}超出上限：已用 ${b.used} / 共 ${b.total} ${b.unit}`);
    }
  }
  return v;
}

/* ────────────────────────── 通用小工具 ────────────────────────── */

/** 把数组里的值与目标做多重集比较，用于「起始数组必须原样用完」这类校验 */
export function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const x = [...a].sort((m, n) => m - n);
  const y = [...b].sort((m, n) => m - n);
  return x.every((v, i) => v === y[i]);
}

/** 取属性值的调整值（DND 用） */
export function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

/** 深拷贝，避免向导中途改动污染原对象 */
export function cloneJSON(v) {
  return JSON.parse(JSON.stringify(v));
}
