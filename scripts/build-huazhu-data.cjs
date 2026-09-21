/**
 * 把华渚的提取数据打包成可直接 import 的 ES 模块。
 *
 * 为什么需要这一步：JSON 模块在浏览器里要靠 import attributes
 * （`import x from './a.json' with { type: 'json' }`），兼容性不稳；
 * 生成 `export default {...}` 的 .js 之后，Node 与浏览器都能无差别加载。
 *
 * 源文件 `*.json` 是提取产物、保持可读；`*.gen.js` 是生成物，不要手改。
 * 用法：node scripts/build-huazhu-data.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'src', 'core', 'rulesets', 'huazhu', 'data');

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
}

/* ── 1. 合并两个分片的职业数据 ── */

function mergeClasses() {
  const part1 = read('classes-1.json');
  const part2 = read('classes-2.json');
  const classes = [...part1.classes, ...part2.classes];

  const ids = new Set();
  for (const c of classes) {
    if (!c.id) throw new Error(`职业缺少 id：${c.name}`);
    if (ids.has(c.id)) throw new Error(`职业 id 重复：${c.id}`);
    ids.add(c.id);
  }
  if (classes.length !== 13) {
    throw new Error(`预期 13 个法门，实际 ${classes.length} 个 —— 提取分片可能不完整`);
  }

  // 归一化：缺字段一律补成安全默认值，避免下游拿到 undefined
  for (const c of classes) {
    c.features = (c.features || []).map(f => ({ tier: '', ...f }));
    c.subclasses = (c.subclasses || []).map(s => ({
      sectNature: '', spellcastTrait: '', startingItems: '', description: '', domain: '',
      ...s,
      features: (s.features || []).map(f => ({ tier: '', ...f })),
    }));
    c.backgroundQuestions = c.backgroundQuestions || [];
    c.connections = c.connections || [];
  }

  fs.writeFileSync(
    path.join(DATA, 'classes.json'),
    `${JSON.stringify({ classes }, null, 1)}\n`,
    'utf8',
  );
  return classes;
}

/* ── 2. JSON → ES 模块 ── */

function toModule(name) {
  const src = fs.readFileSync(path.join(DATA, name), 'utf8');
  // JSON 里可能含 U+2028 / U+2029，它们在 JS 源码里是换行符，必须转义
  const safe = src.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const out = name.replace(/\.json$/, '.gen.js');
  fs.writeFileSync(
    path.join(DATA, out),
    `/** 由 scripts/build-huazhu-data.cjs 从 ${name} 生成，请勿手改 */\n`
    + `export default ${safe.trim()};\n`,
    'utf8',
  );
  return out;
}

/* ── 执行 ── */

const classes = mergeClasses();
console.log(`职业合并完成：${classes.length} 个法门，`
  + `${classes.reduce((n, c) => n + c.subclasses.length, 0)} 个子职业，`
  + `${classes.reduce((n, c) => n + c.features.length + c.subclasses.reduce((m, s) => m + s.features.length, 0), 0)} 条特性`);

const SOURCES = [
  'ancestries.json', 'communities.json', 'classes.json',
  'domains.json', 'equipment.json', 'mechanics.json',
];
if (fs.existsSync(path.join(DATA, 'equipment-stats.json'))) SOURCES.push('equipment-stats.json');

for (const s of SOURCES) {
  const out = toModule(s);
  const kb = (fs.statSync(path.join(DATA, out)).size / 1024).toFixed(0);
  console.log(`  ${s.padEnd(24)} → ${out.padEnd(26)} ${kb} KB`);
}
console.log('\n完成。');
