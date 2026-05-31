import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * YAZICI PANELİ — SİMÜLASYON kaynağı (placeholder).
 *
 * Şu an gerçek yazıcılara bağlı DEĞİL; zamandan deterministik olarak 4 yazıcının
 * canlı baskı durumunu üretir (ilerler, biter, yenisi başlar). İleride her marka
 * için gerçek adaptör (Bambu MQTT / Elegoo Moonraker / Snapmaker) buraya takılacak;
 * dönen şekil (SimPrinter) aynı kalacağı için UI hiç değişmeyecek.
 *
 * "Basılan ürün" olarak gerçek katalog ürünlerini (görselli) kullanır; yoksa
 * yerleşik placeholder listesine düşer.
 */

export type PrinterStatus = "printing" | "finished" | "idle" | "paused" | "error";

export interface PrinterJob {
  productName: string;
  productImage: string | null;
  startedAt: string; // ISO — client ilerlemeyi buradan akıcı hesaplar
  endsAt: string; // ISO
  layerTotal: number;
  filamentType: string;
  filamentColor: string;
}

export interface SimPrinter {
  id: string;
  name: string;
  brand: "bambu" | "elegoo" | "snapmaker";
  model: string;
  accent: string;
  status: PrinterStatus;
  online: boolean;
  temps: { nozzle: number; nozzleTarget: number; bed: number; bedTarget: number };
  job: PrinterJob | null;
}

const FALLBACK_PRODUCTS = [
  "Ejderha Figürü",
  "Kablo Düzenleyici",
  "Telefon Standı",
  "Geometrik Vazo",
  "Sukulent Saksısı",
  "Robot Figürü",
  "Kalemlik Organizer",
  "Gamepad Standı",
  "Kupa Altlığı",
  "Anahtarlık Seti",
];

const FILAMENTS: { type: string; color: string }[] = [
  { type: "PLA", color: "#e23b3b" },
  { type: "PLA", color: "#2b6cf0" },
  { type: "PETG", color: "#15c47e" },
  { type: "PLA", color: "#f5b400" },
  { type: "PLA", color: "#9b5de5" },
  { type: "PETG", color: "#ef7d3a" },
];

interface Cfg {
  id: string;
  name: string;
  brand: SimPrinter["brand"];
  model: string;
  accent: string;
  printSec: number;
  finishedSec: number;
  idleSec: number;
  phaseSec: number;
  layerTotal: number;
  seed: number;
}

const PRINTERS: Cfg[] = [
  { id: "bambu-a1", name: "Bambu Lab A1", brand: "bambu", model: "A1 Combo", accent: "oklch(0.70 0.15 162)", printSec: 360, finishedSec: 22, idleSec: 70, phaseSec: 18, layerTotal: 412, seed: 1 },
  { id: "neptune-pro", name: "Elegoo Neptune 4 Pro", brand: "elegoo", model: "Neptune 4 Pro", accent: "oklch(0.63 0.21 25)", printSec: 540, finishedSec: 22, idleSec: 70, phaseSec: 250, layerTotal: 738, seed: 2 },
  { id: "neptune-plus", name: "Elegoo Neptune 4 Plus", brand: "elegoo", model: "Neptune 4 Plus", accent: "oklch(0.69 0.17 50)", printSec: 480, finishedSec: 22, idleSec: 70, phaseSec: 430, layerTotal: 905, seed: 3 },
  { id: "snapmaker-u1", name: "Snapmaker U1", brand: "snapmaker", model: "U1", accent: "oklch(0.62 0.14 235)", printSec: 420, finishedSec: 22, idleSec: 70, phaseSec: 120, layerTotal: 560, seed: 4 },
];

async function loadProductPool(): Promise<{ name: string; image: string | null }[]> {
  try {
    await ensureRuntimeSchema();
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

function tempsFor(filamentType: string, phase: "hot" | "cooling" | "ambient") {
  const isPetg = filamentType === "PETG";
  const nozzleTarget = isPetg ? 240 : 210;
  const bedTarget = isPetg ? 80 : 60;
  if (phase === "hot") {
    return { nozzle: nozzleTarget - 2, nozzleTarget, bed: bedTarget - 1, bedTarget };
  }
  if (phase === "cooling") {
    return { nozzle: Math.round(nozzleTarget * 0.7), nozzleTarget: 0, bed: Math.round(bedTarget * 0.7), bedTarget: 0 };
  }
  return { nozzle: 28, nozzleTarget: 0, bed: 24, bedTarget: 0 };
}

export async function GET() {
  const pool = await loadProductPool();
  const nowSec = Math.floor(Date.now() / 1000);

  const printers: SimPrinter[] = PRINTERS.map((c) => {
    const cycle = c.printSec + c.finishedSec + c.idleSec;
    const rel = (((nowSec - c.phaseSec) % cycle) + cycle) % cycle;
    const cycleIndex = Math.floor((nowSec - c.phaseSec) / cycle);

    const product = pool[Math.abs(cycleIndex * 3 + c.seed) % pool.length];
    const filament = FILAMENTS[Math.abs(cycleIndex + c.seed) % FILAMENTS.length];

    const startMs = (nowSec - rel) * 1000;
    const endMs = startMs + c.printSec * 1000;

    if (rel < c.printSec) {
      return {
        id: c.id, name: c.name, brand: c.brand, model: c.model, accent: c.accent,
        status: "printing", online: true,
        temps: tempsFor(filament.type, "hot"),
        job: {
          productName: product.name,
          productImage: product.image,
          startedAt: new Date(startMs).toISOString(),
          endsAt: new Date(endMs).toISOString(),
          layerTotal: c.layerTotal,
          filamentType: filament.type,
          filamentColor: filament.color,
        },
      };
    }

    if (rel < c.printSec + c.finishedSec) {
      // Yeni bitti — kutlama penceresi
      return {
        id: c.id, name: c.name, brand: c.brand, model: c.model, accent: c.accent,
        status: "finished", online: true,
        temps: tempsFor(filament.type, "cooling"),
        job: {
          productName: product.name,
          productImage: product.image,
          startedAt: new Date(startMs).toISOString(),
          endsAt: new Date(endMs).toISOString(), // geçmişte → client %100 görür
          layerTotal: c.layerTotal,
          filamentType: filament.type,
          filamentColor: filament.color,
        },
      };
    }

    // Boşta — hazır
    return {
      id: c.id, name: c.name, brand: c.brand, model: c.model, accent: c.accent,
      status: "idle", online: true,
      temps: tempsFor(filament.type, "ambient"),
      job: null,
    };
  });

  return NextResponse.json({ printers, simulated: true });
}
