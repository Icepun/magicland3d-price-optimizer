/* eslint-disable @typescript-eslint/no-require-imports */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trendyolPriceOptimizer", {
  platform: process.platform,
  // Pencere görünür mü (tepside / küçültülmüş / ekran kilitli değil)? Arayüz gizliyken
  // yoklamayı ve çizimi bununla durdurur.
  // Bilgisayar uyandı: arayüz verilerini tazeler ve ana sürece "tamam" der. Demezse (donmuş /
  // eski sayfa) ana süreç sayfayı baştan yükler.
  uygulama: {
    onUyanis: (callback) => {
      const listener = () => {
        try {
          callback();
        } finally {
          ipcRenderer.send("app:uyanis-tamam");
        }
      };
      ipcRenderer.on("app:uyanis", listener);
      return () => ipcRenderer.removeListener("app:uyanis", listener);
    },
  },
  pencere: {
    gorunurMu: () => ipcRenderer.invoke("window:is-visible"),
    onGorunur: (callback) => {
      const listener = (_event, gorunur) => callback(Boolean(gorunur));
      ipcRenderer.on("window:visible", listener);
      return () => ipcRenderer.removeListener("window:visible", listener);
    },
  },
  updater: {
    getStatus: () => ipcRenderer.invoke("updater:get-status"),
    getLogPath: () => ipcRenderer.invoke("updater:get-log-path"),
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
