import { NextResponse } from "next/server";
import { vatRateOf } from "@/core/vat";
import { prisma } from "@/lib/prisma";
import { simulatePrice } from "@/core/pricing-engine";
import { platformMinOrderQty, shopifyCargoOverride } from "@/core/platform-rules";
import { withProductCommissionRule, resolveListingCommissionOverride } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";
import { packagingScopeInput, resolveProductCost } from "@/core/product-cost";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { swr } from "@/lib/route-cache";

type Platform = "shopify" | "trendyol" | "hepsiburada";

interface PlatformStats {
  platform: Platform;
  activeListings: number;
  /** Maliyeti girilmediği için kâr hesabına giremeyen ilan sayısı (activeListings'in alt kümesi). */
  missingCostListings: number;
  totalProfit: number;
  /** Ciroya göre ağırlıklı marj. Hesaplanacak ciro yoksa null — BİLİNMEYEN ≠ SIFIR. */
  averageMargin: number | null;
  negativeProfitCount: number;
  thinMarginCount: number;
}

/** Kartlarda gösterilen satır sayısı; kalanı "+N" olarak yazılır. */
const LOW_STOCK_LIMIT = 30;
const PROBLEM_LIMIT = 30;

/**
 * Panel verisini SWR önbelleğiyle sun: kullanıcı uygulamayı açtığında (açılışta ısıtılır) veya
 * panele döndüğünde ANINDA gelir; veri arka planda tazelenir. Uzak-HTTP'de panel ~2sn'lik ağ
 * gidiş-dönüşüydü — artık kullanıcı bunu beklemiyor. (Toplam/özet veri; ~20sn bayatlık kabul
 * edilebilir ve arka planda kendini tazeler.)
 */
export async function GET() {
  try {
    // v2: marj artık ciroya göre ağırlıklı ve ilan sayısı maliyetten bağımsız — yanıtın ANLAMI
    // değişti. Sürüm artmazsa güncelleme sonrası ilk açılışta diskteki ESKİ gövde taze sayılır
    // (route-cache diski 30 güne kadar geçerli tutar) ve "düzelttik" denen rakamlar düzelmiş
    // görünmez.
    const data = await swr("dashboard:v2", 20_000, computeDashboard);
    return NextResponse.json(data);
  } catch (error) {
    // Sarmalanmamış rota GÖVDESİZ 500 döndürüyordu: Panel boş kalıyor, sebep hiçbir yere yazılmıyordu.
    console.error("[dashboard] hesaplanamadı", error);
    return jsonError(error);
  }
}

async function computeDashboard() {
  await ensureRuntimeSchema();

  const [products, commissionRules, cargoRules, expenseRules, settings] =
    await Promise.all([
      prisma.product.findMany({
        where: { isActive: true, hidden: false },
        include: {
          cost: { include: { filamentType: { select: { costPerGram: true } } } },
          listings: { where: { isActive: true } },
        },
      }),
      prisma.commissionRule.findMany({ where: { isActive: true } }),
      prisma.cargoRule.findMany({ where: { isActive: true } }),
      prisma.expenseRule.findMany({ where: { isActive: true } }),
      prisma.appSetting.findMany(),
    ]);

  const settingsMap = Object.fromEntries(
    settings.map((s) => [s.key, s.value])
  );
  const vatRate = vatRateOf(settingsMap);

  const totalProducts = products.length;
  let missingCost = 0;
  let totalNegativeListings = 0;
  let inStockCount = 0;
  let outOfStockCount = 0;
  let lowStockCount = 0;

  const lowStockProducts: Array<{
    id: string;
    name: string;
    stock: number;
    imageUrl: string | null;
  }> = [];

  const platformStats: Record<Platform, PlatformStats> = {
    shopify: { platform: "shopify", activeListings: 0, missingCostListings: 0, totalProfit: 0, averageMargin: null, negativeProfitCount: 0, thinMarginCount: 0 },
    trendyol: { platform: "trendyol", activeListings: 0, missingCostListings: 0, totalProfit: 0, averageMargin: null, negativeProfitCount: 0, thinMarginCount: 0 },
    hepsiburada: { platform: "hepsiburada", activeListings: 0, missingCostListings: 0, totalProfit: 0, averageMargin: null, negativeProfitCount: 0, thinMarginCount: 0 },
  };

  /**
   * Ağırlıklı marj birikimi: marj = toplam net kâr / toplam ciro.
   * İlan başına DÜZ ortalama, cirosu birkaç liralık küçük ilanları büyüklerle eşit sayıp
   * platform marjını şişiriyordu.
   */
  const platformMargin: Record<Platform, { profit: number; revenue: number }> = {
    shopify: { profit: 0, revenue: 0 },
    trendyol: { profit: 0, revenue: 0 },
    hepsiburada: { profit: 0, revenue: 0 },
  };

  const problemProducts: Array<{
    id: string;
    name: string;
    listingId?: string;
    platform?: Platform;
    salePrice: number;
    problem: "missing_cost" | "negative_profit";
    profit: number | null;
    margin: number | null;
  }> = [];

  for (const product of products) {
    // "Sipariş üzerine üretilir" ürünler stok tutmaz → stok sayımına/uyarısına girmez.
    if (!product.madeToOrder) {
      if (product.stock > 0) inStockCount++;
      else outOfStockCount++;

      // Düşük stok (≤1) takibi. Kesme İŞLEMİ SIRALAMADAN SONRA yapılır (aşağıda): eskiden
      // ilk 30 satır alınıp sonra sıralandığı için stoğu 1 olanlar, stoğu 0 olanları dışarı itiyordu.
      if (product.stock <= 1) {
        lowStockCount++;
        lowStockProducts.push({
          id: product.id,
          name: product.name,
          stock: product.stock,
          imageUrl: product.imageUrl,
        });
      }
    }

    // Maliyeti güncel ayarlardan yeniden hesapla (zam otomatik yansır)
    const resolved = resolveProductCost(
      product.cost,
      settingsMap,
      product.cost?.filamentType?.costPerGram ?? 0
    );
    const productCost = resolved?.productionCost ?? 0;
    const packagingCost = resolved?.packagingCost ?? 0;
    const filamentCost = resolved?.filamentCost ?? 0;
    const costKnown = Boolean(resolved?.productionCostKnown);

    if (!costKnown) {
      missingCost++;
      problemProducts.push({
        id: product.id,
        name: product.name,
        salePrice: product.currentSalePrice,
        problem: "missing_cost",
        profit: null,
        margin: null,
      });
    }

    // Her aktif listing için kâr hesabı
    for (const listing of product.listings) {
      const platform = listing.platform as Platform;
      if (!platformStats[platform]) continue;

      // İLAN SAYISI maliyetten bağımsız: maliyeti eksik ürünün ilanları da platformda duruyor.
      // Eskiden bu ürünler daha döngüye girmeden atlandığı için Shopify 368 yerine 280 gösteriyordu.
      platformStats[platform].activeListings++;
      if (!costKnown) {
        platformStats[platform].missingCostListings++;
        continue; // kâr/marj yalnız maliyeti bilinen ilanlardan hesaplanır
      }

      const sim = simulatePrice({
        salePrice: listing.salePrice,
        productCost,
        packagingCost,
        ...packagingScopeInput(resolved),
        categoryName: product.categoryName,
        desi: product.desi ?? 1,
        commissionRules: withProductCommissionRule(
          product,
          commissionRules as Parameters<typeof simulatePrice>[0]["commissionRules"]
        ),
        cargoRules: filterCargoRulesByPlatform(
          cargoRules as Parameters<typeof simulatePrice>[0]["cargoRules"],
          platform
        ),
        expenseRules: filterRulesByPlatform(
          expenseRules as Parameters<typeof simulatePrice>[0]["expenseRules"],
          platform
        ),
        vatRate,
        ...resolveListingCommissionOverride(listing, settingsMap),
        // ÜRÜNLER sayfası matematiğiyle BİREBİR (karar): Panel eskiden bu iki kuralı uygulamıyordu
        // → aynı listing Panel'de farklı, Ürünler sayfasında/mobilde farklı kâr gösteriyordu.
        // Artık iki kural da TEK kaynaktan (core/platform-rules) geliyor.
        cargoCostOverride:
          listing.cargoCost ?? shopifyCargoOverride(listing.platform, listing.salePrice),
        minOrderQty: platformMinOrderQty(listing.platform, listing.salePrice),
        vatableProductCost: filamentCost,
      });

      platformStats[platform].totalProfit += sim.netProfit;

      // Cirosu olmayan ilan (fiyatı 0 / geçersiz) ağırlığa girmez — payda şişmesin.
      const listingRevenue = sim.salePriceExVat * sim.minOrderQty;
      if (Number.isFinite(listingRevenue) && listingRevenue > 0) {
        platformMargin[platform].profit += sim.netProfit;
        platformMargin[platform].revenue += listingRevenue;
      }

      if (sim.netProfit < 0) {
        platformStats[platform].negativeProfitCount++;
        totalNegativeListings++;
        problemProducts.push({
          id: product.id,
          name: product.name,
          listingId: listing.id,
          platform,
          salePrice: listing.salePrice,
          problem: "negative_profit",
          profit: sim.netProfit,
          margin: sim.profitMargin,
        });
      }
    }
  }

  // Ortalama marjları hesapla — HB dahil (eskiden atlanıyordu → masaüstü HB marjı hep 0,
  // mobil hesaplıyordu; iki cihaz farklı değer gösteriyordu).
  for (const platform of ["shopify", "trendyol", "hepsiburada"] as Platform[]) {
    const m = platformMargin[platform];
    // Ciro yoksa marj BİLİNMİYOR; 0 yazmak "marjımız sıfır" demek olurdu.
    platformStats[platform].averageMargin = m.revenue > 0 ? m.profit / m.revenue : null;
  }

  const grandTotalProfit =
    platformStats.shopify.totalProfit + platformStats.trendyol.totalProfit + platformStats.hepsiburada.totalProfit;

  // Stoğu bitenler en üstte, sonra stoğu 1 olanlar; eşitlikte ada göre (liste her açılışta aynı sırada).
  lowStockProducts.sort(
    (a, b) => a.stock - b.stock || a.name.localeCompare(b.name, "tr-TR")
  );
  const lowStockShown = lowStockProducts.slice(0, LOW_STOCK_LIMIT);

  // ÖNEM sırası: en çok kaybettiren ilan en üstte, maliyeti eksik olanlar en sonda (onların kendi
  // kartı var). Eskiden ürün sırasına göre ilk 30 alındığı için zarar eden ilanların yarısı hiç görünmüyordu.
  problemProducts.sort((a, b) => {
    const aLoss = a.problem === "negative_profit";
    const bLoss = b.problem === "negative_profit";
    if (aLoss !== bLoss) return aLoss ? -1 : 1;
    if (aLoss && bLoss) return (a.profit ?? 0) - (b.profit ?? 0);
    return a.name.localeCompare(b.name, "tr-TR");
  });
  const problemShown = problemProducts.slice(0, PROBLEM_LIMIT);

  return {
    totalProducts,
    inStockCount,
    outOfStockCount,
    lowStockCount,
    lowStockProducts: lowStockShown,
    lowStockShown: lowStockShown.length,
    lowStockMore: Math.max(0, lowStockCount - lowStockShown.length),
    missingCost,
    negativeListings: totalNegativeListings,
    grandTotalProfit,
    platforms: Object.values(platformStats),
    problemProducts: problemShown,
    problemTotal: problemProducts.length,
    problemShown: problemShown.length,
    problemMore: Math.max(0, problemProducts.length - problemShown.length),
    problemNegativeCount: totalNegativeListings,
    problemMissingCostCount: missingCost,
  };
}
