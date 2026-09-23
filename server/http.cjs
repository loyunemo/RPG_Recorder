/**
 * 共用的 HTTP + SSE 服务。
 *
 * - `server/server.cjs`（npm run serve）直接用它
 * - Electron 主进程在「开启牌桌」时用它，这样 GM 用桌面端、玩家用浏览器，共用一份数据
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { lanAddress } = require('./table.cjs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJSON(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, rel));
  if (!p.startsWith(root)) return null;
  return p;
}

/** 角色卡的一句话摘要，仅供加入界面的名册展示（不含任何数值） */
function summariseCharacter(c) {
  const d = c.data || {};
  const parts = [];
  if (c.system === 'coc7') {
    if (d.occupation) parts.push(d.occupation);
    if (d.age) parts.push(`${d.age} 岁`);
  } else if (c.system === 'dnd5e') {
    for (const v of [d.race, d.className, d.level ? `Lv${d.level}` : '']) if (v) parts.push(v);
  } else {
    for (const v of [d.ancestry, d.community, d.className, d.level ? `Lv${d.level}` : '']) if (v) parts.push(v);
  }
  return parts.join(' · ');
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.hub
 * @param {object} deps.table
 * @param {string} deps.appRoot
 * @param {number} [deps.port]
 */
function createTableServer({ store, hub, table, appRoot, port = 41777, dataDirMeta = {} }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    // SSE 不设超时，否则长连接会被掐断
    if (url.pathname === '/api/stream') req.setTimeout(0);

    // 安全：牌桌未开启时，只允许本机访问。
    // 服务监听 0.0.0.0 是为了让局域网里的玩家能接入，
    // 但单机模式不做鉴权，因此必须挡住来自其它机器的请求。
    const remote = req.socket.remoteAddress || '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1'
      || remote === '::ffff:127.0.0.1' || remote.startsWith('127.');
    if (!isLoopback && !table.isOpen) {
      return sendJSON(res, 403, { error: '牌桌尚未开启。请主持人先在应用里开启牌桌。' });
    }

    try {
      /* ── 基础信息 ── */
      if (url.pathname === '/api/info') {
        return sendJSON(res, 200, {
          mode: 'browser',
          version: '0.5.1',
          dataDir: store.root,
          // 浏览器模式改不了数据目录，把「怎么改」和当前来源告诉界面
          dataDirSource: dataDirMeta.source || 'default',
          defaultDir: dataDirMeta.defaultDir || '',
          platform: process.platform,
          node: process.versions.node,
          tableOpen: table.isOpen,
          joinUrl: table.isOpen ? `http://${lanAddress()}:${port}/` : null,
          campaignId: table.campaignId,
        });
      }

      /* ── 开桌 / 关桌 ── */
      if (url.pathname === '/api/table/open' && req.method === 'POST') {
        const body = await readBody(req);
        const { campaign, gm } = table.open(body.campaignId, body.gmName || '主持人');
        return sendJSON(res, 200, {
          ok: true,
          token: gm.token,
          campaign,
          joinUrl: `http://${lanAddress()}:${port}/`,
          lanAddress: lanAddress(),
          port,
        });
      }

      if (url.pathname === '/api/table/close' && req.method === 'POST') {
        const token = req.headers['x-rw-token'];
        const p = table.authenticate(token);
        if (table.isOpen && p?.role !== 'gm') return sendJSON(res, 403, { error: '只有主持人能关闭牌桌' });
        table.close();
        return sendJSON(res, 200, { ok: true });
      }

      if (url.pathname === '/api/table/status') {
        return sendJSON(res, 200, {
          open: table.isOpen,
          campaignId: table.campaignId,
          openedAt: table.openedAt,
          joinUrl: table.isOpen ? `http://${lanAddress()}:${port}/` : null,
          presence: table.isOpen ? table.presence() : [],
        });
      }

      /**
       * 加入前需要看到的名册：战役名、可认领的角色、以及每张卡被谁占了。
       * 只暴露必要字段，不含角色卡内容 —— 玩家在拿到令牌之前不该读到任何数据。
       */
      if (url.pathname === '/api/table/roster') {
        if (!table.isOpen) return sendJSON(res, 200, { open: false });
        const cid = table.campaignId;
        const campaign = store.getCampaign(cid);
        const seats = store.getState(cid).seats || {};
        const ownerOf = {};
        for (const [pid, seat] of Object.entries(seats)) {
          for (const charId of seat.characterIds || []) ownerOf[charId] = { playerId: pid, name: seat.name };
        }
        return sendJSON(res, 200, {
          open: true,
          campaign: { id: cid, name: campaign?.name, system: campaign?.system },
          characters: store.listCharacters(cid).map(c => ({
            id: c.id,
            name: c.name,
            system: c.system,
            summary: summariseCharacter(c),
            claimedBy: ownerOf[c.id] || null,
          })),
          // 「已在场」只列当前真正连着的人，而不是历史上留下过的所有席位
          players: table.presence().map(p => ({ playerId: p.playerId, name: p.name, online: p.online })),
        });
      }

      /* ── 玩家加入 ── */
      if (url.pathname === '/api/join' && req.method === 'POST') {
        const body = await readBody(req);
        const { participant, rejected, campaign } = table.join(body);
        return sendJSON(res, 200, { ok: true, token: participant.token, participant, rejected, campaign });
      }

      if (url.pathname === '/api/claim' && req.method === 'POST') {
        const body = await readBody(req);
        const token = req.headers['x-rw-token'] || body.token;
        const p = table.authenticate(token);
        if (!p) return sendJSON(res, 401, { error: '会话已过期，请重新加入' });
        const result = table.claim(token, body.characterIds || []);
        return sendJSON(res, 200, { ok: true, ...result });
      }

      /* ── SSE 实时推送 ── */
      if (url.pathname === '/api/stream') {
        const token = url.searchParams.get('token');
        const participant = table.authenticate(token);
        if (table.isOpen && !participant) {
          return sendJSON(res, 401, { error: '会话已过期，请重新加入牌桌' });
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        if (table.isOpen) {
          table.addClient(res, participant, token);
          req.on('close', () => table.removeClient(res));
        } else {
          // 牌桌没开也要保持连接，等 GM 开桌时自动收到通知
          res.write('event: idle\ndata: {}\n\n');
          req.on('close', () => {});
        }
        return undefined;
      }

      /* ── 统一调用入口 ── */
      if (url.pathname === '/api/call' && req.method === 'POST') {
        const body = await readBody(req);
        const op = body.op;
        const args = body.args || {};
        const token = req.headers['x-rw-token'] || body.token;

        let participant = null;
        if (table.isOpen) {
          participant = table.authenticate(token);
          if (!participant) return sendJSON(res, 401, { error: '会话已过期，请重新加入牌桌' });
        }

        const result = await hub.call(op, args, participant);
        return sendJSON(res, 200, { ok: true, result: hub.filterFor(op, result, participant) });
      }

      /* ── Markdown 导出下载 ── */
      if (url.pathname === '/api/download') {
        const cid = url.searchParams.get('cid') || table.campaignId;
        const sid = url.searchParams.get('sid') || undefined;
        const md = store.exportMarkdown(cid, { sessionId: sid });
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="export-${Date.now()}.md"`,
        });
        return res.end(md);
      }

      /* ── 静态资源：只暴露 src/ ── */
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') {
        res.writeHead(302, { Location: '/src/renderer/index.html' });
        return res.end();
      }
      if (!rel.startsWith('/src/') || rel.includes('..')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      const file = safeJoin(appRoot, rel);
      if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      const bodyBuf = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      return res.end(bodyBuf);
    } catch (err) {
      const code = err.code === 'FORBIDDEN' ? 403 : 500;
      if (code === 500) console.error('[random-walking] 请求出错：', err);
      return sendJSON(res, code, { error: String((err && err.message) || err) });
    }
  });

  return server;
}

module.exports = { createTableServer, lanAddress };
