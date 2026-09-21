/**
 * 通用骰子引擎。
 *
 * 设计目标：「支持所有骰子的判定」——
 *   1. 任意骰式 NdM（含 d2 到 d1000、dF 命运骰、d%）
 *   2. 完整修饰符：取高/取低/弃高/弃低、爆炸、重掷、上下限、成功计数
 *   3. 百分骰奖惩骰（COC）、优势劣势（DND）、双重骰（匕首心）由规则层组合实现
 *   4. 每次掷骰带种子，可在日志中复现与校验
 *
 * ── 骰式语法 ────────────────────────────────────────────────
 *   3d6            三个六面骰求和
 *   1d100 / d%     百分骰
 *   2d20kh1        优势（取高）
 *   2d20kl1        劣势（取低）
 *   4d6dl1         弃最低（经典属性生成）
 *   4d6dh1         弃最高
 *   6d6>=5         成功计数（数出 >=5 的骰子个数）
 *   1d6!           爆炸骰（掷出最大值则续掷并累加）
 *   4dF            命运骰（-1 / 0 / +1）
 *   2d6r1          重掷直到不是 1
 *   2d6ro1         只重掷一次 1
 *   2d6min2        单骰下限 2
 *   3d8+2-1d4      多项加减混合
 */

import { RNG, newSeed } from './rng.js';

const MAX_EXPLOSIONS = 50;
const MAX_REROLLS = 50;

export class DiceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiceError';
  }
}

/* ────────────────────────────── 解析 ────────────────────────────── */

function readNumber(str, from) {
  let j = from;
  while (j < str.length && str[j] >= '0' && str[j] <= '9') j++;
  const len = j - from;
  return { value: len ? parseInt(str.slice(from, j), 10) : null, len };
}

/** 扫描修饰符串，如 `kh1!` 或 `dl1>=5` */
function parseModifiers(str, termText) {
  const mods = [];
  let i = 0;
  while (i < str.length) {
    const rest = str.slice(i);
    let m;
    if ((m = /^(kh|kl|dh|dl|cs|cf)/.exec(rest))) {
      const n = readNumber(rest, 2);
      mods.push({ type: m[1], value: n.value });
      i += 2 + n.len;
    } else if (rest.startsWith('!!')) {
      mods.push({ type: 'explode', compounding: true });
      i += 2;
    } else if (rest.startsWith('!')) {
      mods.push({ type: 'explode', compounding: false });
      i += 1;
    } else if ((m = /^(>=|<=|>|<|=)/.exec(rest))) {
      const n = readNumber(rest, m[1].length);
      if (n.value === null) throw new DiceError(`「${termText}」中的比较符 ${m[1]} 后面缺少数字`);
      mods.push({ type: 'compare', op: m[1], value: n.value });
      i += m[1].length + n.len;
    } else if ((m = /^(min|max)/.exec(rest))) {
      const n = readNumber(rest, 3);
      if (n.value === null) throw new DiceError(`「${termText}」中的 ${m[1]} 后面缺少数字`);
      mods.push({ type: m[1], value: n.value });
      i += 3 + n.len;
    } else if (rest.startsWith('k')) {
      const n = readNumber(rest, 1);
      mods.push({ type: 'kh', value: n.value ?? 1 });
      i += 1 + n.len;
    } else if (rest.startsWith('r')) {
      let j = 1;
      let once = false;
      let op = '=';
      if (rest[1] === 'o') { once = true; j = 2; }
      if (rest[j] === '<' || rest[j] === '>' || rest[j] === '=') { op = rest[j]; j++; }
      const n = readNumber(rest, j);
      if (n.value === null) throw new DiceError(`「${termText}」中的重掷 r 后面缺少数字`);
      mods.push({ type: 'reroll', op, value: n.value, once });
      i += j + n.len;
    } else {
      throw new DiceError(`无法识别的骰子修饰符：「${rest}」（出现在 ${termText} 中）`);
    }
  }
  return mods;
}

const DICE_RE = /^(\d*)[dD](\d+|%|[fF])([\s\S]*)$/;

/**
 * 把骰式解析为项数组。
 * @returns {{src:string, terms:Array, normalized:string}}
 */
export function parseExpression(input) {
  const src = String(input ?? '').trim();
  if (!src) throw new DiceError('骰式为空');
  const squashed = src.replace(/\s+/g, '');

  // 按顶层 +/- 切分（修饰符不使用 +/-，因此安全）
  const raw = [];
  let sign = 1;
  let buf = '';
  let pendingSign = false;
  for (let i = 0; i < squashed.length; i++) {
    const c = squashed[i];
    if (c === '+' || c === '-') {
      if (buf) { raw.push({ sign, text: buf }); buf = ''; }
      else if (raw.length) throw new DiceError(`骰式「${src}」中出现了连续运算符`);
      sign = c === '+' ? 1 : -1;
      pendingSign = true;
    } else {
      buf += c;
      pendingSign = false;
    }
  }
  if (pendingSign) throw new DiceError(`骰式「${src}」以运算符结尾，后面缺少内容`);
  if (buf) raw.push({ sign, text: buf });
  if (!raw.length) throw new DiceError(`骰式「${src}」不包含任何项`);

  const terms = raw.map(({ sign: sg, text }) => {
    const dm = DICE_RE.exec(text);
    if (dm) {
      const count = dm[1] === '' ? 1 : parseInt(dm[1], 10);
      const sidesRaw = dm[2];
      const fudge = sidesRaw === 'f' || sidesRaw === 'F';
      const sides = fudge ? 3 : sidesRaw === '%' ? 100 : parseInt(sidesRaw, 10);
      if (count <= 0) throw new DiceError(`骰子个数必须大于 0：「${text}」`);
      if (count > 1000) throw new DiceError(`单次掷骰个数上限 1000：「${text}」`);
      if (!fudge && (sides < 2 || sides > 100000)) throw new DiceError(`骰子面数必须在 2~100000 之间：「${text}」`);
      const mods = parseModifiers(dm[3] || '', text);
      return { kind: 'dice', sign: sg, text, count, sides, fudge, mods, notation: normalizeDice(count, sidesRaw, mods) };
    }
    if (/^\d+$/.test(text)) {
      return { kind: 'const', sign: sg, text, value: parseInt(text, 10) };
    }
    throw new DiceError(`无法解析的项：「${text}」。骰式形如 3d6+2、4d6dl1、2d20kh1、6d6>=5`);
  });

  return { src, terms, normalized: terms.map(t => (t.sign < 0 ? '-' : '+') + t.text).join('').replace(/^\+/, '') };
}

function normalizeDice(count, sidesRaw, mods) {
  let s = `${count}d${sidesRaw}`;
  for (const m of mods) {
    switch (m.type) {
      case 'kh': s += `kh${m.value}`; break;
      case 'kl': s += `kl${m.value}`; break;
      case 'dh': s += `dh${m.value}`; break;
      case 'dl': s += `dl${m.value}`; break;
      case 'explode': s += m.compounding ? '!!' : '!'; break;
      case 'reroll': s += `r${m.once ? 'o' : ''}${m.op === '=' ? '' : m.op}${m.value}`; break;
      case 'min': s += `min${m.value}`; break;
      case 'max': s += `max${m.value}`; break;
      case 'compare': s += `${m.op}${m.value}`; break;
      case 'cs': s += `cs${m.value == null ? '' : m.value}`; break;
      case 'cf': s += `cf${m.value == null ? '' : m.value}`; break;
    }
  }
  return s;
}

/* ────────────────────────────── 投掷 ────────────────────────────── */

function faceValue(sides, fudge, rng) {
  if (fudge) return rng.int(-1, 1);
  return rng.int(1, sides);
}

function matchesOp(value, op, target) {
  switch (op) {
    case '>': return value > target;
    case '<': return value < target;
    case '>=': return value >= target;
    case '<=': return value <= target;
    case '=': return value === target;
    default: return false;
  }
}

function rollSingleDie(sides, fudge, rng, mods) {
  const rec = { faces: [], v: 0, kept: true, dropped: null };
  let v = faceValue(sides, fudge, rng);
  rec.faces.push(v);

  // 重掷
  for (const m of mods) {
    if (m.type !== 'reroll') continue;
    let guard = 0;
    while (matchesOp(v, m.op, m.value) && guard < (m.once ? 1 : MAX_REROLLS)) {
      guard++;
      v = faceValue(sides, fudge, rng);
      rec.faces.push(v);
    }
  }

  // 爆炸
  const ex = mods.find(m => m.type === 'explode');
  if (ex) {
    const maxFace = fudge ? 1 : sides;
    let guard = 0;
    let extra = 0;
    let cur = v;
    const boom = [];
    while (cur === maxFace && guard < MAX_EXPLOSIONS) {
      guard++;
      cur = faceValue(sides, fudge, rng);
      rec.faces.push(cur);
      boom.push(cur);
      if (ex.compounding) extra = -1; // 复合型：只累加，不额外计骰
    }
    if (!ex.compounding) extra = boom.reduce((a, b) => a + b, 0);
    else extra = boom.reduce((a, b) => a + b, 0);
    v += extra;
    rec.exploded = boom.length > 0;
    rec.explosionFaces = boom;
  }

  // 上下限
  for (const m of mods) {
    if (m.type === 'min' && v < m.value) v = m.value;
    if (m.type === 'max' && v > m.value) v = m.value;
  }

  rec.v = v;
  return rec;
}

function evalDiceTerm(term, rng) {
  const { count, sides, fudge, mods, sign } = term;
  const dice = [];
  for (let i = 0; i < count; i++) dice.push(rollSingleDie(sides, fudge, rng, mods));

  // 取高/取低/弃高/弃低
  const kh = mods.find(m => m.type === 'kh');
  const kl = mods.find(m => m.type === 'kl');
  const dh = mods.find(m => m.type === 'dh');
  const dl = mods.find(m => m.type === 'dl');
  let keepCount = null;
  let keepMode = null;
  if (kh) { keepCount = Math.min(kh.value, count); keepMode = 'highest'; }
  else if (kl) { keepCount = Math.min(kl.value, count); keepMode = 'lowest'; }
  else if (dh) { keepCount = Math.max(count - dh.value, 0); keepMode = 'lowest'; }
  else if (dl) { keepCount = Math.max(count - dl.value, 0); keepMode = 'highest'; }

  if (keepCount !== null) {
    const order = dice
      .map((d, i) => ({ i, v: d.v }))
      .sort((a, b) => (keepMode === 'highest' ? b.v - a.v : a.v - b.v) || a.i - b.i);
    const keepIdx = new Set(order.slice(0, keepCount).map(o => o.i));
    dice.forEach((d, i) => {
      d.kept = keepIdx.has(i);
      if (!d.kept) d.dropped = keepMode === 'highest' ? 'lowest' : 'highest';
    });
  }

  // 成功计数
  const compare = mods.find(m => m.type === 'compare');
  const cs = mods.find(m => m.type === 'cs');
  const cf = mods.find(m => m.type === 'cf');
  const counting = !!(compare || cs || cf);

  if (counting) {
    const successOp = cs ? { op: '>=', value: cs.value ?? 1 } : { op: compare?.op ?? '>=', value: compare?.value ?? 1 };
    const failOp = cf ? { op: '<=', value: cf.value ?? 1 } : null;
    let successes = 0;
    let failures = 0;
    for (const d of dice) {
      if (!d.kept) continue;
      d.success = matchesOp(d.v, successOp.op, successOp.value);
      d.failure = failOp ? matchesOp(d.v, failOp.op, failOp.value) : false;
      if (d.success) successes++;
      if (d.failure) failures++;
    }
    const net = failures > 0 ? successes - failures : successes;
    return {
      kind: 'dice',
      sign,
      text: term.text,
      notation: term.notation,
      count,
      sides,
      fudge,
      dice,
      mode: 'count',
      successes,
      failures,
      value: net,
      critRule: successOp,
      failRule: failOp,
    };
  }

  const value = dice.filter(d => d.kept).reduce((a, d) => a + d.v, 0);
  return {
    kind: 'dice',
    sign,
    text: term.text,
    notation: term.notation,
    count,
    sides,
    fudge,
    dice,
    mode: 'sum',
    value,
  };
}

/**
 * 掷一个骰式。
 * @param {string} expr
 * @param {{seed?:string, rng?:RNG}} [opts]
 * @returns {object} RollResult
 */
export function rollExpr(expr, opts = {}) {
  const parsed = parseExpression(expr);
  const rng = opts.rng || new RNG(opts.seed || newSeed());
  const startCount = rng.count;

  const terms = parsed.terms.map(t => {
    if (t.kind === 'const') return { kind: 'const', sign: t.sign, text: t.text, value: t.value };
    return evalDiceTerm(t, rng);
  });

  let total = 0;
  for (const t of terms) total += t.sign * t.value;

  const result = {
    ok: true,
    kind: 'expr',
    expr: parsed.normalized,
    input: parsed.src,
    seed: rng.seed,
    consumed: rng.count - startCount,
    startIndex: startCount,
    terms,
    total,
  };
  result.detail = describeRoll(result);
  return result;
}

/* ──────────────────────────── 文字化 ──────────────────────────── */

function dieText(d) {
  const base = d.faces.length > 1 ? d.faces.join('!+') : String(d.v);
  if (!d.kept) return `(${base} 弃)`;
  return base;
}

/** 把一次掷骰渲染成适合写进日志的一行文本 */
export function describeRoll(result) {
  if (!result || !result.terms) return '';
  const pieces = [];
  for (const t of result.terms) {
    const p = t.sign < 0 ? '-' : pieces.length ? '+' : '';
    if (t.kind === 'const') {
      pieces.push(`${p}${t.value}`);
      continue;
    }
    if (t.mode === 'count') {
      const hits = t.dice.filter(d => d.kept && d.success).length;
      const miss = t.dice.filter(d => d.kept && d.failure).length;
      const faces = t.dice.map(dieText).join(', ');
      pieces.push(`${p}${t.notation}[${faces}] → 成功 ${hits}${t.failRule ? ` / 失败 ${miss}` : ''}`);
      continue;
    }
    const faces = t.dice.map(dieText).join(', ');
    pieces.push(`${p}${t.notation}[${faces}]`);
  }
  const exprPart = pieces.join(' ').replace(/^\+/, '').trim();
  return `${exprPart} = ${result.total}`;
}

/* ─────────────────────── 低阶工具（供规则层用） ─────────────────────── */

/** 掷 N 个 M 面骰，返回点数数组 */
export function rollDice(count, sides, rng) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(rng.int(1, sides));
  return out;
}

/**
 * 百分骰 + 奖惩骰（COC 7 版核心机制）。
 * 单位骰共用，十位骰多掷若干个，取最小（奖励）或最大（惩罚）。
 * 结果 00 视为 100。
 */
export function rollPercentile(rng, { bonus = 0, penalty = 0 } = {}) {
  const units = rng.int(0, 9);
  const tensCount = 1 + Math.abs(bonus - penalty);
  const tens = [];
  for (let i = 0; i < tensCount; i++) tens.push(rng.int(0, 9));

  let chosen;
  if (bonus > penalty) chosen = Math.min(...tens);
  else if (penalty > bonus) chosen = Math.max(...tens);
  else chosen = tens[0];

  let value = chosen * 10 + units;
  if (value === 0) value = 100;
  return { value, units, tens, chosen, rawTens: tens };
}

export { RNG, newSeed };
