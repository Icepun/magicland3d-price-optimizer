/* eslint-disable @typescript-eslint/no-require-imports */

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const next = require("next");
const { autoUpdater } = require("electron-updater");

const isDev = !app.isPackaged;
const defaultPort = Number(process.env.PORT || 3000);
const startUrl = process.env.ELECTRON_START_URL || `http://localhost:${defaultPort}`;

let server;
let isQuittingForUpdate = false;
let updateState = {
  status: "idle",
  message: app.isPackaged
    ? "Guncelleme kontrolu hazir"
    : "Guncelleme sadece paketlenmis uygulamada calisir",
  version: app.getVersion(),
  percent: 0,
};

app.setAppUserModelId("com.magicland3d.trendyol-price-optimizer");

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("updater:status", updateState);
  }
}

function closeNextServer() {
  if (!server) return Promise.resolve();

  const currentServer = server;
  server = undefined;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      currentServer.closeAllConnections?.();
      currentServer.closeIdleConnections?.();
      currentServer.close(finish);
    } catch {
      finish();
    }

    setTimeout(finish, 1500).unref?.();
  });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({ status: "checking", message: "Guncelleme kontrol ediliyor", percent: 0 });
  });
  autoUpdater.on("update-available", (info) => {
    setUpdateState({
      status: "available",
      message: `${info.version} surumu hazir`,
      availableVersion: info.version,
      percent: 0,
    });
  });
  autoUpdater.on("update-not-available", () => {
    setUpdateState({ status: "not-available", message: "Uygulama guncel", percent: 0 });
  });
  autoUpdater.on("download-progress", (progress) => {
    setUpdateState({
      status: "downloading",
      message: "Guncelleme indiriliyor",
      percent: Math.round(progress.percent || 0),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState({
      status: "downloaded",
      message: "Guncelleme indirildi",
      availableVersion: info.version,
      percent: 100,
    });
  });
  autoUpdater.on("error", (error) => {
    setUpdateState({
      status: "error",
      message: error?.message || "Guncelleme kontrolu basarisiz",
      percent: 0,
    });
  });

  ipcMain.handle("updater:get-status", () => updateState);
  ipcMain.handle("updater:check", async () => {
    if (!app.isPackaged) {
      setUpdateState({
        status: "not-available",
        message: "Guncelleme sadece paketlenmis uygulamada calisir",
      });
      return updateState;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Ignore, error handled by the "error" event listener above
    }
    return updateState;
  });
  ipcMain.handle("updater:download", async () => {
    if (!app.isPackaged) return updateState;
    autoUpdater.downloadUpdate().catch(() => {
      // Ignore, error handled by the "error" event listener above
    });
    return updateState;
  });
  ipcMain.handle("updater:quit-and-install", async () => {
    if (app.isPackaged) {
      isQuittingForUpdate = true;
      setUpdateState({
        status: "installing",
        message: "Guncelleme kuruluyor, uygulama kapatiliyor",
        percent: 100,
      });
      await closeNextServer();
      for (const window of BrowserWindow.getAllWindows()) {
        window.removeAllListeners("close");
        window.close();
      }
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
    }
  });
}

function ensureDatabaseUrl() {
  if (!app.isPackaged) return;

  const userDataDir = app.getPath("userData");
  const targetDbPath = path.join(userDataDir, "dev.db");

  if (!fs.existsSync(targetDbPath)) {
    const bundledDbPath = path.join(process.resourcesPath, "prisma", "dev.db");
    if (fs.existsSync(bundledDbPath)) {
      fs.copyFileSync(bundledDbPath, targetDbPath);
    } else {
      // Create an empty file so Prisma's query engine doesn't throw SQLITE_CANTOPEN
      fs.writeFileSync(targetDbPath, "");
    }
  }

  process.env.DATABASE_URL = `file:${targetDbPath.replace(/\\/g, "/")}`;
  backupDatabase(targetDbPath);
}

function backupDatabase(dbPath) {
  try {
    if (!fs.existsSync(dbPath)) return;

    const stats = fs.statSync(dbPath);
    if (stats.size === 0) return;

    const userDataDir = app.getPath("userData");
    const backupsDir = path.join(userDataDir, "backups");
    const version = app.getVersion();
    const markerPath = path.join(backupsDir, `backup-${version}.done`);
    if (fs.existsSync(markerPath)) return;

    fs.mkdirSync(backupsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupsDir, `dev-${version}-${timestamp}.db`);
    fs.copyFileSync(dbPath, backupPath);
    fs.writeFileSync(markerPath, backupPath, "utf8");

    const backups = fs
      .readdirSync(backupsDir)
      .filter((name) => name.startsWith("dev-") && name.endsWith(".db"))
      .map((name) => ({
        name,
        path: path.join(backupsDir, name),
        time: fs.statSync(path.join(backupsDir, name)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time);

    for (const oldBackup of backups.slice(30)) {
      fs.rmSync(oldBackup.path, { force: true });
    }
  } catch {
    // Backup failure must never block app startup.
  }
}

function ensureCredentialKey() {
  if (!app.isPackaged || process.env.TRENDYOL_CREDENTIAL_KEY) return;

  const userDataDir = app.getPath("userData");
  const keyPath = path.join(userDataDir, "trendyol-credentials.key");
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, cryptoRandomHex(), { encoding: "utf8", mode: 0o600 });
  }

  process.env.TRENDYOL_CREDENTIAL_KEY = fs.readFileSync(keyPath, "utf8").trim();
  process.env.TRENDYOL_SETTINGS_FILE = path
    .join(userDataDir, "trendyol-settings.json")
    .replace(/\\/g, "/");
}

function cryptoRandomHex() {
  return require("node:crypto").randomBytes(32).toString("hex");
}

async function findAvailablePort(preferredPort) {
  for (let candidate = preferredPort; candidate < preferredPort + 50; candidate += 1) {
    const available = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => {
        probe.close(() => resolve(true));
      });
      probe.listen(candidate, "127.0.0.1");
    });

    if (available) return candidate;
  }

  throw new Error(`No available port found near ${preferredPort}`);
}

async function startNextServer() {
  if (isDev) return startUrl;

  ensureDatabaseUrl();
  ensureCredentialKey();
  const port = await findAvailablePort(defaultPort);

  const nextApp = next({
    dev: false,
    dir: app.getAppPath(),
    hostname: "127.0.0.1",
    port,
  });
  const handle = nextApp.getRequestHandler();

  await nextApp.prepare();

  server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return `http://127.0.0.1:${port}`;
}

async function createWindow() {
  const url = await startNextServer();

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "Trendyol Price Optimizer",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    shell.openExternal(nextUrl);
    return { action: "deny" };
  });

  await win.loadURL(url);

  if (isDev) {
    win.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(() => {
  setupAutoUpdater();
  return createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", (event) => {
  if (!server) return;

  if (!isQuittingForUpdate) {
    event.preventDefault();
    closeNextServer().finally(() => app.quit());
    return;
  }

  closeNextServer();
});

app.on("will-quit", () => {
  closeNextServer();
});
