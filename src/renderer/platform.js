/**
 * 数据访问层：抹平「Electron IPC」与「浏览器 HTTP」两种运行方式的差异，
 * 并在多人模式下承担身份、令牌与实时订阅。
 *
 * 上层业务代码只认这里导出的这一套方法。
 */

const TOKEN_KEY = 'rw:token';
const PLAYER_KEY = 'rw:playerId';

/* ────────────────────────── 事件订阅 ────────────────────────── */

const listeners = new Set();

/** 订阅服务端推送；返回取消订阅的函数 */
export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(msg) {
  for (const cb of [...listeners]) {
    try { cb(msg); } catch (err) { console.error('[sync] 处理推送出错：', err); }
  }
}

/* ────────────────────────── 通道探测 ────────────────────────── */

async function detectBridge() {
  if (globalThis.rwBridge) {
    const info = await globalThis.rwBridge.info();
    globalThis.rwBridge.onSync?.(emit);
    return {
      mode: 'electron',
      info,
      role: 'gm',
      tableOpen: false,
      call: (op, args) => globalThis.rwBridge.call(op, args),
      table: (action, payload) => globalThis.rwBridge.table(action, payload),
      dataDir: (action, payload) => globalThis.rwBridge.dataDir(action, payload),
      join: null,
      connectStream: null,
    };
  }
  const info = await (await fetch('/api/info')).json();
  return {
    mode: 'browser',
    info,
    // 牌桌没开还能访问 = 本机主持人；牌桌开了则需要令牌才确定身份
    role: info.tableOpen ? null : 'gm',
    tableOpen: !!info.tableOpen,
    call: browserCall,
    table: browserTable,
    dataDir: browserDataDir,
    join: browserJoin,
    connectStream: connectBrowserStream,
  };
}

/* ────────────────────────── 浏览器实现 ────────────────────────── */

const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));
export const getPlayerId = () => localStorage.getItem(PLAYER_KEY) || '';
export const setPlayerId = (id) => localStorage.setItem(PLAYER_KEY, id);

async function api(pathname, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['X-RW-Token'] = token;

  const res = await fetch(pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败：${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function browserCall(op, args) {
  const data = await api('/api/call', { method: 'POST', body: { op, args } });
  return data.result;
}

async function browserTable(action, payload = {}) {
  switch (action) {
    case 'status':
      return api('/api/table/status');
    case 'open': {
      const data = await api('/api/table/open', { method: 'POST', body: payload });
      setToken(data.token);
      return data;
    }
    case 'close': {
      const data = await api('/api/table/close', { method: 'POST', body: {} });
      setToken(null);
      return data;
    }
    case 'leave':
      setToken(null);
      return { ok: true };
    case 'claim':
      return api('/api/claim', { method: 'POST', body: payload });
    default:
      throw new Error(`未知的牌桌操作：${action}`);
  }
}

/**
 * 浏览器模式下的数据目录操作。
 *
 * 数据目录由服务端进程决定（`--data-dir` 参数或 `RW_DATA_DIR` 环境变量），
 * 浏览器改不了 —— 这里只做只读展示，把改法告诉用户。
 */
async function browserDataDir(action) {
  const info = await (await fetch('/api/info')).json();
  if (action === 'info') {
    return {
      current: info.dataDir,
      source: info.dataDirSource || 'default',
      defaultDir: info.defaultDir || '',
      recent: [],
      writable: true,
      canChange: false,
      hint: '浏览器模式下数据目录由启动服务时决定，请用 '
        + '`npm run serve -- --data-dir=<路径>` 或设置环境变量 RW_DATA_DIR。',
    };
  }
  if (action === 'reveal') return api('/api/call', { method: 'POST', body: { op: 'openDataDir', args: {} } });
  throw new Error('浏览器模式下无法更改数据目录');
}

async function browserJoin({ name, characterIds = [] }) {  const data = await api('/api/join', {
    method: 'POST',
    body: { playerId: getPlayerId() || undefined, name, characterIds },
  });
  setToken(data.token);
  setPlayerId(data.participant.playerId);
  return data;
}

let eventSource = null;

function connectBrowserStream() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  const token = getToken() || '';
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
  eventSource = es;

  const relay = (type) => (e) => {
    try { emit({ type, payload: JSON.parse(e.data) }); }
    catch { emit({ type, payload: null }); }
  };

  for (const t of ['hello', 'events', 'character', 'combat', 'changed', 'presence', 'closed']) {
    es.addEventListener(t, relay(t));
  }
  es.onopen = () => emit({ type: 'connection', payload: { state: 'online' } });
  es.onerror = () => {
    // EventSource 会自动重连，这里只把状态告诉界面
    emit({ type: 'connection', payload: { state: es.readyState === 2 ? 'reconnecting' : 'offline' } });
  };
  return () => es.close();
}

/* ────────────────────────── 对外接口 ────────────────────────── */

const bridge = await detectBridge();

export const call = (op, args) => bridge.call(op, args);

export const platform = {
  mode: bridge.mode,
  info: bridge.info,
  get role() { return bridge.role; },
  set role(v) { bridge.role = v; },
  get tableOpen() { return bridge.tableOpen; },
  set tableOpen(v) { bridge.tableOpen = v; },
  /** 是否拥有主持人权限，决定界面上哪些操作可用 */
  get isGm() { return bridge.role === 'gm'; },
  canSaveDialog: bridge.mode === 'electron',
};

/** 牌桌操作：open / close / status / claim / leave */
export async function tableAction(action, payload = {}) {
  if (!bridge.table) return { open: false };
  return bridge.table(action, payload);
}

/** 数据目录操作：info / pick / check / set / reset / forget / reveal */
export async function dataDirAction(action, payload = {}) {
  if (!bridge.dataDir) return { current: platform.info.dataDir, canChange: false };
  return bridge.dataDir(action, payload);
}

/** 玩家加入牌桌（桌面端无需，本机即主持人） */
export async function joinTable(payload) {
  if (!bridge.join) throw new Error('桌面端无需加入，本机即主持人');
  return bridge.join(payload);
}

/** 建立实时连接；返回断开函数 */
export function connectStream() {
  if (bridge.connectStream) return bridge.connectStream();
  return () => {};
}

export async function openDataDir() {
  return call('openDataDir', {});
}

/** 导出 Markdown：Electron 弹对话框；浏览器模式写到数据目录 exports/ */
export async function exportMarkdown(cid, opts = {}) {
  const content = await call('exportMarkdown', { cid, opts });
  const filename = `${(opts.filenameHint || 'session-export')}.md`;
  return call('saveExport', { filename, content });
}

export default {
  call, platform, subscribe, tableAction, dataDirAction,
  joinTable, connectStream, openDataDir, exportMarkdown,
};
