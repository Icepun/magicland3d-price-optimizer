import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { invalidateOrdersCache } from "@/lib/orders-cache";

const SEED_KEY = "texCargoSeed.v1";

const baremRules = [
  {
    name: "TEX • Avantajlı Barem • 0-200 TL",
    platform: "trendyol",
    cargoProvider: "TEX",
    minPrice: 0,
    maxPrice: 199.99,
    minDesi: 0,
    maxDesi: 999,
    cargoCost: 34.16,
    vatIncluded: false,
    priority: 30,
    isActive: false,
  },
  {
    name: "TEX • Avantajlı Barem • 200-350 TL",
    platform: "trendyol",
    cargoProvider: "TEX",
    minPrice: 200,
    maxPrice: 349.99,
    minDesi: 0,
    maxDesi: 999,
    cargoCost: 65.83,
    vatIncluded: false,
    priority: 30,
    isActive: false,
  },
  {
    name: "TEX • Standart Barem • 0-200 TL",
    platform: "trendyol",
    cargoProvider: "TEX",
    minPrice: 0,
    maxPrice: 199.99,
    minDesi: 0,
    maxDesi: 999,
    cargoCost: 64.58,
    vatIncluded: false,
    priority: 20,
    isActive: true,
  },
  {
    name: "TEX • Standart Barem • 200-350 TL",
    platform: "trendyol",
    cargoProvider: "TEX",
    minPrice: 200,
    maxPrice: 349.99,
    minDesi: 0,
    maxDesi: 999,
    cargoCost: 72.91,
    vatIncluded: false,
    priority: 20,
    isActive: true,
  },
];

const desiPriceMap = [
  { fromDesi: 0,     toDesi: 2,  cost: 77.54 },
  { fromDesi: 2.01,  toDesi: 3,  cost: 93.63 },
  { fromDesi: 3.01,  toDesi: 4,  cost: 101.46 },
  { fromDesi: 4.01,  toDesi: 5,  cost: 107.98 },
  { fromDesi: 5.01,  toDesi: 6,  cost: 118.30 },
  { fromDesi: 6.01,  toDesi: 7,  cost: 125.66 },
  { fromDesi: 7.01,  toDesi: 8,  cost: 134.21 },
  { fromDesi: 8.01,  toDesi: 9,  cost: 142.42 },
  { fromDesi: 9.01,  toDesi: 10, cost: 153.47 },
  { fromDesi: 10.01, toDesi: 11, cost: 162.13 },
  { fromDesi: 11.01, toDesi: 12, cost: 170.33 },
  { fromDesi: 12.01, toDesi: 13, cost: 178.04 },
  { fromDesi: 13.01, toDesi: 14, cost: 185.17 },
  { fromDesi: 14.01, toDesi: 15, cost: 192.81 },
  { fromDesi: 15.01, toDesi: 20, cost: 236.21 },
  { fromDesi: 20.01, toDesi: 30, cost: 328.88 },
];

const desiRules = desiPriceMap.map(({ fromDesi, toDesi, cost }) => ({
  name: `TEX • 350+ TL • ${Math.ceil(fromDesi)}-${toDesi} desi`,
  platform: "trendyol" as const,
  cargoProvider: "TEX",
  minPrice: 350,
  maxPrice: 999999,
  minDesi: fromDesi,
  maxDesi: toDesi,
  cargoCost: cost,
  vatIncluded: false,
  priority: 10,
  isActive: true,
}));

const allRules = [...baremRules, ...desiRules];

/**
 * TEX kargo kurallarını sıfırlayıp Trendyol baremine göre yeniden yükler.
 * - force=true → her zaman çalışır
 * - force yoksa: AppSetting flag'iyle bir kez çalışır (idempotent)
 */
export async function POST(req: Request) {
  await ensureRuntimeSchema();
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";

  if (!force) {
    const flag = await prisma.appSetting.findUnique({ where: { key: SEED_KEY } });
    if (flag?.value === "done") {
      return NextResponse.json({ skipped: true, reason: "already-seeded" });
    }
  }

  // Mevcut TEX kurallarını sil
  const deleted = await prisma.cargoRule.deleteMany({
    where: {
      OR: [{ cargoProvider: "TEX" }, { name: { contains: "TEX" } }],
    },
  });

  // Yenilerini ekle
  for (const rule of allRules) {
    await prisma.cargoRule.create({ data: rule });
  }

  // Flag'i set et
  await prisma.appSetting.upsert({
    where: { key: SEED_KEY },
    update: { value: "done" },
    create: { key: SEED_KEY, value: "done" },
  });
  invalidateOrdersCache();

  return NextResponse.json({
    seeded: true,
    deleted: deleted.count,
    added: allRules.length,
  });
}
