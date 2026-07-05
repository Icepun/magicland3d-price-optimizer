/**
 * Telefon relay'i — masaüstü (LAN'da) tarafında periyodik çalışır:
 *   1) Yerel Turso replica'yı zorla senkronlar (telefonun yazdığı komutları çabuk görür).
 *   2) Her yazıcının canlı durumunu PrinterSnapshot'a yazar (değiştiyse) → telefon okur.
 *   3) Bekleyen PrintCommand'leri LAN'da yazıcıya uygular → sonucu yazar.
 *
 * instrumentation.ts (Next sunucu açılışı) tarafından bir kez başlatılır.
 * Yalnızca Turso modunda anlamlıdır; Turso yoksa snapshot/komut tabloları yine çalışır
 * ama uzaktan erişim olmaz (sorun değil).
 */
import fs from "node:fs";
import { prisma, syncTursoReplica } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { resolveModelFileLocal } from "@/lib/model-files";
import {
  moonrakerThumbUrl, moonrakerControl, moonrakerUploadAndPrint, type MoonrakerState,
} from "./moonraker";
import { bambuControl, mapBambuState } from "./bambu";
import { fileMatchKey } from "./file-match";
import { tryAcquirePrintLock, releasePrintLock } from "./print-lock";
// Panel API ile PAYLAŞILAN yoklayıcı — aynı yazıcı 5sn (panel) + 10sn (relay) ayrı ayrı
// yoklanmıyor; çevrimdışına backoff + tek-kaçak histerezisi de buradan gelir.
import {
  getMoonrakerStatusCached, getBambuStatusCached, getMoonrakerMetaCached,
  getPrintFileMatches, invalidatePrintFileMatches,
} from "./status-cache";
import { pushToAllDevices } from "@/lib/push-notify";

const TICK_MS = 10_000;
/** Heartbeat aralığı: snapshot İÇERİK değişmese de updatedAt en geç bu aralıkla tazelenir.
 *  (Eski davranış yalnız değişince yazıyordu → boşta/duraklamış yazıcıda updatedAt yaşlanıyor,
 *  mobil 90sn'de yanlış "masaüstü kapalı" alarmı verip kontrolleri/tekrar-bas'ı kilitliyordu.) */
const HEARTBEAT_MS = 30_000;
/** Bu süreden eski pending komutlar UYGULANMAZ → zaman aşımı. (Masaüstü kapalıyken gönderilen
 *  "start"ın saatler sonra kimse beklemiyorken baskı başlatması / bayat "cancel"ın yeni baskıyı
 *  öldürmesi güvenlik riskiydi.) */
const COMMAND_TTL_MS = 10 * 60_000;
let started = false;
let capsWritten = false; // relay yetenek bildirimi (AppSetting) bir kez yazılır
let ticking = false; // re-entrancy guard — bir tick bitmeden diğeri başlamasın (üst üste binme/birikme yok)
let commandsRunning = false; // komut koşucusu guard'ı — tick'ten ayrık, tek koşucu
let tickCount = 0; // her 6. tick'te (~60sn) replica pull — sync() sorguları kısa süre bloke ettiği için sıklığı düşük tut (60sn = periyodik takılma yarıya iner; telefon komutları yine ≤60sn'de görülür)
const lastKey = new Map<string, string>();
const lastWriteAt = new Map<string, number>(); // yazıcı başına son snapshot yazma zamanı (heartbeat için)
const lastStatus = new Map<string, string>(); // baskı-bitti GEÇİŞİNİ yakalamak için yazıcı başına önceki durum

export function startPrinterRelay() {
  if (started) return;
  started = true;
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
    const statusMessage =
      status === "error" ? `Baskı hatayla durdu${bs.printError ? ` (kod: ${bs.printError})` : ""}` : null;
    return {
      name: baseName, brand: c.brand, status, online: true, statusMessage,
      productName: matched?.name ?? bs.filename ?? null,
      productImage: matched?.imageUrl ?? null,
      progress: Math.min(1, Math.max(0, bs.percent / 100)),
      nozzle: bs.nozzle, bed: bs.bed,
      currentFilename: bs.filename, etaSec: bs.remainingSec,
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
    productName = matched?.name ?? st.filename;
    if (matched?.imageUrl) productImage = matched.imageUrl;
    else {
      const meta = await getMoonrakerMetaCached(c.host, c.port, st.filename);
      if (meta?.thumbnailRelPath) productImage = moonrakerThumbUrl(c.host, c.port, st.filename, meta.thumbnailRelPath);
    }
    if (st.progress > 0.01 && st.printDurationSec > 0) {
      etaSec = Math.max(0, Math.round(st.printDurationSec / st.progress - st.printDurationSec));
    }
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
    bambuControl(c.host, c.accessCode, c.serial, action);
  } else {
    await moonrakerControl(c.host, c.port, action);
  }
}

/** Baskı tamamlandı → kalıcı Notification (masaüstü zili + OS bildirimi) + mobil push (telefona düşer). */
async function notifyPrintComplete(c: Cfg, snap: SnapFields): Promise<void> {
  const job = snap.productName ? ` — ${snap.productName}` : "";
  const title = "Baskı tamamlandı 🎉";
  const body = `${c.name}${job}`;
  // 1) Kalıcı bildirim — /api/notifications okur; masaüstü zili gösterir + OS bildirimi atar. Benzersiz
  //    id (zaman damgalı) → her tamamlanma için bir kez (statik id'li eski uyarı tekrar atmıyordu).
  try {
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "Notification" ("id","type","severity","title","body","href") VALUES (?,?,?,?,?,?)`,
      `printer-done:${c.id}:${Date.now()}`,
      "printer-done",
      "success",
      title,
      body,
      "/printers"
    );
  } catch {
    /* Notification tablosu yoksa sessiz geç */
  }
  // 2) Mobil push — telefon kapalıyken de bildirim düşer.
  await pushToAllDevices(title, body).catch(() => {});
}

async function tick(): Promise<void> {
  // UYKU/UYANMA KORUMASI: Mac uyurken/uyanırken DB ağ-op'larını (snapshot yazma + sync) ATLA.
  // main.js powerMonitor bu globalThis flag'ini set eder. Aksi halde libSQL embedded-replica'nın
  // native ağ op'u ölü bağlantıda (timeout YOK) asılıp ana event-loop'u DONDURUYOR.
  if ((globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__) return;
  if (ticking) return; // önceki tick hâlâ sürüyorsa atla — yavaş/çevrimdışı yazıcıda tick'ler üst üste binip birikmesin
  ticking = true;
  try {
    await ensureRuntimeSchema();
    // Yetenek bildirimi (bir kez): mobil, bulut (R2) dosyaya "Tekrar bas" kapısını
    // printRelayCaps içinde "r2start" görünce açar (eski relay'de buton kilitli kalır).
    if (!capsWritten) {
      try {
        await prisma.appSetting.upsert({
          where: { key: "printRelayCaps" },
          create: { key: "printRelayCaps", value: "r2start,heartbeat,cmdttl" },
          update: { value: "r2start,heartbeat,cmdttl" },
        });
        capsWritten = true;
      } catch { /* sonraki tick dener */ }
    }
    // Replica pull'u HER tick'te değil ~60sn'de bir (sync() SQL sorgularını kısa süre bloke
    // ediyor — sıklığı düşürünce blokaj seyrekleşir). Yazmalar (snapshot upsert) zaten anında
    // buluta gider, sync gerektirmez. syncNow ayrıca erişim-kontrollü + guard'lı.
    if (tickCount++ % 6 === 0) await syncTursoReplica().catch(() => {});

    // TÜM yazıcılar devre dışıyken de devam et — komut kuyruğu yine işlenmeli (yoksa pending
    // komutlar ne uygulanır ne TTL ile düşer; sonsuza dek "bekliyor" kalırdı).
    const configs = (await prisma.printerConfig.findMany({ where: { enabled: true } })) as Cfg[];

    // Ürün eşleştirmeleri (snapshot'ta ürün adı/görseli için). Anahtar NORMALİZE (fileMatchKey):
    // print rotası eşleştirmeyi uzantısız kaydediyor, yazıcı ham adla raporluyor — ham anahtarla
    // eşleşme kaçıyor, telefonda ürün adı/görseli yerine dosya adı görünüyordu.
    const matches = configs.length ? await getPrintFileMatches() : [];
    const matchMap = new Map(matches.map((m) => [`${m.printerConfigId}::${fileMatchKey(m.filename)}`, m.productId]));
    const pids = [...new Set(matches.map((m) => m.productId))];
    const products = pids.length
      ? await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, name: true, imageUrl: true } })
      : [];
    const productMap = new Map(products.map((p) => [p.id, { name: p.name, imageUrl: p.imageUrl }]));

    // suspend yukarıdaki (yerel) okumalar sırasında geldiyse buluta yazmaları da atla — defense in depth.
    if ((globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__) return;
    // 1) Snapshot'lar — PARALEL (çevrimdışı/yavaş yazıcı diğerlerini bekletmesin; toplam süre = en yavaş yazıcı)
    await Promise.all(configs.map(async (c) => {
      let snap: SnapFields | null = null;
      try { snap = await buildSnapshot(c, matchMap, productMap); } catch { snap = null; }
      if (!snap) return;
      // BASKI BİTTİ geçişi (… → finished) → bir kez bildirim + mobil push. İlk gözlemde sessizce
      // tohumla: uygulama kapalıyken biten eski bir baskı yüzünden açılışta sahte bildirim atma.
      const prevStatus = lastStatus.get(c.id);
      lastStatus.set(c.id, snap.status);
      if (prevStatus !== undefined && prevStatus !== "finished" && snap.status === "finished") {
        void notifyPrintComplete(c, snap).catch(() => {});
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
      try {
        await prisma.printerSnapshot.upsert({
          where: { printerConfigId: c.id },
          create: { printerConfigId: c.id, ...snap },
          update: snap,
        });
        lastWriteAt.set(c.id, nowMs);
      } catch { /* yazılamadıysa sonraki tick dener */ }
    }));

    // 2) Bekleyen komutlar — tick'ten AYRIK (fire-and-forget + kendi guard'ı). Uzun bir komut
    // (R2 indirme + 180sn'lik yazıcıya upload) eskiden ticking=true'yu tutup snapshot/heartbeat'i
    // durduruyordu → telefon KENDİ komutu işlenirken "masaüstü kapalı" alarmı veriyordu.
    if (!commandsRunning) {
      commandsRunning = true;
      void processPendingCommands(configs)
        .catch(() => { /* komut döngüsü kendi hatasını komuta yazar */ })
        .finally(() => { commandsRunning = false; });
    }
  } finally {
    ticking = false;
  }
}

/** Bekleyen telefon komutlarını sıralı işle (sıra korunmalı; tek koşucu — commandsRunning guard'ı). */
async function processPendingCommands(configs: Cfg[]): Promise<void> {
  let pending: { id: string; printerConfigId: string; action: string; modelFileId: string | null; createdAt: Date }[] = [];
  try {
    pending = await prisma.printCommand.findMany({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: 10 });
  } catch { return; }

  for (const cmd of pending) {
    // TTL: masaüstü KAPALIYKEN gönderilip birikmiş bayat komutlar uygulanmaz — bayat "start"
    // kimse beklemiyorken baskı başlatır, bayat "cancel" masaüstünden yeni açılan baskıyı
    // öldürebilirdi. Telefon 90sn'de zaten "uygulanmadı" uyarısı gösteriyor.
    if (Date.now() - new Date(cmd.createdAt).getTime() > COMMAND_TTL_MS) {
      await prisma.printCommand.update({
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
      await executeCommand(c, cmd);
      await prisma.printCommand.update({ where: { id: cmd.id }, data: { status: "done", processedAt: new Date() } });
    } catch (e) {
      await prisma.printCommand.update({
        where: { id: cmd.id },
        data: { status: "error", error: e instanceof Error ? e.message : "hata", processedAt: new Date() },
      }).catch(() => {});
    }
  }
}
