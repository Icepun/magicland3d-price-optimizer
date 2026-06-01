import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  fetchMoonrakerStatus,
  fetchMoonrakerMeta,
  moonrakerThumbUrl,
  type MoonrakerState,
} from "@/core/printers/moonraker";
import { getBambuStatus, mapBambuState } from "@/core/printers/bambu";

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
      type: "sim" as const, online: true, note: null,
      currentFilename: null, matchedProductId: null,
    };

    if (rel < c.printSec) {
      return {
        ...common, status: "printing" as const, temps: simTemps(filament.type, "hot"),
        job: { productName: product.name, productImage: product.image, startedAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString(), layerTotal: c.layerTotal, filamentType: filament.type, filamentColor: filament.color },
      };
    }
    if (rel < c.printSec + c.finishedSec) {
      return {
        ...common, status: "finished" as const, temps: simTemps(filament.type, "cooling"),
        job: { productName: product.name, productImage: product.image, startedAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString(), layerTotal: c.layerTotal, filamentType: filament.type, filamentColor: filament.color },
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

  // Ürün eşleştirmeleri (printerConfigId::filename → productId)
  const matches = await prisma.printFileProduct.findMany();
  const matchMap = new Map(matches.map((m) => [`${m.printerConfigId}::${m.filename}`, m.productId]));
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
        status: "idle", online: false, note: null,
        currentFilename: null, matchedProductId: null,
        temps: { nozzle: 0, nozzleTarget: 0, bed: 0, bedTarget: 0 }, job: null,
      };

      if (c.type === "bambu") {
        if (!c.accessCode || !c.serial) {
          return { ...base, note: "Access code + seri no gerekli (Yönet → düzenle)" };
        }
        const bs = await getBambuStatus(c.host, c.accessCode, c.serial);
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
          bMatchedId = matchMap.get(`${c.id}::${bs.filename}`) ?? null;
          const matched = bMatchedId ? productMap.get(bMatchedId) : undefined;
          bJob = {
            productName: matched?.name || cleanFilename(bs.filename),
            productImage: matched?.imageUrl || null,
            startedAt: new Date(startMs).toISOString(),
            endsAt: new Date(endMs).toISOString(),
            layerTotal: bs.totalLayerNum ?? 0,
            filamentType: "PLA",
            filamentColor: "#9ca3af",
          };
        }
        return {
          ...base,
          online: true,
          status: bStatus,
          currentFilename: bs.filename,
          matchedProductId: bMatchedId,
          temps: { nozzle: bs.nozzle, nozzleTarget: bs.nozzleTarget, bed: bs.bed, bedTarget: bs.bedTarget },
          job: bJob,
        };
      }

      const st = await fetchMoonrakerStatus(c.host, c.port);
      if (!st.online) {
        return { ...base, online: false, note: `Çevrimdışı — ${c.host} ulaşılamadı` };
      }

      const status = mapState(st.state);
      const hasJob = !!st.filename && (st.state === "printing" || st.state === "paused" || st.state === "complete");
      let job: PrinterJob | null = null;
      let matchedId: string | null = null;

      if (hasJob && st.filename) {
        const meta = await fetchMoonrakerMeta(c.host, c.port, st.filename);
        // İlerleme-doğru tahmini toplam süre: end = start + printDuration/progress
        // → istemcinin hesapladığı ilerleme = gerçek ilerleme.
        let estTotalSec: number;
        if (st.progress >= 0.01 && st.printDurationSec > 0) {
          estTotalSec = st.printDurationSec / st.progress;
        } else if (meta?.estimatedTimeSec) {
          estTotalSec = meta.estimatedTimeSec;
        } else {
          estTotalSec = Math.max(st.printDurationSec, 60);
        }
        const startMs = nowMs - st.printDurationSec * 1000;
        const endMs = startMs + estTotalSec * 1000;
        matchedId = matchMap.get(`${c.id}::${st.filename}`) ?? null;
        const matched = matchedId ? productMap.get(matchedId) : undefined;
        const thumb = meta?.thumbnailRelPath
          ? moonrakerThumbUrl(c.host, c.port, st.filename, meta.thumbnailRelPath)
          : null;
        job = {
          productName: matched?.name || cleanFilename(st.filename),
          productImage: matched?.imageUrl || thumb,
          startedAt: new Date(startMs).toISOString(),
          endsAt: new Date(endMs).toISOString(),
          layerTotal: st.totalLayer ?? meta?.totalLayer ?? 0,
          filamentType: meta?.filamentType || "PLA",
          filamentColor: "#9ca3af",
        };
      }

      return {
        ...base,
        online: true,
        status,
        currentFilename: st.filename,
        matchedProductId: matchedId,
        temps: { nozzle: st.nozzle, nozzleTarget: st.nozzleTarget, bed: st.bed, bedTarget: st.bedTarget },
        job,
      };
    })
  );

  return NextResponse.json({ printers, simulated: false, configured: true });
}
