/** 判定面板：目标选择 → 修正 → 投掷 → 结果展示，另含快速骰与自由骰式。 */

import { h, render, toast, fmtTime } from '../util.js';
import { platform } from '../platform.js';

/** 面板自身的临时状态，切 Tab 不丢失 */
const local = {
  targetKey: null,
  targetLabel: '',
  targetValue: null,
  difficulty: 'regular',
  dc: null,
  bonus: 0,
  penalty: 0,
  advantage: 0,
  disadvantage: 0,
  help: 0,
  rollType: 'action',
  extraMod: 0,
  reason: '',
  freeExpr: '1d100',
  /** 对抗检定 */
  opponent: { label: '对手', value: 50, bonus: 0, penalty: 0 },
  pushConsequence: '',
};

const QUICK_DICE = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100', '2d6', '2d12', '4d6dl1', '2d20kh1'];

export function renderDiceView(root, app) {
  const { state, ruleset } = app;
  const rs = ruleset();
  const char = app.selectedCharacter();

  const container = h('div');
  render(root, container);

  if (!char) {
    container.appendChild(h('div.empty', {},
      h('div.big', {}, '🎲'),
      platform.isGm ? '请先在左侧选择或创建一个角色' : '你还没有认领角色卡',
      h('br'),
      h('span.tiny', {}, platform.isGm
        ? '所有判定都会记录到当前角色名下'
        : '请让主持人在牌桌上把一张角色卡分配给你，然后刷新页面'),
    ));
    container.appendChild(freeRollCard(app));
    return;
  }

  // 玩家点了别人的角色卡：明确告诉他，别让他掷完才发现被拒
  const mine = platform.isGm || (state.participant?.characterIds || []).includes(char.id);
  if (!mine) {
    container.appendChild(h('div.card', {
      style: { borderColor: 'var(--warn)', background: '#2b2416' },
    },
      h('div', { style: { fontWeight: 600, color: 'var(--warn)', marginBottom: '6px' } },
        `「${char.name}」不是你的角色卡`),
      h('div.tiny.muted', {},
        '现在选中的是其他玩家的角色，判定按钮不会生效。请从左侧切换到你自己的角色卡；'
        + '如果你还没有角色卡，请联系主持人分配。'),
    ));
  }

  // 目标变化时重置选择，避免角色切换后指向新角色不存在的技能（那样会静默按 0 计算）
  const groups = rs.rollTargets(char.data);
  if (local.targetKey && !groups.some(g => g.items.some(it => it.key === local.targetKey))) {
    local.targetKey = null;
    local.targetLabel = '';
    local.targetValue = null;
  }

  container.appendChild(targetCard(app, rs, char, groups));
  container.appendChild(modifierCard(app, rs, char));
  if (rs.supportsOpposed) container.appendChild(opposedCard(app, rs, char));
  container.appendChild(resultCard(app));
  container.appendChild(freeRollCard(app));
}

/* ── 对抗检定（COC） ── */

function opposedCard(app, rs, char) {
  const opp = local.opponent;

  const labelInput = h('input.input', {
    value: opp.label, placeholder: '对手名称，例如「邪教徒」',
    style: { flex: '1', minWidth: '120px' },
    onchange: (e) => { opp.label = e.target.value; },
  });
  const valueInput = h('input.input.mono', {
    type: 'number', value: opp.value, style: { width: '84px' }, title: '对手的技能或属性值',
    onchange: (e) => { opp.value = Number(e.target.value) || 0; },
  });
  const bonusInput = h('input.input.mono', {
    type: 'number', value: opp.bonus, style: { width: '62px' }, title: '对手的奖励骰',
    onchange: (e) => { opp.bonus = Math.max(0, Number(e.target.value) || 0); },
  });
  const penaltyInput = h('input.input.mono', {
    type: 'number', value: opp.penalty, style: { width: '62px' }, title: '对手的惩罚骰',
    onchange: (e) => { opp.penalty = Math.max(0, Number(e.target.value) || 0); },
  });

  const doOpposed = () => {
    if (!local.targetKey && local.targetValue == null) {
      toast('请先在上面选择一个我方技能', true);
      return;
    }
    app.performOpposedCheck({
      targetKey: local.targetKey,
      targetLabel: local.targetLabel,
      targetValue: local.targetValue,
      bonus: local.bonus,
      penalty: local.penalty,
      reason: local.reason,
      opponent: { ...opp },
    });
  };

  return h('div.card', {},
    h('h3', {}, '③ 对抗检定',
      h('div.spacer'),
      h('span.tiny.muted', { style: { textTransform: 'none', letterSpacing: 0 } },
        '双方各掷 d100，成功等级高者胜；等级相同则目标值高者胜'),
    ),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
      h('div.row.wrap', {},
        h('span.tiny.dim', { style: { width: '58px' } }, '我方'),
        h('span.mono', { style: { fontSize: '13px' } },
          local.targetLabel ? `${local.targetLabel} ${local.targetValue ?? ''}` : '（未选择）'),
        h('span.tiny.muted', {}, `奖励 ${local.bonus} / 惩罚 ${local.penalty}`),
      ),
      h('div.row.wrap', {},
        h('span.tiny.dim', { style: { width: '58px' } }, '对手'),
        labelInput,
        valueInput,
        h('span.tiny.dim', {}, '奖励'),
        bonusInput,
        h('span.tiny.dim', {}, '惩罚'),
        penaltyInput,
        h('button.btn.primary', { onclick: doOpposed }, '对抗'),
      ),
    ),
  );
}

/* ── 目标选择 ── */

function targetCard(app, rs, char, groups) {
  const items = h('div.target-groups');

  for (const g of groups) {
    const row = h('div.target-items');
    for (const it of g.items) {
      const active = local.targetKey === it.key;
      row.appendChild(h('button.target' + (active ? '.active' : ''), {
        onclick: () => {
          local.targetKey = it.key;
          local.targetLabel = it.label;
          local.targetValue = it.value;
          app.renderMain();
        },
        ondblclick: () => { local.targetKey = it.key; local.targetLabel = it.label; local.targetValue = it.value; doCheck(app, rs, char); },
        title: '单击选择，双击直接投掷',
      },
        h('span', {}, it.label),
        h('span.tv', {}, it.signed && it.value >= 0 ? `+${it.value}` : String(it.value)),
      ));
    }
    items.appendChild(h('div.target-group', {}, h('div.tg-title', {}, g.title), row));
  }

  return h('div.card', {},
    h('h3', {}, '① 选择判定目标',
      h('div.spacer'),
      h('span.tiny.muted', { style: { textTransform: 'none', letterSpacing: 0 } }, `${char.name} · 双击可直接投掷`),
    ),
    items,
  );
}

/* ── 修正与难度 ── */

function modifierCard(app, rs, char) {
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });

  /* 难度 / DC */
  const diffRow = h('div.row.wrap');
  if (rs.id === 'coc7') {
    diffRow.appendChild(h('span.tiny.dim', { style: { width: '70px' } }, '难度'));
    for (const d of rs.difficulties) {
      diffRow.appendChild(h('button.chip' + (local.difficulty === d.id ? '.active' : ''), {
        onclick: () => { local.difficulty = d.id; app.renderMain(); },
      }, d.label));
    }
    if (local.targetValue != null) {
      const hard = Math.floor(local.targetValue / 2);
      const extreme = Math.floor(local.targetValue / 5);
      diffRow.appendChild(h('span.tiny.muted.mono', { style: { marginLeft: 'auto' } },
        `目标 ${local.targetValue} / 困难 ${hard} / 极难 ${extreme}`));
    }
  } else {
    const list = rs.commonDCs || rs.commonDifficulties || [];
    diffRow.appendChild(h('span.tiny.dim', { style: { width: '70px' } }, '难度'));
    for (const d of list) {
      const val = d.id;
      diffRow.appendChild(h('button.chip' + (local.dc === val ? '.active' : ''), {
        onclick: () => { local.dc = val; app.renderMain(); },
      }, `${d.label} ${val}`));
    }
    const dcInput = h('input.input.mono', {
      type: 'number', value: local.dc ?? '', placeholder: 'DC',
      style: { width: '76px' },
      onchange: (e) => { local.dc = e.target.value === '' ? null : Number(e.target.value); app.renderMain(); },
    });
    diffRow.appendChild(dcInput);
  }
  body.appendChild(h('div.row.wrap', {}, h('span.tiny.dim', { style: { width: '70px' } }, '难度'), diffRow));

  /* 修正 */
  const modRow = h('div.row.wrap');
  modRow.appendChild(h('span.tiny.dim', { style: { width: '70px' } }, '修正'));

  if (rs.id === 'coc7') {
    modRow.appendChild(stepper('奖励骰', local.bonus, (v) => { local.bonus = Math.max(0, v); app.renderMain(); }));
    modRow.appendChild(stepper('惩罚骰', local.penalty, (v) => { local.penalty = Math.max(0, v); app.renderMain(); }));
    if (local.bonus && local.penalty) {
      modRow.appendChild(h('span.tiny', { style: { color: 'var(--warn)' } }, '（互相抵消，净额生效）'));
    }
  } else if (rs.id === 'dnd5e') {
    modRow.appendChild(toggleChip('优势', local.advantage > 0, () => {
      local.advantage = local.advantage > 0 ? 0 : 1;
      if (local.advantage) local.disadvantage = 0;
      app.renderMain();
    }));
    modRow.appendChild(toggleChip('劣势', local.disadvantage > 0, () => {
      local.disadvantage = local.disadvantage > 0 ? 0 : 1;
      if (local.disadvantage) local.advantage = 0;
      app.renderMain();
    }));
    modRow.appendChild(h('span.tiny.dim', { style: { marginLeft: '8px' } }, '额外修正'));
    modRow.appendChild(h('input.input.mono', {
      type: 'number', value: local.extraMod, style: { width: '68px' },
      onchange: (e) => { local.extraMod = Number(e.target.value) || 0; app.renderMain(); },
    }));
  } else if (rs.id === 'daggerheart') {
    modRow.appendChild(toggleChip('优势', local.advantage > 0, () => {
      local.advantage = local.advantage > 0 ? 0 : 1;
      if (local.advantage) local.disadvantage = 0;
      app.renderMain();
    }));
    modRow.appendChild(toggleChip('劣势', local.disadvantage > 0, () => {
      local.disadvantage = local.disadvantage > 0 ? 0 : 1;
      if (local.disadvantage) local.advantage = 0;
      app.renderMain();
    }));
    modRow.appendChild(stepper('协助骰', local.help, (v) => { local.help = Math.max(0, v); app.renderMain(); }));
    modRow.appendChild(toggleChip('反应判定', local.rollType === 'reaction', () => {
      local.rollType = local.rollType === 'reaction' ? 'action' : 'reaction';
      app.renderMain();
    }));
  }
  body.appendChild(modRow);

  /* 缘由 + 投掷 */
  const reasonInput = h('input.input', {
    placeholder: '判定缘由（会写进日志，例如「翻找书桌抽屉」）',
    value: local.reason,
    onchange: (e) => { local.reason = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') doCheck(app, rs, char); },
  });

  const rollBtn = h('button.btn.primary', {
    style: { padding: '8px 30px', fontSize: '15px' },
    onclick: () => doCheck(app, rs, char),
  }, '投掷');

  body.appendChild(h('div.row', {}, reasonInput, rollBtn));

  const head = h('h3', {}, '② 设定难度与修正');
  if (local.targetLabel) {
    head.appendChild(h('span.badge', { style: { textTransform: 'none' } }, `目标：${local.targetLabel}`));
  }

  return h('div.card', {}, head, body);
}

function stepper(label, value, onChange) {
  return h('div.row', { style: { gap: '4px' } },
    h('span.tiny.dim', {}, label),
    h('button.btn.sm', { onclick: () => onChange(value - 1) }, '−'),
    h('span.mono', { style: { minWidth: '18px', textAlign: 'center' } }, String(value)),
    h('button.btn.sm', { onclick: () => onChange(value + 1) }, '＋'),
  );
}

function toggleChip(label, active, onClick) {
  return h('button.chip' + (active ? '.active' : ''), { onclick: onClick }, label);
}

async function doCheck(app, rs, char) {
  if (!local.targetKey && local.targetValue == null) {
    toast('请先选择一个判定目标', true);
    return;
  }
  const req = {
    targetKey: local.targetKey,
    targetLabel: local.targetLabel,
    targetValue: local.targetValue,
    reason: local.reason,
    difficulty: rs.id === 'coc7' ? local.difficulty : undefined,
    dc: rs.id === 'dnd5e' ? local.dc : undefined,
    bonus: local.bonus,
    penalty: local.penalty,
    advantage: local.advantage,
    disadvantage: local.disadvantage,
    help: local.help,
    rollType: local.rollType,
    extraMod: local.extraMod,
  };
  if (rs.id === 'daggerheart') {
    req.difficulty = local.dc;
  }
  await app.performCheck(req);
}

/* ── 结果 ── */

function resultCard(app) {
  const lr = app.state.lastRoll;
  const rs = app.ruleset();
  if (!lr) {
    return h('div.card', {},
      h('h3', {}, rs.supportsOpposed ? '④ 判定结果' : '③ 判定结果'),
      h('div.empty', { style: { padding: '18px' } }, '还没有投掷记录。选择目标后按「投掷」。'),
    );
  }
  const r = lr.result;

  /* 对抗检定：左右并列展示双方 */
  if (r.kind === 'opposed') {
    const side = (res, tag) => h('div', {
      style: {
        flex: '1', background: 'var(--bg-2)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', padding: '11px 13px',
      },
    },
      h('div.tiny.muted', {}, tag),
      h('div', { style: { fontWeight: 700, fontSize: '14px', margin: '2px 0 5px' } }, res.targetLabel),
      h('div', { style: { fontSize: '27px', fontWeight: 800, fontFamily: 'var(--mono)', lineHeight: 1.1 } }, String(res.roll)),
      h('div', {
        style: { fontSize: '12px', fontWeight: 700, color: res.success ? 'var(--ok)' : 'var(--bad)' },
      }, res.outcomeLabel),
      h('div.tiny.muted.mono', { style: { marginTop: '3px' } }, `目标 ${res.target}`),
    );

    return h('div.result' + (r.tie ? '.neutral' : r.success ? '.success' : '.fail'), {},
      h('div.r-head', {},
        h('span.r-title', {}, r.title),
        h('span.r-verdict', {}, r.outcomeLabel),
        h('div.spacer'),
        lr.characterName ? h('span.tiny.muted', {}, lr.characterName) : null,
      ),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'stretch', marginBottom: '9px' } },
        side(r.self, '我方'),
        h('div', { style: { display: 'grid', placeItems: 'center', fontSize: '18px', color: 'var(--muted)' } }, 'vs'),
        side(r.foe, '对手'),
      ),
      h('div.r-detail', {}, r.detail),
      h('div.row', { style: { marginTop: '8px' } },
        h('span.tiny.muted.mono', {}, `种子 ${r.seed}`),
      ),
    );
  }

  const cls = r.success === true ? 'success' : r.success === false ? 'fail' : 'neutral';

  const head = h('div.r-head', {},
    h('span.r-title', {}, r.title),
    r.outcomeLabel ? h('span.r-verdict', {}, r.outcomeLabel) : null,
    h('div.spacer'),
    lr.characterName ? h('span.tiny.muted', {}, lr.characterName) : null,
  );

  const body = h('div');

  if (r.system === 'daggerheart' && r.kind === 'check') {
    body.appendChild(h('div.duality', {},
      h('div.dd.hope' + (r.critical ? '.crit' : ''), {}, String(r.hopeDie)),
      h('span.vs', {}, '+'),
      h('div.dd.fear' + (r.critical ? '.crit' : ''), {}, String(r.fearDie)),
      h('span.vs', {}, '='),
      h('div.r-big', { style: { margin: '0 0 0 6px' } }, String(r.total)),
      r.difficulty != null ? h('span.muted', {}, ` vs 难度 ${r.difficulty}`) : null,
    ));
    if (r.critical) {
      body.appendChild(h('div', { style: { color: 'var(--hope)', fontWeight: 700, marginBottom: '6px' } },
        '✦ 会心一击：自动成功并获得额外好处 · +1 希望 · 清除 1 点压力'));
    } else if (r.token) {
      body.appendChild(h('div', {
        style: { color: r.token === 'hope' ? 'var(--hope)' : 'var(--fear)', fontWeight: 600, marginBottom: '6px' },
      }, r.token === 'hope' ? '◇ 玩家获得 1 点希望' : '◆ GM 获得 1 点恐惧'));
    }
  } else if (r.system === 'dnd5e' && r.kind === 'deathsave') {
    body.appendChild(h('div.r-big', {}, String(r.roll)));
    body.appendChild(h('div.row.wrap', { style: { marginBottom: '8px' } },
      h('span.badge', { style: { background: '#3f6b4f', color: '#bfe6cd' } }, `成功 ${r.successes}/3`),
      h('span.badge', { style: { background: '#5a2f2c', color: '#ffc9c5' } }, `失败 ${r.failures}/3`),
      h('span.badge', {}, r.statusLabel),
    ));
  } else if (r.system === 'dnd5e' && r.kind === 'check') {
    body.appendChild(h('div.r-big', {}, String(r.total)));
    body.appendChild(h('div.row.wrap', { style: { marginBottom: '8px' } },
      ...(r.rolls || []).map((v) => {
        const kept = r.rolls.length === 1 || v === r.kept;
        return h('span', {
          style: {
            fontFamily: 'var(--mono)', fontWeight: 700, fontSize: '17px',
            padding: '2px 9px', borderRadius: '7px',
            border: '1px solid ' + (kept ? 'var(--accent-dim)' : 'var(--border)'),
            color: kept ? 'var(--text)' : 'var(--muted)',
            textDecoration: kept ? 'none' : 'line-through',
          },
        }, String(v));
      }),
      h('span.muted', {}, ` ${r.bonus >= 0 ? '+' : ''}${r.bonus}`),
      r.dc != null ? h('span.muted', {}, ` vs DC ${r.dc}`) : null,
    ));
  } else if (r.system === 'coc7' && r.kind === 'check') {
    body.appendChild(h('div.r-big', {}, String(r.roll)));
    const pct = r.percentile;
    body.appendChild(h('div.row.wrap', { style: { marginBottom: '8px' } },
      h('span.muted.tiny', {}, `十位 ${pct.chosen} × 10 + 个位 ${pct.units} = ${r.roll}`),
      (r.bonus || r.penalty)
        ? h('span.badge', {}, r.bonus > r.penalty ? `奖励骰 ×${r.bonus - r.penalty}` : `惩罚骰 ×${r.penalty - r.bonus}`)
        : null,
      h('span.badge', {}, `困难 ${r.hard} / 极难 ${r.extreme}`),
    ));
  } else {
    body.appendChild(h('div.r-big', {}, String(r.total)));
  }

  body.appendChild(h('div.r-detail', {}, r.detail));

  /* 孤注一掷：COC 判定失败后的重掷入口 */
  if (rs.supportsPush && r.system === 'coc7' && r.kind === 'check' && !r.success && !r.pushed) {
    const consInput = h('input.input', {
      value: local.pushConsequence,
      placeholder: '先说明失败会付出什么代价（会写进日志）',
      onchange: (e) => { local.pushConsequence = e.target.value; },
    });
    body.appendChild(h('div', {
      style: {
        marginTop: '10px', paddingTop: '10px',
        borderTop: '1px dashed var(--border)', display: 'flex', gap: '8px', alignItems: 'center',
      },
    },
      consInput,
      h('button.btn', {
        title: '用相同条件重掷一次',
        onclick: async () => {
          await app.pushLastRoll(local.pushConsequence);
          local.pushConsequence = '';
        },
      }, '孤注一掷'),
    ));
  }

  body.appendChild(h('div.row', { style: { marginTop: '9px' } },
    h('span.tiny.muted.mono', {}, `种子 ${r.seed}`),
  ));

  return h('div.result.' + cls, {}, head, body);
}

/* ── 快速骰与自由骰式 ── */

function freeRollCard(app) {
  const quick = h('div.dice-grid', {}, QUICK_DICE.map(d =>
    h('button.die-btn', { onclick: () => app.rollRaw(d) }, d)));

  const input = h('input.input.mono', {
    value: local.freeExpr,
    placeholder: '例如 3d6+2 / 4d6dl1 / 6d6>=5 / 2d20kh1',
    onchange: (e) => { local.freeExpr = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') { local.freeExpr = e.target.value; app.rollRaw(local.freeExpr); } },
  });

  return h('div.card', {},
    h('h3', {}, '自由骰式',
      h('div.spacer'),
      h('button.btn.sm.ghost', { onclick: () => app.openHelpDialog?.() }, '语法'),
    ),
    quick,
    h('div.row', { style: { marginTop: '10px' } },
      input,
      h('button.btn', { onclick: () => app.rollRaw(local.freeExpr) }, '投掷'),
    ),
  );
}
