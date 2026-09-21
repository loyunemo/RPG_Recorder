/**
 * 玩家加入牌桌的界面。
 * 只在浏览器模式下、牌桌已开且当前没有有效令牌时出现。
 */

import { h, render, toast } from '../util.js';
import { joinTable, getPlayerId, setPlayerId, platform } from '../platform.js';

/** 记住上次填的名字，刷新后不用重输 */
const NAME_KEY = 'rw:playerName';

export function renderJoinView(root, app) {
  const box = h('div', { style: { maxWidth: '620px', margin: '0 auto', padding: '42px 20px' } });
  render(root, box);

  box.appendChild(h('div', { style: { textAlign: 'center', marginBottom: '26px' } },
    h('div', { style: { fontSize: '40px', marginBottom: '10px' } }, '🎲'),
    h('h1', { style: { margin: '0 0 6px', fontSize: '23px' } }, '加入牌桌'),
    h('p.muted', {}, '主持人已开启牌桌。填写你的名字并选择自己的角色卡即可开始。'),
  ));

  const body = h('div.card', {}, h('div.empty', {}, '正在读取名册…'));
  box.appendChild(body);

  loadRoster(body, app);
}

async function loadRoster(body, app) {
  let roster;
  try {
    const res = await fetch('/api/table/roster');
    roster = await res.json();
  } catch (err) {
    render(body, h('div.empty', {}, '读取名册失败：', err.message));
    return;
  }

  if (!roster.open) {
    render(body, h('div.empty', {},
      h('div.big', {}, '⏳'),
      '牌桌已经关闭了',
      h('br'),
      h('button.btn.sm', { style: { marginTop: '10px' }, onclick: () => location.reload() }, '重新检查'),
    ));
    return;
  }

  const chosen = new Set();

  /* 名字 */
  const nameInput = h('input.input', {
    value: localStorage.getItem(NAME_KEY) || '',
    placeholder: '你的名字（会显示在日志里）',
    maxlength: 24,
  });

  /* 角色卡选择 */
  const charList = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } });

  if (!roster.characters.length) {
    charList.appendChild(h('div.tiny.muted', {},
      '主持人还没有创建角色卡。你可以先加入，稍后再认领。'));
  }

  for (const c of roster.characters) {
    const mine = c.claimedBy && c.claimedBy.playerId === getPlayerId();
    const taken = c.claimedBy && !mine;

    const card = h('div.radio-card' + (mine ? '.active' : ''), {
      style: taken ? { opacity: .5, cursor: 'not-allowed' } : {},
      onclick: () => {
        if (taken) { toast(`「${c.name}」已被 ${c.claimedBy.name} 选走了`, true); return; }
        if (chosen.has(c.id)) chosen.delete(c.id); else chosen.add(c.id);
        card.classList.toggle('active', chosen.has(c.id));
      },
    },
      h('div.rc-t', {},
        c.name,
        h('span.badge', { style: { marginLeft: '8px' } }, c.system),
        taken ? h('span.badge', { style: { marginLeft: '6px', background: '#5a2f2c', color: '#ffc9c5' } },
          `已被 ${c.claimedBy.name} 选走`) : null,
      ),
      c.summary ? h('div.rc-d', {}, c.summary) : null,
    );
    if (mine) chosen.add(c.id);
    charList.appendChild(card);
  }

  const joinBtn = h('button.btn.primary', {
    style: { padding: '9px 30px' },
    onclick: async () => {
      const name = nameInput.value.trim();
      if (!name) { toast('请先填写你的名字', true); nameInput.focus(); return; }
      joinBtn.disabled = true;
      joinBtn.textContent = '加入中…';
      try {
        localStorage.setItem(NAME_KEY, name);
        await joinTable({ name, characterIds: [...chosen] });
        toast(`欢迎，${name}`);
        location.reload();   // 重新走一遍启动流程，这次带着令牌
      } catch (err) {
        toast(`加入失败：${err.message}`, true);
        joinBtn.disabled = false;
        joinBtn.textContent = '加入牌桌';
      }
    },
  }, '加入牌桌');

  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

  render(body,
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
      h('div.field', {}, h('label', {}, '你的名字'), nameInput),

      h('div.field', {},
        h('label', {}, `选择角色卡${roster.characters.length ? '（可多选，也可以先不选）' : ''}`),
        charList,
      ),

      roster.players.length
        ? h('div.tiny.muted', {}, `已在场：${roster.players.map(p => p.name).join('、')}`)
        : null,

      h('div.row', {},
        h('div.spacer'),
        h('span.tiny.muted', {}, roster.campaign?.name || ''),
        joinBtn,
      ),
    ),
  );
}
