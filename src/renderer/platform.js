/**
 * 数据访问层：抹平「Electron IPC」与「浏览器 HTTP」两种运行方式的差异。
 * 上层业务代码只认 window.RW 这一套方法。
 */

async function detectBridge() {
  if (globalThis.rwBridge) {
    const info = await globalThis.rwBridge.info();
    return {
      mode: 'electron',
      info,
      call: (op, args) => globalThis.rwBridge.call(op, args),
    };
  }
  const info = await (await fetch('/api/info')).json();
  return {
    mode: 'browser',
    info,
    call: async (op, args) => {
      const res = await fetch('/api/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, args }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `请求失败：${op}`);
      return data.result;
    },
  };
}

const bridge = await detectBridge();

/** 统一的存储调用 */
export const call = (op, args) => bridge.call(op, args);

export const platform = {
  mode: bridge.mode,
  info: bridge.info,
  /** 是否支持弹出系统「另存为」对话框 */
  canSaveDialog: bridge.mode === 'electron',
};

/** 打开数据目录（浏览器模式下由本地服务调起资源管理器） */
export async function openDataDir() {
  return call('openDataDir', {});
}

/** 导出 Markdown：Electron 弹对话框；浏览器模式写到数据目录 exports/ 并提示路径 */
export async function exportMarkdown(cid, opts = {}) {
  const content = await call('exportMarkdown', { cid, opts });
  const filename = `${(opts.filenameHint || 'session-export')}.md`;
  if (bridge.mode === 'electron') {
    return call('saveExport', { filename, content });
  }
  return call('saveExport', { filename, content });
}

export default { call, platform, openDataDir, exportMarkdown };
