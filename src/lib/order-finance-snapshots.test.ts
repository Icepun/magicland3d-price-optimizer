import { describe, expect, it } from "vitest";
import { FINANCE_CALCULATION_VERSION } from "@/core/finance-version";
import {
  canonicalFinanceOrderId,
  resolveSnapshotWriteData,
  shouldReplaceCapturedProfit,
  type ExistingSnapshotRow,
  type FinanceSnapshotOrder,
} from "./order-finance-snapshots";

describe("mikro ihracat — yakalanmış kâr yalnız bu bilgi değişince yenilenir", () => {
  const kayitli: ExistingSnapshotRow = {
    orderNumber: "11830532104",
    orderedAt: new Date("2026-11-14T10:00:00Z"),
    revenueKurus: 38_249,
    profitKurus: 5_000,
    profitPartial: false,
    profitSource: "calculated",
    estimatedCommissionKurus: 7_650,
    actualCommissionKurus: null,
    outputVatKurus: 6_375,
    inputVatCreditKurus: 2_000,
    microExportCountry: null,
    actualFeesKurus: null,
    cargoKurus: null,
    returnLossKurus: null,
    returnLossVatKurus: null,
    cargoContext: null,
    penaltyKurus: null,
    delayInfo: null,
    statusKind: "pending",
    currency: "TRY",
    calculationVersion: FINANCE_CALCULATION_VERSION,
  };
  const siparis = (over: Partial<FinanceSnapshotOrder>): FinanceSnapshotOrder => ({
    platform: "trendyol",
    id: "ty-1",
    orderNumber: "11830532104",
    date: "2026-11-14T10:00:00.000Z",
    total: 382.49,
    profit: 113.75,
    profitPartial: false,
    statusKind: "pending",
    currency: "TRY",
    outputVat: 0,
    inputVatCredit: 20,
    ...over,
  });

  it("mikro olduğu ilk kez öğrenilince kâr ve KDV yeniden yazılır", () => {
    const yeni = resolveSnapshotWriteData(kayitli, siparis({ microExport: { ulke: "SA" } }), kayitli.orderedAt);
    expect(yeni.microExportCountry).toBe("SA");
    expect(yeni.profitKurus).toBe(11_375);
    expect(yeni.outputVatKurus).toBe(0);
  });

  it("yurt içi sipariş (null) ve bilgisiz çağrı (undefined) yakalanmış kâra DOKUNMAZ", () => {
    // Yurt içi siparişin satış KDV'si kayıtlıyla aynı (KDV değişimi ayrı kural).
    const yurtIci = resolveSnapshotWriteData(kayitli, siparis({ microExport: null, outputVat: 63.75 }), kayitli.orderedAt);
    expect(yurtIci.profitKurus).toBe(5_000);
    const bilgisiz = resolveSnapshotWriteData(
      { ...kayitli, microExportCountry: "SA" },
      siparis({ microExport: undefined, outputVat: 63.75 }),
      kayitli.orderedAt
    );
    // Shopify/HB ya da eski çağrı yeri kayıtlı ülkeyi silmez.
    expect(bilgisiz.microExportCountry).toBe("SA");
    expect(bilgisiz.profitKurus).toBe(5_000);
  });

  it("ülke bilinmeyen mikro sipariş 'XX' olarak saklanır", () => {
    const yeni = resolveSnapshotWriteData(kayitli, siparis({ microExport: { ulke: null } }), kayitli.orderedAt);
    expect(yeni.microExportCountry).toBe("XX");
  });

  it("satış KDV'si değişince (oran sonradan geldi) yakalanmış kâr yenilenir; bilinmeyen KDV dokunmaz", () => {
    const yakalanmis = { ...kayitli, outputVatKurus: 6_333 };
    const yeni = { revenueKurus: 38_249, profitKurus: 12_130, profitPartial: false };
    expect(shouldReplaceCapturedProfit(yakalanmis, { ...yeni, outputVatKurus: 3_454 })).toBe(true);
    expect(shouldReplaceCapturedProfit(yakalanmis, { ...yeni, outputVatKurus: 6_334 })).toBe(false);
    expect(shouldReplaceCapturedProfit(yakalanmis, { ...yeni, outputVatKurus: null })).toBe(false);
    expect(shouldReplaceCapturedProfit({ ...yakalanmis, outputVatKurus: null }, { ...yeni, outputVatKurus: 3_454 })).toBe(false);
  });

  it("karar fonksiyonu: undefined karşılaştırmaya girmez", () => {
    const tam = { ...kayitli };
    expect(shouldReplaceCapturedProfit(tam, { revenueKurus: 38_249, profitKurus: 1, profitPartial: false })).toBe(false);
    expect(
      shouldReplaceCapturedProfit(tam, { revenueKurus: 38_249, profitKurus: 1, profitPartial: false, microExportCountry: "SA" })
    ).toBe(true);
  });
});

describe("finance snapshot order ids", () => {
  it("masaüstü ve mobil Shopify kimliklerini aynı kanonik kimliğe çevirir", () => {
    expect(canonicalFinanceOrderId("shopify", "gid://shopify/Order/12345")).toBe(
      "sh-12345"
    );
    expect(canonicalFinanceOrderId("shopify", "sh-12345")).toBe("sh-12345");
  });

  it("diğer platform kimliklerini değiştirmez", () => {
    expect(canonicalFinanceOrderId("trendyol", "ty-42")).toBe("ty-42");
    expect(canonicalFinanceOrderId("hepsiburada", "hb-99")).toBe("hb-99");
  });

  it("manual kimliğini kanonikleştirmeden bırakır", () => {
    expect(canonicalFinanceOrderId("manual", "manual-42")).toBe("manual-42");
  });

  it("tam yakalanmış kârı maliyet değişince korur, gelir/iade değişince yeniler", () => {
    const captured = {
      revenueKurus: 10_000,
      profitKurus: 2_500,
      profitPartial: false,
      profitSource: "calculated",
      actualCommissionKurus: null,
      // GÜNCEL sürümle yazılmış satır. Gerçek satırlar bu alanı her zaman taşır; eski sürümle
      // yazılmışsa kâr bilerek YENİDEN hesaplanır (bkz. core/finance-version.ts v4).
      calculationVersion: FINANCE_CALCULATION_VERSION,
    };
    expect(
      shouldReplaceCapturedProfit(captured, {
        revenueKurus: 10_000,
        profitKurus: 2_000,
        profitPartial: false,
      })
    ).toBe(false);
    expect(
      shouldReplaceCapturedProfit(captured, {
        revenueKurus: 8_000,
        profitKurus: 500,
        profitPartial: true,
      })
    ).toBe(true);
  });

  it("eksik veya kısmi kâr tam hesaplanınca yakalanan değeri geliştirir", () => {
    expect(
      shouldReplaceCapturedProfit(
        { revenueKurus: 10_000, profitKurus: null, profitPartial: false },
        { revenueKurus: 10_000, profitKurus: 2_000, profitPartial: true }
      )
    ).toBe(true);
    expect(
      shouldReplaceCapturedProfit(
        { revenueKurus: 10_000, profitKurus: 1_500, profitPartial: true },
        { revenueKurus: 10_000, profitKurus: 2_000, profitPartial: false }
      )
    ).toBe(true);
  });

  it("platform komisyonu gelince yakalanan kârı yükseltir ve değişiklikleri izler", () => {
    const calculated = {
      revenueKurus: 10_000,
      profitKurus: 2_500,
      profitPartial: false,
      profitSource: "calculated",
      actualCommissionKurus: null,
      calculationVersion: FINANCE_CALCULATION_VERSION,
    };
    const platform = {
      revenueKurus: 10_000,
      profitKurus: 2_650,
      profitPartial: false,
      profitSource: "platform",
      actualCommissionKurus: 1_800,
      calculationVersion: FINANCE_CALCULATION_VERSION,
    };

    expect(shouldReplaceCapturedProfit(calculated, platform)).toBe(true);
    expect(shouldReplaceCapturedProfit(platform, platform)).toBe(false);
    expect(
      shouldReplaceCapturedProfit(platform, {
        ...platform,
        profitKurus: 2_600,
        actualCommissionKurus: 1_850,
      })
    ).toBe(true);
  });
});

describe("komisyondan sonra gelen gerçek kesinti (kargo faturası) kayıtlı kârı yeniler", () => {
  const kayitli = {
    revenueKurus: 72_199, profitKurus: 20_000, profitPartial: false, profitSource: "platform",
    actualCommissionKurus: 14_440, calculationVersion: FINANCE_CALCULATION_VERSION, actualFeesKurus: null,
  };
  const gelen = (actualFeesKurus: number | null | undefined) => ({
    revenueKurus: 72_199, profitKurus: 21_500, profitPartial: false, profitSource: "platform",
    actualCommissionKurus: 14_440, actualFeesKurus,
  });
  it("kargo faturası ilk kez geldi → yenilenir; aynı tutar tekrar gelirse yenilenmez", () => {
    expect(shouldReplaceCapturedProfit(kayitli, gelen(12_864))).toBe(true);
    expect(shouldReplaceCapturedProfit({ ...kayitli, actualFeesKurus: 12_864 }, gelen(12_864))).toBe(false);
  });
  it("bilgi taşımayan çağrı (undefined/null) donmuş kârı oynatmaz", () => {
    expect(shouldReplaceCapturedProfit(kayitli, gelen(undefined))).toBe(false);
    expect(shouldReplaceCapturedProfit({ ...kayitli, actualFeesKurus: 12_864 }, gelen(null))).toBe(false);
  });
  it("tahmini kâr (platform kaynaklı değil) bu kuralla yenilenmez", () => {
    expect(shouldReplaceCapturedProfit({ ...kayitli, profitSource: "calculated", actualCommissionKurus: null }, { ...gelen(12_864), profitSource: "calculated", actualCommissionKurus: null })).toBe(false);
  });
});
