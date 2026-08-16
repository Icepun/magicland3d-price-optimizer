import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { simulatePrice } from "@/core/pricing-engine";
import { belowShopifyMinBasket } from "@/core/platform-rules";
import type { CargoRuleInput, CommissionRuleInput, ExpenseRuleInput } from "@/core/types";

/**
 * Ürün detayındaki kâr dökümü.
 *
 * Zorunlu minimum adetli (Trendyol) ürünlerde ürün/paketleme/komisyon satırları SİPARİŞ toplamı
 * (×adet) gösteriliyor ama KDV satırı TEK ADET'ti: rakam doğru, döküm yanlış ölçekteydi — satırlar
 * toplanınca net kâr çıkmıyordu. Aşağıdaki kimlik dökümün toplamının net kâra eşit olduğunu
 * kilitler; sayfa da bu kuralla yazılmış olmalı (kaynak kontrolleri).
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const SAYFA = readFileSync(path.join(REPO_ROOT, "src/app/products/[id]/page.tsx"), "utf8");

const KOMISYON: CommissionRuleInput[] = [
  {
    id: "k1",
    name: "Trendyol",
    categoryName: null,
    minPrice: 0,
    maxPrice: 1_000_000,
    commissionRate: 0.15,
    fixedCommission: 0,
    priority: 1,
    isActive: true,
  },
];

const KARGO: CargoRuleInput[] = [
  {
    id: "c1",
    name: "0-1 desi",
    platform: "trendyol",
    categoryName: null,
    minPrice: 0,
    maxPrice: 1_000_000,
    minDesi: 0,
    maxDesi: 10,
    cargoCost: 40,
    priority: 1,
    isActive: true,
  },
];

const GIDERLER: ExpenseRuleInput[] = [
  {
    id: "g1",
    name: "Platform payı",
    type: "percentage",
    value: 0.02,
    categoryName: null,
    minPrice: 0,
    maxPrice: 1_000_000,
    priority: 1,
    isActive: true,
  },
  {
    id: "g2",
    name: "Hizmet bedeli",
    type: "fixed",
    value: 6.99,
    categoryName: null,
    minPrice: 0,
    maxPrice: 1_000_000,
    priority: 1,
    isActive: true,
  },
];

function simule(minOrderQty: number, adRate = 0) {
  return simulatePrice({
    salePrice: 30,
    productCost: 10,
    packagingCost: 2,
    categoryName: "Dekor",
    desi: 1,
    commissionRules: KOMISYON,
    cargoRules: KARGO,
    expenseRules: GIDERLER,
    vatRate: 20,
    minOrderQty,
    adRate,
  });
}

/** Ekranda gösterilen satırlar — sayfadaki döküm ile BİREBİR aynı ölçek kuralı. */
function dokumSatirlari(result: ReturnType<typeof simulatePrice>) {
  const qty = result.minOrderQty;
  return {
    kdv: result.vatAmount * qty,
    urunVePaketleme: result.productCost + result.packagingCost,
    komisyon: result.commissionCost,
    kargo: result.cargoCost,
    reklam: result.adCost,
    giderler: result.appliedExpenseRules.map((exp) =>
      exp.type === "percentage" ? exp.amount * qty : exp.amount
    ),
    kdvIadesi: result.inputVatCredit,
  };
}

describe("kâr dökümünün toplamı net kâra eşittir", () => {
  it("REKLAM PAYI da satır olarak düşülünce toplam net kârı verir", () => {
    /**
     * Reklam payı `totalCost`a giriyor; dökümde ayrı satır olarak gösterilmezse kartın
     * satırları toplandığında net kâr ÇIKMAZ (kullanıcı "rakamlar tutmuyor" der).
     * Bu test satırın varlığını kimlik üzerinden kilitler.
     */
    const result = simule(1, 0.1871); // ölçülen gerçek oran
    expect(result.adCost).toBeGreaterThan(0);

    const satir = dokumSatirlari(result);
    const siparisCirosu = result.effectiveSalePrice * result.minOrderQty;
    const toplam =
      siparisCirosu -
      satir.kdv -
      satir.urunVePaketleme -
      satir.komisyon -
      satir.kargo -
      satir.reklam -
      satir.giderler.reduce((a, b) => a + b, 0) +
      satir.kdvIadesi;

    expect(toplam).toBeCloseTo(result.netProfit, 8);
  });

  it("reklam payı KDV İADESİNE girmez (yurt dışı fatura, Türk KDV'si yok)", () => {
    const reklamsiz = simule(1, 0);
    const reklamli = simule(1, 0.1871);
    expect(reklamli.inputVatCredit).toBeCloseTo(reklamsiz.inputVatCredit, 8);
  });

  it("sayfa reklam payı satırını basıyor", () => {
    expect(SAYFA).toContain("Reklam payı");
    expect(SAYFA).toMatch(/result\.adCost/);
  });

  for (const qty of [1, 4]) {
    it(`${qty} adetlik siparişte satırlar net kârı verir`, () => {
      const result = simule(qty);
      const satir = dokumSatirlari(result);

      // Kartın tepesinde gösterilen sipariş cirosu (KDV dahil) → satırlar düşülür → net kâr.
      const siparisCirosu = result.effectiveSalePrice * result.minOrderQty;
      const toplam =
        siparisCirosu -
        satir.kdv -
        satir.urunVePaketleme -
        satir.komisyon -
        satir.kargo -
        satir.reklam -
        satir.giderler.reduce((a, b) => a + b, 0) +
        satir.kdvIadesi;

      expect(toplam).toBeCloseTo(result.netProfit, 8);
    });
  }

  it("çok adetli siparişte KDV satırı TEK ADET kalırsa toplam tutmaz (gerileme koruması)", () => {
    const result = simule(4);
    const satir = dokumSatirlari(result);
    const eskiToplam =
      result.effectiveSalePrice * result.minOrderQty -
      result.vatAmount - // eski hata: tek adetlik KDV
      satir.urunVePaketleme -
      satir.komisyon -
      satir.kargo -
      satir.giderler.reduce((a, b) => a + b, 0) +
      satir.kdvIadesi;

    expect(Math.abs(eskiToplam - result.netProfit)).toBeGreaterThan(1);
  });

  it("sayfa KDV satırını sipariş ölçeğinde basıyor ve adedi tek satırda söylüyor", () => {
    expect(SAYFA).toContain("result.vatAmount * result.minOrderQty");
    expect(SAYFA).not.toContain("−{formatCurrency(result.vatAmount)}");
    expect(SAYFA).toContain("adetlik sipariş üzerinden");
    // Ciroyla orantılı gider adetle çarpılır, sabit gider siparişe bir kez.
    expect(SAYFA).toContain('exp.type === "percentage" ? exp.amount * result.minOrderQty : exp.amount');
  });
});

/**
 * Kâr hangi VARSAYIMLA çıktı? Desi boşken kargo 1 desi kabul edilir; ürüne uyan kargo bareni
 * yoksa kargo 0₺ sayılır. İkisi de kârı olduğundan yüksek gösterir → ekran uyarmak zorunda.
 */
describe("eksik girdi uyarıları", () => {
  it("uyan kargo kuralı yoksa kargo 0₺ sayılır (uyarının dayanağı)", () => {
    const desisiBuyuk = simulatePrice({
      salePrice: 300,
      productCost: 10,
      packagingCost: 2,
      categoryName: "Dekor",
      desi: 25, // baremin dışında → kural eşleşmez
      commissionRules: KOMISYON,
      cargoRules: KARGO,
      expenseRules: [],
      vatRate: 20,
    });

    expect(desisiBuyuk.appliedCargoRule).toBeUndefined();
    expect(desisiBuyuk.cargoCost).toBe(0);
  });

  it("Shopify'da sepet minimumunun altı kargosuzdur — bu uyarı DEĞİLDİR", () => {
    expect(belowShopifyMinBasket("shopify", 100)).toBe(true);
    expect(belowShopifyMinBasket("shopify", 200)).toBe(false);
    expect(belowShopifyMinBasket("trendyol", 100)).toBe(false);
  });

  it("sayfa iki uyarıyı da kısa ve jargonsuz gösteriyor", () => {
    expect(SAYFA).toContain("Desi girilmedi — kargo 1 desi sayıldı, kâr olduğundan yüksek olabilir.");
    expect(SAYFA).toContain("Bu ürüne uyan kargo fiyatı yok — kargo ₺0 sayıldı, kâr gerçekte daha düşük.");
    // Desi 0 bilinçli bir değerdir → uyarı üretmez, yalnız hiç girilmemişse uyarılır.
    expect(SAYFA).toContain("costValues.desi == null && product?.desi == null");
    // Fiyat Laboratuvarı da aynı varsayımlarla çalışıyor → uyarı orada da görünür.
    expect(SAYFA).toContain("<ProfitAssumptionNotes");
    expect(SAYFA).toContain("cargoRuleMissing={cargoRuleMissingAnywhere}");
  });
});

/** Tek tıkla 28 ürünün maliyetini değiştiren, geri alınamaz işlem onay ister. */
describe("tüm varyantlara uygula", () => {
  it("önce onay penceresi açılır, mutasyon doğrudan çalışmaz", () => {
    expect(SAYFA).toContain("const handleApplyToVariants = useCallback(() => setApplyConfirmOpen(true)");
    expect(SAYFA).toContain("Tüm varyantlara uygulansın mı?");
    expect(SAYFA).toContain("hepsine yazılacak. Eski maliyetleri geri getiremezsin.");
  });
});

/** Bekleyen kayıt, form sökülürken (varyant değişimi / sayfadan çıkış) hemen yazılır. */
describe("kaydedilmemiş değişiklik", () => {
  it("flush sayfadan çıkarken tetiklenir ve kullanıcı tek satırla bilgilendirilir", () => {
    expect(SAYFA).toContain("onFlush={flushCostSave}");
    expect(SAYFA).toContain('toast.info("Son değişiklikler kaydediliyor…")');
  });
});
