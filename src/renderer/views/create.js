/**
 * 车卡向导。
 *
 * 步骤由 `ruleset.creation` 驱动，四套规则共用同一套流程骨架：
 *   ① 基础信息 → ② 属性 → ③ 选择（技能 / 领域卡 / 经历）→ ④ 确认
 *
 * 只在这里做约束：角色建好之后仍可在「角色卡」页自由修改
 * （那里只做提示，不阻止保存）。
 */

import { h, render, toast } from '../util.js';
import { RNG, newSeed } from '../../core/rng.js';

/* ────────────────────────── 入口 ────────────────────────── */

export function openCreateWizard(rs) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    /** 草稿：向导期间一直改这一份，取消就丢弃 */
    const draft = rs.createDefault('');
    draft.creationMethod = rs.creation?.attributes?.methods?.[0]?.id || null;

    let step = 0;
    const STEPS = buildSteps(rs);
    const close = (value) => { render(root); resolve(value); };

    const mask = h('div.modal-mask', {
      onclick: (e) => { if (e.target === mask) close(null); },
    }, h('div.modal.wizard', { style: { width: 'min(820px, 94vw)' } }));
    const modal = mask.firstChild;

    function draw() {
      // 头部与底部固定，只有中间内容滚动 —— 否则提示与按钮会滚出视野
      render(modal,
        h('div.wiz-body', {}, header(), body()),
        footer(),
      );
    }

    /* ── 头部：步骤条 ── */
    function header() {
      const bar = h('div', {
        style: { display: 'flex', gap: '6px', margin: '4px 0 18px', flexWrap: 'wrap' },
      });
      STEPS.forEach((s, i) => {
        bar.appendChild(h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '4px 11px', borderRadius: '999px', fontSize: '12.5px',
            background: i === step ? 'var(--accent-dim)' : 'var(--bg-3)',
            border: `1px solid ${i === step ? '#4f82c8' : 'var(--border)'}`,
            color: i === step ? '#fff' : 'var(--text-dim)',
            fontWeight: i === step ? 600 : 400,
          },
        }, `${i + 1}. ${s.title}`));
        if (i < STEPS.length - 1) {
          bar.appendChild(h('span', { style: { color: 'var(--muted)', alignSelf: 'center' } }, '›'));
        }
      });

      return h('div', {},
        h('h2', {}, `按规则车卡 · ${rs.name}`),
        h('p.sub', {}, rs.creation?.summary || ''),
        bar,
      );
    }

    /* ── 主体 ── */
    function body() {
      const box = h('div', { style: { minHeight: '300px' } });
      STEPS[step].render(box, { rs, draft, redraw: draw });
      const res = rs.creation?.validate?.(draft);
      if (res) {
        // 提示放在预算条前面，保证一屏之内能先看到问题
        if (res.errors.length || res.warnings.length) box.appendChild(issuePanel(res));
        box.appendChild(budgetPanel(rs, draft));
      }
      return box;
    }

    /* ── 底部 ── */
    function footer() {
      const isLast = step === STEPS.length - 1;
      const nameOk = (draft.name || '').trim().length > 0;
      const res = rs.creation?.validate?.(draft);
      const blocked = isLast && res && !res.ok;

      return h('div.modal-foot', {},
        h('span.tiny.muted', { style: { marginRight: 'auto' } },
          blocked ? `还有 ${res.errors.length} 项不符合规则，见上方红字` : ''),
        step > 0 ? h('button.btn', { onclick: () => { step--; draw(); } }, '上一步') : null,
        h('button.btn', { onclick: () => close(null) }, '取消'),
        isLast
          ? h('button.btn.primary', {
            disabled: blocked,
            title: blocked ? '先修正上方标红的问题' : '',
            onclick: () => close({ name: draft.name.trim(), payload: draft }),
          }, '完成车卡')
          : h('button.btn.primary', {
            disabled: !nameOk && step === 0,
            title: !nameOk && step === 0 ? '先填角色名' : '',
            onclick: () => { step++; draw(); },
          }, '下一步'),
      );
    }

    draw();
    render(root, mask);
  });
}

/* ────────────────────────── 步骤定义 ────────────────────────── */

function buildSteps(rs) {
  const c = rs.creation || {};
  const steps = [];

  steps.push({ id: 'basics', title: '基础信息', render: (box, ctx) => renderBasics(box, rs, ctx) });

  if (c.attributes) {
    steps.push({ id: 'attributes', title: '属性', render: (box, ctx) => renderAttributes(box, rs, ctx) });
  } else if (c.traits) {
    steps.push({ id: 'traits', title: '属性分配', render: (box, ctx) => renderTraits(box, rs, ctx) });
  }

  if (hasPicks(rs)) {
    steps.push({ id: 'picks', title: '技能与领域', render: (box, ctx) => renderPicks(box, rs, ctx) });
  }

  steps.push({ id: 'review', title: '确认', render: (box, ctx) => renderReview(box, rs, ctx) });
  return steps;
}

function hasPicks(rs) {
  return !!(rs.creation?.skillPick || supportsExperiences(rs) || supportsDomainCards(rs));
}
const supportsExperiences = (rs) => Array.isArray(rs.createDefault('x').experiences);
const supportsDomainCards = (rs) => Array.isArray(rs.createDefault('x').domainCards);

/* ────────────────────────── ① 基础信息 ────────────────────────── */

function renderBasics(box, rs, { draft, redraw }) {
  const c = rs.creation || {};
  const fields = [];

  const nameInput = h('input.input', {
    value: draft.name, placeholder: '角色名', autofocus: true,
    oninput: (e) => { draft.name = e.target.value; },
    onchange: () => redraw(),
  });
  fields.push(h('div.field', {}, h('label', {}, '角色名'), nameInput));

  for (const f of c.fields || []) {
    const current = readField(draft, f.key);
    let control;

    if (f.type === 'select') {
      const options = resolveOptions(rs, draft, f);
      control = h('select.select', {
        onchange: (e) => { writeField(draft, f.key, e.target.value); onFieldChanged(rs, draft, f.key); redraw(); },
      }, [
        h('option', { value: '', selected: !current }, '（请选择）'),
        ...options.map(o => h('option', { value: o, selected: current === o }, o)),
      ]);
    } else if (f.type === 'number') {
      control = h('input.input.mono', {
        type: 'number', value: current ?? f.default ?? '', min: f.min, max: f.max,
        style: { width: '110px' },
        onchange: (e) => {
          writeField(draft, f.key, Number(e.target.value));
          onFieldChanged(rs, draft, f.key);
          redraw();
        },
      });
    } else {
      control = h('input.input', {
        value: current || '', placeholder: f.placeholder || '',
        onchange: (e) => { writeField(draft, f.key, e.target.value); redraw(); },
      });
    }

    fields.push(h('div.field', {},
      h('label', {}, f.label, f.hint ? h('span.tiny.muted', {}, `　${f.hint}`) : null),
      control,
    ));
  }

  box.appendChild(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, fields));
}

/** 选项可能是数组，也可能依赖另一个字段（如华渚的宗门依赖法门） */
function resolveOptions(rs, draft, field) {
  if (Array.isArray(field.options)) return field.options;
  if (field.dependsOn === 'className' && rs.creation?.subclassesOf) {
    return rs.creation.subclassesOf(draft.className).map(s => s.name);
  }
  return [];
}

function readField(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function writeField(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  const target = parts.reduce((o, k) => (o[k] = o[k] || {}), obj);
  target[last] = value;
}

/** 换了职业 / 种族这类关键字段后，自动带出派生值 */
function onFieldChanged(rs, draft, key) {
  const c = rs.creation || {};

  if (key === 'className') {
    if (rs.id === 'dnd5e') {
      const cls = (c.classTable || []).find(x => x.name === draft.className);
      if (cls) {
        draft.combat.hpMax = c.expectedHp ? c.expectedHp(cls.name, draft.level || 1, draft.abilities) : draft.combat.hpMax;
        draft.proficiency.saves = [...cls.saves];
        draft.proficiency.skills = [];
      }
    } else if (rs.id === 'daggerheart' || rs.id === 'huazhu') {
      const cls = (rs.classes || []).find(x => x.name === draft.className);
      if (cls) {
        draft.evasionBase = cls.evasion;
        draft.hpMax = cls.hp;
        draft.hpMarked = 0;
        if (rs.id === 'huazhu') {
          draft.domain = cls.domain;
          draft.subclass = '';
          draft.sectNature = '';
          draft.spellcastTrait = '';
        }
      }
    }
  }

  if (key === 'subclass' && rs.id === 'huazhu') {
    const cls = (rs.classes || []).find(x => x.name === draft.className);
    const sub = (cls?.subclasses || []).find(s => s.name === draft.subclass);
    if (sub) {
      draft.sectNature = sub.sectNature || '';
      draft.spellcastTrait = sub.spellcastTrait || '';
      draft.inventory = sub.startingItems || draft.inventory;
    }
  }

  if (key === 'race' && rs.id === 'dnd5e') {
    applyRaceNow(rs, draft);
  }
  if (key === 'level') {
    if (rs.id === 'dnd5e') {
      const cls = (c.classTable || []).find(x => x.name === draft.className);
      if (cls && c.expectedHp) draft.combat.hpMax = c.expectedHp(cls.name, draft.level, draft.abilities);
    }
  }
  if (key === 'age' && rs.id === 'coc7') {
    // 年龄改动只提示，属性由玩家在下一步主动应用
  }
}

function applyRaceNow(rs, draft) {
  const race = (rs.creation?.raceTable || []).find(r => r.name === draft.race);
  if (!race) return;
  const apply = rs.creation.attributes?.applyRace;
  if (!apply) return;
  const choices = draft._raceChoices || [];
  const res = apply(draft, draft.race, choices);
  Object.assign(draft, res);
}

/* ────────────────────────── ② 属性（COC / DND） ────────────────────────── */

function renderAttributes(box, rs, { draft, redraw }) {
  const spec = rs.creation.attributes;
  const isDnd = rs.id === 'dnd5e';

  /* 生成方式 */
  if (spec.methods?.length) {
    const row = h('div.row.wrap', { style: { marginBottom: '12px' } },
      h('span.tiny.dim', { style: { width: '62px' } }, '生成方式'));
    for (const m of spec.methods) {
      row.appendChild(h('button.chip' + (draft.creationMethod === m.id ? '.active' : ''), {
        title: m.hint || '',
        onclick: () => {
          draft.creationMethod = m.id;
          if (m.id === 'standard' && isDnd) {
            // 标准数组：先给一份默认分配，玩家再调
            spec.keys.forEach((k, i) => { draft.baseAbilities[k] = spec.pool[i]; });
            applyRaceNow(rs, draft);
          }
          redraw();
        },
      }, m.label));
    }
    box.appendChild(row);

    const active = spec.methods.find(m => m.id === draft.creationMethod);
    if (active?.hint) {
      box.appendChild(h('div.tiny.muted', { style: { marginBottom: '12px' } }, active.hint));
    }
  }

  /* COC：一键按规则掷骰 */
  if (!isDnd && spec.roll) {
    box.appendChild(h('div.row', { style: { marginBottom: '12px' } },
      h('button.btn', {
        onclick: () => {
          const r = spec.roll(new RNG(newSeed()));
          Object.assign(draft.attributes, spec.applyAge ? spec.applyAge(r.attributes, draft.age) : r.attributes);
          draft.luck = r.luck;
          if (draft.state) draft.state.luck = r.luck;
          toast('已按规则掷出属性，并按年龄做了修正');
          redraw();
        },
      }, '🎲 按规则掷属性'),
      h('span.tiny.muted', {}, `当前年龄 ${draft.age}：${spec.ageRules ? spec.ageRules(draft.age).note : ''}`),
    ));
  }

  /* DND：掷骰生成数值池 */
  let pool = null;
  if (isDnd) {
    if (draft.creationMethod === 'standard') pool = spec.pool;
    else if (draft.creationMethod === 'roll' && Array.isArray(draft._rolledPool)) pool = draft._rolledPool;

    if (draft.creationMethod === 'roll') {
      box.appendChild(h('div.row', { style: { marginBottom: '12px' } },
        h('button.btn', {
          onclick: () => {
            draft._rolledPool = spec.roll(new RNG(newSeed()));
            draft.creationMethod = 'roll';
            redraw();
          },
        }, '🎲 掷 6 组 4d6 弃最低'),
        draft._rolledPool
          ? h('span.mono', { style: { fontSize: '15px' } }, draft._rolledPool.join(' / '))
          : h('span.tiny.muted', {}, '还没掷'),
      ));
    }
  }

  /* 属性输入 */
  const grid = h('div.attr-grid');
  for (const key of spec.keys) {
    const isDndBase = isDnd;
    const cur = isDndBase ? (draft.baseAbilities?.[key] ?? 10) : draft.attributes[key];
    const bonus = isDndBase ? (draft.raceBonuses?.[key] || 0) : 0;

    let control;
    if (isDndBase && pool) {
      control = h('select.input.mono', {
        style: { width: '100%', textAlign: 'center' },
        onchange: (e) => {
          draft.baseAbilities[key] = Number(e.target.value);
          applyRaceNow(rs, draft);
          redraw();
        },
      }, pool.map(v => h('option', { value: v, selected: cur === v }, String(v))));
    } else if (isDndBase && draft.creationMethod === 'pointbuy') {
      control = h('input.inline-edit.mono', {
        type: 'number', value: cur, min: 8, max: 15,
        style: { textAlign: 'center', fontSize: '19px', fontWeight: 700 },
        onchange: (e) => {
          draft.baseAbilities[key] = Number(e.target.value);
          applyRaceNow(rs, draft);
          redraw();
        },
      });
    } else {
      control = h('input.inline-edit.mono', {
        type: 'number', value: cur,
        style: { textAlign: 'center', fontSize: '19px', fontWeight: 700 },
        onchange: (e) => { draft.attributes[key] = Number(e.target.value); redraw(); },
      });
    }

    grid.appendChild(h('div.attr-box', {},
      h('div.lb', {}, spec.labels[key] || key),
      control,
      bonus
        ? h('div.hint', { style: { color: 'var(--ok)' } }, `种族 +${bonus} → ${cur + bonus}`)
        : h('div.hint', {}, isDndBase ? `调整值 ${Math.floor((cur - 10) / 2) >= 0 ? '+' : ''}${Math.floor((cur - 10) / 2)}` : ''),
    ));
  }
  box.appendChild(grid);

  /* 半精灵这类需要自选加值的种族 */
  if (isDnd) {
    const race = (rs.creation.raceTable || []).find(r => r.name === draft.race);
    if (race?.choices) {
      const chosen = draft._raceChoices || [];
      const row = h('div.row.wrap', { style: { marginTop: '12px' } },
        h('span.tiny.dim', {}, `${race.name} 自选 ${race.choices.count} 项各 +${race.choices.amount}：`));
      for (const key of spec.keys) {
        if (key in race.bonuses) continue;
        const on = chosen.includes(key);
        row.appendChild(h('button.chip' + (on ? '.active' : ''), {
          onclick: () => {
            const next = on ? chosen.filter(k => k !== key) : [...chosen, key].slice(0, race.choices.count);
            draft._raceChoices = next;
            applyRaceNow(rs, draft);
            redraw();
          },
        }, spec.labels[key]));
      }
      box.appendChild(row);
    }
  }
}

/* ────────────────────────── ② 属性分配（匕首心 / 华渚） ────────────────────────── */

function renderTraits(box, rs, { draft, redraw }) {
  const spec = rs.creation.traits;
  const values = spec.array;

  box.appendChild(h('div.tiny.muted', { style: { marginBottom: '10px' } },
    `把 ${values.map(v => (v > 0 ? `+${v}` : v)).join(' / ')} 这六个数值各用一次，分配到六项属性上。`));

  const grid = h('div.attr-grid');
  for (const key of spec.keys) {
    const cur = draft.traits[key];
    const remaining = countRemaining(draft.traits, key, values);
    grid.appendChild(h('div.attr-box', {},
      h('div.lb', {}, spec.labels[key] || key),
      h('select.input.mono', {
        style: { width: '100%', textAlign: 'center' },
        onchange: (e) => { draft.traits[key] = Number(e.target.value); redraw(); },
      }, values.map(v => h('option', {
        value: v,
        selected: cur === v,
        disabled: v !== cur && !remaining.includes(v),
      }, v > 0 ? `+${v}` : String(v)))),
      h('div.hint', {}, '调整值'),
    ));
  }
  box.appendChild(grid);
}

/** 去掉当前项占用后，还能给这一项选哪些值 */
function countRemaining(traits, selfKey, values) {
  const pool = [...values];
  for (const [k, v] of Object.entries(traits)) {
    if (k === selfKey) continue;
    const i = pool.indexOf(v);
    if (i >= 0) pool.splice(i, 1);
  }
  return pool;
}

/* ────────────────────────── ③ 选择 ────────────────────────── */

function renderPicks(box, rs, { draft, redraw }) {
  const c = rs.creation || {};

  /* COC：标记本职技能 */
  if (c.skillPick) {
    const picked = new Set(draft[c.skillPick.key] || []);
    const names = Object.keys(draft.skills).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const chips = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px', maxHeight: '220px', overflowY: 'auto' } },
      names.map(n => h('button.chip' + (picked.has(n) ? '.active' : ''), {
        onclick: () => {
          const set = new Set(draft[c.skillPick.key] || []);
          if (set.has(n)) set.delete(n); else set.add(n);
          draft[c.skillPick.key] = [...set];
          redraw();
        },
      }, n)));
    box.appendChild(h('div', { style: { marginBottom: '16px' } },
      h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, c.skillPick.label),
      h('div.tiny.muted', { style: { marginBottom: '8px' } }, c.skillPick.hint),
      chips,
    ));
  }

  /* DND：职业技能与豁免 */
  if (rs.id === 'dnd5e') {
    const cls = (c.classTable || []).find(x => x.name === draft.className);
    const all = rs.skills.map(s => s.label);
    const allowed = cls ? (cls.skills === 'any' ? all : cls.skills) : all;
    const picked = new Set(draft.proficiency.skills || []);

    box.appendChild(h('div', { style: { marginBottom: '16px' } },
      h('div', { style: { fontWeight: 600, marginBottom: '4px' } },
        `职业技能（${picked.size}/${cls?.skillCount ?? '?'}）`),
      h('div.tiny.muted', { style: { marginBottom: '8px' } },
        cls ? `限：${allowed.join('、')}` : '先在上一步选好职业'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } },
        allowed.map(n => h('button.chip' + (picked.has(n) ? '.active' : ''), {
          onclick: () => {
            const set = new Set(draft.proficiency.skills || []);
            if (set.has(n)) set.delete(n); else set.add(n);
            draft.proficiency.skills = [...set];
            redraw();
          },
        }, n))),
    ));
  }

  /* 匕首心 / 华渚：经历 + 领域卡 */
  if (Array.isArray(draft.experiences)) {
    const level = draft.level || 1;
    const need = 2 + Math.max(0, level - 1);
    const rows = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    for (let i = 0; i < need; i++) {
      const e = draft.experiences[i] || { name: '', mod: 2 };
      draft.experiences[i] = e;
      rows.appendChild(h('div.row', {},
        h('input.input', {
          value: e.name, placeholder: `经历 ${i + 1}`,
          onchange: (ev) => { e.name = ev.target.value; e.mod = 2; redraw(); },
        }),
        h('span.mono.tiny.muted', {}, '+2'),
      ));
    }
    box.appendChild(h('div', { style: { marginBottom: '16px' } },
      h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, `起始经历（需要 ${need} 条，每条 +2）`),
      rows,
    ));
  }

  if (Array.isArray(draft.domainCards)) {
    box.appendChild(domainPicker(rs, draft, redraw));
  }
}

function domainPicker(rs, draft, redraw) {
  const usable = rs.creation.usableDomains
    ? rs.creation.usableDomains(draft)
    : [draft.domain].filter(Boolean);

  const need = 2 + Math.max(0, (draft.level || 1) - 1);
  const owned = draft.domainCards || [];
  const hasCatalog = Array.isArray(rs.domainCards);

  const wrap = h('div', {},
    h('div', { style: { fontWeight: 600, marginBottom: '6px' } },
      `领域卡（${owned.length}/${need}）`),
    h('div.tiny.muted', { style: { marginBottom: '8px' } },
      usable.length ? `可用领域：${usable.join(' / ')}` : '先选好法门与宗门，才能看到可选领域卡'),
  );

  owned.forEach((card, i) => {
    wrap.appendChild(h('div.row', {
      style: {
        background: 'var(--bg-2)', border: '1px solid var(--border-soft)',
        borderRadius: 'var(--radius-sm)', padding: '5px 9px', marginBottom: '4px',
      },
    },
      h('span', { style: { flex: '1', fontSize: '12.5px' } }, card.name),
      h('span.badge', {}, card.domain || ''),
      h('button.btn.sm.ghost', {
        onclick: () => { draft.domainCards.splice(i, 1); redraw(); },
      }, '✕'),
    ));
  });

  if (hasCatalog && usable.length) {
    const byName = new Map(rs.domainCards.map(c => [c.name, c]));
    const domainByName = new Map(rs.domains.map(d => [d.name, d]));
    const groups = [];
    for (const name of usable) {
      const dom = domainByName.get(name);
      if (!dom) continue;
      const cards = rs.domainCards
        .filter(c => c.domain === dom.id)
        .sort((a, b) => (a.level ?? 99) - (b.level ?? 99));
      if (cards.length) groups.push({ dom, cards });
    }
    wrap.appendChild(h('select.select', {
      onchange: (e) => {
        const card = byName.get(e.target.value);
        if (!card) return;
        const dom = rs.domains.find(d => d.id === card.domain);
        draft.domainCards.push({
          name: card.name, domain: dom?.name || card.domain, level: card.level, text: card.text,
        });
        e.target.value = '';
        redraw();
      },
    }, [
      h('option', { value: '' }, '＋ 添加领域卡…'),
      ...groups.map(g => h('optgroup', { label: `${g.dom.name}（${g.dom.path}）` },
        g.cards.map(c => h('option', { value: c.name }, `Lv${c.level ?? '?'} ${c.name}`)))),
    ]));
  } else if (!hasCatalog) {
    // 匕首心没有内置卡表，用自由输入
    const input = h('input.input', { placeholder: '领域卡名称，回车添加' });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      draft.domainCards.push({ name: e.target.value.trim(), domain: draft.domain || '', level: 1, text: '' });
      e.target.value = '';
      redraw();
    });
    wrap.appendChild(input);
  }

  return wrap;
}

/* ────────────────────────── ④ 确认 ────────────────────────── */

function renderReview(box, rs, { draft }) {
  const c = rs.creation || {};
  const d = rs.derive(draft);

  const row = (k, v) => h('div.kv-row', {},
    h('span.k', {}, k), h('span', { style: { fontWeight: 600 } }, String(v ?? '—')));

  const info = h('div.kv-list', {},
    row('角色名', draft.name),
    ...(c.fields || []).map(f => row(f.label, readField(draft, f.key))),
  );

  const stats = h('div.stat-grid', {}, d.stats.slice(0, 8).map(s =>
    h('div.stat-box', {}, h('div.lb', {}, s.label), h('div.vl', {}, String(s.value)))));

  const tracks = h('div.tracks', {}, d.tracks.map(t =>
    h('div.track', {}, h('span.tl', {}, t.label),
      h('div.bar', {},
        h('div.fill.tone-' + t.tone, { style: { width: `${t.max ? (t.current / t.max) * 100 : 0}%` } }),
        h('div.txt', {}, `${t.current} / ${t.max}`)))));

  box.appendChild(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    h('div.card', { style: { margin: 0 } }, h('h3', {}, '基本信息'), info),
    h('div.card', { style: { margin: 0 } }, h('h3', {}, '派生数值'), stats),
    h('div.card', { style: { margin: 0 } }, h('h3', {}, '资源'), tracks),
    h('div.tiny.muted', {}, '点「完成车卡」后仍可在角色卡页继续修改；那里只提示、不阻止。'),
  ));
}

/* ────────────────────────── 预算与校验面板 ────────────────────────── */

function budgetPanel(rs, draft) {
  const budgets = rs.creation?.budgets?.(draft);
  if (!budgets || !budgets.length) return h('div');

  const rows = budgets.map(b => {
    const pct = b.total > 0 ? Math.min(100, (b.used / b.total) * 100) : 0;
    return h('div.track', { style: { marginBottom: '6px' } },
      h('span.tl', { style: { width: '96px' } }, b.label),
      h('div.bar', {},
        h('div.fill', {
          style: {
            width: `${pct}%`,
            background: b.over ? 'var(--bad)' : b.remaining === 0 ? 'var(--ok)' : 'var(--accent)',
          },
        }),
        h('div.txt', {}, `${b.used} / ${b.total} ${b.unit}`)),
      h('span.tiny.muted', { style: { width: '132px', textAlign: 'right' } },
        b.over ? `超出 ${b.used - b.total}` : (b.remaining > 0 ? `还剩 ${b.remaining}` : '刚好')),
    );
  });

  return h('div', {
    style: {
      marginTop: '18px', paddingTop: '14px', borderTop: '1px dashed var(--border)',
    },
  },
    h('div', { style: { fontSize: '12px', color: 'var(--muted)', marginBottom: '8px', letterSpacing: '.05em' } }, '车卡预算'),
    rows,
    h('div.tiny.muted', { style: { marginTop: '6px' } }, budgets[0]?.hint || ''),
  );
}

function issuePanel(res) {
  const box = h('div', { style: { marginTop: '14px' } });

  if (res.errors.length) {
    box.appendChild(h('div', {
      style: {
        background: '#2b1a1a', border: '1px solid #6b3f3f', borderRadius: 'var(--radius)',
        padding: '10px 12px', marginBottom: '8px',
      },
    },
      h('div', { style: { color: 'var(--bad)', fontWeight: 600, marginBottom: '5px' } },
        `不符合规则（${res.errors.length}）—— 修正后才能完成车卡`),
      ...res.errors.map(e => h('div.tiny', { style: { color: '#f0b6b2', lineHeight: 1.7 } }, `· ${e.message}`)),
    ));
  }

  if (res.warnings.length) {
    box.appendChild(h('div', {
      style: {
        background: '#2b2416', border: '1px solid #6b5a2f', borderRadius: 'var(--radius)',
        padding: '10px 12px',
      },
    },
      h('div', { style: { color: 'var(--warn)', fontWeight: 600, marginBottom: '5px' } },
        `提醒（${res.warnings.length}）—— 不影响完成`),
      ...res.warnings.map(w => h('div.tiny', { style: { color: '#e3cf9a', lineHeight: 1.7 } }, `· ${w.message}`)),
    ));
  }

  return box;
}
