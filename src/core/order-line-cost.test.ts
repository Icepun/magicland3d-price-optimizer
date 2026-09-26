import { describe, expect, it } from "vitest";
import {
  satirAnahtari,
  satirMaliyetiCozumle,
  satirMaliyetiHaritaAnahtari,
  satirMaliyetiOku,
  satirMaliyetiYaz,
  satirMaliyetliUrun,
  siparisKimligi,
  type SatirMaliyeti,
} from "./order-line-cost";
import { resolveOrderProfit, type OrderProfitInput } from "./order-profit";
import { resolveProductCost } from "./product-cost";
import { filamentFiyatHaritasi } from "./filament-karisimi";

/**
 * SİPARİŞE ÖZEL MALİYET — "stoğunu bitirmeye çalıştığım ürünleri ürünler sayfasına eklemedim;
 * siparişlerde çıktıkları için kâr hesabı bozuluyor". Berke'nin kararı: YALNIZ o sipariş.
 */

const fiyat = filamentFiyatHaritasi([{ id: "x", costPerGram: 0.5 }]);
const ayar = { costMachineWearPerHour: "4" };

const hesap: SatirMaliyeti = {
  mod: "hesap",
  filamentTypeId: "x",
  filamentWeight: 80,
  ekFilamentler: [],
  printTimeHours: 2,
  wasteRate: 0.1,
  tutar: null,
  packagingOptionId: null,
  nylonLevel: null,
  tapeUsed: null,
};

describe("anahtarlar", () => {
  it("sipariş kimliği finans kayıtlarıyla aynı biçim (Shopify sh-)", () => {
    expect(siparisKimligi("shopify", "gid://shopify/Order/123")).toBe("sh-123");
    expect(siparisKimligi("shopify", "shopify-123")).toBe("sh-123");
    expect(siparisKimligi("shopify", "sh-123")).toBe("sh-123");
    expect(siparisKimligi("trendyol", "ty-5")).toBe("ty-5");
  });

  it("satır: eşleşmiş üründe ürün kimliği, eşleşmemişte normalize ad", () => {
    expect(satirAnahtari({ productId: "p1", name: "Herhangi" })).toBe("p:p1");
    expect(satirAnahtari({ productId: null, name: "  kırık   cam figürü " })).toBe(
      satirAnahtari({ name: "KIRIK CAM FİGÜRÜ" })
    );
  });

  it("harita anahtarı sipariş kimliğini kendisi kanonikleştirir", () => {
    expect(satirMaliyetiHaritaAnahtari("shopify", "gid://shopify/Order/9", "n:X")).toBe(
      satirMaliyetiHaritaAnahtari("shopify", "sh-9", "n:X")
    );
  });
});

describe("kayıt okuma", () => {
  it("gidiş-dönüş bozulmaz", () => {
    expect(satirMaliyetiOku(satirMaliyetiYaz(hesap))).toEqual(hesap);
  });

  it("bozuk kayıt null (satır eskisi gibi 'maliyet eksik' kalır)", () => {
    expect(satirMaliyetiOku("{yarım")).toBeNull();
    expect(satirMaliyetiOku(null)).toBeNull();
  });

  it("fire en fazla %100, eksi sayılar atılır", () => {
    const m = satirMaliyetiOku({ ...hesap, wasteRate: 3, filamentWeight: -5 })!;
    expect(m.wasteRate).toBe(1);
    expect(m.filamentWeight).toBeNull();
  });
});

describe("maliyet çözümü", () => {
  it("'hesap' modu ürün sayfasıyla AYNI motor", () => {
    const satir = satirMaliyetiCozumle(hesap, ayar, fiyat)!;
    const urun = resolveProductCost(
      {
        costMode: "detailed",
        manualCost: null,
        totalCost: null,
        filamentWeight: 80,
        printTimeHours: 2,
        wasteRate: 0.1,
        packagingOptionId: null,
        nylonLevel: null,
        tapeUsed: null,
      },
      ayar,
      0.5,
      fiyat
    )!;
    expect(satir).toEqual(urun);
  });

  it("'tutar' modu: üretim payı girilen rakam, malzeme KDV'si yok", () => {
    const r = satirMaliyetiCozumle({ ...hesap, mod: "tutar", tutar: 45 }, ayar, fiyat)!;
    expect(r.productionCost).toBe(45);
    expect(r.filamentCost).toBe(0);
    expect(r.productionCostKnown).toBe(true);
    expect(satirMaliyetiCozumle({ ...hesap, mod: "tutar", tutar: 0 }, ayar, fiyat)!.productionCostKnown).toBe(false);
  });
});

describe("sipariş kârına girişi", () => {
  const siparis = (urun: OrderProfitInput["lines"][number]["product"]): OrderProfitInput => ({
    platform: "trendyol",
    orderTotal: 400,
    lines: [{ unitPrice: 200, quantity: 2, product: urun }],
    commissionRules: [],
    cargoRules: [],
    expenseRules: [],
    settings: { ...ayar, trendyolCommissionRate: "0.2" },
  });

  it("eşleşmeyen satır özel maliyetle kâra girer — kâr artık eksik değil", () => {
    const once = resolveOrderProfit(siparis(null));
    expect(once.profit).toBeNull();

    const urun = satirMaliyetliUrun(
      { costJson: satirMaliyetiYaz(hesap), desi: 2, lineName: "Eski Kupa" },
      null,
      ayar,
      fiyat
    );
    const sonra = resolveOrderProfit(siparis(urun));
    expect(sonra.profit).not.toBeNull();
    expect(sonra.profitPartial).toBe(false);
  });

  it("katalog ürünü aynı maliyetle aynı kârı verir (tek motor)", () => {
    const cozum = satirMaliyetiCozumle(hesap, ayar, fiyat)!;
    const katalog = {
      id: "p1",
      name: "Kupa",
      categoryName: "Figür",
      desi: 2,
      commissionRate: null,
      listing: null,
    };
    const ozel = satirMaliyetliUrun({ costJson: satirMaliyetiYaz(hesap), desi: null, lineName: "Kupa" }, katalog, ayar, fiyat)!;
    const normal = {
      ...katalog,
      productionCost: cozum.productionCost,
      packagingCost: cozum.packagingCost,
      packagingComponents: cozum.packagingBreakdown?.components ?? null,
      filamentCost: cozum.filamentCost,
      productionCostKnown: cozum.productionCostKnown,
    };
    expect(resolveOrderProfit(siparis(ozel)).profit).toBeCloseTo(resolveOrderProfit(siparis(normal)).profit!);
    // Desi girilmediyse katalog ürününün desisi kullanılır.
    expect(ozel.desi).toBe(2);
  });

  it("okunamayan kayıt satırı değiştirmez", () => {
    expect(satirMaliyetliUrun({ costJson: "{", desi: null, lineName: "x" }, null, ayar, fiyat)).toBeNull();
  });
});
