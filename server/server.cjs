/**
 * 本地 HTTP 服务（浏览器模式兜底）。
 *
 * 当 Electron 二进制不可用时，用 `npm run serve` 也能得到同样的功能：
 * 界面跑在浏览器里，数据仍由 Node 进程写入本地磁盘。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store } = require('../electron/store.cjs');
const { createRoutes } = require('../electron/routes.cjs');

const APP_ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.RW_PORT || 41777);
const DATA_DIR = process.env.RW_DATA_DIR
  ? path.resolve(process.env.RW_DATA_DIR)
  : path.join(APP_ROOT, 'data');

const store = new Store(DATA_DIR);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

const routes = createRoutes({
  store,
  openPath: (p) => {
    spawn('cmd', ['/c', 'start', '', p], { stdio: 'ignore', detached: true }).unref();
    return Promise.resolve();
  },
  saveFile: async ({ filename, content }) => {
    // 浏览器模式没有系统保存对话框，统一写到数据目录的 exports/
    const dir = path.join(store.root, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const safe = (filename || 'export.md').replace(/[\\/:*?"<>|]/g, '_');
    const filePath = path.join(dir, safe);
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  },
});

function sendJSON(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, rel));
  if (!p.startsWith(root)) return null;
  return p;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    if (url.pathname === '/api/info') {
      return sendJSON(res, 200, {
        mode: 'browser',
        version: '0.1.0',
        dataDir: store.root,
        platform: process.platform,
        node: process.versions.node,
      });
    }

    if (url.pathname === '/api/call' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { op, args } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const fn = routes[op];
      if (!fn) return sendJSON(res, 404, { error: `未知操作：${op}` });
      const result = await fn(args || {});
      return sendJSON(res, 200, { ok: true, result });
    }

    if (url.pathname === '/api/download') {
      const cid = url.searchParams.get('cid');
      const sid = url.searchParams.get('sid') || undefined;
      const md = store.exportMarkdown(cid, { sessionId: sid });
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="export-${Date.now()}.md"`,
      });
      return res.end(md);
    }

    // 静态文件
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') {
      // 必须重定向而不是直接返回文件，否则页面内相对路径的资源会全部解析到根目录
      res.writeHead(302, { Location: '/src/renderer/index.html' });
      return res.end();
    }
    // 只暴露 src/ 下的前端资源：数据目录、package.json、node_modules 一律不可访问
    if (!rel.startsWith('/src/') || rel.includes('..')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const file = safeJoin(APP_ROOT, rel);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    return res.end(body);
  } catch (err) {
    console.error('[random-walking] 请求出错：', err);
    return sendJSON(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('[random-walking] 数据目录：', store.root);
  console.log('[random-walking] 服务已启动：', url);
  if (!process.argv.includes('--no-open')) {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  }
});
