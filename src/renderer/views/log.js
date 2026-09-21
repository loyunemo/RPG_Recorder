/** 事件日志面板：实时流水、筛选、搜索、种子复现校验。 */

import { h, render, fmtTime, fmtDateTime, toast } from '../util.js';
import { RNG } from '../../core/rng.js';
import { rollExpr, rollPercentile } from '../../core/dice.js';

const TYPE_META = {
  roll: { label: '掷骰', cls: 't-roll' },
  sheet: { label: '角色卡', cls: 't-sheet' },
  note: { label: '笔记', cls: 't-note' },
  scene: { label: '场景', cls: 't-scene' },
  session: { label: '场次', cls: 't-session' },
  system: { label: '系统', cls: 't-system' },
  combat: { label: '战斗', cls: 't-combat' },
};

export function renderLogView(root, app) {
  const { state } = app;

  /* 头部 */
  const head = h('div.panel-head', {},
    h('span', {}, '事件日志'),
    h('span.badge', {}, String(state.events.length)),
    h('div.spacer'),
    h('button.btn.sm.ghost', { title: '导出复盘', onclick: () => app.exportFlow() }, '⤓'),
    h('button.btn.sm.ghost', { title: '刷新', onclick: () => app.reloadEvents() }, '↻'),
  );

  /* 筛选 */
  const chips = h('div.log-tools', {},
    ...Object.entries(TYPE_META).map(([type, meta]) =>
      h('button.chip' + (state.logFilter.types.includes(type) ? '.active' : ''), {
        onclick: async () => {
          const arr = state.logFilter.types;
          state.logFilter.types = arr.includes(type) ? arr.filter(t => t !== type) : [...arr, type];
          await app.reloadEvents();
          app.renderLogPanel();
        },
      }, meta.label)),
  );

  const searchInput = h('input.input', {
    placeholder: '搜索标题 / 详情 / 角色…',
    value: state.logFilter.search,
    oninput: debounceInput(async (v) => {
      state.logFilter.search = v;
      await app.reloadEvents();
      app.renderLogPanel();
      const box = document.querySelector('.logpanel .input');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }),
  });

  const tools2 = h('div.log-tools', {}, searchInput,
    h('button.btn.sm', {
      title: '清除筛选',
      onclick: async () => {
        state.logFilter = { types: [], search: '' };
        await app.reloadEvents();
        app.renderLogPanel();
      },
    }, '清除'));

  /* 快速记一笔 */
  const quickInput = h('input.input', {
    placeholder: '快速记录一条事件，回车提交…',
    onkeydown: async (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      const text = e.target.value.trim();
      e.target.value = '';
      await app.addEvent({
        type: 'note',
        actor: app.selectedCharacter()?.id ?? null,
        actorName: app.selectedCharacter()?.name ?? null,
        title: text,
        detail: '',
      });
      toast('已记录');
    },
  });
  const tools3 = h('div.log-tools', {}, quickInput);

  /* 列表 */
  const body = h('div.panel-body');
  const list = h('div.log-list');

  if (!state.events.length) {
    list.appendChild(h('div.empty', {}, '还没有任何记录', h('br'), h('span.tiny', {}, '掷骰、改卡、记笔记都会出现在这里')));
  } else {
    for (const ev of state.events.slice().reverse()) {
      list.appendChild(logItem(ev, app));
    }
  }
  body.appendChild(list);

  render(root, head, chips, tools2, tools3, body);
}

function logItem(ev, app) {
  const meta = TYPE_META[ev.type] || { label: ev.type, cls: '' };
  const item = h('div.log-item.' + meta.cls, { title: fmtDateTime(ev.ts) },
    h('div.l-head', {},
      h('span.l-time', {}, fmtTime(ev.ts)),
      h('span.badge', {}, meta.label),
      ev.actorName ? h('span.l-who', {}, ev.actorName) : null,
      h('span.l-title', {}, ev.title || ''),
    ),
  );

  if (ev.detail) {
    const lines = String(ev.detail).split('\n');
    const shown = lines.length > 6 ? [...lines.slice(0, 6), `…（共 ${lines.length} 行）`] : lines;
    item.appendChild(h('div.l-detail', {}, shown.join('\n')));
  }

  const foot = h('div.l-foot');
  if (ev.seed) {
    foot.appendChild(h('span.seed', { title: '随机种子' }, `🎲 ${ev.seed}`));
    foot.appendChild(h('button.btn.sm.ghost', {
      title: '用同一种子重放，验证记录未被篡改',
      onclick: () => verifyEvent(ev),
    }, '复现校验'));
  }
  if (foot.childNodes.length) item.appendChild(foot);

  return item;
}

/** 依据日志中的种子重放该次掷骰，与记录比对 */
function verifyEvent(ev) {
  const d = ev.data;
  if (!d) { toast('该事件没有可复现的掷骰数据', true); return; }

  try {
    if (d.kind === 'expr' && d.expr) {
      const re = rollExpr(d.expr, { seed: d.seed });
      report(re.total === d.total, `重放 ${d.expr} → ${re.total}`, `记录 ${d.total}`);
      return;
    }
    if (d.system === 'coc7') {
      const rng = new RNG(d.seed);
      const pct = rollPercentile(rng, { bonus: d.bonus || 0, penalty: d.penalty || 0 });
      report(pct.value === d.roll, `重放 1d100 → ${pct.value}`, `记录 ${d.roll}`);
      return;
    }
    if (d.system === 'dnd5e') {
      const rng = new RNG(d.seed);
      const rolls = (d.rolls || []).map(() => rng.int(1, 20));
      const same = JSON.stringify(rolls) === JSON.stringify(d.rolls);
      report(same, `重放 d20 → [${rolls.join(', ')}]`, `记录 [${(d.rolls || []).join(', ')}]`);
      return;
    }
    if (d.system === 'daggerheart') {
      const rng = new RNG(d.seed);
      const hope = rng.int(1, 12);
      const fear = rng.int(1, 12);
      report(hope === d.hopeDie && fear === d.fearDie,
        `重放 2d12 → 希望 ${hope} / 恐惧 ${fear}`,
        `记录 希望 ${d.hopeDie} / 恐惧 ${d.fearDie}`);
      return;
    }
    toast('该事件类型暂不支持复现校验', true);
  } catch (err) {
    toast(`复现失败：${err.message}`, true);
  }
}

function report(same, got, expected) {
  if (same) toast(`✓ 复现一致 · ${got}`);
  else toast(`✗ 复现不一致 · ${got}（${expected}）`, true);
}

function debounceInput(fn, ms = 260) {
  let t;
  return (v) => {
    clearTimeout(t);
    t = setTimeout(() => fn(v), ms);
  };
}
