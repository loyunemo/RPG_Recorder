/**
 * 应用主控：状态、布局、事件分发。
 *
 * 视图层（views/*.js）只负责画界面并调用 app 暴露的动作；
 * 所有写盘都经过这里，保证「每一次判定、每一次改卡都进日志」这条铁律不被绕过。
 */

import { call, platform, subscribe, connectStream, tableAction, joinTable, getPlayerId } from './platform.js';
import { h, render, toast, confirmDialog, debounce, clear } from './util.js';
import { RULESET_LIST, getRuleset } from '../core/rulesets/index.js';
import { rollExpr, DiceError } from '../core/dice.js';
import { RNG, newSeed } from '../core/rng.js';

import { renderDiceView } from './views/dice.js';
import { renderSheetView } from './views/sheet.js';
import { renderNotesView } from './views/notes.js';
import { renderLogView } from './views/log.js';
import { renderCombatView } from './views/combat.js';
import { renderJoinView } from './views/join.js';
import { openNewCampaignDialog, openNewCharacterDialog } from './views/dialogs.js';
import { openHelpDialog } from './views/help.js';

/* ────────────────────────────── 状态 ────────────────────────────── */

/** 战斗追踪器的空状态 */
export const emptyCombat = () => ({
  active: false,
  round: 1,
  turnIndex: 0,
  combatants: [],
});

export const state = {
  campaigns: [],
  campaign: null,
  characters: [],
  sessions: [],
  activeSessionId: null,
  selectedCharacterId: null,
  events: [],
  tab: 'dice',
  lastRoll: null,
  lastRollEventId: null,
  combat: emptyCombat(),
  logFilter: { types: [], search: '' },
  stats: null,
  booted: false,

  /* ── 多人牌桌 ── */
  /** 是否停在「加入牌桌」界面 */
  needsJoin: false,
  /** 自己的牌桌身份：{ name, role, characterIds } */
  participant: null,
  /** 在线玩家列表 */
  presence: [],
  /** 座位表：playerId -> { name, characterIds } */
  seats: {},
  /** 实时连接状态 */
  connection: 'offline',
  /** 牌桌连接信息（开桌后由服务端返回） */
  table: { open: false, joinUrl: null, port: null },
};

export const ruleset = () => getRuleset(state.campaign?.system || 'coc7');
export const selectedCharacter = () =>
  state.characters.find(c => c.id === state.selectedCharacterId) || null;

/** 主持人视角？决定界面上哪些操作可见 */
export const isGm = () => platform.isGm;

/** 这个角色卡是否归我管（主持人管全部） */
export function canEditCharacter(id) {
  if (platform.isGm) return true;
  return (state.participant?.characterIds || []).includes(id);
}

/** 掷骰统一从这里取随机源：每次独立种子，日志可复现 */
export const freshRng = () => new RNG(newSeed());

/* ────────────────────────────── 启动 ────────────────────────────── */

async function boot() {
  // 浏览器模式下先问服务端：牌桌开了没、我有没有有效令牌
  if (platform.mode === 'browser') {
    const status = await tableAction('status').catch(() => ({ open: false }));
    platform.tableOpen = !!status.open;
    state.table = { ...state.table, open: !!status.open, joinUrl: status.joinUrl };
    state.presence = status.presence || [];

    if (status.open) {
      // 有令牌就试着用一下，失效则回到加入界面
      let valid = false;
      try {
        await call('stats', { cid: status.campaignId });
        valid = true;
      } catch { valid = false; }

      if (!valid) {
        state.needsJoin = true;
        state.booted = true;
        renderAll();
        return;
      }
      platform.role = 'player';
      if (getPlayerId() && status.presence) {
        const me = status.presence.find(p => p.playerId === getPlayerId());
        if (me) state.participant = { name: me.name, role: 'player', characterIds: me.characterIds };
      }
      state.campaigns = await call('listCampaigns', {});
      await openCampaign(status.campaignId || state.campaigns[0]?.id);
      state.booted = true;
      attachSync();
      connectStream();
      renderAll();
      return;
    }
    // 牌桌没开 + 能访问 = 本机主持人，走单机流程
  }

  state.campaigns = await call('listCampaigns', {});
  const last = localStorage.getItem('rw:lastCampaign');
  if (last && state.campaigns.some(c => c.id === last)) {
    await openCampaign(last);
  } else if (state.campaigns.length) {
    await openCampaign(state.campaigns[0].id);
  }
  state.booted = true;
  if (platform.mode === 'electron') attachSync();
  renderAll();
}

/* ────────────────────────── 实时同步 ────────────────────────── */

let syncAttached = false;

function attachSync() {
  if (syncAttached) return;
  syncAttached = true;
  subscribe(handleSync);
}

/**
 * 处理服务端推送。
 *
 * 策略：事件直接并入列表（追加式，服务端已盖章）；其余变更走「失效重取」，
 * 因为数据量很小，重取比在各处维护合并逻辑更不容易出错。
 */
async function handleSync(msg) {
  const { type, payload } = msg;

  switch (type) {
    case 'connection':
      state.connection = payload.state;
      renderTopbar();
      break;

    case 'presence':
      state.presence = payload || [];
      renderSidebar();
      renderTopbar();
      break;

    case 'events': {
      const incoming = payload?.events || [];
      const seen = new Set(state.events.map(e => e.id));
      const fresh = incoming.filter(e => !seen.has(e.id));
      if (fresh.length) {
        state.events = state.events.concat(fresh);
        renderLogPanel();
      }
      // 本机掷骰后 lastRoll 已由本地逻辑处理，这里只提示别人的
      if (payload?.by && payload.by !== state.participant?.name && !platform.isGm) {
        const roll = fresh.find(e => e.type === 'roll');
        if (roll) toast(`${payload.by}：${roll.title}`);
      }
      break;
    }

    case 'character': {
      const c = payload?.character;
      if (!c) break;
      const idx = state.characters.findIndex(x => x.id === c.id);
      if (idx >= 0) state.characters[idx] = c;
      else state.characters.push(c);
      renderSidebar();
      if (state.tab === 'sheet' && state.selectedCharacterId === c.id) renderMain();
      break;
    }

    case 'combat':
      if (payload?.combat) {
        state.combat = { ...emptyCombat(), ...payload.combat };
        if (state.tab === 'combat') renderMain();
      }
      break;

    case 'changed':
      await refreshFromServer(payload?.what);
      break;

    case 'closed':
      toast('主持人关闭了牌桌');
      state.connection = 'offline';
      break;

    case 'hello':
      applySnapshot(payload);
      break;

    default:
      break;
  }
}

/** 全量快照（刚连上时服务端会推一次） */
function applySnapshot(snap) {
  if (!snap) return;
  state.participant = { ...snap.participant, role: snap.role };
  state.seats = snap.seats || {};
  state.presence = snap.presence || [];
  if (snap.combat) state.combat = { ...emptyCombat(), ...snap.combat };
  if (snap.characters) state.characters = snap.characters;
  if (snap.sessions?.sessions) {
    state.sessions = snap.sessions.sessions;
    state.activeSessionId = snap.sessions.activeSessionId;
  }
  if (snap.events) state.events = snap.events;
  state.connection = 'online';
  renderAll();
}

async function refreshFromServer(what) {
  if (!state.campaign) return;
  try {
    if (what === 'sessions' || what === 'state') {
      const data = await call('listSessions', { cid: state.campaign.id });
      state.sessions = data.sessions || [];
      state.activeSessionId = data.activeSessionId;
      renderTopbar();
    }
    if (what === 'characters') {
      state.characters = await call('listCharacters', { cid: state.campaign.id });
      renderSidebar();
      if (state.tab === 'sheet') renderMain();
    }
    if (what === 'campaign') {
      state.campaign = await call('getCampaign', { cid: state.campaign.id });
      renderAll();
    }
  } catch (err) {
    console.warn('[sync] 刷新失败：', err.message);
  }
}

export async function openCampaign(cid) {
  state.campaign = await call('getCampaign', { cid });
  if (!state.campaign) return;
  localStorage.setItem('rw:lastCampaign', cid);

  const [characters, sessionData, events, stats, saved] = await Promise.all([
    call('listCharacters', { cid }),
    call('listSessions', { cid }),
    call('readEvents', { cid, opts: { limit: 400 } }),
    call('stats', { cid }),
    call('getState', { cid }),
  ]);

  state.characters = characters;
  state.sessions = sessionData.sessions || [];
  state.activeSessionId = sessionData.activeSessionId || state.sessions.at(-1)?.id || null;
  state.events = events;
  state.stats = stats;
  state.combat = { ...emptyCombat(), ...(saved?.combat || {}) };
  state.selectedCharacterId =
    saved?.selectedCharacterId && characters.some(c => c.id === saved.selectedCharacterId)
      ? saved.selectedCharacterId
      : characters[0]?.id || null;
  state.lastRoll = null;
  state.lastRollEventId = null;
  state.tab = 'dice';
  renderAll();
}

export async function refreshCampaignList() {
  state.campaigns = await call('listCampaigns', {});
  state.stats = state.campaign ? await call('stats', { cid: state.campaign.id }) : null;
}

async function reloadCharacters() {
  if (!state.campaign) return;
  state.characters = await call('listCharacters', { cid: state.campaign.id });
}

async function reloadEvents() {
  if (!state.campaign) return;
  state.events = await call('readEvents', {
    cid: state.campaign.id,
    opts: { limit: 500, types: state.logFilter.types, search: state.logFilter.search },
  });
  renderLogPanel();
}

/* ────────────────────────────── 动作 ────────────────────────────── */

/** 执行一次规则判定 */
export async function performCheck(req, opts = {}) {
  const char = selectedCharacter();
  if (!char) {
    toast('请先选择一个角色', true);
    return;
  }
  const rs = ruleset();
  const rng = freshRng();
  let result;
  try {
    result = rs.roll(char.data, req, rng);
  } catch (err) {
    toast(`判定失败：${err.message}`, true);
    return;
  }

  state.lastRoll = { result, characterName: char.name, characterId: char.id, system: rs.id };
  state.tab = 'dice';
  renderMain();

  const stamped = await call('appendEvents', {
    cid: state.campaign.id,
    sid: state.activeSessionId,
    events: [{
      type: 'roll',
      actor: char.id,
      actorName: char.name,
      title: result.title,
      detail: result.detail,
      seed: result.seed,
      data: { ...result, parentEventId: opts.parentEventId ?? null },
    }],
  });
  state.lastRollEventId = stamped[0]?.id ?? null;
  await reloadEvents();
  await refreshCampaignList();
  return result;
}

/**
 * 孤注一掷：用上次判定的相同条件重掷，并把结果挂在原事件下（parentEventId）。
 * 规则上守秘人需要先说明失败的后果，界面上由 GM 在缘由里写清。
 */
export async function pushLastRoll(consequence = '') {
  const lr = state.lastRoll;
  if (!lr?.result?.request) {
    toast('没有可孤注一掷的判定', true);
    return;
  }
  const req = { ...lr.result.request, pushed: true, reason: consequence || lr.result.request.reason };
  const parent = state.lastRollEventId;
  const result = await performCheck(req, { parentEventId: parent });
  if (result) {
    toast(result.success ? '孤注一掷成功' : '孤注一掷失败——后果生效', !result.success);
  }
}

/** COC 对抗检定：双方各掷一次 d100 */
export async function performOpposedCheck(req) {
  const char = selectedCharacter();
  if (!char) {
    toast('请先选择一个角色', true);
    return;
  }
  const rs = ruleset();
  if (!rs.rollOpposed) {
    toast('当前规则系统不支持对抗检定', true);
    return;
  }
  const rng = freshRng();
  let result;
  try {
    result = rs.rollOpposed(char.data, req, rng);
  } catch (err) {
    toast(`对抗检定失败：${err.message}`, true);
    return;
  }

  state.lastRoll = { result, characterName: char.name, characterId: char.id, system: rs.id };
  state.tab = 'dice';
  renderMain();

  const stamped = await call('appendEvents', {
    cid: state.campaign.id,
    sid: state.activeSessionId,
    events: [{
      type: 'roll',
      actor: char.id,
      actorName: char.name,
      title: result.title,
      detail: result.detail,
      seed: result.seed,
      data: result,
    }],
  });
  state.lastRollEventId = stamped[0]?.id ?? null;
  await reloadEvents();
  return result;
}

/** DND 死亡豁免：掷一次并把成功/失败计数写回角色卡 */
export async function rollDeathSave() {
  const char = selectedCharacter();
  if (!char) { toast('请先选择角色', true); return; }
  const rs = ruleset();
  if (!rs.deathSave) { toast('当前规则系统没有死亡豁免', true); return; }

  const result = rs.deathSave(freshRng(), {
    successes: char.data.combat.deathSuccess || 0,
    failures: char.data.combat.deathFail || 0,
  });

  await saveCharacterNow((data) => {
    data.combat.deathSuccess = result.status === 'revived' || result.status === 'stable' ? 0 : result.successes;
    data.combat.deathFail = result.status === 'revived' ? 0 : result.failures;
    if (result.status === 'revived') data.combat.hp = 1;
  }, { emit: false });

  state.lastRoll = { result, characterName: char.name, characterId: char.id, system: 'dnd5e' };
  state.tab = 'dice';
  renderMain();

  const stamped = await call('appendEvents', {
    cid: state.campaign.id,
    sid: state.activeSessionId,
    events: [{
      type: 'roll', actor: char.id, actorName: char.name,
      title: `死亡豁免（${result.statusLabel}）`,
      detail: result.detail, seed: result.seed, data: result,
    }],
  });
  state.lastRollEventId = stamped[0]?.id ?? null;
  await reloadEvents();
  return result;
}

/** 掷任意骰式（自由骰） */
export async function rollRaw(expr, label = '') {
  let result;
  try {
    result = rollExpr(expr, { seed: newSeed() });
  } catch (err) {
    toast(err instanceof DiceError ? err.message : `骰式有误：${err.message}`, true);
    return null;
  }

  const char = selectedCharacter();
  state.lastRoll = {
    result: {
      ok: true,
      kind: 'expr',
      system: 'generic',
      title: label || `自由骰 ${result.expr}`,
      formula: result.expr,
      total: result.total,
      detail: result.detail,
      success: null,
      outcomeLabel: '',
      seed: result.seed,
    },
    characterName: char?.name || '',
    characterId: char?.id || null,
    system: 'generic',
  };
  state.tab = 'dice';
  renderMain();

  await call('appendEvents', {
    cid: state.campaign.id,
    sid: state.activeSessionId,
    events: [{
      type: 'roll',
      actor: char?.id ?? null,
      actorName: char?.name ?? null,
      title: label || `自由骰 ${result.expr}`,
      detail: result.detail,
      seed: result.seed,
      data: result,
    }],
  });
  await reloadEvents();
  return result;
}

/** 写一条笔记 / 场景事件 */
export async function addEvent(event) {
  if (!state.campaign) return;
  const stamped = await call('appendEvents', {
    cid: state.campaign.id,
    sid: state.activeSessionId,
    events: [event],
  });
  state.events = state.events.concat(stamped);
  renderLogPanel();
  await refreshCampaignList();
}

/**
 * 修改当前角色。
 *
 * 注意：mutate 必须**立即**执行（否则连续编辑会被防抖吃掉），
 * 只有落盘动作做防抖。多次改动合并成一次写盘，日志里的 diff 会覆盖全部改动。
 *
 * @param {(data:object)=>void} mutate 直接改数据的函数
 */
export function saveCharacter(mutate, opts = {}) {
  const char = selectedCharacter();
  if (!char) return;
  mutate(char.data);
  refreshDerived();
  scheduleSave(char, opts);
}

const scheduleSave = debounce(async (char, opts) => {
  if (!state.campaign) return;
  const saved = await call('saveCharacter', {
    cid: state.campaign.id,
    character: { ...char, data: char.data },
    opts: { sessionId: state.activeSessionId, emit: opts.emit !== false },
  });
  const idx = state.characters.findIndex(c => c.id === saved.id);
  if (idx >= 0) state.characters[idx] = saved;
  await reloadEvents();
}, 400);

/** 把某个角色对象落盘（不依赖当前选中项） */
export async function persistCharacter(char, opts = {}) {
  if (!state.campaign || !char) return null;
  const saved = await call('saveCharacter', {
    cid: state.campaign.id,
    character: { ...char, data: char.data },
    opts: { sessionId: state.activeSessionId, emit: opts.emit !== false },
  });
  const idx = state.characters.findIndex(c => c.id === saved.id);
  if (idx >= 0) state.characters[idx] = saved;
  return saved;
}

/** 立即落盘（不防抖），用于点击类的离散操作 */
export async function saveCharacterNow(mutate, opts = {}) {
  const char = selectedCharacter();
  if (!char) return;
  mutate(char.data);
  await persistCharacter(char, opts);
  renderSidebar();
  if (!opts.skipDerived) refreshDerived();
  if (!opts.skipSheetRefresh) renderMain();
  await reloadEvents();
}

/* ────────────────────────────── 渲染 ────────────────────────────── */

export function renderAll() {
  // 需要加入牌桌时，先给玩家一个加入界面
  if (state.needsJoin) {
    document.getElementById('sidebar').style.display = 'none';
    document.getElementById('logpanel').style.display = 'none';
    renderTopbar();
    renderMain();
    return;
  }

  // 没有战役时收起左右面板，让欢迎页占满窗口
  const hasCampaign = !!state.campaign;
  document.getElementById('sidebar').style.display = hasCampaign ? '' : 'none';
  document.getElementById('logpanel').style.display = hasCampaign ? '' : 'none';

  renderTopbar();
  renderSidebar();
  renderMain();
  renderLogPanel();
}

function renderTopbar() {
  const bar = document.getElementById('topbar');

  if (!state.campaigns.length && !state.needsJoin) {
    render(bar,
      h('div.brand', {}, h('span.die', {}, '🎲'), '跑团记录系统'),
      h('div.spacer'),
      tableControl(),
    );
    return;
  }

  const campaignSelect = h('select.select', {
    title: state.campaign?.name,
    onchange: (e) => openCampaign(e.target.value),
  }, state.campaigns.map(c =>
    h('option', { value: c.id, selected: c.id === state.campaign?.id }, c.name)));

  const sessionSelect = h('select.select', {
    title: '当前场次',
    disabled: !state.sessions.length,
    onchange: async (e) => {
      state.activeSessionId = e.target.value || null;
      await call('setActiveSession', { cid: state.campaign.id, sid: state.activeSessionId });
      await reloadEvents();
      renderTopbar();
      toast(`已切换到「${state.sessions.find(s => s.id === state.activeSessionId)?.name || '无场次'}」`);
    },
  }, [
    h('option', { value: '', selected: !state.activeSessionId }, '（无场次）'),
    ...state.sessions.map(s => h('option', { value: s.id, selected: s.id === state.activeSessionId }, s.name)),
  ]);

  const rs = ruleset();

  render(bar,
    h('div.brand', {}, h('span.die', {}, '🎲'), '跑团记录系统'),
    h('div', { style: { width: '1px', height: '22px', background: 'var(--border)' } }),
    campaignSelect,
    platform.isGm ? h('button.btn.sm', { onclick: newCampaignFlow, title: '新建战役' }, '＋ 战役') : null,
    sessionSelect,
    platform.isGm
      ? h('button.btn.sm', {
        title: '开始新场次',
        onclick: async () => {
          const s = await call('createSession', { cid: state.campaign.id, payload: {} });
          const data = await call('listSessions', { cid: state.campaign.id });
          state.sessions = data.sessions;
          state.activeSessionId = s.id;
          await reloadEvents();
          renderTopbar();
          toast(`开始「${s.name}」`);
        },
      }, '＋ 场次')
      : null,
    h('span.badge.' + rs.id, {}, rs.short),

    h('div.spacer'),

    tableControl(),
    h('button.btn.sm.ghost', { onclick: () => openHelpDialog() }, '骰式帮助'),
    platform.isGm
      ? h('button.btn.sm.ghost', {
        title: platform.info.dataDir,
        onclick: async () => { await call('openDataDir', {}); },
      }, '📁 数据目录')
      : null,
    h('button.btn.sm', { onclick: exportFlow }, '导出复盘'),
    h('span.tiny.muted', { title: `运行模式：${platform.mode}` },
      platform.isGm ? '主持人' : (state.participant?.name || '玩家')),
  );
}

/* ────────────────────────── 牌桌控制条 ────────────────────────── */

function tableControl() {
  const t = state.table || {};

  // 玩家：只显示自己的身份与连接状态
  if (!platform.isGm) {
    return h('div.row', { style: { gap: '6px', flex: '0 0 auto' } },
      h('span.chip', { style: { cursor: 'default' } },
        `👤 ${state.participant?.name || '玩家'}`),
      h('span.chip', {
        style: { cursor: 'default' },
        title: { online: '已连接', reconnecting: '连接中断，正在重连', offline: '未连接' }[state.connection],
      },
        { online: '● 在线', reconnecting: '◌ 重连中', offline: '○ 离线' }[state.connection] || '○ 离线'),
    );
  }

  // 主持人：开桌 / 关桌
  if (t.open) {
    const online = (state.presence || []).filter(p => p.online).length;
    return h('div.row', { style: { gap: '6px', flex: '0 0 auto' } },
      h('button.btn.sm.primary', {
        title: '点击复制玩家连接地址',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(t.joinUrl);
            toast('连接地址已复制，发给玩家即可');
          } catch {
            toast(t.joinUrl);
          }
        },
      }, `🌐 牌桌已开 · ${online} 人在线`),
      h('button.btn.sm', { onclick: closeTableFlow, title: '关闭牌桌' }, '关桌'),
    );
  }

  return h('button.btn.sm', {
    title: '开启牌桌，让玩家用浏览器加入',
    onclick: openTableFlow,
  }, '🌐 开启牌桌');
}

async function openTableFlow() {
  if (!state.campaign) { toast('请先创建或打开一个战役', true); return; }
  try {
    const res = await tableAction('open', {
      campaignId: state.campaign.id,
      gmName: '主持人',
    });
    state.table = {
      open: true,
      joinUrl: res.joinUrl,
      port: res.port,
      lanAddress: res.lanAddress,
    };
    state.connection = 'online';
    connectStream();
    const online = h('div', { style: { fontFamily: 'var(--mono)', fontSize: '15px', margin: '10px 0' } },
      res.joinUrl || '');
    showInfoModal('牌桌已开启', [
      '把下面这个地址发给玩家，他们用手机或电脑的浏览器打开即可加入：',
      online,
      '玩家加入后需要选择自己的角色卡。你和他们的掷骰、战斗、笔记会实时同步。',
      `仅限同一局域网。数据仍然保存在你自己的磁盘上（${platform.info.dataDir}）。`,
    ]);
    renderAll();
  } catch (err) {
    toast(`开启牌桌失败：${err.message}`, true);
  }
}

async function closeTableFlow() {
  const ok = await confirmDialog('关闭牌桌', '玩家会断开连接。确认关闭吗？', '关闭');
  if (!ok) return;
  await tableAction('close', {});
  state.table = { open: false, joinUrl: null };
  state.presence = [];
  state.connection = 'offline';
  renderAll();
  toast('牌桌已关闭');
}

/** 简单的信息弹窗 */
function showInfoModal(title, paragraphs) {
  const root = document.getElementById('modal-root');
  const close = () => render(root);
  const mask = h('div.modal-mask', { onclick: (e) => { if (e.target === mask) close(); } },
    h('div.modal', {},
      h('h2', {}, title),
      ...paragraphs.map(p => (typeof p === 'string'
        ? h('p', { style: { margin: '8px 0', lineHeight: 1.7 } }, p)
        : p)),
      h('div.modal-foot', {}, h('button.btn.primary', { onclick: close }, '知道了')),
    ));
  render(root, mask);
}

function renderSidebar() {
  const side = document.getElementById('sidebar');
  if (!state.campaign) { render(side); return; }

  const header = h('div.panel-head', {},
    h('span', {}, '角色卡'),
    h('div.spacer'),
    h('button.btn.sm', { onclick: newCharacterFlow }, '＋'),
  );

  const body = h('div.panel-body');

  if (!state.characters.length) {
    body.appendChild(h('div.empty', {},
      h('div.big', {}, '👥'),
      '还没有角色卡',
      h('br'),
      h('button.btn.primary.sm', { style: { marginTop: '10px' }, onclick: newCharacterFlow }, '创建第一张角色卡'),
    ));
  } else {
    const list = h('div.pc-list');
    for (const c of state.characters) {
      list.appendChild(pcCard(c));
    }
    body.appendChild(list);
  }

  // 底部：在线玩家 + 战役统计
  const rs = ruleset();
  const statLine = state.stats
    ? `事件 ${state.stats.events} · 角色 ${state.stats.characters} · 场次 ${state.stats.sessions}`
    : '';

  const foot = h('div', {
    style: {
      padding: '9px 12px', borderTop: '1px solid var(--border-soft)',
      fontSize: '11px', color: 'var(--muted)',
    },
  },
    state.table?.open ? presenceBlock() : null,
    h('div', {}, h('span.badge.' + rs.id, {}, rs.short), ' ', state.campaign.name),
    h('div.mono', { style: { marginTop: '3px' } }, statLine),
  );

  render(side, header, body, foot);
}

/** 谁在线、各自身上有哪些角色卡 */
function presenceBlock() {
  const online = state.presence.filter(p => p.online);
  const offline = state.presence.filter(p => !p.online);
  const nameOf = (id) => state.characters.find(c => c.id === id)?.name || '？';

  return h('div', { style: { marginBottom: '9px', paddingBottom: '9px', borderBottom: '1px solid var(--border-soft)' } },
    h('div', { style: { letterSpacing: '.06em', marginBottom: '5px' } },
      `在线 ${online.length} 人`),
    ...online.map(p => h('div.row', { style: { gap: '5px', alignItems: 'baseline' } },
      h('span', { style: { color: 'var(--ok)' } }, '●'),
      h('span', { style: { color: 'var(--text-dim)' } }, p.name),
      h('span.mono', { style: { fontSize: '10px', marginLeft: 'auto' } },
        (p.characterIds || []).map(nameOf).join('、') || '未选角色'),
    )),
    ...offline.map(p => h('div.row', { style: { gap: '5px', alignItems: 'baseline', opacity: .5 } },
      h('span', {}, '○'),
      h('span', {}, p.name),
      h('span.mono', { style: { fontSize: '10px', marginLeft: 'auto' } }, '离线'),
    )),
  );
}

function pcCard(c) {
  const rs = getRuleset(c.system || state.campaign.system);
  const d = rs.derive(c.data);
  const isActive = c.id === state.selectedCharacterId;

  const bars = h('div.bars');
  for (const t of d.tracks.slice(0, 3)) {
    const pct = t.max > 0 ? Math.max(0, Math.min(100, (t.current / t.max) * 100)) : 0;
    bars.appendChild(h('div.minibar', {},
      h('div.fill.tone-' + t.tone, { style: { width: pct + '%' } }),
      h('div.txt', {}, `${t.label.slice(0, 2)} ${t.current}/${t.max}`),
    ));
  }

  return h('div.pc-card' + (isActive ? '.active' : ''), {
    onclick: () => {
      state.selectedCharacterId = c.id;
      state.tab = 'sheet';
      rememberSelection();
      renderSidebar();
      renderMain();
    },
  },
    h('div.name', {}, c.name || '（无名）'),
    h('div.sub', {}, describeCharacter(c)),
    bars,
  );
}

function describeCharacter(c) {
  const rs = getRuleset(c.system || state.campaign.system);
  const d = c.data;
  if (rs.id === 'coc7') {
    return `${d.occupation || '调查员'} · ${d.age || '?'} 岁`;
  }
  if (rs.id === 'dnd5e') {
    const parts = [d.race, d.className, d.level ? `Lv${d.level}` : ''].filter(Boolean);
    return parts.join(' · ') || '冒险者';
  }
  return [d.ancestry, d.community, d.className, d.level ? `Lv${d.level}` : ''].filter(Boolean).join(' · ') || '英雄';
}

function renderMain() {
  const main = document.getElementById('main');

  if (state.needsJoin) {
    const view = h('div.tabview');
    render(main, view);
    renderJoinView(view, app);
    return;
  }

  if (!state.campaign) {
    render(main, welcomeScreen());
    return;
  }

  const TABS = [
    ['dice', '判定'],
    ['combat', '战斗'],
    ['sheet', '角色卡'],
    ['notes', '战役笔记'],
  ];

  const tabs = h('div.tabs', {}, TABS.map(([id, label]) =>
    h('button.tab' + (state.tab === id ? '.active' : ''), {
      onclick: () => { state.tab = id; renderMain(); },
    }, label,
      id === 'combat' && state.combat?.active
        ? h('span.badge', { style: { marginLeft: '6px' } }, `R${state.combat.round}`)
        : null,
    )));

  const view = h('div.tabview');
  render(main, tabs, view);

  if (state.tab === 'dice') renderDiceView(view, app);
  else if (state.tab === 'combat') renderCombatView(view, app);
  else if (state.tab === 'sheet') renderSheetView(view, app);
  else renderNotesView(view, app);
}

/* ────────────────────────── 战斗状态持久化 ────────────────────────── */

/** 把战斗状态写回战役的 state.json（防抖，回合内多次点击合并成一次写盘） */
export const saveCombat = debounce(async () => {
  if (!state.campaign) return;
  await call('saveState', {
    cid: state.campaign.id,
    patch: { combat: state.combat },
  });
}, 250);

/** 记住当前选中的角色，下次打开战役时恢复 */
export const rememberSelection = debounce(async () => {
  if (!state.campaign) return;
  await call('saveState', {
    cid: state.campaign.id,
    patch: { selectedCharacterId: state.selectedCharacterId },
  });
}, 400);

/** 改动战斗状态：立即改内存并刷新界面，落盘防抖 */
export function updateCombat(mutator, opts = {}) {
  mutator(state.combat);
  if (opts.render !== false) renderMain();
  saveCombat();
}

function renderLogPanel() {
  const panel = document.getElementById('logpanel');
  if (!state.campaign) { render(panel); return; }
  renderLogView(panel, app);
}

/** 只刷新角色卡上的派生数值，避免整页重绘打断输入 */
export function refreshDerived() {
  const char = selectedCharacter();
  if (!char) return;
  const d = ruleset().derive(char.data);
  for (const node of document.querySelectorAll('[data-derived]')) {
    const key = node.dataset.derived;
    const stat = d.stats.find(s => s.key === key);
    if (stat) node.textContent = String(stat.value);
  }
  for (const node of document.querySelectorAll('[data-track]')) {
    const key = node.dataset.track;
    const t = d.tracks.find(x => x.key === key);
    if (!t) continue;
    const fill = node.querySelector('.fill');
    const txt = node.querySelector('.txt');
    const pct = t.max > 0 ? Math.max(0, Math.min(100, (t.current / t.max) * 100)) : 0;
    if (fill) fill.style.width = pct + '%';
    if (txt) txt.textContent = `${t.current} / ${t.max}`;
  }
  const evNode = document.querySelector('[data-derived="evasion"]');
  if (evNode) evNode.textContent = String(d.evasion ?? d.stats.find(s => s.key === 'evasion')?.value ?? '');
  renderSidebar();
}

/* ────────────────────── 流程：新建 / 导出 ────────────────────── */

async function newCampaignFlow() {
  const created = await openNewCampaignDialog();
  if (!created) return;
  await refreshCampaignList();
  await openCampaign(created.id);
  toast(`战役「${created.name}」已创建`);
}

async function newCharacterFlow() {
  if (!state.campaign) { toast('请先创建战役', true); return; }
  const data = await openNewCharacterDialog(ruleset());
  if (!data) return;
  const saved = await call('saveCharacter', {
    cid: state.campaign.id,
    character: { name: data.name, system: ruleset().id, data: data.payload },
    opts: { sessionId: state.activeSessionId },
  });
  await reloadCharacters();
  state.selectedCharacterId = saved.id;
  state.tab = 'sheet';
  await reloadEvents();
  renderAll();
  toast(`已创建「${saved.name}」`);
}

async function exportFlow() {
  if (!state.campaign) return;
  const opts = {};
  if (state.activeSessionId) {
    opts.sessionId = state.activeSessionId;
    opts.filenameHint = state.sessions.find(s => s.id === state.activeSessionId)?.name || 'session';
  }
  try {
    const res = await call('exportMarkdown', { cid: state.campaign.id, opts });
    const filename = `${(opts.filenameHint || 'campaign')}-${Date.now()}.md`;
    const saved = await call('saveExport', { filename, content: res });
    if (saved?.ok) toast(`已导出到 ${saved.filePath}`);
    else if (saved && saved.ok === false) toast('已取消导出');
    else toast('已导出');
  } catch (err) {
    toast(`导出失败：${err.message}`, true);
  }
}

function welcomeScreen() {
  return h('div', { style: { padding: '60px 40px', maxWidth: '720px', margin: '0 auto', textAlign: 'center' } },
    h('div', { style: { fontSize: '46px', marginBottom: '14px' } }, '🎲'),
    h('h1', { style: { margin: '0 0 8px', fontSize: '25px' } }, '跑团记录系统'),
    h('p.muted', { style: { marginBottom: '26px' } },
      '内置骰子判定、完整事件日志与角色卡面板。支持克苏鲁的呼唤 7 版、龙与地下城 5 版、匕首心。'),
    h('button.btn.primary', { style: { padding: '10px 26px', fontSize: '15px' }, onclick: newCampaignFlow },
      '创建第一个战役'),
    h('div', { style: { marginTop: '30px' } },
      h('div.tiny.muted', {}, `数据目录：${platform.info.dataDir}`),
      h('div.tiny.muted', {}, `运行模式：${platform.mode === 'electron' ? '桌面应用' : '浏览器（本地服务）'}`),
    ),
  );
}

/* ────────────────────── 对外暴露给视图的接口 ────────────────────── */

export const app = {
  state,
  ruleset,
  selectedCharacter,
  freshRng,
  performCheck,
  performOpposedCheck,
  pushLastRoll,
  rollDeathSave,
  rollRaw,
  addEvent,
  saveCharacter,
  saveCharacterNow,
  persistCharacter,
  updateCombat,
  saveCombat,
  rememberSelection,
  renderMain,
  renderAll,
  renderSidebar,
  renderTopbar,
  renderLogPanel,
  reloadEvents,
  reloadCharacters,
  openCampaign,
  refreshDerived,
  exportFlow,
  newCharacterFlow,
  newCampaignFlow,
  openHelpDialog,
  RULESET_LIST,
};

/* 启动 */
boot().catch(err => {
  console.error(err);
  document.body.innerHTML =
    `<div style="padding:40px;font-family:system-ui;color:#e6e9ef">
       <h2>启动失败</h2><pre style="color:#e79692">${String(err && err.stack || err)}</pre>
     </div>`;
});
