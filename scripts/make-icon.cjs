/**
 * 生成应用图标 build/icon.png（256×256，PNG）。
 *
 * 不依赖任何图像库：手写 PNG 编码（zlib 压缩 + CRC32），
 * 图形用「4 倍超采样 + 盒式降采样」拿到平滑边缘。
 * electron-builder 会拿这张 PNG 自动生成各尺寸的 .ico。
 *
 * 用法：node scripts/make-icon.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const SS = 4;                      // 超采样倍数
const N = SIZE * SS;

/* ────────────────────────── PNG 编码 ────────────────────────── */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgba: Uint8Array 长度 w*h*4 */
function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // 位深
  ihdr[9] = 6;    // 颜色类型：RGBA
  ihdr[10] = 0;   // 压缩
  ihdr[11] = 0;   // 滤波
  ihdr[12] = 0;   // 非隔行

  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;    // 滤波类型 None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ────────────────────────── 绘图 ────────────────────────── */

const canvas = new Float32Array(N * N * 4);   // 线性空间，稍后降采样

function mix(a, b, t) { return a + (b - a) * t; }

/** 圆角矩形：返回覆盖度 0..1 */
function roundRect(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(x - cx) - (halfW - r);
  const dy = Math.abs(y - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const d = outside + Math.min(Math.max(dx, dy), 0) - r;
  return Math.max(0, Math.min(1, 0.5 - d));
}

/** 点到线段距离 */
function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** 描边：返回覆盖度 0..1 */
function stroke(px, py, pts, width) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, distToSeg(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  return Math.max(0, Math.min(1, 0.5 + (width / 2 - d)));
}

function paint(x, y, [r, g, b, a]) {
  if (a <= 0) return;
  const i = (y * N + x) * 4;
  const inv = 1 - a;
  canvas[i] = canvas[i] * inv + r * a;
  canvas[i + 1] = canvas[i + 1] * inv + g * a;
  canvas[i + 2] = canvas[i + 2] * inv + b * a;
  canvas[i + 3] = canvas[i + 3] * inv + a;
}

/* 图形参数（都按 0..1 归一化，乘以 N） */
const C = 0.5;
const PX = 1 / N;          // 一个采样像素在归一化坐标下的边长

/**
 * 圆角矩形：返回覆盖度 0..1。
 * 注意 d 是归一化坐标下的有向距离，要除以 PX 才是「像素」。
 * 早先这里写成 0.5 - d，等于把半个图像当成一个像素，整张图会被糊满。
 */
function roundRect(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(x - cx) - (halfW - r);
  const dy = Math.abs(y - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const d = outside + Math.min(Math.max(dx, dy), 0) - r;
  return Math.max(0, Math.min(1, 0.5 - d / PX));
}

/** 点到线段距离 */
function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** 描边：返回覆盖度 0..1 */
function stroke(px, py, pts, width) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, distToSeg(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  return Math.max(0, Math.min(1, 0.5 + (width / 2 - d) / PX));
}

const LINE = 0.028;                   // 线宽（归一化）

/* 几何：经典 d20 构图 —— 外圈六边形 + 内部倒三角 + 三条刻面线 */
const R = 0.36;                       // 六边形外接圆半径
const hex = [];
for (let i = 0; i < 6; i++) {
  const ang = -Math.PI / 2 + i * Math.PI / 3;      // 顶点朝上
  hex.push([C + R * Math.cos(ang), C + R * Math.sin(ang)]);
}
hex.push(hex[0]);

const tri = [
  [C, C + R * 0.58],
  [C - R * 0.53, C - R * 0.31],
  [C + R * 0.53, C - R * 0.31],
];
const triClosed = [...tri, tri[0]];

// 从六边形顶点连到三角形顶点，做出刻面感
const facets = [
  [hex[0], tri[1]],
  [hex[2], tri[2]],
  [hex[4], tri[0]],
];

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const px = (x + 0.5) / N;
    const py = (y + 0.5) / N;

    // 1) 底板：深色圆角方块 + 自上而下的渐变
    const bg = roundRect(px, py, C, C, 0.5, 0.5, 0.22);
    if (bg > 0) {
      const t = py;
      paint(x, y, [
        mix(0x24 / 255, 0x14 / 255, t),
        mix(0x2c / 255, 0x17 / 255, t),
        mix(0x3d / 255, 0x20 / 255, t),
        bg,
      ]);
    }

    // 2) 内圈描边，做出一点层次
    const inner = roundRect(px, py, C, C, 0.455, 0.455, 0.19);
    if (inner > 0 && inner < 1) paint(x, y, [0.42, 0.55, 0.78, inner * 0.35]);

    // 3) d20 线条（金色）
    const gold = [0.93, 0.78, 0.36, 1];
    let cov = 0;
    cov = Math.max(cov, stroke(px, py, hex, LINE));
    cov = Math.max(cov, stroke(px, py, triClosed, LINE));
    for (const f of facets) cov = Math.max(cov, stroke(px, py, f, LINE * 0.72));

    // 4) 线条略加粗一点，保证缩到 16×16 的任务栏尺寸时仍然认得出
    if (cov > 0) paint(x, y, [gold[0], gold[1], gold[2], cov * 0.96]);
  }
}

/* ────────────────────────── 降采样 ────────────────────────── */

const out = new Uint8Array(SIZE * SIZE * 4);
const inv = 1 / (SS * SS);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
        // 预乘 alpha 再平均，避免边缘出现暗边
        const al = canvas[i + 3];
        r += canvas[i] * al;
        g += canvas[i + 1] * al;
        b += canvas[i + 2] * al;
        a += al;
      }
    }
    const o = (y * SIZE + x) * 4;
    if (a > 0) {
      out[o] = Math.round(Math.min(255, (r / a) * 255));
      out[o + 1] = Math.round(Math.min(255, (g / a) * 255));
      out[o + 2] = Math.round(Math.min(255, (b / a) * 255));
    }
    out[o + 3] = Math.round(Math.min(255, (a * inv) * 255));
  }
}

/* ────────────────────────── 输出 ────────────────────────── */

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, 'icon.png');
fs.writeFileSync(file, encodePNG(out, SIZE, SIZE));

const kb = (fs.statSync(file).size / 1024).toFixed(1);
console.log(`图标已生成：${file}  ${SIZE}×${SIZE}  ${kb} KB`);
