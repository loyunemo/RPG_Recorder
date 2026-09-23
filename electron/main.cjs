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
const { readConfig, writeConfig, rememberDir, forgetDir, normalizedRecent, probeDir, copyTree } = require('./config.cjs');
const { Table, lanAddress } = require('../server/table.cjs');
const { Hub } = require('../server/hub.cjs');
const { createTableServer } = require('../server/http.cjs');

const APP_ROOT = path.join(__dirname, '..');

/** 配置放在 userData 下 —— 它记录的是「数据放哪」，不能放进数据目录本身 */
const configFile = () => path.join(app.getPath('userData'), 'config.json');

/** 没指定过目录时的默认位置 */
function defaultDataDir() {
  return app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(APP_ROOT, 'data');
}

/**
 * 决定数据目录。优先级：
 *   1. `--data-dir=<路径>` 命令行参数（便携版、快捷方式、脚本用）
 *   2. `RW_DATA_DIR` 环境变量
 *   3. 配置文件里用户指定过的目录
 *   4. 默认位置
 * @returns {{dir:string, source:'cli'|'env'|'config'|'default'}}
 */
function resolveDataDir() {
  const arg = process.argv.find(a => a.startsWith('--data-dir='));
  if (arg) return { dir: path.resolve(arg.slice('--data-dir='.length)), source: 'cli' };
  if (process.env.RW_DATA_DIR) return { dir: path.resolve(process.env.RW_DATA_DIR), source: 'env' };
  const cfg = readConfig(configFile());
  if (cfg.dataDir) return { dir: path.resolve(cfg.dataDir), source: 'config' };
  return { dir: defaultDataDir(), source: 'default' };
}

let store;
let routes;             // 操作路由（切换数据目录时会重建）
let mainWindow;
let table;              // 牌桌（多人）
let hub;                // 调用与广播的唯一入口
let gmParticipant;      // 本机 GM 在牌桌上的身份
let tableServer;        // 开桌后才启动的 HTTP + SSE 服务
let tablePort = Number(process.env.RW_PORT || 41777);
let dataDirInfo = { dir: '', source: 'default' };

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

  // 开发辅助：--shot-wizard <目录> 打开车卡向导，逐步截图
  const wizIdx = process.argv.indexOf('--shot-wizard');
  if (wizIdx >= 0) {
    const outDir = path.resolve(process.argv[wizIdx + 1] || 'wizard-shots');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    mainWindow.webContents.once('did-finish-load', async () => {
      const js = (code) => mainWindow.webContents.executeJavaScript(`(() => { ${code} })()`)
        .catch(e => { console.error('[wiz]', e.message); return null; });
      const shoot = async (name) => {
        mainWindow.show(); mainWindow.focus(); mainWindow.moveTop();
        await sleep(320);
        const img = await mainWindow.webContents.capturePage();
        if (img.isEmpty()) { console.error('[wiz] 空图：', name); return; }
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
        console.log('[wiz] 截图：', name);
      };

      try {
        await sleep(2600);
        const count = await js(`return document.querySelectorAll('.topbar select')[0]?.options.length || 0;`);
        for (let c = 0; c < (count || 1); c++) {
          await js(`const s=document.querySelectorAll('.topbar select')[0];
                    if(!s||!s.options[${c}])return false;
                    s.selectedIndex=${c}; s.dispatchEvent(new Event('change')); return true;`);
          await sleep(1400);
          const sys = await js(`const b=document.querySelector('.topbar .badge'); if(!b)return '';
            for(const id of ['coc7','dnd5e','daggerheart','huazhu']) if(b.classList.contains(id)) return id; return '';`);

          // 打开车卡向导
          const opened = await js(`
            const btns = [...document.querySelectorAll('button')];
            const b = btns.find(x => x.textContent.includes('新角色') || x.textContent.trim() === '＋');
            if (!b) return false; b.click(); return true;`);
          if (!opened) { console.log('[wiz] ' + sys + '：找不到新建按钮'); continue; }
          await sleep(700);

          // 第一步必须填名字，「下一步」才会解禁
          await js(`
            const ni = document.querySelector('.modal input.input');
            if (ni && !ni.value) {
              ni.value = '测试角色';
              ni.dispatchEvent(new Event('input', { bubbles: true }));
              ni.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;`);
          await sleep(500);

          // 逐步走一遍
          const steps = [];
          for (let i = 0; i < 5; i++) {
            await shoot(`${c}-${sys}-step${i + 1}`);

            // 记录「技能与领域」这一步有没有领域卡可选
            const probe = await js(`
              const groups = document.querySelectorAll('.modal optgroup');
              const opts = groups.length ? [...groups].reduce((n,g)=>n+g.children.length,0) : 0;
              const picker = [...document.querySelectorAll('.modal select')].some(s =>
                (s.options[0]?.textContent || '').includes('添加领域卡'));
              return { 领域卡选项: opts, 有领域选择器: picker };`);
            if (probe && probe.有领域选择器) {
              console.log(`[wiz] ${sys} 第${i + 1}步：领域选择器 ✓，可选 ${probe.领域卡选项} 张`);
            }

            const next = await js(`
              const btns = [...document.querySelectorAll('.modal button')];
              const n = btns.find(b => b.textContent.trim() === '下一步');
              if (n && !n.disabled) { n.click(); return 'next'; }
              if (btns.some(b => b.textContent.trim() === '完成车卡')) return 'last';
              if (n) return 'blocked';
              return 'stop';`);
            steps.push(next);
            if (next !== 'next') break;
            await sleep(600);
          }
          console.log('[wiz] ' + sys + ' 步骤流转：' + steps.join(' → '));

          // 关掉弹窗 —— 必须点「取消」，第一个按钮可能是「上一步」，点了不会关
          await js(`
            const b = [...document.querySelectorAll('.modal-foot button')]
              .find(x => x.textContent.trim() === '取消');
            if (b) b.click();
            return true;`);
          await sleep(400);
        }
      } catch (err) {
        console.error('[wiz] 出错：', err && err.stack || err);
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
        // 给每张角色卡都加上该系统的一个预设行动，好让战斗里的行动条有内容
        const pcCount = await js(`return document.querySelectorAll('.pc-card').length;`);
        for (let p = 0; p < (pcCount || 0); p++) {
          await js(`document.querySelectorAll('.pc-card')[${p}]?.click(); return true;`);
          await waitFor(`[...document.querySelectorAll('.card h3')].some(x => x.textContent.startsWith('行动'))`, 8000);
          await sleep(300);
          const picked = await js(`
            const card = [...document.querySelectorAll('.card')]
              .find(c => c.querySelector('h3')?.textContent.startsWith('行动'));
            if (!card) return null;
            const sel = [...card.querySelectorAll('select.select')]
              .find(s => [...s.options].some(o => o.textContent.startsWith('＋ 从预设添加')));
            if (!sel) return null;
            const opt = [...sel.options].find(o => o.value);
            if (!opt) return null;
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change'));
            return opt.value;`);
          await sleep(500);
          if (p === 0) console.log(`[shot] 角色卡行动预设：${pcCount} 张卡，首个添加「${picked}」`);
        }
        await sleep(400);
        await shoot(`${c}-sheet-${sys}`);

        // 回到战斗页：行动条应该有内容，且能按下并写进日志
        await clickTab(1);
        await sleep(600);
        const bar = await js(`
          const btns = [...document.querySelectorAll('.action-btn')];
          return { count: btns.length, names: btns.map(b => b.dataset.action).slice(0, 4).join(' / ') };`);
        // 当前行动者可能没声明行动（比如刚加进来的杂兵），往后翻几个回合找一个有的
        let turns = 0;
        while (!(await js(`return document.querySelectorAll('.action-btn').length > 0;`)) && turns < 8) {
          await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('下一回合'))?.click(); return true;`);
          await sleep(450);
          turns++;
        }
        const nowOn = await js(`
          const btns = [...document.querySelectorAll('.action-btn')];
          return { count: btns.length, names: btns.map(b => b.dataset.action).slice(0, 4).join(' / ') };`);
        console.log(`[shot] 行动条按钮：开局 ${bar?.count ?? 0} 个，跳过 ${turns} 个回合后 ${nowOn?.count ?? 0} 个`
          + `${nowOn?.names ? ' → ' + nowOn.names : ''}`);
        const before = await js(`return document.body.innerText;`);
        const used = await js(`
          const b = document.querySelector('.action-btn');
          if (!b) return null;
          b.click();
          return b.dataset.action;`);
        await sleep(1300);
        const after = await js(`return document.body.innerText;`);
        const logged = await js(`return document.querySelector('.log-item .l-title')?.textContent || '';`);
        console.log(`[shot] 按下行动「${used}」，最新日志：${logged || '（无）'}`);
        console.log('[shot] 结算后界面发生变化：', before !== after ? '是' : '否');
        const spent = await js(`
          const all = [...document.querySelectorAll('.action-btn')];
          return {
            total: all.length,
            spent: all.filter(b => b.dataset.spent === '1').length,
            disabled: all.filter(b => b.disabled).length,
          };`);
        console.log(`[shot] 用掉后行动条：${spent?.total ?? 0} 个按钮，其中已用 ${spent?.spent ?? 0} 个（禁用 ${spent?.disabled ?? 0} 个）`);
        await shoot(`${c}-actionbar`);

        // 推一个回合，行动经济应该刷新回来
        await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('下一回合'))?.click(); return true;`);
        await sleep(600);
        const after2 = await js(`
          const all = [...document.querySelectorAll('.action-btn')];
          return all.filter(b => b.dataset.spent === '1').length;`);
        console.log('[shot] 推进回合后仍在「已用」状态的按钮：', after2);

        // 战斗进行中，判定页应被收敛为「只能从已声明的行动里选」
        await clickTab(0);
        await sleep(500);
        const locked = await js(
          `return document.body.innerText.includes('战斗中的判定只能通过它声明的行动来结算') ? '已锁定' : '未锁定';`);
        console.log('[shot] 判定页战斗锁定：', locked);
        await shoot(`${c}-dice-locked`);

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
  dataDirInfo = resolveDataDir();
  store = new Store(dataDirInfo.dir);
  table = new Table(store);
  console.log('[random-walking] 数据目录：', store.root, `（来源：${dataDirInfo.source}）`);

  routes = createRoutes({
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

  /** 用新的数据目录重建 Store / 路由 / Hub，然后刷新界面 */
  function swapDataDir(newDir) {
    if (newDir === store.root) return;
    if (table.isOpen) table.close();          // 换目录等于换战役，牌桌必须先关
    gmParticipant = null;

    store = new Store(newDir);
    routes = createRoutes({
      store,
      openPath: (p) => shell.openPath(p),
      saveFile: saveFileWithDialog,
    });
    hub = new Hub({
      store,
      routes,
      table: new Table(store),               // 牌桌也换成新的 Store
      onLocal: (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rw:sync', msg);
      },
    });
    table = hub.table;
    dataDirInfo = { dir: newDir, source: 'config' };
    console.log('[random-walking] 数据目录已切换：', newDir);

    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  }

  ipcMain.handle('rw:dataDir', (_evt, action, payload = {}) => {
    switch (action) {
      case 'info': {
        const probe = probeDir(store.root);
        return {
          current: store.root,
          source: dataDirInfo.source,
          defaultDir: defaultDataDir(),
          configFile: configFile(),
          // 归一化后再给界面，免得当前目录重复出现在「最近使用」里
          recent: normalizedRecent(configFile()),
          writable: probe.ok,
          reason: probe.reason || '',
          lockedBy: dataDirInfo.source === 'cli' ? '命令行参数 --data-dir'
            : dataDirInfo.source === 'env' ? '环境变量 RW_DATA_DIR' : '',
        };
      }

      case 'pick': {
        return dialog.showOpenDialog(mainWindow, {
          title: '选择数据目录',
          message: '选择一个文件夹来存放战役数据（可以直接新建）',
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: '用这个目录',
        }).then(r => (r.canceled || !r.filePaths.length ? null : r.filePaths[0]));
      }

      case 'check': {
        const probe = probeDir(payload.dir || '');
        return probe;
      }

      case 'set': {
        const probe = probeDir(payload.dir || '');
        if (!probe.ok) throw new Error(probe.reason);

        // 需要搬迁时先复制，复制成功再切 —— 复制失败就什么都不动
        let copied = 0;
        if (payload.migrate && probe.dir !== store.root) {
          copied = copyTree(store.root, probe.dir);
        }

        writeConfig(configFile(), { dataDir: probe.dir });
        rememberDir(configFile(), probe.dir);
        swapDataDir(probe.dir);
        return { ok: true, dir: probe.dir, copied, hadData: probe.hasData };
      }

      case 'reset': {
        // 回到默认位置
        writeConfig(configFile(), { dataDir: '' });
        swapDataDir(defaultDataDir());
        return { ok: true, dir: defaultDataDir() };
      }

      case 'forget': {
        const cfg = forgetDir(configFile(), payload.dir || '');
        return { ok: true, recent: cfg.recentDirs };
      }

      case 'reveal':
        return shell.openPath(store.root).then(() => true);

      default:
        throw new Error(`未知的数据目录操作：${action}`);
    }
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
    dataDirSource: dataDirInfo.source,
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
