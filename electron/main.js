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
// userData/ayar/db klasörü bu isme bağlı — ürün adı (productName) değişse bile
// SABİT tut ki kullanıcı verisi (ayarlar, db, gizlenen ürünler) taşınmasın/kaybolmasın.
app.setName("trendyol-price-optimizer");

// =========================================================================
// GLOBAL STARTUP LOGGER — paketlenmiş app'te startup hataları için.
// Log: %APPDATA%/Trendyol Price Optimizer/startup.log
// =========================================================================
function getStartupLogPath() {
  try {
    return path.join(app.getPath("userData"), "startup.log");
  } catch {
    return null;
  }
}
function logStartup(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a)))
    .join(" ")}\n`;
  console.log("[startup]", ...args);
  const p = getStartupLogPath();
  if (p) {
    try {
      fs.appendFileSync(p, line, "utf8");
    } catch {
      /* ignore */
    }
  }
}

// Yakalanmamış hatalarda zorla logla — sessiz crash olmasın
process.on("uncaughtException", (err) => {
  logStartup("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (err) => {
  logStartup("UNHANDLED REJECTION:", err);
});

logStartup("===== Application starting =====");
logStartup("version:", app.getVersion(), "packaged:", app.isPackaged);
logStartup("platform:", process.platform, "node:", process.version);

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

    // Max 800ms bekle, sonra zorla devam et
    setTimeout(finish, 800).unref?.();
  });
}

let isShuttingDown = false;

/**
 * Tek bir kapanış akışı — kullanıcı X'e bastığında, app.quit() çağrıldığında,
 * veya updater "Kur ve Yeniden Başlat" tetiklediğinde hep buradan geçer.
 *
 * Kritik: Next.js + Prisma worker process'leri elektron'un beforeQuit ile
 * temiz kapanmıyor. Bu yüzden sonunda process.exit(0) ile sert kapatma yapıyoruz.
 * Aksi halde installer "uygulama hâlâ açık" diyerek kuruluma izin vermiyor.
 */
async function gracefulShutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Window'ları sert kapat (close listener'larını bypass et)
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.removeAllListeners("close");
      win.destroy();
    } catch {
      // ignore
    }
  }

  // GÜNCELLEME kurulumu: installer'ın dosyaları kilitli bulmaması ve "uygulama
  // kapatılamaz" dialogu çıkmaması için HEMEN çık. Yavaş server kapatmayı bekleme —
  // OS process ölünce socket/dosya handle'larını zaten serbest bırakır.
  if (isQuittingForUpdate) {
    try { server?.closeAllConnections?.(); } catch { /* ignore */ }
    try { app.exit(0); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 50);
    return;
  }

  // HTTP server'ı kapat (max 800ms bekler)
  await Promise.race([
    closeNextServer(),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

  // Zorla exit — child process / worker thread / native handle ne kalmışsa
  // event loop'u beklemeden öldür.
  setTimeout(() => {
    try { app.exit(0); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 100);
  }, 50);
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Write update logs to a file so they are visible in packaged builds.
  // Log file: %APPDATA%\Trendyol Price Optimizer\updater.log
  const logPath = path.join(app.getPath("userData"), "updater.log");
  const writeLog = (...args) => {
    const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`;
    try { fs.appendFileSync(logPath, line, "utf8"); } catch { /* ignore */ }
    console.log("[updater]", ...args);
  };
  autoUpdater.logger = { info: writeLog, warn: writeLog, error: writeLog, debug: writeLog };

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
    const fullMsg = error?.stack || error?.message || "Guncelleme kontrolu basarisiz";
    writeLog("error event:", fullMsg);
    setUpdateState({
      status: "error",
      message: error?.message || "Guncelleme kontrolu basarisiz",
      percent: 0,
    });
  });

  ipcMain.handle("updater:get-status", () => updateState);
  ipcMain.handle("updater:get-log-path", () => logPath);
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
    if (!app.isPackaged) return;

    writeLog("quit-and-install requested");
    isQuittingForUpdate = true;
    setUpdateState({
      status: "installing",
      message: "Güncelleme kuruluyor, uygulama kapatılıyor",
      percent: 100,
    });

    // electron-updater quitAndInstall'ı çağır — internally app.quit() tetikleyecek
    // ve before-quit handler'ımız gracefulShutdown ile arkaplan process'leri öldürecek.
    setImmediate(() => {
      try {
        // SILENT kurulum (isSilent=true): installer /S ile çalışır, açık uygulamayı
        // sessizce zorla kapatır, dosyaları kopyalar, yeniden başlatır. Interaktif
        // modda (false) "uygulama kapatılamaz, Tekrar dene" dialogu çıkıyordu.
        writeLog("calling autoUpdater.quitAndInstall(true, true)");
        autoUpdater.quitAndInstall(true, true);
      } catch (e) {
        writeLog("quitAndInstall threw:", e?.message || e);
        setUpdateState({
          status: "error",
          message: `Kurulum başlatılamadı: ${e?.message || e}`,
          percent: 0,
        });
      }
    });
  });
}

/**
 * Paketli app'te Prisma sorgu motorunun (query_engine-*.node) konumunu açıkça
 * bildirir. webpack generated client'ı .next/server/chunks'a bundle ettiği için
 * Prisma motoru asar içinde arıyor; oysa motor app.asar.unpacked'e çıkarılıyor
 * (asarUnpack). Bu env ile doğru yolu zorla gösteriyoruz → "Query Engine not found"
 * hatası biter. (Hem local hem Turso modunda klasik motor derleme için gerekli.)
 */
function ensurePrismaEngine() {
  if (!app.isPackaged) return;
  try {
    const prismaDir = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "src",
      "generated",
      "prisma"
    );
    if (!fs.existsSync(prismaDir)) {
      logStartup("ensurePrismaEngine: unpacked prisma dir yok:", prismaDir);
      return;
    }
    const engineFile = fs
      .readdirSync(prismaDir)
      .find((f) => f.endsWith(".node") && f.toLowerCase().includes("query"));
    if (engineFile) {
      const enginePath = path.join(prismaDir, engineFile);
      process.env.PRISMA_QUERY_ENGINE_LIBRARY = enginePath;
      logStartup("Prisma engine:", enginePath);
    } else {
      logStartup("ensurePrismaEngine: query engine .node bulunamadı");
    }
  } catch (e) {
    logStartup("ensurePrismaEngine error:", e?.message || e);
  }
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
  if (!app.isPackaged) return;

  const userDataDir = app.getPath("userData");

  // AES-256 master key (Trendyol/Shopify/Hepsiburada credential şifreleme için)
  if (!process.env.TRENDYOL_CREDENTIAL_KEY) {
    const keyPath = path.join(userDataDir, "trendyol-credentials.key");
    if (!fs.existsSync(keyPath)) {
      fs.writeFileSync(keyPath, cryptoRandomHex(), { encoding: "utf8", mode: 0o600 });
    }
    process.env.TRENDYOL_CREDENTIAL_KEY = fs.readFileSync(keyPath, "utf8").trim();
  }

  // Tüm platform settings dosyalarını userData'ya yönlendir.
  // Aksi takdirde process.cwd() (asar içi veya geçici dizin) kullanılır ve
  // her uygulama güncellemesinden sonra ayarlar KAYBOLUR.
  const slashedUserData = userDataDir.replace(/\\/g, "/");
  if (!process.env.TRENDYOL_SETTINGS_FILE) {
    process.env.TRENDYOL_SETTINGS_FILE = `${slashedUserData}/trendyol-settings.json`;
  }
  if (!process.env.SHOPIFY_SETTINGS_FILE) {
    process.env.SHOPIFY_SETTINGS_FILE = `${slashedUserData}/shopify-settings.json`;
  }
  if (!process.env.HEPSIBURADA_SETTINGS_FILE) {
    process.env.HEPSIBURADA_SETTINGS_FILE = `${slashedUserData}/hepsiburada-settings.json`;
  }

  // Turso (bulut DB) ayar dosyası + bağlantı env'leri.
  // turso-settings.json varsa ve url doluysa → prisma Turso'ya bağlanır (çok cihaz
  // senkron). Yoksa local SQLite'a düşer (mevcut davranış).
  const tursoSettingsPath = `${slashedUserData}/turso-settings.json`;
  if (!process.env.TURSO_SETTINGS_FILE) {
    process.env.TURSO_SETTINGS_FILE = tursoSettingsPath;
  }
  try {
    const tursoRaw = fs.readFileSync(path.join(userDataDir, "turso-settings.json"), "utf8");
    const turso = JSON.parse(tursoRaw);
    if (turso && turso.url) {
      process.env.TURSO_DATABASE_URL = turso.url;
      if (turso.authToken) process.env.TURSO_AUTH_TOKEN = turso.authToken;
      // Embedded replica: yerel kopya dosyası. Okumalar buradan (anında), yazmalar
      // buluta yazılır + periyodik senkronla diğer cihazın değişiklikleri çekilir.
      process.env.TURSO_REPLICA_PATH = `${slashedUserData}/turso-replica.db`;
      logStartup("Turso bulut DB aktif (embedded replica):", turso.url);
    }
  } catch {
    // dosya yok → local SQLite (mevcut davranış)
  }
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

  logStartup("startNextServer: ensuring db url");
  ensureDatabaseUrl();
  logStartup("startNextServer: ensuring prisma engine");
  ensurePrismaEngine();
  logStartup("startNextServer: ensuring credential key");
  ensureCredentialKey();
  logStartup("startNextServer: finding port");
  const port = await findAvailablePort(defaultPort);
  logStartup("startNextServer: port =", port);

  logStartup("startNextServer: creating Next.js instance");
  const nextApp = next({
    dev: false,
    dir: app.getAppPath(),
    hostname: "127.0.0.1",
    port,
  });
  const handle = nextApp.getRequestHandler();

  logStartup("startNextServer: preparing Next.js");
  await nextApp.prepare();
  logStartup("startNextServer: Next.js prepared");

  server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  logStartup("startNextServer: HTTP server listening on", port);

  return `http://127.0.0.1:${port}`;
}

async function createWindow() {
  logStartup("createWindow: starting next server");
  const url = await startNextServer();
  logStartup("createWindow: URL =", url);

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "Magicland 3D Hub",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    backgroundColor: "#1B1E2A",
    autoHideMenuBar: true,
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

  logStartup("createWindow: loading URL");
  try {
    await win.loadURL(url);
    logStartup("createWindow: URL loaded ✓");
  } catch (e) {
    logStartup("createWindow: loadURL failed:", e);
    // Yine de window'u kapatma — kullanıcı en azından boş pencere görsün
    win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          "<html><body style='font-family:sans-serif;padding:32px;background:#1B1E2A;color:#fff'>" +
            "<h2>Uygulama başlatılırken hata oluştu</h2>" +
            "<p>Detaylar: %APPDATA%/Trendyol Price Optimizer/startup.log</p>" +
            `<pre>${String(e)}</pre>` +
            "</body></html>"
        )
    );
  }

  if (isDev) {
    win.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(async () => {
  logStartup("app whenReady fired");
  try {
    setupAutoUpdater();
    logStartup("setupAutoUpdater done");
    await createWindow();
    logStartup("createWindow done ✓");
  } catch (e) {
    logStartup("FATAL during startup:", e);
    // Hata olursa basit bir error window aç
    try {
      const errWin = new BrowserWindow({
        width: 800,
        height: 500,
        backgroundColor: "#1B1E2A",
        title: "Hata",
      });
      errWin.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            `<html><body style="font-family:sans-serif;padding:32px;background:#1B1E2A;color:#fff">
              <h2>Uygulama başlatılamadı</h2>
              <p>Log dosyası: <code>%APPDATA%\\Trendyol Price Optimizer\\startup.log</code></p>
              <pre style="background:#0d0d17;padding:16px;border-radius:8px;overflow:auto;max-height:300px">${String(
                e?.stack || e
              )}</pre>
              <p style="margin-top:24px">Bu pencereyi kapatabilirsin. Lütfen log dosyasını paylaş.</p>
            </body></html>`
          )
      );
    } catch (innerErr) {
      logStartup("error window creation also failed:", innerErr);
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    gracefulShutdown("window-all-closed");
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", (event) => {
  if (isShuttingDown) return; // ikinci tur, izin ver
  if (!server) return; // server yoksa normal akış
  event.preventDefault();
  gracefulShutdown(isQuittingForUpdate ? "update-install" : "before-quit");
});

// Son güvenlik: hiçbir koşulda process arkada kalmasın
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
