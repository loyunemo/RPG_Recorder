/** 战役笔记面板：战役信息、场景记录、场次管理。玩家只能看与记场景。 */

import { h, render, toast, confirmDialog } from '../util.js';
import { call, platform, dataDirAction } from '../platform.js';

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
  if (isGm) container.appendChild(dataCard(app));
}

/* ────────────────────────── 数据目录管理 ────────────────────────── */

const SOURCE_LABEL = {
  cli: '命令行参数指定',
  env: '环境变量指定',
  config: '你指定的目录',
  default: '默认位置',
};

function dataCard(app) {
  const box = h('div.card', {},
    h('h3', {}, '数据'),
    h('div.empty', { style: { padding: '14px' } }, '正在读取…'));
  // 异步填充，避免每次渲染笔记页都要等一轮 IPC
  loadDataCard(app, box);
  return box;
}

async function loadDataCard(app, box) {
  let info;
  try {
    info = await dataDirAction('info');
  } catch (err) {
    render(box, h('h3', {}, '数据'), h('div.tiny', { style: { color: 'var(--bad)' } }, `读取失败：${err.message}`));
    return;
  }

  const canChange = info.canChange !== false;
  const locked = !!info.lockedBy;

  const rows = [];

  rows.push(h('div', { style: { marginBottom: '9px' } },
    h('div.tiny.muted', { style: { marginBottom: '3px' } },
      '当前数据目录',
      h('span.badge', { style: { marginLeft: '7px' } }, SOURCE_LABEL[info.source] || info.source)),
    h('div.mono', {
      style: { wordBreak: 'break-all', fontSize: '13px', lineHeight: 1.6 },
    }, info.current),
    !info.writable
      ? h('div.tiny', { style: { color: 'var(--bad)', marginTop: '4px' } },
        `⚠ 该目录当前不可写：${info.reason}`)
      : null,
    info.lockedBy
      ? h('div.tiny.muted', { style: { marginTop: '4px' } },
        `本次运行由「${info.lockedBy}」决定，界面里改不了。去掉它就会用下面选择的目录。`)
      : null,
  ));

  /* 操作按钮 */
  const buttons = h('div.row.wrap', {},
    h('button.btn.sm', { onclick: () => call('openDataDir', {}) }, '打开目录'),
    h('button.btn.sm', { onclick: () => app.exportFlow() }, '导出 Markdown 复盘'),
    canChange && !locked
      ? h('button.btn.sm', { onclick: () => changeDirFlow(app, info) }, '更换目录…')
      : null,
    canChange && !locked && info.source === 'config'
      ? h('button.btn.sm.ghost', {
        onclick: async () => {
          const ok = await confirmDialog('恢复默认位置',
            `数据目录将改回：\n${info.defaultDir}\n\n当前目录里的数据不会被删除，只是不再从这里读取。`, '恢复默认');
          if (!ok) return;
          await dataDirAction('reset', {});
        },
      }, '恢复默认')
      : null,
  );
  rows.push(buttons);

  /* 最近使用过的目录 */
  if (canChange && !locked && info.recent?.length) {
    const others = info.recent.filter(d => d !== info.current);
    if (others.length) {
      rows.push(h('div', { style: { marginTop: '14px' } },
        h('div.tiny.muted', { style: { marginBottom: '6px' } }, '最近使用'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          ...others.map(dir => h('div.row', { style: { gap: '7px' } },
            h('span.mono.tiny', {
              style: { flex: '1', wordBreak: 'break-all', color: 'var(--text-dim)' },
            }, dir),
            h('button.btn.sm.ghost', {
              title: '切换到这个目录',
              onclick: () => switchTo(app, dir),
            }, '切换'),
            h('button.btn.sm.ghost', {
              title: '从列表移除',
              onclick: async () => {
                await dataDirAction('forget', { dir });
                app.renderMain();
              },
            }, '✕'),
          )),
        ),
      ));
    }
  }

  if (!canChange) {
    rows.push(h('div.tiny.muted', { style: { marginTop: '12px', lineHeight: 1.8 } },
      info.hint || '当前运行方式下无法在界面里更改数据目录。'));
  }

  rows.push(h('div.tiny.muted', { style: { marginTop: '12px', lineHeight: 1.8 } },
    '日志以追加式 JSONL 保存，可直接用文本编辑器打开。'
    + '备份 = 复制整个目录；换机器 = 把目录拷过去再在这里指过来。'));

  render(box, h('h3', {}, '数据'), ...rows);
}

/** 换目录：选路径 → 检查 → 视情况询问是否搬迁 → 应用 */
async function changeDirFlow(app, info) {
  const picked = await dataDirAction('pick');
  if (!picked) return;

  const probe = await dataDirAction('check', { dir: picked });
  if (!probe.ok) { toast(probe.reason, true); return; }
  await applyNewDir(app, probe, info);
}

async function switchTo(app, dir) {
  const probe = await dataDirAction('check', { dir });
  if (!probe.ok) { toast(probe.reason, true); return; }
  const info = await dataDirAction('info');
  await applyNewDir(app, probe, info);
}

async function applyNewDir(app, probe, info) {
  if (probe.dir === info.current) { toast('已经是当前目录了'); return; }

  // 目标目录已经有数据 —— 直接切过去，不覆盖
  if (probe.hasData) {
    const ok = await confirmDialog('切换到已有数据的目录',
      `该目录里已经有战役数据：\n${probe.dir}\n\n`
      + '切换后将读取那里的战役，当前目录的数据不会被删除。确定切换吗？', '切换');
    if (!ok) return;
    await dataDirAction('set', { dir: probe.dir, migrate: false });
    return;
  }

  // 目标目录是空的 —— 问要不要把现在这份搬过去
  const hasCurrentData = (app.state.stats?.events || 0) > 0 || (app.state.campaigns?.length || 0) > 0;
  let migrate = false;
  if (hasCurrentData) {
    migrate = await chooseMigrate(probe.dir, info.current);
    if (migrate === null) return;              // 取消
  }
  await dataDirAction('set', { dir: probe.dir, migrate: !!migrate });
}

/** 三选一：复制过去 / 用空目录重开 / 取消 */
function chooseMigrate(newDir, oldDir) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const close = (v) => { render(root); resolve(v); };
    const mask = h('div.modal-mask', {
      onclick: (e) => { if (e.target === mask) close(null); },
    }, h('div.modal', { style: { width: 'min(600px, 94vw)' } },
      h('h2', {}, '目标目录是空的'),
      h('p.sub', {}, '你想怎么处理现有的数据？'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px', margin: '14px 0' } },
        h('div.radio-card', { onclick: () => close(true) },
          h('div.rc-t', {}, '把现有数据复制过去'),
          h('div.rc-d', {}, `从 ${oldDir} 复制到 ${newDir}。原目录保留不动，相当于做了一次备份。`)),
        h('div.radio-card', { onclick: () => close(false) },
          h('div.rc-t', {}, '在新目录从零开始'),
          h('div.rc-d', {}, '新目录保持空白，之后的战役写在那里。原目录的数据仍然保留，随时能切回去。')),
      ),
      h('div.modal-foot', {}, h('button.btn', { onclick: () => close(null) }, '取消')),
    ));
    render(root, mask);
  });
}
