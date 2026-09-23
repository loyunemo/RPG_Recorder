/** 角色卡面板：按当前战役的规则系统渲染对应的卡面。 */

import { h, render, numInput, textInput, toast, confirmDialog } from '../util.js';
import { setTrackValue } from '../characterOps.js';
import { platform } from '../platform.js';
import {
  blankAction, actionFromPreset, normalizeActions,
  kindsFor, describeCost, ACTION_TARGETS,
} from '../../core/actions.js';

export function renderSheetView(root, app) {
  const char = app.selectedCharacter();

  if (!char) {
    render(root, h('div.empty', {},
      h('div.big', {}, '📋'),
      '还没有选中角色',
      h('br'),
      platform.isGm
        ? h('button.btn.primary.sm', { style: { marginTop: '10px' }, onclick: () => app.newCharacterFlow() }, '创建角色卡')
        : h('span.tiny', {}, '请让主持人先建好角色卡，或从左侧认领一张'),
    ));
    return;
  }

  const rs = app.ruleset();
  const editable = app.canEditCharacter(char.id);

  const container = h('div');
  render(root, container);

  // 不是自己的角色卡：只读。用 pointer-events 挡住交互，比逐个输入框禁用更不容易漏。
  const body = h('div', editable ? {} : { style: { pointerEvents: 'none', opacity: '.72' } });

  if (!editable) {
    container.appendChild(h('div.card', {
      style: { borderColor: 'var(--warn)', background: '#2b2416', padding: '10px 13px' },
    },
      h('div', { style: { fontWeight: 600, color: 'var(--warn)' } }, '👁 只读'),
      h('div.tiny.muted', { style: { marginTop: '3px' } },
        `「${char.name}」归其他玩家所有，你可以查看，但改动不会保存。`),
    ));
  }

  // 规则校验：只提示，不阻止保存 —— 主持人随时可以裁定偏离规则。
  // 注意必须先 append 到 container，再 append body —— 此时 body 还不是 container 的子节点，
  // 用 insertBefore(panel, body) 会抛 NotFoundError。
  if (editable && rs.creation?.validate) {
    const res = rs.creation.validate(char.data);
    if (res.errors.length || res.warnings.length) {
      container.appendChild(ruleCheckPanel(res));
    }
  }

  body.appendChild(sheetHeader(app, char, rs, editable));

  if (rs.id === 'coc7') renderCoc7(body, app, char);
  else if (rs.id === 'dnd5e') renderDnd5e(body, app, char);
  else if (rs.id === 'huazhu') renderHuazhu(body, app, char, rs);
  else renderDaggerheart(body, app, char);

  body.appendChild(notesCard(app, char));
  body.appendChild(actionsCard(app, char, rs));
  container.appendChild(body);
  return container;
}

/**
 * 对照车卡规则的校验结果面板。
 * 这里只「提示」不「阻止」：角色卡页是自由编辑区，
 * 主持人有权裁定偏离规则的角色（房规、剧情、临时 NPC 都需要）。
 */
function ruleCheckPanel(res, onFix) {
  const box = h('div.card', {
    style: {
      marginBottom: '12px',
      borderColor: res.errors.length ? '#6b3f3f' : '#6b5a2f',
      background: res.errors.length ? '#241a1a' : '#2b2416',
    },
  },
    h('h3', { style: { marginBottom: '8px' } },
      res.errors.length ? '⚠ 偏离车卡规则' : 'ⓘ 与车卡规则略有出入',
      h('div.spacer'),
      h('span.tiny.muted', { style: { textTransform: 'none', letterSpacing: 0 } },
        '仅提示，不影响保存'),
    ),
  );

  for (const e of res.errors) {
    box.appendChild(h('div.tiny', { style: { color: '#f0b6b2', lineHeight: 1.8 } }, `· ${e.message}`));
  }
  for (const w of res.warnings) {
    box.appendChild(h('div.tiny', { style: { color: '#e3cf9a', lineHeight: 1.8 } }, `· ${w.message}`));
  }

  if (res.errors.length) {
    box.appendChild(h('div', { style: { marginTop: '10px' } },
      h('span.tiny.muted', {},
        '这些是「按规则车卡」时的约束。若你是刻意如此（房规、NPC、剧情需要），忽略即可。')));
  }

  return box;
}

/**
 * 行动面板。
 *
 * 战斗轮到这个角色时，只能从这组行动里挑一个来结算 ——
 * 所以这里既是编辑器，也是战斗中那个「行动条」的数据来源。
 */
function actionsCard(app, char, rs) {
  const list = normalizeActions(char.data.actions);
  const kinds = kindsFor(rs.id);

  /* 可选判定目标，做成下拉方便指到具体技能 */
  const targetOptions = (() => {
    const groups = rs.rollTargets ? rs.rollTargets(char.data) : [];
    const out = [{ value: '', label: '（不判定）' }];
    for (const g of groups) {
      for (const it of g.items) {
        out.push({ value: it.key, label: `${g.title}｜${it.label}`, value_: it });
      }
    }
    return out;
  })();

  const commit = (mutate) => app.saveCharacterNow((data) => {
    data.actions = normalizeActions(data.actions);
    mutate(data.actions);
  });

  /* 已声明的行动 */
  const rows = list.map((act, i) => {
    const kind = kinds.find(k => k.id === act.kind);
    const checkLabel = act.check?.targetLabel
      || targetOptions.find(o => o.value === act.check?.targetKey)?.label?.split('｜')[1]
      || '';

    return h('div', {
      style: {
        background: 'var(--bg-2)', border: '1px solid var(--border-soft)',
        borderRadius: 'var(--radius)', padding: '9px 11px', marginBottom: '6px',
      },
    },
      h('div.row.wrap', { style: { gap: '7px', alignItems: 'center' } },
        h('span', { style: { fontWeight: 600, fontSize: '13px' } }, act.name),
        h('span.badge', {}, kind?.label || act.kind),
        h('span.tiny.muted', {},
          [checkLabel, act.damage ? `伤害 ${act.damage}` : '', describeCost(act.cost) ? `消耗 ${describeCost(act.cost)}` : '']
            .filter(Boolean).join(' · ') || '无判定'),
        h('div.spacer'),
        h('button.btn.sm.ghost', {
          title: '删除这个行动',
          onclick: () => commit(a => { a.splice(i, 1); }),
        }, '✕'),
      ),

      /* 展开的编辑区 */
      h('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div.row.wrap', { style: { gap: '6px' } },
          h('input.input', {
            value: act.name, placeholder: '行动名', style: { flex: '1', minWidth: '120px' },
            onchange: (e) => commit(a => { a[i].name = e.target.value; }),
          }),
          h('select.select', {
            style: { width: '118px' },
            onchange: (e) => commit(a => { a[i].kind = e.target.value; }),
          }, kinds.map(k => h('option', { value: k.id, selected: act.kind === k.id }, k.label))),
          h('select.select', {
            style: { width: '118px' },
            onchange: (e) => commit(a => { a[i].target = e.target.value; }),
          }, ACTION_TARGETS.map(t => h('option', { value: t.id, selected: act.target === t.id }, t.label))),
        ),

        h('div.row.wrap', { style: { gap: '6px' } },
          h('span.tiny.dim', { style: { width: '54px', alignSelf: 'center' } }, '判定目标'),
          h('select.select', {
            style: { flex: '1', minWidth: '150px' },
            onchange: (e) => commit(a => {
              const picked = targetOptions.find(o => o.value === e.target.value);
              a[i].check = picked && picked.value_
                ? { targetKey: picked.value, targetLabel: picked.value_.label }
                : {};
            }),
          }, targetOptions.map(o => h('option', {
            value: o.value, selected: (act.check?.targetKey || '') === o.value,
          }, o.label))),
        ),

        h('div.row.wrap', { style: { gap: '6px' } },
          h('span.tiny.dim', { style: { width: '54px', alignSelf: 'center' } }, '伤害骰'),
          h('input.input.mono', {
            value: act.damage, placeholder: '留空则不掷伤害，例如 1d8+3',
            style: { flex: '1', minWidth: '140px' },
            onchange: (e) => commit(a => { a[i].damage = e.target.value.trim(); }),
          }),
        ),

        h('div.row.wrap', { style: { gap: '6px' } },
          h('span.tiny.dim', { style: { width: '54px', alignSelf: 'center' } }, '备注'),
          h('input.input', {
            value: act.note, placeholder: '效果说明（会写进日志）',
            style: { flex: '1', minWidth: '160px' },
            onchange: (e) => commit(a => { a[i].note = e.target.value; }),
          }),
        ),
      ),
    );
  });

  /* 预设挑选 */
  const presets = rs.actionPresets || [];
  const presetInfo = h('div.tiny.muted', { style: { marginTop: '6px' } });

  const picker = h('select.select', {
    style: { flex: '1', minWidth: '170px' },
    onchange: (e) => {
      const p = presets.find(x => x.name === e.target.value);
      if (!p) return;
      commit(a => { a.push(actionFromPreset(p)); });
      e.target.value = '';
    },
  }, [
    h('option', { value: '' }, `＋ 从预设添加（${presets.length} 个）…`),
    ...presets.map(p => h('option', { value: p.name }, `${p.name}${p.damage ? `（${p.damage}）` : ''}`)),
  ]);

  return card(`行动（${list.length}）`,
    h('div.tiny.muted', { style: { marginBottom: '9px', lineHeight: 1.8 } },
      '战斗中轮到这名角色时，只能从下面这些行动里挑一个来结算。'),
    ...rows,
    list.length ? null : h('div.tiny.muted', { style: { marginBottom: '8px' } }, '还没有声明任何行动。'),
    h('div.row.wrap', {},
      picker,
      h('button.btn.sm', {
        onclick: () => {
          commit(a => { a.push(blankAction({ name: '新行动' })); });
          presetInfo.textContent = '已添加空白行动，请填写判定目标与伤害骰';
        },
      }, '＋ 自定义行动'),
      h('button.btn.sm.ghost', {
        title: '把该系统的常用行动一次全加上',
        onclick: async () => {
          const ok = await confirmDialog('添加全部预设',
            `将把「${rs.short}」的 ${presets.length} 个常用行动全部加进来，之后可以逐个删改。`, '全部添加');
          if (!ok) return;
          commit(a => { for (const p of presets) a.push(actionFromPreset(p)); });
        },
      }, '全部预设'),
    ),
    presetInfo,
  );
}

/* ────────────────────────── 华渚（匕首之心扩展） ────────────────────────── */
/**
 * 判定与资源机制与匕首之心完全一致，因此卡面直接复用；
 * 这里额外挂上华渚特有的法门 / 宗门 / 位阶 / 道心 / 声望 / 九玄技 / 领域卡。
 */
function renderHuazhu(root, app, char, rs) {
  renderDaggerheart(root, app, char);

  const d = char.data;
  const cls = rs.classes.find(c => c.name === d.className);
  const subs = rs.subclassesOf(d.className);

  const classSel = h('select.select', {
    onchange: (e) => app.saveCharacterNow((data) => {
      const next = rs.classes.find(c => c.name === e.target.value);
      data.className = e.target.value;
      if (next) {
        data.evasionBase = next.evasion;
        data.hpMax = next.hp;
        data.domain = next.domain;
        data.subclass = next.subclasses?.[0]?.name || '';
        data.sectNature = next.subclasses?.[0]?.sectNature || '';
        data.spellcastTrait = next.subclasses?.[0]?.spellcastTrait || '';
      }
    }),
  }, rs.classes.map(c => h('option', { value: c.name, selected: d.className === c.name },
    `${c.name}（${c.domain} · 闪避 ${c.evasion} / 生命 ${c.hp}）`)));

  const subSel = h('select.select', {
    disabled: !subs.length,
    onchange: (e) => app.saveCharacterNow((data) => {
      const s = subs.find(x => x.name === e.target.value);
      data.subclass = e.target.value;
      if (s) {
        data.sectNature = s.sectNature || '';
        data.spellcastTrait = s.spellcastTrait || '';
      }
    }),
  }, subs.map(s => h('option', { value: s.name, selected: d.subclass === s.name }, s.name)));

  const sub = subs.find(s => s.name === d.subclass);
  const subDetail = sub ? h('div', {
    style: { marginTop: '9px', display: 'flex', flexDirection: 'column', gap: '5px' },
  },
    h('div.row.wrap', { style: { gap: '6px' } },
      h('span.badge', {}, sub.sectNature || '性质未标注'),
      h('span.badge', {}, `施法属性 ${sub.spellcastTrait || '—'}`),
      h('span.badge', {}, `额外领域 ${sub.domain || '—'}`),
    ),
    sub.startingItems ? h('div.tiny.muted', {}, `初始物品：${sub.startingItems}`) : null,
    sub.description ? h('div.tiny.dim', { style: { lineHeight: 1.7 } }, sub.description) : null,
    ...tieredFeatures(sub.features),
  ) : null;

  root.appendChild(card('法门与宗门',
    h('div.kv-list', {},
      kv('法门', classSel),
      kv('宗门流派', subSel),
      kv('领域', h('span.mono', {}, d.domain || cls?.domain || '—')),
    ),
    subDetail,
  ));

  /* 位阶 / 声望 / 道心 */
  const tier = rs.tierFor(d.level);
  root.appendChild(card('华渚机制',
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div.kv-row', {}, h('span.k', {}, '位阶'),
        h('span.mono', { style: { fontWeight: 700 } }, `${tier}（Lv${d.level}）`)),

      h('div.kv-row', {}, h('span.k', {}, '华渚声望'),
        numInput(d.reputation ?? 0, (v) => app.saveCharacter((data) => { data.reputation = v; }), { style: { width: '80px' } }),
        h('span.badge', {}, rs.reputationBand(d.reputation ?? 0)),
      ),

      h('div.kv-row', {}, h('span.k', {}, '道心经历'),
        h('input.input', {
          value: d.daoHeart?.name || '', placeholder: '道心之名',
          onchange: (e) => app.saveCharacter((data) => { data.daoHeart.name = e.target.value; }),
        }),
        numInput(d.daoHeart?.mod ?? -2, (v) => app.saveCharacter((data) => { data.daoHeart.mod = v; }), { style: { width: '66px' } }),
        h('button.btn.sm.roll', {
          title: '用道心经历掷骰',
          onclick: () => {
            const dh = app.selectedCharacter()?.data.daoHeart;
            if (dh?.name) app.performCheck({ targetLabel: `道心：${dh.name}`, targetValue: dh.mod ?? -2 });
          },
        }, '🎲'),
      ),
      h('div.tiny.muted', {},
        '原文给道心经历的数值是 −2，且注明「无需花费希望点便可直接使用」。'
        + '若读作笔误（应为 +2），直接改上面的数字即可。'),
    ),
  ));

  root.appendChild(nineMysteriesCard(app, char, rs));
  root.appendChild(domainCardsCard(app, char, rs));
}

/** 把特性按基石 / 专精 / 大师分档展示 */
function tieredFeatures(features) {
  const ORDER = ['基石特性', '专精特性', '大师特性'];
  const out = [];
  const block = (list, label) => h('div', { style: { marginTop: '7px' } },
    label ? h('div.tiny', { style: { color: 'var(--accent)', marginBottom: '3px' } }, label) : null,
    ...list.map(f => h('div', { style: { marginBottom: '4px' } },
      h('span', { style: { fontWeight: 600, fontSize: '12.5px' } }, `【${f.name}】`),
      h('span.tiny.dim', { style: { lineHeight: 1.7 } }, ` ${f.text}`),
    )),
  );
  for (const tierName of ORDER) {
    const list = (features || []).filter(f => f.tier === tierName);
    if (list.length) out.push(block(list, tierName));
  }
  const untiered = (features || []).filter(f => !ORDER.includes(f.tier));
  if (untiered.length) out.push(block(untiered, ''));
  return out;
}

function nineMysteriesCard(app, char, rs) {
  const d = char.data;
  const learned = new Set(d.nineMysteries || []);
  const list = rs.mechanics.nineMysteries || [];

  const rows = list.map(m => {
    const on = learned.has(m.name);
    return h('div', {
      style: {
        background: on ? 'var(--bg-3)' : 'var(--bg-2)',
        border: `1px solid ${on ? 'var(--accent-dim)' : 'var(--border-soft)'}`,
        borderRadius: 'var(--radius)', padding: '8px 10px', cursor: 'pointer',
      },
      onclick: () => app.saveCharacterNow((data) => {
        const arr = data.nineMysteries || [];
        data.nineMysteries = arr.includes(m.name) ? arr.filter(x => x !== m.name) : [...arr, m.name];
      }),
    },
      h('div', { style: { fontWeight: 600, fontSize: '13px' } }, on ? '✦ ' : '○ ', m.name),
      m.text ? h('div.tiny.dim', { style: { marginTop: '3px', lineHeight: 1.7 } }, m.text) : null,
    );
  });

  return card(`九玄技（已悟 ${learned.size} / ${list.length}）`,
    h('div.tiny.muted', { style: { marginBottom: '8px' } }, '点击卡片切换是否已领悟'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, rows),
  );
}

function domainCardsCard(app, char, rs) {
  const d = char.data;
  const owned = d.domainCards || [];

  const cls = rs.classes.find(c => c.name === d.className);
  const sub = (cls?.subclasses || []).find(s => s.name === d.subclass);

  // 优先用规则集自己给出的「可用领域」——华渚是法门+宗门，匕首心是职业的两个领域
  const usable = rs.creation?.usableDomains
    ? rs.creation.usableDomains(d)
    : [].concat(cls?.domains || cls?.domain || [], sub?.domain || []);

  const domainByName = new Map(rs.domains.map(x => [x.name, x]));

  const picker = h('select.select', {
    onchange: (e) => {
      const cardName = e.target.value;
      if (!cardName) return;
      const c = rs.domainCards.find(x => x.name === cardName);
      if (!c) return;
      const dom = rs.domains.find(x => x.id === c.domain);
      app.saveCharacterNow((data) => {
        data.domainCards = [...(data.domainCards || []), {
          name: c.name, domain: dom?.name || c.domain, level: c.level, text: c.text,
        }];
      });
      e.target.value = '';
    },
  }, [
    h('option', { value: '' }, '＋ 添加领域卡…'),
    ...usable.flatMap(name => {
      const dom = domainByName.get(name);
      if (!dom) return [];
      return [h('optgroup', { label: `${dom.name}（${dom.path || '领域'}）` },
        rs.domainCards
          .filter(c => c.domain === dom.id)
          .sort((a, b) => (a.level ?? 99) - (b.level ?? 99))
          .map(c => h('option', { value: c.name }, `Lv${c.level ?? '?'} ${c.name}`)))];
    }),
  ]);

  const need = 2 + Math.max(0, (d.level || 1) - 1);

  return card(`领域卡（${owned.length} / ${need}）`,
    h('div.tiny.muted', { style: { marginBottom: '8px' } },
      usable.length ? `可用领域：${usable.join(' / ')}` : '先选好职业才能看到可选领域卡'),
    h('div', { style: { marginBottom: '9px' } }, picker),
    owned.length
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        ...owned.map((c, i) => h('div', {
          style: {
            background: 'var(--bg-2)', border: '1px solid var(--border-soft)',
            borderRadius: 'var(--radius)', padding: '8px 10px',
          },
        },
          h('div.row', {},
            h('span', { style: { fontWeight: 600, fontSize: '13px' } }, c.name),
            h('span.badge', { style: { marginLeft: '7px' } }, c.domain || ''),
            c.level != null ? h('span.badge', { style: { marginLeft: '4px' } }, `Lv${c.level}`) : null,
            h('div.spacer'),
            h('button.btn.sm.ghost', {
              onclick: () => app.saveCharacterNow((data) => { data.domainCards.splice(i, 1); }),
            }, '✕'),
          ),
          c.text ? h('div.tiny.dim', { style: { marginTop: '4px', lineHeight: 1.7 } }, c.text) : null,
        )),
      )
      : h('div.tiny.muted', {}, '还没有领域卡。从上方选择添加。'),
  );
}

/**
 * 血统与社群的特性。
 * 这两项在匕首心里各给一条固定特性，车卡时必须看得到具体效果。
 */
function traitsCard(app, char, rs) {
  const d = char.data;
  const anc = (rs.ancestries || []).find(a => a.name === d.ancestry);
  const com = (rs.communities || []).find(c => c.name === d.community);

  if (!anc && !com) return h('div');

  const block = (title, subtitle, items) => h('div', { style: { marginBottom: '12px' } },
    h('div', { style: { fontWeight: 600, fontSize: '13.5px', marginBottom: '2px' } }, title),
    subtitle ? h('div.tiny.muted', { style: { marginBottom: '7px', lineHeight: 1.7 } }, subtitle) : null,
    ...items.map(f => h('div', {
      style: {
        background: 'var(--bg-2)', border: '1px solid var(--border-soft)',
        borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: '5px',
      },
    },
      h('div', { style: { fontWeight: 600, fontSize: '12.5px', color: 'var(--accent)' } }, f.name),
      h('div.tiny.dim', { style: { marginTop: '3px', lineHeight: 1.8 } }, f.text),
    )),
  );

  return card('血统与社群特性',
    anc ? block(`血统 · ${anc.name}`, anc.description, anc.traits) : null,
    com ? block(`社群 · ${com.name}`, com.description, [com.feature]) : null,
  );
}

/* ────────────────────────── 公共部件 ────────────────────────── */

function sheetHeader(app, char, rs) {
  const d = rs.derive(char.data);

  // 角色名存在角色对象上（而非 data 上），需单独处理
  const nameInput = h('input.inline-edit', {
    value: char.name,
    style: { fontSize: '21px', fontWeight: '700', width: '240px' },
    onchange: async (e) => {
      char.name = e.target.value;
      await app.saveCharacterNow(() => {});
      app.renderAll();
    },
  });

  const tracks = h('div.tracks');
  if (rs.id === 'daggerheart') {
    // 匕首心用打勾格管理资源，卡面下方已有交互式格子，这里只做一行速览避免重复
    tracks.appendChild(h('div.row.wrap', { style: { gap: '7px' } },
      ...d.tracks.map(t => h('span.chip', {
        style: { cursor: 'default' },
        title: t.label,
      }, `${t.label} ${t.current}/${t.max}`)),
    ));
  } else {
    for (const t of d.tracks) tracks.appendChild(trackRow(app, char, t));
  }

  return h('div.card', {},
    h('div.sheet-head', {},
      nameInput,
      h('span.badge.' + rs.id, {}, rs.short),
      h('div.spacer'),
      // 新建 / 删除都是主持人权限
      platform.isGm
        ? h('button.btn.sm', { onclick: () => app.newCharacterFlow() }, '＋ 新角色')
        : null,
      platform.isGm
        ? h('button.btn.sm.danger', {
          onclick: async () => {
            const ok = await confirmDialog('删除角色卡', `确定要删除「${char.name}」吗？此操作不可撤销（但日志会保留删除记录）。`, '删除');
            if (!ok) return;
            const { call } = await import('../platform.js');
            await call('deleteCharacter', { cid: app.state.campaign.id, id: char.id });
            await app.reloadCharacters();
            await app.reloadEvents();
            app.state.selectedCharacterId = app.state.characters[0]?.id || null;
            app.renderAll();
            toast('已删除');
          },
        }, '删除')
        : null,
    ),
    tracks,
  );
}

function trackRow(app, char, t) {
  const pct = t.max > 0 ? Math.max(0, Math.min(100, (t.current / t.max) * 100)) : 0;
  const bar = h('div.bar', { 'data-track': t.key },
    h('div.fill.tone-' + t.tone, { style: { width: pct + '%' } }),
    h('div.txt', {}, `${t.current} / ${t.max}`),
  );

  const setVal = async (delta) => {
    await app.saveCharacterNow((data) => {
      const d = app.ruleset().derive(data);
      const cur = d.tracks.find(x => x.key === t.key);
      const next = Math.max(0, cur.current + delta);
      setTrackValue(data, t.key, next);
    }, { skipSheetRefresh: false });
  };

  return h('div.track', {},
    h('span.tl', {}, t.label),
    bar,
    h('div.ctl', {},
      h('button', { onclick: () => setVal(-1), title: '−1' }, '−'),
      h('button', { onclick: () => setVal(-5), title: '−5' }, '−5'),
      h('button', { onclick: () => setVal(+5), title: '+5' }, '+5'),
      h('button', { onclick: () => setVal(+1), title: '+1' }, '＋'),
    ),
  );
}

function statGrid(items) {
  return h('div.stat-grid', {}, items.map(s =>
    h('div.stat-box', {},
      h('div.lb', {}, s.label),
      h('div.vl', { 'data-derived': s.key }, String(s.value)),
    )));
}

function card(title, ...children) {
  return h('div.card', {}, h('h3', {}, title), ...children);
}

function notesCard(app, char) {
  return card('备注',
    h('textarea.textarea', {
      value: char.data.notes || '',
      placeholder: '人物背景、随身物品、线索……',
      onchange: (e) => app.saveCharacter((data) => { data.notes = e.target.value; }),
    }),
  );
}

/* ────────────────────────── COC 7 版 ────────────────────────── */

function renderCoc7(root, app, char) {
  const rs = app.ruleset();
  const d = char.data;

  /* 属性 */
  const attrs = h('div.attr-grid', {}, rs.attributes.map(a =>
    h('div.attr-box', {},
      h('div.lb', {}, `${a.label} ${a.abbr}`),
      numInput(d.attributes[a.key], (v) => app.saveCharacter((data) => { data.attributes[a.key] = v; }), { min: 0, max: 999 }),
      h('div.hint', {}, `困难 ${Math.floor(d.attributes[a.key] / 2)} / 极难 ${Math.floor(d.attributes[a.key] / 5)}`),
    )));
  root.appendChild(card('属性', attrs));

  /* 派生值 */
  const dd = rs.derive(d);
  root.appendChild(card('派生数值 · 自动计算', statGrid(dd.stats)));

  /* 基本信息 */
  root.appendChild(card('调查员信息',
    h('div.kv-list', {},
      kv('职业', textInput(d.occupation, (v) => app.saveCharacter((x) => { x.occupation = v; }))),
      kv('年龄', numInput(d.age, (v) => app.saveCharacter((x) => { x.age = v; }), { min: 0, max: 120 })),
      kv('性别', textInput(d.gender, (v) => app.saveCharacter((x) => { x.gender = v; }))),
      kv('居住地', textInput(d.residence, (v) => app.saveCharacter((x) => { x.residence = v; }))),
      kv('出生地', textInput(d.birthPlace, (v) => app.saveCharacter((x) => { x.birthPlace = v; }))),
      h('div.tiny.muted', { style: { marginTop: '6px' } }, `年龄修正：${rs.ageModifier(d.age).note}`),
    ),
  ));

  /* 技能 */
  const skillWrap = h('div.skill-table');
  const entries = Object.entries(d.skills).sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'));
  for (const [name, val] of entries) {
    skillWrap.appendChild(cocSkillRow(app, char, name, val));
  }

  const addSkillBtn = h('button.btn.sm', {
    onclick: () => app.saveCharacterNow((data) => {
      let n = 1;
      while (data.skills[`新技能 ${n}`] != null) n++;
      data.skills[`新技能 ${n}`] = 20;
    }),
  }, '＋ 添加技能');

  root.appendChild(card('技能', skillWrap, h('div', { style: { marginTop: '10px' } }, addSkillBtn)));

  /* 武器 */
  root.appendChild(weaponsCard(app, char, [
    ['name', '名称'], ['damage', '伤害'], ['range', '射程'], ['note', '备注'],
  ], () => ({ name: '', damage: '', range: '', note: '' })));

  /* 背景 */
  const bgFields = [
    ['description', '外貌描述'], ['belief', '信念'],
    ['significantPeople', '重要之人'], ['meaningfulLocations', '意义非凡之地'],
    ['treasuredPossessions', '宝贵之物'], ['traits', '特质'],
    ['injuries', '伤痕与疤痕'], ['phobias', '恐惧症与躁狂症'],
    ['arcaneTomes', '魔法物品与典籍'],
  ];
  root.appendChild(card('背景',
    h('div.kv-list', {}, bgFields.map(([k, label]) =>
      kv(label, textInput(d.background[k], (v) => app.saveCharacter((data) => { data.background[k] = v; }))))),
  ));
}

function cocSkillRow(app, char, name, val) {
  const hard = Math.floor(val / 2);
  const extreme = Math.floor(val / 5);

  return h('div.skill-row', {},
    textInput(name, (newName) => {
      if (!newName || newName === name) return;
      app.saveCharacterNow((data) => {
        const v = data.skills[name];
        delete data.skills[name];
        data.skills[newName] = v;
      });
    }),
    h('span.grades', {}, `${hard}/${extreme}`),
    numInput(val, (v) => app.saveCharacterNow((data) => { data.skills[name] = v; }), { min: 0, max: 999, style: { width: '52px' } }),
    h('button.btn.sm.roll', {
      title: '投掷该技能',
      onclick: () => app.performCheck({
        targetKey: `skill:${name}`, targetLabel: name, targetValue: val,
        difficulty: 'regular', reason: '',
      }),
    }, '🎲'),
    h('button.btn.sm.ghost', {
      title: '删除技能',
      onclick: () => app.saveCharacterNow((data) => { delete data.skills[name]; }),
    }, '✕'),
  );
}

/* ────────────────────────── DND 5e ────────────────────────── */

function renderDnd5e(root, app, char) {
  const rs = app.ruleset();
  const d = char.data;
  const dd = rs.derive(d);

  /* 属性 */
  const attrs = h('div.attr-grid', {}, rs.abilities.map(a => {
    const mod = rs.abilityMod(d.abilities[a.key]);
    return h('div.attr-box', {},
      h('div.lb', {}, `${a.label} ${a.abbr}`),
      numInput(d.abilities[a.key], (v) => app.saveCharacter((data) => { data.abilities[a.key] = v; }), { min: 1, max: 40 }),
      h('div.hint', { style: { fontSize: '14px', fontWeight: 700 } }, mod >= 0 ? `+${mod}` : String(mod)),
    );
  }));
  root.appendChild(card('属性', attrs));

  root.appendChild(card('战斗数值 · 自动计算', statGrid(dd.stats)));

  /* 死亡豁免：生命值为 0 时每回合开始投掷 */
  const ds = d.combat.deathSuccess || 0;
  const df = d.combat.deathFail || 0;
  const down = (d.combat.hp ?? dd.hpMax) <= 0;
  const marks = (n, tone) => h('div.pips', {}, [0, 1, 2].map(i =>
    h('div.pip' + (i < n ? '.on' : ''), {
      style: i < n ? { background: tone, borderColor: tone, color: '#00000099' } : {},
      onclick: () => app.saveCharacterNow((data) => {
        if (tone === '#7a2f2c') data.combat.deathSuccess = i + 1 === n ? i : i + 1;
        else data.combat.deathFail = i + 1 === n ? i : i + 1;
      }),
    })));

  root.appendChild(card('死亡豁免',
    down
      ? h('div.tiny', { style: { color: 'var(--bad)', marginBottom: '8px', fontWeight: 600 } },
        '生命值为 0，昏迷中——每回合开始时投掷死亡豁免')
      : h('div.tiny.muted', { style: { marginBottom: '8px' } }, '生命值归零后每回合开始投掷'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      h('div.track', {}, h('span.tl', {}, '成功'), marks(ds, '#3f6b4f'),
        h('span.tiny.muted.mono', { style: { marginLeft: 'auto' } }, `${ds}/3`)),
      h('div.track', {}, h('span.tl', {}, '失败'), marks(df, '#7a2f2c'),
        h('span.tiny.muted.mono', { style: { marginLeft: 'auto' } }, `${df}/3`)),
      h('div.row', {},
        h('button.btn.primary', { onclick: () => app.rollDeathSave() }, '🎲 投掷死亡豁免'),
        h('button.btn.sm', {
          onclick: () => app.saveCharacterNow((data) => { data.combat.deathSuccess = 0; data.combat.deathFail = 0; }),
        }, '清除计数'),
        h('span.tiny.muted', {}, '天然 20 恢复 1 点生命；天然 1 记 2 次失败'),
      ),
    ),
  ));

  /* 基本信息 */
  root.appendChild(card('角色信息',
    h('div.kv-list', {},
      kv('玩家', textInput(d.player, (v) => app.saveCharacter((x) => { x.player = v; }))),
      kv('种族', textInput(d.race, (v) => app.saveCharacter((x) => { x.race = v; }))),
      kv('职业', textInput(d.className, (v) => app.saveCharacter((x) => { x.className = v; }))),
      kv('等级', numInput(d.level, (v) => app.saveCharacter((x) => { x.level = Math.max(1, Math.min(20, v)); }), { min: 1, max: 20 })),
      kv('背景', textInput(d.backgroundName, (v) => app.saveCharacter((x) => { x.backgroundName = v; }))),
      kv('阵营', textInput(d.alignment, (v) => app.saveCharacter((x) => { x.alignment = v; }))),
      kv('生命骰', textInput(d.combat.hitDice, (v) => app.saveCharacter((x) => { x.combat.hitDice = v; }))),
      kv('生命上限', numInput(d.combat.hpMax, (v) => app.saveCharacter((x) => { x.combat.hpMax = v; }), { min: 1 })),
      kv('护甲基础', numInput(d.combat.armorBase, (v) => app.saveCharacter((x) => { x.combat.armorBase = v; }), { min: 0 })),
      kv('盾牌加值', numInput(d.combat.shield, (v) => app.saveCharacter((x) => { x.combat.shield = v; }), {} )),
      kv('速度', numInput(d.combat.speed, (v) => app.saveCharacter((x) => { x.combat.speed = v; }), { min: 0 })),
    ),
  ));

  /* 豁免 */
  const saves = h('div.skill-table', {}, dd.saves.map(s =>
    h('div.skill-row', {},
      h('span', { style: { flex: 1, fontSize: '12.5px' } }, s.label),
      h('span.grades', {}, s.prof ? `含熟练 +${dd.prof}` : '—'),
      h('span.mono', { style: { fontWeight: 700, width: '32px', textAlign: 'right' } }, s.total >= 0 ? `+${s.total}` : String(s.total)),
      h('input', {
        type: 'checkbox', checked: s.prof > 0, title: '熟练',
        onchange: () => app.saveCharacterNow((data) => {
          const arr = data.proficiency.saves || [];
          data.proficiency.saves = arr.includes(s.key) ? arr.filter(x => x !== s.key) : [...arr, s.key];
        }),
      }),
      h('button.btn.sm.roll', {
        onclick: () => app.performCheck({ targetKey: `save:${s.key}`, targetLabel: s.label, dc: app.state.lastRoll?.dc ?? null }),
      }, '🎲'),
    )));
  root.appendChild(card('豁免检定', saves));

  /* 技能 */
  const skills = h('div.skill-table', {}, dd.skills.map(s =>
    h('div.skill-row', {},
      h('span', { style: { flex: 1, fontSize: '12.5px' } }, s.label),
      h('span.grades', {}, s.expertise ? '专精' : s.prof ? '熟练' : ''),
      h('span.mono', { style: { fontWeight: 700, width: '32px', textAlign: 'right' } }, s.total >= 0 ? `+${s.total}` : String(s.total)),
      h('input', {
        type: 'checkbox', checked: s.prof > 0, title: '熟练',
        onchange: () => app.saveCharacterNow((data) => {
          const arr = data.proficiency.skills || [];
          data.proficiency.skills = arr.includes(s.key) ? arr.filter(x => x !== s.key) : [...arr, s.key];
        }),
      }),
      h('input', {
        type: 'checkbox', checked: s.expertise > 0, title: '专精（熟练加值翻倍）',
        onchange: () => app.saveCharacterNow((data) => {
          const arr = data.proficiency.expertise || [];
          data.proficiency.expertise = arr.includes(s.key) ? arr.filter(x => x !== s.key) : [...arr, s.key];
        }),
      }),
      h('button.btn.sm.roll', {
        onclick: () => app.performCheck({ targetKey: `skill:${s.key}`, targetLabel: s.label, dc: app.state.lastRoll?.dc ?? null }),
      }, '🎲'),
    )));
  root.appendChild(card('技能检定',
    h('div.tiny.muted', { style: { marginBottom: '8px' } }, '左勾选框＝熟练，右勾选框＝专精'),
    skills));

  /* 法术位 */
  if (dd.spellSlots.length) {
    const slots = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } });
    for (const s of dd.spellSlots) {
      const pips = h('div.pips', {});
      for (let i = 0; i < s.max; i++) {
        pips.appendChild(h('div.pip' + (i < s.used ? '.on' : ''), {
          onclick: () => app.saveCharacterNow((data) => {
            const used = data.spell.slotsUsed?.[s.level] || 0;
            data.spell.slotsUsed = data.spell.slotsUsed || {};
            data.spell.slotsUsed[s.level] = (i + 1 === used) ? i : i + 1;
          }),
        }));
      }
      slots.appendChild(h('div.track', {}, h('span.tl', {}, `${s.level} 环`), pips,
        h('span.tiny.muted', {}, `${s.max - s.used}/${s.max}`)));
    }
    root.appendChild(card('法术位', h('div.kv-list', {},
      kv('施法属性', h('select.select', {
        onchange: (e) => app.saveCharacterNow((data) => { data.spell.ability = e.target.value; }),
      }, rs.abilities.map(a => h('option', { value: a.key, selected: d.spell.ability === a.key }, a.label)))),
    ), slots));
  }

  root.appendChild(weaponsCard(app, char, [['name', '名称'], ['damage', '伤害'], ['note', '备注']],
    () => ({ name: '', damage: '', note: '' })));

  root.appendChild(card('特性与专长',
    h('textarea.textarea', {
      value: d.features || '',
      onchange: (e) => app.saveCharacter((data) => { data.features = e.target.value; }),
    })));

  root.appendChild(card('装备',
    h('textarea.textarea', {
      value: d.gear || '',
      onchange: (e) => app.saveCharacter((data) => { data.gear = e.target.value; }),
    })));
}

/* ────────────────────────── 匕首心 ────────────────────────── */

function renderDaggerheart(root, app, char) {
  const rs = app.ruleset();
  const d = char.data;
  const dd = rs.derive(d);

  /* 打勾式资源 */
  const pipsCard = card('资源',
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '11px' } },
      pipRow('生命值', d.hpMax, d.hpMarked, '', (v) => app.saveCharacterNow((data) => { data.hpMarked = v; })),
      pipRow('压力', d.stressMax ?? 6, d.stressMarked ?? 0, 'stress', (v) => app.saveCharacterNow((data) => { data.stressMarked = v; })),
      pipRow('护甲槽', d.armorSlotsMax ?? 0, d.armorMarked ?? 0, 'armor', (v) => app.saveCharacterNow((data) => { data.armorMarked = v; })),
      counterRow('希望', d.hope ?? 0, 6, (v) => app.saveCharacterNow((data) => { data.hope = Math.max(0, Math.min(6, v)); }), 'var(--hope)'),
      counterRow('恐惧 (GM)', d.fear ?? 0, 12, (v) => app.saveCharacterNow((data) => { data.fear = Math.max(0, v); }), 'var(--fear)'),
    ));
  root.appendChild(pipsCard);

  /* 属性（匕首心的属性本身就是调整值，无需再显示一行提示） */
  const traits = h('div.attr-grid', {}, rs.traits.map(t =>
    h('div.attr-box', {},
      h('div.lb', {}, `${t.label} ${t.abbr}`),
      numInput(d.traits[t.key], (v) => app.saveCharacter((data) => { data.traits[t.key] = v; }), { min: -10, max: 10 }),
      h('div.hint', {}, '调整值'),
    )));
  root.appendChild(card('属性', traits));

  /* 派生 */
  root.appendChild(card('战斗数值', statGrid(dd.stats)));

  /* 角色信息 */
  root.appendChild(card('角色信息',
    h('div.kv-list', {},
      kv('代词', textInput(d.pronouns, (v) => app.saveCharacter((x) => { x.pronouns = v; }))),
      kv('职业', h('select.select', {
        onchange: (e) => app.saveCharacterNow((data) => {
          const cls = rs.classes.find(c => c.name === e.target.value);
          data.className = e.target.value;
          if (cls) {
            data.evasionBase = cls.evasion;
            data.hpMax = cls.hp;
            data.subclass = cls.subclasses?.[0]?.name || '';
          }
        }),
      }, rs.classes.map(c => {
        // 匕首心是 domains 数组，华渚是单个 domain —— 两者都要兼容
        const doms = c.domains || (c.domain ? [c.domain] : []);
        return h('option', { value: c.name, selected: d.className === c.name },
          `${c.name}（${doms.join('/')} · 闪避 ${c.evasion} / HP ${c.hp}）`);
      }))),
      kv('子职业', (() => {
        const subs = rs.subclassesOf ? rs.subclassesOf(d.className) : [];
        return subs.length
          ? h('select.select', {
            onchange: (e) => app.saveCharacterNow((data) => { data.subclass = e.target.value; }),
          }, subs.map(s => h('option', { value: s.name, selected: d.subclass === s.name }, s.name)))
          : textInput(d.subclass, (v) => app.saveCharacter((x) => { x.subclass = v; }));
      })()),
      kv('等级', numInput(d.level, (v) => app.saveCharacter((x) => { x.level = Math.max(1, Math.min(10, v)); }), { min: 1, max: 10 })),
      kv('血统', (() => {
        const list = rs.ancestries || [];
        return list.length
          ? h('select.select', {
            onchange: (e) => app.saveCharacterNow((data) => { data.ancestry = e.target.value; }),
          }, [
            h('option', { value: '', selected: !d.ancestry }, '（请选择）'),
            ...list.map(a => h('option', { value: a.name, selected: d.ancestry === a.name }, a.name)),
          ])
          : textInput(d.ancestry, (v) => app.saveCharacter((x) => { x.ancestry = v; }));
      })()),
      kv('社群', (() => {
        const list = rs.communities || [];
        return list.length
          ? h('select.select', {
            onchange: (e) => app.saveCharacterNow((data) => { data.community = e.target.value; }),
          }, [
            h('option', { value: '', selected: !d.community }, '（请选择）'),
            ...list.map(c => h('option', { value: c.name, selected: d.community === c.name }, c.name)),
          ])
          : textInput(d.community, (v) => app.saveCharacter((x) => { x.community = v; }));
      })()),
    ),
  ));

  /* 血统 / 社群特性 —— 车卡时要看得到具体效果 */
  root.appendChild(traitsCard(app, char, rs));

  /* 领域卡 */
  root.appendChild(domainCardsCard(app, char, rs));

  /* 护甲 */
  const armorSel = h('select.select', {
    onchange: (e) => app.saveCharacterNow((data) => {
      const a = rs.armors.find(x => x.name === e.target.value);
      if (!a) return;
      data.armorName = a.name;
      data.majorThreshold = a.major;
      data.severeThreshold = a.severe;
      data.armorScore = a.score;
      data.armorSlotsMax = a.score;
      data.armorEvasion = a.evasion;
    }),
  }, rs.armors.map(a => h('option', { value: a.name, selected: d.armorName === a.name },
    `${a.name}（${a.major}/${a.severe} · 分 ${a.score}）`)));

  root.appendChild(card('护甲',
    h('div.kv-list', {},
      kv('护甲', armorSel),
      kv('重伤阈值', numInput(d.majorThreshold, (v) => app.saveCharacter((x) => { x.majorThreshold = v; }), { min: 0 })),
      kv('致命阈值', numInput(d.severeThreshold, (v) => app.saveCharacter((x) => { x.severeThreshold = v; }), { min: 0 })),
      kv('护甲分数', numInput(d.armorScore, (v) => app.saveCharacter((x) => { x.armorScore = v; }), { min: 0, max: 12 })),
      kv('闪避基础', numInput(d.evasionBase, (v) => app.saveCharacter((x) => { x.evasionBase = v; }), {})),
      kv('护甲闪避修正', numInput(d.armorEvasion, (v) => app.saveCharacter((x) => { x.armorEvasion = v; }), {})),
      kv('压力上限', numInput(d.stressMax, (v) => app.saveCharacter((x) => { x.stressMax = v; }), { min: 1, max: 12 })),
      kv('生命上限', numInput(d.hpMax, (v) => app.saveCharacter((x) => { x.hpMax = v; }), { min: 1 })),
    ),
    h('div.tiny.muted', { style: { marginTop: '8px' } },
      '护甲数值取自 SRD 基础表；升级后获得的加值请手动调整上述字段。'),
  ));

  /* 经历 */
  const exps = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
  (d.experiences || []).forEach((ex, i) => {
    exps.appendChild(h('div.row', {},
      h('input.input', {
        value: ex.name, placeholder: `经历 ${i + 1}`,
        onchange: (e) => app.saveCharacter((data) => { data.experiences[i].name = e.target.value; }),
      }),
      h('input.input.mono', {
        type: 'number', value: ex.mod, style: { width: '64px' },
        onchange: (e) => app.saveCharacter((data) => { data.experiences[i].mod = Number(e.target.value) || 0; }),
      }),
      h('button.btn.sm', {
        title: '用该经历投掷',
        onclick: () => app.performCheck({ targetLabel: `经历：${ex.name || '未命名'}`, targetValue: ex.mod }),
      }, '🎲'),
    ));
  });
  exps.appendChild(h('button.btn.sm', {
    onclick: () => app.saveCharacterNow((data) => { data.experiences = [...(data.experiences || []), { name: '', mod: 2 }]; }),
  }, '＋ 添加经历'));

  root.appendChild(card('经历', exps));

  /* 伤害结算器 */
  root.appendChild(damageCalcCard(app, char, rs));

  root.appendChild(weaponsCard(app, char, [['name', '名称'], ['damage', '伤害骰'], ['trait', '属性'], ['note', '备注']],
    () => ({ name: '', damage: '', trait: '', note: '' })));

  root.appendChild(card('领域卡与装备',
    h('textarea.textarea', {
      value: d.inventory || '',
      onchange: (e) => app.saveCharacter((data) => { data.inventory = e.target.value; }),
    })));
}

function pipRow(label, max, marked, cls, onChange) {
  const pips = h('div.pips', {});
  for (let i = 0; i < max; i++) {
    pips.appendChild(h('div.pip' + (i < marked ? '.on' : '') + (cls ? '.' + cls : ''), {
      title: `第 ${i + 1} 格`,
      onclick: () => onChange(i + 1 === marked ? i : i + 1),
    }));
  }
  return h('div.track', {},
    h('span.tl', {}, label),
    pips,
    h('span.tiny.muted.mono', { style: { marginLeft: 'auto' } }, `${max - marked}/${max} 剩余`),
    h('div.ctl', {}, h('button', { onclick: () => onChange(0), title: '全部清除' }, '↺')),
  );
}

function counterRow(label, value, max, onChange, color) {
  const pips = h('div.pips', {});
  for (let i = 0; i < max; i++) {
    pips.appendChild(h('div.pip' + (i < value ? '.on' : ''), {
      title: String(i + 1),
      style: i < value ? { background: color, borderColor: color, color: '#00000099' } : {},
      onclick: () => onChange(i + 1 === value ? i : i + 1),
    }));
  }
  return h('div.track', {},
    h('span.tl', {}, label),
    pips,
    h('span.tiny.muted.mono', { style: { marginLeft: 'auto' } }, String(value)),
  );
}

function damageCalcCard(app, char, rs) {
  const d = char.data;
  const input = h('input.input.mono', { type: 'number', placeholder: '伤害总值', value: 0, style: { width: '110px' } });
  const markArmor = h('input', { type: 'checkbox', checked: true });
  const out = h('div.tiny.mono.muted', { style: { marginTop: '8px' } }, '输入伤害值后点「结算」');

  return card('伤害结算',
    h('div.row.wrap', {},
      input,
      h('label.row.tiny', { style: { gap: '5px' } }, markArmor, '标记护甲槽降低一级'),
      h('button.btn', {
        onclick: () => {
          const res = rs.resolveDamage(d, { total: Number(input.value) || 0, markArmor: markArmor.checked });
          out.textContent = res.detail;
          app.addEvent({
            type: 'combat',
            actor: char.id, actorName: char.name,
            title: `伤害结算：${res.total} 点 → ${res.severityLabel}（${res.severity} HP）`,
            detail: res.detail,
            data: res,
          });
        },
      }, '结算'),
      h('button.btn.primary', {
        title: '结算并直接扣减生命值',
        onclick: () => {
          const res = rs.resolveDamage(d, { total: Number(input.value) || 0, markArmor: markArmor.checked });
          app.saveCharacterNow((data) => {
            data.hpMarked = Math.min(data.hpMax, (data.hpMarked || 0) + res.severity);
            if (res.markArmor) data.armorMarked = Math.min(data.armorSlotsMax, (data.armorMarked || 0) + 1);
          });
          out.textContent = res.detail;
          app.addEvent({
            type: 'combat',
            actor: char.id, actorName: char.name,
            title: `受到伤害 ${res.total} → ${res.severityLabel}（${res.severity} HP）`,
            detail: res.detail,
            data: res,
          });
        },
      }, '结算并扣血'),
    ),
    out,
    h('div.tiny.muted', { style: { marginTop: '5px' } },
      `当前阈值 ${d.majorThreshold} / ${d.severeThreshold}`),
  );
}

/* ────────────────────────── 通用 ────────────────────────── */

function kv(label, control) {
  return h('div.kv-row', {}, h('span.k', {}, label), control);
}

function weaponsCard(app, char, columns, blank) {
  const list = char.data.weapons || [];
  const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });

  list.forEach((w, i) => {
    wrap.appendChild(h('div.row', {}, columns.map(([key, ph]) =>
      h('input.input', {
        value: w[key] || '', placeholder: ph,
        style: key === 'name' ? { flex: '1' } : { width: '130px' },
        onchange: (e) => app.saveCharacter((data) => { data.weapons[i][key] = e.target.value; }),
      })),
      h('button.btn.sm.roll', {
        title: '投掷伤害',
        onclick: () => {
          const expr = String(w.damage || '').replace(/[^0-9d+\-*]/gi, '');
          if (expr) app.rollRaw(expr, `${w.name || '武器'} 伤害`);
          else toast('该武器没有可解析的伤害骰', true);
        },
      }, '🎲'),
      h('button.btn.sm.ghost', {
        onclick: () => app.saveCharacterNow((data) => { data.weapons.splice(i, 1); }),
      }, '✕'),
    ));
  });

  wrap.appendChild(h('button.btn.sm', {
    onclick: () => app.saveCharacterNow((data) => { data.weapons = [...(data.weapons || []), blank()]; }),
  }, '＋ 添加'));

  return h('div.card', {}, h('h3', {}, '武器'), wrap);
}
