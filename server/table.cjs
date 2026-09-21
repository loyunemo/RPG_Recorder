/**
 * 牌桌：多人同步的核心。
 *
 * 模型
 *   GM 在一台机器上「开桌」，这台机器就是服务端；玩家用浏览器接入同一个局域网地址。
 *   服务端 → 客户端用 SSE 推送（浏览器原生 EventSource，自动重连）；
 *   客户端 → 服务端用普通 POST。因此不需要 WebSocket，也不需要任何外部依赖。
 *
 * 身份
 *   playerId  持久身份，存在玩家浏览器的 localStorage，用于认领角色卡、跨场次保留席位
 *   token     会话凭据，每次连接重新签发，用于鉴权与断线识别
 *
 * 权限
 *   GM   可做任何事，包括隐藏掷骰、改战斗、管所有角色卡
 *   玩家 只能改自己认领的角色卡、只能掷自己角色的骰、只能记笔记与场景，
 *        并且看不到 visibility 为 gm 的事件
 */

const crypto = require('node:crypto');

/** 玩家允许写入的事件类型 */
const PLAYER_EVENT_TYPES = new Set(['note', 'scene', 'roll']);

/** 玩家允许写入的战役状态字段 */
const PLAYER_STATE_KEYS = new Set(['selectedCharacterId']);

const nowISO = () => new Date().toISOString();
const newToken = () => crypto.randomBytes(16).toString('hex');

/** 需要有人主持才能玩的牌桌 */
class Table {
  constructor(store) {
    this.store = store;
    this.campaignId = null;
    this.openedAt = null;
    /** token -> participant */
    this.sessions = new Map();
    /** response -> { participant, token }（SSE 长连接） */
    this.clients = new Map();
    this.heartbeat = null;
    this.version = 0;
  }

  get isOpen() {
    return !!this.campaignId;
  }

  /* ───────────────────────── 开桌 / 关桌 ───────────────────────── */

  open(campaignId, gmName = '主持人') {
    const campaign = this.store.getCampaign(campaignId);
    if (!campaign) throw new Error(`战役不存在：${campaignId}`);

    this.campaignId = campaignId;
    this.openedAt = nowISO();

    const gm = {
      token: newToken(),
      playerId: 'gm-local',
      name: gmName,
      role: 'gm',
      characterIds: [],
      joinedAt: nowISO(),
      lastSeen: nowISO(),
      online: true,
    };
    this.sessions.set(gm.token, gm);

    this.heartbeat = setInterval(() => this.tick(), 25000);
    if (this.heartbeat.unref) this.heartbeat.unref();

    return { campaign, gm };
  }

  close() {
    this.broadcast('closed', { reason: '主持人关闭了牌桌' });
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.clients.forEach((_v, res) => { try { res.end(); } catch { /* 已断开 */ } });
    this.clients.clear();
    this.sessions.clear();
    this.campaignId = null;
    this.openedAt = null;
  }

  /* ───────────────────────── 加入 / 离开 ───────────────────────── */

  /**
   * 玩家加入。
   * @param {object} req { playerId, name, characterIds }
   */
  join({ playerId, name, characterIds = [] }) {
    if (!this.isOpen) throw new Error('牌桌尚未开启，请向主持人索取开局链接');

    const pid = playerId || `p_${crypto.randomBytes(6).toString('hex')}`;
    const seats = this.store.getState(this.campaignId).seats || {};
    const known = seats[pid];

    // 认领角色卡：只能认领尚未被别人占用的
    const takenBy = new Map();
    for (const [otherPid, seat] of Object.entries(seats)) {
      if (otherPid === pid) continue;
      for (const cid of seat.characterIds || []) takenBy.set(cid, seat.name);
    }

    const wanted = (characterIds.length ? characterIds : known?.characterIds || []);
    const accepted = [];
    const rejected = [];
    for (const cid of wanted) {
      if (takenBy.has(cid)) rejected.push({ characterId: cid, by: takenBy.get(cid) });
      else accepted.push(cid);
    }

    const participant = {
      token: newToken(),
      playerId: pid,
      name: (name || known?.name || '无名玩家').slice(0, 24),
      role: 'player',
      characterIds: accepted,
      joinedAt: nowISO(),
      lastSeen: nowISO(),
      online: true,
    };
    this.sessions.set(participant.token, participant);

    // 席位落盘，跨场次保留
    seats[pid] = { name: participant.name, characterIds: accepted, lastSeen: participant.lastSeen };
    this.store.saveState(this.campaignId, { seats });

    return { participant, rejected, campaign: this.store.getCampaign(this.campaignId) };
  }

  /** 认领 / 取消认领角色卡 */
  claim(token, characterIds) {
    const p = this.sessions.get(token);
    if (!p) throw new Error('会话已过期，请重新加入');
    if (p.role === 'gm') throw new Error('主持人不需要认领角色卡');

    const seats = this.store.getState(this.campaignId).seats || {};
    const takenBy = new Map();
    for (const [otherPid, seat] of Object.entries(seats)) {
      if (otherPid === p.playerId) continue;
      for (const cid of seat.characterIds || []) takenBy.set(cid, seat.name);
    }

    const accepted = [];
    const rejected = [];
    for (const cid of characterIds) {
      if (takenBy.has(cid)) rejected.push({ characterId: cid, by: takenBy.get(cid) });
      else accepted.push(cid);
    }

    p.characterIds = accepted;
    seats[p.playerId] = { name: p.name, characterIds: accepted, lastSeen: nowISO() };
    this.store.saveState(this.campaignId, { seats });
    this.broadcastPresence();
    return { characterIds: accepted, rejected };
  }

  leave(token) {
    const p = this.sessions.get(token);
    if (!p) return;
    p.online = false;
    p.lastSeen = nowISO();
    this.broadcastPresence();
  }

  authenticate(token) {
    const p = this.sessions.get(token);
    if (p) p.lastSeen = nowISO();
    return p || null;
  }

  /* ───────────────────────── SSE ───────────────────────── */

  addClient(res, participant, token) {
    this.clients.set(res, { participant, token });
    this.send(res, 'hello', this.snapshot(participant));
    this.broadcastPresence();
  }

  removeClient(res) {
    const entry = this.clients.get(res);
    this.clients.delete(res);
    if (entry) {
      // 只有当这个人没有别的连接时才标记离线
      const stillHere = [...this.clients.values()].some(c => c.token === entry.token);
      if (!stillHere) {
        const p = this.sessions.get(entry.token);
        if (p) { p.online = false; p.lastSeen = nowISO(); }
      }
      this.broadcastPresence();
    }
  }

  send(res, type, payload) {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }

  /** 广播给所有在线客户端；filter 可用来做逐人可见性裁剪 */
  broadcast(type, payload, filter) {
    this.version++;
    for (const [res, { participant }] of this.clients) {
      if (filter && !filter(participant)) continue;
      this.send(res, type, payload);
    }
  }

  broadcastPresence() {
    this.broadcast('presence', this.presence());
  }

  tick() {
    for (const [res] of this.clients) {
      try { res.write(': ping\n\n'); } catch { this.clients.delete(res); }
    }
  }

  /* ───────────────────────── 快照与视图 ───────────────────────── */

  /** 新客户端接入时的一次性全量数据 */
  snapshot(participant) {
    const cid = this.campaignId;
    const isGm = participant.role === 'gm';
    return {
      role: participant.role,
      participant: publicParticipant(participant),
      campaign: this.store.getCampaign(cid),
      characters: this.store.listCharacters(cid),
      sessions: this.store.listSessions(cid),
      events: this.store.readEvents(cid, { limit: 300 }).filter(e => isGm || e.visibility !== 'gm'),
      combat: this.store.getState(cid).combat || null,
      presence: this.presence(),
      seats: this.store.getState(cid).seats || {},
    };
  }

  presence() {
    const seen = new Map();
    for (const p of this.sessions.values()) {
      if (p.role === 'gm') continue;
      const online = [...this.clients.values()].some(c => c.token === p.token);
      const prev = seen.get(p.playerId);
      if (!prev || online) {
        seen.set(p.playerId, {
          playerId: p.playerId, name: p.name, online,
          characterIds: p.characterIds, lastSeen: p.lastSeen,
        });
      }
    }
    return [...seen.values()];
  }

  /* ───────────────────────── 权限 ───────────────────────── */

  /**
   * 判断某个操作是否被允许。
   * @returns {{ok:true} | {ok:false, reason:string}}
   */
  authorize(participant, op, args = {}) {
    if (!participant) return { ok: false, reason: '未加入牌桌' };
    if (participant.role === 'gm') return { ok: true };

    const mine = new Set(participant.characterIds);

    switch (op) {
      case 'getCampaign': case 'listCharacters': case 'getCharacter':
      case 'listSessions': case 'getState': case 'stats':
      case 'readEvents': case 'exportMarkdown': case 'exportArchive':
      case 'dataDir': case 'getEvent':
      case 'listCampaigns':
        return { ok: true };

      case 'saveCharacter': {
        const id = args.character?.id;
        if (!id) return { ok: false, reason: '玩家不能新建角色卡，请联系主持人' };
        if (!mine.has(id)) return { ok: false, reason: '这不是你的角色卡' };
        return { ok: true };
      }

      case 'appendEvents': {
        const events = args.events || [];
        for (const e of events) {
          if (!PLAYER_EVENT_TYPES.has(e.type)) {
            return { ok: false, reason: `玩家不能记录「${e.type}」类型的事件` };
          }
          if (e.actor && !mine.has(e.actor)) {
            return { ok: false, reason: '不能替其他角色掷骰或记录' };
          }
          if (e.visibility === 'gm') {
            return { ok: false, reason: '玩家不能发隐藏掷骰' };
          }
        }
        return { ok: true };
      }

      case 'saveState': {
        const keys = Object.keys(args.patch || {});
        const bad = keys.filter(k => !PLAYER_STATE_KEYS.has(k));
        if (bad.length) return { ok: false, reason: `玩家不能修改战役状态字段：${bad.join('、')}` };
        return { ok: true };
      }

      case 'claimCharacters':
        return { ok: true };

      case 'updateCampaign': case 'deleteCampaign': case 'createCampaign':
      case 'createSession': case 'endSession': case 'setActiveSession':
      case 'deleteCharacter':
        return { ok: false, reason: '该操作需要主持人权限' };

      default:
        return { ok: false, reason: `未知操作或需要主持人权限：${op}` };
    }
  }

  /** 读事件时按可见性裁剪 */
  filterEvents(events, participant) {
    if (participant?.role === 'gm') return events;
    return events.filter(e => e.visibility !== 'gm');
  }
}

function publicParticipant(p) {
  return {
    playerId: p.playerId, name: p.name, role: p.role,
    characterIds: p.characterIds, joinedAt: p.joinedAt,
  };
}

/** 取本机在局域网中的 IPv4 地址，用于生成给玩家用的连接地址 */
function lanAddress() {
  const os = require('node:os');
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // 优先常见局域网网段
      const priv = /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a.address);
      candidates.push({ name, address: a.address, priv });
    }
  }
  candidates.sort((a, b) => Number(b.priv) - Number(a.priv));
  return candidates[0]?.address || '127.0.0.1';
}

module.exports = { Table, lanAddress, PLAYER_EVENT_TYPES, PLAYER_STATE_KEYS };
