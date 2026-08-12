import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-dashboard-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let dashboard: typeof import("./route").GET;
let priceChanges: typeof import("./price-changes/route").GET;
let bustCache: typeof import("@/lib/route-cache").bustCache;
let db: typeof import("@/lib/prisma").prisma;

interface PlatformStats {
  platform: string;
  activeListings: number;
  missingCostListings: number;
  totalProfit: number;
  averageMargin: number | null;
  negativeProfitCount: number;
}

interface DashboardBody {
  computedAt: string;
  totalProducts: number;
  lowStockCount: number;
  lowStockProducts: Array<{ id: string; name: string; stock: number; imageUrl: string | null }>;
  lowStockShown: number;
  lowStockMore: number;
  lowStockMoreOutOfStock: number;
  lowStockMoreLow: number;
  missingCost: number;
  platforms: PlatformStats[];
  problemProducts: Array<{ id: string; problem: string; profit: number | null }>;
  problemTotal: number;
  problemMore: number;
  problemMoreNegative: number;
  problemMoreMissingCost: number;
  problemNegativeCount: number;
  problemMissingCostCount: number;
}

interface PriceChangeItem {
  productId: string;
  productName: string;
  firstPrice: number;
  lastPrice: number;
  changePercent: number | null;
  changeCount: number;
  source: string;
}

interface PriceChangesBody {
  computedAt: string;
  days: number;
  since: string;
  totalChanges: number;
  productsAffected: number;
  recent: PriceChangeItem[];
}

/** Rotayı OLDUĞU GİBİ çağırır — önbellek düşürülmez (önbellek davranışı sınanabilsin). */
async function callDashboard(query = ""): Promise<DashboardBody> {
  const request = new Request(
    `http://localhost/api/dashboard${query ? `?${query}` : ""}`
  ) as NextRequest;
  const response = await dashboard(request);
  expect(response.status).toBe(200);
  return (await response.json()) as DashboardBody;
}

async function readDashboard(): Promise<DashboardBody> {
  bustCache("dashboard:");
  return callDashboard();
}

async function callPriceChanges(query = "days=30&limit=10"): Promise<PriceChangesBody> {
  const request = new Request(
    `http://localhost/api/dashboard/price-changes?${query}`
  ) as NextRequest;
  const response = await priceChanges(request);
  expect(response.status).toBe(200);
  return (await response.json()) as PriceChangesBody;
}

async function readPriceChanges(query = "days=30&limit=10"): Promise<PriceChangesBody> {
  bustCache("dashboard:");
  return callPriceChanges(query);
}

function platformOf(body: DashboardBody, platform: string): PlatformStats {
  const found = body.platforms.find((p) => p.platform === platform);
  if (!found) throw new Error(`platform yok: ${platform}`);
  return found;
}

/** Bugünün 00:00'ından N gün geri — rota ile aynı pencere yaslaması. */
function daysAgoAtMidnight(days: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}

beforeAll(async () => {
  ({ GET: dashboard } = await import("./route"));
  ({ GET: priceChanges } = await import("./price-changes/route"));
  ({ bustCache } = await import("@/lib/route-cache"));
  ({ prisma: db } = await import("@/lib/prisma"));
  await (await import("@/lib/runtime-schema")).ensureRuntimeSchema();
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Ürün silinince maliyet/ilan/fiyat geçmişi cascade ile gider.
  await db.product.deleteMany();
  await db.commissionRule.deleteMany();
  await db.cargoRule.deleteMany();
  await db.expenseRule.deleteMany();
  await db.appSetting.deleteMany();
  await db.appSetting.create({ data: { key: "vatRate", value: "20" } });
});

/** Maliyeti bilinen (manuel tutar) ürün + tek ilan. */
async function seedProduct(opts: {
  id: string;
  name?: string;
  stock?: number;
  salePrice: number;
  manualCost?: number | null;
  platform?: string;
  listingPrice?: number;
  hidden?: boolean;
  isActive?: boolean;
  imageUrl?: string | null;
  withListing?: boolean;
}) {
  const {
    id,
    name = id,
    stock = 10,
    salePrice,
    manualCost = 100,
    platform = "hepsiburada",
    listingPrice = salePrice,
    hidden = false,
    isActive = true,
    imageUrl = null,
    withListing = true,
  } = opts;

  await db.product.create({
    data: {
      id,
      barcode: `bc-${id}`,
      sku: `sku-${id}`,
      name,
      categoryName: "Dekor",
      currentSalePrice: salePrice,
      stock,
      hidden,
      isActive,
      imageUrl,
      ...(manualCost === null
        ? {}
        : { cost: { create: { costMode: "manual", manualCost, totalCost: manualCost } } }),
      ...(withListing
        ? {
            listings: {
              create: {
                id: `l-${id}`,
                platform,
                salePrice: listingPrice,
                cargoCost: 0, // kargo kuralı devre dışı — test kâr matematiği sade kalsın
              },
            },
          }
        : {}),
    },
  });
}

describe("GET /api/dashboard", () => {
  it("düşük stok listesini ÖNCE sıralar SONRA keser — stoğu bitenler dışarı itilmez", async () => {
    // Stoğu 1 olanlar önce eklenir: eski kod ilk N satırı alıp sonra sıraladığı için
    // bunlar stoğu 0 olanları listeden atıyordu.
    for (let i = 0; i < 5; i++) {
      await seedProduct({ id: `az-${i}`, stock: 1, salePrice: 200, withListing: false });
    }
    for (let i = 0; i < 62; i++) {
      await seedProduct({
        id: `bitti-${String(i).padStart(2, "0")}`,
        stock: 0,
        salePrice: 200,
        withListing: false,
        imageUrl: `https://cdn.test/${i}.png`,
      });
    }

    const body = await readDashboard();

    expect(body.lowStockCount).toBe(67);
    expect(body.lowStockProducts).toHaveLength(60);
    expect(body.lowStockProducts.every((p) => p.stock === 0)).toBe(true);
    expect(body.lowStockShown).toBe(60);
    expect(body.lowStockMore).toBe(7);
    // Karta sığmayanların TÜR DAĞILIMI: arayüz yalnız "stoğu biten" kısmı için bağlantı kurar;
    // "stoğu 1 kalan" kısmının Ürünler'de karşılığı yok (bağlantı boş liste açardı).
    expect(body.lowStockMoreOutOfStock).toBe(2);
    expect(body.lowStockMoreLow).toBe(5);
    // Satırda ürün görseli gösterilebilsin diye imageUrl yanıtta olmalı.
    expect(body.lowStockProducts[0].imageUrl).toMatch(/^https:\/\/cdn\.test\//);
  });

  it("acil müdahale listesini zarara göre sıralar; maliyeti eksikler sona düşer", async () => {
    // Maliyeti eksik 32 ürün ÖNCE eklenir — eski kod ilk 30'u alıp zarar edenleri hiç göstermiyordu.
    for (let i = 0; i < 32; i++) {
      await seedProduct({
        id: `eksik-${String(i).padStart(2, "0")}`,
        salePrice: 300,
        manualCost: null,
      });
    }
    await seedProduct({ id: "kucuk-zarar", salePrice: 90, manualCost: 100 });
    await seedProduct({ id: "orta-zarar", salePrice: 50, manualCost: 100 });
    await seedProduct({ id: "buyuk-zarar", salePrice: 10, manualCost: 100 });

    const body = await readDashboard();

    const losses = body.problemProducts.filter((p) => p.problem === "negative_profit");
    expect(losses.map((p) => p.id)).toEqual(["buyuk-zarar", "orta-zarar", "kucuk-zarar"]);
    // Zarar edenler listenin BAŞINDA — kesme sıralamadan sonra yapılıyor.
    expect(body.problemProducts.slice(0, 3).map((p) => p.id)).toEqual([
      "buyuk-zarar",
      "orta-zarar",
      "kucuk-zarar",
    ]);
    expect(body.problemTotal).toBe(35);
    expect(body.problemMore).toBe(5);
    // Taşan 5 satırın TAMAMI maliyeti eksik — "+5" bağlantısı zarar edenler listesine
    // gitseydi kullanıcı 5 bekleyip 3 kayıt görürdü.
    expect(body.problemMoreNegative).toBe(0);
    expect(body.problemMoreMissingCost).toBe(5);
    expect(body.problemNegativeCount).toBe(3);
    expect(body.problemMissingCostCount).toBe(32);
    // Maliyeti eksik olanlar ayırt edilebilir kalmalı (arayüz filtreleyebilsin).
    expect(body.problemProducts.some((p) => p.problem === "missing_cost")).toBe(true);
  });

  it("ilan sayısı maliyetten bağımsız sayılır; eksik olanlar ayrıca raporlanır", async () => {
    await seedProduct({ id: "maliyetli", salePrice: 400, manualCost: 100 });
    await seedProduct({ id: "maliyetsiz-1", salePrice: 400, manualCost: null });
    await seedProduct({ id: "maliyetsiz-2", salePrice: 400, manualCost: null });

    const body = await readDashboard();
    const hb = platformOf(body, "hepsiburada");

    expect(hb.activeListings).toBe(3); // eskiden 1 idi: maliyeti eksik ürünün ilanı hiç sayılmıyordu
    expect(hb.missingCostListings).toBe(2);
    expect(body.missingCost).toBe(2);
    // Kâr yalnız maliyeti bilinen ilandan gelir.
    expect(hb.totalProfit).toBeCloseTo(400 / 1.2 - 100, 6);
  });

  it("ortalama marj CİROYA GÖRE ağırlıklı — düz ortalamadan farklı çıkar", async () => {
    // Büyük ciro / iyi marj + küçük ciro / felaket marj.
    await seedProduct({ id: "buyuk", salePrice: 1000, manualCost: 100 });
    await seedProduct({ id: "kucuk", salePrice: 10, manualCost: 100 });

    const body = await readDashboard();
    const hb = platformOf(body, "hepsiburada");

    const revenueBig = 1000 / 1.2;
    const revenueSmall = 10 / 1.2;
    const profitBig = revenueBig - 100;
    const profitSmall = revenueSmall - 100;

    const weighted = (profitBig + profitSmall) / (revenueBig + revenueSmall);
    const flat = (profitBig / revenueBig + profitSmall / revenueSmall) / 2;

    // Düz ortalama küçük ilanın uç marjı yüzünden ekside; ağırlıklı marj gerçeği söylüyor.
    expect(flat).toBeLessThan(0);
    expect(weighted).toBeGreaterThan(0);
    expect(hb.averageMargin).toBeCloseTo(weighted, 9);
    expect(hb.averageMargin).not.toBeCloseTo(flat, 2);
    expect(hb.totalProfit).toBeCloseTo(profitBig + profitSmall, 6);
  });

  it("hiç ilanı olmayan platformun marjı null döner (sıfır değil)", async () => {
    await seedProduct({ id: "tek", salePrice: 400, platform: "hepsiburada" });

    const body = await readDashboard();

    expect(platformOf(body, "shopify").averageMargin).toBeNull();
    expect(platformOf(body, "trendyol").averageMargin).toBeNull();
    expect(platformOf(body, "shopify").activeListings).toBe(0);
  });

  it("gövde HESAPLAMA anını taşır — önbellekten dönen yanıt kendi damgasını korur", async () => {
    await seedProduct({ id: "damga", salePrice: 400, withListing: false });
    bustCache("dashboard:");

    const first = await callDashboard();
    expect(Number.isFinite(new Date(first.computedAt).getTime())).toBe(true);

    // Önbellekten dönen ikinci yanıt YENİ bir damga üretmemeli: yoksa ekran bir haftalık
    // veriyi "az önce güncellendi" diye gösterir.
    const cached = await callDashboard();
    expect(cached.computedAt).toBe(first.computedAt);
  });

  it("?fresh=1 sunucu önbelleğini atlar", async () => {
    await seedProduct({ id: "ilk", salePrice: 400, withListing: false });
    bustCache("dashboard:");

    expect((await callDashboard()).totalProducts).toBe(1);

    await seedProduct({ id: "ikinci", salePrice: 400, withListing: false });
    // Önbellek ömrü dolmadı → eski gövde. "Yenile" bu yüzden hiçbir rakamı değiştirmiyordu.
    expect((await callDashboard()).totalProducts).toBe(1);

    const fresh = await callDashboard("fresh=1");
    expect(fresh.totalProducts).toBe(2);
    // Taze hesap önbelleği de yeniler.
    expect((await callDashboard()).totalProducts).toBe(2);
  });
});

describe("GET /api/dashboard/price-changes", () => {
  async function seedHistory(
    productId: string,
    rows: Array<{ id: string; oldPrice: number; newPrice: number; source: string; at: Date }>
  ) {
    for (const row of rows) {
      await db.priceHistory.create({
        data: {
          id: row.id,
          productId,
          oldPrice: row.oldPrice,
          newPrice: row.newPrice,
          changeSource: row.source,
          changedAt: row.at,
        },
      });
    }
  }

  it("platformları karıştırmaz: güncel fiyatı süren kaynağın çizgisini referans alır", async () => {
    // Ürünün güncel satış fiyatı 260 — bunu Shopify çizgisi sürüyor (200 → 260).
    // Trendyol çizgisi ayrı bir fiyat hattı (90 → 95); eskiden ikisi arka arkaya dizilip
    // "90 → 260" (%+189) gibi uydurma bir zam üretiliyordu.
    await seedProduct({ id: "karisik", salePrice: 260, withListing: false });
    await seedHistory("karisik", [
      { id: "h1", oldPrice: 90, newPrice: 95, source: "trendyol_sync", at: daysAgoAtMidnight(20) },
      { id: "h2", oldPrice: 200, newPrice: 240, source: "shopify_sync", at: daysAgoAtMidnight(10) },
      { id: "h3", oldPrice: 240, newPrice: 260, source: "shopify_sync", at: daysAgoAtMidnight(2) },
    ]);

    const body = await readPriceChanges();
    const item = body.recent.find((i) => i.productId === "karisik");

    expect(item).toBeDefined();
    expect(item?.source).toBe("shopify_sync");
    expect(item?.firstPrice).toBe(200);
    // Son fiyat SEÇİLEN ÇİZGİNİN kendi son fiyatı (h3'ün newPrice'ı). Ürünün
    // `currentSalePrice` alanına dayanılamaz: onu yalnız Shopify senkronu ve elle düzenleme
    // günceller, Trendyol/Hepsiburada senkronları sadece ilan fiyatını yazar.
    expect(item?.lastPrice).toBe(260);
    expect(item?.changePercent).toBeCloseTo(30, 6);
    // Gösterilen aralık TEK çizgiye ait (Shopify: h2 + h3) → sayı da o çizginin. Ürünün tüm
    // kaynaklardaki toplamı (3) yazılsaydı "3×" derken iki hareketlik aralık gösterilirdi.
    expect(item?.changeCount).toBe(2);
    expect(body.totalChanges).toBe(3);
  });

  it("aynı anda yazılmış kayıtlarda taban fiyat rastgele seçilmez", async () => {
    const sameMoment = daysAgoAtMidnight(5);
    await seedProduct({ id: "toplu", salePrice: 150, withListing: false });
    await seedHistory("toplu", [
      { id: "b-ikinci", oldPrice: 120, newPrice: 150, source: "shopify_sync", at: sameMoment },
      { id: "a-ilk", oldPrice: 100, newPrice: 150, source: "shopify_sync", at: sameMoment },
    ]);

    const first = await readPriceChanges();
    const second = await readPriceChanges();

    // Zaman eşitse id ile ikinci sıra ölçütü uygulanır → her istekte AYNI taban.
    expect(first.recent[0].firstPrice).toBe(100);
    expect(second.recent[0].firstPrice).toBe(100);
  });

  it("hesaplanamayan yüzde null döner (sıfır değil)", async () => {
    await seedProduct({ id: "tabansiz", salePrice: 180, withListing: false });
    await seedHistory("tabansiz", [
      { id: "h-nul", oldPrice: 0, newPrice: 180, source: "manual", at: daysAgoAtMidnight(3) },
    ]);

    const body = await readPriceChanges();

    expect(body.recent[0].changePercent).toBeNull();
    expect(body.recent[0].lastPrice).toBe(180);
  });

  it("pasif ve gizli ürünler listeye girmez", async () => {
    await seedProduct({ id: "pasif", salePrice: 100, isActive: false, withListing: false });
    await seedProduct({ id: "gizli", salePrice: 100, hidden: true, withListing: false });
    await seedProduct({ id: "acik", salePrice: 130, withListing: false });
    for (const id of ["pasif", "gizli", "acik"]) {
      await seedHistory(id, [
        { id: `h-${id}`, oldPrice: 100, newPrice: 130, source: "manual", at: daysAgoAtMidnight(4) },
      ]);
    }

    const body = await readPriceChanges();

    expect(body.recent.map((i) => i.productId)).toEqual(["acik"]);
    expect(body.productsAffected).toBe(1);
    expect(body.totalChanges).toBe(1);
  });

  it("pencere gün başına yaslı — günün saatine göre kaymaz", async () => {
    await seedProduct({ id: "sinirda", salePrice: 210, withListing: false });
    await seedProduct({ id: "disarida", salePrice: 210, withListing: false });
    // 30 günlük pencere = bugün + önceki 29 gün → 29 gün önceki 00:00 İÇERİDE, 30 gün önce DIŞARIDA.
    await seedHistory("sinirda", [
      { id: "h-in", oldPrice: 200, newPrice: 210, source: "manual", at: daysAgoAtMidnight(29) },
    ]);
    await seedHistory("disarida", [
      { id: "h-out", oldPrice: 200, newPrice: 210, source: "manual", at: daysAgoAtMidnight(30) },
    ]);

    const body = await readPriceChanges();

    expect(body.recent.map((i) => i.productId)).toEqual(["sinirda"]);
    expect(new Date(body.since).getTime()).toBe(daysAgoAtMidnight(29).getTime());
  });

  it("gövde hesaplama anını taşır ve ?fresh=1 önbelleği atlar", async () => {
    await seedProduct({ id: "fk-1", salePrice: 130, withListing: false });
    await seedHistory("fk-1", [
      { id: "h-fk-1", oldPrice: 100, newPrice: 130, source: "manual", at: daysAgoAtMidnight(4) },
    ]);
    bustCache("dashboard:");

    const first = await callPriceChanges();
    expect(Number.isFinite(new Date(first.computedAt).getTime())).toBe(true);
    expect(first.productsAffected).toBe(1);

    await seedProduct({ id: "fk-2", salePrice: 130, withListing: false });
    await seedHistory("fk-2", [
      { id: "h-fk-2", oldPrice: 100, newPrice: 130, source: "manual", at: daysAgoAtMidnight(3) },
    ]);

    const cached = await callPriceChanges();
    expect(cached.productsAffected).toBe(1);
    expect(cached.computedAt).toBe(first.computedAt);

    const fresh = await callPriceChanges("days=30&limit=10&fresh=1");
    expect(fresh.productsAffected).toBe(2);
  });

  it("geçersiz parametreleri 400 ile reddeder", async () => {
    const request = new Request(
      "http://localhost/api/dashboard/price-changes?days=0"
    ) as NextRequest;
    const response = await priceChanges(request);
    expect(response.status).toBe(400);
  });
});
