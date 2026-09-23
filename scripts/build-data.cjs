/**
 * 把各规则集的提取数据打包成可直接 import 的 ES 模块。
 *
 * 为什么需要这一步：JSON 模块在浏览器里要靠 import attributes
 * （`import x from './a.json' with { type: 'json' }`），兼容性不稳；
 * 生成 `export default {...}` 的 .js 之后，Node 与浏览器都能无差别加载。
 *
 * 源文件 `*.json` 是提取产物、保持可读；`*.gen.js` 是生成物，不要手改。
 *
 * 用法：node scripts/build-data.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const RULESETS = path.join(__dirname, '..', 'src', 'core', 'rulesets');

/* ────────────────────────── 华渚：合并职业分片 ────────────────────────── */

function mergeHuazhuClasses(dir) {
  const p1 = path.join(dir, 'classes-1.json');
  const p2 = path.join(dir, 'classes-2.json');
  if (!fs.existsSync(p1) || !fs.existsSync(p2)) return null;

  const classes = [
    ...JSON.parse(fs.readFileSync(p1, 'utf8')).classes,
    ...JSON.parse(fs.readFileSync(p2, 'utf8')).classes,
  ];

  const ids = new Set();
  for (const c of classes) {
    if (!c.id) throw new Error(`职业缺少 id：${c.name}`);
    if (ids.has(c.id)) throw new Error(`职业 id 重复：${c.id}`);
    ids.add(c.id);
  }
  if (classes.length !== 13) {
    throw new Error(`预期 13 个法门，实际 ${classes.length} 个 —— 提取分片可能不完整`);
  }

  // 归一化：缺字段补成安全默认值，避免下游拿到 undefined
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

  // 校验领域卡都能对应到领域
  const domFile = path.join(dir, 'domains.json');
  if (fs.existsSync(domFile)) {
    const { domains, cards } = JSON.parse(fs.readFileSync(domFile, 'utf8'));
    const known = new Set(domains.map(d => d.id));
    const bad = (cards || []).filter(c => !known.has(c.domain));
    if (bad.length) throw new Error(`有 ${bad.length} 张领域卡指向了不存在的领域`);
  }

  fs.writeFileSync(
    path.join(dir, 'classes.json'),
    `${JSON.stringify({ classes }, null, 1)}\n`,
    'utf8',
  );
  return classes;
}

/* ────────────────────────── JSON → ES 模块 ────────────────────────── */

function toModule(dir, name) {
  const src = fs.readFileSync(path.join(dir, name), 'utf8');
  // JSON 里可能含 U+2028 / U+2029，它们在 JS 源码里是换行符，必须转义
  const safe = src.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const out = name.replace(/\.json$/, '.gen.js');
  fs.writeFileSync(
    path.join(dir, out),
    `/** 由 scripts/build-data.cjs 从 ${name} 生成，请勿手改 */\n`
    + `export default ${safe.trim()};\n`,
    'utf8',
  );
  return out;
}

/* ────────────────────────── 执行 ────────────────────────── */

/** 中间产物，不需要生成模块（只是合并 classes.json 的原料） */
const SKIP = new Set(['classes-1.json', 'classes-2.json']);

let total = 0;

for (const id of fs.readdirSync(RULESETS)) {
  const dir = path.join(RULESETS, id, 'data');
  if (!fs.existsSync(dir)) continue;

  console.log(`\n[${id}]`);

  if (id === 'huazhu') {
    const merged = mergeHuazhuClasses(dir);
    if (merged) {
      const subs = merged.reduce((n, c) => n + c.subclasses.length, 0);
      const feats = merged.reduce(
        (n, c) => n + c.features.length + c.subclasses.reduce((m, s) => m + s.features.length, 0), 0,
      );
      console.log(`  职业合并：${merged.length} 个法门，${subs} 个子职业，${feats} 条特性`);
    }
  }

  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
    if (SKIP.has(f)) {
      console.log(`  ${f.padEnd(22)} — 中间产物，跳过`);
      continue;
    }
    const out = toModule(dir, f);
    const kb = (fs.statSync(path.join(dir, out)).size / 1024).toFixed(0);
    console.log(`  ${f.padEnd(22)} → ${out.padEnd(24)} ${kb} KB`);
    total++;
  }
}

console.log(`\n完成，共生成 ${total} 个模块。`);
