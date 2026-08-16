import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { moonrakerThumbUrl, type MoonrakerState } from "@/core/printers/moonraker";
import { mapBambuState, BAMBU_SPEED_LEVELS, type BambuWarning } from "@/core/printers/bambu";
import { fileMatchKey } from "@/core/printers/file-match";
import { pickProgress, resolveEta, type EtaSource, type ProgressSource } from "@/core/printers/eta";
import { etaHafizasiOku, etaHafizasiYaz } from "@/core/printers/eta-memory";
import { SPEED_PRESETS_PCT, type PrinterControlCaps } from "@/core/printers/controls";
import { printJobDisplayName } from "@/lib/print-job-name";
// Canlı yoklama yerine PAYLAŞILAN önbellek: relay ile tek yoklayıcı, çevrimdışı yazıcıya üstel
// backoff + arka planda tazeleme → çevrimdışı yazıcı 5sn'lik paneli HİÇ geciktirmez.
import {
  getMoonrakerStatusCached, getBambuStatusCached, getMoonrakerMetaCached, getPrintFileMatches,
  getModelFilesForPreview,
  getMoonrakerExtrasCached, getBambuSlotsCached, getMatchedProducts, getEnabledPrinterConfigs,
  bumpMoonrakerStatus, bumpBambuStatus,
} from "@/core/printers/status-cache";

export const dynamic = "force-dynamic";

/**
 * YAZICI PANELİ veri kaynağı.
 *
 * Yapılandırılmış yazıcı (PrinterConfig) VARSA → gerçek canlı durum:
 *   - Moonraker (Elegoo Neptune 4 Pro/Plus, Snapmaker U1) adaptörü ile
 *   - Bambu → şimdilik "yakında" (Faz 2)
 * Hiç yazıcı yoksa → DEMO simülasyonu (zamana dayalı, eski davranış).
 *
 * Dönen şekil her iki durumda da PanelPrinter; UI tek tip kart render eder.
 * Gerçek veride job.startedAt/endsAt, ilerleme/ETA'yı istemci tarafında akıcı
 * hesaplatmak için snapshot'tan türetilir (progress = gerçek ilerleme).
 */

export type PrinterStatus = "printing" | "finished" | "idle" | "paused" | "error";

export interface PrinterJob {
  productName: string;
  productImage: string | null;
  startedAt: string;
  endsAt: string;
  progress: number; // 0..1 — GERÇEK ilerleme (snapshot), zaman tahmini değil
  remainingSec: number; // kalan saniye (snapshot anına göre)
  layerCurrent: number | null; // gerçek güncel katman (yoksa null → gösterme)
  layerTotal: number;
  filamentType: string;
  filamentColor: string;
  // ── Faz 3 eklentileri (arayüz Tur 2'de kullanacak) ──────────────────────────────────────
  /** Kalan süre GERÇEKTEN biliniyor mu. false ise `remainingSec` yalnız yer tutucudur → "—" göster. */
  remainingKnown: boolean;
  /** İlerlemenin kaynağı: "slicer" = M73 zaman tahmini, "bytes" = dosya bayt oranı. */
  progressSource: ProgressSource;
  /** Kalan sürenin kaynağı: "printer" = yazıcının kendi değeri, "measured" = ölçülen hız. */
  etaSource: EtaSource;
  /** Basılan plakanın dilimleyici görüntüsü (gcode'a gömülü / Moonraker .thumbs). */
  plateThumbnail: string | null;
  /** Eşleşen ürünün mağaza fotoğrafı — plaka görüntüsü varsa artık ikinci sırada. */
  storeImage: string | null;
  /** Dilimleyicinin bildirdiği toplam filament (gram) — YALNIZ GÖSTERİM. */
  filamentGrams: number | null;
  /** Bu baskıda kullanılan slot/kafa indeksleri. */
  activeSlots: number[];
  /** Canlı aşama verisi (MADDE 7) — katman çevirisi için ham alanlar. */
  live: {
    filePosition: number | null;
    fileSize: number | null;
    zHeight: number | null;
    nozzleX: number | null;
    nozzleY: number | null;
  };
}

/** Panelde gösterilecek uyarı (Bambu HMS / Moonraker mesajı). */
export interface PanelWarning {
  code: string | null;
  level: "fatal" | "serious" | "common" | "info";
  text: string;
}

export interface PanelPrinter {
  id: string;
  name: string;
  brand: string;
  model: string;
  accent: string;
  type: "moonraker" | "bambu" | "sim";
  status: PrinterStatus;
  online: boolean;
  note: string | null;
  /** "ok" · "offline" (ağda yok) · "unconfigured" (kurulumu tamamlanmamış) — AYRI durumlar. */
  connection: "ok" | "offline" | "unconfigured" | "unsupported";
  /** Hata/duraklatma NEDENİ (Moonraker print_stats.message / Bambu hata kodu) — kartta gösterilir.
      Mobil snapshot'ta zaten vardı; masaüstü paneli bunu düşürüyordu. */
  statusMessage: string | null;
  /** Baskı sırasındaki uyarılar (Bambu HMS) — eskiden panele hiç düşmüyordu. */
  warnings: PanelWarning[];
  /** Çalışan baskının ham gcode dosya adı (eşleştirme + kontrol için — KİMLİK, temizlenmez). */
  currentFilename: string | null;
  matchedProductId: string | null;
  /** `nozzles` YALNIZ çok kafalı yazıcıda (U1) dolu gelir; tek kafalıda yok. */
  temps: { nozzle: number; nozzleTarget: number; bed: number; bedTarget: number; nozzles?: { index: number; temp: number; target: number; active: boolean }[] };
  /** Yazıcının desteklediği kontroller — düğmeler buna göre çizilir. */
  caps: PrinterControlCaps;
  /** Hız durumu ve izin verilen kademeler (SUNUCUDA zorlanır). */
  speed: {
    percent: number | null;
    presets: readonly number[];
    /** Bambu'da yüzde yerine profil: 1 sessiz … 4 çok hızlı. */
    levels: readonly { level: number; label: string; pct: number }[] | null;
    level: number | null;
  };
  light: { supported: boolean; readable: boolean; on: boolean | null };
  /** Mantıksal takım → fiziksel kafa (U1 extruder_map_table). Yoksa kimlik varsayılır. */
  toolMap?: number[];
  /**
   * Parça iptali (exclude_object) durumu — YALNIZ dilimleyici nesneleri işaretlemişse gelir.
   * Alan yoksa arayüz "Parça seç" düğmesini hiç çizmez.
   */
  parts?: { current: string | null; excluded: string[]; count: number };
  /** Ayarlı "şu katmanda duraklat" değeri (yoksa null). */
  pauseAtLayer: number | null;
  /** Spagetti / kirli tabla gözetimi (yalnız destekleyen yazıcıda). */
  defectWatch: { supported: boolean; enabled: boolean; spaghetti: boolean; cleanBed: boolean } | null;
  /** Yüklü filamentler — renk + tip + doluluk (MADDE 12). */
  slots: { slot: number; color: string; type: string; empty: boolean }[];
  job: PrinterJob | null;
}

const ACCENTS = [
  "oklch(0.70 0.15 162)",
  "oklch(0.63 0.21 25)",
  "oklch(0.69 0.17 50)",
  "oklch(0.62 0.14 235)",
  "oklch(0.65 0.20 300)",
  "oklch(0.72 0.17 60)",
];

/**
 * MADDE 13 — kartta gösterilecek ad. Ham dosya adı dilimleyici artıklarıyla dolu
 * ("EN4Plus 0.4 PS5+Dummy+Controller+Display Generic PLA 0.2 3h36m-65b2a0d971"); kullanıcı
 * ürünün adını görmeli. Kimlik (eşleştirme anahtarı) HAM addan üretilmeye devam eder.
 */
function cleanFilename(fn: string): string {
  return printJobDisplayName(fn) || fn;
}

/** Simülasyon/gerçek fark etmeksizin her kartın taşıdığı kontrol alanları — varsayılan: hiçbiri. */
const NO_CAPS_PANEL: PrinterControlCaps = {
  pauseResume: false, speed: false, light: false, lightReadable: false,
  pauseAtLayer: false, filamentChange: false, defectDetection: false,
};

function emptyJobExtras(): Pick<
  PrinterJob,
  "remainingKnown" | "progressSource" | "etaSource" | "plateThumbnail" | "storeImage" |
  "filamentGrams" | "activeSlots" | "live"
> {
  return {
    remainingKnown: false,
    progressSource: "none",
    etaSource: "unknown",
    plateThumbnail: null,
    storeImage: null,
    filamentGrams: null,
    activeSlots: [],
    live: { filePosition: null, fileSize: null, zHeight: null, nozzleX: null, nozzleY: null },
  };
}

// fileMatchKey artık paylaşılan modülde (@/core/printers/file-match) — relay ile AYNI normalize.

function mapState(state: MoonrakerState): PrinterStatus {
  switch (state) {
    case "printing": return "printing";
    case "paused": return "paused";
    case "complete": return "finished";
    case "error": return "error";
    default: return "idle"; // standby, cancelled
  }
}

// ─────────────────────────── DEMO SİMÜLASYONU (config yokken) ───────────────────────────

const FALLBACK_PRODUCTS = [
  "Ejderha Figürü", "Kablo Düzenleyici", "Telefon Standı", "Geometrik Vazo",
  "Sukulent Saksısı", "Robot Figürü", "Kalemlik Organizer", "Gamepad Standı",
  "Kupa Altlığı", "Anahtarlık Seti",
];

const FILAMENTS: { type: string; color: string }[] = [
  { type: "PLA", color: "#e23b3b" },
  { type: "PLA", color: "#2b6cf0" },
  { type: "PETG", color: "#15c47e" },
  { type: "PLA", color: "#f5b400" },
  { type: "PLA", color: "#9b5de5" },
  { type: "PETG", color: "#ef7d3a" },
];

interface SimCfg {
  id: string; name: string; brand: string; model: string; accent: string;
  printSec: number; finishedSec: number; idleSec: number; phaseSec: number; layerTotal: number; seed: number;
}

const SIM_PRINTERS: SimCfg[] = [
  { id: "bambu-a1", name: "Bambu Lab A1", brand: "bambu", model: "A1 Combo", accent: ACCENTS[0], printSec: 360, finishedSec: 22, idleSec: 70, phaseSec: 18, layerTotal: 412, seed: 1 },
  { id: "neptune-pro", name: "Elegoo Neptune 4 Pro", brand: "elegoo", model: "Neptune 4 Pro", accent: ACCENTS[1], printSec: 540, finishedSec: 22, idleSec: 70, phaseSec: 250, layerTotal: 738, seed: 2 },
  { id: "neptune-plus", name: "Elegoo Neptune 4 Plus", brand: "elegoo", model: "Neptune 4 Plus", accent: ACCENTS[2], printSec: 480, finishedSec: 22, idleSec: 70, phaseSec: 430, layerTotal: 905, seed: 3 },
  { id: "snapmaker-u1", name: "Snapmaker U1", brand: "snapmaker", model: "U1", accent: ACCENTS[3], printSec: 420, finishedSec: 22, idleSec: 70, phaseSec: 120, layerTotal: 560, seed: 4 },
];

async function loadProductPool(): Promise<{ name: string; image: string | null }[]> {
  try {
    const products = await prisma.product.findMany({
      where: { imageUrl: { not: null }, hidden: false },
      select: { name: true, imageUrl: true },
      take: 30,
      orderBy: { updatedAt: "desc" },
    });
    const withImg = products
      .filter((p) => p.imageUrl)
      .map((p) => ({ name: p.name, image: p.imageUrl as string }));
    if (withImg.length >= 4) return withImg;
  } catch {
    /* DB yoksa placeholder */
  }
  return FALLBACK_PRODUCTS.map((name) => ({ name, image: null }));
}

function simTemps(filamentType: string, phase: "hot" | "cooling" | "ambient") {
  const isPetg = filamentType === "PETG";
  const nozzleTarget = isPetg ? 240 : 210;
  const bedTarget = isPetg ? 80 : 60;
  if (phase === "hot") return { nozzle: nozzleTarget - 2, nozzleTarget, bed: bedTarget - 1, bedTarget };
  if (phase === "cooling") return { nozzle: Math.round(nozzleTarget * 0.7), nozzleTarget: 0, bed: Math.round(bedTarget * 0.7), bedTarget: 0 };
  return { nozzle: 28, nozzleTarget: 0, bed: 24, bedTarget: 0 };
}

function buildSim(pool: { name: string; image: string | null }[]): PanelPrinter[] {
  const nowSec = Math.floor(Date.now() / 1000);
  return SIM_PRINTERS.map((c) => {
    const cycle = c.printSec + c.finishedSec + c.idleSec;
    const rel = (((nowSec - c.phaseSec) % cycle) + cycle) % cycle;
    const cycleIndex = Math.floor((nowSec - c.phaseSec) / cycle);
    const product = pool[Math.abs(cycleIndex * 3 + c.seed) % pool.length];
    const filament = FILAMENTS[Math.abs(cycleIndex + c.seed) % FILAMENTS.length];
    const startMs = (nowSec - rel) * 1000;
    const endMs = startMs + c.printSec * 1000;

    const common = {
      id: c.id, name: c.name, brand: c.brand, model: c.model, accent: c.accent,
      type: "sim" as const, online: true, note: null, connection: "ok" as const,
      statusMessage: null, warnings: [], currentFilename: null, matchedProductId: null,
      caps: NO_CAPS_PANEL,
      speed: { percent: null, presets: SPEED_PRESETS_PCT, levels: null, level: null },
      light: { supported: false, readable: false, on: null },
      pauseAtLayer: null, defectWatch: null, slots: [],
    };

    if (rel < c.printSec) {
      return {
        ...common, status: "printing" as const, temps: simTemps(filament.type, "hot"),
        job: { ...emptyJobExtras(), remainingKnown: true, productName: product.name, productImage: product.image, storeImage: product.image, startedAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString(), progress: Math.min(1, Math.max(0, rel / c.printSec)), remainingSec: Math.max(0, c.printSec - rel), layerCurrent: Math.round((rel / c.printSec) * c.layerTotal), layerTotal: c.layerTotal, filamentType: filament.type, filamentColor: filament.color },
      };
    }
    if (rel < c.printSec + c.finishedSec) {
      return {
        ...common, status: "finished" as const, temps: simTemps(filament.type, "cooling"),
        job: { ...emptyJobExtras(), remainingKnown: true, productName: product.name, productImage: product.image, storeImage: product.image, startedAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString(), progress: 1, remainingSec: 0, layerCurrent: c.layerTotal, layerTotal: c.layerTotal, filamentType: filament.type, filamentColor: filament.color },
      };
    }
    return { ...common, status: "idle" as const, temps: simTemps(filament.type, "ambient"), job: null };
  });
}

// ─────────────────────────────────── GET ───────────────────────────────────

export async function GET(req: NextRequest) {
  await ensureRuntimeSchema();

  /**
   * `?fresh=1` — SAYFA AÇILIŞI: önbelleği ve çevrimdışı geri çekilmesini ATLA.
   *
   * Yazıcı durumu saniyesi saniyesine doğru olmalı ("buranın hep çok güncel olması
   * gerekiyor"). İki şey buna engeldi: 4 saniyelik durum önbelleği ve çevrimdışı damgalanmış
   * yazıcıda 120 saniyeye kadar çıkan yeniden-deneme beklemesi. İkincisi daha kötüydü: kısa
   * bir kesintiden sonra sayfayı açtığında yazıcı dakikalarca "ulaşılamadı" kalabiliyordu.
   * Bu bayrak yalnız MOUNT'ta gönderilir; 5 saniyelik düzenli yoklama önbelleği kullanmaya
   * devam eder (yazıcılar boşuna yorulmasın).
   */
  if (req.nextUrl.searchParams.get("fresh") === "1") {
    for (const c of await getEnabledPrinterConfigs()) {
      if (c.brand === "bambu") bumpBambuStatus(c.host, c.serial ?? "");
      else bumpMoonrakerStatus(c.host, c.port);
    }
  }

  // MADDE 20: yapılandırma satırları neredeyse hiç değişmez ama panel 5sn'de bir buluta
  // sorguluyordu (uzak-HTTP libSQL'de her sorgu ~96ms ve SIRALI). 15sn önbellek.
  const configs = await getEnabledPrinterConfigs();

  // Hiç yazıcı yapılandırılmamış → DEMO
  if (configs.length === 0) {
    const pool = await loadProductPool();
    return NextResponse.json({ printers: buildSim(pool), simulated: true, configured: false });
  }

  // Ürün eşleştirmeleri (printerConfigId::filename → productId) — 30sn TTL önbellek
  // (eskiden her 5sn'de sınırsız findMany; tablo baskı geçmişiyle büyüyor).
  const matches = await getPrintFileMatches();
  // Plan D: kart görseli slicer'ın gömülü render'ı. Yazıcıdan gelmiyorsa KENDİ
  // kütüphanemizdeki dosyadan çıkarılır (Bambu'da tek yol bu).
  const modelFileMap = await getModelFilesForPreview();
  const matchMap = new Map(matches.map((m) => [`${m.printerConfigId}::${fileMatchKey(m.filename)}`, m.productId]));
  const productMap = await getMatchedProducts();

  const nowMs = Date.now();

  const printers: PanelPrinter[] = await Promise.all(
    configs.map(async (c, i): Promise<PanelPrinter> => {
      const accent = c.accent || ACCENTS[i % ACCENTS.length];
      const base: PanelPrinter = {
        id: c.id, name: c.name, brand: c.brand, model: c.model || "",
        accent, type: (c.type === "bambu" ? "bambu" : "moonraker"),
        status: "idle", online: false, note: null, connection: "offline",
        statusMessage: null, warnings: [],
        currentFilename: null, matchedProductId: null,
        temps: { nozzle: 0, nozzleTarget: 0, bed: 0, bedTarget: 0 },
        caps: NO_CAPS_PANEL,
        speed: { percent: null, presets: SPEED_PRESETS_PCT, levels: null, level: null },
        light: { supported: false, readable: false, on: null },
        pauseAtLayer: null, defectWatch: null, slots: [], job: null,
      };

      if (c.type === "bambu") {
        // MADDE 14: "kurulumu tamamlanmamış" ≠ "bağlantı yok". Kullanıcı ilkinde ayar yapmalı,
        // ikincisinde yazıcıyı açmalı — kart bunları ayrı göstermeli.
        if (!c.accessCode || !c.serial) {
          return { ...base, connection: "unconfigured", note: "Kurulum tamamlanmadı — access code ve seri no gerekiyor." };
        }
        const bs = await getBambuStatusCached(c.host, c.accessCode, c.serial);
        if (!bs.online) {
          return { ...base, connection: "offline", note: `Yazıcıya ulaşılamadı — ${c.host}` };
        }
        const bStatus = mapBambuState(bs.gcodeState);
        const bHasJob = !!bs.filename && (bStatus === "printing" || bStatus === "paused" || bStatus === "finished");
        const slots = await getBambuSlotsCached(c.host, c.accessCode, c.serial);
        let bJob: PrinterJob | null = null;
        let bMatchedId: string | null = null;
        if (bHasJob && bs.filename) {
          // MADDE 1: yüzde + yazıcının KENDİ kalan süresi (mc_remaining_time) tek hesaba girer.
          const picked = pickProgress({ printerPercent: bs.percent });
          const elapsedSec = bs.startedAtMs != null ? Math.max(0, (nowMs - bs.startedAtMs) / 1000) : null;
          const eta = resolveEta({
            progress: picked.progress,
            elapsedSec,
            slicerEstimateSec: null,
            printerRemainingSec: bs.remainingSec,
          });
          const remaining = eta.remainingSec ?? 0;
          const endMs = nowMs + remaining * 1000;
          // Geçen süre bilinmiyorsa BAŞLANGIÇ "şimdi"dir. `endMs` yazmak başlangıcı GELECEĞE
          // taşıyordu (hazırlık aşamasındaki A1'de: başlangıç = şimdi + 90dk) ve panel baskı
          // boyunca 0 geçen süre gösteriyordu.
          const startMs = eta.elapsedSec != null ? nowMs - eta.elapsedSec * 1000 : nowMs;
          bMatchedId = matchMap.get(`${c.id}::${fileMatchKey(bs.filename)}`) ?? null;
          const matched = bMatchedId ? productMap.get(bMatchedId) : undefined;
          const activeSlots = bs.activeTray != null ? [bs.activeTray] : [];
          const activeSlot = bs.activeTray != null ? slots.find((s) => s.slot === bs.activeTray) : undefined;
          /**
           * PLAN D — model görseli slicer'ın kendi render'ı.
           * Bambu 3MF yazıyor ve önizleme zip'in İÇİNDE; yazıcıdan alınamıyor. Eşleşen ürünün
           * bu yazıcıya ait dosyasından çıkarılır (uzun önbellekli ayrı uç — JSON'a gömülmez).
           */
          const bModelId = bMatchedId ? modelFileMap.get(`${bMatchedId}|${c.id}`) : null;
          const bPlateUrl = bModelId ? `/api/models/${bModelId}/slicer-preview` : null;
          bJob = {
            ...emptyJobExtras(),
            productName: matched?.name || cleanFilename(bs.filename),
            productImage: bPlateUrl || matched?.imageUrl || null,
            plateThumbnail: bPlateUrl,
            storeImage: matched?.imageUrl ?? null,
            startedAt: new Date(startMs).toISOString(),
            endsAt: new Date(endMs).toISOString(),
            progress: picked.progress,
            remainingSec: remaining,
            remainingKnown: eta.remainingSec != null,
            progressSource: picked.source,
            etaSource: eta.source,
            layerCurrent: bs.layerNum,
            layerTotal: bs.totalLayerNum ?? 0,
            // Gerçek AMS verisi okunmuyorsa UYDURMA "PLA" gösterme — boş bırak, UI çipi gizler.
            filamentType: activeSlot?.type ?? "",
            filamentColor: activeSlot && !activeSlot.empty ? activeSlot.color : "",
            activeSlots,
          };
        }
        return {
          ...base,
          online: true,
          connection: "ok",
          status: bStatus,
          // Hata/duraklatma nedeni ve uyarılar kartta görünsün (mobilde vardı, masaüstünde yoktu).
          statusMessage:
            bs.statusReason ??
            (bStatus === "error"
              ? `Baskı hatayla durdu${bs.printError ? ` (kod 0x${(bs.printError >>> 0).toString(16).toUpperCase()})` : ""}`
              : null),
          warnings: bs.warnings.map((w: BambuWarning) => ({ code: w.code, level: w.level, text: w.text })),
          currentFilename: bs.filename,
          matchedProductId: bMatchedId,
          temps: { nozzle: bs.nozzle, nozzleTarget: bs.nozzleTarget, bed: bs.bed, bedTarget: bs.bedTarget },
          caps: {
            pauseResume: true, speed: true, light: false, lightReadable: false,
            pauseAtLayer: false, filamentChange: false, defectDetection: false,
          },
          speed: {
            percent: BAMBU_SPEED_LEVELS.find((l) => l.level === bs.speedLevel)?.pct ?? null,
            presets: SPEED_PRESETS_PCT,
            levels: BAMBU_SPEED_LEVELS,
            level: bs.speedLevel,
          },
          slots,
          job: bJob,
        };
      }

      if (c.type !== "moonraker") {
        return { ...base, connection: "unsupported", note: "Bu yazıcı uygulamadan yönetilemiyor." };
      }
      if (!c.host) {
        return { ...base, connection: "unconfigured", note: "Kurulum tamamlanmadı — yazıcının IP adresi gerekiyor." };
      }

      const st = await getMoonrakerStatusCached(c.host, c.port);
      if (!st.online) {
        return { ...base, connection: "offline", note: `Yazıcıya ulaşılamadı — ${c.host}` };
      }

      const status = mapState(st.state);
      const extras = await getMoonrakerExtrasCached(c.host, c.port);
      const hasJob = !!st.filename && (st.state === "printing" || st.state === "paused" || st.state === "complete");
      let job: PrinterJob | null = null;
      let matchedId: string | null = null;

      if (hasJob && st.filename) {
        const meta = await getMoonrakerMetaCached(c.host, c.port, st.filename);
        // MADDE 1: ilerleme adaptörde DOĞRU kaynaktan seçildi (M73 → bayt); süre hesabı
        // src/core/printers/eta.ts'te, üç marka için AYNI.
        const eta = resolveEta({
          progress: st.progress,
          elapsedSec: st.printDurationSec,
          slicerEstimateSec: meta?.estimatedTimeSec ?? null,
          printerRemainingSec: null,
          // Hız yalnız ilerleme İLERLEYİNCE tazelenir; arada geri sayım düzgün akar.
          prev: etaHafizasiOku(c.id, st.filename),
        });
        etaHafizasiYaz(c.id, st.filename, st.progress, eta.totalSec);
        const remainingSec = eta.remainingSec ?? 0;
        const startMs = nowMs - st.printDurationSec * 1000;
        const endMs = nowMs + remainingSec * 1000;

        // Güncel katman: Klipper info.current_layer (slicer yazıyorsa) → yoksa
        // Z yüksekliğinden tahmin (Fluidd gibi): floor((z - ilk_katman) / katman_yük.) + 1.
        const totalLayer = st.totalLayer ?? meta?.totalLayer ?? 0;
        let layerCurrent: number | null = st.currentLayer;
        if ((layerCurrent == null || layerCurrent <= 0) && st.zHeight != null && meta?.layerHeight && meta.layerHeight > 0) {
          const flh = meta.firstLayerHeight ?? meta.layerHeight;
          const est = Math.floor((st.zHeight - flh) / meta.layerHeight + 1e-4) + 1;
          layerCurrent = totalLayer > 0 ? Math.max(1, Math.min(est, totalLayer)) : Math.max(1, est);
        }

        matchedId = matchMap.get(`${c.id}::${fileMatchKey(st.filename)}`) ?? null;
        const matched = matchedId ? productMap.get(matchedId) : undefined;
        // MADDE 3: BASILAN PLAKANIN görüntüsü mağaza fotoğrafını YENER — kullanıcı tablada ne
        // olduğunu görmeli. Moonraker'ın ürettiği .thumbs varsa o, yoksa gcode'a gömülü blok.
        // Gcode'a gömülü blok 800×800 olabiliyor (~130 KB) — 5sn'de bir JSON'a gömmek yerine
        // küçük bir URL veriyoruz; görsel ayrı, uzun önbellekli uçtan gelir.
        /**
         * PLAN D sırası: (1) yazıcının ürettiği .thumbs, (2) gcode'a gömülü blok,
         * (3) KENDİ kütüphanemizdeki dosyadan çıkarılan slicer render'ı.
         * Üçüncüsü olmadan görsel üretmeyen kurulumlarda (ölçüldü: Snapmaker U1) kart
         * görselsiz kalıyordu.
         */
        const kutuphaneModelId = matchedId ? modelFileMap.get(`${matchedId}|${c.id}`) : null;
        const plateThumb = meta?.thumbnailRelPath
          ? moonrakerThumbUrl(c.host, c.port, st.filename, meta.thumbnailRelPath)
          : meta?.thumbnailDataUrl
            ? `/api/printers/${c.id}/plate-thumbnail?f=${encodeURIComponent(st.filename)}`
            : kutuphaneModelId
              ? `/api/models/${kutuphaneModelId}/slicer-preview`
              : null;
        // MADDE 12: baskıda kullanılan slot(lar)ın rengi. Tek kafalı yazıcıda dilimleyicinin
        // yazdığı renk kullanılır (yazıcıda slot kavramı yok).
        const activeSlots = extras.activeSlots;
        const activeSlot = activeSlots.length ? extras.slots.find((s) => s.slot === activeSlots[0]) : undefined;
        const filamentColor =
          (activeSlot && !activeSlot.empty ? activeSlot.color : null) ??
          meta?.filamentColours[0] ??
          "";
        job = {
          ...emptyJobExtras(),
          productName: matched?.name || cleanFilename(st.filename),
          productImage: plateThumb || matched?.imageUrl || null,
          plateThumbnail: plateThumb,
          storeImage: matched?.imageUrl ?? null,
          startedAt: new Date(startMs).toISOString(),
          endsAt: new Date(endMs).toISOString(),
          progress: st.progress,
          remainingSec,
          remainingKnown: eta.remainingSec != null,
          progressSource: st.progressSource,
          etaSource: eta.source,
          layerCurrent,
          layerTotal: totalLayer,
          // Bilinmiyorsa boş — UI uydurma "PLA" çipi göstermesin.
          filamentType: meta?.filamentType || activeSlot?.type || "",
          filamentColor,
          filamentGrams: meta?.filamentGrams ?? null,
          activeSlots,
          live: {
            filePosition: st.filePosition,
            fileSize: st.fileSize,
            zHeight: st.zHeight,
            nozzleX: st.posX,
            nozzleY: st.posY,
          },
        };
      }

      return {
        ...base,
        online: true,
        connection: "ok",
        status,
        // Duraklatma/hata NEDENİ (örn. "Filament runout") kartta görünsün.
        statusMessage: status === "error" || status === "paused" ? st.message : null,
        // MADDE 14 + 22: duraklatma nedeni ve firmware uyarıları (spagetti / kirli tabla dahil)
        // panele düşer — eskiden yalnız telefona gidiyordu.
        warnings: [
          ...((status === "error" || status === "paused") && st.message
            ? [{ code: null, level: status === "error" ? ("serious" as const) : ("common" as const), text: st.message }]
            : []),
          ...extras.alerts
            .filter((a) => a.text !== st.message)
            .map((a) => ({ code: a.code, level: "common" as const, text: a.text })),
        ],
        currentFilename: st.filename,
        matchedProductId: matchedId,
        temps: {
          nozzle: st.nozzle, nozzleTarget: st.nozzleTarget, bed: st.bed, bedTarget: st.bedTarget,
          // Tek kafalıda ek bilgi yok — diziyi boş bırakıp arayüzü kalabalıklaştırmayalım.
          nozzles: st.nozzles.length > 1 ? st.nozzles : undefined,
        },
        caps: {
          pauseResume: true,
          speed: extras.caps.speed,
          light: extras.caps.lightKind !== "none",
          lightReadable: extras.light.readable,
          pauseAtLayer: extras.caps.pauseAtLayer,
          filamentChange: extras.caps.filamentChange,
          defectDetection: extras.caps.defectDetection,
        },
        speed: { percent: st.speedPercent, presets: SPEED_PRESETS_PCT, levels: null, level: null },
        light: extras.light,
        pauseAtLayer: extras.pauseAtLayer,
        defectWatch: extras.defectWatch.supported ? extras.defectWatch : null,
        slots: extras.slots,
        // Boşsa GÖNDERME — arayüz eşleme yokken kimliğe düşer (tek kafalı yazıcılar).
        toolMap: extras.toolMap.length ? extras.toolMap : undefined,
        // Nesne tanımlı değilse alan HİÇ gönderilmez → arayüz düğmeyi çizmez.
        parts: st.currentObject || st.excludedObjects.length
          ? { current: st.currentObject, excluded: st.excludedObjects, count: 0 }
          : undefined,
        job,
      };
    })
  );

  return NextResponse.json({ printers, simulated: false, configured: true });
}
