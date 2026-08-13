/**
 * TEORİK ÜRÜN KÂRLILIĞI — Raporlar'ın "Ürün Kârlılığı" kartının veri kaynağı.
 *
 * NEDEN AYRI BİR OKUMA:
 * Raporlar bu kartı doldurmak için `/api/products?filter=active` çağırıyordu. Ekranda yalnız
 * 12 satır görünüyor, ama yanıt 372 ürünün TAM kaydını taşıyordu (ölçüldü: 536.058 bayt,
 * soğukta 1,06 sn). Kartın ihtiyacı olan bilgi ~4 KB: en kârlı 6, zarar eden 6 ve maliyeti
 * girilmemiş ürün sayısı. Burada aynı hesap yapılır, yalnız o satırlar döner.
 *
 * ⚠️ RAKAM AYNI KALMALI: kâr hesabı `simulatePrice` çekirdeğinin ta kendisiyle, Ürünler
 * ekranıyla BİREBİR aynı girdilerle yapılır (aynı maliyet çözümü, aynı komisyon/kargo/gider
 * kuralı süzgeci, aynı "birincil platform" seçimi). Burada yeni bir formül YOKTUR.
 *
 * Ürünler rotasındaki eşik taraması ("küçük zam, büyük kazanç") burada YOK: o hesap ürün
 * başına birkaç ek simülasyon demek ve bu kartta hiç gösterilmiyor.
 */
import { prisma } from "@/lib/prisma";
import { vatRateOf } from "@/core/vat";
import {
  resolveListingCommissionOverride,
  withProductCommissionRule,
} from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";
import { simulatePrice, trendyolMinQty } from "@/core/pricing-engine";
import { packagingScopeInput, resolveProductCost } from "@/core/product-cost";

export interface ProfitabilityRow {
  id: string;
  name: string;
  imageUrl: string | null;
  /** BİLİNMEYEN ≠ SIFIR: maliyeti girilmemiş üründe null kalır. */
  netProfit: number | null;
  profitMargin: number | null;
}

export interface ProductProfitability {
  /** En kârlı ürünler (çoktan aza). */
  leaders: ProfitabilityRow[];
  /** Zarar edenler (en çok zarardan aza). */
  losers: ProfitabilityRow[];
  /** Maliyeti girilmediği için listeye hiç giremeyen ürün sayısı. */
  missingCostProducts: number;
  /** Kârı hesaplanabilen ürün sayısı. */
  countedProducts: number;
}

/** Listeye giren ürün sayısı — kart altı bir avuç satır gösteriyor. */
const LIST_LIMIT = 6;

/**
 * Hesaplanmış satırlardan iki listeyi ve sayaçları çıkar (SAF).
 *
 * Sıralama ve eleme kuralları ekranın kendi kuralları; veritabanı olmadan test edilebilsin
 * diye ayrı durur.
 */
export function pickProfitLists(
  rows: Array<ProfitabilityRow & { hasCost: boolean }>,
  limit = LIST_LIMIT
): ProductProfitability {
  const priced = rows.filter((row) => row.hasCost && row.netProfit != null);
  const leaders = [...priced]
    .sort((a, b) => (b.netProfit ?? 0) - (a.netProfit ?? 0))
    .slice(0, limit);
  const losers = priced
    .filter((row) => (row.netProfit ?? 0) < 0)
    .sort((a, b) => (a.netProfit ?? 0) - (b.netProfit ?? 0))
    .slice(0, limit);
  const strip = ({ id, name, imageUrl, netProfit, profitMargin }: ProfitabilityRow) => ({
    id,
    name,
    imageUrl,
    netProfit,
    profitMargin,
  });
  return {
    leaders: leaders.map(strip),
    losers: losers.map(strip),
    missingCostProducts: rows.reduce((count, row) => (row.hasCost ? count : count + 1), 0),
    countedProducts: priced.length,
  };
}

/**
 * Aktif (gizlenmemiş) ürünlerin bugünkü fiyat ve maliyetle teorik kârı.
 *
 * Beş okuma yapar (ürünler + komisyon/kargo/gider kuralları + ayarlar) — Ürünler rotasının
 * soğukta yaptığı okumaların aynısı.
 *
 * ⚠️ ÖLÇÜM DÜRÜSTLÜĞÜ: kazanç YALNIZ indirilen bayttadır (536 KB → ~3 KB). Sunucudaki beş okuma
 * ve ürün başına simülasyon aynı kaldı, üstelik bu gövde `products:v2:filter=active` ile
 * paylaşılmadığı için kâr girdisi değişince aynı hesap iki ayrı önbellek girdisi için iki kez
 * yapılır. Bir sonraki tur bu maliyeti bilerek taşısın: istenirse iki gövde tek okumadan
 * türetilebilir.
 */
export async function readProductProfitability(): Promise<ProductProfitability> {
  const [products, commissionRules, cargoRules, expenseRules, settings] = await Promise.all([
    prisma.product.findMany({
      where: { isActive: true, hidden: false },
      include: {
        cost: { include: { filamentType: { select: { costPerGram: true } } } },
        // Yalnız AKTİF ilanlar — Ürünler ekranı da böyle davranıyor; aksi hâlde aynı ürün iki
        // yüzeyde farklı kâr gösterirdi.
        listings: {
          where: { isActive: true },
          select: {
            id: true,
            platform: true,
            salePrice: true,
            commissionRate: true,
            commissionFixed: true,
            cargoCost: true,
          },
        },
      },
      // Kârı BİREBİR aynı olan ürünler var (aynı kalıbın renk varyantları). Sıralama Ürünler
      // ekranıyla aynı olsun ki iki yüzey eşitlikte farklı ürünü öne almasın.
      orderBy: { updatedAt: "desc" },
    }),
    prisma.commissionRule.findMany({
      where: { isActive: true },
      orderBy: [{ priority: "desc" }, { name: "asc" }],
    }),
    prisma.cargoRule.findMany({ where: { isActive: true } }),
    prisma.expenseRule.findMany({ where: { isActive: true } }),
    prisma.appSetting.findMany(),
  ]);

  const settingsMap = Object.fromEntries(settings.map((row) => [row.key, row.value]));
  const vatRate = vatRateOf(settingsMap);
  type CargoRuleInput = Parameters<typeof simulatePrice>[0]["cargoRules"];
  type ExpenseRuleInput = Parameters<typeof simulatePrice>[0]["expenseRules"];

  const rows = products.map((product) => {
    const productRules = withProductCommissionRule(product, commissionRules);
    const resolved = resolveProductCost(
      product.cost,
      settingsMap,
      product.cost?.filamentType?.costPerGram ?? 0
    );
    const productCost = resolved?.productionCost ?? 0;
    const packagingCost = resolved?.packagingCost ?? 0;
    // Paketleme her ürüne otomatik eklendiği için `totalCost` asla 0 olmuyor → bilinirlik
    // kararı ÜRETİM payına bakar (bkz. core/product-cost.ts productionCostKnown).
    const hasCost = resolved?.productionCostKnown ?? false;
    const filamentMatCost = resolved?.filamentCost ?? 0;

    const base = {
      id: product.id,
      name: product.name,
      imageUrl: product.imageUrl,
      netProfit: null as number | null,
      profitMargin: null as number | null,
      hasCost,
    };
    if (!hasCost) return base;

    const simulate = (
      platform: string,
      listing: {
        commissionRate: number | null;
        commissionFixed: number | null;
        cargoCost: number | null;
      } | null,
      price: number
    ) =>
      simulatePrice({
        salePrice: price,
        productCost,
        packagingCost,
        ...packagingScopeInput(resolved),
        categoryName: product.categoryName,
        desi: product.desi ?? 1,
        commissionRules: productRules,
        cargoRules: filterCargoRulesByPlatform(cargoRules as CargoRuleInput, platform),
        expenseRules: filterRulesByPlatform(expenseRules as ExpenseRuleInput, platform),
        vatRate,
        ...resolveListingCommissionOverride(
          {
            platform,
            commissionRate: listing?.commissionRate ?? null,
            commissionFixed: listing?.commissionFixed ?? null,
          },
          settingsMap
        ),
        // Shopify sepet alt sınırı 150₺ → altındaki ürün tek başına satılamaz, kargo paylaşılır.
        cargoCostOverride:
          listing?.cargoCost ?? (platform === "shopify" && price < 150 ? 0 : undefined),
        minOrderQty: platform === "trendyol" ? trendyolMinQty(price) : 1,
        vatableProductCost: filamentMatCost,
      });

    // Rapor metriği TEK bir gerçek platform sonucundan gelir; platform kurallarını birbirine
    // karıştırmak bir platformun kargosunu diğerinin ürününe uygulardı.
    const preferred = [product.source, "shopify", "trendyol", "hepsiburada"];
    for (const platform of preferred) {
      const listing = product.listings.find((row) => row.platform === platform);
      if (!listing) continue;
      const sim = simulate(platform, listing, listing.salePrice);
      if (sim.netProfit == null) continue;
      return { ...base, netProfit: sim.netProfit, profitMargin: sim.profitMargin };
    }

    // Hiç aktif ilan yok → ürünün kendi satış fiyatıyla, kaynağının platform kurallarıyla.
    const fallback =
      product.source === "trendyol" ||
      product.source === "hepsiburada" ||
      product.source === "shopify"
        ? product.source
        : "shopify";
    const sim = simulate(fallback, null, product.currentSalePrice);
    return { ...base, netProfit: sim.netProfit, profitMargin: sim.profitMargin };
  });

  return pickProfitLists(rows);
}
