/**
 * 可复现随机数发生器。
 *
 * 记录系统的核心要求之一：任何一次掷骰都必须可复现、可审计。
 * 因此我们不使用 Math.random()，而是用「种子 + 计数器」的方式，
 * 日志里保存 seed 与 rollIndex，任何人拿着同样的种子就能重放出完全相同的点数。
 */

/** 字符串 → 32 位整数散列（xmur3），用于把人类可读的种子变成数字状态。 */
export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32：小巧、快速、分布良好的 32 位 PRNG。 */
export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成一个适合人类朗读/抄写的随机种子。 */
export function newSeed() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export class RNG {
  /** @param {string} seed 任意字符串种子 */
  constructor(seed) {
    this.seed = String(seed ?? newSeed());
    this.reset();
  }

  reset() {
    this.count = 0;
    this._rand = mulberry32(xmur3(this.seed)());
  }

  /** [0, 1) 浮点 */
  next() {
    this.count++;
    return this._rand();
  }

  /** [min, max] 闭区间整数 */
  int(min, max) {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** 从数组中等概率取一个元素 */
  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }
}

/**
 * 重放：用同一种子重新掷一遍，用于校验日志中的记录是否被篡改。
 * @param {string} seed
 * @param {number} count 要消耗的随机数个数
 */
export function replay(seed, count) {
  const rng = new RNG(seed);
  const out = [];
  for (let i = 0; i < count; i++) out.push(rng.next());
  return out;
}
