import { describe, expect, it } from "vitest";
import { resolveProductCost } from "./product-cost";

const BASE = {
  costMode: "manual",
  filamentWeight: null,
  printTimeHours: null,
  wasteRate: null,
  packagingOptionId: null,
  nylonLevel: null,
  tapeUsed: null,
};

describe("manuel ürün maliyeti", () => {
  it("ürün ve ambalaj ayrı kaydedildiyse ambalaj kapsamını korur", () => {
    const result = resolveProductCost(
      {
        ...BASE,
        manualCost: 50,
        packagingCost: 10,
        totalCost: 60,
      },
      {},
      0
    );

    expect(result?.productionCost).toBe(50);
    expect(result?.packagingCost).toBe(10);
    expect(result?.packagingBreakdown?.perShipment).toBe(10);
    expect(result?.totalCost).toBe(60);
  });

  it("eski kayıtta toplam zaten manualCost ise ambalajı ikinci kez eklemez", () => {
    const result = resolveProductCost(
      {
        ...BASE,
        manualCost: 60,
        packagingCost: 10,
        totalCost: 60,
      },
      {},
      0
    );

    expect(result?.productionCost).toBe(60);
    expect(result?.packagingCost).toBe(0);
    expect(result?.totalCost).toBe(60);
  });
});

/**
 * REGRESYON: "maliyeti biliniyor mu?" kararı totalCost'a BAKAMAZ.
 *
 * Kart/sticker/sakız her ürüne koşulsuz eklendiği için totalCost fiilen hiçbir zaman 0 olmuyordu;
 * filament gramajı/süresi hiç girilmemiş ürünler bu yüzden "maliyeti tam" sayılıp Ürünler'de
 * kârlı görünüyor, "Maliyet eksik" filtresine düşmüyor ve şişik kâr Raporlar'a yazılıyordu.
 */
const PACKAGING_SETTINGS = {
  cardQty: "100",
  cardPrice: "250",
  stickerQty: "500",
  stickerPrice: "300",
};

describe("üretim maliyeti bilinirliği", () => {
  it("detaylı modda gramaj/süre girilmemişse maliyet BİLİNMİYOR sayılır (paketleme maskelemez)", () => {
    const result = resolveProductCost(
      { ...BASE, costMode: "detailed", manualCost: null, totalCost: null },
      PACKAGING_SETTINGS,
      1.2
    );

    // Paketleme tek başına toplamı 0'ın üstüne çıkarıyor — eski kapı burada "maliyet var" diyordu.
    expect(result?.totalCost).toBeGreaterThan(0);
    expect(result?.productionCost).toBe(0);
    expect(result?.productionCostKnown).toBe(false);
  });

  it("filament gramajı girilince maliyet BİLİNİYOR sayılır", () => {
    const result = resolveProductCost(
      { ...BASE, costMode: "detailed", manualCost: null, totalCost: null, filamentWeight: 20 },
      PACKAGING_SETTINGS,
      1.2
    );

    expect(result?.productionCost).toBeGreaterThan(0);
    expect(result?.productionCostKnown).toBe(true);
  });

  it("elle girilen maliyet 0 ise bilinmiyor, pozitifse biliniyor sayılır", () => {
    const bos = resolveProductCost(
      { ...BASE, manualCost: 0, packagingCost: 10, totalCost: 10 },
      PACKAGING_SETTINGS,
      0
    );
    expect(bos?.productionCostKnown).toBe(false);

    const dolu = resolveProductCost(
      { ...BASE, manualCost: 50, packagingCost: 10, totalCost: 60 },
      PACKAGING_SETTINGS,
      0
    );
    expect(dolu?.productionCostKnown).toBe(true);
  });

  it("maliyet kaydı hiç yoksa null döner", () => {
    expect(resolveProductCost(null, PACKAGING_SETTINGS, 1.2)).toBeNull();
  });
});
