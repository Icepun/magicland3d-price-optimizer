/**
 * ÜRÜN BAZLI SATIŞ ÖZETİ — davranış + GERÇEK libSQL üzerinde SQL doğrulaması.
 *
 * Korunan hatalar:
 *  1) "En çok satanlar" pazaryeri BAŞLIĞINA göre gruplanıyordu: aynı ürün üç başlıkla satıldığında
 *     listede üçe bölünüyor, farklı ürünler benzer başlıkla tek satırda toplanıyordu.
 *  2) Ürünle eşleşmeyen kalemler sessizce düşüyordu.
 *  3) Kârı bilinmeyen sipariş "0 kâr" sayılırsa ürün kârlı görünür — BİLİNMEYEN ≠ SIFIR.
 *  4) Dize içindeki ham SQL `tsc`/`eslint`/`next build` üçünden de kaçar; bu yüzden gerçek
 *     libSQL üzerinde koşturuluyor.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateProductSales,
  parseProductSalesItems,
  productSalesItemsSql,
  type ProductSalesItem,
  type ProductSalesOrder,
} from "./finance-product-sales";
import { toDbDate } from "./sqlite-date";

const RANGE_FROM = new Date("2026-01-01T00:00:00.000Z");
const NOW = new Date("2026-03-01T00:00:00.000Z");
/** Son 30 günün İÇİNDE. */
const YENI = new Date("2026-02-20T10:00:00.000Z");
/** Pencerede ama son 30 günün DIŞINDA. */
const ESKI = new Date("2026-01-10T10:00:00.000Z");

function kalem(over: Partial<ProductSalesItem> = {}): ProductSalesItem {
  return {
    platform: "trendyol",
    externalOrderId: "o1",
    orderedAt: YENI,
    productId: "p1",
    productName: "Ürün 1",
    quantity: 1,
    lineRevenueKurus: 10_000,
    statusKind: "delivered",
    ...over,
  };
}

function siparis(over: Partial<ProductSalesOrder> = {}): ProductSalesOrder {
  return {
    platform: "trendyol",
    externalOrderId: "o1",
    orderedAt: YENI,
    revenueKurus: 10_000,
    profitKurus: 4_000,
    profitPartial: false,
    statusKind: "delivered",
    currency: "TRY",
    ...over,
  };
}

describe("ürün bazlı satış özeti", () => {
  it("aynı ürün farklı başlıklarla satıldıysa TEK satırda toplanır", () => {
    const sonuc = aggregateProductSales({
      items: [
        kalem({ externalOrderId: "o1", productName: "Xbox Kol Standı — Trendyol başlığı" }),
        kalem({
          externalOrderId: "o2",
          productName: "XBOX KOL STANDI Siyah | Hepsiburada",
          quantity: 2,
          lineRevenueKurus: 20_000,
        }),
      ],
      orders: [siparis({ externalOrderId: "o1" }), siparis({ externalOrderId: "o2" })],
      productInfo: [{ id: "p1", name: "Xbox Kol Standı — Siyah", imageUrl: "a.png" }],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });

    expect(sonuc.topSellers).toHaveLength(1);
    expect(sonuc.topSellers[0]).toMatchObject({
      productId: "p1",
      name: "Xbox Kol Standı — Siyah",
      quantity: 3,
      revenue: 300,
      orderCount: 2,
    });
  });

  it("farklı ürünler benzer başlık taşısa bile AYRI satır olur", () => {
    const sonuc = aggregateProductSales({
      items: [
        kalem({ externalOrderId: "o1", productId: "p1", productName: "Joystick Standı" }),
        kalem({ externalOrderId: "o2", productId: "p2", productName: "Joystick Standı" }),
      ],
      orders: [siparis({ externalOrderId: "o1" }), siparis({ externalOrderId: "o2" })],
      productInfo: [
        { id: "p1", name: "Xbox Joystick Standı", imageUrl: null },
        { id: "p2", name: "PS5 Joystick Standı", imageUrl: null },
      ],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });

    expect(sonuc.topSellers.map((row) => row.productId).sort()).toEqual(["p1", "p2"]);
  });

  it("sipariş kârı kalemlere CİRO PAYINA göre dağıtılır, toplamı siparişin kârını aşmaz", () => {
    const sonuc = aggregateProductSales({
      items: [
        kalem({ productId: "p1", lineRevenueKurus: 30_000 }),
        kalem({ productId: "p2", lineRevenueKurus: 10_000 }),
      ],
      orders: [siparis({ profitKurus: 8_000 })],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });

    const kar = Object.fromEntries(
      sonuc.profitLeaders.map((row) => [row.productId, row.profit])
    );
    expect(kar.p1).toBe(60); // 30.000/40.000 × 8.000 kuruş
    expect(kar.p2).toBe(20);
    expect((kar.p1 ?? 0) + (kar.p2 ?? 0)).toBeCloseTo(80, 2);
  });

  it("eşleşmeyen satır paya girmez — dağıtılan kâr siparişin kârını AŞMAZ", () => {
    const sonuc = aggregateProductSales({
      items: [
        kalem({ productId: "p1", lineRevenueKurus: 10_000 }),
        kalem({ productId: null, productName: "Bilinmeyen ilan", lineRevenueKurus: 10_000 }),
      ],
      orders: [siparis({ profitKurus: 6_000 })],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });

    expect(sonuc.profitLeaders[0].profit).toBe(30); // yarısı; diğer yarı kimseye yazılmaz
    expect(sonuc.unmatched.lines).toBe(1);
    expect(sonuc.unmatched.quantity).toBe(1);
    expect(sonuc.unmatched.revenue).toBe(100);
    expect(sonuc.unmatched.titles[0].name).toBe("Bilinmeyen ilan");
  });

  it("kârı bilinmeyen sipariş SIFIR sayılmaz — ürünün kârı null döner", () => {
    const sonuc = aggregateProductSales({
      items: [kalem({ productId: "p1" })],
      orders: [siparis({ profitKurus: null })],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });

    expect(sonuc.topSellers[0].profit).toBeNull();
    expect(sonuc.topSellers[0].profitUnknownLines).toBe(1);
    // Kârı hiç bilinmeyen ürün "en çok para getirenler" listesinde 0 ile sıralanmaz.
    expect(sonuc.profitLeaders).toHaveLength(0);
  });

  it("kârı kısmi sipariş ürünü işaretler", () => {
    const sonuc = aggregateProductSales({
      items: [kalem({ productId: "p1" })],
      orders: [siparis({ profitPartial: true })],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });
    expect(sonuc.topSellers[0].profitPartial).toBe(true);
  });

  it("iptal ve TL dışı siparişler aylık toplamlarla AYNI şekilde elenir", () => {
    const sonuc = aggregateProductSales({
      items: [
        kalem({ externalOrderId: "iptal", productId: "p1" }),
        kalem({ externalOrderId: "dolar", productId: "p2" }),
        kalem({ externalOrderId: "iptal-satir", productId: "p3", statusKind: "cancelled" }),
        kalem({ externalOrderId: "saglam", productId: "p4" }),
      ],
      orders: [
        siparis({ externalOrderId: "iptal", statusKind: "cancelled" }),
        siparis({ externalOrderId: "dolar", currency: "USD" }),
        siparis({ externalOrderId: "iptal-satir" }),
        siparis({ externalOrderId: "saglam" }),
      ],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });

    expect(sonuc.topSellers.map((row) => row.productId)).toEqual(["p4"]);
  });

  it("siparişi kayıtlı olmayan kalem toplamlara girmez ama AYRI KOVADA bildirilir", () => {
    // 🔴 DENETİMDE BULUNDU: bu satırlar hiçbir sayaca girmeden düşüyordu. `unmatched` yalnız
    // ürünü eşleşmemiş satırları, `coverage` yalnız sipariş tarafını sayıyor — üçüncü bir
    // sessiz kayıp kanalı yanıtta hiç görünmüyordu. Toplamlara KATILMAMASI doğru (kârın
    // kaynağı sipariş özeti), GÖRÜNMEMESİ değil.
    const sonuc = aggregateProductSales({
      items: [kalem({ externalOrderId: "yok", quantity: 3, lineRevenueKurus: 30_000 })],
      orders: [],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });
    expect(sonuc.topSellers).toHaveLength(0);
    expect(sonuc.soldUnits).toEqual({});
    expect(sonuc.unmatched.lines).toBe(0); // ürünü VAR; eksik olan sipariş özeti
    expect(sonuc.orphanItems).toEqual({ lines: 1, quantity: 3, revenue: 300 });
  });

  it("iptal edilen KALEM satırı kâr paydasına girmez (kârın bir kısmı kaybolmasın)", () => {
    // 🔴 DENETİMDE BULUNDU: iptal satır toplamadan eleniyordu ama paylaştırmanın paydası
    // onun cirosunu içermeye devam ediyordu → siparişin kârının bir kısmı HİÇBİR ürüne
    // yazılmıyor, sağlam ürün "En çok para getirenler"de olduğundan düşük görünüyordu.
    const sonuc = aggregateProductSales({
      items: [
        kalem({ externalOrderId: "o9", productId: "p1", lineRevenueKurus: 30_000 }),
        kalem({
          externalOrderId: "o9",
          productId: "p2",
          lineRevenueKurus: 10_000,
          statusKind: "cancelled",
        }),
      ],
      orders: [
        siparis({ externalOrderId: "o9", revenueKurus: 30_000, profitKurus: 10_000 }),
      ],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });

    const p1 = sonuc.topSellers.find((row) => row.productId === "p1");
    // Kârın TAMAMI sağlam ürüne yazılır (₺100), %75'i (₺75) değil.
    expect(p1?.profit).toBe(100);
    expect(sonuc.topSellers.map((row) => row.productId)).toEqual(["p1"]);
  });

  it("'en çok satanlar' son 30 gün, 'satılan adet' TÜM pencere üzerinden", () => {
    const sonuc = aggregateProductSales({
      items: [
        kalem({ externalOrderId: "o1", orderedAt: ESKI, quantity: 5 }),
        kalem({ externalOrderId: "o2", orderedAt: YENI, quantity: 2 }),
      ],
      orders: [siparis({ externalOrderId: "o1" }), siparis({ externalOrderId: "o2" })],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });

    expect(sonuc.topSellers[0].quantity).toBe(2); // yalnız son 30 gün
    expect(sonuc.soldUnits.p1).toBe(7); // tüm pencere
    expect(sonuc.recentDays).toBe(30);
  });

  it("pencere başlangıcından önceki satırlar okunmaz", () => {
    const sonuc = aggregateProductSales({
      items: [kalem({ orderedAt: new Date("2025-12-01T00:00:00.000Z") })],
      orders: [siparis()],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });
    expect(sonuc.soldUnits).toEqual({});
  });

  it("kalem geçmişi olmayan eski siparişler kapsam dışı olarak SAYILIR", () => {
    const sonuc = aggregateProductSales({
      items: [kalem({ externalOrderId: "yeni" })],
      orders: [
        siparis({ externalOrderId: "yeni" }),
        // Kalem geçmişi eklenmeden önceki sipariş — ürün listelerinde HİÇ görünemez.
        siparis({ externalOrderId: "eski-dokumsuz", orderedAt: ESKI, revenueKurus: 55_000 }),
      ],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });

    expect(sonuc.coverage).toEqual({
      ordersWithItems: 1,
      ordersWithoutItems: 1,
      revenueWithoutItems: 550,
    });
    // Son 30 günde dökümsüz sipariş yok → uyarı orada çıkmamalı.
    expect(sonuc.recentCoverage).toEqual({
      ordersWithItems: 1,
      ordersWithoutItems: 0,
      revenueWithoutItems: 0,
    });
  });

  it("iptal sipariş kapsam sayımına da girmez", () => {
    const sonuc = aggregateProductSales({
      items: [],
      orders: [siparis({ externalOrderId: "iptal", statusKind: "cancelled" })],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });
    expect(sonuc.coverage.ordersWithoutItems).toBe(0);
  });

  it("ürün silinmişse kalemdeki ad kullanılır (satır kaybolmaz)", () => {
    const sonuc = aggregateProductSales({
      items: [kalem({ productId: "silinmis", productName: "Eski Ürün" })],
      orders: [siparis()],
      productInfo: [],
      rangeFrom: RANGE_FROM,
      now: NOW,
    });
    expect(sonuc.topSellers[0].name).toBe("Eski Ürün");
  });
});

describe("kalem geçmişi SQL'i GERÇEK libSQL üzerinde", () => {
  it("karışık tarih tipli tabloda hiçbir satırı düşürmez", async () => {
    const { PrismaLibSQL } = await import("@prisma/adapter-libsql");
    const { PrismaClient } = await import("@/generated/prisma/client");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "urun-satis-"));
    const db = new PrismaClient({
      adapter: new PrismaLibSQL({ url: `file:${path.join(dir, "t.db")}` }),
    });
    try {
      await db.$executeRawUnsafe(
        `CREATE TABLE "OrderItemSnapshot" (
          "id" TEXT NOT NULL PRIMARY KEY, "platform" TEXT NOT NULL,
          "externalOrderId" TEXT NOT NULL, "lineIndex" INTEGER NOT NULL,
          "orderedAt" DATETIME NOT NULL, "productId" TEXT, "productName" TEXT NOT NULL,
          "quantity" INTEGER NOT NULL, "unitPriceKurus" INTEGER NOT NULL,
          "lineRevenueKurus" INTEGER NOT NULL, "statusKind" TEXT NOT NULL,
          "currency" TEXT NOT NULL DEFAULT 'TRY', "syncedAt" DATETIME NOT NULL)`
      );

      const ekle = (id: string, orderedAt: string | number, productId: string | null) =>
        db.$executeRawUnsafe(
          `INSERT INTO "OrderItemSnapshot"
             ("id","platform","externalOrderId","lineIndex","orderedAt","productId","productName",
              "quantity","unitPriceKurus","lineRevenueKurus","statusKind","currency","syncedAt")
           VALUES (?,'trendyol',?,0,?,?,'Ad',2,5000,10000,'delivered','TRY',?)`,
          id,
          id,
          orderedAt,
          productId,
          toDbDate(YENI)
        );

      // Aynı tabloda İKİ farklı depolama biçimi — sahada tam olarak bu vardı.
      await ekle("iso", YENI.toISOString().replace(/Z$/, "+00:00"), "p1");
      await ekle("epoch", YENI.getTime(), "p2");
      await ekle("eski", ESKI.getTime(), "p3");

      const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        productSalesItemsSql(),
        RANGE_FROM.getTime()
      );
      const items = parseProductSalesItems(rows);

      // Üç satırın ÜÇÜ de okunmalı: normalize karşılaştırma tipi karışık olsa da eleme yapmaz.
      expect(items.map((item) => item.productId).sort()).toEqual(["p1", "p2", "p3"]);
      for (const item of items) {
        expect(item.orderedAt.getTime()).toBeGreaterThan(RANGE_FROM.getTime());
        expect(item.quantity).toBe(2);
        expect(item.lineRevenueKurus).toBe(10_000);
      }

      // Pencere gerçekten daraltıyor mu?
      const dar = parseProductSalesItems(
        await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
          productSalesItemsSql(),
          new Date("2026-02-01T00:00:00.000Z").getTime()
        )
      );
      expect(dar.map((item) => item.productId).sort()).toEqual(["p1", "p2"]);
    } finally {
      await db.$disconnect();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* geçici klasör işletim sistemine kalsın */
      }
    }
  }, 60_000);
});
