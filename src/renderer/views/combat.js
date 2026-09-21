/**
 * 战斗追踪器：先攻序列、回合推进、伤害与状态管理。
 *
 * 所有会改变战局的操作都会写进事件日志（伤害、倒地、加入/移除、回合推进），
 * 这样一场战斗打完，日志里就是一份完整的战报。
 */

import { h, render, toast, confirmDialog } from '../util.js';
import { rollExpr } from '../../core/dice.js';
import { getRuleset } from '../../core/rulesets/index.js';
import { platform } from '../platform.js';
import { combatantFromCharacter, blankCombatant, setTrackValue, getTrack } from '../characterOps.js';

const COMMON_CONDITIONS = ['中毒', '麻痹', '束缚', '目盲', '恐惧', '流血', '倒地', '隐身', '加速'];

export function renderCombatView(root, app) {
  const combat = app.state.combat || { active: false, round: 1, turnIndex: 0, combatants: [] };
  const container = h('div');
  render(root, container);

  // 玩家只读：战斗由主持人推进，界面上不给任何会写盘的入口
  if (!platform.isGm) {
    renderCombatReadOnly(container, app, combat);
    return;
  }

  container.appendChild(controlCard(app, combat));
  container.appendChild(setupCard(app, combat));
  container.appendChild(listCard(app, combat));
}

/* ────────────────────────── 玩家视角（只读） ────────────────────────── */

function renderCombatReadOnly(container, app, combat) {
  const list = sortedCombatants(combat);

  if (!combat.active && !list.length) {
    container.appendChild(h('div.empty', {},
      h('div.big', {}, '⚔️'),
      '主持人还没有开始战斗',
      h('br'),
      h('span.tiny', {}, '战斗开始后，这里会实时显示先攻顺序与各人状态')));
    return;
  }

  const current = combat.active ? list[combat.turnIndex] : null;

  container.appendChild(h('div.card', {},
    h('h3', {}, '战况',
      combat.active
        ? h('span.badge', { style: { background: '#5a2f2c', color: '#ffc9c5' } }, `第 ${combat.round} 回合`)
        : h('span.badge', {}, '未开始'),
      h('div.spacer'),
      h('span.tiny.muted', { style: { textTransform: 'none', letterSpacing: 0 } }, `${list.length} 名参战者`),
    ),
    current
      ? h('div', {
        style: {
          background: 'var(--bg-2)', border: '1px solid var(--accent-dim)',
          borderRadius: 'var(--radius)', padding: '10px 13px',
        },
      },
        h('div', { style: { fontSize: '11px', color: 'var(--muted)', letterSpacing: '.06em' } }, '当前行动者'),
        h('div', { style: { fontSize: '19px', fontWeight: 700, marginTop: '2px' } }, current.name),
        h('div.tiny.muted', {}, `先攻 ${current.initiative ?? '—'} · 生命 ${current.hp}/${current.maxHp}`),
        current.conditions ? h('div.tiny', { style: { color: 'var(--warn)', marginTop: '3px' } }, `状态：${current.conditions}`) : null,
      )
      : h('div.tiny.muted', {}, '战斗尚未开始'),
  ));

  // 顺序表
  const rows = list.map((cb, i) => {
    const isCurrent = combat.active && i === combat.turnIndex;
    const pct = cb.maxHp > 0 ? Math.max(0, Math.min(100, (cb.hp / cb.maxHp) * 100)) : 0;
    return h('div', {
      style: {
        background: isCurrent ? 'var(--bg-3)' : 'var(--bg-2)',
        border: `1px solid ${isCurrent ? 'var(--accent-dim)' : 'var(--border-soft)'}`,
        borderRadius: 'var(--radius)', padding: '9px 11px',
        opacity: cb.defeated ? .55 : 1,
      },
    },
      h('div.row', { style: { gap: '9px' } },
        isCurrent ? h('span', { style: { color: 'var(--accent)', fontWeight: 700 } }, '▶') : h('span', { style: { width: '11px' } }),
        h('span.mono.tiny.muted', { style: { width: '26px' } }, String(cb.initiative ?? '—')),
        h('span', { style: { flex: '1', fontWeight: 600, textDecoration: cb.defeated ? 'line-through' : 'none' } }, cb.name),
        h('div', {
          style: {
            flex: '1', minWidth: '90px', height: '17px', background: 'var(--bg)',
            borderRadius: '5px', overflow: 'hidden', position: 'relative', border: '1px solid var(--border-soft)',
          },
        },
          h('div', {
            style: {
              width: pct + '%', height: '100%', transition: 'width .2s',
              background: pct > 50 ? '#a8443f' : pct > 20 ? '#b06a2f' : '#7a2f2c',
            },
          }),
          h('div', {
            style: {
              position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
              fontSize: '11px', fontFamily: 'var(--mono)', textShadow: '0 1px 3px #000c',
            },
          }, `${cb.hp} / ${cb.maxHp}`),
        ),
      ),
      cb.conditions ? h('div.tiny', { style: { color: 'var(--warn)', marginTop: '4px', marginLeft: '46px' } }, cb.conditions) : null,
    );
  });

  container.appendChild(h('div.card', {},
    h('h3', {}, '先攻顺序'),
    rows.length
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } }, rows)
      : h('div.tiny.muted', {}, '暂无参战者'),
  ));
}

/* ────────────────────────── 战斗控制 ────────────────────────── */

function controlCard(app, combat) {
  const list = sortedCombatants(combat);
  const current = list[combat.turnIndex] || null;

  const head = h('h3', {}, '战斗控制',
    combat.active ? h('span.badge', { style: { background: '#5a2f2c', color: '#ffc9c5' } }, '进行中') : null,
    h('div.spacer'),
    combat.active
      ? h('span.tiny.muted', {}, `回合 ${combat.round} · ${combat.turnIndex + 1}/${list.length}`)
      : h('span.tiny.muted', {}, `${list.length} 名参战者`),
  );

  const row = h('div.row.wrap');

  if (!combat.active) {
    row.appendChild(h('button.btn.primary', {
      disabled: !list.length,
      onclick: () => {
        app.updateCombat((c) => {
          c.active = true;
          c.round = 1;
          c.turnIndex = 0;
          // 还没掷先攻的先统一掷掉，避免开局卡住
          if (c.combatants.some(x => x.initiative == null)) rollAllInitiative(app, c, false);
        });
        app.addEvent({ type: 'combat', title: '战斗开始', detail: describeOrder(app, app.state.combat) });
      },
    }, '开始战斗'));
  } else {
    row.appendChild(h('button.btn', { onclick: () => stepTurn(app, -1) }, '← 上一回合'));
    row.appendChild(h('button.btn.primary', { onclick: () => stepTurn(app, +1) }, '下一回合 →'));
    row.appendChild(h('button.btn', {
      onclick: async () => {
        const ok = await confirmDialog('结束战斗', '战斗状态会被清空（参战者列表保留）。确定结束吗？', '结束战斗');
        if (!ok) return;
        app.updateCombat((c) => { c.active = false; c.round = 1; c.turnIndex = 0; });
        app.addEvent({
          type: 'combat',
          title: `战斗结束（共 ${combat.round} 回合）`,
          detail: sortedCombatants(combat).map(c => `${c.name} ${c.hp}/${c.maxHp}${c.defeated ? '（倒地）' : ''}`).join('\n'),
        });
      },
    }, '结束战斗'));
  }

  row.appendChild(h('button.btn', {
    disabled: !list.length,
    onclick: () => { rollAllInitiative(app, combat, true); },
  }, '🎲 全部掷先攻'));
  row.appendChild(h('button.btn', {
    disabled: !list.length,
    onclick: () => {
      app.updateCombat((c) => { c.round = 1; c.turnIndex = 0; c.combatants.forEach(x => { x.defeated = false; }); });
      app.addEvent({ type: 'combat', title: '重置战斗', detail: '回合归 1，倒地标记已清除' });
    },
  }, '重置回合'));

  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '11px' } }, row);

  if (combat.active && current) {
    body.appendChild(h('div', {
      style: {
        background: 'var(--bg-2)', border: '1px solid var(--accent-dim)',
        borderRadius: 'var(--radius)', padding: '10px 13px',
      },
    },
      h('div', { style: { fontSize: '11px', color: 'var(--muted)', letterSpacing: '.06em' } }, '当前行动者'),
      h('div', { style: { fontSize: '19px', fontWeight: 700, marginTop: '2px' } },
        current.name,
        current.defeated ? h('span.badge', { style: { marginLeft: '8px', background: '#5a2f2c', color: '#ffc9c5' } }, '已倒地') : null,
      ),
      h('div.tiny.muted', {}, `先攻 ${current.initiative ?? '—'} · ${current.defenseLabel} ${current.defense ?? '—'} · 生命 ${current.hp}/${current.maxHp}`),
      current.conditions ? h('div.tiny', { style: { color: 'var(--warn)', marginTop: '3px' } }, `状态：${current.conditions}`) : null,
    ));
  }

  return h('div.card', {}, head, body);
}

/* ────────────────────────── 添加参战者 ────────────────────────── */

function setupCard(app, combat) {
  const rs = app.ruleset();
  const inCombat = new Set(combat.combatants.map(c => c.refId).filter(Boolean));
  const available = app.state.characters.filter(c => !inCombat.has(c.id));

  const pcButtons = available.map(c =>
    h('button.target', {
      onclick: () => {
        const cb = combatantFromCharacter(getRuleset(c.system || app.state.campaign.system), c);
        app.updateCombat((x) => { x.combatants.push(cb); });
        app.addEvent({
          type: 'combat', actor: c.id, actorName: c.name,
          title: `加入战斗：${c.name}`,
          detail: `生命 ${cb.hp}/${cb.maxHp} · ${cb.defenseLabel} ${cb.defense ?? '—'}`,
        });
      },
    }, h('span', {}, c.name), h('span.tv', {}, `${c.system || app.state.campaign.system}`)));

  const nameInput = h('input.input', { placeholder: '杂兵 / NPC 名称，例如「哥布林 A」' });
  const hpInput = h('input.input.mono', { type: 'number', value: 10, style: { width: '84px' }, title: '生命上限' });
  const acInput = h('input.input.mono', { type: 'number', value: 12, style: { width: '84px' }, title: '防御值' });

  const addNpc = () => {
    const name = nameInput.value.trim() || `无名者 ${combat.combatants.length + 1}`;
    const cb = blankCombatant(name);
    cb.maxHp = Number(hpInput.value) || 10;
    cb.hp = cb.maxHp;
    cb.defense = Number(acInput.value) || 12;
    cb.defenseLabel = rs.id === 'daggerheart' ? '闪避' : 'AC';
    app.updateCombat((x) => { x.combatants.push(cb); });
    app.addEvent({ type: 'combat', title: `加入战斗：${cb.name}`, detail: `生命 ${cb.hp}/${cb.maxHp} · ${cb.defenseLabel} ${cb.defense}` });
    nameInput.value = '';
    nameInput.focus();
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addNpc(); });

  return h('div.card', {},
    h('h3', {}, '添加参战者'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div.target-group', {},
        h('div.tg-title', {}, '从角色卡加入'),
        pcButtons.length
          ? h('div.target-items', {}, pcButtons)
          : h('div.tiny.muted', {}, '所有角色都已在战斗中'),
      ),
      h('div.target-group', {},
        h('div.tg-title', {}, '手动添加'),
        h('div.row.wrap', {}, nameInput, hpInput, acInput,
          h('button.btn', { onclick: addNpc }, '＋ 添加')),
      ),
    ),
  );
}

/* ────────────────────────── 参战者列表 ────────────────────────── */

function listCard(app, combat) {
  const list = sortedCombatants(combat);
  const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } });

  if (!list.length) {
    wrap.appendChild(h('div.empty', {},
      h('div.big', {}, '⚔️'),
      '战斗还没有参战者',
      h('br'),
      h('span.tiny', {}, '从上方把角色卡加入，或手动添加杂兵')));
  }

  list.forEach((cb) => {
    const index = combat.combatants.indexOf(cb);
    wrap.appendChild(combatantRow(app, combat, cb, index));
  });

  return h('div.card', {},
    h('h3', {}, '先攻顺序',
      h('div.spacer'),
      h('span.tiny.muted', { style: { textTransform: 'none', letterSpacing: 0 } }, '按先攻从高到低行动'),
    ),
    wrap,
  );
}

function combatantRow(app, combat, cb, index) {
  const isCurrent = combat.active && sortedCombatants(combat)[combat.turnIndex]?.id === cb.id;
  const pct = cb.maxHp > 0 ? Math.max(0, Math.min(100, (cb.hp / cb.maxHp) * 100)) : 0;

  const initInput = h('input.input.mono', {
    type: 'number', value: cb.initiative ?? '', placeholder: '—',
    style: { width: '62px', textAlign: 'center' },
    onchange: (e) => {
      const v = e.target.value === '' ? null : Number(e.target.value);
      app.updateCombat((c) => { c.combatants[index].initiative = v; });
    },
  });

  const hpBar = h('div.bar', {
    style: { flex: '1', height: '18px', background: 'var(--bg)', borderRadius: '5px', overflow: 'hidden', position: 'relative', border: '1px solid var(--border-soft)' },
  },
    h('div.fill', { style: { width: pct + '%', height: '100%', background: pct > 50 ? '#a8443f' : pct > 20 ? '#b06a2f' : '#7a2f2c', transition: 'width .2s' } }),
    h('div.txt', {
      style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: '11px', fontFamily: 'var(--mono)', textShadow: '0 1px 3px #000c' },
    }, `${cb.hp} / ${cb.maxHp}`),
  );

  const hpInput = h('input.input.mono', {
    type: 'number', value: cb.hp, style: { width: '62px' },
    title: '直接设定当前生命值',
    onchange: (e) => applyHp(app, cb, Number(e.target.value) - cb.hp, '设定'),
  });

  const conditionInput = h('input.input', {
    value: cb.conditions, placeholder: '状态（如：中毒、束缚）',
    onchange: (e) => app.updateCombat((c) => { c.combatants[index].conditions = e.target.value; }),
  });

  const quickChips = h('div.row.wrap', { style: { gap: '4px', marginTop: '4px' } },
    ...COMMON_CONDITIONS.slice(0, 6).map(cond =>
      h('button.chip', {
        style: { fontSize: '11px', padding: '0 7px' },
        onclick: () => {
          app.updateCombat((c) => {
            const cur = c.combatants[index].conditions;
            const parts = cur ? cur.split(/[,，]\s*/).filter(Boolean) : [];
            const i = parts.indexOf(cond);
            if (i >= 0) parts.splice(i, 1); else parts.push(cond);
            c.combatants[index].conditions = parts.join('、');
          });
        },
      }, cond)));

  return h('div', {
    style: {
      background: isCurrent ? 'var(--bg-3)' : 'var(--bg-2)',
      border: `1px solid ${isCurrent ? 'var(--accent-dim)' : 'var(--border-soft)'}`,
      borderRadius: 'var(--radius)', padding: '9px 11px',
      opacity: cb.defeated ? .55 : 1,
    },
  },
    h('div.row', { style: { gap: '8px' } },
      isCurrent ? h('span', { style: { color: 'var(--accent)', fontWeight: 700 } }, '▶') : h('span', { style: { width: '11px' } }),
      initInput,
      h('span', {
        style: { flex: '1', fontWeight: 600, textDecoration: cb.defeated ? 'line-through' : 'none' },
      }, cb.name,
        cb.kind === 'pc' ? h('span.badge', { style: { marginLeft: '6px', background: '#2c4436', color: '#9fd9b6' } }, 'PC') : null,
      ),
      h('span.tiny.muted', {}, `${cb.defenseLabel} ${cb.defense ?? '—'}`),
      hpBar,
      hpInput,
      h('div.ctl', { style: { display: 'flex', gap: '3px' } },
        h('button.btn.sm', { onclick: () => applyHp(app, cb, -5, '受到伤害') }, '−5'),
        h('button.btn.sm', { onclick: () => applyHp(app, cb, -1, '受到伤害') }, '−1'),
        h('button.btn.sm', { onclick: () => applyHp(app, cb, +1, '恢复生命') }, '+1'),
        h('button.btn.sm', { onclick: () => applyHp(app, cb, +5, '恢复生命') }, '+5'),
      ),
      h('button.btn.sm' + (cb.defeated ? '.primary' : ''), {
        title: cb.defeated ? '标记为站立' : '标记为倒地',
        onclick: () => {
          const next = !cb.defeated;
          app.updateCombat((c) => { c.combatants[index].defeated = next; });
          app.addEvent({
            type: 'combat', actor: cb.refId, actorName: cb.kind === 'pc' ? cb.name : null,
            title: `${cb.name} ${next ? '倒地' : '重新站起'}`,
            detail: `剩余生命 ${cb.hp}/${cb.maxHp}`,
          });
        },
      }, cb.defeated ? '起身' : '倒地'),
      h('button.btn.sm.ghost', {
        title: '移除参战者',
        onclick: () => {
          app.updateCombat((c) => {
            c.combatants.splice(index, 1);
            if (c.turnIndex >= c.combatants.length) c.turnIndex = 0;
          });
          app.addEvent({ type: 'combat', title: `移出战斗：${cb.name}`, detail: '' });
        },
      }, '✕'),
    ),
    h('div.row', { style: { gap: '8px', marginTop: '6px' } }, conditionInput),
    quickChips,
  );
}

/* ────────────────────────── 行为 ────────────────────────── */

function applyHp(app, cb, delta, verb) {
  if (!delta) return;
  app.updateCombat((c) => {
    const t = c.combatants.find(x => x.id === cb.id);
    if (!t) return;
    t.hp = Math.max(0, Math.min(t.maxHp, t.hp + delta));
    if (t.hp === 0) t.defeated = true;
  });

  // 绑定角色卡的参战者，生命值同步写回角色卡
  if (cb.kind === 'pc' && cb.refId) {
    const char = app.state.characters.find(c => c.id === cb.refId);
    if (char) {
      const rs = getRuleset(char.system || app.state.campaign.system);
      const track = getTrack(rs, char.data, 'hp');
      if (track) {
        const next = Math.max(0, Math.min(track.max, track.current + delta));
        // 直接改内存后按 id 落盘——这里不能走 saveCharacterNow，它只认当前选中的角色
        setTrackValue(char.data, 'hp', next);
        app.persistCharacter(char, { emit: false });
        app.renderSidebar();   // 侧栏的生命条也要跟着变
      }
    }
  }

  const target = app.state.combat.combatants.find(x => x.id === cb.id);
  const heal = delta > 0;
  app.addEvent({
    type: 'combat',
    actor: cb.refId,
    actorName: cb.kind === 'pc' ? cb.name : null,
    title: `${cb.name} ${verb} ${Math.abs(delta)} 点`,
    detail: `生命值 ${target?.hp ?? '?'}/${cb.maxHp}${target?.defeated ? '（已倒地）' : ''}`,
    tags: [heal ? '治疗' : '伤害'],
  });
}

function stepTurn(app, dir) {
  const combat = app.state.combat;
  const n = combat.combatants.length;
  if (!n) return;

  let round = combat.round;
  let turn = combat.turnIndex + dir;

  if (turn >= n) { turn = 0; round += 1; }
  if (turn < 0) { turn = n - 1; round = Math.max(1, round - 1); }

  const rolledRound = round !== combat.round;
  app.updateCombat((c) => { c.round = round; c.turnIndex = turn; });

  if (rolledRound && dir > 0) {
    app.addEvent({
      type: 'combat',
      title: `进入第 ${round} 回合`,
      detail: sortedCombatants(app.state.combat).map(c => `${c.name} ${c.hp}/${c.maxHp}`).join('\n'),
    });
  }
}

/** 为所有还没有先攻值的参战者掷先攻 */
function rollAllInitiative(app, combat, notify) {
  const rs = app.ruleset();
  const rolls = [];

  app.updateCombat((c) => {
    for (const cb of c.combatants) {
      if (cb.initiative != null && !notify) continue;
      const inst = initiativeFor(app, rs, cb);
      cb.initiative = inst.value;
      rolls.push(`${cb.name} ${inst.detail}`);
    }
  });

  if (rolls.length) {
    app.addEvent({
      type: 'combat',
      title: '掷先攻',
      detail: rolls.join('\n'),
      seed: null,
    });
    if (notify) toast('先攻已重掷');
  }
}

/** 按规则系统计算先攻：COC 直接取 DEX，其余掷 1d20 + 调整值 */
function initiativeFor(app, rs, cb) {
  const char = cb.refId ? app.state.characters.find(c => c.id === cb.refId) : null;
  const inst = char ? rs.initiative(char.data) : { kind: 'roll', expr: '1d20', mod: 0, label: '1d20' };

  if (inst.kind === 'static') {
    return { value: inst.value, detail: `${inst.value}（${inst.label}）` };
  }
  const r = rollExpr(inst.expr, { seed: null });
  const total = r.total + (inst.mod || 0);
  return {
    value: total,
    detail: `${r.total} ${inst.mod >= 0 ? '+' : ''}${inst.mod} = ${total}`,
  };
}

export function sortedCombatants(combat) {
  return combat.combatants
    .slice()
    .sort((a, b) => (b.initiative ?? -999) - (a.initiative ?? -999) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function describeOrder(app, combat) {
  return sortedCombatants(combat)
    .map((c, i) => `${i + 1}. ${c.name}（先攻 ${c.initiative ?? '—'}）`)
    .join('\n');
}
