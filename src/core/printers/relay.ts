/**
 * Telefon relay'i — masaüstü (LAN'da) tarafında periyodik çalışır:
 *   1) Her yazıcının canlı durumunu PrinterSnapshot'a yazar (değiştiyse) → telefon okur.
 *   2) Bekleyen PrintCommand'leri LAN'da yazıcıya uygular → sonucu yazar.
 *
 * Kullanıcı ekranları yerel replica'dan hızlı okunur; telefonla paylaşılan snapshot ve
 * komut tabloları ayrı remotePrisma client'ıyla doğrudan buluta gider. Burada replica
 * sync ÇALIŞTIRILMAZ: native sync tüm API sorgularını 30+ saniye kilitliyordu.
 *
 * instrumentation.ts (Next sunucu açılışı) tarafından bir kez başlatılır.
 * Yalnızca Turso modunda anlamlıdır; Turso yoksa snapshot/komut tabloları yine çalışır
 * ama uzaktan erişim olmaz (sorun değil).
 */
import { processSingleton } from "./process-singleton";
import fs from "node:fs";
import { prisma, remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { resolveModelFileLocal } from "@/lib/model-files";
import {
  moonrakerControl, moonrakerUploadAndPrint, type MoonrakerState,
} from "./moonraker";
import { bambuControl, mapBambuState } from "./bambu";
import { fileMatchKey } from "./file-match";
import { pickProgress, resolveEta } from "./eta";
import { etaHafizasiOku, etaHafizasiYaz } from "./eta-memory";
import { printJobDisplayName } from "@/lib/print-job-name";
import { tryAcquirePrintLock, releasePrintLock } from "./print-lock";
// Panel API ile PAYLAŞILAN yoklayıcı — aynı yazıcı 5sn (panel) + 10sn (relay) ayrı ayrı
// yoklanmıyor; çevrimdışına backoff + tek-kaçak histerezisi de buradan gelir.
import {
  getMoonrakerStatusCached, getBambuStatusCached, getMoonrakerMetaCached,
  getMoonrakerThumbDataUrl, getPrintFileMatches, invalidatePrintFileMatches,
  SNAPSHOT_IMAGE_MAX_BYTES,
} from "./status-cache";
import { runStorageJanitor } from "@/lib/storage-janitor";
import { pushToAllDevices } from "@/lib/push-notify";
import { dbEpochMs, toDbDate } from "@/lib/sqlite-date";

const TICK_MS = 10_000;
/** Gcode'a gömülü küçük resmin data-URL karakter sınırı (base64 ≈ bayt × 4/3). */
const SNAPSHOT_IMAGE_MAX_CHARS = Math.round((SNAPSHOT_IMAGE_MAX_BYTES * 4) / 3);
/** Heartbeat aralığı: snapshot İÇERİK değişmese de updatedAt en geç bu aralıkla tazelenir.
 *  (Eski davranış yalnız değişince yazıyordu → boşta/duraklamış yazıcıda updatedAt yaşlanıyor,
 *  mobil 90sn'de yanlış "masaüstü kapalı" alarmı verip kontrolleri/tekrar-bas'ı kilitliyordu.) */
const HEARTBEAT_MS = 30_000;
/** Bu süreden eski pending komutlar UYGULANMAZ → zaman aşımı. (Masaüstü kapalıyken gönderilen
 *  "start"ın saatler sonra kimse beklemiyorken baskı başlatması / bayat "cancel"ın yeni baskıyı
 *  öldürmesi güvenlik riskiydi.) Baskı BAŞLATAN/SÜRDÜREN komutlar (start/resume) daha da kısa:
 *  kimse 3 dakikadan uzun süredir beklemiyorsa o baskı artık istenmiyordur. */
const COMMAND_TTL_MS = 10 * 60_000;
const START_TTL_MS = 3 * 60_000;
/** Bu oturumda ZATEN yürütülen komutlar — durum-yazması (done/error) buluta gidemese bile aynı
 *  komut bir sonraki tick'te YENİDEN yürütülmez (çift baskı başlatma koruması). */
const processedCmdIds = processSingleton("relay_processedCmdIds", () => new Set<string>());
const startedKutu = processSingleton("relay_started", () => ({ v: false }));
const capsWrittenKutu = processSingleton("relay_capsWritten", () => ({ v: false })); // relay yetenek bildirimi (AppSetting) bir kez yazılır
const tickingKutu = processSingleton("relay_ticking", () => ({ v: false })); // re-entrancy guard — bir tick bitmeden diğeri başlamasın (üst üste binme/birikme yok)
const commandsRunningKutu = processSingleton("relay_commandsRunning", () => ({ v: false })); // komut koşucusu guard'ı — tick'ten ayrık, tek koşucu
const tickCountKutu = processSingleton("relay_tickCount", () => ({ v: 0 })); // yalnız düşük öncelikli ilk-tick işlerini açılıştan uzaklaştırmak için
const lastKey = processSingleton("relay_lastKey", () => new Map<string, string>());
const lastWriteAt = processSingleton("relay_lastWriteAt", () => new Map<string, number>()); // yazıcı başına son snapshot yazma zamanı (heartbeat için)
const lastImage = processSingleton("relay_lastImage", () => new Map<string, string | null>()); // buluta EN SON yazılan görsel (aynıysa tekrar gönderilmez)
const lastStatus = processSingleton("relay_lastStatus", () => new Map<string, string>()); // baskı-bitti GEÇİŞİNİ yakalamak için yazıcı başına önceki durum
// Mükerrer "baskı bitti" koruması: aynı iş için 30dk içinde ikinci bildirim atma (dosya adı
// snapshot'lar arasında uzantılı/uzantısız değişince sahte ikinci "finished" geçişi görülebiliyor).
const lastDoneNotify = processSingleton("relay_lastDoneNotify", () => new Map<string, { key: string; at: number }>());
/** Hata/duraklama bildirimi için aynı mükerrer-koruma (yazıcı → son bildirilen durum+dosya). */
const lastFaultNotify = processSingleton("relay_lastFaultNotify", () => new Map<string, { key: string; at: number }>());

/**
 * Baskı bildirimi hafızası KALICI tutulur (AppSetting).
 *
 * NEDEN: yukarıdaki üç harita yalnız bellekteydi. Uygulama kapanıp açılınca "önceki durum"
 * sıfırlanıyor, ilk gözlem sessizce tohumlanıyordu → uygulama KAPALIYKEN biten baskı hiç
 * bildirilmiyordu (gece biten baskı sabah sessizce yutuluyordu). Kalıcı hafızayla açılışta
 * "baskı yapıyordu → şimdi bitmiş" geçişi görülüp bildirim atılır.
 */
const NOTIFY_STATE_KEY = "printerRelayNotifyState";
/** Uygulama bu süreden uzun kapalı kaldıysa eski durum "bilinmiyor" sayılır — günler öncesinin
 *  baskısını "az önce bitti" gibi duyurmak kafa karıştırır. */
const NOTIFY_STATE_TTL_MS = 24 * 60 * 60_000;
/** En sık bu aralıkla yazılır (durum çevrimdışı↔çevrimiçi zıplasa bile bulut yazması patlamasın). */
const NOTIFY_STATE_MIN_WRITE_MS = 60_000;
interface NotifyState {
  status?: string;
  doneKey?: string;
  doneAt?: number;
  faultKey?: string;
  faultAt?: number;
}
let notifyStateLoaded = false;
let notifyStateWrittenAt = 0;
let notifyStateSerialized = "";

function serializeNotifyState(): string {
  const printers: Record<string, NotifyState> = {};
  for (const [id, status] of lastStatus) printers[id] = { status };
  for (const [id, d] of lastDoneNotify) printers[id] = { ...(printers[id] ?? {}), doneKey: d.key, doneAt: d.at };
  for (const [id, f] of lastFaultNotify) printers[id] = { ...(printers[id] ?? {}), faultKey: f.key, faultAt: f.at };
  return JSON.stringify(printers);
}

/** Kalıcı hafızayı oturumda BİR KEZ belleğe al. */
async function loadNotifyState(): Promise<void> {
  if (notifyStateLoaded) return;
  notifyStateLoaded = true;
  try {
    const row = await remotePrisma.appSetting.findUnique({ where: { key: NOTIFY_STATE_KEY } });
    if (!row?.value) return;
    const parsed = JSON.parse(row.value) as { at?: number; printers?: Record<string, NotifyState> };
    if (!parsed?.printers || typeof parsed.at !== "number") return;
    if (Date.now() - parsed.at > NOTIFY_STATE_TTL_MS) return;
    for (const [id, s] of Object.entries(parsed.printers)) {
      if (typeof s?.status === "string") lastStatus.set(id, s.status);
      if (typeof s?.doneKey === "string" && typeof s?.doneAt === "number") {
        lastDoneNotify.set(id, { key: s.doneKey, at: s.doneAt });
      }
      if (typeof s?.faultKey === "string" && typeof s?.faultAt === "number") {
        lastFaultNotify.set(id, { key: s.faultKey, at: s.faultAt });
      }
    }
    notifyStateSerialized = serializeNotifyState();
  } catch {
    /* okunamadıysa bellekten devam — yalnız kapalıyken biten baskı bildirimi kaçar */
  }
}

/** Değiştiyse (ve en fazla dakikada bir) kalıcı hafızayı güncelle. */
async function saveNotifyState(): Promise<void> {
  const next = serializeNotifyState();
  if (next === notifyStateSerialized) return;
  if (Date.now() - notifyStateWrittenAt < NOTIFY_STATE_MIN_WRITE_MS) return;
  const value = JSON.stringify({ at: Date.now(), printers: JSON.parse(next) });
  try {
    await remotePrisma.appSetting.upsert({
      where: { key: NOTIFY_STATE_KEY },
      create: { key: NOTIFY_STATE_KEY, value },
      update: { value },
    });
    notifyStateSerialized = next;
    notifyStateWrittenAt = Date.now();
  } catch {
    /* yazılamadıysa sonraki tick dener */
  }
}

export function startPrinterRelay() {
  if (startedKutu.v) return;
  startedKutu.v = true;
  setTimeout(() => { void tick(); }, 5000);
  setInterval(() => { void tick(); }, TICK_MS);
}

interface SnapFields {
  name: string; brand: string; status: string; online: boolean;
  statusMessage: string | null; // hata/duraklatma nedeni (error/paused'da dolar)
  productName: string | null; productImage: string | null;
  progress: number; nozzle: number; bed: number;
  currentFilename: string | null; etaSec: number | null;
}

type Cfg = { id: string; name: string; brand: string; model: string | null; type: string; host: string; port: number; accessCode: string | null; serial: string | null };

function moonrakerStatusName(s: MoonrakerState): string {
  switch (s) {
    case "printing": return "printing";
    case "paused": return "paused";
    case "complete": return "finished";
    case "error": return "error";
    default: return "idle";
  }
}

async function buildSnapshot(
  c: Cfg,
  matchMap: Map<string, string>,
  productMap: Map<string, { name: string; imageUrl: string | null }>
): Promise<SnapFields | null> {
  const baseName = c.name;
  if (c.type === "bambu") {
    if (!c.accessCode || !c.serial) {
      return { name: baseName, brand: c.brand, status: "offline", online: false, statusMessage: null, productName: null, productImage: null, progress: 0, nozzle: 0, bed: 0, currentFilename: null, etaSec: null };
    }
    const bs = await getBambuStatusCached(c.host, c.accessCode, c.serial);
    if (!bs.online) return { name: baseName, brand: c.brand, status: "offline", online: false, statusMessage: null, productName: null, productImage: null, progress: 0, nozzle: 0, bed: 0, currentFilename: null, etaSec: null };
    const status = mapBambuState(bs.gcodeState);
    const matchedId = bs.filename ? matchMap.get(`${c.id}::${fileMatchKey(bs.filename)}`) : undefined;
    const matched = matchedId ? productMap.get(matchedId) : undefined;
    // MADDE 14: duraklatma/hata nedeni telefona da AYNI metinle gitsin.
    const statusMessage =
      bs.statusReason ??
      (status === "error" ? `Baskı hatayla durdu${bs.printError ? ` (kod: ${bs.printError})` : ""}` : null);
    // MADDE 1: kalan süre yazıcının KENDİ değerinden (mc_remaining_time) — panelle aynı hesap.
    const picked = pickProgress({ printerPercent: bs.percent });
    const eta = resolveEta({
      progress: picked.progress,
      elapsedSec: bs.startedAtMs != null ? Math.max(0, (Date.now() - bs.startedAtMs) / 1000) : null,
      slicerEstimateSec: null,
      printerRemainingSec: bs.remainingSec,
    });
    return {
      name: baseName, brand: c.brand, status, online: true, statusMessage,
      productName: matched?.name ?? (bs.filename ? printJobDisplayName(bs.filename) || bs.filename : null),
      productImage: matched?.imageUrl ?? null,
      progress: picked.progress,
      nozzle: bs.nozzle, bed: bs.bed,
      currentFilename: bs.filename, etaSec: eta.remainingSec,
    };
  }

  // Moonraker
  const st = await getMoonrakerStatusCached(c.host, c.port);
  if (!st.online) return { name: baseName, brand: c.brand, status: "offline", online: false, statusMessage: null, productName: null, productImage: null, progress: 0, nozzle: 0, bed: 0, currentFilename: null, etaSec: null };
  const status = moonrakerStatusName(st.state);
  let productName: string | null = null;
  let productImage: string | null = null;
  let etaSec: number | null = null;
  if (st.filename && (st.state === "printing" || st.state === "paused" || st.state === "complete")) {
    const matchedId = matchMap.get(`${c.id}::${fileMatchKey(st.filename)}`);
    const matched = matchedId ? productMap.get(matchedId) : undefined;
    // MADDE 13: eşleşme yoksa ham dosya adı değil, temizlenmiş gösterim adı gitsin (telefonda da).
    productName = matched?.name ?? (printJobDisplayName(st.filename) || st.filename);
    const meta = await getMoonrakerMetaCached(c.host, c.port, st.filename); // dosya başına önbellekli — ucuz
    // MADDE 3: basılan plakanın görüntüsü mağaza fotoğrafını YENER — ama snapshot satırı baskı
    // boyunca defalarca uzak Turso'ya yazıldığı için görsel KÜÇÜK olmak zorunda
    // (bkz. SNAPSHOT_IMAGE_MAX_BYTES). Sınırı aşan görselde mağaza fotoğrafına düşülür;
    // LAN-IP URL'i yazılmaz (telefon LAN dışındayken kırık görsel oluyordu).
    if (meta?.thumbnailRelPath) {
      productImage = await getMoonrakerThumbDataUrl(c.host, c.port, st.filename, meta.thumbnailRelPath);
    }
    if (!productImage && meta?.thumbnailDataUrl && meta.thumbnailDataUrl.length <= SNAPSHOT_IMAGE_MAX_CHARS) {
      productImage = meta.thumbnailDataUrl;
    }
    if (!productImage && matched?.imageUrl) productImage = matched.imageUrl;
    // MADDE 1: kalan süre panelle AYNI hesap (src/core/printers/eta.ts) — telefon ve masaüstü
    // artık farklı rakam göstermez.
    // Panelle AYNI dondurulmuş hız: telefon ve masaüstü aynı rakamı göstermeli. Hafıza
    // yazıcı kimliğine bağlı; panel de aynı anahtarı kullanıyor (tek süreç, tek kayıt).
    const eta = resolveEta({
      progress: st.progress,
      elapsedSec: st.printDurationSec,
      slicerEstimateSec: meta?.estimatedTimeSec ?? null,
      printerRemainingSec: null,
      prev: etaHafizasiOku(c.id, st.filename),
    });
    etaHafizasiYaz(c.id, st.filename, st.progress, eta.totalSec);
    etaSec = eta.remainingSec;
  }
  return {
    name: baseName, brand: c.brand, status, online: true,
    statusMessage: status === "error" || status === "paused" ? st.message : null,
    productName, productImage,
    progress: st.progress, nozzle: st.nozzle, bed: st.bed,
    currentFilename: st.filename, etaSec,
  };
}

async function executeCommand(c: Cfg, cmd: { action: string; modelFileId: string | null }): Promise<void> {
  if (cmd.action === "start") {
    if (!cmd.modelFileId) throw new Error("Model dosyası belirtilmedi");
    if (c.type !== "moonraker") throw new Error("Bambu'da uzaktan baskı başlatma henüz desteklenmiyor");
    const mf = await prisma.productModelFile.findUnique({ where: { id: cmd.modelFileId } });
    if (!mf) throw new Error("Model dosyası bulunamadı");
    // Masaüstü print rotasıyla AYNI çözümleme: R2'deki (bulut) dosya indirilir, yerel dosya
    // diskten okunur. (Eski hali yalnız storedPath'e bakıyordu → telefondan bulut dosyaya
    // "Tekrar bas" %100 "Dosya bu cihazda yok" hatası veriyordu.)
    // KİLİT: masaüstü print rotasıyla AYNI yazıcı-başına kilit — telefon + masaüstü aynı anda
    // başlatırsa ikincisi net "meşgul" hatası alır (çift upload/start yarışı yok).
    if (!tryAcquirePrintLock(c.id)) throw new Error("Yazıcıda şu an başka bir baskı başlatılıyor");
    try {
      const local = await resolveModelFileLocal(mf);
      try {
        // async oku — readFileSync büyük gcode'da (100MB+) Electron ana event-loop'unu donduruyordu.
        const buf = await fs.promises.readFile(local.path);
        // brand ŞART: Snapmaker U1 native WITH_PARAMETERS akışına girmezse print_task_config boş
        // kalır → sahte "filament runout" (id=523), nozzle ısınmaz. (Eski çağrı brand'siz →
        // telefondan U1'e her "Tekrar bas" bu hataya çakılıyordu.)
        await moonrakerUploadAndPrint(c.host, c.port, buf, mf.originalName, { brand: c.brand });
      } finally {
        local.cleanup();
      }
    } finally {
      releasePrintLock(c.id);
    }
    try {
      await prisma.printFileProduct.upsert({
        where: { printerConfigId_filename: { printerConfigId: c.id, filename: mf.originalName } },
        create: { printerConfigId: c.id, filename: mf.originalName, productId: mf.productId },
        update: { productId: mf.productId },
      });
      invalidatePrintFileMatches(); // panel yeni eşleşmeyi 30sn TTL beklemeden görsün
    } catch { /* eşleştirme kritik değil */ }
    return;
  }
  // pause | resume | cancel
  const action = cmd.action as "pause" | "resume" | "cancel";
  if (c.type === "bambu") {
    if (!c.accessCode || !c.serial) throw new Error("Bambu access code/seri no eksik");
    // await ŞART: hata (bağlı değil / publish reddi) komuta yazılsın — telefon dürüst sonuç görsün.
    await bambuControl(c.host, c.accessCode, c.serial, action);
  } else {
    await moonrakerControl(c.host, c.port, action);
  }
}

/**
 * Aynı bildirim son 30 dakikada zaten yazılmış mı?
 *
 * ⚠️ NEDEN VERİTABANINDAN SORUYORUZ: tekilleştirme yalnız BELLEKTEKİ `lastDoneNotify` /
 * `lastFaultNotify` haritalarına bakıyordu ve o haritalar SÜRECE ait. Aynı veritabanına bakan
 * ikinci bir süreç (ikinci pencere, geliştirme sunucusu, yeniden başlatma) kendi boş
 * haritasıyla AYNI bildirimi bir daha yazıyordu. Satır id'si `…:${Date.now()}` olduğu için
 * `INSERT OR IGNORE` de hiçbir şeyi engellemiyordu — id her seferinde farklı.
 * Sahada görüldü: tek baskı bitişi için üç "Baskı tamamlandı" satırı, 4 saniye içinde.
 *
 * Zaman penceresi kullanılıyor, sabit id DEĞİL: aynı dosya saatler sonra yeniden basılırsa
 * bildirim YİNE düşmeli. (Sabit id bir zamanlar denenmiş ve tekrarlayan baskıları sessize
 * almıştı — bu yüzden id zaman damgalı yapılmış, ama o da tekilleştirmeyi tamamen kaldırmış.)
 */
export const NOTIFY_DEDUPE_MS = 30 * 60_000;

/**
 * Mükerrer kontrolünün SQL'i — testten AYNI dizeyi koşturabilmek için dışa açık.
 * (Dize içindeki SQL'i `tsc`, `eslint` ve `next build` GÖREMEZ; bu projede geçersiz bir göç
 * sorgusu tam bu yüzden fark edilmeden yayınlanmış ve uygulamayı 205 saniye açtırmamıştı.)
 *
 * `dbEpochMs` ile karşılaştırılır: `createdAt` sahada İKİ biçimde bulunabiliyor
 * ("2026-08-13 09:13:21" ve "2026-08-13T09:13:21.620+00:00"). Düz metin karşılaştırması
 * biçimlerden birini tümüyle ıskalar ve koruma sessizce çalışmaz.
 */
export function recentNotificationSql(): string {
  return `SELECT COUNT(*) AS n FROM "Notification"
           WHERE "type" = ? AND "body" = ? AND ${dbEpochMs("createdAt")} >= ?`;
}

async function bildirimZatenVar(type: string, body: string): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number | bigint }>>(
      recentNotificationSql(),
      type,
      body,
      Date.now() - NOTIFY_DEDUPE_MS
    );
    const n = rows[0]?.n;
    return (typeof n === "bigint" ? Number(n) : Number(n ?? 0)) > 0;
  } catch {
    // Sorgu düşerse bildirimi ENGELLEME — mükerrer bildirim, kaçan bildirimden iyidir.
    return false;
  }
}

/** Baskı tamamlandı → kalıcı Notification (masaüstü zili + OS bildirimi) + mobil push (telefona düşer). */
async function notifyPrintComplete(c: Cfg, snap: SnapFields): Promise<void> {
  const job = snap.productName ? ` — ${snap.productName}` : "";
  const title = "Baskı tamamlandı 🎉";
  const body = `${c.name}${job}`;
  // Süreçler arası koruma: mobil push da buradan geçtiği için telefon da tek bildirim alır.
  if (await bildirimZatenVar("printer-done", body)) return;
  // 1) Kalıcı bildirim — /api/notifications okur; masaüstü zili gösterir + OS bildirimi atar. Benzersiz
  //    id (zaman damgalı) → her tamamlanma için bir kez (statik id'li eski uyarı tekrar atmıyordu).
  try {
    await prisma.$executeRawUnsafe(
      // createdAt AÇIKÇA yazılır: kolon boş bırakılınca SQLite'ın DEFAULT CURRENT_TIMESTAMP
      // değeri giriyor ("2026-08-13 07:00:00"). Prisma'nın yazdığı ISO biçimden FARKLI bir
      // metin ve sıralamada boşluk 'T'den küçük → yazıcı bildirimi zilin en dibine düşüyor,
      // liste 100 satırı aşınca hiç görünmüyordu.
      `INSERT OR IGNORE INTO "Notification" ("id","type","severity","title","body","href","createdAt") VALUES (?,?,?,?,?,?,?)`,
      `printer-done:${c.id}:${Date.now()}`,
      "printer-done",
      "success",
      title,
      body,
      "/printers",
      toDbDate(new Date())
    );
  } catch {
    /* Notification tablosu yoksa sessiz geç */
  }
  // 2) Mobil push — telefon kapalıyken de bildirim düşer.
  await pushToAllDevices(title, body).catch(() => {});
}

/** Baskı hatayla durdu / duraklatıldı → kalıcı Notification (KRİTİK) + mobil push.
 *  Kritik severity: masaüstü zili bunu OS bildirimi olarak da atar. */
async function notifyPrintFault(c: Cfg, snap: SnapFields): Promise<void> {
  const job = snap.productName ? ` — ${snap.productName}` : "";
  const isError = snap.status === "error";
  const title = isError ? "Baskı hatayla durdu ⚠️" : "Baskı duraklatıldı ⏸";
  // statusMessage yazıcıdan gelen nedeni taşır (hata kodu vb.); yoksa yazıcı adıyla yetin.
  const body = `${c.name}${job}${snap.statusMessage ? ` · ${snap.statusMessage}` : ""}`;
  // "Baskı duraklatıldı" da aynı şekilde üçleniyordu (sahada 08:44'te üç satır).
  if (await bildirimZatenVar(isError ? "printer-error" : "printer-paused", body)) return;
  try {
    await prisma.$executeRawUnsafe(
      // createdAt AÇIKÇA yazılır: kolon boş bırakılınca SQLite'ın DEFAULT CURRENT_TIMESTAMP
      // değeri giriyor ("2026-08-13 07:00:00"). Prisma'nın yazdığı ISO biçimden FARKLI bir
      // metin ve sıralamada boşluk 'T'den küçük → yazıcı bildirimi zilin en dibine düşüyor,
      // liste 100 satırı aşınca hiç görünmüyordu.
      `INSERT OR IGNORE INTO "Notification" ("id","type","severity","title","body","href","createdAt") VALUES (?,?,?,?,?,?,?)`,
      `printer-fault:${c.id}:${Date.now()}`,
      isError ? "printer-error" : "printer-paused",
      "critical",
      title,
      body,
      "/printers",
      toDbDate(new Date())
    );
  } catch {
    /* Notification tablosu yoksa sessiz geç */
  }
  await pushToAllDevices(title, body).catch(() => {});
}

async function tick(): Promise<void> {
  // UYKU/UYANMA KORUMASI: Mac uyurken/uyanırken DB ağ-op'larını (snapshot yazma + sync) ATLA.
  // main.js powerMonitor bu globalThis flag'ini set eder. Aksi halde libSQL embedded-replica'nın
  // native ağ op'u ölü bağlantıda (timeout YOK) asılıp ana event-loop'u DONDURUYOR.
  if ((globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__) return;
  if (tickingKutu.v) return; // önceki tick hâlâ sürüyorsa atla — yavaş/çevrimdışı yazıcıda tick'ler üst üste binip birikmesin
  tickingKutu.v = true;
  try {
    await ensureRuntimeSchema();
    // Kapalıyken biten/hataya düşen baskıyı yakalayabilmek için önceki oturumun durumu.
    await loadNotifyState();
    tickCountKutu.v++;
    // İlk-tick yan işleri (caps yazımı + depo hademesi) 3. tick'e (~t+25sn) ertelendi:
    // açılışın ilk saniyelerinde bulut yazması/R2 listelemesi ilk ekran sorgularıyla yarışmasın.
    if (!capsWrittenKutu.v && tickCountKutu.v >= 3) {
      try {
        await remotePrisma.appSetting.upsert({
          where: { key: "printRelayCaps" },
          create: { key: "printRelayCaps", value: "r2start,heartbeat,cmdttl" },
          update: { value: "r2start,heartbeat,cmdttl" },
        });
        capsWrittenKutu.v = true;
      } catch { /* sonraki tick dener */ }
      // Depo hademesi — oturumda bir kez, arka planda (temp artıkları + R2 orphan'ları).
      void runStorageJanitor().catch(() => {});
    }
    // TÜM yazıcılar devre dışıyken de devam et — komut kuyruğu yine işlenmeli (yoksa pending
    // komutlar ne uygulanır ne TTL ile düşer; sonsuza dek "bekliyor" kalırdı).
    // ARKA PLAN ŞERİDİ: relay 10 saniyede bir dönüyor. Ana istemci uzak-HTTP libSQL'de
    // TEK mutex kullandığı için bu turlar, kullanıcının açtığı sayfanın sorgularının
    // önüne geçiyordu. Relay'in birkaç yüz ms geç kalması kimseyi etkilemez.
    const configs = (await remotePrisma.printerConfig.findMany({ where: { enabled: true } })) as Cfg[];

    // Ürün eşleştirmeleri (snapshot'ta ürün adı/görseli için). Anahtar NORMALİZE (fileMatchKey):
    // print rotası eşleştirmeyi uzantısız kaydediyor, yazıcı ham adla raporluyor — ham anahtarla
    // eşleşme kaçıyor, telefonda ürün adı/görseli yerine dosya adı görünüyordu.
    const matches = configs.length ? await getPrintFileMatches() : [];
    const matchMap = new Map(matches.map((m) => [`${m.printerConfigId}::${fileMatchKey(m.filename)}`, m.productId]));
    const pids = [...new Set(matches.map((m) => m.productId))];
    const products = pids.length
      ? await remotePrisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, name: true, imageUrl: true } })
      : [];
    const productMap = new Map(products.map((p) => [p.id, { name: p.name, imageUrl: p.imageUrl }]));

    // suspend yukarıdaki (yerel) okumalar sırasında geldiyse buluta yazmaları da atla — defense in depth.
    if ((globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__) return;
    // 1) Snapshot'lar — PARALEL (çevrimdışı/yavaş yazıcı diğerlerini bekletmesin; toplam süre = en yavaş yazıcı)
    await Promise.all(configs.map(async (c) => {
      let snap: SnapFields | null = null;
      try { snap = await buildSnapshot(c, matchMap, productMap); } catch { snap = null; }
      if (!snap) return;
      // BASKI BİTTİ geçişi (… → finished) → bir kez bildirim + mobil push. Önceki durum kalıcı
      // hafızadan gelir (loadNotifyState) → uygulama kapalıyken biten baskı da açılışta bildirilir;
      // 24 saatten eski hafıza kullanılmaz, o yüzden çok eski baskılar sahte bildirim üretmez.
      const prevStatus = lastStatus.get(c.id);
      lastStatus.set(c.id, snap.status);
      // YALNIZ gerçek baskı bitişinde bildir: printing/paused → finished. Eski koşul
      // (≠finished → finished) offline→online dalgalanmasında da tetikleniyordu — FINISH durumu
      // yazıcıda GÜNLERCE kalır, her flap "Baskı tamamlandı"yı yeniden yakıyordu (sahada 4 mükerrer).
      if ((prevStatus === "printing" || prevStatus === "paused") && snap.status === "finished") {
        const doneKey = fileMatchKey(snap.productName || snap.currentFilename || "");
        const prevDone = lastDoneNotify.get(c.id);
        if (!(prevDone && prevDone.key === doneKey && Date.now() - prevDone.at < 30 * 60_000)) {
          lastDoneNotify.set(c.id, { key: doneKey, at: Date.now() });
          void notifyPrintComplete(c, snap).catch(() => {});
        }
      }
      // BASKI DURDU/HATA geçişi (printing → error|paused) → bildirim + push. Eskiden yalnız
      // "bitti" bildiriliyordu; hatayla duran baskı saatlerce fark edilmiyordu (filament boşa gider).
      // Aynı "bir kez bildir" ve "flap koruması" mantığı: yalnız PRINTING'den geçişte tetiklenir.
      if (prevStatus === "printing" && (snap.status === "error" || snap.status === "paused")) {
        const key = `${snap.status}:${fileMatchKey(snap.productName || snap.currentFilename || "")}`;
        const prev = lastFaultNotify.get(c.id);
        if (!(prev && prev.key === key && Date.now() - prev.at < 30 * 60_000)) {
          lastFaultNotify.set(c.id, { key, at: Date.now() });
          void notifyPrintFault(c, snap).catch(() => {});
        }
      }
      // etaSec 30sn KOVASI: saniye hassasiyetinde her tick "değişti" sayılıp baskı boyunca
      // 10sn'de bir Turso bulut yazması üretiyordu; 30sn kovası yazmaları ~1/3'e indirir
      // (telefon zaten kalan süreyi dakika hassasiyetinde gösteriyor).
      const etaBucket = snap.etaSec == null ? "-" : String(Math.round(snap.etaSec / 30));
      const key = [snap.status, snap.online, Math.round(snap.progress * 100), snap.currentFilename, snap.nozzle, snap.bed, snap.productName, etaBucket, snap.statusMessage].join("|");
      // HEARTBEAT: içerik değişmese de updatedAt en geç 30sn'de bir tazelenir. Telefon
      // "masaüstü açık mı?" tespitini updatedAt yaşından yapıyor; salt-değişince-yaz davranışı
      // boşta/duraklamış yazıcıda (değerler sabit) yanlış "Canlı değil" alarmı + kontrol/tekrar-bas
      // kilidi üretiyordu.
      const nowMs = Date.now();
      const unchanged = lastKey.get(c.id) === key;
      const fresh = nowMs - (lastWriteAt.get(c.id) ?? 0) < HEARTBEAT_MS;
      if (unchanged && fresh) return;
      lastKey.set(c.id, key);
      // GÖRSELİ TEKRAR GÖNDERME: plaka görüntüsü baskı boyunca DEĞİŞMEZ, ama her tick/heartbeat
      // yazmasında aynı data-URL yeniden buluta gidiyordu. Değişmediyse update'ten çıkarılır
      // (create'te kalır — ilk satırda görsel yine yazılır).
      const imageUnchanged = lastImage.get(c.id) === snap.productImage;
      const update: Partial<SnapFields> = { ...snap };
      if (imageUnchanged) delete update.productImage;
      try {
        await remotePrisma.printerSnapshot.upsert({
          where: { printerConfigId: c.id },
          create: { printerConfigId: c.id, ...snap },
          update,
        });
        lastWriteAt.set(c.id, nowMs);
        lastImage.set(c.id, snap.productImage);
      } catch { /* yazılamadıysa sonraki tick dener */ }
    }));

    // Durum/bildirim hafızasını kalıcılaştır (değiştiyse) → uygulama kapansa bile geçişler kaybolmaz.
    await saveNotifyState();

    // 2) Bekleyen komutlar — tick'ten AYRIK (fire-and-forget + kendi guard'ı). Uzun bir komut
    // (R2 indirme + 180sn'lik yazıcıya upload) eskiden ticking=true'yu tutup snapshot/heartbeat'i
    // durduruyordu → telefon KENDİ komutu işlenirken "masaüstü kapalı" alarmı veriyordu.
    if (!commandsRunningKutu.v) {
      commandsRunningKutu.v = true;
      void processPendingCommands(configs)
        .catch(() => { /* komut döngüsü kendi hatasını komuta yazar */ })
        .finally(() => { commandsRunningKutu.v = false; });
    }
  } finally {
    tickingKutu.v = false;
  }
}

/** Bekleyen telefon komutlarını sıralı işle (sıra korunmalı; tek koşucu — commandsRunning guard'ı). */
async function processPendingCommands(configs: Cfg[]): Promise<void> {
  let pending: { id: string; printerConfigId: string; action: string; modelFileId: string | null; createdAt: Date }[] = [];
  try {
    pending = await remotePrisma.printCommand.findMany({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: 10 });
  } catch { return; }

  for (const cmd of pending) {
    // Bu oturumda zaten yürütüldüyse ATLA — done/error yazması buluta gidememiş olabilir;
    // yeniden yürütmek çift baskı demek. (Yazma sonraki tick'lerde tekrar denenir.)
    if (processedCmdIds.has(cmd.id)) {
      await remotePrisma.printCommand.update({ where: { id: cmd.id }, data: { status: "done", processedAt: new Date() } }).catch(() => {});
      continue;
    }
    // TTL: masaüstü KAPALIYKEN gönderilip birikmiş bayat komutlar uygulanmaz — bayat "start"
    // kimse beklemiyorken baskı başlatır, bayat "cancel" masaüstünden yeni açılan baskıyı
    // öldürebilirdi. Telefon 90sn'de zaten "uygulanmadı" uyarısı gösteriyor.
    const ttl = cmd.action === "start" || cmd.action === "resume" ? START_TTL_MS : COMMAND_TTL_MS;
    if (Date.now() - new Date(cmd.createdAt).getTime() > ttl) {
      await remotePrisma.printCommand.update({
        where: { id: cmd.id },
        data: { status: "error", error: "Zaman aşımı — masaüstü kapalıyken gönderildi, güvenlik için uygulanmadı", processedAt: new Date() },
      }).catch(() => {});
      continue;
    }
    try {
      const c = configs.find((x) => x.id === cmd.printerConfigId)
        ?? ((await prisma.printerConfig.findUnique({ where: { id: cmd.printerConfigId } })) as (Cfg & { enabled?: boolean }) | null);
      if (!c) throw new Error("Yazıcı bulunamadı");
      // configs yalnız etkinleri içerir; fallback'ten gelen kayıt devre dışı olabilir → uygulama.
      if ((c as { enabled?: boolean }).enabled === false) throw new Error("Yazıcı devre dışı");
      /**
       * ATOMİK SAHİPLENME — iki masaüstü aynı anda açıkken çift yürütmeyi engeller.
       *
       * `processedCmdIds` yalnız SÜREÇ İÇİ bir işaret; Berke hem Windows hem Mac'te
       * çalıştığında iki relay de aynı bekleyen komutu görüyor ve ikisi de yürütüyordu
       * (durum ancak yürütmeden SONRA "done" yazılıyor). Telefondan gönderilen tek bir
       * "baskıyı başlat" iki kez gidebilirdi.
       *
       * `updateMany` koşullu güncellemedir: yalnız hâlâ "pending" olan satırı "running"
       * yapar ve KAÇ satır güncellediğini söyler. 0 dönerse komutu başka bir makine
       * kapmıştır → bu makine dokunmaz.
       */
      const kapildi = await remotePrisma.printCommand.updateMany({
        where: { id: cmd.id, status: "pending" },
        data: { status: "running" },
      });
      if (kapildi.count !== 1) {
        processedCmdIds.add(cmd.id); // başka makine aldı — bir daha bakma
        continue;
      }
      processedCmdIds.add(cmd.id); // yürütmeden HEMEN önce işaretle — yazma hatasında bile tekrar yok
      await executeCommand(c, cmd);
      await remotePrisma.printCommand.update({ where: { id: cmd.id }, data: { status: "done", processedAt: new Date() } });
    } catch (e) {
      processedCmdIds.add(cmd.id);
      await remotePrisma.printCommand.update({
        where: { id: cmd.id },
        data: { status: "error", error: e instanceof Error ? e.message : "hata", processedAt: new Date() },
      }).catch(() => {});
    }
  }
}
