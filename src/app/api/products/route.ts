import { bustProductCaches } from "@/lib/cache-busting";
import { vatRateOf } from "@/core/vat";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findCommissionRule } from "@/core/commission-calculator";
import { withProductCommissionRule, resolveListingCommissionOverride } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";
import { simulatePrice, trendyolMinQty } from "@/core/pricing-engine";
import { packagingScopeInput, resolveProductCost } from "@/core/product-cost";
import { collectRulePriceBreakpoints } from "@/core/price-target";
import {
  chooseThresholdHint,
  perUnitRatio,
  thresholdCandidatePrices,
} from "@/lib/product-metrics";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { swr } from "@/lib/route-cache";
import { jsonError } from "@/lib/api-error";
import { z } from "zod";

const CreateProductSchema = z.object({
  barcode: z.string().min(1),
  sku: z.string().min(1),
  name: z.string().min(1),
  categoryName: z.string().min(1),
  currentSalePrice: z.number().positive(),
  listPrice: z.number().positive().optional(),
  stock: z.number().int().min(0).default(0),
  desi: z.number().positive().optional(),
  weight: z.number().positive().optional(),
  isActive: z.boolean().default(true),
});

interface PlatformSummary {
  platform: "shopify" | "trendyol" | "hepsiburada";
  listingId: string;
  salePrice: number;
  stock: number;
  netProfit: number | null;
  profitMargin: number | null;
  commissionMissing: boolean;
  /** Hiçbir kargo bareni eşleşmedi ve elle kargo da girilmemiş → kargo ₺0 sayıldı. */
  cargoMissing: boolean;
  minOrderQty?: number;
}

/** "Küçük zam, büyük kazanç" önerisi — kural bandı lehe dönen ilk kırılım noktası. */
interface PriceThresholdSummary {
  platform: string;
  currentPrice: number;
  targetPrice: number;
  currentProfit: number;
  targetProfit: number;
  gain: number;
}

// Sarmalanmamış rota GÖVDESİZ 500 döndürür: liste boş gelir, ekranda "Ürünler yüklenemedi"
// yazar ve nedenini kimse göremez. jsonError hatayı okunur bir gövdeye çevirir.
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const cacheable =
      !url.searchParams.has("ids") &&
      !url.searchParams.has("search") &&
      !url.searchParams.has("lite");

    const data = cacheable
      ? await swr(
          `products:v1:${url.searchParams.toString()}`,
          2 * 60_000,
          () => computeProducts(req.url)
        )
      : await computeProducts(req.url);
    return NextResponse.json(data);
  } catch (error) {
    return jsonError(error);
  }
}

async function computeProducts(urlString: string) {
  await ensureRuntimeSchema();

  const { searchParams } = new URL(urlString);
  const filter = searchParams.get("filter") ?? "active";
  const search = searchParams.get("search");
  const platformFilter = searchParams.get("platform"); // shopify | trendyol
  // Gizli ürünler listelerin dışındadır; hızlı arama (Ctrl+K) ise hepsini ister:
  // satıştan kaldırılmış bir ürünün maliyetine bakmak da bir arama sebebidir.
  const includeHidden = searchParams.get("includeHidden") === "1";

  // TEKİL/ÇOKLU ürün tazeleme: ?ids=a,b,c → SADECE bu ürünler, filtreden bağımsız hesaplanıp döner.
  // Amaç: bir ürünün maliyeti/listing'i değişince TÜM 368 ürünü değil yalnız o ürünü çekmek
  // (minimum DB okuma → donma yok). İstemci sonucu ["products"] cache'ine yamalar.
  const idsParam = searchParams.get("ids");
  const idList = idsParam ? idsParam.split(",").map((s) => s.trim()).filter(Boolean) : null;

  const where: Record<string, unknown> = {};
  // Tüm ürünler düz olarak döner; varyant grubu üyeleri istemci tarafında tek satırda
  // toplanır (her ürün kendi variantGroup bilgisini taşır).

  if (idList) {
    where.id = { in: idList };
  } else if (filter === "hidden") {
    // Sadece gizlenmiş ürünler
    where.hidden = true;
  } else {
    // Diğer tüm görünümler gizli ürünleri hariç tutar
    if (!includeHidden) where.hidden = false;
    if (filter === "active") {
      where.isActive = true;
    } else if (filter === "out-of-stock") {
      where.isActive = true;
      where.stock = 0;
    } else if (filter === "inactive") {
      where.isActive = false;
    } else if (
      filter === "negative-profit" ||
      filter === "missing-cost" ||
      filter === "missing-desi"
    ) {
      where.isActive = true;
    }
  }

  if (search) {
    where.OR = [
      { name: { contains: search } },
      { barcode: { contains: search } },
      { sku: { contains: search } },
      { categoryName: { contains: search } },
    ];
  }

  // LITE mod (varyant seçici vb.): kâr hesabı YOK → 368 ürün için ağır simülasyon + büyük
  // cache nesnesi oluşmaz. Sadece liste/seçim için gereken küçük alanlar döner.
  if (searchParams.get("lite")) {
    const lite = await prisma.product.findMany({
      where,
      select: {
        id: true,
        name: true,
        alias: true,
        imageUrl: true,
        currentSalePrice: true,
        // Barkod/stok kodu ve varyant etiketi olmadan hızlı arama okuduğu listede
        // barkod eşleşmesi bulamıyor, her tuşta sunucuya sorup uygulamayı bekletiyordu.
        // Satır sayısı aynı, yalnız birkaç küçük kolon eklendi.
        barcode: true,
        sku: true,
        variantLabel: true,
        isActive: true,
        hidden: true,
        variantGroup: { select: { id: true, name: true } },
      },
      orderBy: { name: "asc" },
    });
    return lite;
  }

  const [products, commissionRules, cargoRules, expenseRules, settings] =
    await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          cost: { include: { filamentType: { select: { costPerGram: true } } } },
          // Yalnız AKTİF listing'ler: satışı durmuş (pasif) bir listing için kâr/marj
          // hesaplanmaz. Panel (dashboard route) ve mobil zaten böyle davranıyordu; Ürünler
          // ekranı tek istisnaydı → aynı ürün iki yüzeyde farklı kâr gösteriyordu.
          // NOT: sipariş kârı hattı (api/orders) listing'leri FİLTRELEMEZ — eski bir sipariş,
          // ürün sonradan pasifleşse de "eşleşmedi"ye düşmemeli.
          // Yanıta konmayan bu kayıtlardan yalnız kâr hesabının kullandığı alanlar okunur.
          listings: {
            where: { isActive: true },
            select: {
              id: true,
              platform: true,
              salePrice: true,
              stock: true,
              commissionRate: true,
              commissionFixed: true,
              cargoCost: true,
            },
          },
          // _count: grubun TAM varyant sayısı. Liste bir grubun yalnız bir kısmını gösterdiğinde
          // (arama, "Zarar Eden", "Maliyet Eksik" …) grup satırı "5 / 8 varyant" yazabilsin;
          // aksi halde kullanıcı 5 varyantlık bir grup görüyor sanıyordu.
          variantGroup: {
            select: {
              id: true,
              name: true,
              // Sayım listeyle AYNI kapsamı kullanmalı: liste varsayılan olarak gizli/pasif
              // ürünleri elediği için filtresiz `_count`, hiçbir filtre açık değilken bile
              // kalıcı "2 / 3 varyant" rozeti üretiyordu.
              _count: { select: { products: { where: { isActive: true, hidden: false } } } },
            },
          },
        },
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

  const settingsMap = Object.fromEntries(
    settings.map((s) => [s.key, s.value])
  );
  const vatRate = vatRateOf(settingsMap);

  const productsWithProfit = products.map((product) => {
    const productRules = withProductCommissionRule(product, commissionRules);
    const rule = findCommissionRule(
      productRules,
      product.currentSalePrice,
      product.categoryName
    );

    // Maliyeti güncel ayarlardan yeniden hesapla (zam otomatik yansır)
    const resolved = resolveProductCost(
      product.cost,
      settingsMap,
      product.cost?.filamentType?.costPerGram ?? 0
    );
    const productCost = resolved?.productionCost ?? 0;
    const packagingCost = resolved?.packagingCost ?? 0;
    // Paketleme her ürüne otomatik eklendiği için totalCost asla 0 olmuyor → bilinirlik
    // kararı ÜRETİM payına bakmalı (bkz. product-cost.ts productionCostKnown).
    const hasCost = resolved?.productionCostKnown ?? false;
    const filamentMatCost = resolved?.filamentCost ?? 0; // KDV iadesine giren malzeme payı

    // "Ya fiyat şu olsaydı?" sorusunu SORMAK için motoru aynı girdilerle yeniden çağıran yardımcı.
    // Aşağıdaki mevcut kâr hesaplarının girdileriyle BİREBİR aynıdır; formüle dokunmaz, yalnızca
    // farklı bir satış fiyatı verir (eşik önerisi bunu kullanır).
    const simulateAtPrice = (
      platform: string,
      listing: { commissionRate: number | null; commissionFixed: number | null; cargoCost: number | null } | null,
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
        cargoRules: filterCargoRulesByPlatform(
          cargoRules as Parameters<typeof simulatePrice>[0]["cargoRules"],
          platform
        ),
        expenseRules: filterRulesByPlatform(
          expenseRules as Parameters<typeof simulatePrice>[0]["expenseRules"],
          platform
        ),
        vatRate,
        ...resolveListingCommissionOverride(
          {
            platform,
            commissionRate: listing?.commissionRate ?? null,
            commissionFixed: listing?.commissionFixed ?? null,
          },
          settingsMap
        ),
        cargoCostOverride:
          listing?.cargoCost ?? (platform === "shopify" && price < 150 ? 0 : undefined),
        minOrderQty: platform === "trendyol" ? trendyolMinQty(price) : 1,
        vatableProductCost: filamentMatCost,
      });

    // Her listing için ayrı kâr hesabı (platform-specific override'lar dahil)
    const platformSummaries: PlatformSummary[] = product.listings
      .filter((l) => !platformFilter || l.platform === platformFilter)
      .map((listing) => {
        if (!hasCost) {
          return {
            platform: listing.platform as PlatformSummary["platform"],
            listingId: listing.id,
            salePrice: listing.salePrice,
            stock: listing.stock,
            netProfit: null,
            profitMargin: null,
            commissionMissing: false,
            cargoMissing: false,
          };
        }

        const sim = simulatePrice({
          salePrice: listing.salePrice,
          productCost,
          packagingCost,
          ...packagingScopeInput(resolved),
          categoryName: product.categoryName,
          desi: product.desi ?? 1,
          commissionRules: productRules,
          cargoRules: filterCargoRulesByPlatform(
            cargoRules as Parameters<typeof simulatePrice>[0]["cargoRules"],
            listing.platform
          ),
          expenseRules: filterRulesByPlatform(
            expenseRules as Parameters<typeof simulatePrice>[0]["expenseRules"],
            listing.platform
          ),
          vatRate,
          ...resolveListingCommissionOverride(listing, settingsMap),
          // Shopify sepet min 150₺ → <150₺ ürün tek başına satılamaz, kargo paylaşılır → katma (0).
          cargoCostOverride:
            listing.cargoCost ??
            (listing.platform === "shopify" && listing.salePrice < 150 ? 0 : undefined),
          // Trendyol min sipariş adedi → kâr N-adetlik sipariş üzerinden (fiyattan otomatik).
          minOrderQty: listing.platform === "trendyol" ? trendyolMinQty(listing.salePrice) : 1,
          vatableProductCost: filamentMatCost,
        });

        // Trendyol/Hepsiburada'da komisyon kaynağı yoksa uyar (override yok + kural eşleşmedi)
        const commissionMissing =
          (listing.platform === "trendyol" || listing.platform === "hepsiburada") &&
          listing.commissionRate == null &&
          !sim.appliedCommissionRule;

        // Kargo kaynağı yoksa uyar. Komisyonda bu uyarı VARDI, kargoda YOKTU: hiçbir barem
        // eşleşmediğinde kargo sessizce ₺0 sayılıyor ve kâr 100₺'ye kadar şişik görünüyordu.
        // Shopify'da 150₺ altı kargonun 0 olması BİLİNÇLİ bir kural — o durum uyarı değildir.
        const cargoMissing =
          listing.cargoCost == null &&
          !(listing.platform === "shopify" && listing.salePrice < 150) &&
          !sim.appliedCargoRule;

        return {
          platform: listing.platform as PlatformSummary["platform"],
          listingId: listing.id,
          salePrice: listing.salePrice,
          stock: listing.stock,
          netProfit: sim.netProfit,
          profitMargin: sim.profitMargin,
          commissionMissing,
          cargoMissing,
          minOrderQty: sim.minOrderQty, // Trendyol >1 → liste "×N" rozeti gösterir
        };
      });

    // Rapor metriği tek bir gerçek platform sonucundan gelir; platform kurallarını birbirine
    // karıştırmak TEX kargosunu Shopify ürününe uygulayabiliyordu.
    let currentNetProfit: number | null = null;
    let currentProfitMargin: number | null = null;
    // Kâr hangi platformun hangi fiyatından geldi? Kâr/saat ve eşik önerisi aynı sonucu bölmek /
    // karşılaştırmak zorunda — yoksa iki rakam farklı platformları anlatır.
    let profitBasis: {
      platform: string;
      listing: { commissionRate: number | null; commissionFixed: number | null; cargoCost: number | null } | null;
      price: number;
      orderQty: number;
    } | null = null;
    if (hasCost) {
      const preferredPlatforms = [
        product.source,
        "shopify",
        "trendyol",
        "hepsiburada",
      ];
      const primary = preferredPlatforms
        .map((platform) => platformSummaries.find((summary) => summary.platform === platform))
        .find((summary) => summary?.netProfit != null);
      if (primary) {
        currentNetProfit = primary.netProfit;
        currentProfitMargin = primary.profitMargin;
        const primaryListing = product.listings.find((l) => l.id === primary.listingId) ?? null;
        profitBasis = {
          platform: primary.platform,
          listing: primaryListing,
          price: primary.salePrice,
          orderQty: primary.minOrderQty ?? 1,
        };
      } else {
        const fallbackPlatform =
          platformFilter === "trendyol" ||
          platformFilter === "hepsiburada" ||
          platformFilter === "shopify"
            ? platformFilter
            : product.source === "trendyol" ||
                product.source === "hepsiburada" ||
                product.source === "shopify"
              ? product.source
              : "shopify";
        const sim = simulatePrice({
          salePrice: product.currentSalePrice,
          productCost,
          packagingCost,
          ...packagingScopeInput(resolved),
          categoryName: product.categoryName,
          desi: product.desi ?? 1,
          commissionRules: productRules,
          cargoRules: filterCargoRulesByPlatform(
            cargoRules as Parameters<typeof simulatePrice>[0]["cargoRules"],
            fallbackPlatform
          ),
          expenseRules: filterRulesByPlatform(
            expenseRules as Parameters<typeof simulatePrice>[0]["expenseRules"],
            fallbackPlatform
          ),
          vatRate,
          ...resolveListingCommissionOverride(
            {
              platform: fallbackPlatform,
              commissionRate: null,
              commissionFixed: null,
            },
            settingsMap
          ),
          cargoCostOverride:
            fallbackPlatform === "shopify" && product.currentSalePrice < 150
              ? 0
              : undefined,
          minOrderQty:
            fallbackPlatform === "trendyol"
              ? trendyolMinQty(product.currentSalePrice)
              : 1,
          vatableProductCost: filamentMatCost,
        });
        currentNetProfit = sim.netProfit;
        currentProfitMargin = sim.profitMargin;
        profitBasis = {
          platform: fallbackPlatform,
          listing: null,
          price: product.currentSalePrice,
          orderQty: sim.minOrderQty,
        };
      }
    }

    // ── Kâr/saat ve kâr/gram ────────────────────────────────────────────────────────────────
    // "Şimdi hangi ürünü basayım?" sorusunun cevabı: darboğaz makine saati. Yeni bir kâr hesabı
    // YOK — yukarıda çıkan net kâr, aynı siparişin baskı süresine / filament gramajına bölünür.
    const profitPerHour = perUnitRatio(
      currentNetProfit,
      product.cost?.printTimeHours,
      profitBasis?.orderQty ?? 1
    );
    const profitPerGram = perUnitRatio(
      currentNetProfit,
      product.cost?.filamentWeight,
      profitBasis?.orderQty ?? 1
    );

    // ── Eşik uyarısı: "küçük zam, büyük kazanç" ────────────────────────────────────────────
    // Komisyon/kargo/adet bantlarının kırılım noktaları motorda zaten biliniyor. Fiyat bir bandın
    // hemen altındaysa, o noktadaki kârı AYNI motorla simüle edip farkı gösteririz.
    let priceThreshold: PriceThresholdSummary | null = null;
    if (currentNetProfit != null && profitBasis) {
      const { platform, listing, price, orderQty } = profitBasis;
      const breakpoints = collectRulePriceBreakpoints(
        productRules,
        filterCargoRulesByPlatform(
          cargoRules as Parameters<typeof simulatePrice>[0]["cargoRules"],
          platform
        ),
        filterRulesByPlatform(
          expenseRules as Parameters<typeof simulatePrice>[0]["expenseRules"],
          platform
        )
      );
      // Bantları kurallardan gelmeyen platform eşikleri tamamlar (Fiyat Lab ile aynı liste).
      if (platform === "trendyol") breakpoints.push(25, 35, 50, 75);
      if (platform === "shopify") breakpoints.push(150);

      const candidates = thresholdCandidatePrices(breakpoints, price);
      if (candidates.length > 0) {
        const options = [];
        for (const candidate of candidates) {
          const sim = simulateAtPrice(platform, listing, candidate);
          // Trendyol'da fiyat bandı minimum sipariş adedini de değiştirebiliyor. O durumda iki
          // rakam farklı büyüklükte siparişi anlatır (6 adetlik kâr ↔ 1 adetlik kâr) → kıyaslama
          // yanıltıcı olur, aday elenir.
          if (sim.minOrderQty !== orderQty) continue;
          options.push({ price: candidate, profit: sim.netProfit });
        }
        const hint = chooseThresholdHint(price, currentNetProfit, options);
        if (hint) priceThreshold = { platform, currentPrice: price, ...hint };
      }
    }

    // Payload kırpma (694KB→~yarısı): liste + planner yalnızca aşağıdaki alanları kullanıyor.
    // Ham `listings` (client `platforms` özetini kullanır), tam `cost` objesi ve `filamentType`
    // YANITA KONMAZ — sunucu bunları kâr hesabı için kullandı, göndermeye gerek yok.
    return {
      ...product,
      // YALIN payload (H4): client/planner bu alanları KULLANMAZ → yanıttan düşür
      // (JSON.stringify undefined'ı atar). 312 ürün × birkaç alan = anlamlı boyut tasarrufu.
      listings: undefined,
      weight: undefined,
      trendyolId: undefined,
      productMainId: undefined,
      commissionSource: undefined,
      commissionUpdatedAt: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      cost: product.cost
        ? {
            totalCost: product.cost.totalCost,
            manualCost: product.cost.manualCost,
            packagingCost: product.cost.packagingCost,
            filamentWeight: product.cost.filamentWeight, // planner kullanıyor
          }
        : null,
      // Ham `_count` yerine tek okunur alan: grubun kaç varyantı var (süzülenler dahil).
      variantGroup: product.variantGroup
        ? {
            id: product.variantGroup.id,
            name: product.variantGroup.name,
            variantCount: product.variantGroup._count.products,
          }
        : null,
      appliedCommissionRule: rule
        ? {
            id: rule.id,
            name: rule.name,
            categoryName: rule.categoryName,
            commissionRate: rule.commissionRate,
            fixedCommission: rule.fixedCommission,
          }
        : null,
      currentNetProfit,
      currentProfitMargin,
      /** Net kâr ÷ baskı süresi — makine saati başına kazanç (süre yoksa null). */
      profitPerHour,
      /** Net kâr ÷ filament gramajı — gram başına kazanç (gramaj yoksa null). */
      profitPerGram,
      /** Fiyat bir kural bandının hemen altındaysa: o noktaya çıkmanın kâra etkisi. */
      priceThreshold,
      hasCost,
      // desi = 0 bilerek girilmiş geçerli bir değerdir (çok küçük ürünler) → uyarı verilmez.
      // Sipariş kârı hattı da aynı kuralı uygular; iki ekran farklı uyarı göstermesin.
      missingDesi: product.desi == null || product.desi < 0,
      resolvedTotalCost: resolved?.totalCost ?? null,
      platforms: platformSummaries,
    };
  });

  let filtered = productsWithProfit;
  // ids modu (tekil/çoklu cache patch) → post-filtre YOK: istenen ürünler filtreden bağımsız aynen döner.
  if (!idList) {
    if (filter === "negative-profit") {
      filtered = filtered.filter((p) => {
        if (p.platforms.length > 0) {
          return p.platforms.some((pl) => pl.netProfit !== null && pl.netProfit < 0);
        }
        return p.currentNetProfit !== null && p.currentNetProfit < 0;
      });
    } else if (filter === "missing-cost") {
      filtered = filtered.filter((p) => !p.hasCost);
    } else if (filter === "missing-desi") {
      filtered = filtered.filter((p) => p.missingDesi);
    } else if (filter === "out-of-stock") {
      // Local stok bazında; "sipariş üzerine üretilir" ürünler stok takip etmez → 0 sayılmaz.
      filtered = filtered.filter((p) => p.stock === 0 && !p.madeToOrder);
    }

    if (platformFilter) {
      filtered = filtered.filter((p) =>
        p.platforms.some((pl) => pl.platform === platformFilter)
      );
    }
  }

  return filtered;
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const body = await req.json();
    const data = CreateProductSchema.parse(body);
    const product = await prisma.product.create({ data });
    // Yeni ürün listelerde ve sipariş eşleşmesinde ANINDA görünmeli.
    bustProductCaches();
    return NextResponse.json(product, { status: 201 });
  } catch (error) {
    // Zod hatası 400 + okunur mesaj döner (ör. "Barkod zorunlu") → "Ürün eklenemedi" bilmecesi biter.
    return jsonError(error);
  }
}
