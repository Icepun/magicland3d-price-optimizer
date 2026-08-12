import { NextRequest, NextResponse } from "next/server";
import { vatRateOf } from "@/core/vat";
import { prisma } from "@/lib/prisma";
import { simulatePrice } from "@/core/pricing-engine";
import { platformMinOrderQty, shopifyCargoOverride } from "@/core/platform-rules";
import { withProductCommissionRule, resolveListingCommissionOverride } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";
import { packagingScopeInput, resolveProductCost } from "@/core/product-cost";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { bustCache, swr } from "@/lib/route-cache";

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

/**
 * Kartlarda gösterilen satır sayısı; kalanı "+N" olarak yazılır.
 *
 * Düşük stok listesi 30'dan 60'a çıkarıldı: kart ilk 30'u gösterip gerisini KENDİ İÇİNDE
 * açabilsin. Eski hâlinde taşan satırların hepsi zorunlu olarak "stok 1" oluyordu ve karttaki
 * bağlantı "stoğu bitenler" listesine gidip BOŞ açılıyordu.
 */
const LOW_STOCK_LIMIT = 60;
const PROBLEM_LIMIT = 30;

/** SWR önbellek anahtarı — gövdenin ANLAMI değişince sürümü artır (aşağıdaki nota bak). */
const CACHE_KEY = "dashboard:v3";

/**
 * Panel verisini SWR önbelleğiyle sun: kullanıcı uygulamayı açtığında (açılışta ısıtılır) veya
 * panele döndüğünde ANINDA gelir; veri arka planda tazelenir. Uzak-HTTP'de panel ~2sn'lik ağ
 * gidiş-dönüşüydü — artık kullanıcı bunu beklemiyor. (Toplam/özet veri; ~20sn bayatlık kabul
 * edilebilir ve arka planda kendini tazeler.)
 *
 * `?fresh=1` → önbellek ATLANIR: kullanıcı "Yenile"ye bastığında disk kopyası değil gerçek
 * rakamlar gelir (ve önbellek o taze gövdeyle yenilenir).
 */
export async function GET(req: NextRequest) {
  try {
    // v2 → v3: gövde artık hesaplama zamanı damgası (computedAt) ve taşan satırların tür bazlı
    // sayılarını taşıyor. Sürüm artmazsa güncelleme sonrası ilk açılışta diskteki ESKİ gövde taze
    // sayılır (route-cache diski 30 güne kadar geçerli tutar); tazelik satırı ve "+N" bağlantıları
    // eksik alanlarla çalışmaz.
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    // Kayıtlı kopyayı düşür → swr taze hesaplayıp önbelleği yeniden doldurur.
    if (fresh) bustCache(CACHE_KEY);
    const data = await swr(CACHE_KEY, 20_000, computeDashboard);
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
  // Karta sığmayan satırlar TÜRE GÖRE ayrılır: "stoğu biten" kısmının Ürünler'de doğru bir
  // karşılığı var (filter=out-of-stock), "stoğu 1 kalan" kısmının YOK. Tek sayı gönderilseydi
  // kart yine boş açılan bir bağlantı kurardı.
  const lowStockHidden = lowStockProducts.slice(LOW_STOCK_LIMIT);
  const lowStockMoreOutOfStock = lowStockHidden.filter((p) => p.stock === 0).length;

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
  // Taşan satırların TÜR DAĞILIMI: kart "+N satır daha" derken hangi listeye götüreceğini
  // buradan bilir. Toplam sayılar (negatif/maliyet-eksik) taşan kümeyi temsil etmiyordu:
  // 12 zarar + 50 maliyet-eksik varken "+32" deyip 12 kayıtlık listeyi açıyordu.
  const problemHidden = problemProducts.slice(PROBLEM_LIMIT);
  const problemMoreNegative = problemHidden.filter((p) => p.problem === "negative_profit").length;

  return {
    // Bu gövdenin HESAPLANDIĞI an. Panel tazelik satırını bundan yazar: yanıt diskteki
    // kopyadan da dönebildiği için "isteğin geldiği an" bir haftalık veriyi taze gösteriyordu.
    computedAt: new Date().toISOString(),
    totalProducts,
    inStockCount,
    outOfStockCount,
    lowStockCount,
    lowStockProducts: lowStockShown,
    lowStockShown: lowStockShown.length,
    lowStockMore: lowStockHidden.length,
    lowStockMoreOutOfStock,
    lowStockMoreLow: lowStockHidden.length - lowStockMoreOutOfStock,
    missingCost,
    negativeListings: totalNegativeListings,
    grandTotalProfit,
    platforms: Object.values(platformStats),
    problemProducts: problemShown,
    problemTotal: problemProducts.length,
    problemShown: problemShown.length,
    problemMore: problemHidden.length,
    problemMoreNegative,
    problemMoreMissingCost: problemHidden.length - problemMoreNegative,
    problemNegativeCount: totalNegativeListings,
    problemMissingCostCount: missingCost,
  };
}
