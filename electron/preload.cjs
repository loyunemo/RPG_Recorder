/**
 * 预加载脚本：通过 contextBridge 把存储层安全地暴露给渲染进程。
 * 渲染进程拿不到 Node，只能调用下面这些白名单方法。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rwBridge', {
  mode: 'electron',
  role: 'gm',

  /** 统一的存储调用入口：call('readEvents', { cid, opts }) */
  call: (op, args) => ipcRenderer.invoke('rw:call', op, args),

  /** 运行时信息（数据目录、版本等） */
  info: () => ipcRenderer.invoke('rw:info'),

  /** 牌桌操作：open / close / status / seatPlayer / unseatPlayer */
  table: (action, payload) => ipcRenderer.invoke('rw:table', action, payload),

  /**
   * 订阅本机同步事件（玩家在浏览器里改的东西会推回来）。
   * 返回取消订阅的函数。
   */
  onSync: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('rw:sync', handler);
    return () => ipcRenderer.removeListener('rw:sync', handler);
  },

  /** 主进程菜单事件 */
  onMenu: (cb) => {
    ipcRenderer.on('rw:menu', (_e, action) => cb(action));
  },
});
