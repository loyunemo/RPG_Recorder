/**
 * 端到端冒烟测试：对已启动的本地服务发真实 HTTP 请求。
 *
 * 用法：先 `npm run serve -- --no-open`（或设 RW_PORT），再 `node tests/smoke.js [baseUrl]`
 */

const BASE = process.argv[2] || process.env.RW_BASE || 'http://127.0.0.1:41777';

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
}

async function call(op, args = {}) {
  const res = await fetch(`${BASE}/api/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, args }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${op}: ${data.error}`);
  return data.result;
}

console.log(`\n冒烟测试 → ${BASE}\n`);

const info = await (await fetch(`${BASE}/api/info`)).json();
ok('服务可达', info.mode === 'browser', JSON.stringify(info));
console.log(`     数据目录：${info.dataDir}\n`);

/* 1. 建战役 */
const cmp = await call('createCampaign', { name: '冒烟测试战役', system: 'daggerheart', description: '集成测试用' });
ok('创建战役', !!cmp.id && cmp.name === '冒烟测试战役', JSON.stringify(cmp));
ok('战役系统正确', cmp.system === 'daggerheart');

/* 2. 场次 */
const ses = await call('createSession', { cid: cmp.id, payload: { name: '第一次跑团' } });
ok('创建场次', !!ses.id && ses.name === '第一次跑团');
const sesData = await call('listSessions', { cid: cmp.id });
ok('场次索引已更新', sesData.activeSessionId === ses.id && sesData.sessions.length === 1);

/* 3. 角色卡 */
const char = await call('saveCharacter', {
  cid: cmp.id,
  character: {
    name: '莉安', system: 'daggerheart',
    data: {
      name: '莉安', className: '战士', subclass: '勇者之召', level: 1,
      ancestry: '人类', community: '高地人', pronouns: '她',
      traits: { agility: 1, strength: 2, finesse: 0, instinct: 0, presence: -1, knowledge: 1 },
      evasionBase: 11, armorName: '皮甲', armorScore: 3, armorEvasion: 0,
      majorThreshold: 6, severeThreshold: 13,
      hpMax: 6, hpMarked: 0, stressMax: 6, stressMarked: 0,
      armorSlotsMax: 3, armorMarked: 0, hope: 2, fear: 0,
      experiences: [{ name: '老兵', mod: 2 }], weapons: [], domainCards: [],
      inventory: '', notes: '',
    },
  },
  opts: { sessionId: ses.id },
});
ok('创建角色', !!char.id && char.name === '莉安');
ok('角色带战役归属', char.campaignId === cmp.id);

const back = await call('getCharacter', { cid: cmp.id, id: char.id });
ok('角色可读回且数据完整', back?.data?.traits?.strength === 2 && back?.data?.majorThreshold === 6);

/* 4. 改卡产生 diff 日志 */
const beforeCount = (await call('readEvents', { cid: cmp.id, opts: {} })).length;
await call('saveCharacter', {
  cid: cmp.id,
  character: { ...back, data: { ...back.data, hpMarked: 2, hope: 3 } },
  opts: { sessionId: ses.id },
});
const events = await call('readEvents', { cid: cmp.id, opts: {} });
ok('改卡写入日志', events.length > beforeCount, `${beforeCount} → ${events.length}`);
const diffEv = events.find(e => e.type === 'sheet' && e.detail.includes('hpMarked'));
ok('日志记录了具体字段变化', !!diffEv && diffEv.detail.includes('2'), diffEv?.detail || '（未找到）');

/* 5. 掷骰事件 */
const appended = await call('appendEvents', {
  cid: cmp.id, sid: ses.id,
  events: [{
    type: 'roll', actor: char.id, actorName: '莉安',
    title: '敏捷判定（优势）',
    detail: '希望骰 9 + 恐惧骰 3 = 12 · 属性 +1 · 优势 d6 = +5 · 总计 18 · 难度 12 · 结果：成功（带希望）',
    seed: 'ABCD2345EFGH',
    data: { system: 'daggerheart', kind: 'check', hopeDie: 9, fearDie: 3, total: 18, difficulty: 12 },
  }],
});
ok('追加掷骰事件并补全元数据', !!appended[0].id && appended[0].seq > 0 && !!appended[0].ts);
ok('种子被记入事件', appended[0].seed === 'ABCD2345EFGH');

/* 6. 过滤与搜索 */
const rolls = await call('readEvents', { cid: cmp.id, opts: { types: ['roll'] } });
ok('按类型过滤', rolls.length === 1 && rolls[0].type === 'roll');
const searched = await call('readEvents', { cid: cmp.id, opts: { search: '敏捷' } });
ok('按关键词搜索', searched.length === 1);
const bySession = await call('readEvents', { cid: cmp.id, opts: { sessionId: ses.id } });
ok('按场次过滤', bySession.length >= 3);
const limited = await call('readEvents', { cid: cmp.id, opts: { limit: 2 } });
ok('limit 生效', limited.length === 2);

/* 7. 统计 */
const stats = await call('stats', { cid: cmp.id });
ok('统计信息', stats.characters === 1 && stats.sessions === 1 && stats.events >= 5, JSON.stringify(stats));
ok('统计含 root 路径', typeof stats.root === 'string' && stats.root.length > 0);

/* 8. 导出 */
const md = await call('exportMarkdown', { cid: cmp.id, opts: {} });
ok('导出含战役名', md.includes('# 冒烟测试战役'));
ok('导出含角色', md.includes('莉安'));
ok('导出含掷骰记录', md.includes('敏捷判定'));
ok('导出含种子', md.includes('ABCD2345EFGH'));
ok('导出含角色卡变更', md.includes('hpMarked'));

const saved = await call('saveExport', { filename: 'smoke-export.md', content: md });
ok('导出文件落盘', saved.ok === true && saved.filePath.endsWith('.md'), JSON.stringify(saved));

/* 9. 结束场次 */
const ended = await call('endSession', { cid: cmp.id, sid: ses.id });
ok('结束场次', !!ended.endedAt);

/* 9.5 战役状态：战斗序列读写 */
ok('初始状态为空对象', Object.keys(await call('getState', { cid: cmp.id })).length === 0);

const combat = {
  active: true, round: 1, turnIndex: 0,
  combatants: [
    { id: 'cb_1', name: '莉安', kind: 'pc', refId: char.id, initiative: 15, hp: 4, maxHp: 6, defenseLabel: '闪避', defense: 11, conditions: '', defeated: false },
    { id: 'cb_2', name: '哥布林 A', kind: 'npc', refId: null, initiative: 9, hp: 7, maxHp: 7, defenseLabel: 'AC', defense: 15, conditions: '中毒', defeated: false },
  ],
};
await call('saveState', { cid: cmp.id, patch: { combat } });
const st = await call('getState', { cid: cmp.id });
ok('战斗状态落盘并可读回', st.combat.combatants.length === 2 && st.combat.combatants[0].initiative === 15);
ok('状态带更新时间', typeof st.updatedAt === 'string');

await call('saveState', { cid: cmp.id, patch: { selectedCharacterId: char.id } });
const st2 = await call('getState', { cid: cmp.id });
ok('状态浅合并不丢字段', st2.selectedCharacterId === char.id && st2.combat.combatants.length === 2);

/* 9.6 存档导出 */
const archive = await call('exportArchive', { cid: cmp.id });
ok('存档格式正确', archive.format === 'random-walking-archive' && archive.version === 1);
ok('存档含战役', archive.campaign.id === cmp.id);
ok('存档含角色卡', archive.characters.length === 1 && archive.characters[0].name === '莉安');
ok('存档含场次', archive.sessions.sessions.length === 1);
ok('存档含全部事件', archive.events.length >= 6);
ok('存档含战斗状态', archive.state.combat.combatants.length === 2);

/* 10. 多战役隔离 */
const cmp2 = await call('createCampaign', { name: '第二个战役', system: 'dnd5e' });
const list = await call('listCampaigns', {});
ok('战役列表含两个', list.length >= 2);
const ev2 = await call('readEvents', { cid: cmp2.id, opts: {} });
ok('新战役日志相互隔离', ev2.length === 1 && ev2[0].type === 'system');

/* 11. 错误处理 */
let threw = false;
try { await call('nonexistentOp', {}); } catch { threw = true; }
ok('未知操作返回错误', threw);

threw = false;
try { await call('getCampaign', { cid: 'cmp_不存在' }); } catch { threw = true; }
ok('读取不存在的战役不崩溃', !threw, '（返回 null 即可）');

/* 12. 静态资源（浏览器实际会请求的路径） */
const root = await fetch(BASE + '/', { redirect: 'manual' });
ok('根路径重定向到入口页', root.status === 302 && root.headers.get('location') === '/src/renderer/index.html',
  `HTTP ${root.status} → ${root.headers.get('location')}`);

const ASSETS = [
  '/src/renderer/index.html',
  '/src/renderer/styles.css',
  '/src/renderer/app.js',
  '/src/renderer/platform.js',
  '/src/renderer/util.js',
  '/src/renderer/views/dice.js',
  '/src/renderer/views/sheet.js',
  '/src/renderer/views/log.js',
  '/src/renderer/views/notes.js',
  '/src/renderer/views/combat.js',
  '/src/renderer/views/dialogs.js',
  '/src/renderer/views/help.js',
  '/src/renderer/characterOps.js',
  '/src/core/dice.js',
  '/src/core/rng.js',
  '/src/core/rulesets/index.js',
  '/src/core/rulesets/coc7.js',
  '/src/core/rulesets/dnd5e.js',
  '/src/core/rulesets/daggerheart.js',
];
let assetsOk = true;
for (const p of ASSETS) {
  const r = await fetch(BASE + p);
  if (!r.ok) { assetsOk = false; console.log(`     缺失：${p} → HTTP ${r.status}`); }
}
ok(`全部 ${ASSETS.length} 个前端资源可加载`, assetsOk);

const html = await (await fetch(BASE + '/src/renderer/index.html')).text();
ok('入口页引用了 app.js', html.includes('src="app.js"'));

const mod = await (await fetch(BASE + '/src/core/dice.js')).text();
ok('核心模块内容正确', mod.includes('export function rollExpr'));

const css = await (await fetch(BASE + '/src/renderer/styles.css')).text();
ok('样式表内容正确', css.includes('.log-item'));

// 只应暴露 src/，其余一律 404
for (const p of ['/package.json', '/electron/store.cjs', '/server/server.cjs', '/data/index.json', '/node_modules/electron/package.json']) {
  const r = await fetch(BASE + p);
  ok(`非 src 路径被拒绝：${p}`, r.status === 404, `HTTP ${r.status}`);
}
const enc = await fetch(BASE + '/src/renderer/%2e%2e/%2e%2e/package.json');
ok('编码式目录穿越被阻止', enc.status !== 200, `HTTP ${enc.status}`);

/* 13. 清理 */
await call('deleteCampaign', { cid: cmp2.id });
const after = await call('listCampaigns', {});
ok('删除战役', !after.some(c => c.id === cmp2.id));

console.log(`\n${'─'.repeat(52)}`);
if (fail === 0) console.log(`\x1b[32m冒烟测试全部通过：${pass} 项\x1b[0m`);
else { console.log(`\x1b[31m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`); process.exitCode = 1; }
console.log(`\n提示：测试战役「冒烟测试战役」(${cmp.id}) 保留在数据目录中，可手动删除。`);
