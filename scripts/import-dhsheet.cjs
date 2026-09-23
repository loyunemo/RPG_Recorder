/**
 * 从 DHSheet 的卡牌数据导入匕首之心的车卡数据。
 *
 * 数据来源：https://github.com/RidRisR/DaggerHeart-CharacterSheet
 *   文件 `data/cards/builtin-base.json`（元信息自述「数据来自官方SRD」）。
 *   该仓库整体以 GPL-3.0 发布，但卡牌内容本身派生自
 *   Daggerheart SRD 1.0（© Critical Role, LLC.，DPCGL 授权）。
 *   本项目在使用时保留了完整署名，详见 LICENSE 与 README 的版权章节。
 *
 * 用法：
 *   node scripts/import-dhsheet.cjs <dhsheet 仓库路径>
 * 省略路径时默认用 %TEMP%/dhsheet。
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = process.argv[2] || path.join(process.env.TEMP || '/tmp', 'dhsheet');
const SOURCE = path.join(REPO, 'data', 'cards', 'builtin-base.json');
const OUT = path.join(__dirname, '..', 'src', 'core', 'rulesets', 'daggerheart', 'data');

if (!fs.existsSync(SOURCE)) {
  console.error(`找不到数据文件：${SOURCE}`);
  console.error('请先克隆：git clone --depth 1 https://github.com/RidRisR/DaggerHeart-CharacterSheet.git');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

const clean = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();

/**
 * 卡面文本用 Markdown 的粗斜体标记特性名，如 `***天赋艺者：*** 描述…`。
 * 拆成 { name, text } 数组；拆不出来就整段作为一条无名特性。
 */
function splitNamedFeatures(text) {
  const src = clean(text);
  if (!src) return [];

  const out = [];
  const re = /\*{3}\s*([^*]{1,40}?)\s*[:：]\s*\*{3}\s*/g;
  const marks = [...src.matchAll(re)];

  if (!marks.length) {
    return [{ name: '', text: src.replace(/\*+/g, '').trim() }];
  }

  // 开头若有引子（第一个标记之前的内容），单独留一条
  const lead = src.slice(0, marks[0].index).replace(/\*+/g, '').trim();
  if (lead) out.push({ name: '', text: lead });

  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    out.push({
      name: m[1].trim(),
      text: src.slice(start, end).replace(/\*+/g, '').trim(),
    });
  });
  return out.filter(f => f.name || f.text);
}

/** 去掉 markdown 强调符号，保留纯文本 */
const plain = (s) => clean(s).replace(/\*{1,3}([^*]*)\*{1,3}/g, '$1');

/* ────────────────────────── 血统 ────────────────────────── */

const ancestryGroups = new Map();
for (const card of raw.ancestry || []) {
  const key = card['种族'] || card['名称'];
  if (!ancestryGroups.has(key)) {
    ancestryGroups.set(key, { name: key, description: '', traits: [], id: null });
  }
  const g = ancestryGroups.get(key);
  if (!g.id) g.id = card.id.split('-')[0].toLowerCase();
  const desc = clean(card['简介']);
  if (desc && !g.description) g.description = desc;
  const effect = clean(card['效果']);
  if (effect) g.traits.push({ name: clean(card['名称']), text: effect });
}
const ancestries = [...ancestryGroups.values()].filter(a => a.traits.length);

/* ────────────────────────── 社群 ────────────────────────── */

const communities = (raw.community || []).map(c => ({
  id: String(c.id || '').toLowerCase(),
  name: clean(c['名称']),
  description: clean(c['简介']),
  feature: { name: clean(c['特性']), text: clean(c['描述']) },
}));

/* ────────────────────────── 子职业 ────────────────────────── */

// 子职业卡按「主职 + 子职业」聚合成一组，每组含基石/专精/大师三张
const subclassGroups = new Map();
for (const card of raw.subclass || []) {
  const owner = clean(card['主职']);
  const subName = clean(card['子职业']) || clean(card['名称']);
  const key = `${owner}::${subName}`;
  if (!subclassGroups.has(key)) {
    subclassGroups.set(key, {
      owner,
      name: subName,
      spellcastTrait: clean(card['施法']),
      features: [],
    });
  }
  const g = subclassGroups.get(key);
  if (!g.spellcastTrait) g.spellcastTrait = clean(card['施法']);
  const tier = clean(card['等级']) || '';
  for (const f of splitNamedFeatures(card['描述'])) {
    g.features.push({ ...f, tier: tier ? `${tier}特性` : '' });
  }
}

/**
 * 希望特性也是一条带名字的特性（`***大闹一场：*** …`），
 * 统一拆成 { name, text }，与职业特性保持同一种形状。
 */
function parseHopeFeature(text) {
  const parts = splitNamedFeatures(text);
  if (!parts.length) return { name: '', text: '' };
  return { name: parts[0].name, text: parts.map(p => p.text).join('\n') };
}

/* ────────────────────────── 职业 ────────────────────────── */

const classes = (raw.profession || []).map(c => {
  const name = clean(c['名称']);
  const subs = [...subclassGroups.values()]
    .filter(g => g.owner === name)
    .map(({ owner, ...rest }) => rest);

  return {
    id: String(c.id || '').toLowerCase(),
    name,
    domains: [clean(c['领域1']), clean(c['领域2'])].filter(Boolean),
    hp: Number(c['起始生命']) || null,
    evasion: Number(c['起始闪避']) || null,
    classItems: clean(c['起始物品']),
    description: clean(c['简介']),
    hopeFeature: parseHopeFeature(c['希望特性']),
    features: splitNamedFeatures(c['职业特性']),
    subclasses: subs,
  };
});

/* ────────────────────────── 领域与领域卡 ────────────────────────── */

const domainNames = [...new Set((raw.domain || []).map(c => clean(c['领域'])).filter(Boolean))];
const domains = domainNames.map(n => ({ id: n, name: n, description: '' }));

const cards = (raw.domain || []).map(c => ({
  id: String(c.id || ''),
  domain: clean(c['领域']),
  name: clean(c['名称']),
  level: Number(c['等级']) || null,
  type: clean(c['属性']),
  recall: Number(c['回想']) || 0,
  text: clean(c['描述']),
}));

/* ────────────────────────── 写盘 ────────────────────────── */

function write(file, value) {
  fs.writeFileSync(path.join(OUT, file), `${JSON.stringify(value, null, 1)}\n`, 'utf8');
}

write('ancestries.json', { ancestries });
write('communities.json', { communities });
write('classes.json', { classes });
write('domains.json', { domains, cards });
write('source.json', {
  note: '本目录数据由 scripts/import-dhsheet.cjs 从 DHSheet 的卡牌数据转换而来，请勿手改。',
  upstream: 'https://github.com/RidRisR/DaggerHeart-CharacterSheet',
  upstreamFile: 'data/cards/builtin-base.json',
  upstreamName: raw.name,
  upstreamVersion: raw.version,
  upstreamDescription: raw.description,
  upstreamAuthors: raw.author,
  importedAt: new Date().toISOString(),
  license: '卡牌内容派生自 Daggerheart SRD 1.0（© Critical Role, LLC.，DPCGL 授权）；'
    + '上游仓库以 GPL-3.0 发布，中文翻译由 RidRisR、PolearmMaster、末楔、里予、一得完成。',
});

/* ────────────────────────── 报告 ────────────────────────── */

console.log(`数据源：${SOURCE}`);
console.log(`  上游：${raw.name} ${raw.version}（${raw.description}）`);
console.log('');
console.log(`  血统      ${ancestries.length} 个种族 / ${ancestries.reduce((n, a) => n + a.traits.length, 0)} 条特性`);
console.log(`  社群      ${communities.length}`);
console.log(`  职业      ${classes.length}（子职业合计 ${classes.reduce((n, c) => n + c.subclasses.length, 0)}）`);
console.log(`  领域      ${domains.length}，领域卡 ${cards.length} 张`);
console.log('');
const noSub = classes.filter(c => !c.subclasses.length).map(c => c.name);
if (noSub.length) console.log(`  ⚠ 没有子职业的职业：${noSub.join('、')}`);
const noTrait = ancestries.filter(a => a.traits.length !== 2);
if (noTrait.length) console.log(`  ⚠ 特性不是 2 条的种族：${noTrait.map(a => `${a.name}(${a.traits.length})`).join('、')}`);
const badSub = classes.flatMap(c => c.subclasses).filter(s => !s.features.length);
if (badSub.length) console.log(`  ⚠ 没有特性的子职业：${badSub.map(s => s.name).join('、')}`);
console.log('\n完成。');
