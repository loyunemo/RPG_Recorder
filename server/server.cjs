/**
 * 命令行启动的牌桌服务（`npm run serve`）。
 *
 * 单机模式：主持人自己用浏览器打开，数据照常写入本地目录。
 * 多人模式：在界面里「开启牌桌」后，局域网内的玩家即可用显示的地址接入。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { Store } = require('../electron/store.cjs');
const { createRoutes } = require('../electron/routes.cjs');
const { Table, lanAddress } = require('./table.cjs');
const { Hub } = require('./hub.cjs');
const { createTableServer } = require('./http.cjs');

const APP_ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.RW_PORT || 41777);

/** 与桌面端保持一致的优先级：命令行参数 > 环境变量 > 默认位置 */
function resolveDataDir() {
  const arg = process.argv.find(a => a.startsWith('--data-dir='));
  if (arg) return { dir: path.resolve(arg.slice('--data-dir='.length)), source: 'cli' };
  if (process.env.RW_DATA_DIR) return { dir: path.resolve(process.env.RW_DATA_DIR), source: 'env' };
  return { dir: path.join(APP_ROOT, 'data'), source: 'default' };
}

const dataDirMeta = resolveDataDir();
const DATA_DIR = dataDirMeta.dir;

const store = new Store(DATA_DIR);
const table = new Table(store);

const routes = createRoutes({
  store,
  openPath: (p) => {
    spawn('cmd', ['/c', 'start', '', p], { stdio: 'ignore', detached: true }).unref();
    return Promise.resolve();
  },
  saveFile: async ({ filename, content }) => {
    const dir = path.join(store.root, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const safe = (filename || 'export.md').replace(/[\\/:*?"<>|]/g, '_');
    const filePath = path.join(dir, safe);
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  },
});

const hub = new Hub({ store, routes, table });
const server = createTableServer({
  store, hub, table, appRoot: APP_ROOT, port: PORT,
  dataDirMeta: { source: dataDirMeta.source, defaultDir: path.join(APP_ROOT, 'data') },
});

// 绑定 0.0.0.0 以便局域网玩家接入；牌桌未开启时由 http.cjs 拒绝非本机请求
server.listen(PORT, '0.0.0.0', () => {
  const local = `http://127.0.0.1:${PORT}/`;
  const SRC = { cli: '命令行参数', env: '环境变量 RW_DATA_DIR', default: '默认位置' };
  console.log('[random-walking] 数据目录：', store.root, `（${SRC[dataDirMeta.source]}）`);
  console.log('[random-walking] 本机地址：', local);
  console.log('[random-walking] 局域网地址：', `http://${lanAddress()}:${PORT}/`);
  console.log('[random-walking] 牌桌尚未开启，仅本机可访问。在界面里点「开启牌桌」后玩家才能接入。');
  console.log('[random-walking] 换数据目录：npm run serve -- --data-dir=<路径>');
  if (!process.argv.includes('--no-open')) {
    spawn('cmd', ['/c', 'start', '', local], { stdio: 'ignore', detached: true }).unref();
  }
});

process.on('SIGINT', () => {
  console.log('\n[random-walking] 正在关闭牌桌…');
  if (table.isOpen) table.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
