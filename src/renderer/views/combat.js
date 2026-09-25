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
import {
  combatantFromCharacter, blankCombatant, setTrackValue, getTrack,
  combatantActions, combatantData, defaultActionTarget,
} from '../characterOps.js';
import { stepTurnIndex, standingIndexes } from '../../core/turn.js';
import {
  actionFromPreset, describeAction, describeActionResult, describeCost,
  resolveAction, kindsFor, normalizeActions, expandDamageExpr,
  canUseKind, markKindUsed, refreshUsage, scopeOf,
} from '../../core/actions.js';

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
  const standing = standingIndexes(list).length;

  const head = h('h3', {}, '战斗控制',
    combat.active ? h('span.badge', { style: { background: '#5a2f2c', color: '#ffc9c5' } }, '进行中') : null,
    h('div.spacer'),
    combat.active
      ? h('span.tiny.muted', {}, `回合 ${combat.round} · 第 ${combat.turnIndex + 1}/${list.length} 位`
        + ` · 还站着 ${standing} 人`)
      : h('span.tiny.muted', {}, `${list.length} 名参战者`),
  );

  // 没开始战斗时先把「谁没有行动」说清楚，免得开打了才发现轮到他无从结算
  const noActions = combat.combatants.filter(c => !combatantActions(app, c).length);

  const row = h('div.row.wrap');

  if (!combat.active) {
    row.appendChild(h('button.btn.primary', {
      disabled: !list.length,
      onclick: () => {
        app.updateCombat((c) => {
          c.active = true;
          c.round = 1;
          c.turnIndex = 0;
          c.used = {};   // 行动经济从头算起
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
        app.updateCombat((c) => { c.active = false; c.round = 1; c.turnIndex = 0; c.used = {}; });
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
      app.updateCombat((c) => {
        c.round = 1; c.turnIndex = 0; c.combatants.forEach(x => { x.defeated = false; }); c.used = {};
      });
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
      actionBar(app, combat, current, list),
    ));
  }

  if (noActions.length) {
    body.appendChild(h('div', {
      style: {
        background: '#2a2318', border: '1px solid #5a4a24',
        borderRadius: 'var(--radius)', padding: '9px 12px', lineHeight: 1.8,
      },
    },
      h('div', { style: { fontSize: '12.5px', color: '#ffd79a', fontWeight: 600 } },
        `有 ${noActions.length} 名参战者还没声明行动`),
      h('div.tiny.muted', {},
        noActions.map(c => c.name).join('、'),
        ' —— 战斗里只能按已声明的行动结算，轮到他们时回合会白转一圈。'
        + '加入角色卡时若空着会自动补上预设，手动加的 NPC 也默认带全部预设。'),
    ));
  }

  return h('div.card', {}, head, body);
}

/* ────────────────────────── 行动条 ────────────────────────── */

/** 行动条里「展开全部」的状态，按「参战者:行动经济」记 —— 重绘不该把它清掉 */
const expandedGroups = new Set();

/** 每一类行动经济默认先摆几个，多的折起来，免得一排铺满整屏 */
const GROUP_LIMIT = 6;

/**
 * 当前行动者可用的行动。
 *
 * 这里是「只能根据角色动作来」这条约束的落点：
 * 战斗进行中，结算入口只有这一排按钮，来源是行动者自己声明的行动组。
 */
function actionBar(app, combat, actor, list) {
  const rs = app.ruleset();
  const actions = combatantActions(app, actor);
  const kinds = kindsFor(rs.id);

  const others = list.filter(c => c.id !== actor.id);
  const defaultTarget = defaultActionTarget(actor, others);

  const targetSel = h('select.select', {
    style: { flex: '1', minWidth: '130px' },
    onchange: (e) => { targetSel.dataset.picked = e.target.value; },
  }, others.length
    ? others.map(c => h('option', {
      value: c.id,
      selected: defaultTarget && c.id === defaultTarget.id,
    }, `${c.name}（${c.defenseLabel} ${c.defense ?? '—'}${c.defeated ? ' · 已倒地' : ''}）`))
    : [h('option', { value: '' }, '（场上没有其他参战者）')]);
  if (defaultTarget) targetSel.dataset.picked = defaultTarget.id;

  const wrap = h('div', {
    style: {
      marginTop: '11px', paddingTop: '11px',
      borderTop: '1px dashed var(--border)',
    },
  });

  wrap.appendChild(h('div.row', { style: { marginBottom: '8px' } },
    h('span.tiny.dim', { style: { flex: '0 0 auto' } }, '目标'),
    targetSel,
  ));

  if (!actions.length) {
    wrap.appendChild(h('div.tiny.muted', { style: { lineHeight: 1.8 } },
      '这名参战者还没有声明任何行动。',
      actor.kind === 'pc'
        ? '到它的角色卡 →「行动」里添加。'
        : '移除后重新添加，或在添加时选择行动。'));

    // 就地补上预设，省得为了加几个行动跑去角色卡再回来
    const presets = rs.actionPresets || [];
    if (presets.length) {
      wrap.appendChild(h('div.row', { style: { marginTop: '8px' } },
        h('button.btn.primary.sm', {
          onclick: async () => {
            const ok = await confirmDialog('补上行动',
              `将把「${rs.short}」的 ${presets.length} 个常用预设加到 ${actor.name} 上，之后可以逐个删改。`,
              '全部添加');
            if (!ok) return;
            if (actor.kind === 'pc' && actor.refId) {
              const char = app.state.characters.find(x => x.id === actor.refId);
              if (char) {
                char.data.actions = presets.map(actionFromPreset);
                await app.persistCharacter(char);
              }
            } else {
              app.updateCombat((c) => {
                const t = c.combatants.find(x => x.id === actor.id);
                if (!t) return;
                t.actions = presets.map(actionFromPreset);
                if (t.data) t.data.actions = t.actions;
              });
            }
            toast(`已为 ${actor.name} 补上 ${presets.length} 个行动`);
          },
        }, `＋ 补上「${rs.short}」的全部 ${presets.length} 个预设`)));
    }
    return wrap;
  }

  /* 按行动经济分组；已经用掉的那一类会置灰，仿照 BG3 的状态栏 */
  const usage = combat.used || {};
  const data = combatantData(app, actor);

  for (const kind of kinds) {
    const group = actions.filter(a => (a.kind || 'action') === kind.id);
    if (!group.length) continue;

    const spent = !canUseKind(usage, actor.id, kind.id);
    const scope = scopeOf(kind.id);
    const key = `${actor.id}:${kind.id}`;
    const expanded = expandedGroups.has(key);
    const shown = expanded ? group : group.slice(0, GROUP_LIMIT);
    const hidden = group.length - shown.length;

    wrap.appendChild(h('div', { style: { marginBottom: '7px' } },
      h('div.tiny', { style: { color: spent ? 'var(--muted)' : 'var(--muted)', marginBottom: '4px' } },
        kind.label,
        h('span.tiny.muted', {}, `　${kind.hint}`),
        h('span.tiny.muted', {}, `　${group.length} 个`),
        spent ? h('span.badge', { style: { marginLeft: '6px', background: '#4a3a1f', color: '#ffd79a' } },
          scope === 'round' ? '本轮已用' : '本回合已用') : null),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } },
        ...shown.map((act) => {
          // 伤害骰式里的 DB / STR 这类符号按当前行动者展开，免得界面上看到占位符
          const dmg = act.damage ? expandDamageExpr(rs, data || {}, act.damage) : '';
          return h('button.btn.sm.action-btn' + (spent ? '.ghost' : ''), {
            'data-action': act.name,
            'data-kind': act.kind || 'action',
            'data-spent': spent ? '1' : '0',
            disabled: spent,
            title: `${describeAction(act) || '无判定'}${act.note ? `\n${act.note}` : ''}`
              + (spent ? '\n（这一类行动经济已经用掉了）' : ''),
            style: { textAlign: 'left', opacity: spent ? .45 : 1 },
            onclick: () => resolveActorAction(app, actor, act, targetSel.dataset.picked, list),
          }, act.name + (dmg ? ` ⟶ ${dmg}` : ''));
        }),
        group.length > GROUP_LIMIT
          ? h('button.btn.sm.ghost.action-more', {
            title: expanded ? '只显示前几个' : '把这一类行动全部摆出来',
            onclick: () => {
              if (expanded) expandedGroups.delete(key); else expandedGroups.add(key);
              app.renderMain();
            },
          }, expanded ? '收起' : `展开全部（还有 ${hidden} 个）`)
          : null,
      ),
    ));
  }

  if (kinds.every(k => scopeOf(k.id) === 'none' || !canUseKind(usage, actor.id, k.id))) {
    wrap.appendChild(h('div.tiny', { style: { color: 'var(--warn)', marginTop: '2px' } },
      '这一回合的行动经济已经用完，点「下一回合 →」把主动权交给下一位。'));
  }

  wrap.appendChild(h('div.row', { style: { marginTop: '9px' } },
    h('button.btn.sm.ghost', {
      title: '把当前行动者的行动经济清空（记错了可以重来）',
      onclick: () => {
        app.updateCombat((c) => {
          c.used = { ...(c.used || {}) };
          delete c.used[actor.id];
        });
        toast(`${actor.name} 的行动经济已重置`);
      },
    }, '重置行动经济'),
  ));

  return wrap;
}

/** 结算一个行动：掷判定 → 命中则掷伤害 → 记日志（必要时扣血） */
function resolveActorAction(app, actor, action, targetId, list) {
  const rs = app.ruleset();
  const target = list.find(c => c.id === targetId) || null;
  const data = combatantData(app, actor);

  const rng = app.freshRng();
  const a = normalizeActions([action])[0];

  // 把目标的防御值接到判定上：DND 用 DC，其余系统用难度
  const req = { ...a.check };
  if (target && target.defense != null) {
    if (rs.id === 'dnd5e') req.dc = target.defense;
    else req.difficulty = target.defense;
  }

  let res;
  try {
    res = resolveAction(rs, data || {}, { ...a, check: req }, rng);
  } catch (err) {
    toast(`结算失败：${err.message}`, true);
    return;
  }

  const targetText = target && a.target !== 'self' && a.target !== 'none' ? ` → ${target.name}` : '';
  const kindLabel = kindsFor(rs.id).find(k => k.id === (a.kind || 'action'))?.label || a.kind;
  const detail = [
    target ? `目标：${target.name}（${target.defenseLabel} ${target.defense ?? '—'}）` : '',
    `行动经济：${kindLabel}`,
    a.note,
    describeActionResult(res),
    describeCost(a.cost) ? `消耗：${describeCost(a.cost)}` : '',
  ].filter(Boolean).join('\n');

  app.addEvent({
    type: 'combat',
    actor: actor.refId || null,
    actorName: actor.kind === 'pc' ? actor.name : null,
    title: `${actor.name} 使用【${a.name}】${targetText}`,
    detail,
    seed: res.seed,
    data: { kind: 'action', action: a, result: res.check, damage: res.damage },
  });

  // 命中且掷出伤害就顺带扣血
  if (target && res.damage?.ok && res.check?.success !== false) {
    applyHp(app, target, -res.damage.total, '受到伤害');
    toast(`${a.name} 命中 ${target.name}，伤害 ${res.damage.total}`);
  } else if (res.check?.success === false) {
    toast(`${a.name} 未命中`, true);
  } else if (res.damage?.ok) {
    toast(`${a.name}：伤害 ${res.damage.total}`);
  }

  // 记下这一类行动经济已经用掉，界面上随即置灰
  app.updateCombat((c) => { c.used = markKindUsed(c.used, actor.id, a.kind || 'action'); });
}

/* ────────────────────────── 添加参战者 ────────────────────────── */

function setupCard(app, combat) {
  const rs = app.ruleset();
  const inCombat = new Set(combat.combatants.map(c => c.refId).filter(Boolean));
  const available = app.state.characters.filter(c => !inCombat.has(c.id));

  const pcButtons = available.map(c =>
    h('button.target', {
      onclick: () => {
        const crs = getRuleset(c.system || app.state.campaign.system);
        const cb = combatantFromCharacter(crs, c);
        app.updateCombat((x) => { x.combatants.push(cb); });
        app.addEvent({
          type: 'combat', actor: c.id, actorName: c.name,
          title: `加入战斗：${c.name}`,
          detail: `生命 ${cb.hp}/${cb.maxHp} · ${cb.defenseLabel} ${cb.defense ?? '—'}`,
        });

        // 角色卡上还没声明行动就自动补上该系统的常用预设：
        // 战斗里只能按已声明的行动结算，轮到一张空卡就只能干瞪眼
        const presets = crs.actionPresets || [];
        if (!normalizeActions(c.data.actions).length && presets.length) {
          c.data.actions = presets.map(actionFromPreset);
          app.persistCharacter(c);
          toast(`${c.name} 还没有声明行动，已自动补上 ${crs.short} 的 ${presets.length} 个常用预设`);
        }
      },
    }, h('span', {}, c.name), h('span.tv', {}, `${c.system || app.state.campaign.system}`)));

  const nameInput = h('input.input', { placeholder: '杂兵 / NPC 名称，例如「哥布林 A」' });
  const hpInput = h('input.input.mono', { type: 'number', value: 10, style: { width: '84px' }, title: '生命上限' });
  const acInput = h('input.input.mono', { type: 'number', value: 12, style: { width: '84px' }, title: '防御值' });

  /* NPC 的行动：从预设里挑，加进待添加列表 */
  const presets = rs.actionPresets || [];
  const pending = [];
  const pendingBox = h('div.row.wrap', { style: { gap: '4px', marginTop: '5px' } });

  const pendingHint = h('div.tiny', { style: { marginTop: '4px' } });
  const redrawPending = () => {
    render(pendingBox, ...pending.map((p, i) => h('span.chip', {
      style: { cursor: 'pointer' },
      title: '点击移除',
      onclick: () => { pending.splice(i, 1); redrawPending(); },
    }, `${p.name} ✕`)));

    // 默认就让每个 NPC 都带上行动：战斗里只能按行动结算，没行动的参战者轮到了也白转
    if (pending.length) {
      pendingHint.textContent = `将只带上上面这 ${pending.length} 个行动`;
      pendingHint.style.color = 'var(--text-dim)';
    } else if (presets.length) {
      pendingHint.textContent = `没挑就默认带上「${rs.short}」的全部 ${presets.length} 个常用预设`;
      pendingHint.style.color = 'var(--muted)';
    } else {
      pendingHint.textContent = '';
    }
  };

  const presetSel = h('select.select', {
    style: { flex: '1', minWidth: '160px' },
    onchange: (e) => {
      const p = presets.find(x => x.name === e.target.value);
      if (!p) return;
      pending.push(p);
      redrawPending();
      e.target.value = '';
    },
  }, [
    h('option', { value: '' }, `＋ 选择行动（${presets.length} 个预设）…`),
    ...presets.map(p => h('option', { value: p.name }, `${p.name}${p.damage ? `（${p.damage}）` : ''}`)),
  ]);

  const addNpc = () => {
    const name = nameInput.value.trim() || `无名者 ${combat.combatants.length + 1}`;
    // 传规则集进去，NPC 才会带上可用于判定的精简数据
    const cb = blankCombatant(name, rs);
    cb.maxHp = Number(hpInput.value) || 10;
    cb.hp = cb.maxHp;
    cb.defense = Number(acInput.value) || 12;
    cb.defenseLabel = rs.id === 'dnd5e' ? 'AC' : rs.id === 'coc7' ? '—' : '闪避';
    // 手挑了就用手挑的，没挑就铺上该系统的全部预设
    cb.actions = (pending.length ? pending : presets).map(actionFromPreset);
    if (cb.data) {
      if (cb.data.combat) { cb.data.combat.hpMax = cb.maxHp; cb.data.combat.hp = cb.hp; }
      if (cb.data.attributes) { /* COC 的属性走默认值，可在角色卡页细化 */ }
      cb.data.actions = cb.actions;
    }

    app.updateCombat((x) => { x.combatants.push(cb); });
    app.addEvent({
      type: 'combat',
      title: `加入战斗：${cb.name}`,
      detail: [
        `生命 ${cb.hp}/${cb.maxHp} · ${cb.defenseLabel} ${cb.defense}`,
        cb.actions.length ? `行动：${cb.actions.map(a => a.name).join('、')}` : '未指定行动（战斗中无法结算）',
      ].join('\n'),
    });
    nameInput.value = '';
    pending.length = 0;
    redrawPending();
    nameInput.focus();
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addNpc(); });
  redrawPending();

  return h('div.card', {},
    h('h3', {}, '添加参战者'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div.target-group', {},
        h('div.tg-title', {}, '从角色卡加入'),
        pcButtons.length
          ? h('div.target-items', {}, pcButtons)
          : h('div.tiny.muted', {}, '所有角色都已在战斗中'),
        h('div.tiny.muted', { style: { marginTop: '5px', lineHeight: 1.7 } },
          '角色卡上还没声明行动的，加入时会自动补上该系统的常用预设 —— 战斗里只能按行动结算。'),
      ),
      h('div.target-group', {},
        h('div.tg-title', {}, '手动添加 NPC'),
        h('div.row.wrap', {}, nameInput, hpInput, acInput,
          h('button.btn', { onclick: addNpc }, '＋ 添加')),
        h('div.row.wrap', { style: { marginTop: '6px' } }, presetSel),
        pendingBox,
        pendingHint,
        h('div.tiny.muted', { style: { marginTop: '5px', lineHeight: 1.7 } },
          '给 NPC 指定行动后，战斗中轮到它时才能结算；没指定行动就只能记生命与状态。'
          + 'NPC 的判定数值取自规则集的默认值，需要精确数值可以之后在角色卡里细化。'),
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
    'data-combatant': cb.id,
    'data-current': isCurrent ? '1' : '0',
    'data-defeated': cb.defeated ? '1' : '0',
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

          // 倒下的正好是当前行动者：把回合交给下一个还站着的人，
          // 免得所有人都打完了还得在尸体上按一次「下一回合」
          if (next) handOffIfDowned(app, cb);
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
  const wasHp = app.state.combat.combatants.find(x => x.id === cb.id)?.hp ?? 0;
  app.updateCombat((c) => {
    const t = c.combatants.find(x => x.id === cb.id);
    if (!t) return;
    t.hp = Math.max(0, Math.min(t.maxHp, t.hp + delta));
    if (t.hp === 0) t.defeated = true;
  });
  const justDown = wasHp > 0 && (app.state.combat.combatants.find(x => x.id === cb.id)?.hp ?? 0) === 0;

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

  // 刚被打倒的正好是当前行动者：把回合交出去，别让所有人对着尸体按「下一回合」
  if (justDown) handOffIfDowned(app, cb);
}

/**
 * 当前行动者倒下后，把回合交给下一个还站着的人。
 * 手动点「倒地」和扣血扣到 0 都会走到这里。
 */
function handOffIfDowned(app, cb) {
  if (!app.state.combat.active) return;
  const list = sortedCombatants(app.state.combat);
  if (list[app.state.combat.turnIndex]?.id !== cb.id) return;

  const step = stepTurnIndex(list, app.state.combat.turnIndex, 1);
  if (!step) {
    toast('所有参战者都已倒地', true);
    return;
  }
  const round = Math.max(1, app.state.combat.round + step.roundDelta);
  const advancedRound = round !== app.state.combat.round;
  const incoming = list[step.index];
  app.updateCombat((c) => {
    c.round = round;
    c.turnIndex = step.index;
    c.used = refreshUsage(c.used || {}, incoming?.id ?? null, advancedRound);
  });
  toast(`${cb.name} 已倒地，回合交给 ${incoming?.name || '下一位'}`);
}

function stepTurn(app, dir) {
  const combat = app.state.combat;
  const list = sortedCombatants(combat);
  if (!list.length) return;

  const step = stepTurnIndex(list, combat.turnIndex, dir);
  if (!step) {
    toast('所有参战者都已倒地，回合不再推进', true);
    return;
  }

  const round = Math.max(1, combat.round + step.roundDelta);
  const rolledRound = round !== combat.round;
  const incoming = list[step.index];

  // 轮到谁谁拿回「每回合」的行动经济；进了新一轮则所有人都拿回反应
  app.updateCombat((c) => {
    c.round = round;
    c.turnIndex = step.index;
    c.used = refreshUsage(c.used || {}, incoming?.id ?? null, rolledRound);
  });

  if (step.skipped) {
    toast(`跳过 ${step.skipped} 名已倒地的参战者`);
  }

  if (rolledRound && dir > 0) {
    app.addEvent({
      type: 'combat',
      title: `进入第 ${round} 回合`,
      detail: sortedCombatants(app.state.combat)
        .map(c => `${c.name} ${c.hp}/${c.maxHp}${c.defeated ? '（倒地）' : ''}`).join('\n'),
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
