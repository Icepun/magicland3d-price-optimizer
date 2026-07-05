import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { moonrakerThumbUrl, type MoonrakerState } from "@/core/printers/moonraker";
import { mapBambuState } from "@/core/printers/bambu";
import { fileMatchKey } from "@/core/printers/file-match";
// Canlı yoklama yerine PAYLAŞILAN önbellek: relay ile tek yoklayıcı, çevrimdışı yazıcıya backoff
// (30sn'de bir dene, arada anında dön) → çevrimdışı yazıcı her 5sn'lik paneli 1.5-2.2sn geciktirmez.
import {
  getMoonrakerStatusCached, getBambuStatusCached, getMoonrakerMetaCached, getPrintFileMatches,
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
  /** Hata/duraklatma NEDENİ (Moonraker print_stats.message / Bambu hata kodu) — kartta gösterilir.
      Mobil snapshot'ta zaten vardı; masaüstü paneli bunu düşürüyordu. */
  statusMessage: string | null;
  /** Çalışan baskının ham gcode dosya adı (eşleştirme + kontrol için). */
  currentFilename: string | null;
  matchedProductId: string | null;
  temps: { nozzle: number; nozzleTarget: number; bed: number; bedTarget: number };
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

function cleanFilename(fn: string): string {
  const base = fn.includes("/") ? fn.slice(fn.lastIndexOf("/") + 1) : fn;
  return base.replace(/\.(gcode|gco|g|3mf)$/i, "").replace(/_+/g, " ").trim() || base;
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
      type: "sim" as const, online: true, note: null, statusMessage: null,
      currentFilename: null, matchedProductId: null,
    };

    if (rel < c.printSec) {
      return {
        ...common, status: "printing" as const, temps: simTemps(filament.type, "hot"),
        job: { productName: product.name, productImage: product.image, startedAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString(), progress: Math.min(1, Math.max(0, rel / c.printSec)), remainingSec: Math.max(0, c.printSec - rel), layerCurrent: Math.round((rel / c.printSec) * c.layerTotal), layerTotal: c.layerTotal, filamentType: filament.type, filamentColor: filament.color },
      };
    }
    if (rel < c.printSec + c.finishedSec) {
      return {
        ...common, status: "finished" as const, temps: simTemps(filament.type, "cooling"),
        job: { productName: product.name, productImage: product.image, startedAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString(), progress: 1, remainingSec: 0, layerCurrent: c.layerTotal, layerTotal: c.layerTotal, filamentType: filament.type, filamentColor: filament.color },
      };
    }
    return { ...common, status: "idle" as const, temps: simTemps(filament.type, "ambient"), job: null };
  });
}

// ─────────────────────────────────── GET ───────────────────────────────────

export async function GET() {
  await ensureRuntimeSchema();

  const configs = await prisma.printerConfig.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  // Hiç yazıcı yapılandırılmamış → DEMO
  if (configs.length === 0) {
    const pool = await loadProductPool();
    return NextResponse.json({ printers: buildSim(pool), simulated: true, configured: false });
  }

  // Ürün eşleştirmeleri (printerConfigId::filename → productId) — 30sn TTL önbellek
  // (eskiden her 5sn'de sınırsız findMany; tablo baskı geçmişiyle büyüyor).
  const matches = await getPrintFileMatches();
  const matchMap = new Map(matches.map((m) => [`${m.printerConfigId}::${fileMatchKey(m.filename)}`, m.productId]));
  const pids = [...new Set(matches.map((m) => m.productId))];
  const products = pids.length
    ? await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, name: true, imageUrl: true } })
    : [];
  const productMap = new Map(products.map((p) => [p.id, p]));

  const nowMs = Date.now();

  const printers: PanelPrinter[] = await Promise.all(
    configs.map(async (c, i): Promise<PanelPrinter> => {
      const accent = c.accent || ACCENTS[i % ACCENTS.length];
      const base: PanelPrinter = {
        id: c.id, name: c.name, brand: c.brand, model: c.model || "",
        accent, type: (c.type === "bambu" ? "bambu" : "moonraker"),
        status: "idle", online: false, note: null, statusMessage: null,
        currentFilename: null, matchedProductId: null,
        temps: { nozzle: 0, nozzleTarget: 0, bed: 0, bedTarget: 0 }, job: null,
      };

      if (c.type === "bambu") {
        if (!c.accessCode || !c.serial) {
          return { ...base, note: "Access code + seri no gerekli (Yönet → düzenle)" };
        }
        const bs = await getBambuStatusCached(c.host, c.accessCode, c.serial);
        if (!bs.online) {
          return { ...base, note: `Çevrimdışı — ${c.host} (LAN + Developer Mode açık mı?)` };
        }
        const bStatus = mapBambuState(bs.gcodeState);
        const bHasJob = !!bs.filename && (bStatus === "printing" || bStatus === "paused" || bStatus === "finished");
        let bJob: PrinterJob | null = null;
        let bMatchedId: string | null = null;
        if (bHasJob && bs.filename) {
          const pct = Math.min(1, Math.max(0, bs.percent / 100));
          const remaining = bs.remainingSec ?? 0;
          let totalSec: number;
          if (pct > 0.001 && pct < 1 && remaining > 0) totalSec = remaining / (1 - pct);
          else totalSec = Math.max(60, remaining);
          const endMs = nowMs + remaining * 1000;
          const startMs = endMs - totalSec * 1000;
          bMatchedId = matchMap.get(`${c.id}::${fileMatchKey(bs.filename)}`) ?? null;
          const matched = bMatchedId ? productMap.get(bMatchedId) : undefined;
          bJob = {
            productName: matched?.name || cleanFilename(bs.filename),
            productImage: matched?.imageUrl || null,
            startedAt: new Date(startMs).toISOString(),
            endsAt: new Date(endMs).toISOString(),
            progress: pct,
            remainingSec: remaining,
            layerCurrent: bs.layerNum,
            layerTotal: bs.totalLayerNum ?? 0,
            // Gerçek AMS verisi okunmuyorsa UYDURMA "PLA" gösterme — boş bırak, UI çipi gizler.
            filamentType: "",
            filamentColor: "",
          };
        }
        return {
          ...base,
          online: true,
          status: bStatus,
          // Hata nedeni kartta görünsün (mobilde vardı, masaüstünde yoktu).
          statusMessage:
            bStatus === "error"
              ? `Baskı hatayla durdu${bs.printError ? ` (kod 0x${(bs.printError >>> 0).toString(16).toUpperCase()})` : ""}`
              : null,
          currentFilename: bs.filename,
          matchedProductId: bMatchedId,
          temps: { nozzle: bs.nozzle, nozzleTarget: bs.nozzleTarget, bed: bs.bed, bedTarget: bs.bedTarget },
          job: bJob,
        };
      }

      const st = await getMoonrakerStatusCached(c.host, c.port);
      if (!st.online) {
        return { ...base, online: false, note: `Çevrimdışı — ${c.host} ulaşılamadı` };
      }

      const status = mapState(st.state);
      const hasJob = !!st.filename && (st.state === "printing" || st.state === "paused" || st.state === "complete");
      let job: PrinterJob | null = null;
      let matchedId: string | null = null;

      if (hasJob && st.filename) {
        const meta = await getMoonrakerMetaCached(c.host, c.port, st.filename);
        // ETA STABİLİZASYONU: süre/ilerleme ekstrapolasyonu %1'de gürültüyü 100× büyütüp geri
        // sayımı her poll'da zıplatıyordu. Erken evrede (%<5) dilimleyici tahmini, %5-15 arası
        // harman, %15 sonrası gerçek hız.
        const extrapolated = st.progress >= 0.01 && st.printDurationSec > 0 ? st.printDurationSec / st.progress : null;
        const slicerEst = meta?.estimatedTimeSec && meta.estimatedTimeSec > 0 ? meta.estimatedTimeSec : null;
        let estTotalSec: number;
        if (extrapolated != null && (st.progress >= 0.15 || !slicerEst)) {
          estTotalSec = extrapolated;
        } else if (slicerEst && extrapolated != null && st.progress >= 0.05) {
          const w = (st.progress - 0.05) / 0.10; // %5→0 … %15→1
          estTotalSec = slicerEst * (1 - w) + extrapolated * w;
        } else if (slicerEst) {
          estTotalSec = slicerEst;
        } else {
          estTotalSec = Math.max(st.printDurationSec, 60);
        }
        const remainingSec = Math.max(0, estTotalSec - st.printDurationSec);
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
        const thumb = meta?.thumbnailRelPath
          ? moonrakerThumbUrl(c.host, c.port, st.filename, meta.thumbnailRelPath)
          : null;
        job = {
          productName: matched?.name || cleanFilename(st.filename),
          productImage: matched?.imageUrl || thumb,
          startedAt: new Date(startMs).toISOString(),
          endsAt: new Date(endMs).toISOString(),
          progress: st.progress,
          remainingSec,
          layerCurrent,
          layerTotal: totalLayer,
          // Bilinmiyorsa boş — UI uydurma "PLA" çipi göstermesin.
          filamentType: meta?.filamentType || "",
          filamentColor: "",
        };
      }

      return {
        ...base,
        online: true,
        status,
        // Duraklatma/hata NEDENİ (örn. "Filament runout") kartta görünsün.
        statusMessage: status === "error" || status === "paused" ? st.message : null,
        currentFilename: st.filename,
        matchedProductId: matchedId,
        temps: { nozzle: st.nozzle, nozzleTarget: st.nozzleTarget, bed: st.bed, bedTarget: st.bedTarget },
        job,
      };
    })
  );

  return NextResponse.json({ printers, simulated: false, configured: true });
}
