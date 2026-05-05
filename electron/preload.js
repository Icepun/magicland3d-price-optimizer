/* eslint-disable @typescript-eslint/no-require-imports */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trendyolPriceOptimizer", {
  platform: process.platform,
  updater: {
    getStatus: () => ipcRenderer.invoke("updater:get-status"),
    checkForUpdates: () => ipcRenderer.invoke("updater:check"),
    downloadUpdate: () => ipcRenderer.invoke("updater:download"),
    quitAndInstall: () => ipcRenderer.invoke("updater:quit-and-install"),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on("updater:status", listener);
      return () => ipcRenderer.removeListener("updater:status", listener);
    },
  },
});
