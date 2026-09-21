/** 弹窗：新建战役 / 新建角色。 */

import { h, render, toast } from '../util.js';
import { call } from '../platform.js';
import { RULESET_LIST } from '../../core/rulesets/index.js';
import { RNG, newSeed } from '../../core/rng.js';

function openModal(builder, { width = '560px' } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const close = (value) => { render(root); resolve(value); };
    const mask = h('div.modal-mask', {
      onclick: (e) => { if (e.target === mask) close(null); },
    }, h('div.modal', { style: { width } }));
    mask.firstChild.appendChild(builder(close));
    render(root, mask);
  });
}

/* ────────────────────── 新建战役 ────────────────────── */

export function openNewCampaignDialog() {
  return openModal((close) => {
    let system = 'coc7';
    const nameInput = h('input.input', { placeholder: '例如：阿卡姆之夜', autofocus: true });
    const descInput = h('input.input', { placeholder: '可选' });

    const cards = RULESET_LIST.map(rs =>
      h('div.radio-card' + (rs.id === system ? '.active' : ''), {
        onclick: () => {
          system = rs.id;
          cards.forEach((c, i) => c.classList.toggle('active', RULESET_LIST[i].id === system));
        },
      },
        h('div.rc-t', {}, h('span.badge.' + rs.id, {}, rs.short), rs.name),
        h('div.rc-d', {}, describeRuleset(rs.id)),
      ));

    const submit = async () => {
      const name = nameInput.value.trim();
      if (!name) { toast('请填写战役名称', true); return; }
      const created = await call('createCampaign', { name, system, description: descInput.value.trim() });
      close(created);
    };

    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    return h('div', {},
      h('h2', {}, '创建新战役'),
      h('p.sub', {}, '战役决定了使用哪套规则，创建后仍可修改角色卡，但系统类型不建议中途更换。'),
      h('div.field', { style: { marginBottom: '12px' } }, h('label', {}, '战役名称'), nameInput),
      h('div.field', { style: { marginBottom: '12px' } }, h('label', {}, '简述'), descInput),
      h('div.field', {}, h('label', {}, '规则系统'), h('div.radio-cards', {}, cards)),
      h('div.modal-foot', {},
        h('button.btn', { onclick: () => close(null) }, '取消'),
        h('button.btn.primary', { onclick: submit }, '创建'),
      ),
    );
  });
}

function describeRuleset(id) {
  if (id === 'coc7') return 'd100 判定，奖励骰 / 惩罚骰，理智与幸运；技能百分比制。';
  if (id === 'dnd5e') return 'd20 判定，优势 / 劣势，属性调整值与熟练加值，法术位。';
  return '双重骰 2d12，希望与恐惧，会心一击；压力与护甲槽打勾制。';
}

/* ────────────────────── 新建角色 ────────────────────── */

export function openNewCharacterDialog(rs) {
  return openModal((close) => {
    const nameInput = h('input.input', { placeholder: '角色名', autofocus: true });
    const hint = h('div.tiny.muted', { style: { marginTop: '6px' } });

    const submit = () => {
      const name = nameInput.value.trim();
      if (!name) { toast('请填写角色名', true); return; }
      const payload = rs.createDefault(name);
      close({ name, payload });
    };

    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    const genRow = h('div.row.wrap', { style: { marginTop: '12px' } });
    if (rs.id === 'coc7') {
      genRow.appendChild(h('button.btn.sm', {
        onclick: () => {
          const rng = new RNG(newSeed());
          const roll5 = () => (rng.int(1, 6) + rng.int(1, 6) + rng.int(1, 6)) * 5;
          hint.textContent = `本次随机：${['力量', '体质', '敏捷', '外貌', '意志', '智力'].map((l, i) => `${l} ${roll5()}`).join(' · ')}`;
          hint.dataset.mode = 'rolled';
        },
      }, '🎲 掷属性（3d6×5）'));
    } else if (rs.id === 'dnd5e') {
      genRow.appendChild(h('button.btn.sm', {
        onclick: () => {
          const rng = new RNG(newSeed());
          const arr = Array.from({ length: 6 }, () => {
            const dice = [rng.int(1, 6), rng.int(1, 6), rng.int(1, 6), rng.int(1, 6)].sort((a, b) => b - a);
            return dice.slice(0, 3).reduce((a, b) => a + b, 0);
          });
          hint.textContent = `4d6 弃最低：${arr.join(' / ')}（请手动填入属性）`;
        },
      }, '🎲 掷属性（4d6 弃最低）'));
      genRow.appendChild(h('button.btn.sm', {
        onclick: () => { hint.textContent = '标准数组：15 / 14 / 13 / 12 / 10 / 8'; },
      }, '标准数组'));
    } else {
      genRow.appendChild(h('button.btn.sm', {
        onclick: () => { hint.textContent = '起始属性分配：+2 / +1 / +1 / 0 / 0 / −1（建立角色卡后自行分配到六项属性）'; },
      }, '起始属性数组'));
    }

    return h('div', {},
      h('h2', {}, '创建角色卡'),
      h('p.sub', {}, `规则系统：${rs.name}。创建后可随时在「角色卡」标签页修改全部数值。`),
      h('div.field', {}, h('label', {}, '角色名'), nameInput),
      genRow,
      hint,
      h('div.modal-foot', {},
        h('button.btn', { onclick: () => close(null) }, '取消'),
        h('button.btn.primary', { onclick: submit }, '创建'),
      ),
    );
  });
}
