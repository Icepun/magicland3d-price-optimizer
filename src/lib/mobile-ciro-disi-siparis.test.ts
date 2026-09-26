import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * CİRO DIŞI SİPARİŞLER — telefon da masaüstü gibi davranmalı (27 Eyl 2026).
 *
 * 1) TUTARI ALINAMAYAN SİPARİŞ ₺0 SATIŞ DEĞİLDİR. Hepsiburada sipariş detayı telefonda alınamayınca
 *    (zaman aşımı, limit, çekim sınırı) sipariş kalemsiz ve ₺0 tutarla geliyordu. Telefonun finans
 *    senkronu onu da yazıyordu; yazma `revenueKurus`'u KOŞULSUZ güncellediği için masaüstünün doğru
 *    yazdığı tutar ₺0'a iniyordu. Panel ve Raporlar özeti de bu siparişi ₺0 satış sayıyordu.
 *
 * 2) DURUMU TANINMAYAN SİPARİŞ (pazaryeri tablomuzda olmayan bir durum adı) satış da olabilir iade
 *    de. Telefon onu finans geçmişine "aktif" satış olarak yazıyor, Raporlar özeti ciroya katıyordu;
 *    Panel katmıyordu (aynı uygulamada iki ayrı küme).
 *
 * Masaüstü kuralı (api/orders route `persistableOrders` + özet): bilgisi eksik sipariş YAZILMAZ,
 * yalnız iptal/iade ise "iptal" bilgisi yazılır ki kalıcı kayıt "satıldı"da kalmasın; durumu
 * tanınmayan HİÇ yazılmaz. İkisi de ciro/kâr toplamına girmez.
 *
 * Telefonun GERÇEK `buildFinanceSnapshots` ve sipariş kararları (`isCancelledOrder`,
 * `isExcludedFromTotals` …) çalışır; yalnız ağ/veritabanı uçları ve kâr hesabı sahte. Modül
 * yolları DEĞİŞKENDE: telefonun `@/` takma adları kökte çözülmez, literal yol kök `tsc`'yi
 * düşürür (bkz. mobile-hb-siparis.test.ts).
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const yol = vi.hoisted(() => ({
  siparisler: "../../mobile/src/lib/api/orders",
  finansSenkronu: "../../mobile/src/lib/finance-sync",
}));

// Telefonun sipariş modülünün ağ kaynakları — bu testte çağrılmıyor.
vi.mock("@/lib/api/shopify", () => ({ getShopifyOrders: async () => [] }));
vi.mock("@/lib/api/trendyol", () => ({ getTrendyolOrders: async () => [] }));
vi.mock("@/lib/api/hepsiburada", () => ({ getHepsiburadaOrders: async () => [] }));
vi.mock("@/lib/api/window", () => ({ orderWindowCutoff: () => 0 }));
vi.mock("@/lib/db/manual-orders", () => ({ getManualOrdersSince: async () => [] }));
// `@/lib/api/orders` kökte YOK → gerçek telefon modülüne yönlendir (kararlar gerçek kalsın).
vi.mock("@/lib/api/orders", () => import(/* @vite-ignore */ yol.siparisler));
vi.mock("@/lib/db/finance", () => ({ syncOrderFinanceSnapshots: vi.fn(async () => {}) }));
// Kâr hesabı bu testin konusu değil: ciro = sipariş tutarı.
vi.mock("@/lib/order-profit", () => ({
  getProductMap: () => new Map(),
  computeOrderProfit: (o: { total: number }) => ({
    revenue: o.total,
    profit: o.total * 0.3,
    partial: false,
    profitSource: "calculated",
    estimatedCommission: 0,
    actualCommission: null,
  }),
}));

type Platform = "hepsiburada" | "trendyol" | "shopify";

interface Siparis {
  id: string;
  platform: Platform;
  orderNumber: string;
  date: number;
  status: string;
  customer: null;
  total: number;
  items: { name: string; quantity: number; unitPrice: number; matchKeys: string[] }[];
  dataIncomplete?: boolean;
}

interface FinansSatiri {
  externalOrderId: string;
  revenue: number;
  statusKind: string;
}

const ONEK: Record<Platform, string> = { hepsiburada: "hb", trendyol: "ty", shopify: "sh" };

/** `tutar` null = kalem/tutar alınamadı. */
const siparis = (platform: Platform, no: string, status: string, tutar: number | null): Siparis => ({
  id: `${ONEK[platform]}-${no}`,
  platform,
  orderNumber: no,
  date: Date.UTC(2026, 8, 20),
  status,
  customer: null,
  total: tutar ?? 0,
  items: tutar == null ? [] : [{ name: "Ürün", quantity: 1, unitPrice: tutar, matchKeys: [] }],
  dataIncomplete: tutar == null,
});
const hb = (no: string, status: string, tutar: number | null) => siparis("hepsiburada", no, status, tutar);

async function finansSatirlari(siparisler: Siparis[]): Promise<FinansSatiri[]> {
  const m = (await import(/* @vite-ignore */ yol.finansSenkronu)) as {
    buildFinanceSnapshots: (o: Siparis[], p: unknown[], r: unknown, s: Record<string, string>) => FinansSatiri[];
  };
  return m.buildFinanceSnapshots(siparisler, [], {}, {});
}

type Karar = (o: Siparis) => boolean;
async function kararlar(): Promise<{ isExcludedFromTotals: Karar; isUnknownStatusOrder: Karar }> {
  return (await import(/* @vite-ignore */ yol.siparisler)) as {
    isExcludedFromTotals: Karar;
    isUnknownStatusOrder: Karar;
  };
}

describe("telefonun finans senkronu", () => {
  it("tutarı alınamayan sipariş finans geçmişine YAZILMAZ (doğru kayıt ₺0'la ezilmez)", async () => {
    const satirlar = await finansSatirlari([hb("TAM", "Delivered", 150), hb("EKSIK", "Delivered", null)]);

    expect(satirlar.map((s) => s.externalOrderId)).toEqual(["hb-TAM"]);
    expect(satirlar[0]).toMatchObject({ revenue: 150, statusKind: "active" });
  });

  it("tutarı alınamasa da İADE bilgisi yazılır — kalıcı kayıt 'satıldı'da kalmasın", async () => {
    const satirlar = await finansSatirlari([hb("IADE", "Returned", null), hb("IPTAL", "CancelledByCustomer", null)]);

    expect(satirlar).toEqual([
      expect.objectContaining({ externalOrderId: "hb-IADE", statusKind: "cancelled" }),
      expect.objectContaining({ externalOrderId: "hb-IPTAL", statusKind: "cancelled" }),
    ]);
  });

  it("durumu tanınmayan pazaryeri siparişi HİÇ yazılmaz (satış mı iade mi bilinmiyor)", async () => {
    const satirlar = await finansSatirlari([
      hb("H1", "Delivered", 100),
      hb("H2", "YeniBirDurum", 100),
      siparis("trendyol", "T1", "Delivered", 100),
      siparis("trendyol", "T2", "BilinmeyenDurum", 100),
    ]);

    expect(satirlar.map((s) => s.externalOrderId)).toEqual(["hb-H1", "ty-T1"]);
  });

  it("eski önbellekten gelen işaretsiz sipariş eskisi gibi yazılır", async () => {
    const eski = { ...hb("ESKI", "Delivered", 80) };
    delete eski.dataIncomplete;

    expect((await finansSatirlari([eski])).map((s) => s.externalOrderId)).toEqual(["hb-ESKI"]);
  });
});

describe("ciro/kâr toplamlarının kümesi", () => {
  it("iptal/iade, tutarı alınamayan ve durumu tanınmayan sipariş toplama girmez", async () => {
    const { isExcludedFromTotals } = await kararlar();

    expect(isExcludedFromTotals(hb("A", "Delivered", 100))).toBe(false);
    expect(isExcludedFromTotals(hb("B", "Open", 100))).toBe(false);
    expect(isExcludedFromTotals(hb("C", "Returned", 100))).toBe(true);
    expect(isExcludedFromTotals(hb("D", "Delivered", null))).toBe(true);
    expect(isExcludedFromTotals(hb("E", "YeniBirDurum", 100))).toBe(true);
    expect(isExcludedFromTotals(siparis("trendyol", "F", "BilinmeyenDurum", 100))).toBe(true);
    expect(isExcludedFromTotals(siparis("trendyol", "G", "Picking", 100))).toBe(false);
  });

  it("Shopify'da 'tanınmayan durum' kuralı yok (masaüstüyle aynı)", async () => {
    const { isUnknownStatusOrder } = await kararlar();

    expect(isUnknownStatusOrder(siparis("shopify", "S", "HERHANGI_BIR_SEY", 100))).toBe(false);
  });

  it("Panel ve Raporlar AYNI fonksiyonu kullanıyor", () => {
    const raporlar = oku("mobile/src/app/(tabs)/reports.tsx");
    expect(oku("mobile/src/app/(tabs)/index.tsx")).toContain("sayilmazMi: isExcludedFromTotals,");
    expect(raporlar).toContain("if (isExcludedFromTotals(o)) {");
    // Özet, en çok satanlar ve günlük grafik aynı kümeden: ekranda iki ayrı sayı çıkmasın.
    expect(raporlar.match(/isExcludedFromTotals\(o\)/g)).toHaveLength(3);
    expect(raporlar).not.toMatch(/isCancelledOrder\(o\)/);
  });

  it("liste ve detay tutarı alınamayan siparişte ₺0 değil '—' gösterir", () => {
    expect(oku("mobile/src/app/(tabs)/orders.tsx")).toContain("formatCurrency(tutarYok ? null : order.total)");
    expect(oku("mobile/src/app/order/[id].tsx")).toMatch(/!tutarYok && products && rules && settings/);
  });
});
