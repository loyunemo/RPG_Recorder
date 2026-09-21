/**
 * Hub：所有存储调用的唯一入口。
 *
 * 无论是 GM 在桌面端走 IPC，还是玩家在浏览器走 HTTP，最终都经过这里：
 *   1. 鉴权（Table.authorize）
 *   2. 执行存储操作
 *   3. 若发生变更，向所有在线客户端广播
 *
 * 这样两种入口的行为与同步语义完全一致，不会出现「GM 改了玩家看不到」。
 */

const MUTATING = {
  appendEvents: 'events',
  saveCharacter: 'character',
  deleteCharacter: 'characters',
  saveState: 'state',
  createSession: 'sessions',
  endSession: 'sessions',
  setActiveSession: 'sessions',
  updateCampaign: 'campaign',
  createCampaign: 'campaigns',
  deleteCampaign: 'campaigns',
};

class Hub {
  /**
   * @param {object} deps
   * @param {object} deps.store   存储层
   * @param {object} deps.routes  操作路由表
   * @param {object} [deps.table] 牌桌；不传则为单机模式，不做鉴权也不广播
   * @param {(msg:object)=>void} [deps.onLocal] 本地界面（Electron 窗口）的同步回调
   */
  constructor({ store, routes, table = null, onLocal = null }) {
    this.store = store;
    this.routes = routes;
    this.table = table;
    this.onLocal = onLocal;
  }

  /**
   * 执行一次操作。
   * @param {string} op
   * @param {object} args
   * @param {object|null} participant 牌桌参与者；牌桌开启时必填
   */
  async call(op, args = {}, participant = null) {
    const fn = this.routes[op];
    if (!fn) throw new Error(`未知的存储操作：${op}`);

    const multiplayer = this.table?.isOpen;
    if (multiplayer) {
      const verdict = this.table.authorize(participant, op, args);
      if (!verdict.ok) {
        const err = new Error(verdict.reason);
        err.code = 'FORBIDDEN';
        throw err;
      }
    }

    const result = await fn(args);

    if (multiplayer && MUTATING[op]) {
      this.afterMutation(op, args, result, participant);
    }

    return result;
  }

  /** 变更后广播；读操作返回的数据也可能需要按可见性裁剪 */
  afterMutation(op, args, result, participant) {
    const what = MUTATING[op];

    switch (what) {
      case 'events': {
        const events = Array.isArray(result) ? result : [];
        const publicOnes = events.filter(e => e.visibility !== 'gm');
        const payloadBase = { sessionId: args.sid ?? null, by: participant?.name ?? '主持人' };
        // 主持人拿全量，玩家只拿公开的 —— 分两次推，避免在客户端做可见性判断
        this.table.broadcast('events', { ...payloadBase, events }, p => p.role === 'gm');
        if (publicOnes.length) {
          this.table.broadcast('events', { ...payloadBase, events: publicOnes }, p => p.role !== 'gm');
        }
        break;
      }
      case 'character':
        this.table.broadcast('character', { character: result });
        break;
      case 'state':
        if (args.patch && 'combat' in args.patch) {
          this.table.broadcast('combat', { combat: args.patch.combat });
        } else {
          this.table.broadcast('changed', { what: 'state' });
        }
        break;
      default:
        this.table.broadcast('changed', { what: what || op, by: participant?.name ?? '主持人' });
        break;
    }

    // 让本机的 Electron 界面也刷新（玩家在浏览器改的东西，GM 要立刻看到）。
    // participant.local 为真说明这次改动就来自本机界面，无需回灌。
    if (this.onLocal && !participant?.local) {
      try {
        this.onLocal({
          type: what || op,
          payload: { op, args, result, by: participant?.name ?? '主持人' },
        });
      } catch { /* 界面可能已关闭 */ }
    }
  }

  /** 读操作也要按角色裁剪可见性 */
  filterFor(op, result, participant) {
    if (!this.table?.isOpen) return result;
    if (op === 'readEvents') return this.table.filterEvents(result, participant);
    return result;
  }
}

module.exports = { Hub, MUTATING };
