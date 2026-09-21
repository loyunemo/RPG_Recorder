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

const APP_ROOT = path.join(__dirname, '..');

/** 决定数据目录：显式环境变量 > 开发期放项目内 > 打包后放用户数据目录 */
function resolveDataDir() {
  if (process.env.RW_DATA_DIR) return path.resolve(process.env.RW_DATA_DIR);
  if (!app.isPackaged) return path.join(APP_ROOT, 'data');
  return path.join(app.getPath('userData'), 'data');
}

let store;
let mainWindow;

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
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'index.html'));

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
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
        console.log('[random-walking] 截图：', name);
      };
      const clickTab = (i) => js(`document.querySelectorAll('.tab')[${i}]?.click(); return true;`);
      const pickCampaign = (i) => js(
        `const s = document.querySelectorAll('.topbar select')[0];
         if (!s || !s.options[${i}]) return false;
         s.selectedIndex = ${i}; s.dispatchEvent(new Event('change')); return true;`);

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

        // 判定页：选一个目标并投掷
        await clickTab(0);
        await sleep(400);
        if (c === 2) {
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
        await shoot(`${c}-dice`);

        // 验证孤注一掷与对抗检定确实可用（COC）
        if (c === 2) {
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
        if (c === 1) {
          const clicked = await js(`const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('投掷死亡豁免')); if (!b) return false; b.click(); return true;`);
          await sleep(1100);
          const logged = await js(`return (document.querySelector('.log-item .l-title')?.textContent || '').includes('死亡豁免') ? '已记录' : '未记录';`);
          console.log('[shot] 死亡豁免（点击=' + clicked + '）：', logged);
        }
        await shoot(`${c}-sheet`);

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
  console.log('[random-walking] 数据目录：', store.root);

  const routes = createRoutes({
    store,
    openPath: (p) => shell.openPath(p),
    saveFile: saveFileWithDialog,
  });

  ipcMain.handle('rw:call', async (_evt, op, args = {}) => {
    const fn = routes[op];
    if (!fn) throw new Error(`未知的存储操作：${op}`);
    return fn(args);
  });

  ipcMain.handle('rw:info', () => ({
    mode: 'electron',
    version: app.getVersion(),
    dataDir: store.root,
    platform: process.platform,
    electron: process.versions.electron,
  }));

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
