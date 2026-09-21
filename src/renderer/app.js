/**
 * 应用主控：状态、布局、事件分发。
 *
 * 视图层（views/*.js）只负责画界面并调用 app 暴露的动作；
 * 所有写盘都经过这里，保证「每一次判定、每一次改卡都进日志」这条铁律不被绕过。
 */

import { call, platform } from './platform.js';
import { h, render, toast, confirmDialog, debounce, clear } from './util.js';
import { RULESET_LIST, getRuleset } from '../core/rulesets/index.js';
import { rollExpr, DiceError } from '../core/dice.js';
import { RNG, newSeed } from '../core/rng.js';

import { renderDiceView } from './views/dice.js';
import { renderSheetView } from './views/sheet.js';
import { renderNotesView } from './views/notes.js';
import { renderLogView } from './views/log.js';
import { renderCombatView } from './views/combat.js';
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
};

export const ruleset = () => getRuleset(state.campaign?.system || 'coc7');
export const selectedCharacter = () =>
  state.characters.find(c => c.id === state.selectedCharacterId) || null;

/** 掷骰统一从这里取随机源：每次独立种子，日志可复现 */
export const freshRng = () => new RNG(newSeed());

/* ────────────────────────────── 启动 ────────────────────────────── */

async function boot() {
  state.campaigns = await call('listCampaigns', {});
  const last = localStorage.getItem('rw:lastCampaign');
  if (last && state.campaigns.some(c => c.id === last)) {
    await openCampaign(last);
  } else if (state.campaigns.length) {
    await openCampaign(state.campaigns[0].id);
  }
  state.booted = true;
  renderAll();
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

  if (!state.campaigns.length) {
    render(bar,
      h('div.brand', {}, h('span.die', {}, '🎲'), '跑团记录系统'),
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
    h('button.btn.sm', { onclick: newCampaignFlow, title: '新建战役' }, '＋ 战役'),
    sessionSelect,
    h('button.btn.sm', {
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
    }, '＋ 场次'),
    h('span.badge.' + rs.id, {}, rs.short),

    h('div.spacer'),

    h('button.btn.sm.ghost', { onclick: () => openHelpDialog() }, '骰式帮助'),
    h('button.btn.sm.ghost', {
      title: platform.info.dataDir,
      onclick: async () => { await call('openDataDir', {}); },
    }, '📁 数据目录'),
    h('button.btn.sm', { onclick: exportFlow }, '导出复盘'),
    h('span.tiny.muted', { title: `运行模式：${platform.mode}` },
      platform.mode === 'electron' ? '桌面版' : '浏览器版'),
  );
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

  // 底部：战役统计
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
    h('div', {}, h('span.badge.' + rs.id, {}, rs.short), ' ', state.campaign.name),
    h('div.mono', { style: { marginTop: '3px' } }, statLine),
  );

  render(side, header, body, foot);
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
