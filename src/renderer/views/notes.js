/** 战役笔记面板：战役信息、场景记录、场次管理。玩家只能看与记场景。 */

import { h, render, toast } from '../util.js';
import { call, platform } from '../platform.js';

export function renderNotesView(root, app) {
  const { state } = app;
  const campaign = state.campaign;
  const isGm = platform.isGm;
  const container = h('div');
  render(root, container);

  /* 战役信息：主持人可编辑，玩家只读 */
  container.appendChild(h('div.card', {},
    h('h3', {}, '战役信息'),
    h('div.kv-list', {},
      h('div.kv-row', {}, h('span.k', {}, '名称'),
        isGm
          ? h('input.inline-edit', {
            value: campaign.name,
            onchange: async (e) => {
              await call('updateCampaign', { cid: campaign.id, patch: { name: e.target.value } });
              state.campaign.name = e.target.value;
              await app.reloadEvents();
              app.renderAll();
            },
          })
          : h('span', {}, campaign.name)),
      h('div.kv-row', {}, h('span.k', {}, '简述'),
        isGm
          ? h('input.inline-edit', {
            value: campaign.description || '',
            placeholder: '一句话概括这个战役',
            onchange: async (e) => {
              await call('updateCampaign', { cid: campaign.id, patch: { description: e.target.value } });
              state.campaign.description = e.target.value;
            },
          })
          : h('span.dim', {}, campaign.description || '—')),
      h('div.kv-row', {}, h('span.k', {}, '创建于'),
        h('span.dim', {}, new Date(campaign.createdAt).toLocaleString('zh-CN'))),
    ),
  ));

  /* 场景记录 */
  const sceneInput = h('textarea.textarea', { placeholder: '描述当前场景：地点、在场人物、发生了什么……（Ctrl+Enter 提交）' });
  sceneInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      await submitScene();
    }
  });

  const sceneTitle = h('input.input', { placeholder: '场景标题，例如「抵达阿卡姆图书馆」' });

  async function submitScene() {
    const title = sceneTitle.value.trim();
    const detail = sceneInput.value.trim();
    if (!title && !detail) { toast('请填写场景标题或内容', true); return; }
    await app.addEvent({
      type: 'scene',
      actor: null,
      actorName: null,
      title: title || detail.slice(0, 40),
      detail: title ? detail : '',
    });
    sceneTitle.value = '';
    sceneInput.value = '';
    toast('场景已记录');
  }

  container.appendChild(h('div.card', {},
    h('h3', {}, '记录场景'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      sceneTitle,
      sceneInput,
      h('div.row', {}, h('div.spacer'),
        h('button.btn.primary', { onclick: submitScene }, '记录场景')),
    ),
  ));

  /* 场次管理 */
  const sessionRows = (state.sessions || []).slice().reverse().map(s => {
    const count = state.events.filter(e => e.sessionId === s.id).length;
    const isActive = s.id === state.activeSessionId;
    return h('div.skill-row', { style: { padding: '7px 10px' } },
      h('span', { style: { flex: 1, fontWeight: isActive ? 700 : 400 } },
        s.name,
        isActive ? h('span.badge', { style: { marginLeft: '8px' } }, '进行中') : null,
        s.endedAt ? h('span.tiny.muted', { style: { marginLeft: '8px' } }, '已结束') : null,
      ),
      h('span.tiny.muted.mono', {}, `${count} 条`),
      h('span.tiny.muted', {}, new Date(s.startedAt).toLocaleDateString('zh-CN')),
      // 场次的开关由主持人管；玩家只看到「进行中 / 已结束」的状态
      isGm
        ? (isActive
          ? h('button.btn.sm', {
            onclick: async () => {
              await call('endSession', { cid: campaign.id, sid: s.id });
              const data = await call('listSessions', { cid: campaign.id });
              state.sessions = data.sessions;
              state.activeSessionId = data.activeSessionId;
              await app.reloadEvents();
              app.renderAll();
              toast(`「${s.name}」已结束`);
            },
          }, '结束场次')
          : h('button.btn.sm', {
            onclick: async () => {
              await call('setActiveSession', { cid: campaign.id, sid: s.id });
              state.activeSessionId = s.id;
              await app.reloadEvents();
              app.renderAll();
              toast(`已切换到「${s.name}」`);
            },
          }, '切换到此场次'))
        : (isActive ? h('span.badge', { style: { marginLeft: 'auto' } }, '当前') : null),
    );
  });

  container.appendChild(h('div.card', {},
    h('h3', {}, '场次'),
    sessionRows.length
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, sessionRows)
      : h('div.empty', {}, '还没有场次记录'),
    isGm
      ? h('div', { style: { marginTop: '10px' } },
        h('button.btn.sm', {
          onclick: async () => {
            const s = await call('createSession', { cid: campaign.id, payload: {} });
            const data = await call('listSessions', { cid: campaign.id });
            state.sessions = data.sessions;
            state.activeSessionId = s.id;
            await app.reloadEvents();
            app.renderAll();
          },
        }, '＋ 开始新场次'))
      : null,
  ));

  /* 数据位置：只有主持人能看到本机路径与导出入口 */
  if (isGm) {
    container.appendChild(h('div.card', {},
      h('h3', {}, '数据'),
      h('div.tiny.mono.muted', { style: { wordBreak: 'break-all' } }, app.state.stats?.root || ''),
      h('div.row', { style: { marginTop: '10px' } },
        h('button.btn.sm', { onclick: () => call('openDataDir', {}) }, '打开数据目录'),
        h('button.btn.sm', { onclick: () => app.exportFlow() }, '导出 Markdown 复盘'),
      ),
      h('div.tiny.muted', { style: { marginTop: '8px' } },
        '日志以追加式 JSONL 保存，可直接用文本编辑器打开，也可随时备份整个目录。'),
    ));
  }
}
