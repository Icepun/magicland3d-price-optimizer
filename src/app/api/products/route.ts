import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findCommissionRule } from "@/core/commission-calculator";
import { withProductCommissionRule, resolveListingCommissionOverride } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";
import { simulatePrice, trendyolMinQty } from "@/core/pricing-engine";
import { resolveProductCost } from "@/core/product-cost";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
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
  platform: "shopify" | "trendyol";
  listingId: string;
  salePrice: number;
  stock: number;
  netProfit: number | null;
  profitMargin: number | null;
  commissionMissing: boolean;
  minOrderQty?: number;
}

export async function GET(req: NextRequest) {
  await ensureRuntimeSchema();

  const { searchParams } = new URL(req.url);
  const filter = searchParams.get("filter") ?? "active";
  const search = searchParams.get("search");
  const platformFilter = searchParams.get("platform"); // shopify | trendyol

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
    where.hidden = false;
    if (filter === "active") {
      where.isActive = true;
    } else if (filter === "out-of-stock") {
      where.isActive = true;
      where.stock = 0;
    } else if (filter === "inactive") {
      where.isActive = false;
    } else if (filter === "negative-profit" || filter === "missing-cost") {
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
        variantGroup: { select: { id: true, name: true } },
      },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(lite);
  }

  const [products, commissionRules, cargoRules, expenseRules, settings] =
    await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          cost: { include: { filamentType: { select: { costPerGram: true } } } },
          listings: true,
          variantGroup: { select: { id: true, name: true } },
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
  const vatRate = Number(settingsMap.vatRate ?? 0);

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

    // Her listing için ayrı kâr hesabı (platform-specific override'lar dahil)
    const platformSummaries: PlatformSummary[] = product.listings
      .filter((l) => !platformFilter || l.platform === platformFilter)
      .map((listing) => {
        if (productCost <= 0) {
          return {
            platform: listing.platform as PlatformSummary["platform"],
            listingId: listing.id,
            salePrice: listing.salePrice,
            stock: listing.stock,
            netProfit: null,
            profitMargin: null,
            commissionMissing: false,
          };
        }

        const sim = simulatePrice({
          salePrice: listing.salePrice,
          productCost,
          packagingCost,
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
        });

        // Trendyol/Hepsiburada'da komisyon kaynağı yoksa uyar (override yok + kural eşleşmedi)
        const commissionMissing =
          (listing.platform === "trendyol" || listing.platform === "hepsiburada") &&
          listing.commissionRate == null &&
          !sim.appliedCommissionRule;

        return {
          platform: listing.platform as PlatformSummary["platform"],
          listingId: listing.id,
          salePrice: listing.salePrice,
          stock: listing.stock,
          netProfit: sim.netProfit,
          profitMargin: sim.profitMargin,
          commissionMissing,
          minOrderQty: sim.minOrderQty, // Trendyol >1 → liste "×N" rozeti gösterir
        };
      });

    // Ana ürünün "current" kar/zararı: ürünün kendi currentSalePrice'ı kullanılır (no listing varsa)
    let currentNetProfit: number | null = null;
    let currentProfitMargin: number | null = null;
    if (productCost > 0) {
      const sim = simulatePrice({
        salePrice: product.currentSalePrice,
        productCost,
        packagingCost,
        categoryName: product.categoryName,
        desi: product.desi ?? 1,
        commissionRules: productRules,
        cargoRules: cargoRules as Parameters<typeof simulatePrice>[0]["cargoRules"],
        expenseRules: expenseRules as Parameters<typeof simulatePrice>[0]["expenseRules"],
        vatRate,
      });
      currentNetProfit = sim.netProfit;
      currentProfitMargin = sim.profitMargin;
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
      hasCost: productCost > 0,
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

  return NextResponse.json(filtered);
}

export async function POST(req: NextRequest) {
  await ensureRuntimeSchema();
  const body = await req.json();
  const data = CreateProductSchema.parse(body);
  const product = await prisma.product.create({ data });
  return NextResponse.json(product, { status: 201 });
}
