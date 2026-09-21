/**
 * Electron 主进程。
 *
 * 职责：开窗口、决定数据目录、把存储层通过 IPC 暴露给渲染进程。
 * 业务逻辑一律不放在这里——渲染进程与本地 HTTP 服务共用同一套核心模块。
 */

const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./store.cjs');
const { createRoutes } = require('./routes.cjs');
const { Table, lanAddress } = require('../server/table.cjs');
const { Hub } = require('../server/hub.cjs');
const { createTableServer } = require('../server/http.cjs');

const APP_ROOT = path.join(__dirname, '..');

/** 决定数据目录：显式环境变量 > 开发期放项目内 > 打包后放用户数据目录 */
function resolveDataDir() {
  if (process.env.RW_DATA_DIR) return path.resolve(process.env.RW_DATA_DIR);
  if (!app.isPackaged) return path.join(APP_ROOT, 'data');
  return path.join(app.getPath('userData'), 'data');
}

let store;
let mainWindow;
let table;              // 牌桌（多人）
let hub;                // 调用与广播的唯一入口
let gmParticipant;      // 本机 GM 在牌桌上的身份
let tableServer;        // 开桌后才启动的 HTTP + SSE 服务
let tablePort = Number(process.env.RW_PORT || 41777);

/**
 * 开发辅助：`--url=<地址>` 会让窗口加载远程地址且**不挂载 preload**，
 * 也就是以「浏览器」而非「桌面端」的身份运行。
 * 用来验证玩家视角 —— 否则 GM 的桌面端永远看不到加入界面。
 */
const REMOTE_URL = (() => {
  const arg = process.argv.find(a => a.startsWith('--url='));
  return arg ? arg.slice('--url='.length) : null;
})();

/** 开启牌桌：启动 HTTP 服务，局域网玩家即可接入 */
function openTable(campaignId, gmName = '主持人') {
  if (table.isOpen) {
    if (table.campaignId === campaignId) {
      return { alreadyOpen: true, ...tableInfo() };
    }
    table.close();
  }
  const { campaign, gm } = table.open(campaignId, gmName);
  gmParticipant = gm;
  gmParticipant.local = true;   // 标记为本地 GM，广播时不回灌自己

  if (!tableServer) {
    tableServer = createTableServer({
      store, hub, table, appRoot: APP_ROOT, port: tablePort,
    });
    tableServer.listen(tablePort, '0.0.0.0');
  }

  return { campaign, ...tableInfo() };
}

function closeTable() {
  if (table.isOpen) table.close();
  gmParticipant = null;
  return { ok: true };
}

function tableInfo() {
  return {
    open: table.isOpen,
    campaignId: table.campaignId,
    openedAt: table.openedAt,
    joinUrl: table.isOpen ? `http://${lanAddress()}:${tablePort}/` : null,
    lanAddress: lanAddress(),
    port: tablePort,
    presence: table.isOpen ? table.presence() : [],
    seats: table.isOpen ? (store.getState(table.campaignId).seats || {}) : {},
  };
}

/** GM 调整某个玩家的角色卡归属 */
function seatPlayer({ playerId, characterIds = [] }) {
  if (!table.isOpen) throw new Error('牌桌未开启');
  const seats = store.getState(table.campaignId).seats || {};
  if (!seats[playerId]) throw new Error('找不到该玩家的席位');

  // 从其他席位里摘掉这些角色，保证一张卡只属于一个人
  for (const [pid, seat] of Object.entries(seats)) {
    if (pid === playerId) continue;
    seat.characterIds = (seat.characterIds || []).filter(id => !characterIds.includes(id));
  }
  seats[playerId].characterIds = characterIds;
  store.saveState(table.campaignId, { seats });

  for (const p of table.sessions.values()) {
    if (p.playerId === playerId) p.characterIds = characterIds;
  }
  table.broadcastPresence();
  return { ok: true, seats };
}

/** 请某位玩家离席 */
function unseatPlayer({ playerId }) {
  if (!table.isOpen) throw new Error('牌桌未开启');
  const seats = store.getState(table.campaignId).seats || {};
  delete seats[playerId];
  store.saveState(table.campaignId, { seats });

  for (const [token, p] of [...table.sessions]) {
    if (p.playerId === playerId) table.sessions.delete(token);
  }
  table.broadcastPresence();
  return { ok: true, seats };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#14161c',
    title: '跑团记录系统',
    autoHideMenuBar: false,
    webPreferences: {
      // --url 模式刻意不挂 preload，让它表现得和浏览器一致（用于验证玩家视角）
      preload: REMOTE_URL ? undefined : path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  if (REMOTE_URL) {
    mainWindow.loadURL(REMOTE_URL);
  } else {
    mainWindow.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'index.html'));
  }

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 渲染进程的报错转发到终端，便于排查界面问题
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message}  (${source}:${line})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[random-walking] 渲染进程崩溃：', details);
  });

  // 开发辅助：--shot-player <目录> 以浏览器身份跑一遍玩家流程并截图
  const playerShotIdx = process.argv.indexOf('--shot-player');
  if (playerShotIdx >= 0) {
    const outDir = path.resolve(process.argv[playerShotIdx + 1] || 'player-shots');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    mainWindow.webContents.once('did-finish-load', async () => {
      const js = (code) => mainWindow.webContents.executeJavaScript(`(() => { ${code} })()`)
        .catch(() => null);
      const shoot = async (name) => {
        try {
          // 窗口必须真的可见并由合成器绘制过，capturePage 才不会返回空图
          mainWindow.show();
          mainWindow.focus();
          mainWindow.moveTop();
          await sleep(350);
          const image = await mainWindow.webContents.capturePage();
          if (image.isEmpty()) {
            console.error('[shot] 抓到空图：', name);
            return;
          }
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
          console.log('[shot] 截图：', name);
        } catch (err) { console.error('[shot] 失败：', err.message); }
      };

      try {
        await sleep(1500);
        // 上次跑完会把令牌留在 localStorage 里，那样会直接跳过加入界面。
        // 每次验证都从干净状态开始，才能截到玩家真正看到的加入页。
        await js(`localStorage.clear(); return true;`);
        mainWindow.webContents.reload();
        await sleep(2600);
        await shoot('1-join');

        // 填名字、选第一张角色卡、加入
        await js(`
          const nameInput = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('你的名字'));
          if (nameInput) nameInput.value = '测试玩家';
          const card = document.querySelector('.radio-card');
          if (card) card.click();
          return true;`);
        await sleep(500);
        await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('加入牌桌'))?.click(); return true;`);

        // 加入后页面会 reload，轮询等玩家界面就绪
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
          await sleep(500);
          ready = await js(`return document.querySelectorAll('.tab').length >= 4;`);
        }
        console.log('[shot] 玩家界面就绪：', ready);
        await sleep(1500);
        await shoot('2-dice');

        const probe = await js(`
          const t = document.body.innerText;
          return {
            身份: document.querySelector('.topbar .chip')?.innerText || '(无)',
            有开桌按钮: t.includes('开启牌桌'),
            有新建战役: t.includes('新战役'),
            有数据目录: t.includes('数据目录'),
          };`);
        console.log('[shot] 玩家视角探针：', JSON.stringify(probe));

        await js(`document.querySelectorAll('.tab')[1]?.click(); return true;`);
        await sleep(900);
        await shoot('3-combat');
        const combatProbe = await js(`
          return {
            有开始按钮: document.body.innerText.includes('开始战斗'),
            有添加参战者: document.body.innerText.includes('添加参战者'),
          };`);
        console.log('[shot] 玩家战斗页探针：', JSON.stringify(combatProbe));

        await js(`document.querySelectorAll('.tab')[2]?.click(); return true;`);
        await sleep(900);
        await shoot('4-sheet');

        await js(`document.querySelectorAll('.tab')[3]?.click(); return true;`);
        await sleep(900);
        await shoot('5-notes');
        const notesProbe = await js(`
          return {
            有开始新场次: document.body.innerText.includes('开始新场次'),
            有数据目录卡: document.body.innerText.includes('可直接用文本编辑器打开'),
          };`);
        console.log('[shot] 玩家笔记页探针：', JSON.stringify(notesProbe));
      } catch (err) {
        console.error('[shot] 玩家流程出错：', err && err.stack || err);
      } finally {
        app.quit();
      }
    });
  }

  // 开发辅助：--screenshot <目录> 遍历战役与标签页截图，用于快速核对界面
  const shotIdx = process.argv.indexOf('--screenshot');
  if (shotIdx >= 0) {
    const outDir = path.resolve(process.argv[shotIdx + 1] || 'shots');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
      await sleep(2400);
      console.log('[random-walking] 开始截图 →', outDir);
      fs.mkdirSync(outDir, { recursive: true });

      // 等渲染进程真正完成启动：应用要先跑几轮 IPC 才会把顶栏渲染出来，
      // 固定 sleep 会打在空白页面上，必须轮询。
      const waitFor = async (expr, timeout = 20000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
          const ok = await mainWindow.webContents.executeJavaScript(`!!(${expr})`).catch(() => false);
          if (ok) return true;
          await sleep(250);
        }
        return false;
      };
      if (!await waitFor(`document.querySelector('.topbar > *')`)) {
        console.error('[random-walking] 应用未在超时内完成启动');
        app.quit();
        return;
      }
      await sleep(400);
      const js = (code) => mainWindow.webContents.executeJavaScript(`(() => { ${code} })()`)
        .catch(e => { console.error('[shot]', e.message); return null; });
      const shoot = async (name) => {
        // 窗口必须真的可见并由合成器绘制过，capturePage 才不会返回空图
        mainWindow.show();
        mainWindow.focus();
        mainWindow.moveTop();
        await sleep(350);
        const image = await mainWindow.webContents.capturePage();
        if (image.isEmpty()) { console.error('[shot] 抓到空图：', name); return; }
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
        console.log('[random-walking] 截图：', name);
      };
      const clickTab = (i) => js(`document.querySelectorAll('.tab')[${i}]?.click(); return true;`);
      const pickCampaign = (i) => js(
        `const s = document.querySelectorAll('.topbar select')[0];
         if (!s || !s.options[${i}]) return false;
         s.selectedIndex = ${i}; s.dispatchEvent(new Event('change')); return true;`);
      // 按系统判断当前是哪个战役，不要靠下拉顺序 —— 加了新规则集就会错位
      const currentSystem = () => js(
        `const b = document.querySelector('.topbar .badge');
         if (!b) return '';
         for (const id of ['coc7', 'dnd5e', 'daggerheart', 'huazhu']) {
           if (b.classList.contains(id)) return id;
         }
         return '';`);

      // 逐个战役截图；pickCampaign 返回 false 说明下拉里已经没有这一项了
      for (let c = 0; c < 8; c++) {
        const picked = await pickCampaign(c);
        if (picked === false) {
          if (c === 0) await shoot('welcome');   // 没有战役时截一张欢迎页
          break;
        }
        // 切战役后要等新的战役数据加载完（select 重建）再操作
        await waitFor(`document.querySelectorAll('.tab').length >= 4`);
        await sleep(c === 0 ? 600 : 1000);
        const sys = await currentSystem();

        // 判定页：选一个目标并投掷
        await clickTab(0);
        await sleep(400);
        if (sys === 'coc7') {
          // COC：故意挑一个成功率极低的技能，好触发「孤注一掷」入口
          await js(`[...document.querySelectorAll('.target')].find(b => b.textContent.includes('潜水'))?.click(); return true;`);
        } else {
          await js(`document.querySelectorAll('.target')[3]?.click(); return true;`);
        }
        await sleep(350);
        await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '投掷')?.click(); return true;`);
        await sleep(1100);
        await js(`document.querySelector('.result')?.scrollIntoView({ block: 'center' }); return true;`);
        await sleep(400);
        await shoot(`${c}-dice-${sys}`);

        // 验证孤注一掷与对抗检定确实可用（COC）
        if (sys === 'coc7') {
          const push = await js(`return [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '孤注一掷') ? '出现' : '未出现';`);
          console.log('[shot] 孤注一掷按钮：', push);
          await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '对抗')?.click(); return true;`);
          await sleep(1100);
          await js(`document.querySelector('.result')?.scrollIntoView({ block: 'center' }); return true;`);
          await sleep(400);
          const opposed = await js(`return document.querySelector('.result')?.innerText.includes('vs') ? '已渲染' : '未渲染';`);
          console.log('[shot] 对抗检定结果：', opposed);
          await shoot(`${c}-opposed`);
        }

        // 战斗页：拉入全部角色 + 几个杂兵，掷先攻并开打
        await clickTab(1);
        await sleep(500);
        await js(`
          let guard = 0;
          while (document.querySelector('.tabview .target') && guard++ < 12) {
            document.querySelector('.tabview .target').click();
          }
          const addNpc = (name, hp, ac) => {
            const ni = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('杂兵'));
            if (!ni) return false;
            ni.value = name;
            const hpi = document.querySelector('input[title="生命上限"]');
            const aci = document.querySelector('input[title="防御值"]');
            if (hpi) hpi.value = hp;
            if (aci) aci.value = ac;
            const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '＋ 添加');
            if (!btn) return false;
            btn.click();
            return true;
          };
          addNpc('哥布林 A', 7, 15);
          addNpc('哥布林 B', 7, 15);
          addNpc('哥布林头目', 21, 17);
          return true;
        `);
        await sleep(600);
        await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('全部掷先攻'))?.click(); return true;`);
        await sleep(600);
        await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '开始战斗')?.click(); return true;`);
        await sleep(700);
        // 打两下，让血条有变化
        await js(`
          const rows = [...document.querySelectorAll('.tabview .btn')].filter(b => b.textContent.trim() === '−5');
          rows.forEach((b, i) => { if (i % 2 === 0) b.click(); });
          return true;
        `);
        await sleep(700);
        await shoot(`${c}-combat`);

        await clickTab(2);
        await sleep(600);
        // DND：点一次死亡豁免，确认投掷并写进日志
        if (sys === 'dnd5e') {
          const clicked = await js(`const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('投掷死亡豁免')); if (!b) return false; b.click(); return true;`);
          await sleep(1100);
          const logged = await js(`return (document.querySelector('.log-item .l-title')?.textContent || '').includes('死亡豁免') ? '已记录' : '未记录';`);
          console.log('[shot] 死亡豁免（点击=' + clicked + '）：', logged);
        }
        // 华渚：确认法门 / 九玄技 / 领域卡三块专属面板都渲染出来了
        if (sys === 'huazhu') {
          const probe = await js(`
            const text = document.body.innerText;
            return [
              text.includes('法门与宗门') ? '法门✓' : '法门✗',
              text.includes('九玄技') ? '九玄技✓' : '九玄技✗',
              text.includes('领域卡') ? '领域卡✓' : '领域卡✗',
              text.includes('位阶') ? '位阶✓' : '位阶✗',
              text.includes('道心经历') ? '道心✓' : '道心✗',
              text.includes('华渚声望') ? '声望✓' : '声望✗',
            ].join(' ');`);
          console.log('[shot] 华渚专属面板：', probe);
          const cls = await js(`return document.querySelector('select.select')?.options?.length || 0;`);
          console.log('[shot] 法门下拉项数：', cls);
        }
        await shoot(`${c}-sheet-${sys}`);

        await clickTab(3);
        await sleep(500);
        await shoot(`${c}-notes`);
      }
      } catch (err) {
        console.error('[random-walking] 截图流程出错：', err && err.stack || err);
      } finally {
        app.quit();
      }
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** 用户选择保存位置并写入导出文件（Electron 弹出系统对话框） */
async function saveFileWithDialog({ filename, content }) {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出复盘记录',
    defaultPath: filename || 'session-export.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '纯文本', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, filePath };
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据目录',
          click: () => shell.openPath(store.root),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '骰式语法速查',
          click: () => mainWindow?.webContents.send('rw:menu', 'dice-help'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  const dataDir = resolveDataDir();
  store = new Store(dataDir);
  table = new Table(store);
  console.log('[random-walking] 数据目录：', store.root);

  const routes = createRoutes({
    store,
    openPath: (p) => shell.openPath(p),
    saveFile: saveFileWithDialog,
  });

  hub = new Hub({
    store,
    routes,
    table,
    // 玩家在浏览器里改的东西，推回本机界面
    onLocal: (msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('rw:sync', msg);
      }
    },
  });

  // 本机界面 = 主持人；牌桌没开时 participant 为 null，即单机模式
  ipcMain.handle('rw:call', async (_evt, op, args = {}) => {
    const participant = table.isOpen ? gmParticipant : null;
    const result = await hub.call(op, args, participant);
    return hub.filterFor(op, result, participant);
  });

  ipcMain.handle('rw:info', () => ({
    mode: 'electron',
    version: app.getVersion(),
    dataDir: store.root,
    platform: process.platform,
    electron: process.versions.electron,
  }));

  ipcMain.handle('rw:table', (_evt, action, payload = {}) => {
    switch (action) {
      case 'open': return openTable(payload.campaignId, payload.gmName);
      case 'close': return closeTable();
      case 'status': return tableInfo();
      case 'seatPlayer': return seatPlayer(payload);
      case 'unseatPlayer': return unseatPlayer(payload);
      default: throw new Error(`未知的牌桌操作：${action}`);
    }
  });

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (table?.isOpen) table.close();
  if (tableServer) tableServer.close();
  if (process.platform !== 'darwin') app.quit();
});
