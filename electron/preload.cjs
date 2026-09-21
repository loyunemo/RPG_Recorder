/**
 * 预加载脚本：通过 contextBridge 把存储层安全地暴露给渲染进程。
 * 渲染进程拿不到 Node，只能调用下面这些白名单方法。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rwBridge', {
  mode: 'electron',

  /** 统一的存储调用入口：call('readEvents', { cid, opts }) */
  call: (op, args) => ipcRenderer.invoke('rw:call', op, args),

  /** 运行时信息（数据目录、版本等） */
  info: () => ipcRenderer.invoke('rw:info'),

  /** 主进程菜单事件 */
  onMenu: (cb) => {
    ipcRenderer.on('rw:menu', (_e, action) => cb(action));
  },
});
