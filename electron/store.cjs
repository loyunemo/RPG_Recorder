/**
 * 存储层（CommonJS，供 Electron 主进程与本地 HTTP 服务共用）。
 *
 * 目录结构：
 *   <root>/index.json                        战役索引
 *   <root>/campaigns/<cid>/campaign.json     战役元数据
 *   <root>/campaigns/<cid>/characters/*.json 角色卡（一卡一文件，便于 diff 与手工修）
 *   <root>/campaigns/<cid>/sessions.json     场次索引
 *   <root>/campaigns/<cid>/log/<sid>.jsonl   事件日志（追加写入，永不改写）
 *
 * 事件日志采用 JSONL 追加写入：任何一次掷骰、改卡、笔记都是一行，
 * 崩溃最多丢最后一行，且可用文本编辑器直接翻阅。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const nowISO = () => new Date().toISOString();
const shortId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写入：先写临时文件再 rename，避免中途崩溃留下半个文件 */
function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function appendLine(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
}

function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // 跳过损坏行，不让一行坏数据毁掉整份日志
    }
  }
  return out;
}

/* ───────────────────────── 深度 diff（记录改卡事件） ───────────────────────── */

function deepDiff(a, b, prefix = '', out = []) {
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      deepDiff(a[k], b[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path: prefix, from: a, to: b });
  }
  return out;
}

class Store {
  constructor(root) {
    this.root = root;
    ensureDir(this.root);
  }

  campaignsDir() { return path.join(this.root, 'campaigns'); }
  campaignDir(cid) { return path.join(this.campaignsDir(), cid); }
  indexPath() { return path.join(this.root, 'index.json'); }
  campaignFile(cid) { return path.join(this.campaignDir(cid), 'campaign.json'); }
  charactersDir(cid) { return path.join(this.campaignDir(cid), 'characters'); }
  characterFile(cid, id) { return path.join(this.charactersDir(cid), `${id}.json`); }
  sessionsFile(cid) { return path.join(this.campaignDir(cid), 'sessions.json'); }
  stateFile(cid) { return path.join(this.campaignDir(cid), 'state.json'); }
  logDir(cid) { return path.join(this.campaignDir(cid), 'log'); }
  logFile(cid, sid) { return path.join(this.logDir(cid), `${sid}.jsonl`); }

  /* ── 战役级状态（战斗序列、骰子宏等可变快照） ── */

  getState(cid) {
    return readJSON(this.stateFile(cid), {});
  }

  /** 浅合并写入，并记录更新时间 */
  saveState(cid, patch) {
    const next = { ...this.getState(cid), ...patch, updatedAt: nowISO() };
    writeJSON(this.stateFile(cid), next);
    return next;
  }

  /* ── 战役 ── */

  listCampaigns() {
    const idx = readJSON(this.indexPath(), { campaigns: [] });
    return (idx.campaigns || []).slice().sort((a, b) => (b.lastPlayedAt || '').localeCompare(a.lastPlayedAt || ''));
  }

  saveIndex(idx) {
    writeJSON(this.indexPath(), idx);
  }

  createCampaign({ name, system = 'coc7', description = '' }) {
    const id = shortId('cmp');
    const campaign = {
      id,
      name: name || '未命名战役',
      system,
      description,
      createdAt: nowISO(),
      lastPlayedAt: nowISO(),
    };
    writeJSON(this.campaignFile(id), campaign);
    ensureDir(this.charactersDir(id));
    ensureDir(this.logDir(id));
    writeJSON(this.sessionsFile(id), { sessions: [], activeSessionId: null });

    const idx = readJSON(this.indexPath(), { campaigns: [] });
    idx.campaigns = idx.campaigns || [];
    idx.campaigns.push({ id, name: campaign.name, system, createdAt: campaign.createdAt, lastPlayedAt: campaign.lastPlayedAt });
    this.saveIndex(idx);

    // 开局事件
    this.appendEvents(id, null, [{
      type: 'system',
      title: `创建战役「${campaign.name}」`,
      detail: `规则系统：${system}`,
    }]);

    return campaign;
  }

  getCampaign(cid) {
    return readJSON(this.campaignFile(cid), null);
  }

  updateCampaign(cid, patch) {
    const cur = this.getCampaign(cid);
    if (!cur) throw new Error(`战役不存在：${cid}`);
    const next = { ...cur, ...patch, id: cid };
    writeJSON(this.campaignFile(cid), next);
    const idx = readJSON(this.indexPath(), { campaigns: [] });
    const entry = (idx.campaigns || []).find(c => c.id === cid);
    if (entry) {
      entry.name = next.name;
      entry.system = next.system;
      entry.lastPlayedAt = next.lastPlayedAt || nowISO();
    }
    this.saveIndex(idx);
    return next;
  }

  deleteCampaign(cid) {
    fs.rmSync(this.campaignDir(cid), { recursive: true, force: true });
    const idx = readJSON(this.indexPath(), { campaigns: [] });
    idx.campaigns = (idx.campaigns || []).filter(c => c.id !== cid);
    this.saveIndex(idx);
    return true;
  }

  /** 存档：把整个战役目录打包成单个 JSON，便于备份或迁移 */
  exportArchive(cid) {
    const campaign = this.getCampaign(cid);
    if (!campaign) throw new Error('战役不存在');
    return {
      format: 'random-walking-archive',
      version: 1,
      exportedAt: nowISO(),
      campaign,
      characters: this.listCharacters(cid),
      sessions: this.listSessions(cid),
      state: this.getState(cid),
      events: this.readEvents(cid, {}),
    };
  }

  /* ── 角色卡 ── */

  listCharacters(cid) {
    const dir = this.charactersDir(cid);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => readJSON(path.join(dir, f), null))
      .filter(Boolean)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }

  getCharacter(cid, id) {
    return readJSON(this.characterFile(cid, id), null);
  }

  saveCharacter(cid, character, opts = {}) {
    const id = character.id || shortId('pc');
    const prev = this.getCharacter(cid, id);
    const next = {
      ...character,
      id,
      campaignId: cid,
      createdAt: prev?.createdAt || nowISO(),
      updatedAt: nowISO(),
    };
    writeJSON(this.characterFile(cid, id), next);

    if (opts.emit !== false && prev) {
      const changes = deepDiff(prev, next).filter(c => !c.path.startsWith('updatedAt'));
      if (changes.length) {
        this.appendEvents(cid, opts.sessionId ?? null, [{
          type: 'sheet',
          actor: id,
          actorName: next.name,
          title: `角色卡更新：${next.name}`,
          detail: changes.slice(0, 40).map(c => `${c.path}: ${fmt(c.from)} → ${fmt(c.to)}`).join('\n'),
          data: { changes },
        }]);
      }
    } else if (opts.emit !== false && !prev) {
      this.appendEvents(cid, opts.sessionId ?? null, [{
        type: 'sheet',
        actor: id,
        actorName: next.name,
        title: `新建角色：${next.name}`,
        detail: `规则系统：${next.system}`,
      }]);
    }
    return next;
  }

  deleteCharacter(cid, id) {
    const cur = this.getCharacter(cid, id);
    fs.rmSync(this.characterFile(cid, id), { force: true });
    if (cur) {
      this.appendEvents(cid, null, [{
        type: 'sheet',
        title: `删除角色：${cur.name}`,
        detail: '',
      }]);
    }
    return true;
  }

  /* ── 场次 ── */

  listSessions(cid) {
    const data = readJSON(this.sessionsFile(cid), { sessions: [], activeSessionId: null });
    return data;
  }

  createSession(cid, { name, note = '' } = {}) {
    const data = this.listSessions(cid);
    const n = (data.sessions || []).length + 1;
    const session = {
      id: shortId('ses'),
      name: name || `第 ${n} 次跑团`,
      index: n,
      note,
      startedAt: nowISO(),
      endedAt: null,
    };
    data.sessions = data.sessions || [];
    data.sessions.push(session);
    data.activeSessionId = session.id;
    writeJSON(this.sessionsFile(cid), data);
    this.appendEvents(cid, session.id, [{
      type: 'session',
      title: `开始场次「${session.name}」`,
      detail: note,
    }]);
    return session;
  }

  endSession(cid, sid) {
    const data = this.listSessions(cid);
    const s = (data.sessions || []).find(x => x.id === sid);
    if (!s) throw new Error(`场次不存在：${sid}`);
    s.endedAt = nowISO();
    if (data.activeSessionId === sid) data.activeSessionId = null;
    writeJSON(this.sessionsFile(cid), data);
    this.appendEvents(cid, sid, [{ type: 'session', title: `结束场次「${s.name}」`, detail: '' }]);
    return s;
  }

  setActiveSession(cid, sid) {
    const data = this.listSessions(cid);
    data.activeSessionId = sid;
    writeJSON(this.sessionsFile(cid), data);
    return data;
  }

  /* ── 事件日志 ── */

  /**
   * 追加事件。sid 为 null 时写入 `_campaign.jsonl`（战役级事件，如建卡）。
   * @returns {Array} 补全了 id / seq / ts 的事件
   */
  appendEvents(cid, sid, events) {
    const file = this.logFile(cid, sid || '_campaign');
    const existing = readLines(file);
    let seq = existing.length;
    const stamped = events.map(e => ({
      id: shortId('ev'),
      seq: ++seq,
      ts: nowISO(),
      campaignId: cid,
      sessionId: sid || null,
      type: e.type || 'note',
      actor: e.actor ?? null,
      actorName: e.actorName ?? null,
      title: e.title ?? '',
      detail: e.detail ?? '',
      tags: e.tags ?? [],
      // 可见性必须保留：多人模式下玩家不该看到 visibility 为 gm 的事件
      visibility: e.visibility === 'gm' ? 'gm' : 'public',
      data: e.data ?? null,
      seed: e.seed ?? e.data?.seed ?? null,
      // 关联到触发它的那条事件（例如孤注一掷挂在原始判定下）
      parentEventId: e.parentEventId ?? e.data?.parentEventId ?? null,
    }));
    ensureDir(this.logDir(cid));
    fs.appendFileSync(file, stamped.map(e => `${JSON.stringify(e)}\n`).join(''), 'utf8');
    return stamped;
  }

  /**
   * 读取事件（合并战役级 + 所有场次），按时间排序。
   * @param {object} opts { sessionId, types, search, actor, limit, since }
   */
  readEvents(cid, opts = {}) {
    const dir = this.logDir(cid);
    if (!fs.existsSync(dir)) return [];
    let files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    if (opts.sessionId) {
      files = files.filter(f => f === `${opts.sessionId}.jsonl` || f === '_campaign.jsonl');
    }
    let all = [];
    for (const f of files) {
      all = all.concat(readLines(path.join(dir, f)));
    }
    all.sort((a, b) => (a.ts || '').localeCompare(b.ts || '') || (a.seq - b.seq));

    if (opts.types?.length) {
      const set = new Set(opts.types);
      all = all.filter(e => set.has(e.type));
    }
    if (opts.actor) {
      all = all.filter(e => e.actor === opts.actor);
    }
    if (opts.since) {
      all = all.filter(e => (e.ts || '') >= opts.since);
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      all = all.filter(e =>
        (e.title || '').toLowerCase().includes(q) ||
        (e.detail || '').toLowerCase().includes(q) ||
        (e.actorName || '').toLowerCase().includes(q));
    }
    if (opts.limit && all.length > opts.limit) all = all.slice(-opts.limit);
    return all;
  }

  /** 依据种子重放一条掷骰事件所需的参数 */
  getEvent(cid, eventId) {
    const dir = this.logDir(cid);
    if (!fs.existsSync(dir)) return null;
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
      const hit = readLines(path.join(dir, f)).find(e => e.id === eventId);
      if (hit) return hit;
    }
    return null;
  }

  /** 导出为 Markdown 复盘文档 */
  exportMarkdown(cid, opts = {}) {
    const campaign = this.getCampaign(cid);
    if (!campaign) throw new Error('战役不存在');
    const events = this.readEvents(cid, { sessionId: opts.sessionId || undefined });
    const sessions = this.listSessions(cid).sessions || [];
    const chars = this.listCharacters(cid);
    const lines = [];
    lines.push(`# ${campaign.name}`);
    lines.push('');
    lines.push(`- 规则系统：${campaign.system}`);
    lines.push(`- 导出时间：${nowISO()}`);
    lines.push(`- 事件总数：${events.length}`);
    lines.push('');
    if (chars.length) {
      lines.push('## 角色');
      lines.push('');
      for (const c of chars) {
        lines.push(`- **${c.name}**（${c.system}）`);
      }
      lines.push('');
    }
    lines.push('## 事件记录');
    lines.push('');
    const TYPE_LABEL = {
      roll: '掷骰', sheet: '角色卡', note: '笔记', scene: '场景',
      session: '场次', system: '系统', combat: '战斗',
    };
    const bySession = new Map();
    for (const e of events) {
      const k = e.sessionId || '_campaign';
      if (!bySession.has(k)) bySession.set(k, []);
      bySession.get(k).push(e);
    }
    for (const [k, list] of bySession) {
      const s = sessions.find(x => x.id === k);
      lines.push(`### ${s ? s.name : '战役级事件'}`);
      lines.push('');
      for (const e of list) {
        const t = new Date(e.ts);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const label = TYPE_LABEL[e.type] || e.type;
        const who = e.actorName ? ` **${e.actorName}**` : '';
        lines.push(`- \`${hh}:${mm}\` [${label}]${who} ${e.title}`);
        if (e.detail) {
          for (const dl of String(e.detail).split('\n')) lines.push(`  - ${dl}`);
        }
        if (e.seed) lines.push(`  - 种子：\`${e.seed}\``);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /** 统计信息，供 UI 概览 */
  stats(cid) {
    const events = this.readEvents(cid, {});
    const byType = {};
    for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
    return {
      events: events.length,
      byType,
      characters: this.listCharacters(cid).length,
      sessions: (this.listSessions(cid).sessions || []).length,
      root: this.root,
    };
  }
}

function fmt(v) {
  if (v === undefined) return '（空）';
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

module.exports = { Store, deepDiff };
