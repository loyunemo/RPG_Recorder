/**
 * 存储路由：把 op 名映射到 Store 方法。
 * Electron 主进程与本地 HTTP 服务共用这一份，保证两种运行方式行为完全一致。
 *
 * @param {object} deps { store, openPath, saveFile }
 */

function createRoutes({ store, openPath, saveFile }) {
  return {
    dataDir: () => store.root,
    openDataDir: async () => { await openPath(store.root); return true; },

    listCampaigns: () => store.listCampaigns(),
    createCampaign: (a) => store.createCampaign(a),
    getCampaign: (a) => store.getCampaign(a.cid),
    updateCampaign: (a) => store.updateCampaign(a.cid, a.patch),
    deleteCampaign: (a) => store.deleteCampaign(a.cid),
    stats: (a) => store.stats(a.cid),

    listCharacters: (a) => store.listCharacters(a.cid),
    getCharacter: (a) => store.getCharacter(a.cid, a.id),
    saveCharacter: (a) => store.saveCharacter(a.cid, a.character, a.opts || {}),
    deleteCharacter: (a) => store.deleteCharacter(a.cid, a.id),

    listSessions: (a) => store.listSessions(a.cid),
    createSession: (a) => store.createSession(a.cid, a.payload || {}),
    endSession: (a) => store.endSession(a.cid, a.sid),
    setActiveSession: (a) => store.setActiveSession(a.cid, a.sid),

    getState: (a) => store.getState(a.cid),
    saveState: (a) => store.saveState(a.cid, a.patch || {}),

    appendEvents: (a) => store.appendEvents(a.cid, a.sid, a.events),
    readEvents: (a) => store.readEvents(a.cid, a.opts || {}),
    getEvent: (a) => store.getEvent(a.cid, a.eventId),
    exportMarkdown: (a) => store.exportMarkdown(a.cid, a.opts || {}),
    exportArchive: (a) => store.exportArchive(a.cid),

    saveExport: (a) => saveFile({ filename: a.filename, content: a.content }),
  };
}

module.exports = { createRoutes };
