/* eslint-disable @typescript-eslint/no-require-imports */

const { app, BrowserWindow, ipcMain, shell, powerMonitor, Tray, Menu } = require("electron");
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
// Tepsi (tray) modu: pencere X'i uygulamayı KAPATMAZ, arka plana alır — relay + sipariş izleyici
// çalışmaya devam eder → bildirimler uygulama "kapalıyken" de zamanında düşer.
let tray = null;
let trayBalloonShown = false; // "arka planda çalışıyor" bilgisi oturumda bir kez
let quitRequested = false; // tepsiden "Çık" → gerçek kapanış niyeti
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

// ── Tek-instance kilidi ──────────────────────────────────────────────────────
// Aynı userData/ayar/cache dosyalarına iki masaüstü sürecinin eşzamanlı yazmasını önle.
// İkinci instance hemen çıkar; mevcut pencere öne getirilir.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  logStartup("İkinci instance tespit edildi — çıkılıyor (single-instance lock)");
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

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

  // Yeni DB/relay işi başlatma. Özellikle macOS updater uygulamayı kapatırken devam eden
  // embedded-replica işi bırakmak bir sonraki açılışta native libSQL kilidine dönüşebiliyor.
  globalThis.__MLHUB_DB_PAUSED__ = true;
  try { tray?.destroy(); } catch { /* ignore */ }

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
    // Güncelleme yolu server/DB'nin gerçekten durmasını beklemeden sert çıkar. Bu oturumu
    // "temiz" sayma; yeni sürüm aktif sync marker'ı yoksa hızlı yerel replica'yı korur.
    try { fs.rmSync(path.join(app.getPath("userData"), ".clean-exit"), { force: true }); } catch { /* ignore */ }
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

  // Bayrağı ancak server kapanış denemesi bittikten sonra yaz. Eski kod bunu fonksiyonun
  // başında yazdığı için updater/force-exit sırasında yarım kalan replica da yanlışlıkla
  // "temiz" kabul ediliyordu. Sync marker kaldıysa yine temiz sayma.
  const userDataDir = app.getPath("userData");
  const replicaPath = process.env.TURSO_REPLICA_PATH;
  const syncStillRunning = replicaPath && fs.existsSync(`${replicaPath}.sync-in-progress`);
  try {
    const cleanFlag = path.join(userDataDir, ".clean-exit");
    if (syncStillRunning) fs.rmSync(cleanFlag, { force: true });
    else fs.writeFileSync(cleanFlag, `${Date.now()} ${reason}`, "utf8");
  } catch { /* kapanışı log/marker hatasıyla bloke etme */ }

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
      transferred: progress.transferred || 0,
      total: progress.total || 0,
      bytesPerSecond: progress.bytesPerSecond || 0,
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
  if (!process.env.MLHUB_ORDERS_CACHE_FILE) {
    process.env.MLHUB_ORDERS_CACHE_FILE = `${slashedUserData}/orders-cache.json`;
  }
  if (!process.env.MLHUB_ROUTE_CACHE_DIR) {
    process.env.MLHUB_ROUTE_CACHE_DIR = `${slashedUserData}/route-cache`;
  }

  // Turso (bulut DB) ayar dosyası + bağlantı env'leri.
  // Native embedded replica gerçek paket içinde SQL'i/ana Electron event-loop'unu tekrar
  // kilitleyebildi (0.19.125). Bu nedenle paketli uygulama onu HİÇ açmaz: bütün bulut I/O
  // asenkron HTTP'dir; ağır ekranlar kalıcı SWR disk önbelleğinden anında gösterilir.
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
      delete process.env.TURSO_REPLICA_PATH;
      process.env.TURSO_DISABLE_EMBEDDED_REPLICA = "1";
      logStartup("Turso bulut DB aktif (uzak HTTP + kalıcı SWR disk cache):", turso.url);
    }
  } catch {
    // dosya yok → local SQLite (mevcut davranış)
  }
}

function cryptoRandomHex() {
  return require("node:crypto").randomBytes(32).toString("hex");
}

/** Replica'nın yan dosyaları (-wal/-shm/-info/-client_wal_index/… + kendi marker'ımız).
 *  Dizin taranır: liste SABİT DEĞİL → libsql ileride yeni uzantı eklerse o da yakalanır. */
function listReplicaSidecars(replicaPath) {
  const dir = path.dirname(replicaPath);
  const base = path.basename(replicaPath);
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(base) && f !== base);
  } catch {
    // Dizin okunamadı → bilinen uzantılara düş.
    return ["-wal", "-shm", "-info", "-client_wal_index"]
      .map((s) => base + s)
      .filter((f) => {
        try { return fs.existsSync(path.join(dir, f)); } catch { return false; }
      });
  }
}

/**
 * Replica dosyalarını GÜVENLİ SIRAYLA siler: önce TÜM yan dosyalar, EN SON ana .db.
 *
 * Sıra hayati: libsql "metadata var ama db yok" durumunu ONULMAZ sayar
 * (Sync(InvalidLocalState("metadata file exists but db file does not"))) → HER bağlantı
 * patlar, uygulama kalıcı açılamaz. Ana db ÖNCE silinirse ve silme yarıda kesilirse
 * (kapanma/çökme/güç) tam o duruma düşülür — v0.19.112'de yaşandı: panel "veriler
 * yüklenemedi". Yan dosyalar önce gidip db sona kalınca, yarıda kesilme "db var, metadata
 * yok" bırakır; libsql bunu taze senkronla kendiliğinden toparlar.
 */
function resetReplicaFiles(replicaPath) {
  const dir = path.dirname(replicaPath);
  for (const f of listReplicaSidecars(replicaPath)) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* silinemezse devam */ }
  }
  try { fs.rmSync(replicaPath, { force: true }); } catch { /* silinemezse normal akış dener */ }
}

/**
 * BOZUK REPLICA KENDİNİ İYİLEŞTİRME — "Mac'te açılıştan ~3sn sonra sonsuz donma"nın kalıcı fix'i.
 *
 * Kök neden (sample kanıtlı): turso-replica.db bozuk duruma düşünce (donma sırasında zorla
 * kapatma vb.) libsql'in native sync/YAZMA çağrısı ana thread'de SONSUZA DEK bekliyor
 * (index.node → __psynch_cvwait) → Electron ana süreci = UI + Node aynı thread → her şey donar.
 * Okumalar çalıştığı için basit SELECT yoklaması yetmez; süreç-içi timeout da işlemez (loop bloke).
 *
 * Artık normal oturumda native sync() çağrılmadığı için sürüm değişimi veya sert kapanış
 * tek başına replica'yı şüpheli yapmaz. Dosyayı her güncellemede silmek, sonraki açılışta
 * 6+ MB tam senkron başlatıp uygulamayı yeniden yavaşlatıyordu. Yalnız gerçekten yarım
 * kalmış bir ilk senkron işareti ya da ana DB'siz yetim metadata varsa sıfırla.
 */
async function ensureReplicaHealthy() {
  const replicaPath = process.env.TURSO_REPLICA_PATH;
  if (!replicaPath || !process.env.TURSO_DATABASE_URL) return;

  const userDataDir = app.getPath("userData");
  const cleanFlag = path.join(userDataDir, ".clean-exit");
  const versionFlag = path.join(userDataDir, ".replica-app-version");
  const syncFlag = `${replicaPath}.sync-in-progress`;
  const currentVersion = app.getVersion();
  let previousVersion = "";
  try { previousVersion = fs.readFileSync(versionFlag, "utf8").trim(); } catch { /* ilk çalıştırma */ }
  const versionChanged = previousVersion !== currentVersion;
  const interruptedSync = fs.existsSync(syncFlag);
  const wasClean = fs.existsSync(cleanFlag) && !interruptedSync;

  // Bayrak oturum başında tüketilir. Bu oturum doğal şekilde kapanmazsa bir sonraki açılış
  // replica'yı şüpheli kabul eder. Sürüm damgası da karar verildikten hemen sonra güncellenir.
  try { fs.rmSync(cleanFlag, { force: true }); } catch { /* ignore */ }
  try { fs.writeFileSync(versionFlag, currentVersion, "utf8"); } catch { /* karar yine uygulanır */ }

  if (!fs.existsSync(replicaPath)) {
    // Ana db YOK ama yan dosya kalmışsa bu "ilk kurulum" DEĞİL — yarım kalmış silme/senkron.
    // libsql bu durumda Sync(InvalidLocalState) atıp HER bağlantıyı reddeder; temizlenmezse
    // uygulama KALICI olarak açılamaz (v0.19.112: panel "veriler yüklenemedi", API'ler 500).
    // Yetimleri süpür → libsql temiz sayfadan taze senkron yapar.
    const orphans = listReplicaSidecars(replicaPath);
    if (orphans.length > 0) {
      logStartup("YETİM replica metadata (db yok) → temizleniyor:", orphans.join(", "));
      resetReplicaFiles(replicaPath);
    }
    return; // yoklanacak db yok
  }

  // Yarım kalan tek native işlem ilk kurulum senkronudur; marker varsa dosyayı korumak
  // libSQL InvalidLocalState/kilit döngüsüne sokabilir. Bu dar durumda yeniden oluştur.
  if (interruptedSync) {
    logStartup("replica güvenli yeniden oluşturulacak: yarım ilk senkron işareti var");
    resetReplicaFiles(replicaPath);
    return;
  }

  const notes = [];
  if (versionChanged) notes.push(`sürüm ${previousVersion || "bilinmiyor"} → ${currentVersion}`);
  if (!wasClean) notes.push("önceki oturum sert kapandı");
  logStartup(
    notes.length
      ? `replica korundu (${notes.join(", ")}; aktif sync yok)`
      : "replica korundu (yerel hızlı okuma)"
  );
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
  logStartup("startNextServer: replica health check");
  await ensureReplicaHealthy();
  logStartup("startNextServer: finding port");
  const port = await findAvailablePort(defaultPort);
  logStartup("startNextServer: port =", port);
  // Sunucu içi periyodik işler (sipariş izleyici) kendi API'sini bu porttan çağırır.
  process.env.MLHUB_PORT = String(port);

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

  // ISINDIRMA: pencere yüklenirken kritik rotaları arka planda tetikle → route + Prisma planı
  // sıcakken istemci sorguları anında döner (boş iskelet süresi kısalır). Non-blocking.
  if (!isDev) {
    try {
      void fetch(`${url}/api/dashboard`, { cache: "no-store" }).catch(() => {});
      void fetch(`${url}/api/notifications`, { cache: "no-store" }).catch(() => {});
    } catch { /* fetch yoksa/eski runtime — önemsiz */ }
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "Magicland 3D Hub",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    backgroundColor: "#1B1E2A",
    autoHideMenuBar: true,
    // BOŞ pencere gösterme: içerik ilk boyamaya hazır olunca görün (aşağıda ready-to-show).
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => { try { win.show(); } catch { /* ignore */ } });
  // Fail-safe: her ne olursa olsun 15sn'de pencere görünür (ready-to-show gelmezse bile).
  setTimeout(() => {
    try { if (!win.isDestroyed() && !win.isVisible()) win.show(); } catch { /* ignore */ }
  }, 15000);

  // TEPSİ MODU: X'e basmak uygulamayı KAPATMAZ — arka plana alır (bildirimler zamanında düşsün
  // diye relay + sipariş izleyici yaşamaya devam eder). Gerçek kapanış: tepsi menüsü "Çık",
  // güncelleme kurulumu veya gracefulShutdown (o yol close listener'larını zaten bypass eder).
  win.on("close", (e) => {
    if (isShuttingDown || isQuittingForUpdate || quitRequested) return;
    e.preventDefault();
    try { win.hide(); } catch { /* ignore */ }
    if (tray && !trayBalloonShown) {
      trayBalloonShown = true;
      try {
        tray.displayBalloon?.({
          title: "Magicland 3D Hub",
          content: "Arka planda çalışmaya devam ediyor — bildirimler gelmeye devam eder. Kapatmak için tepsi simgesine sağ tıkla.",
        });
      } catch { /* balon desteklenmiyorsa sessiz */ }
    }
  });

  win.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    shell.openExternal(nextUrl);
    return { action: "deny" };
  });

  // Renderer (web) tarafındaki konsol/hata/çökmeleri ana sürece logla.
  // Boş-ekran teşhisi için kritik; sahada da renderer çökmesini görünür kılar.
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    // level: 0=verbose 1=info 2=warning 3=error
    if (level >= 2) {
      logStartup("[renderer]", `(${level}) ${message} @ ${sourceId}:${line}`);
    }
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    logStartup("[renderer] render-process-gone:", JSON.stringify(details));
  });
  win.webContents.on("unresponsive", () => {
    logStartup("[renderer] unresponsive");
  });
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    logStartup("[renderer] preload-error:", preloadPath, String(error));
  });
  win.webContents.on("did-fail-load", (_e, code, desc, validatedURL) => {
    logStartup("[renderer] did-fail-load:", code, desc, validatedURL);
  });

  // ── Uyku/uyanma DONMA koruması (dark-wake YARIŞINA dayanıklı) ───────────────
  // Geçmiş sorun: Mac uyurken/uyanırken libSQL embedded-replica'nın native sync() çağrısı
  // ölü bağlantıda asılıp ana event-loop'u DONDURUYORDU (native çağrı, timeout yok).
  // ÖNEMLİ (Mac'e özgü): macOS uykudayken periyodik "dark wake" (Power Nap) yapar → resume sonra
  // hemen suspend gelir. Eski sabit-süreli grace timer sonraki suspend ile iptal edilmediği için
  // UYKU SIRASINDA flag'i false yapıp ağ işlerini çalıştırıyordu. (Windows dark-wake yapmaz.)
  // Native sync artık tamamen kaldırıldı; bu koruma yine de relay'in uzak ağ isteklerinin uyku
  // geçişlerinde gereksiz yere birikmesini önler. Her power olayı "gen" sayacını artırır.
  if (!globalThis.__MLHUB_POWER_HOOKED__) {
    globalThis.__MLHUB_POWER_HOOKED__ = true;
    globalThis.__MLHUB_DB_PAUSED__ = false;
    let powerGen = 0;

    // Turso bulut erişilebilir mi? libsql:// → https://, 2.5sn timeout. (Local modda hep true.)
    const tursoReachable = async () => {
      const u = process.env.TURSO_DATABASE_URL;
      if (!u) return true;
      const httpUrl = u.replace(/^libsql:\/\//i, "https://").replace(/^wss?:\/\//i, "https://");
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      try { await fetch(httpUrl, { method: "GET", signal: ctrl.signal, cache: "no-store" }); return true; }
      catch { return false; }
      finally { clearTimeout(t); }
    };

    powerMonitor.on("suspend", () => {
      powerGen++; // bekleyen TÜM resume timer'larını geçersiz kıl (dark-wake yarışı engellenir)
      globalThis.__MLHUB_DB_PAUSED__ = true;
      logStartup("[power] suspend → DB duraklatıldı (gen " + powerGen + ")");
    });

    powerMonitor.on("resume", () => {
      const myGen = ++powerGen;
      // Bazı işletim sistemi/uyku akışlarında suspend olayı kaçsa bile relay çevrimdışı açılmasın.
      globalThis.__MLHUB_DB_PAUSED__ = true;
      logStartup("[power] resume → DB duraklı, ağ kontrolü (gen " + myGen + ")");
      // Renderer'ı erken tazele (yerel okuma → ağ beklemez) — donmuş UI hızlı kurtulur.
      setTimeout(() => {
        if (myGen !== powerGen) return; // araya yeni power olayı girdi → iptal
        const w = BrowserWindow.getAllWindows()[0];
        if (w && !w.isDestroyed()) { w.webContents.reload(); logStartup("[power] renderer tazelendi"); }
      }, 1500);
      // Relay'i SADECE Turso erişilince sürdür. Araya suspend/resume girerse iptal.
      const startedAt = Date.now();
      let retryDelayMs = 3000;
      let offlineLogged = false;
      const tryResume = async () => {
        if (myGen !== powerGen) return; // dark-wake/yeni olay → bu grace geçersiz, flag duraklı kalır
        let ok = false;
        try { ok = await tursoReachable(); } catch { ok = false; }
        if (myGen !== powerGen) return; // fetch sırasında power olayı olduysa iptal
        if (ok) {
          globalThis.__MLHUB_DB_PAUSED__ = false;
          logStartup("[power] ağ geldi → DB/relay devam (gen " + myGen + ")");
        } else {
          const elapsedMs = Date.now() - startedAt;
          if (elapsedMs >= 45000) {
            if (!offlineLogged) {
              offlineLogged = true;
              logStartup("[power] ağ hâlâ yok → DB/relay duraklı, kontrollü yeniden denenecek (gen " + myGen + ")");
            }
            retryDelayMs = Math.min(Math.max(retryDelayMs, 5000) * 2, 30000);
          }
          setTimeout(tryResume, retryDelayMs);
        }
      };
      setTimeout(tryResume, 3000); // ilk denemeden önce min 3sn
    });
  }

  logStartup("createWindow: loading URL");
  const healFlag = path.join(app.getPath("userData"), ".replica-healed");
  try {
    // Server bozuk embedded replica yüzünden event-loop'u kilitlerse loadURL ASLA dönmez.
    // 30sn timeout ile yakala (sağlıklı yükleme ~2-3sn).
    await Promise.race([
      win.loadURL(url),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("loadURL 30sn'de yanıt vermedi — server kilitli olabilir")),
          30000
        )
      ),
    ]);
    logStartup("createWindow: URL loaded ✓");
    try {
      fs.rmSync(healFlag, { force: true });
    } catch {
      /* başarılı yükleme → heal bayrağını temizle (sonraki gerçek arıza yine onarılabilsin) */
    }
  } catch (e) {
    logStartup("createWindow: loadURL başarısız/timeout:", String(e));
    // SELF-HEAL: en olası sebep bozuk embedded replica (libsql native event-loop kilidi).
    // Replica CACHE'ini temizleyip BİR KEZ yeniden başlat. Turso config + bulut verisi korunur.
    const replicaPath = process.env.TURSO_REPLICA_PATH;
    let healedRecently = false;
    try {
      healedRecently = Date.now() - fs.statSync(healFlag).mtimeMs < 90_000;
    } catch {
      /* bayrak yok */
    }
    if (replicaPath && !healedRecently) {
      try {
        resetReplicaFiles(replicaPath); // yan dosyalar önce, ana db en son (yarıda kesilme güvenli)
        fs.writeFileSync(healFlag, String(Date.now()));
        logStartup("SELF-HEAL: bozuk replica temizlendi → uygulama yeniden başlatılıyor");
        app.relaunch();
        app.exit(0);
        return;
      } catch (healErr) {
        logStartup("SELF-HEAL hatası:", String(healErr));
      }
    }
    // Heal denendi ama hâlâ sorun (veya replica yolu yok) → anlaşılır hata göster
    win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          "<html><body style='font-family:sans-serif;padding:32px;background:#1B1E2A;color:#fff'>" +
            "<h2>Uygulama başlatılamadı</h2>" +
            "<p>Yerel veri önbelleği onarımı denendi ama sorun sürüyor. Uygulamayı kapatıp tekrar açın; sürerse startup.log'u iletin.</p>" +
            `<pre style='color:#F87171;white-space:pre-wrap'>${String(e)}</pre>` +
            "</body></html>"
        )
    );
  }

  if (isDev) {
    win.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return; // ikinci instance — hiçbir kurulum yapma, çıkıyoruz
  logStartup("app whenReady fired");
  try {
    setupAutoUpdater();
    logStartup("setupAutoUpdater done");
    await createWindow();
    logStartup("createWindow done ✓");
    // Tepsi simgesi — pencere gizliyken uygulamaya dönüş + gerçek çıkış buradan.
    try {
      tray = new Tray(path.join(__dirname, "..", "build", "icon.ico"));
      tray.setToolTip("Magicland 3D Hub");
      tray.setContextMenu(Menu.buildFromTemplate([
        {
          label: "Aç",
          click: () => {
            const w = BrowserWindow.getAllWindows()[0];
            if (w && !w.isDestroyed()) { w.show(); if (w.isMinimized()) w.restore(); w.focus(); }
            else void createWindow();
          },
        },
        { type: "separator" },
        {
          label: "Çık",
          click: () => { quitRequested = true; gracefulShutdown("tray-quit"); },
        },
      ]));
      tray.on("click", () => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w && !w.isDestroyed()) { w.show(); if (w.isMinimized()) w.restore(); w.focus(); }
        else void createWindow();
      });
      logStartup("tray hazır ✓");
    } catch (trayErr) {
      logStartup("tray kurulamadı (önemsiz):", String(trayErr));
    }
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
