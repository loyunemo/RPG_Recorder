/**
 * 多人牌桌端到端测试。
 *
 * 验证的是**权限边界**与**实时推送**这两件最容易写错的事：
 * 玩家不能改别人的卡、不能删战役、不能发隐藏掷骰，而隐藏掷骰不能漏给玩家。
 *
 * 用法：先 `npm run serve -- --no-open`（或设 RW_PORT），再
 *   node tests/multiplayer.js [baseUrl]
 */

const BASE = process.argv[2] || process.env.RW_BASE || 'http://127.0.0.1:41776';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-RW-Token'] = token;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

const call = async (op, args, token) => {
  const r = await api('/api/call', { method: 'POST', body: { op, args }, token });
  if (!r.ok) { const e = new Error(r.data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.data.result;
};

/** 连上 SSE，收集一段时间内的事件 */
async function collectStream(token, ms = 2500) {
  const events = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${BASE}/api/stream?token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let type = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) type = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (data) { try { events.push({ type, payload: JSON.parse(data) }); } catch { /* 忽略心跳 */ } }
      }
    }
  } catch { /* 到时间主动断开 */ }
  clearTimeout(timer);
  return events;
}

console.log(`\n多人牌桌测试 → ${BASE}\n`);

/* ── 准备：牌桌开启前，本机即主持人 ── */

const info = (await api('/api/info')).data;
ok('服务可达', typeof info.mode === 'string', JSON.stringify(info));

const campaign = await call('createCampaign', { name: '多人测试战役', system: 'coc7' });
ok('创建战役', !!campaign.id);

const charA = await call('saveCharacter', {
  cid: campaign.id,
  character: { name: '甲调查员', system: 'coc7', data: { name: '甲调查员', attributes: { str: 50, con: 50, siz: 50, dex: 60, app: 50, int: 60, pow: 50, edu: 60 }, luck: 50, state: {}, skills: { 侦察: 55 }, weapons: [], background: {} } },
});
const charB = await call('saveCharacter', {
  cid: campaign.id,
  character: { name: '乙调查员', system: 'coc7', data: { name: '乙调查员', attributes: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50 }, luck: 50, state: {}, skills: { 潜行: 40 }, weapons: [], background: {} } },
});
ok('创建两张角色卡', !!charA.id && !!charB.id);

/* ── 开桌 ── */

const openRes = await api('/api/table/open', { method: 'POST', body: { campaignId: campaign.id, gmName: '测试主持人' } });
ok('开启牌桌', openRes.ok && !!openRes.data.token, JSON.stringify(openRes.data).slice(0, 120));
const gmToken = openRes.data.token;

const status = await api('/api/table/status');
ok('牌桌状态为开启', status.data.open === true);
ok('返回了玩家连接地址', typeof status.data.joinUrl === 'string' && status.data.joinUrl.includes('http'));

/* ── 未鉴权的远程请求应被拒绝（这里模拟不了远程 IP，改为验证无令牌被拒） ── */

const noToken = await api('/api/call', { method: 'POST', body: { op: 'listCampaigns', args: {} } });
ok('无令牌调用被拒绝', noToken.status === 401, `HTTP ${noToken.status}`);

/* ── 名册：加入前可读，但不含角色卡内容 ── */

const roster = (await api('/api/table/roster')).data;
ok('名册可读', roster.open === true && roster.characters.length === 2);
ok('名册不含角色卡数值', roster.characters.every(c => c.data === undefined));
ok('名册标注了战役信息', roster.campaign?.name === '多人测试战役');

/* ── 玩家加入 ── */

const joinRes = await api('/api/join', { method: 'POST', body: { playerId: 'p_test_1', name: '小明', characterIds: [charA.id] } });
ok('玩家加入成功', joinRes.ok && !!joinRes.data.token, JSON.stringify(joinRes.data).slice(0, 120));
const playerToken = joinRes.data.token;
ok('玩家认领到角色卡', joinRes.data.participant.characterIds.includes(charA.id));
ok('玩家角色为 player', joinRes.data.participant.role === 'player');

/* ── 玩家权限：能读 ── */

let r;
try { r = await call('listCampaigns', {}, playerToken); ok('玩家可读战役列表', Array.isArray(r)); }
catch (e) { ok('玩家可读战役列表', false, e.message); }

try { r = await call('readEvents', { cid: campaign.id, opts: {} }, playerToken); ok('玩家可读事件日志', Array.isArray(r)); }
catch (e) { ok('玩家可读事件日志', false, e.message); }

/* ── 玩家权限：不能做的事 ── */

const denied = [
  ['不能删除战役', 'deleteCampaign', { cid: campaign.id }],
  ['不能新建战役', 'createCampaign', { name: '偷偷建的', system: 'coc7' }],
  ['不能新建场次', 'createSession', { cid: campaign.id, payload: {} }],
  ['不能删除角色卡', 'deleteCharacter', { cid: campaign.id, id: charB.id }],
  ['不能修改别人的角色卡', 'saveCharacter', { cid: campaign.id, character: { ...charB, data: { ...charB.data, luck: 99 } } }],
  ['不能写战斗状态', 'saveState', { cid: campaign.id, patch: { combat: { active: true } } }],
];
for (const [label, op, args] of denied) {
  try {
    await call(op, args, playerToken);
    ok(label, false, '竟然成功了');
  } catch (e) {
    ok(label, e.status === 403, `HTTP ${e.status}：${e.message}`);
  }
}

/* ── 玩家权限：可以做的事 ── */

try {
  await call('saveCharacter', {
    cid: campaign.id,
    character: { ...charA, data: { ...charA.data, luck: 77 } },
  }, playerToken);
  const back = await call('getCharacter', { cid: campaign.id, id: charA.id }, playerToken);
  ok('玩家可改自己的角色卡', back.data.luck === 77, `luck=${back.data.luck}`);
} catch (e) { ok('玩家可改自己的角色卡', false, e.message); }

try {
  await call('appendEvents', {
    cid: campaign.id, sid: null,
    events: [{ type: 'note', title: '玩家记的笔记', actor: charA.id, actorName: '甲调查员' }],
  }, playerToken);
  ok('玩家可记笔记', true);
} catch (e) { ok('玩家可记笔记', false, e.message); }

try {
  await call('appendEvents', {
    cid: campaign.id, sid: null,
    events: [{ type: 'roll', title: '侦察检定', actor: charA.id, actorName: '甲调查员', seed: 'TESTSEED0001', detail: '1d100 = 33' }],
  }, playerToken);
  ok('玩家可掷自己角色的骰', true);
} catch (e) { ok('玩家可掷自己角色的骰', false, e.message); }

/* ── 玩家不能替别人掷骰 / 不能发隐藏掷骰 ── */

try {
  await call('appendEvents', {
    cid: campaign.id, sid: null,
    events: [{ type: 'roll', title: '替别人掷', actor: charB.id, actorName: '乙调查员' }],
  }, playerToken);
  ok('玩家不能替别人掷骰', false, '竟然成功了');
} catch (e) { ok('玩家不能替别人掷骰', e.status === 403, `HTTP ${e.status}`); }

try {
  await call('appendEvents', {
    cid: campaign.id, sid: null,
    events: [{ type: 'roll', title: '隐藏掷骰', visibility: 'gm' }],
  }, playerToken);
  ok('玩家不能发隐藏掷骰', false, '竟然成功了');
} catch (e) { ok('玩家不能发隐藏掷骰', e.status === 403, `HTTP ${e.status}`); }

/* ── 隐藏掷骰：主持人发，玩家看不到 ── */

await call('appendEvents', {
  cid: campaign.id, sid: null,
  events: [{ type: 'roll', title: '暗骰：邪教徒的聆听', visibility: 'gm', seed: 'GMSECRET0001', detail: '1d100 = 12' }],
}, gmToken);

const gmEvents = await call('readEvents', { cid: campaign.id, opts: {} }, gmToken);
const playerEvents = await call('readEvents', { cid: campaign.id, opts: {} }, playerToken);
ok('主持人能看到暗骰', gmEvents.some(e => e.title.includes('暗骰')));
ok('玩家看不到暗骰', !playerEvents.some(e => e.title.includes('暗骰')));
ok('玩家仍能看到公开事件', playerEvents.some(e => e.title === '侦察检定'));

/* ── 实时推送 ── */

const gmStream = collectStream(gmToken, 3000);
const playerStream = collectStream(playerToken, 3000);
await new Promise(r => setTimeout(r, 500));   // 等两条流都连上

await call('appendEvents', {
  cid: campaign.id, sid: null,
  events: [{ type: 'note', title: '广播测试：公开消息' }],
}, gmToken);
await call('appendEvents', {
  cid: campaign.id, sid: null,
  events: [{ type: 'note', title: '广播测试：暗消息', visibility: 'gm' }],
}, gmToken);

const [gmMsgs, playerMsgs] = await Promise.all([gmStream, playerStream]);

const gmGot = gmMsgs.filter(m => m.type === 'events').flatMap(m => m.payload.events || []);
const playerGot = playerMsgs.filter(m => m.type === 'events').flatMap(m => m.payload.events || []);

ok('主持人收到实时推送', gmGot.some(e => e.title === '广播测试：公开消息'));
ok('玩家收到公开推送', playerGot.some(e => e.title === '广播测试：公开消息'));
ok('暗消息推给主持人', gmGot.some(e => e.title === '广播测试：暗消息'));
ok('暗消息不推给玩家', !playerGot.some(e => e.title === '广播测试：暗消息'));
ok('收到 hello 快照', gmMsgs.some(m => m.type === 'hello'));
ok('收到在线名单', gmMsgs.some(m => m.type === 'presence'));

/* ── 认领冲突：两个玩家不能抢同一张卡 ── */

const join2 = await api('/api/join', { method: 'POST', body: { playerId: 'p_test_2', name: '小红', characterIds: [charA.id, charB.id] } });
ok('第二个人加入成功', join2.ok);
ok('已被占用的角色卡被拒绝认领', join2.data.rejected.some(x => x.characterId === charA.id));
ok('未占用的角色卡认领成功', join2.data.participant.characterIds.includes(charB.id));

/* ── 关桌 ── */

const closeRes = await api('/api/table/close', { method: 'POST', body: {}, token: gmToken });
ok('主持人可关闭牌桌', closeRes.ok);
const after = await api('/api/table/status');
ok('关桌后状态为关闭', after.data.open === false);

const afterClose = await api('/api/join', { method: 'POST', body: { playerId: 'p_x', name: '迟到的人' } });
ok('关桌后不能加入', !afterClose.ok, `HTTP ${afterClose.status}`);

/* ── 清理 ── */
await call('deleteCampaign', { cid: campaign.id });

console.log(`\n${'─'.repeat(52)}`);
if (fail === 0) console.log(`\x1b[32m多人测试全部通过：${pass} 项\x1b[0m`);
else {
  console.log(`\x1b[31m失败 ${fail} 项\x1b[0m，通过 ${pass} 项：`);
  failures.forEach(f => console.log(`  · ${f}`));
  process.exitCode = 1;
}
