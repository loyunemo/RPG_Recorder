/**
 * 核心逻辑测试。运行：npm test
 * 不依赖任何测试框架，直接 node 跑。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { RNG, newSeed, xmur3, mulberry32 } from '../src/core/rng.js';
import { rollExpr, parseExpression, rollPercentile, DiceError } from '../src/core/dice.js';
import { pointBuyCost } from '../src/core/creation.js';
import {
  ACTION_KINDS, kindsFor, ACTION_TARGETS, blankAction, actionFromPreset,
  normalizeAction, normalizeActions, describeCost, describeAction,
  expandDamageExpr, resolveAction, describeActionResult,
  ACTION_KIND_SCOPE, scopeOf, spentKinds, canUseKind, markKindUsed, refreshUsage,
} from '../src/core/actions.js';
import { getRuleset } from '../src/core/rulesets/index.js';
import coc7 from '../src/core/rulesets/coc7.js';
import dnd5e from '../src/core/rulesets/dnd5e.js';
import daggerheart from '../src/core/rulesets/daggerheart.js';
// 华渚要放到文件顶部 import：它是 const 声明，在后面才写会落进暂时性死区，
// 前面任何用到它的用例都会抛「Cannot access 'HZ' before initialization」
import HZ from '../src/core/rulesets/huazhu/index.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message.split('\n')[0]}\n`);
  }
}

function group(name) {
  process.stdout.write(`\n\x1b[1m${name}\x1b[0m\n`);
}

/** 可预测的假随机源：按给定序列吐出 int 值 */
class FakeRng {
  constructor(seq, seed = 'FAKE') {
    this.seq = seq.slice();
    this.seed = seed;
    this.count = 0;
  }
  int(min, max) {
    this.count++;
    const v = this.seq.shift();
    if (v === undefined) throw new Error('FakeRng 序列用尽');
    assert.ok(v >= min && v <= max, `FakeRng 值 ${v} 超出 [${min}, ${max}]`);
    return v;
  }
  next() { return this.int(0, 999999) / 1000000; }
}

/* ══════════════════════════ 随机数 ══════════════════════════ */

group('随机数发生器');

test('同一种子产生完全相同的序列', () => {
  const a = new RNG('TESTSEED');
  const b = new RNG('TESTSEED');
  const sa = Array.from({ length: 50 }, () => a.int(1, 100));
  const sb = Array.from({ length: 50 }, () => b.int(1, 100));
  assert.deepEqual(sa, sb);
});

test('不同种子产生不同序列', () => {
  const a = new RNG('SEED-A');
  const b = new RNG('SEED-B');
  const sa = Array.from({ length: 50 }, () => a.int(1, 100));
  const sb = Array.from({ length: 50 }, () => b.int(1, 100));
  assert.notDeepEqual(sa, sb);
});

test('int 落在闭区间内且能取到两端', () => {
  const rng = new RNG('RANGE');
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    const v = rng.int(1, 6);
    assert.ok(v >= 1 && v <= 6, `越界：${v}`);
    seen.add(v);
  }
  assert.equal(seen.size, 6, '六个面都应出现');
});

test('murmur 散列对相似输入不塌缩', () => {
  assert.notEqual(xmur3('abc')(), xmur3('abd')());
  const r = mulberry32(12345);
  const vals = new Set(Array.from({ length: 200 }, () => r()));
  assert.ok(vals.size > 190, '分布不应大量重复');
});

test('newSeed 生成的种子长度稳定且可复现', () => {
  const s = newSeed();
  assert.equal(s.length, 12);
  assert.equal(new RNG(s).seed, s);
});

/* ══════════════════════════ 骰式解析 ══════════════════════════ */

group('骰式解析');

test('基本骰式', () => {
  const p = parseExpression('3d6');
  assert.equal(p.terms.length, 1);
  assert.equal(p.terms[0].count, 3);
  assert.equal(p.terms[0].sides, 6);
  assert.equal(p.terms[0].sign, 1);
});

test('省略个数的 d20 视为 1d20', () => {
  const p = parseExpression('d20');
  assert.equal(p.terms[0].count, 1);
  assert.equal(p.terms[0].sides, 20);
});

test('d% 等价于 d100', () => {
  assert.equal(parseExpression('d%').terms[0].sides, 100);
});

test('加减混合与负项', () => {
  const p = parseExpression('3d6+2-1d4');
  assert.equal(p.terms.length, 3);
  assert.equal(p.terms[0].sign, 1);
  assert.equal(p.terms[1].kind, 'const');
  assert.equal(p.terms[1].value, 2);
  assert.equal(p.terms[2].sign, -1);
  assert.equal(p.terms[2].sides, 4);
});

test('空白被忽略', () => {
  assert.equal(parseExpression(' 2 d 6 + 1 ').normalized, '2d6+1');
});

test('修饰符解析齐全', () => {
  const t = parseExpression('4d6dl1kh2!r1min2max5').terms[0];
  const types = t.mods.map(m => m.type);
  assert.ok(types.includes('dl'));
  assert.ok(types.includes('kh'));
  assert.ok(types.includes('explode'));
  assert.ok(types.includes('reroll'));
  assert.ok(types.includes('min'));
  assert.ok(types.includes('max'));
});

test('非法骰式抛出 DiceError', () => {
  assert.throws(() => parseExpression('abc'), DiceError);
  assert.throws(() => parseExpression('d'), DiceError);
  assert.throws(() => parseExpression(''), DiceError);
  assert.throws(() => parseExpression('3d6+'), DiceError);
  assert.throws(() => parseExpression('1d6q3'), DiceError);
});

/* ══════════════════════════ 骰子引擎 ══════════════════════════ */

group('骰子引擎');

test('3d6+2 结果等于各部分之和', () => {
  for (let i = 0; i < 60; i++) {
    const r = rollExpr('3d6+2');
    const sum = r.terms[0].dice.reduce((a, d) => a + d.v, 0);
    assert.equal(r.total, sum + 2);
    assert.ok(r.total >= 5 && r.total <= 20);
  }
});

test('同一种子的骰式完全可复现', () => {
  const a = rollExpr('4d6+3d8-2', { seed: 'REPLAY' });
  const b = rollExpr('4d6+3d8-2', { seed: 'REPLAY' });
  assert.equal(a.total, b.total);
  assert.deepEqual(a.terms[0].dice.map(d => d.v), b.terms[0].dice.map(d => d.v));
  assert.equal(a.consumed, 7);
});

test('4d6dl1 弃掉最低值', () => {
  for (let i = 0; i < 80; i++) {
    const r = rollExpr('4d6dl1');
    const dice = r.terms[0].dice;
    const dropped = dice.filter(d => !d.kept);
    assert.equal(dropped.length, 1);
    const min = Math.min(...dice.map(d => d.v));
    assert.equal(dropped[0].v, min, '弃掉的应是最低值');
    assert.equal(r.total, dice.filter(d => d.kept).reduce((a, d) => a + d.v, 0));
  }
});

test('4d6dh1 弃掉最高值', () => {
  const r = rollExpr('4d6dh1');
  const dice = r.terms[0].dice;
  const dropped = dice.find(d => !d.kept);
  assert.equal(dropped.v, Math.max(...dice.map(d => d.v)));
});

test('2d20kh1 取高、2d20kl1 取低', () => {
  for (let i = 0; i < 60; i++) {
    const hi = rollExpr('2d20kh1');
    const lo = rollExpr('2d20kl1');
    const hv = hi.terms[0].dice.map(d => d.v);
    const lv = lo.terms[0].dice.map(d => d.v);
    assert.equal(hi.total, Math.max(...hv));
    assert.equal(lo.total, Math.min(...lv));
  }
});

test('3d6k2 只保留两个最高', () => {
  const r = rollExpr('3d6k2');
  assert.equal(r.terms[0].dice.filter(d => d.kept).length, 2);
});

test('爆炸骰有连锁上限，不会失控', () => {
  // 1d2 每次都掷出最大值 2，会无限连锁——必须被 MAX_EXPLOSIONS 截断
  const r = rollExpr('1d2!', { rng: new FakeRng(Array(300).fill(2)) });
  const faces = r.terms[0].dice[0].faces;
  assert.ok(faces.length <= 51, `连锁次数应被限制，实际 ${faces.length}`);
  assert.equal(r.total, faces.length * 2);
});

test('骰子面数下限被校验（d1 不合法）', () => {
  assert.throws(() => parseExpression('1d1'), DiceError);
});

test('爆炸骰在非最大面时不再续掷', () => {
  const r = rollExpr('1d6!', { rng: new FakeRng([3]) });
  assert.equal(r.total, 3);
  assert.equal(r.terms[0].dice[0].faces.length, 1);
});

test('爆炸骰在最大面时续掷并累加', () => {
  const r = rollExpr('1d6!', { rng: new FakeRng([6, 6, 2]) });
  assert.equal(r.total, 14);
  assert.deepEqual(r.terms[0].dice[0].faces, [6, 6, 2]);
});

test('重掷 r1 直到不是 1', () => {
  const r = rollExpr('1d6r1', { rng: new FakeRng([1, 1, 4]) });
  assert.equal(r.total, 4);
});

test('重掷 ro1 只重掷一次', () => {
  const r = rollExpr('1d6ro1', { rng: new FakeRng([1, 1]) });
  assert.equal(r.total, 1, '只重掷一次，第二次仍是 1 就保留');
  assert.equal(r.terms[0].dice[0].faces.length, 2);
});

test('min / max 修正单骰', () => {
  assert.equal(rollExpr('1d6min4', { rng: new FakeRng([1]) }).total, 4);
  assert.equal(rollExpr('1d6max3', { rng: new FakeRng([6]) }).total, 3);
});

test('成功计数 6d6>=5', () => {
  const r = rollExpr('6d6>=5', { rng: new FakeRng([6, 5, 4, 3, 2, 1]) });
  assert.equal(r.terms[0].mode, 'count');
  assert.equal(r.terms[0].successes, 2);
  assert.equal(r.total, 2);
});

test('净成功 8d6cf<=1 减去失败数', () => {
  const r = rollExpr('1d6>=5cf<=1', { rng: new FakeRng([1]) });
  assert.equal(r.total, -1);
});

test('命运骰 4dF 取值在 -4..4 且各面为 -1/0/1', () => {
  for (let i = 0; i < 40; i++) {
    const r = rollExpr('4dF');
    assert.ok(r.total >= -4 && r.total <= 4);
    for (const d of r.terms[0].dice) assert.ok([-1, 0, 1].includes(d.v));
  }
});

test('负号骰项正确相减', () => {
  const r = rollExpr('10-1d4', { rng: new FakeRng([4]) });
  assert.equal(r.total, 6);
});

test('describeRoll 产出可读文本', () => {
  const r = rollExpr('4d6dl1+2', { rng: new FakeRng([6, 4, 2, 3]) });
  assert.match(r.detail, /4d6dl1/);
  assert.match(r.detail, /= 15/);
});

test('rollPercentile：奖励骰取最小十位', () => {
  const pct = rollPercentile(new FakeRng([5, 3, 8]), { bonus: 1, penalty: 0 });
  assert.equal(pct.chosen, 3);
  assert.equal(pct.value, 35);
});

test('rollPercentile：惩罚骰取最大十位', () => {
  const pct = rollPercentile(new FakeRng([5, 3, 8]), { bonus: 0, penalty: 1 });
  assert.equal(pct.chosen, 8);
  assert.equal(pct.value, 85);
});

test('rollPercentile：00 视为 100', () => {
  const pct = rollPercentile(new FakeRng([0, 0]));
  assert.equal(pct.value, 100);
});

/* ══════════════════════════ COC 7e ══════════════════════════ */

group('COC 7 版');

test('派生数值：HP / MP / 理智上限', () => {
  const data = coc7.createDefault('测试');
  data.attributes = { str: 50, con: 60, siz: 70, dex: 50, app: 50, int: 50, pow: 65, edu: 70 };
  const d = coc7.derive(data);
  assert.equal(d.hpMax, 13);   // (60+70)/10
  assert.equal(d.mpMax, 13);   // 65/5
  assert.equal(d.sanMax, 99);
});

test('伤害加值 / 体格表边界', () => {
  assert.deepEqual(coc7.buildAndDB(64), { build: -2, db: '-2' });
  assert.deepEqual(coc7.buildAndDB(65), { build: -1, db: '-1' });
  assert.deepEqual(coc7.buildAndDB(85), { build: 0, db: '0' });
  assert.deepEqual(coc7.buildAndDB(125), { build: 1, db: '+1D4' });
  assert.deepEqual(coc7.buildAndDB(205), { build: 3, db: '+2D6' });
  assert.equal(coc7.buildAndDB(285).build, 4);
  assert.equal(coc7.buildAndDB(365).build, 5);
});

test('移动力：按 STR/DEX 与 SIZ 的关系分档', () => {
  assert.equal(coc7.movement(40, 40, 60), 7);
  assert.equal(coc7.movement(60, 40, 50), 8);
  assert.equal(coc7.movement(70, 70, 50), 9);
  assert.equal(coc7.movement(70, 70, 50, 50), 7, '50 岁 −2');
});

test('大成功：掷出 1', () => {
  const data = coc7.createDefault('x');
  data.skills['侦察'] = 50;
  const r = coc7.roll(data, { targetKey: 'skill:侦察' }, new FakeRng([1, 0]));
  assert.equal(r.roll, 1);
  assert.equal(r.outcome, 'critical');
  assert.equal(r.success, true);
});

test('大失败：目标 <50 时掷出 96', () => {
  const data = coc7.createDefault('x');
  data.skills['侦察'] = 40;
  const r = coc7.roll(data, { targetKey: 'skill:侦察' }, new FakeRng([6, 9]));
  assert.equal(r.roll, 96);
  assert.equal(r.outcome, 'fumble');
});

test('目标 ≥50 时掷出 96 不算大失败', () => {
  const data = coc7.createDefault('x');
  data.skills['侦察'] = 70;
  const r = coc7.roll(data, { targetKey: 'skill:侦察' }, new FakeRng([6, 9]));
  assert.equal(r.roll, 96);
  assert.equal(r.outcome, 'fail', '96 未超过 70，属普通失败');
});

test('三档成功等级判定', () => {
  const data = coc7.createDefault('x');
  data.skills['侦察'] = 50;   // 困难 25 / 极难 10
  // FakeRng 顺序为「先个位、后十位」
  assert.equal(coc7.roll(data, { targetKey: 'skill:侦察' }, new FakeRng([8, 0])).outcome, 'extreme');
  assert.equal(coc7.roll(data, { targetKey: 'skill:侦察' }, new FakeRng([0, 2])).outcome, 'hard');
  assert.equal(coc7.roll(data, { targetKey: 'skill:侦察' }, new FakeRng([0, 4])).outcome, 'regular');
  assert.equal(coc7.roll(data, { targetKey: 'skill:侦察' }, new FakeRng([0, 8])).outcome, 'fail');
});

test('难度门槛影响 success 判定', () => {
  const data = coc7.createDefault('x');
  data.skills['侦察'] = 50;
  // 掷出 40：常规成功，但不是困难成功
  const regular = coc7.roll(data, { targetKey: 'skill:侦察', difficulty: 'regular' }, new FakeRng([0, 4]));
  const hard = coc7.roll(data, { targetKey: 'skill:侦察', difficulty: 'hard' }, new FakeRng([0, 4]));
  assert.equal(regular.roll, 40);
  assert.equal(regular.success, true);
  assert.equal(hard.success, false);
});

test('奖励骰影响十位取值', () => {
  const data = coc7.createDefault('x');
  data.skills['侦察'] = 50;
  // 个位 5；两个十位骰 7 与 2 → 奖励取 2 → 25
  const r = coc7.roll(data, { targetKey: 'skill:侦察', bonus: 1 }, new FakeRng([5, 7, 2]));
  assert.equal(r.roll, 25);
  assert.equal(r.outcome, 'hard');
});

/* ══════════════════════════ DND 5e ══════════════════════════ */

group('DND 5 版');

test('属性调整值', () => {
  assert.equal(dnd5e.abilityMod(10), 0);
  assert.equal(dnd5e.abilityMod(11), 0);
  assert.equal(dnd5e.abilityMod(8), -1);
  assert.equal(dnd5e.abilityMod(20), 5);
  assert.equal(dnd5e.abilityMod(1), -5);
});

test('熟练加值随等级提升', () => {
  assert.equal(dnd5e.proficiencyBonus(1), 2);
  assert.equal(dnd5e.proficiencyBonus(4), 2);
  assert.equal(dnd5e.proficiencyBonus(5), 3);
  assert.equal(dnd5e.proficiencyBonus(9), 4);
  assert.equal(dnd5e.proficiencyBonus(17), 6);
  assert.equal(dnd5e.proficiencyBonus(20), 6);
});

test('AC 与被动察觉派生正确', () => {
  const data = dnd5e.createDefault('t');
  data.abilities.dex = 16;   // +3
  data.abilities.wis = 14;   // +2
  data.combat.armorBase = 14;
  data.proficiency.skills = ['perception'];
  const d = dnd5e.derive(data);
  assert.equal(d.ac, 17);
  assert.equal(d.passivePerception, 14);  // 10 + 2 + 2
});

test('敏捷上限对 AC 生效（重甲）', () => {
  const data = dnd5e.createDefault('t');
  data.abilities.dex = 18;   // +4
  data.combat.armorBase = 16;
  data.combat.dexCap = 0;
  assert.equal(dnd5e.derive(data).ac, 16);
});

test('技能熟练与专精叠加', () => {
  const data = dnd5e.createDefault('t');
  data.level = 5;            // 熟练 +3
  data.abilities.dex = 16;   // +3
  data.proficiency.skills = ['stealth'];
  data.proficiency.expertise = ['stealth'];
  const d = dnd5e.derive(data);
  const stealth = d.skills.find(s => s.key === 'stealth');
  assert.equal(stealth.total, 3 + 3 + 3);
});

test('d20 检定：达到 DC 即成功', () => {
  const data = dnd5e.createDefault('t');
  data.abilities.str = 16;  // +3
  const r = dnd5e.roll(data, { targetKey: 'ability:str', dc: 15 }, new FakeRng([12]));
  assert.equal(r.total, 15);
  assert.equal(r.success, true);
});

test('天然 20 必定成功，天然 1 必定失败', () => {
  const data = dnd5e.createDefault('t');
  data.abilities.str = 1;   // -5
  const crit = dnd5e.roll(data, { targetKey: 'ability:str', dc: 30 }, new FakeRng([20]));
  assert.equal(crit.outcome, 'critical');
  assert.equal(crit.success, true);

  data.abilities.str = 30;  // +10
  const fumble = dnd5e.roll(data, { targetKey: 'ability:str', dc: 5 }, new FakeRng([1]));
  assert.equal(fumble.outcome, 'fumble');
  assert.equal(fumble.success, false);
});

test('优势取高、劣势取低', () => {
  const data = dnd5e.createDefault('t');
  data.abilities.dex = 10;
  const adv = dnd5e.roll(data, { targetKey: 'ability:dex', advantage: true }, new FakeRng([4, 17]));
  assert.equal(adv.kept, 17);
  const dis = dnd5e.roll(data, { targetKey: 'ability:dex', disadvantage: true }, new FakeRng([4, 17]));
  assert.equal(dis.kept, 4);
});

test('优势与劣势同时给出时互相抵消', () => {
  const data = dnd5e.createDefault('t');
  const r = dnd5e.roll(data, { targetKey: 'ability:dex', advantage: true, disadvantage: true }, new FakeRng([11]));
  assert.equal(r.rolls.length, 1, '抵消后只掷一个 d20');
});

test('法术豁免 DC 与法术位派生', () => {
  const data = dnd5e.createDefault('t');
  data.level = 5;
  data.abilities.int = 18;  // +4
  data.spell.ability = 'int';
  const d = dnd5e.derive(data);
  assert.equal(d.stats.find(s => s.key === 'spellSaveDC').value, 8 + 3 + 4);
  assert.equal(d.spellSlots.length, 3);
  assert.equal(d.spellSlots[0].max, 4);
  assert.equal(d.spellSlots[2].max, 2);
});

/* ══════════════════════════ 匕首心 ══════════════════════════ */

group('匕首心');

test('职业表数值与 SRD 一致', () => {
  const byName = Object.fromEntries(daggerheart.classes.map(c => [c.name, c]));
  assert.equal(byName['战士'].evasion, 11);
  assert.equal(byName['战士'].hp, 6);
  assert.equal(byName['神使'].hp, 7);
  assert.equal(byName['术士'].hp, 6);
  assert.equal(byName['游荡者'].evasion, 12);
  assert.equal(byName['法师'].hp, 5);
  assert.equal(daggerheart.classes.length, 9);
});

test('职业的两个领域用的是官方中文译名', () => {
  const byName = Object.fromEntries(daggerheart.classes.map(c => [c.name, c]));
  assert.deepEqual(byName['吟游诗人'].domains, ['优雅', '典籍'], '官方译名是「典籍」不是「法典」');
  assert.deepEqual(byName['德鲁伊'].domains, ['贤者', '奥术'], '官方译名是「贤者/奥术」不是「智慧/秘法」');
  assert.deepEqual(byName['法师'].domains, ['典籍', '辉耀']);

  // 所有职业的领域都必须能在领域表里找到
  const known = new Set(daggerheart.domains.map(d => d.name));
  for (const c of daggerheart.classes) {
    for (const dom of c.domains) {
      assert.ok(known.has(dom), `${c.name} 的领域「${dom}」不在领域表里`);
    }
  }
});

test('每个职业都有两个子职业，且子职业特性分档', () => {
  for (const c of daggerheart.classes) {
    assert.equal(c.subclasses.length, 2, `${c.name} 应有 2 个子职业，实际 ${c.subclasses.length}`);
    for (const s of c.subclasses) {
      assert.ok(s.name, `${c.name} 的子职业缺名字`);
      assert.ok(s.spellcastTrait, `${c.name}/${s.name} 缺施法属性`);
      assert.ok(s.features.length > 0, `${c.name}/${s.name} 没有任何特性`);
      for (const f of s.features) {
        assert.ok(f.name, `${c.name}/${s.name} 有特性缺名字`);
        assert.ok(f.text, `${c.name}/${s.name} 的【${f.name}】缺描述`);
      }
    }
  }
});

test('血统 18 个种族，每个恰好 2 条特性', () => {
  assert.equal(daggerheart.ancestries.length, 18);
  for (const a of daggerheart.ancestries) {
    assert.equal(a.traits.length, 2, `${a.name} 的特性不是 2 条`);
    for (const t of a.traits) {
      assert.ok(t.name, `${a.name} 有特性缺名字`);
      assert.ok(t.text, `${a.name} 的【${t.name}】缺描述`);
    }
  }
});

test('社群 9 个，每个 1 条特性', () => {
  assert.equal(daggerheart.communities.length, 9);
  for (const c of daggerheart.communities) {
    assert.ok(c.name);
    assert.ok(c.feature?.name, `${c.name} 缺特性名`);
    assert.ok(c.feature?.text, `${c.name} 缺特性描述`);
  }
});

test('领域 9 个，每个恰好 21 张卡', () => {
  assert.equal(daggerheart.domains.length, 9);
  assert.equal(daggerheart.domainCards.length, 189);
  const counts = {};
  for (const c of daggerheart.domainCards) counts[c.domain] = (counts[c.domain] || 0) + 1;
  for (const d of daggerheart.domains) {
    assert.equal(counts[d.name], 21, `${d.name} 的卡数应为 21，实际 ${counts[d.name]}`);
  }
});

test('领域卡字段完整，等级在 1~10', () => {
  for (const c of daggerheart.domainCards) {
    assert.ok(c.name, '领域卡缺名字');
    assert.ok(c.domain, `${c.name} 缺领域`);
    assert.ok(c.text, `${c.name} 缺描述`);
    assert.ok(Number.isFinite(c.level) && c.level >= 1 && c.level <= 10, `${c.name} 等级异常：${c.level}`);
    assert.ok(['能力', '法术', '术典'].includes(c.type), `${c.name} 类型异常：${c.type}`);
  }
});

test('职业的领域卡查询可用', () => {
  const cards = daggerheart.cardsOfDomain('利刃');
  assert.equal(cards.length, 21);
  assert.ok(cards.every(c => c.domain === '利刃'));
  assert.ok(cards[0].level <= cards[cards.length - 1].level, '应按等级升序');
});

test('车卡可用的领域 = 职业的两个领域', () => {
  assert.deepEqual(daggerheart.creation.usableDomains('战士'), ['利刃', '骸骨']);
  assert.deepEqual(daggerheart.creation.usableDomains('法师'), ['典籍', '辉耀']);
  assert.deepEqual(daggerheart.creation.usableDomains('不存在的职业'), []);
});

test('usableDomains 传数据对象与传职业名结果一致（匕首心）/ 互为超集（华渚）', () => {
  // 这条是为了防住一个让车卡彻底走不下去的 bug：
  // 匕首心的 usableDomains 只接受职业名字符串，而界面向导传的是数据对象，
  // 于是 DH_CLASS_BY_NAME.get(对象) 得到 undefined，领域卡列表恒为空 ——
  // 玩家选不到领域卡，校验又要求必须有 2 张，车卡永远完不成。
  const dh = daggerheart.createDefault('测试');
  const dhByData = daggerheart.creation.usableDomains(dh);
  const dhByName = daggerheart.creation.usableDomains(dh.className);
  assert.ok(dhByData.length > 0, '匕首心：传数据对象应返回非空领域列表');
  assert.deepEqual(dhByData, dhByName, '匕首心：两种入参结果应一致');

  // 华渚不同：法门只给第一个领域，第二个来自宗门。
  // 所以只传法门名时少一个是正确的，只要求「数据对象的结果是它的超集」。
  const hz = HZ.createDefault('测试');
  const hzByData = HZ.creation.usableDomains(hz);
  const hzByName = HZ.creation.usableDomains(hz.className);
  assert.ok(hzByName.length > 0, '华渚：传法门名应至少给出一个领域');
  assert.ok(hzByData.length >= hzByName.length, '华渚：带宗门的数据对象不应少于只传法门名');
  for (const d of hzByName) {
    assert.ok(hzByData.includes(d), `华渚：数据对象的结果应包含 ${d}`);
  }
});

test('匕首心的领域卡能按职业领域取到', () => {
  const data = daggerheart.createDefault('测试');
  data.className = '战士';
  const usable = daggerheart.creation.usableDomains(data);
  const cards = daggerheart.domainCards.filter(c => usable.includes(c.domain));
  assert.equal(cards.length, 42, `战士应能选到 42 张卡，实际 ${cards.length}`);
});

test('华渚的领域卡能按法门与宗门取到', () => {
  const data = HZ.createDefault('测试');
  data.className = '剑修';
  const cls = HZ.classes.find(c => c.name === '剑修');
  data.subclass = cls.subclasses[0].name;
  const usable = HZ.creation.usableDomains(data);
  assert.ok(usable.length >= 1);

  // 华渚的领域卡用 id 关联、usableDomains 返回的是名称，需要经领域表转换
  const byName = new Map(HZ.domains.map(d => [d.name, d]));
  const cards = HZ.domainCards.filter(c => usable.some(n => byName.get(n)?.id === c.domain));
  assert.ok(cards.length > 0, '应能取到领域卡');
});

test('护甲表数值与 SRD 一致', () => {
  const byName = Object.fromEntries(daggerheart.armors.map(a => [a.name, a]));
  assert.deepEqual(
    { m: byName['皮甲'].major, s: byName['皮甲'].severe, sc: byName['皮甲'].score },
    { m: 6, s: 13, sc: 3 });
  assert.deepEqual(
    { m: byName['锁子甲'].major, s: byName['锁子甲'].severe, sc: byName['锁子甲'].score, e: byName['锁子甲'].evasion },
    { m: 7, s: 15, sc: 4, e: -1 });
  assert.equal(byName['传说全身板甲'].severe, 44);
});

test('匕首心：能造出完全合规的 1 级角色（含血统 / 社群 / 领域卡）', () => {
  const data = daggerheart.createDefault('合规英雄');
  data.className = '游荡者';
  data.subclass = daggerheart.subclassesOf('游荡者')[0].name;
  data.level = 1;
  const cls = daggerheart.classes.find(c => c.name === '游荡者');
  data.evasionBase = cls.evasion;
  data.hpMax = cls.hp;
  data.ancestry = daggerheart.ancestries[0].name;
  data.community = daggerheart.communities[0].name;
  data.traits = { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 };
  data.experiences = [{ name: '街头生存', mod: 2 }, { name: '开锁', mod: 2 }];
  data.hope = 2;
  data.stressMax = 6;
  data.armorSlotsMax = data.armorScore;

  // 领域卡必须来自职业的两个领域
  const usable = daggerheart.creation.usableDomains('游荡者');
  const picked = usable.map(name => {
    const c = daggerheart.cardsOfDomain(name)[0];
    return { name: c.name, domain: name, level: c.level };
  });
  data.domainCards = picked;

  const res = daggerheart.creation.validate(data);
  assert.deepEqual(res.errors, [], `应无 error：${JSON.stringify(res.errors)}`);
});

test('匕首心：带了不属于本职领域的卡会被拦下', () => {
  const data = daggerheart.createDefault('测试');
  data.className = '战士';                 // 领域是 利刃 / 骸骨
  data.subclass = daggerheart.subclassesOf('战士')[0].name;
  data.evasionBase = 11;
  data.hpMax = 6;
  data.traits = { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 };
  data.experiences = [{ name: 'a', mod: 2 }, { name: 'b', mod: 2 }];
  data.armorSlotsMax = data.armorScore;
  data.domainCards = [
    { name: '越界', domain: '奥术', level: 1 },
    { name: '越界2', domain: '辉耀', level: 1 },
  ];
  const res = daggerheart.creation.validate(data);
  assert.ok(res.errors.some(e => /不在 战士 的领域/.test(e.message)), JSON.stringify(res.errors));
});

test('闪避 = 基础 + 护甲修正', () => {
  const data = daggerheart.createDefault('t');
  data.evasionBase = 11;
  data.armorEvasion = -2;
  assert.equal(daggerheart.derive(data).evasion, 9);
});

test('会心一击：双骰同点自动成功', () => {
  const data = daggerheart.createDefault('t');
  const r = daggerheart.roll(data, { targetLabel: '测试', targetValue: 0, difficulty: 30, hopeDie: 7, fearDie: 7 }, new FakeRng([]));
  assert.equal(r.critical, true);
  assert.equal(r.success, true);
  assert.equal(r.total, 14);
  assert.equal(r.token, 'hope');
});

test('达到难度即成功（meets or beats）', () => {
  const data = daggerheart.createDefault('t');
  const r = daggerheart.roll(data, { targetLabel: '测试', targetValue: 0, difficulty: 14, hopeDie: 8, fearDie: 6 }, new FakeRng([]));
  assert.equal(r.total, 14);
  assert.equal(r.success, true);
});

test('希望骰更高给玩家希望，恐惧骰更高给 GM 恐惧', () => {
  const data = daggerheart.createDefault('t');
  const h = daggerheart.roll(data, { targetLabel: 't', targetValue: 0, difficulty: 5, hopeDie: 9, fearDie: 3 }, new FakeRng([]));
  assert.equal(h.token, 'hope');
  const f = daggerheart.roll(data, { targetLabel: 't', targetValue: 0, difficulty: 5, hopeDie: 3, fearDie: 9 }, new FakeRng([]));
  assert.equal(f.token, 'fear');
});

test('失败同样结算希望 / 恐惧', () => {
  const data = daggerheart.createDefault('t');
  const r = daggerheart.roll(data, { targetLabel: 't', targetValue: 0, difficulty: 40, hopeDie: 9, fearDie: 3 }, new FakeRng([]));
  assert.equal(r.success, false);
  assert.equal(r.token, 'hope');
  assert.match(r.outcomeLabel, /失败/);
});

test('反应判定不产生希望与恐惧', () => {
  const data = daggerheart.createDefault('t');
  const r = daggerheart.roll(data, { targetLabel: 't', targetValue: 0, difficulty: 5, hopeDie: 9, fearDie: 3, rollType: 'reaction' }, new FakeRng([]));
  assert.equal(r.token, null);
});

test('优势掷 1 个 d6 相加，且与劣势一对一抵消', () => {
  const data = daggerheart.createDefault('t');
  const adv = daggerheart.roll(data, { targetLabel: 't', targetValue: 0, hopeDie: 5, fearDie: 5, advantage: 1 }, new FakeRng([6]));
  assert.equal(adv.poolDie, 6);
  assert.equal(adv.total, 10 + 6);

  const both = daggerheart.roll(data, { targetLabel: 't', targetValue: 0, hopeDie: 5, fearDie: 5, advantage: 1, disadvantage: 1 }, new FakeRng([]));
  assert.equal(both.poolDie, 0, '抵消后不掷优势骰');
});

test('协助骰取最高并叠加', () => {
  const data = daggerheart.createDefault('t');
  const r = daggerheart.roll(data, { targetLabel: 't', targetValue: 0, hopeDie: 5, fearDie: 5, help: 2 }, new FakeRng([2, 6]));
  assert.equal(r.helpBonus, 6);
  assert.equal(r.total, 16);
});

test('伤害严重程度对照阈值', () => {
  assert.equal(daggerheart.damageSeverity(5, 6, 13), 1);
  assert.equal(daggerheart.damageSeverity(6, 6, 13), 2);
  assert.equal(daggerheart.damageSeverity(12, 6, 13), 2);
  assert.equal(daggerheart.damageSeverity(13, 6, 13), 3);
});

test('标记护甲槽让严重程度降一级（轻微可降为无伤）', () => {
  const data = daggerheart.createDefault('t');
  data.majorThreshold = 6; data.severeThreshold = 13;
  data.armorScore = 3; data.armorSlotsMax = 3; data.armorMarked = 0;

  assert.equal(daggerheart.resolveDamage(data, { total: 20, markArmor: true }).severity, 2);
  assert.equal(daggerheart.resolveDamage(data, { total: 8, markArmor: true }).severity, 1);
  assert.equal(daggerheart.resolveDamage(data, { total: 3, markArmor: true }).severity, 0);
  assert.equal(daggerheart.resolveDamage(data, { total: 8, markArmor: false }).severity, 2);
});

test('护甲分数为 0 时无法标记护甲槽', () => {
  const data = daggerheart.createDefault('t');
  data.armorScore = 0; data.armorSlotsMax = 0; data.armorMarked = 0;
  const r = daggerheart.resolveDamage(data, { total: 8, markArmor: true });
  assert.equal(r.markArmor, false);
  assert.equal(r.severity, 2);
});

/* ══════════════════════════ 对抗检定 ══════════════════════════ */

group('COC 对抗检定');

test('成功等级高者获胜', () => {
  const data = coc7.createDefault('x');
  data.skills['格斗（斗殴）'] = 60;   // 困难 30 / 极难 12
  // FakeRng 顺序：先我方（个位、十位），再对手（个位、十位）
  // 我方 15 → 困难成功；对手目标 40，掷 55 → 失败
  const r = coc7.rollOpposed(data, {
    targetKey: 'skill:格斗（斗殴）',
    opponent: { label: '邪教徒', value: 40 },
  }, new FakeRng([5, 1, 5, 5]));

  assert.equal(r.kind, 'opposed');
  assert.equal(r.self.roll, 15);
  assert.equal(r.self.outcome, 'hard');
  assert.equal(r.foe.roll, 55);
  assert.equal(r.foe.outcome, 'fail');
  assert.equal(r.winner, 'self');
  assert.equal(r.success, true);
});

test('对抗检定的双方标签正确写入标题与详情', () => {
  const data = coc7.createDefault('x');
  data.skills['格斗（斗殴）'] = 60;
  const r = coc7.rollOpposed(data, {
    targetKey: 'skill:格斗（斗殴）',
    opponent: { label: '邪教徒', value: 40 },
  }, new FakeRng([5, 1, 5, 5]));

  // 这两个字段曾经被写成 undefined：roll() 返回的 target 是数字，不是 {label,value}
  assert.equal(r.self.targetLabel, '格斗（斗殴）');
  assert.equal(r.foe.targetLabel, '邪教徒');
  assert.equal(typeof r.self.target, 'number');
  assert.equal(typeof r.foe.target, 'number');

  assert.ok(!r.title.includes('undefined'), `标题不应含 undefined：${r.title}`);
  assert.ok(!r.detail.includes('undefined'), `详情不应含 undefined：${r.detail}`);
  assert.match(r.title, /格斗（斗殴） vs 邪教徒/);
  assert.match(r.detail, /我方 格斗（斗殴）/);
  assert.match(r.detail, /对手 邪教徒/);
});

test('普通判定的结果也带 targetLabel', () => {
  const data = coc7.createDefault('x');
  data.skills['侦察'] = 55;
  const r = coc7.roll(data, { targetKey: 'skill:侦察' }, new FakeRng([0, 4]));
  assert.equal(r.targetLabel, '侦察');
  assert.equal(r.target, 55);
});

test('同一成功等级时按目标值高者胜', () => {
  const data = coc7.createDefault('x');
  data.skills['说服'] = 60;
  // 我方 45 → 常规成功；对手目标 40 掷 35 → 常规成功；等级相同，我方目标值更高
  const r = coc7.rollOpposed(data, {
    targetKey: 'skill:说服',
    opponent: { label: '守门人', value: 40 },
  }, new FakeRng([5, 4, 5, 3]));

  assert.equal(r.self.outcome, 'regular');
  assert.equal(r.foe.outcome, 'regular');
  assert.equal(r.winner, 'self');
});

test('对手获胜的情况', () => {
  const data = coc7.createDefault('x');
  data.skills['潜行'] = 30;
  // 我方 85 → 失败；对手目标 70 掷 20 → 困难成功
  const r = coc7.rollOpposed(data, {
    targetKey: 'skill:潜行',
    opponent: { label: '守卫', value: 70 },
  }, new FakeRng([5, 8, 0, 2]));

  assert.equal(r.winner, 'foe');
  assert.equal(r.success, false);
  assert.equal(r.outcomeLabel, '对手胜');
});

test('大成功压过对手的极难成功', () => {
  const data = coc7.createDefault('x');
  data.skills['闪避'] = 50;
  // 我方掷出 1 → 大成功（等级 4）；对手目标 90 掷 5 → 极难成功（等级 3）
  const r = coc7.rollOpposed(data, {
    targetKey: 'skill:闪避',
    opponent: { label: '猎犬', value: 90 },
  }, new FakeRng([1, 0, 5, 0]));

  assert.equal(r.self.outcome, 'critical');
  assert.equal(r.foe.outcome, 'extreme');
  assert.equal(r.winner, 'self');
});

test('对抗检定结果严格可复现', () => {
  const data = coc7.createDefault('x');
  data.skills['侦察'] = 55;
  const req = { targetKey: 'skill:侦察', opponent: { label: '黑影', value: 45 } };
  const seed = newSeed();
  const a = coc7.rollOpposed(data, req, new RNG(seed));
  const b = coc7.rollOpposed(data, req, new RNG(seed));
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
});

test('普通判定结果回显 request，便于孤注一掷复用条件', () => {
  const data = coc7.createDefault('x');
  data.skills['图书馆使用'] = 70;
  const r = coc7.roll(data, { targetKey: 'skill:图书馆使用', bonus: 1, reason: '翻查档案' }, new FakeRng([0, 4, 9]));
  assert.equal(r.request.targetKey, 'skill:图书馆使用');
  assert.equal(r.request.targetValue, 70);
  assert.equal(r.request.bonus, 1);
  assert.equal(r.request.reason, '翻查档案');
  assert.equal(r.pushed, false);
});

test('孤注一掷标记会写进标题', () => {
  const data = coc7.createDefault('x');
  data.skills['图书馆使用'] = 70;
  const r = coc7.roll(data, { targetKey: 'skill:图书馆使用', pushed: true }, new FakeRng([0, 4]));
  assert.equal(r.pushed, true);
  assert.match(r.title, /孤注一掷/);
});

/* ══════════════════════════ 死亡豁免 ══════════════════════════ */

group('DND 死亡豁免');

test('10 以上记 1 次成功', () => {
  const r = dnd5e.deathSave(new FakeRng([14]), { successes: 0, failures: 0 });
  assert.equal(r.roll, 14);
  assert.equal(r.successes, 1);
  assert.equal(r.failures, 0);
  assert.equal(r.status, 'rolling');
});

test('9 以下记 1 次失败', () => {
  const r = dnd5e.deathSave(new FakeRng([3]), { successes: 0, failures: 0 });
  assert.equal(r.failures, 1);
  assert.equal(r.status, 'rolling');
});

test('天然 20 恢复并苏醒', () => {
  const r = dnd5e.deathSave(new FakeRng([20]), { successes: 1, failures: 2 });
  assert.equal(r.status, 'revived');
  assert.equal(r.successes, 0);
  assert.equal(r.failures, 0);
  assert.equal(r.success, true);
});

test('天然 1 记 2 次失败', () => {
  const r = dnd5e.deathSave(new FakeRng([1]), { successes: 0, failures: 0 });
  assert.equal(r.failures, 2);
});

test('累计 3 次成功则伤势稳定', () => {
  const r = dnd5e.deathSave(new FakeRng([12]), { successes: 2, failures: 1 });
  assert.equal(r.successes, 3);
  assert.equal(r.status, 'stable');
  assert.equal(r.success, true);
});

test('累计 3 次失败则死亡', () => {
  const r = dnd5e.deathSave(new FakeRng([2]), { successes: 0, failures: 2 });
  assert.equal(r.failures, 3);
  assert.equal(r.status, 'dead');
  assert.equal(r.success, false);
});

test('天然 1 在已有 2 次失败时直接致死', () => {
  const r = dnd5e.deathSave(new FakeRng([1]), { successes: 0, failures: 2 });
  assert.equal(r.status, 'dead');
});

test('死亡豁免可复现', () => {
  const seed = newSeed();
  const a = dnd5e.deathSave(new RNG(seed), { successes: 1, failures: 0 });
  const b = dnd5e.deathSave(new RNG(seed), { successes: 1, failures: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
});

/* ══════════════════════════ 先攻推导 ══════════════════════════ */

group('先攻推导');

test('COC 按 DEX 静态排序', () => {
  const data = coc7.createDefault('x');
  data.attributes.dex = 75;
  const inst = coc7.initiative(data);
  assert.equal(inst.kind, 'static');
  assert.equal(inst.value, 75);
});

test('DND 用 1d20 + 敏捷调整值', () => {
  const data = dnd5e.createDefault('x');
  data.abilities.dex = 16;   // +3
  const inst = dnd5e.initiative(data);
  assert.equal(inst.kind, 'roll');
  assert.equal(inst.expr, '1d20');
  assert.equal(inst.mod, 3);
});

test('匕首心用 1d20 + 敏捷属性', () => {
  const data = daggerheart.createDefault('x');
  data.traits.agility = -1;
  const inst = daggerheart.initiative(data);
  assert.equal(inst.kind, 'roll');
  assert.equal(inst.mod, -1);
});

/* ══════════════════════════ 华渚框架 ══════════════════════════ */

group('华渚框架数据完整性');

test('13 个法门全部提取到位', () => {
  assert.equal(HZ.classes.length, 13, `实际 ${HZ.classes.length} 个`);
  const names = HZ.classes.map(c => c.name);
  for (const n of ['侠义', '戎武', '奇门', '医道', '结阵', '佛法', '五行', '剑修', '丹术', '行御', '匿影', '文韬', '阴诡']) {
    assert.ok(names.includes(n), `缺少法门：${n}`);
  }
});

test('每个法门都有领域 / 闪避 / 生命点，且都是数字', () => {
  for (const c of HZ.classes) {
    assert.ok(c.domain, `${c.name} 缺领域`);
    assert.equal(typeof c.evasion, 'number', `${c.name} 闪避不是数字`);
    assert.equal(typeof c.hp, 'number', `${c.name} 生命点不是数字`);
    assert.ok(c.evasion > 0 && c.evasion < 30, `${c.name} 闪避值异常：${c.evasion}`);
  }
});

test('55 个子职业，每个都有宗门性质 / 施法属性 / 初始物品', () => {
  const subs = HZ.classes.flatMap(c => c.subclasses);
  assert.equal(subs.length, 55, `实际 ${subs.length} 个`);
  for (const s of subs) {
    assert.ok(s.name, '子职业缺名字');
    assert.ok(s.sectNature, `${s.name} 缺宗门性质`);
    assert.ok(s.spellcastTrait, `${s.name} 缺施法属性`);
    assert.ok(s.startingItems, `${s.name} 缺初始物品`);
  }
});

test('每条子职业特性都带基石/专精/大师档位', () => {
  const TIERS = new Set(['基石特性', '专精特性', '大师特性']);
  let total = 0;
  for (const c of HZ.classes) {
    for (const s of c.subclasses) {
      assert.ok(s.features.length > 0, `${s.name} 没有任何特性`);
      for (const f of s.features) {
        total++;
        assert.ok(TIERS.has(f.tier), `${s.name} 的【${f.name}】档位异常：「${f.tier}」`);
      }
    }
  }
  assert.ok(total > 300, `特性总数偏少：${total}`);
});

test('领域 15 个、领域卡 315 张，且卡片都能对应到领域', () => {
  assert.equal(HZ.domains.length, 15);
  assert.equal(HZ.domainCards.length, 315);
  const ids = new Set(HZ.domains.map(d => d.id));
  for (const card of HZ.domainCards) {
    assert.ok(ids.has(card.domain), `领域卡「${card.name}」指向了不存在的领域：${card.domain}`);
  }
});

test('正道 12 / 邪道 3', () => {
  const zheng = HZ.domains.filter(d => d.path === '正道').length;
  const xie = HZ.domains.filter(d => d.path === '邪道').length;
  assert.equal(zheng, 12, `正道实际 ${zheng}`);
  assert.equal(xie, 3, `邪道实际 ${xie}`);
});

test('种族 27、社群 15', () => {
  assert.equal(HZ.ancestries.length, 27);
  assert.equal(HZ.communities.length, 15);
});

test('种族特性成对出现，不可扮演的种族被标注', () => {
  for (const a of HZ.ancestries) {
    assert.equal(a.traits.length, 2, `${a.name} 的特性不是 2 条`);
  }
  assert.ok(HZ.ancestries.some(a => a.playable === false), '应至少有一个不可扮演种族');
});

test('九玄技 9 项、位阶 5 级', () => {
  assert.equal(HZ.mechanics.nineMysteries.length, 9);
  assert.equal(HZ.mechanics.tiers.length, 5);
});

group('华渚机制');

test('位阶由等级推导', () => {
  assert.equal(HZ.tierFor(1), '启微境');
  assert.equal(HZ.tierFor(3), '贯枢境');
  assert.equal(HZ.tierFor(6), '栖真境');
  assert.equal(HZ.tierFor(9), '凌宸境');
  assert.equal(HZ.tierFor(10), '陆地神仙境');
});

test('位阶对越界等级不崩', () => {
  assert.ok(HZ.tierFor(0));
  assert.ok(HZ.tierFor(99));
  assert.ok(HZ.tierFor(undefined));
});

test('声望档位按正负区分', () => {
  assert.match(HZ.reputationBand(3), /善/);
  assert.match(HZ.reputationBand(-3), /恶/);
  assert.equal(HZ.reputationBand(0), '籍籍无名');
});

test('新建角色卡带有华渚特有字段', () => {
  const d = HZ.createDefault('测试');
  assert.ok(d.className, '应带默认法门');
  assert.ok(d.domain, '应带领域');
  assert.equal(typeof d.reputation, 'number');
  assert.ok(d.daoHeart, '应带道心经历');
  assert.ok(Array.isArray(d.nineMysteries));
  assert.ok(Array.isArray(d.domainCards));
});

test('派生数值含华渚专属项', () => {
  const data = HZ.createDefault('测试');
  data.level = 6;
  data.reputation = 4;
  const d = HZ.derive(data);
  const keys = d.stats.map(s => s.key);
  for (const k of ['tier', 'domain', 'sectNature', 'spellcastTrait', 'reputation', 'daoHeart', 'mysteries']) {
    assert.ok(keys.includes(k), `派生数值缺少 ${k}`);
  }
  assert.equal(d.stats.find(s => s.key === 'tier').value, '栖真境');
  assert.match(d.stats.find(s => s.key === 'reputation').value, /善/);
  assert.ok(d.tracks.find(t => t.key === 'hp'), '应保留匕首心的资源轨');
});

test('道心经历作为可掷目标出现', () => {
  const data = HZ.createDefault('测试');
  data.daoHeart = { name: '问道', mod: -2 };
  const groups = HZ.rollTargets(data);
  const all = groups.flatMap(g => g.items);
  const dh = all.find(i => i.key === 'daoheart');
  assert.ok(dh, '道心经历应出现在判定目标里');
  assert.equal(dh.value, -2);
});

test('判定机制沿用匕首之心：双重骰与希望恐惧', () => {
  const data = HZ.createDefault('测试');
  const r = HZ.roll(data, { targetLabel: '测试', targetValue: 0, difficulty: 14, hopeDie: 8, fearDie: 6 }, new RNG(newSeed()));
  assert.equal(r.total, 14);
  assert.equal(r.success, true);
  assert.equal(r.duality, 'hope');
  assert.equal(r.token, 'hope');
});

test('会心一击在华渚里同样生效', () => {
  const data = HZ.createDefault('测试');
  const r = HZ.roll(data, { targetLabel: '测试', targetValue: 0, difficulty: 30, hopeDie: 7, fearDie: 7 }, new RNG(newSeed()));
  assert.equal(r.critical, true);
  assert.equal(r.success, true);
});

test('伤害阈值机制沿用匕首之心', () => {
  const data = HZ.createDefault('测试');
  data.majorThreshold = 6; data.severeThreshold = 13;
  data.armorScore = 3; data.armorSlotsMax = 3; data.armorMarked = 0;
  assert.equal(HZ.resolveDamage(data, { total: 20, markArmor: false }).severity, 3);
  assert.equal(HZ.resolveDamage(data, { total: 20, markArmor: true }).severity, 2);
});

test('华渚与匕首心在判定上完全一致（同种子同结果）', () => {
  const seed = newSeed();
  const hz = HZ.createDefault('x');
  const dh = daggerheart.createDefault('x');
  const req = { targetLabel: '对照', targetValue: 1, difficulty: 12 };
  const a = HZ.roll(hz, req, new RNG(seed));
  const b = daggerheart.roll(dh, req, new RNG(seed));
  assert.equal(a.total, b.total, '同一套判定机制应给出相同结果');
  assert.equal(a.critical, b.critical);
});

test('领域卡按领域筛选可用', () => {
  const zhenwu = HZ.cardsOfDomain('zhenwu');
  assert.ok(zhenwu.length > 0, '真武领域应有卡');
  assert.ok(zhenwu.every(c => c.domain === 'zhenwu'));
});

test('法门子职业查询可用', () => {
  assert.ok(HZ.subclassesOf('侠义').length > 0);
  assert.deepEqual(HZ.subclassesOf('不存在的法门'), []);
});

test('装备表保留了原名以便反查基础数值', () => {
  assert.ok(HZ.equipment.weapons.length > 0);
  const w = HZ.equipment.weapons[0];
  assert.ok(w.name, '应有华渚名');
  assert.ok(w.originalName, '应保留官方中文原名');
});

test('装备数值已从基础规则补齐（武器 64 / 副武器 9 / 护甲 17）', () => {
  assert.equal(HZ.weapons.length, 64, `武器实际 ${HZ.weapons.length}`);
  assert.equal(HZ.secondaryWeapons.length, 9, `副武器实际 ${HZ.secondaryWeapons.length}`);
  assert.equal(HZ.armors.length, 17, `护甲实际 ${HZ.armors.length}`);
});

test('补出的武器数值完整且格式正确', () => {
  for (const w of HZ.weapons) {
    assert.ok(w.name, '武器缺名字');
    assert.ok(w.trait, `${w.name} 缺属性`);
    assert.ok(w.range, `${w.name} 缺射程`);
    assert.match(w.damage, /^\d*d\d+([+-]\d+)?$/, `${w.name} 伤害格式异常：${w.damage}`);
    assert.ok(w.burden, `${w.name} 缺负担`);
  }
});

test('补出的护甲阈值是数字且阈值大小关系正确', () => {
  for (const a of HZ.armors) {
    assert.equal(typeof a.major, 'number', `${a.name} 重伤阈值不是数字`);
    assert.equal(typeof a.severe, 'number', `${a.name} 致命阈值不是数字`);
    assert.ok(a.severe > a.major, `${a.name} 致命阈值应大于重伤阈值`);
    assert.ok(a.major > 0, `${a.name} 阈值异常：${a.major}`);
    assert.equal(typeof a.score, 'number', `${a.name} 护甲分数不是数字`);
    assert.ok(a.score > 0 && a.score <= 12, `${a.name} 护甲分数越界：${a.score}`);
  }
});

test('护甲选择器用的是华渚护甲名，不再落到原版表', () => {
  const names = HZ.armors.map(a => a.name);
  assert.ok(names.includes('铁浮屠'), `应含华渚护甲名，实际样例：${names.slice(0, 5).join('、')}`);
  assert.ok(!names.includes('皮甲'), '不应再出现匕首之心原版护甲名');
});

test('带闪避修正的护甲被正确识别', () => {
  const withMod = HZ.armors.filter(a => a.evasion !== 0);
  assert.ok(withMod.length >= 1, '应至少有一件护甲带闪避修正');
  for (const a of withMod) {
    assert.ok([-2, -1, 1, 2].includes(a.evasion), `${a.name} 闪避修正异常：${a.evasion}`);
  }
});

test('护甲阈值与匕首之心基础表对齐（抽查已知条目）', () => {
  const byName = new Map(HZ.armors.map(a => [a.name, a]));

  // 铁浮屠 ← Savior Chainmail，18/48 分 8，且是唯一带闪避修正的一件。
  // 提取时这里出过一次 bug：特性原文是 "-1 to all character traits and Evasion"，
  // 按 "to Evasion" 匹配会漏掉，导致闪避修正被写成 0。留作回归测试。
  const iron = byName.get('铁浮屠');
  assert.ok(iron, '应存在「铁浮屠」');
  assert.equal(iron.major, 18);
  assert.equal(iron.severe, 48);
  assert.equal(iron.score, 8);
  assert.equal(iron.evasion, -1, '救世主锁子甲的闪避修正是 −1，曾被漏掉');

  // 玄铁锁甲 ← Elundrian Chain Armor
  const chain = byName.get('玄铁锁甲');
  assert.ok(chain);
  assert.equal(chain.major, 9);
  assert.equal(chain.severe, 21);
});

test('华渚护甲覆盖 2~4 阶，且阈值随阶递增', () => {
  const tiers = new Set(HZ.armors.map(a => a.tier));
  assert.ok(tiers.has(2) && tiers.has(3) && tiers.has(4), `阶位覆盖异常：${[...tiers].join(',')}`);

  const byTier = (t) => HZ.armors.filter(a => a.tier === t).map(a => a.major);
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(avg(byTier(4)) > avg(byTier(2)), '4 阶护甲的重伤阈值平均应高于 2 阶');
});

test('武器数值与官方中文规则书样例一致', () => {
  const byName = new Map(HZ.weapons.map(w => [w.name, w]));
  // 长刀 ← Broadsword：敏捷 / 近战 / 1d8 / 单手
  const sabre = byName.get('长刀');
  assert.ok(sabre, '应存在「长刀」');
  assert.equal(sabre.trait, '敏捷');
  assert.equal(sabre.range, '近战');
  assert.equal(sabre.damage, '1d8');
  assert.equal(sabre.burden, '单手');

  // 重剑 ← Greatsword：力量 / 近战 / 1d10+3 / 双手
  const gs = byName.get('重剑');
  assert.ok(gs, '应存在「重剑」');
  assert.equal(gs.damage, '1d10+3');
  assert.equal(gs.burden, '双手');
});

/* ══════════════════════════ 规则集接口一致性 ══════════════════════════ */

group('规则集接口一致性');

for (const id of ['coc7', 'dnd5e', 'daggerheart', 'huazhu']) {
  test(`${id}：新建角色 → 派生 → 掷骰全流程`, () => {
    const rs = getRuleset(id);
    const data = rs.createDefault('测试角色');
    assert.ok(data.name);

    const d = rs.derive(data);
    assert.ok(Array.isArray(d.tracks) && d.tracks.length > 0);
    assert.ok(Array.isArray(d.stats) && d.stats.length > 0);
    for (const t of d.tracks) {
      assert.ok(typeof t.current === 'number', `${t.key}.current 应为数字`);
      assert.ok(typeof t.max === 'number', `${t.key}.max 应为数字`);
    }

    const groups = rs.rollTargets(data);
    assert.ok(groups.length > 0);
    const first = groups[0].items[0];
    assert.ok(first.key);

    const rng = new RNG(newSeed());
    const result = rs.roll(data, {
      targetKey: first.key,
      difficulty: rs.id === 'coc7' ? 'regular' : undefined,
      dc: rs.id === 'dnd5e' ? 12 : undefined,
    }, rng);
    assert.equal(result.ok, true);
    assert.ok(result.detail.length > 0, '结果应有可读描述');
    assert.ok(result.seed, '结果应带种子');
    assert.ok(typeof result.consumed === 'number');
  });
}

/* ══════════════════════════ 日志可复现性 ══════════════════════════ */

group('日志可复现性');

test('同一份判定记录用种子可完整重放', () => {
  const cases = [
    ['coc7', { targetKey: 'skill:侦察', bonus: 1, penalty: 0 }],
    ['dnd5e', { targetKey: 'skill:perception', advantage: true, dc: 15 }],
    ['daggerheart', { targetKey: 'trait:agility', advantage: 1, difficulty: 12 }],
  ];

  for (const [id, req] of cases) {
    const rs = getRuleset(id);
    const data = rs.createDefault('复现测试');
    const seed = newSeed();
    const a = rs.roll(data, req, new RNG(seed));
    const b = rs.roll(data, req, new RNG(seed));
    assert.deepEqual(
      JSON.parse(JSON.stringify(b)),
      JSON.parse(JSON.stringify(a)),
      `${id} 用同一种子应得到完全相同的结果`);
  }
});

test('自由骰式记录可复现', () => {
  const seed = newSeed();
  const a = rollExpr('4d6dl1+2', { seed });
  const b = rollExpr('4d6dl1+2', { seed });
  assert.deepEqual(a.terms[0].dice.map(d => d.v), b.terms[0].dice.map(d => d.v));
  assert.equal(a.total, b.total);
});

/* ══════════════════════════ 存储层 ══════════════════════════ */

group('存储层');

const storeTest = await (async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require('../electron/store.cjs');
})();

test('战役 / 角色 / 事件 落盘与读回', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-test-'));
  try {
    const store = new storeTest.Store(tmp);

    const cmp = store.createCampaign({ name: '测试战役', system: 'coc7' });
    assert.ok(cmp.id);

    const list = store.listCampaigns();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '测试战役');

    const ses = store.createSession(cmp.id, { name: '第一次跑团' });
    assert.equal(store.listSessions(cmp.id).activeSessionId, ses.id);

    const ev = store.appendEvents(cmp.id, ses.id, [{ type: 'roll', title: '侦察检定', detail: '1d100 = 33' }]);
    assert.equal(ev[0].seq, 2, '场次开始事件占 seq 1');

    const char = store.saveCharacter(cmp.id, {
      name: '测试调查员', system: 'coc7', data: coc7.createDefault('测试调查员'),
    }, { sessionId: ses.id });
    assert.ok(char.id);

    const back = store.getCharacter(cmp.id, char.id);
    assert.equal(back.name, '测试调查员');

    const all = store.readEvents(cmp.id, {});
    assert.ok(all.length >= 3, `应有建战役/开场次/掷骰/建卡事件，实际 ${all.length}`);
    assert.ok(all.some(e => e.type === 'roll'));
    assert.ok(all.some(e => e.title.includes('新建角色')));

    // 改卡应产生 diff 事件
    const before = store.readEvents(cmp.id, {}).length;
    store.saveCharacter(cmp.id, {
      ...back,
      data: { ...back.data, luck: 99 },
    }, { sessionId: ses.id });
    const after = store.readEvents(cmp.id, {});
    assert.ok(after.length > before, '修改角色卡应写入一条日志');
    const sheetEv = after.find(e => e.type === 'sheet' && e.detail.includes('luck'));
    assert.ok(sheetEv, 'diff 事件应指出被改的字段');
    assert.match(sheetEv.detail, /99/);

    // 搜索与过滤
    assert.equal(store.readEvents(cmp.id, { types: ['roll'] }).length, 1);
    assert.ok(store.readEvents(cmp.id, { search: '侦察' }).length >= 1);

    // Markdown 导出
    const md = store.exportMarkdown(cmp.id, {});
    assert.match(md, /# 测试战役/);
    assert.match(md, /侦察检定/);

    // 统计
    const st = store.stats(cmp.id);
    assert.equal(st.characters, 1);
    assert.equal(st.sessions, 1);

    // 删除
    store.deleteCampaign(cmp.id);
    assert.equal(store.listCampaigns().length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('战役级状态读写（战斗序列）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-test-'));
  try {
    const store = new storeTest.Store(tmp);
    const cmp = store.createCampaign({ name: '状态测试', system: 'dnd5e' });

    assert.deepEqual(store.getState(cmp.id), {}, '未写入时应返回空对象');

    store.saveState(cmp.id, {
      combat: { active: true, round: 2, turnIndex: 1, combatants: [{ id: 'cb_1', name: '哥布林', hp: 3, maxHp: 7 }] },
    });
    const st = store.getState(cmp.id);
    assert.equal(st.combat.active, true);
    assert.equal(st.combat.combatants[0].hp, 3);
    assert.ok(st.updatedAt, '应记录更新时间');

    // 浅合并：再次写入不应丢掉已有字段
    store.saveState(cmp.id, { selectedCharacterId: 'pc_x' });
    const st2 = store.getState(cmp.id);
    assert.equal(st2.selectedCharacterId, 'pc_x');
    assert.equal(st2.combat.combatants[0].name, '哥布林', '先前写入的战斗状态应保留');

    // 状态是整体覆盖 combat 字段的，验证覆盖行为
    store.saveState(cmp.id, { combat: { active: false, round: 1, turnIndex: 0, combatants: [] } });
    assert.equal(store.getState(cmp.id).combat.combatants.length, 0);
    assert.equal(store.getState(cmp.id).selectedCharacterId, 'pc_x', '其他字段仍在');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('存档导出包含战役全部内容', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-test-'));
  try {
    const store = new storeTest.Store(tmp);
    const cmp = store.createCampaign({ name: '存档测试', system: 'daggerheart' });
    const ses = store.createSession(cmp.id, { name: '第一幕' });
    store.saveCharacter(cmp.id, { name: '莉安', system: 'daggerheart', data: daggerheart.createDefault('莉安') });
    store.appendEvents(cmp.id, ses.id, [{ type: 'note', title: '一条笔记' }]);
    store.saveState(cmp.id, { combat: { active: false, round: 1, turnIndex: 0, combatants: [] } });

    const archive = store.exportArchive(cmp.id);
    assert.equal(archive.format, 'random-walking-archive');
    assert.equal(archive.version, 1);
    assert.equal(archive.campaign.name, '存档测试');
    assert.equal(archive.characters.length, 1);
    assert.equal(archive.sessions.sessions.length, 1);
    assert.ok(archive.events.some(e => e.title === '一条笔记'));
    assert.ok(archive.state.combat, '存档应包含战役状态');
    assert.ok(archive.exportedAt);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('损坏的日志行不会影响其余事件读取', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-test-'));
  try {
    const store = new storeTest.Store(tmp);
    const cmp = store.createCampaign({ name: '容错', system: 'dnd5e' });
    const ses = store.createSession(cmp.id, {});
    store.appendEvents(cmp.id, ses.id, [{ type: 'note', title: '正常事件' }]);

    fs.appendFileSync(store.logFile(cmp.id, ses.id), '{ 这不是合法 JSON\n', 'utf8');
    store.appendEvents(cmp.id, ses.id, [{ type: 'note', title: '坏行之后的事件' }]);

    const events = store.readEvents(cmp.id, {});
    assert.ok(events.some(e => e.title === '正常事件'));
    assert.ok(events.some(e => e.title === '坏行之后的事件'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ══════════════════════════ 车卡规则 ══════════════════════════ */

group('车卡规则 · COC 7 版');

test('属性按规则书公式掷出，落在合法区间', () => {
  for (let i = 0; i < 40; i++) {
    const r = coc7.creation.attributes.roll(new RNG(newSeed()));
    for (const k of ['str', 'con', 'dex', 'app', 'pow']) {
      assert.ok(r.attributes[k] >= 15 && r.attributes[k] <= 90, `${k} = ${r.attributes[k]} 超出 3d6×5 的 15~90`);
      assert.equal(r.attributes[k] % 5, 0, '应为 5 的倍数');
    }
    for (const k of ['siz', 'int', 'edu']) {
      assert.ok(r.attributes[k] >= 40 && r.attributes[k] <= 90, `${k} = ${r.attributes[k]} 超出 (2d6+6)×5 的 40~90`);
    }
    assert.ok(r.luck >= 15 && r.luck <= 90);
  }
});

test('年龄修正按规则书的额度下降', () => {
  const base = { str: 60, con: 60, dex: 60, app: 60, pow: 60, siz: 60, int: 60, edu: 60 };

  const young = coc7.creation.attributes.applyAge(base, 18);
  assert.equal(base.str - young.str + (base.siz - young.siz), 5, '15–19 岁：力量+体型合计 −5');
  assert.equal(young.edu, 55, '15–19 岁：教育 −5');

  const mid = coc7.creation.attributes.applyAge(base, 45);
  const lost = (base.str - mid.str) + (base.con - mid.con) + (base.dex - mid.dex);
  assert.equal(lost, 5, '40–49 岁：力量/体质/敏捷合计 −5');
  assert.equal(mid.app, 55, '40–49 岁：外貌 −5');
  assert.equal(mid.edu, 60, '40–49 岁不改教育');

  const old = coc7.creation.attributes.applyAge(base, 65);
  const lostOld = (base.str - old.str) + (base.con - old.con) + (base.dex - old.dex);
  assert.equal(lostOld, 20, '60–69 岁合计 −20');
  assert.equal(old.app, 45);

  const ancient = coc7.creation.attributes.applyAge(base, 85);
  assert.equal((base.str - ancient.str) + (base.con - ancient.con) + (base.dex - ancient.dex), 80);
});

test('年龄修正不会把属性压到 1 以下', () => {
  const weak = { str: 20, con: 20, dex: 20, app: 20, pow: 40, siz: 45, int: 50, edu: 50 };
  const out = coc7.creation.attributes.applyAge(weak, 85);
  for (const [k, v] of Object.entries(out)) assert.ok(v >= 1, `${k} 低于 1：${v}`);
});

test('年龄修正：某项见底时额度顺延给其它项', () => {
  // 力量只有 20，吃不下 80 点里的大部分；额度应转给体质与敏捷
  const lopsided = { str: 20, con: 90, dex: 90, app: 60, pow: 60, siz: 60, int: 60, edu: 60 };
  const out = coc7.creation.attributes.applyAge(lopsided, 85);
  assert.ok(out.str >= 1, `力量不应低于 1，实际 ${out.str}`);
  const lost = (20 - out.str) + (90 - out.con) + (90 - out.dex);
  assert.equal(lost, 80, '总额度应完整用掉');
  assert.ok(out.con < 90 && out.dex < 90, '减不动的部分应转给其它属性');
});

test('技能点预算 = 教育×4 与智力×2', () => {
  const data = coc7.createDefault('测试');
  data.attributes.edu = 70;
  data.attributes.int = 60;
  data.occupationSkills = ['侦察'];
  data.skills['侦察'] = 25 + 30;      // 基础 25，加了 30
  data.skills['图书馆使用'] = 20 + 15; // 基础 20，加了 15（非本职）

  const b = coc7.creation.budgets(data);
  const occ = b.find(x => x.key === 'occupationPoints');
  const intr = b.find(x => x.key === 'interestPoints');
  assert.equal(occ.total, 70 * 4);
  assert.equal(occ.used, 30, '只统计本职技能上的加点');
  assert.equal(intr.total, 60 * 2);
  assert.equal(intr.used, 15, '非本职的加点算进兴趣点');
});

test('技能点超支会被拦下', () => {
  const data = coc7.createDefault('测试');
  data.attributes.edu = 40;
  data.occupationSkills = ['侦察'];
  data.skills['侦察'] = 25 + 999;   // 远超 160 的预算
  const res = coc7.creation.validate(data);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => /本职技能点超出/.test(e.message)), JSON.stringify(res.errors));
});

test('本职技能超过 8 项会被拦下', () => {
  const data = coc7.createDefault('测试');
  data.occupationSkills = Object.keys(data.skills).slice(0, 9);
  const res = coc7.creation.validate(data);
  assert.ok(res.errors.some(e => /最多 8 项/.test(e.message)));
});

test('属性越界会被拦下（硬边界）', () => {
  const data = coc7.createDefault('测试');
  data.attributes.str = 0;      // 硬边界之外
  data.attributes.siz = 120;    // 硬边界之外
  const res = coc7.creation.validate(data);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => /力量/.test(e.message)));
  assert.ok(res.errors.some(e => /体型/.test(e.message)));
});

test('偏离掷骰范围只提醒、不阻止（年龄修正会合法下调）', () => {
  const data = coc7.createDefault('测试');
  data.age = 30;
  data.attributes.siz = 20;     // 掷骰最低 40，但可能是手工设定
  const res = coc7.creation.validate(data);
  assert.ok(res.warnings.some(w => /体型 20 不在掷骰范围/.test(w.message)));
  assert.ok(!res.errors.some(e => /体型/.test(e.message)), '这种情况不该是 error');
});

test('年龄修正后的属性不会被误判为越界（多次随机）', () => {
  // 这条曾经约有 25% 概率失败：极老的年龄配上很低的掷骰，
  // 旧实现会把属性压到 0，而校验要求 ≥1 —— 车卡向导会卡在玩家无法修正的错误上。
  for (let i = 0; i < 200; i++) {
    const data = coc7.createDefault('测试');
    data.age = 85;
    const rolled = coc7.creation.attributes.roll(new RNG(newSeed()));
    Object.assign(data.attributes, coc7.creation.attributes.applyAge(rolled.attributes, 85));
    const res = coc7.creation.validate(data);
    assert.ok(!res.errors.some(e => /超出 1~99/.test(e.message)),
      `第 ${i} 次出现越界：${JSON.stringify(res.errors)}`);
  }
});

group('车卡规则 · DND 5 版');

test('点数购买换算与规则书一致', () => {
  assert.equal(pointBuyCost([8, 8, 8, 8, 8, 8]), 0);
  assert.equal(pointBuyCost([13, 13, 13, 13, 13, 13]), 30);   // 5×6
  assert.equal(pointBuyCost([15, 15, 15, 8, 8, 8]), 27);      // 9×3，刚好用满 27 点
  assert.equal(pointBuyCost([14, 14, 14, 8, 8, 8]), 21);      // 7×3
  assert.equal(pointBuyCost([16, 10, 10, 10, 10, 10]), null, '16 超出点数购买上限 15');
});

test('标准数组必须是原数组的重新排列', () => {
  const data = dnd5e.createDefault('测试');
  data.creationMethod = 'standard';
  data.className = '战士';
  data.baseAbilities = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
  data.abilities = { ...data.baseAbilities };
  data.raceBonuses = {};
  data.race = '';
  const ok = dnd5e.creation.validate(data);
  assert.ok(!ok.errors.some(e => /标准数组/.test(e.message)), '正确排列不应报错');

  data.baseAbilities = { str: 15, dex: 15, con: 13, int: 12, wis: 10, cha: 8 };
  const bad = dnd5e.creation.validate(data);
  assert.ok(bad.errors.some(e => /标准数组/.test(e.message)), '重复值应被拦下');
});

test('点数购买超支会被拦下', () => {
  const data = dnd5e.createDefault('测试');
  data.creationMethod = 'pointbuy';
  data.baseAbilities = { str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 };  // 54 点
  data.abilities = { ...data.baseAbilities };
  const res = dnd5e.creation.validate(data);
  assert.ok(res.errors.some(e => /点数超出预算/.test(e.message)), JSON.stringify(res.errors));
});

test('种族加值正确叠加并可反推', () => {
  const data = dnd5e.createDefault('测试');
  data.baseAbilities = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  const res = dnd5e.creation.attributes.applyRace(data, '山地矮人');
  assert.equal(res.abilities.con, 12, '山地矮人 体质 +2');
  assert.equal(res.abilities.str, 12, '山地矮人 力量 +2');
  assert.equal(res.abilities.dex, 10);
  assert.equal(res.baseAbilities.con, 10, '基础值应保持不变');
});

test('半精灵需要自选两项 +1', () => {
  const data = dnd5e.createDefault('测试');
  data.baseAbilities = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

  const two = dnd5e.creation.attributes.applyRace(data, '半精灵', ['str', 'dex']);
  assert.equal(two.abilities.cha, 12, '半精灵 魅力 +2');
  assert.equal(two.abilities.str, 11);
  assert.equal(two.abilities.dex, 11);

  data.race = '半精灵';
  Object.assign(data, two);
  const good = dnd5e.creation.validate(data);
  assert.ok(!good.errors.some(e => /自选/.test(e.message)), '选够两项不应报错');

  Object.assign(data, dnd5e.creation.attributes.applyRace(data, '半精灵', ['str']));
  const bad = dnd5e.creation.validate(data);
  assert.ok(bad.errors.some(e => /自选 2 项/.test(e.message)), '只选一项应被拦下');
});

test('1 级生命值 = 生命骰满值 + 体质调整值', () => {
  const abilities = { str: 10, dex: 10, con: 14, int: 10, wis: 10, cha: 10 };  // CON +2
  assert.equal(dnd5e.creation.expectedHp('战士', 1, abilities), 10 + 2);
  assert.equal(dnd5e.creation.expectedHp('法师', 1, abilities), 6 + 2);
  assert.equal(dnd5e.creation.expectedHp('野蛮人', 1, abilities), 12 + 2);
});

test('职业决定豁免熟练与技能数量', () => {
  const data = dnd5e.createDefault('测试');
  data.className = '游荡者';
  data.level = 1;
  data.abilities = { str: 10, dex: 16, con: 10, int: 12, wis: 10, cha: 10 };
  data.baseAbilities = { ...data.abilities };
  data.raceBonuses = {};
  data.combat.hpMax = 8 + 3;
  data.proficiency.saves = ['dex', 'int'];
  data.proficiency.skills = ['体操', '调查'];

  const res = dnd5e.creation.validate(data);
  assert.ok(res.errors.some(e => /恰好选 4 项/.test(e.message)), '游荡者只选了 2 项，应报错');

  data.proficiency.skills = ['体操', '调查', '察觉', '隐匿'];
  const ok = dnd5e.creation.validate(data);
  assert.ok(!ok.errors.some(e => /技能/.test(e.message)), '选够 4 项后不应再有技能相关的错误');
});

test('选了职业技能表以外的技能会被拦下', () => {
  const data = dnd5e.createDefault('测试');
  data.className = '战士';
  data.level = 1;
  data.abilities = { str: 16, dex: 14, con: 14, int: 10, wis: 10, cha: 10 };
  data.baseAbilities = { ...data.abilities };
  data.raceBonuses = {};
  data.combat.hpMax = 10 + 2;
  data.proficiency.saves = ['str', 'con'];
  data.proficiency.skills = ['运动', '奥秘'];   // 奥秘不在战士技能表里
  const res = dnd5e.creation.validate(data);
  assert.ok(res.errors.some(e => /不在 战士 的技能表里/.test(e.message)), JSON.stringify(res.errors));
});

group('车卡规则 · 匕首心 / 华渚');

test('起始属性数组必须恰好用掉 +2/+1/+1/0/0/−1', () => {
  const data = daggerheart.createDefault('测试');
  data.className = '战士';
  data.evasionBase = 11;
  data.hpMax = 6;
  data.armorSlotsMax = data.armorScore;
  data.traits = { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 };
  data.experiences = [{ name: 'a', mod: 2 }, { name: 'b', mod: 2 }];

  const ok = daggerheart.creation.validate(data);
  assert.ok(!ok.errors.some(e => /起始数组/.test(e.message)), JSON.stringify(ok.errors));

  data.traits = { agility: 2, strength: 2, finesse: 0, instinct: 0, presence: 0, knowledge: -1 };
  const bad = daggerheart.creation.validate(data);
  assert.ok(bad.errors.some(e => /属性分配不合法/.test(e.message)), '重复用 +2 应被拦下');
});

test('职业闪避与生命点会被校验', () => {
  const data = daggerheart.createDefault('测试');
  data.className = '游荡者';
  data.traits = { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 };
  data.evasionBase = 11;   // 游荡者应为 12
  data.hpMax = 9;          // 应为 6
  const res = daggerheart.creation.validate(data);
  assert.ok(res.errors.some(e => /起始闪避应为 12/.test(e.message)));
  assert.ok(res.errors.some(e => /起始生命点应为 6/.test(e.message)));
});

test('经历与领域卡数量按等级校验', () => {
  const data = daggerheart.createDefault('测试');
  data.className = '战士';
  data.evasionBase = 11;
  data.hpMax = 6;
  data.armorSlotsMax = data.armorScore;
  data.traits = { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 };
  data.experiences = [];
  data.domainCards = [];
  data.level = 1;
  const res = daggerheart.creation.validate(data);
  assert.ok(res.errors.some(e => /应有 2 条经历/.test(e.message)));
  assert.ok(res.errors.some(e => /应有 2 张领域卡/.test(e.message)));

  data.level = 3;
  const res3 = daggerheart.creation.validate(data);
  assert.ok(res3.errors.some(e => /应有 4 条经历/.test(e.message)), '3 级应要 4 条经历');
});

test('护甲槽必须等于护甲分数', () => {
  const data = daggerheart.createDefault('测试');
  data.className = '战士';
  data.evasionBase = 11;
  data.hpMax = 6;
  data.traits = { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 };
  data.experiences = [{ name: 'a', mod: 2 }, { name: 'b', mod: 2 }];
  data.domainCards = [{ name: 'x', domain: 'y', level: 1 }];
  data.domainCards.push({ name: 'z', domain: 'y', level: 1 });
  data.armorScore = 3;
  data.armorSlotsMax = 5;
  const res = daggerheart.creation.validate(data);
  assert.ok(res.errors.some(e => /护甲槽数量应等于护甲分数/.test(e.message)));
});

test('华渚：法门与宗门必须匹配，领域自动带出', () => {
  const data = HZ.createDefault('测试');
  data.className = '剑修';
  data.subclass = '云隐剑宗';
  const cls = HZ.classes.find(c => c.name === '剑修');
  const sub = cls.subclasses.find(s => s.name === '云隐剑宗');
  if (!sub) { assert.ok(cls.subclasses.length > 0, '剑修应有宗门'); return; }

  data.evasionBase = cls.evasion;
  data.hpMax = cls.hp;
  data.domain = cls.domain;
  data.sectNature = sub.sectNature;
  data.spellcastTrait = sub.spellcastTrait;
  data.traits = { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 };
  data.experiences = [{ name: 'a', mod: 2 }, { name: 'b', mod: 2 }];
  data.domainCards = [];
  data.armorSlotsMax = data.armorScore;

  const usable = HZ.creation.usableDomains(data);
  assert.ok(usable.includes(cls.domain), `可用领域应含法门领域 ${cls.domain}`);

  // 从可用领域里挑两张卡
  const dom = HZ.domains.find(d => d.name === usable[0]);
  const cards = HZ.domainCards.filter(c => c.domain === dom.id).slice(0, 2);
  data.domainCards = cards.map(c => ({ name: c.name, domain: dom.name, level: c.level }));

  const res = HZ.creation.validate(data);
  assert.ok(!res.errors.some(e => /不在你的可用领域/.test(e.message)), JSON.stringify(res.errors));
});

test('华渚：选了不属于可用领域的卡会被拦下', () => {
  const data = HZ.createDefault('测试');
  data.className = '剑修';
  const cls = HZ.classes.find(c => c.name === '剑修');
  data.subclass = cls.subclasses[0]?.name || '';
  data.domain = cls.domain;
  data.evasionBase = cls.evasion;
  data.hpMax = cls.hp;
  data.traits = { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 };
  data.experiences = [{ name: 'a', mod: 2 }, { name: 'b', mod: 2 }];
  data.armorSlotsMax = data.armorScore;
  data.domainCards = [
    { name: '越界卡', domain: '一个不存在的领域', level: 1 },
    { name: '越界卡2', domain: '另一个不存在的领域', level: 1 },
  ];
  const res = HZ.creation.validate(data);
  assert.ok(res.errors.some(e => /不在你的可用领域/.test(e.message)), JSON.stringify(res.errors).slice(0, 200));
});

test('四套规则的 createDefault 都能被 validate 处理而不崩', () => {
  for (const id of ['coc7', 'dnd5e', 'daggerheart', 'huazhu']) {
    const rs = getRuleset(id);
    assert.ok(rs.creation, `${id} 缺少 creation 规格`);
    const data = rs.createDefault('测试');
    const res = rs.creation.validate(data);
    assert.ok(Array.isArray(res.errors) && Array.isArray(res.warnings), `${id} 校验结果结构不对`);
    assert.ok(rs.creation.budgets, `${id} 缺少 budgets`);
    assert.ok(Array.isArray(rs.creation.budgets(data)), `${id} budgets 应返回数组`);
  }
});

group('车卡规则 · 可满足性');

test('COC：能造出完全合规的调查员', () => {
  const data = coc7.createDefault('合规调查员');
  const rolled = coc7.creation.attributes.roll(new RNG(newSeed()));
  Object.assign(data.attributes, coc7.creation.attributes.applyAge(rolled.attributes, data.age));
  data.luck = rolled.luck;
  data.state.luck = rolled.luck;

  // 标记 8 项本职技能，并把职业点与兴趣点花在预算内
  data.occupationSkills = ['侦察', '聆听', '图书馆使用', '心理学', '潜行', '急救', '说服', '闪避'];
  const occBudget = data.attributes.edu * 4;
  const perSkill = Math.floor(occBudget / 8);
  for (const name of data.occupationSkills) {
    data.skills[name] = (data.skills[name] || 0) + perSkill;
  }
  const intBudget = data.attributes.int * 2;
  data.skills['历史'] += intBudget;

  const res = coc7.creation.validate(data);
  assert.deepEqual(res.errors, [], `应无 error：${JSON.stringify(res.errors)}`);
});

test('DND：能造出完全合规的 1 级角色', () => {
  const data = dnd5e.createDefault('合规冒险者');
  data.creationMethod = 'standard';
  data.className = '战士';
  data.race = '山地矮人';
  data.level = 1;
  data.baseAbilities = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
  Object.assign(data, dnd5e.creation.attributes.applyRace(data, '山地矮人'));
  data.proficiency.saves = ['str', 'con'];
  data.proficiency.skills = ['运动', '察觉'];
  data.combat.hpMax = dnd5e.creation.expectedHp('战士', 1, data.abilities);

  const res = dnd5e.creation.validate(data);
  assert.deepEqual(res.errors, [], `应无 error：${JSON.stringify(res.errors)}`);
});

test('匕首心：能造出完全合规的 1 级角色', () => {
  const data = daggerheart.createDefault('合规英雄');
  data.className = '游荡者';
  data.level = 1;
  const cls = daggerheart.classes.find(c => c.name === '游荡者');
  data.evasionBase = cls.evasion;
  data.hpMax = cls.hp;
  data.traits = { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 };
  data.experiences = [{ name: '街头生存', mod: 2 }, { name: '开锁', mod: 2 }];
  data.domainCards = [
    { name: '暗影步', domain: '午夜', level: 1 },
    { name: '疾风连击', domain: '优雅', level: 1 },
  ];
  data.hope = 2;
  data.stressMax = 6;
  data.armorSlotsMax = data.armorScore;

  const res = daggerheart.creation.validate(data);
  assert.deepEqual(res.errors, [], `应无 error：${JSON.stringify(res.errors)}`);
});

test('华渚：能造出完全合规的 1 级修行者（领域卡来自法门或宗门）', () => {
  const data = HZ.createDefault('合规修行者');
  data.className = '剑修';
  const cls = HZ.classes.find(c => c.name === '剑修');
  data.subclass = cls.subclasses[0].name;
  const sub = cls.subclasses[0];
  data.domain = cls.domain;
  data.sectNature = sub.sectNature;
  data.spellcastTrait = sub.spellcastTrait;
  data.evasionBase = cls.evasion;
  data.hpMax = cls.hp;
  data.level = 1;
  data.traits = { agility: 2, strength: 1, finesse: 1, instinct: 0, presence: 0, knowledge: -1 };
  data.experiences = [{ name: '山野求生', mod: 2 }, { name: '辨认真气', mod: 2 }];
  data.hope = 2;
  data.stressMax = 6;
  data.armorSlotsMax = data.armorScore;
  data.daoHeart = { name: '剑心通明', mod: -2 };

  // 从可用领域里各取一张
  const usable = HZ.creation.usableDomains(data);
  assert.ok(usable.length >= 1, '应至少有一个可用领域');
  const picked = [];
  for (const domainName of usable) {
    const dom = HZ.domains.find(d => d.name === domainName);
    if (!dom) continue;
    const card = HZ.domainCards.find(c => c.domain === dom.id);
    if (card) picked.push({ name: card.name, domain: dom.name, level: card.level });
    if (picked.length >= 2) break;
  }
  // 只有一个可用领域时，从同一领域取两张
  if (picked.length < 2) {
    const dom = HZ.domains.find(d => d.name === usable[0]);
    const more = HZ.domainCards.filter(c => c.domain === dom.id).slice(0, 2);
    picked.length = 0;
    for (const c of more) picked.push({ name: c.name, domain: dom.name, level: c.level });
  }
  data.domainCards = picked;

  const res = HZ.creation.validate(data);
  assert.deepEqual(res.errors, [], `应无 error：${JSON.stringify(res.errors)}`);
});

/* ══════════════════════════ 渲染层接口一致性 ══════════════════════════ */

group('渲染层接口一致性');

test('视图里用到的 app.* 方法都在 app.js 的导出对象里', () => {
  const rendererDir = path.join(import.meta.dirname, '..', 'src', 'renderer');
  const appSrc = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');

  // 取 `export const app = { ... };` 里列出的键
  const objMatch = /export const app = \{([\s\S]*?)\n\};/.exec(appSrc);
  assert.ok(objMatch, '没能从 app.js 里解析出 app 导出对象');
  const exported = new Set(
    [...objMatch[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*,/gm)].map(m => m[1]),
  );
  assert.ok(exported.size > 10, `解析出的导出项太少（${exported.size}），正则可能失效了`);

  // 视图里每一处 app.xxx( 都必须能在导出对象里找到。
  // 这条测试是为了防住「函数写好了但忘了加进 app 对象」——视图一调用就崩，
  // 而且只有真的点到那个界面才会暴露。
  const viewsDir = path.join(rendererDir, 'views');
  const missing = [];
  for (const f of fs.readdirSync(viewsDir).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(viewsDir, f), 'utf8');
    for (const m of src.matchAll(/\bapp\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!exported.has(m[1])) missing.push(`${f} → app.${m[1]}()`);
    }
  }
  assert.deepEqual(missing, [], `以下方法被视图调用但没在 app.js 中导出：\n  ${missing.join('\n  ')}`);
});

test('渲染层不会用到没 import 的核心函数', () => {
  const root = path.join(import.meta.dirname, '..');
  const coreDir = path.join(root, 'src', 'core');

  // 收集核心层所有具名导出
  const coreExports = new Set();
  const walkCore = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walkCore(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        coreExports.add(m[1]);
      }
    }
  };
  walkCore(coreDir);
  assert.ok(coreExports.size > 30, `解析到的核心导出太少（${coreExports.size}）`);

  const rendererDir = path.join(root, 'src', 'renderer');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(rendererDir);

  // 浏览器全局 + 模块内常见的局部名，避免误报
  const GLOBALS = new Set([
    'document', 'window', 'console', 'fetch', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'requestAnimationFrame', 'alert', 'confirm',
    'prompt', 'Event', 'CustomEvent', 'URL', 'URLSearchParams', 'TextEncoder',
    'TextDecoder', 'AbortController', 'structuredClone', 'queueMicrotask',
    'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent',
    'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date',
    'Map', 'Set', 'Promise', 'Error', 'RegExp', 'Symbol', 'BigInt', 'Function',
  ]);

  const problems = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(rendererDir, f);

    // 本文件 import 进来的名字
    const imported = new Set();
    for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
      const clause = m[1];
      const braces = /\{([\s\S]*?)\}/.exec(clause);
      if (braces) {
        for (const part of braces[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/).pop().trim();
          if (name) imported.add(name);
        }
      }
      const def = clause.replace(/\{[\s\S]*?\}/, '').replace(/,/g, '').trim();
      if (def && !def.startsWith('*')) imported.add(def.split(/\s+/)[0]);
      const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      if (ns) imported.add(ns[1]);
    }

    // 本文件自己声明的名字（顶层或嵌套都算）
    const declared = new Set();
    for (const m of src.matchAll(/\b(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
      declared.add(m[1]);
    }
    // 解构出来的名字也算
    for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/[:\s]/).pop().replace(/=.*$/, '').trim();
        if (name) declared.add(name);
      }
    }

    for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (!coreExports.has(name)) continue;
      if (imported.has(name) || declared.has(name) || GLOBALS.has(name)) continue;
      problems.push(`${rel} → ${name}()`);
    }
  }
  assert.deepEqual([...new Set(problems)], [],
    `以下核心函数被调用但没有 import（运行到那一行才会炸）：\n  ${[...new Set(problems)].join('\n  ')}`);
});

test('前端模块之间的相对导入路径都存在', () => {
  const rendererDir = path.join(import.meta.dirname, '..', 'src', 'renderer');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(rendererDir);

  const broken = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      if (!fs.existsSync(target)) {
        broken.push(`${path.relative(rendererDir, f)} → ${m[1]}`);
      }
    }
  }
  assert.deepEqual(broken, [], `以下导入指向了不存在的文件：\n  ${broken.join('\n  ')}`);
});

test('所有 JSON 文件不带 BOM 且能解析', () => {
  // 这条是为了防住一个只在打包时才暴露的问题：
  // 在 Windows PowerShell 5.1 里用 `Set-Content -Encoding UTF8` 改 package.json，
  // 会写入 BOM，导致 electron-builder 报 "Unexpected token ''，is not valid JSON"。
  // 平时跑测试完全看不出来，只有打包才炸。
  const root = path.join(import.meta.dirname, '..');
  const targets = ['package.json', 'package-lock.json'];
  const dataDir = path.join(root, 'src', 'core', 'rulesets', 'huazhu', 'data');
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir).filter(x => x.endsWith('.json'))) {
      targets.push(path.join('src', 'core', 'rulesets', 'huazhu', 'data', f));
    }
  }

  const problems = [];
  for (const rel of targets) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      problems.push(`${rel} 带 BOM`);
      continue;
    }
    try { JSON.parse(buf.toString('utf8')); }
    catch (err) { problems.push(`${rel} 解析失败：${err.message}`); }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

/* ══════════════════════════ 行动系统 ══════════════════════════ */

group('行动系统');

test('四套规则都提供行动预设，且字段合法', () => {
  for (const id of ['coc7', 'dnd5e', 'daggerheart', 'huazhu']) {
    const rs = getRuleset(id);
    const presets = rs.actionPresets;
    assert.ok(Array.isArray(presets) && presets.length > 0, `${id} 没有行动预设`);
    for (const p of presets) {
      assert.ok(p.name, `${id} 有预设缺名字`);
      assert.ok(['action', 'bonus', 'reaction', 'free'].includes(p.kind || 'action'),
        `${id} 的「${p.name}」行动经济非法：${p.kind}`);
    }
  }
});

test('每套规则的行动经济分类都有定义', () => {
  for (const id of ['coc7', 'dnd5e', 'daggerheart', 'huazhu']) {
    const kinds = kindsFor(id);
    assert.ok(kinds.length > 0, `${id} 没有定义行动经济`);
    for (const k of kinds) {
      assert.ok(k.id && k.label, `${id} 的行动经济缺字段`);
    }
  }
});

test('DND 的行动经济包含主要 / 附赠 / 反应三类', () => {
  const ids = kindsFor('dnd5e').map(k => k.id);
  for (const want of ['action', 'bonus', 'reaction']) {
    assert.ok(ids.includes(want), `DND 应包含 ${want}`);
  }
  const presets = dnd5e.actionPresets;
  assert.ok(presets.some(p => p.kind === 'bonus'), '应有附赠动作预设');
  assert.ok(presets.some(p => p.kind === 'reaction'), '应有反应预设');
});

test('blankAction 生成字段齐全的行动', () => {
  const a = blankAction();
  assert.ok(a.id);
  assert.equal(a.kind, 'action');
  assert.deepEqual(a.check, {});
  assert.deepEqual(a.cost, {});
  assert.equal(a.damage, '');
});

test('actionFromPreset 不会与预设共享引用', () => {
  const preset = { name: '攻击', kind: 'action', check: { targetKey: 'x' }, cost: { hope: 1 } };
  const a1 = actionFromPreset(preset);
  const a2 = actionFromPreset(preset);
  a1.check.targetKey = '改过了';
  a1.cost.hope = 99;
  assert.equal(a2.check.targetKey, 'x', 'check 应是深拷贝');
  assert.equal(a2.cost.hope, 1, 'cost 应是深拷贝');
  assert.notEqual(a1.id, a2.id);
});

test('normalizeAction 对残缺数据补齐而不崩', () => {
  for (const bad of [null, undefined, {}, { name: 'x' }, { check: null, cost: 'nope' }]) {
    const a = normalizeAction(bad);
    assert.ok(a.id && a.name && a.kind);
    assert.equal(typeof a.check, 'object');
    assert.equal(typeof a.cost, 'object');
  }
});

test('resolveAction 复用规则集判定，并给出伤害', () => {
  const data = coc7.createDefault('测试');
  data.skills['格斗（斗殴）'] = 60;
  const action = actionFromPreset(
    coc7.actionPresets.find(p => p.name === '格斗攻击'),
  );
  // 个位 5、十位 1 → 15，对 60 是困难成功
  const res = resolveAction(coc7, data, action, new FakeRng([5, 1, 2]));
  assert.equal(res.check.roll, 15);
  assert.equal(res.check.success, true);
  assert.ok(res.damage?.ok, '判定成功应掷伤害');
  assert.ok(res.damage.expr, '伤害应记录骰式');
  assert.equal(typeof res.damageTotal, 'number');
  assert.equal(res.action.name, action.name);
});

test('判定失败时不掷伤害', () => {
  const data = coc7.createDefault('测试');
  data.skills['格斗（斗殴）'] = 30;
  const action = actionFromPreset(coc7.actionPresets.find(p => p.name === '格斗攻击'));
  // 个位 0、十位 9 → 90，对 30 是失败
  const res = resolveAction(coc7, data, action, new FakeRng([0, 9]));
  assert.equal(res.check.success, false);
  assert.equal(res.damage, null, '失败不该掷伤害');
});

test('未设难度时 success 为 null，仍会掷伤害', () => {
  const data = daggerheart.createDefault('测试');
  data.traits.strength = 2;
  const action = actionFromPreset(daggerheart.actionPresets.find(p => p.name === '攻击判定'));
  const res = resolveAction(daggerheart, data, action, new RNG(newSeed()));
  assert.equal(res.check.success, null, '匕首心默认不设难度');
  assert.ok(res.damage?.ok, '无难度时应照常掷伤害');
});

test('反应类行动在匕首心里标记为 reaction（不产生希望/恐惧）', () => {
  const data = daggerheart.createDefault('测试');
  const action = actionFromPreset(daggerheart.actionPresets.find(p => p.name === '反应判定'));
  const res = resolveAction(daggerheart, data, action, new RNG(newSeed()));
  assert.equal(res.check.rollType, 'reaction');
  assert.equal(res.check.token, null, '反应判定不产生希望或恐惧');
});

test('非法伤害骰式不会让结算崩，而是记下错误', () => {
  const data = coc7.createDefault('测试');
  data.skills['格斗（斗殴）'] = 90;
  const action = actionFromPreset({ name: '测试', check: { targetKey: 'skill:格斗（斗殴）' }, damage: '不是骰式' });
  const res = resolveAction(coc7, data, action, new FakeRng([5, 1]));
  assert.equal(res.damage.ok, false);
  assert.match(res.damage.error, /伤害骰式无效/);
  assert.equal(res.damageTotal, null);
});

test('describeCost 只列出大于 0 的消耗', () => {
  assert.equal(describeCost({ hope: 2, stress: 0 }), '希望 −2');
  assert.equal(describeCost({ hope: 1, stress: 1 }), '希望 −1，压力 −1');
  assert.equal(describeCost({}), '');
  assert.equal(describeCost(null), '');
});

test('describeActionResult 拼出可读的一行', () => {
  const data = coc7.createDefault('测试');
  data.skills['格斗（斗殴）'] = 90;
  const action = actionFromPreset({ name: '测试', check: { targetKey: 'skill:格斗（斗殴）' }, damage: '1d4' });
  const res = resolveAction(coc7, data, action, new FakeRng([5, 1, 3]));
  const line = describeActionResult(res);
  assert.match(line, /1d100 = 15/);
  assert.match(line, /伤害 1d4 = 3/);
});

test('华渚的行动预设在匕首心基础上扩展', () => {
  const base = daggerheart.actionPresets.map(p => p.name);
  const hz = HZ.actionPresets.map(p => p.name);
  for (const n of base) assert.ok(hz.includes(n), `华渚应包含匕首心的「${n}」`);
  assert.ok(hz.length > base.length, '华渚应有额外的行动');
  assert.ok(hz.some(n => n.includes('炁')), '应有华渚特有的炁相关行动');
});

test('行动判定结果可复现', () => {
  const data = coc7.createDefault('测试');
  data.skills['格斗（斗殴）'] = 60;
  const action = actionFromPreset(coc7.actionPresets.find(p => p.name === '格斗攻击'));
  const seed = newSeed();
  const a = resolveAction(coc7, data, action, new RNG(seed));
  const b = resolveAction(coc7, data, action, new RNG(seed));
  assert.equal(a.check.roll, b.check.roll);
  assert.equal(a.damageTotal, b.damageTotal);
  assert.equal(a.seed, b.seed);
});

test('expandDamageExpr 把 DB 换成实际伤害加值', () => {
  const mk = (str, siz) => ({ attributes: { str, siz } });
  // STR+SIZ = 100 → DB 为 0
  assert.equal(expandDamageExpr(coc7, mk(50, 50), '1d3+DB'), '1d3+0');
  // STR+SIZ = 150 → DB 为 +1D4，多出来的 + 应被合并
  assert.equal(expandDamageExpr(coc7, mk(75, 75), '1d3+DB'), '1d3+1D4');
  // STR+SIZ = 60 → DB 为 -2
  assert.equal(expandDamageExpr(coc7, mk(30, 30), '1d3+DB'), '1d3-2');
  // 破折号：STR+SIZ = 200 → DB 为 +1D6
  assert.equal(expandDamageExpr(coc7, mk(100, 100), '1d3+DB'), '1d3+1D6');
});

test('expandDamageExpr 对没有符号声明的规则集原样返回', () => {
  assert.equal(expandDamageExpr(daggerheart, {}, '2d8'), '2d8');
  assert.equal(expandDamageExpr(daggerheart, {}, ''), '');
});

test('expandDamageExpr 把 DND 的力量调整值展开', () => {
  assert.equal(expandDamageExpr(dnd5e, { abilities: { str: 16, dex: 10 } }, '1d8+STR'), '1d8+3');
  assert.equal(expandDamageExpr(dnd5e, { abilities: { str: 8, dex: 10 } }, '1d8+STR'), '1d8-1');
  assert.equal(expandDamageExpr(dnd5e, { abilities: { str: 10, dex: 18 } }, '1d6+DEX'), '1d6+4');
});

test('克苏鲁的格斗攻击能掷出真实伤害（DB 已被代入）', () => {
  const data = coc7.createDefault('测试');
  data.attributes.str = 75;
  data.attributes.siz = 75;
  data.skills['格斗（斗殴）'] = 90;
  const action = actionFromPreset(coc7.actionPresets.find(p => p.name === '格斗攻击'));
  const res = resolveAction(coc7, data, action, new FakeRng([5, 1, 2, 3]));
  assert.ok(res.damage?.ok, `应能结算伤害：${JSON.stringify(res.damage)}`);
  assert.equal(res.damage.expr, '1d3+1D4');
  assert.equal(res.damageTotal, 2 + 3);
});

test('DND 的攻击预设用角色的力量调整值而非写死的 +3', () => {
  const data = dnd5e.createDefault('测试');
  data.abilities.str = 8; // 调整值 -1
  data.proficiency.skills = [];
  const action = actionFromPreset(dnd5e.actionPresets.find(p => p.name === '攻击'));
  const res = resolveAction(dnd5e, data, action, new RNG(newSeed()));
  assert.ok(res.damage?.ok);
  assert.match(res.damage.expr, /^1d8(\+0|-1)$/, `伤害骰式应代入调整值：${res.damage.expr}`);
});

test('DND 的攻击在力量 10 时不出现 ++ 这类坏骰式', () => {
  const data = dnd5e.createDefault('测试');
  data.abilities.str = 10;
  const action = actionFromPreset(dnd5e.actionPresets.find(p => p.name === '攻击'));
  const res = resolveAction(dnd5e, data, action, new RNG(newSeed()));
  assert.ok(res.damage?.ok, JSON.stringify(res.damage));
  assert.ok(!res.damage.expr.includes('++'), res.damage.expr);
});

/* ══════════════════════════ 行动经济 ══════════════════════════ */

group('行动经济');

test('每一类行动都有自己的重置周期', () => {
  assert.equal(scopeOf('action'), 'turn');
  assert.equal(scopeOf('bonus'), 'turn');
  assert.equal(scopeOf('reaction'), 'round');
  assert.equal(scopeOf('free'), 'none');
  assert.equal(scopeOf('没见过的类别'), 'turn');
  for (const id of ['coc7', 'dnd5e', 'daggerheart', 'huazhu']) {
    for (const k of kindsFor(id)) {
      assert.ok(ACTION_KIND_SCOPE[k.id], `${id} 的「${k.id}」没有定义重置周期`);
    }
  }
});

test('没用过的时候什么都能做', () => {
  assert.equal(canUseKind({}, 'a', 'action'), true);
  assert.equal(canUseKind(undefined, 'a', 'reaction'), true);
  assert.deepEqual(spentKinds(undefined, 'a'), {});
});

test('用过之后同类行动被占掉，其他类不受影响', () => {
  let used = markKindUsed({}, 'a', 'action');
  assert.equal(canUseKind(used, 'a', 'action'), false);
  assert.equal(canUseKind(used, 'a', 'bonus'), true);
  assert.equal(canUseKind(used, 'a', 'reaction'), true);
  // 别人不受影响
  assert.equal(canUseKind(used, 'b', 'action'), true);
});

test('自由行动永远不会被占掉', () => {
  const used = markKindUsed({}, 'a', 'free');
  assert.equal(canUseKind(used, 'a', 'free'), true);
  assert.deepEqual(used, {});
});

test('markKindUsed 不修改传入的对象', () => {
  const first = markKindUsed({}, 'a', 'action');
  const second = markKindUsed(first, 'a', 'bonus');
  assert.deepEqual(first, { a: { action: true } });
  assert.deepEqual(second, { a: { action: true, bonus: true } });
});

test('轮到某人时他拿回每回合的行动，别人不拿', () => {
  const used = { a: { action: true, bonus: true }, b: { action: true } };
  refreshUsage(used, 'a', false);
  assert.equal(canUseKind(used, 'a', 'action'), true);
  assert.equal(canUseKind(used, 'a', 'bonus'), true);
  assert.equal(canUseKind(used, 'b', 'action'), false, '没轮到的角色不该刷新');
});

test('进入新一轮时所有人的反应都拿回来', () => {
  const used = { a: { action: true, reaction: true }, b: { reaction: true } };
  refreshUsage(used, 'a', true);
  assert.equal(canUseKind(used, 'a', 'reaction'), true);
  assert.equal(canUseKind(used, 'b', 'reaction'), true, '新一轮所有人都拿回反应');
});

test('同一轮内换人不会拿回反应', () => {
  const used = markKindUsed({}, 'a', 'reaction');
  refreshUsage(used, 'b', false);
  assert.equal(canUseKind(used, 'a', 'reaction'), false, '反应按轮算，换人不刷新');
});

test('DND 主要动作每回合一次，反应每轮一次', () => {
  let used = {};
  used = markKindUsed(used, 'pc', 'action');
  used = markKindUsed(used, 'pc', 'reaction');
  assert.equal(canUseKind(used, 'pc', 'action'), false);
  assert.equal(canUseKind(used, 'pc', 'reaction'), false);
  // 同一轮里换到别人再换回来，反应仍然是空的
  refreshUsage(used, 'npc', false);
  refreshUsage(used, 'pc', false);
  assert.equal(canUseKind(used, 'pc', 'action'), true, '新回合主要动作恢复');
  assert.equal(canUseKind(used, 'pc', 'reaction'), false, '同一轮反应不恢复');
});

/* ══════════════════════════ 数据目录配置 ══════════════════════════ */

group('数据目录配置');

const configMod = await (async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('../electron/config.cjs');
})();

test('没有配置文件时返回默认值', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-cfg-'));
  try {
    const cfg = configMod.readConfig(path.join(tmp, 'nope.json'));
    assert.equal(cfg.dataDir, '');
    assert.deepEqual(cfg.recentDirs, []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('配置文件损坏时不崩，退回默认值', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-cfg-'));
  try {
    const file = path.join(tmp, 'config.json');
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
    const cfg = configMod.readConfig(file);
    assert.equal(cfg.dataDir, '');
    assert.deepEqual(cfg.recentDirs, []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('写入后可读回，且是局部合并', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-cfg-'));
  try {
    const file = path.join(tmp, 'config.json');
    configMod.writeConfig(file, { dataDir: 'D:\\a' });
    configMod.writeConfig(file, { recentDirs: ['D:\\a'] });
    const cfg = configMod.readConfig(file);
    assert.equal(cfg.dataDir, 'D:\\a', '后一次写入不应抹掉先前字段');
    assert.deepEqual(cfg.recentDirs, ['D:\\a']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('最近目录去重且最新在前', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-cfg-'));
  try {
    const file = path.join(tmp, 'config.json');
    const A = path.join(tmp, 'A');
    const B = path.join(tmp, 'B');
    configMod.rememberDir(file, A);
    configMod.rememberDir(file, B);
    configMod.rememberDir(file, A);       // 再次使用 A
    assert.deepEqual(configMod.readConfig(file).recentDirs, [A, B]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('最近目录有条数上限', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-cfg-'));
  try {
    const file = path.join(tmp, 'config.json');
    for (let i = 0; i < configMod.MAX_RECENT + 5; i++) {
      configMod.rememberDir(file, path.join(tmp, `dir-${i}`));
    }
    const list = configMod.readConfig(file).recentDirs;
    assert.equal(list.length, configMod.MAX_RECENT);
    assert.equal(list[0], path.join(tmp, `dir-${configMod.MAX_RECENT + 4}`), '最新的应在最前');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('forgetDir 能移除指定目录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-cfg-'));
  try {
    const file = path.join(tmp, 'config.json');
    const A = path.join(tmp, 'A');
    const B = path.join(tmp, 'B');
    configMod.rememberDir(file, A);
    configMod.rememberDir(file, B);
    configMod.forgetDir(file, A);
    assert.deepEqual(configMod.readConfig(file).recentDirs, [B]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('最近目录会被归一化，等价写法不重复', () => {
  // 手工编辑过的配置里可能写成 D:\\a\\b（多余分隔符）。
  // 不归一化的话字符串比较永不相等，当前目录会重复出现在「最近使用」里。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-cfg-'));
  try {
    const file = path.join(tmp, 'config.json');
    const target = path.join(tmp, 'somedir', 'data');
    const messy = `${path.join(tmp, 'somedir')}${path.sep}${path.sep}data`;

    configMod.rememberDir(file, messy);
    configMod.rememberDir(file, target);
    const list = configMod.readConfig(file).recentDirs;
    assert.equal(list.length, 1, `等价路径应合并，实际 ${JSON.stringify(list)}`);
    assert.equal(list[0], path.resolve(target));

    // normalizedRecent 对历史脏数据同样有效
    fs.writeFileSync(file, JSON.stringify({ recentDirs: [messy, messy, target] }), 'utf8');
    assert.equal(configMod.normalizedRecent(file).length, 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('probeDir 会创建不存在的目录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-probe-'));
  try {
    const target = path.join(tmp, 'a', 'b', 'c');
    const res = configMod.probeDir(target);
    assert.equal(res.ok, true, res.reason);
    assert.equal(fs.existsSync(target), true, '应把目录建出来');
    assert.equal(res.hasData, false, '新目录应被识别为空的');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('probeDir 识别出已有数据的目录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-probe-'));
  try {
    const target = path.join(tmp, 'data');
    fs.mkdirSync(path.join(target, 'campaigns', 'c1'), { recursive: true });
    fs.writeFileSync(path.join(target, 'index.json'), '{"campaigns":[]}', 'utf8');
    const res = configMod.probeDir(target);
    assert.equal(res.ok, true);
    assert.equal(res.hasData, true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('probeDir 对非法路径给出可读的失败原因', () => {
  // Windows 上把文件当目录用必然失败
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-probe-'));
  try {
    const file = path.join(tmp, 'a-file');
    fs.writeFileSync(file, 'x', 'utf8');
    const res = configMod.probeDir(path.join(file, 'sub'));
    assert.equal(res.ok, false);
    assert.ok(res.reason && res.reason.length > 0, '失败时必须给出原因');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('copyTree 递归复制且不覆盖已存在的文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-copy-'));
  try {
    const from = path.join(tmp, 'from');
    const to = path.join(tmp, 'to');
    fs.mkdirSync(path.join(from, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(from, 'a.txt'), 'A', 'utf8');
    fs.writeFileSync(path.join(from, 'sub', 'b.txt'), 'B', 'utf8');

    // 目标里已有一个同名文件，复制不应把它冲掉
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'a.txt'), '原有内容', 'utf8');

    const n = configMod.copyTree(from, to);
    assert.equal(n, 1, '只应复制 sub/b.txt 这一个新文件');
    assert.equal(fs.readFileSync(path.join(to, 'a.txt'), 'utf8'), '原有内容', '已存在的文件不应被覆盖');
    assert.equal(fs.readFileSync(path.join(to, 'sub', 'b.txt'), 'utf8'), 'B', '新文件应被复制');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

/* ══════════════════════════ 汇总 ══════════════════════════ */

process.stdout.write(`\n${'─'.repeat(52)}\n`);
if (failed === 0) {
  process.stdout.write(`\x1b[32m全部通过：${passed} 项\x1b[0m\n`);
} else {
  process.stdout.write(`\x1b[31m失败 ${failed} 项\x1b[0m，通过 ${passed} 项\n\n`);
  for (const f of failures) {
    process.stdout.write(`\x1b[31m✗ ${f.name}\x1b[0m\n${f.err.stack}\n\n`);
  }
  process.exitCode = 1;
}
