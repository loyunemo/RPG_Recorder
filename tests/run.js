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
import { getRuleset } from '../src/core/rulesets/index.js';
import coc7 from '../src/core/rulesets/coc7.js';
import dnd5e from '../src/core/rulesets/dnd5e.js';
import daggerheart from '../src/core/rulesets/daggerheart.js';

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
  assert.equal(byName['炽天使'].hp, 7);
  assert.equal(byName['术士'].hp, 6);
  assert.equal(byName['游荡者'].evasion, 12);
  assert.equal(byName['法师'].hp, 5);
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

const HZ = (await import('../src/core/rulesets/huazhu/index.js')).default;

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
