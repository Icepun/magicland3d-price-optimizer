import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findCommissionRule } from "@/core/commission-calculator";
import { withProductCommissionRule, resolveListingCommissionOverride } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";
import { simulatePrice } from "@/core/pricing-engine";
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
}

export async function GET(req: NextRequest) {
  await ensureRuntimeSchema();

  const { searchParams } = new URL(req.url);
  const filter = searchParams.get("filter") ?? "active";
  const search = searchParams.get("search");
  const platformFilter = searchParams.get("platform"); // shopify | trendyol

  const where: Record<string, unknown> = {};
  // Tüm ürünler düz olarak döner; varyant grubu üyeleri istemci tarafında tek satırda
  // toplanır (her ürün kendi variantGroup bilgisini taşır).

  if (filter === "hidden") {
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

  const [products, commissionRules, cargoRules, expenseRules, settings] =
    await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          cost: { include: { filamentType: true } },
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
          cargoCostOverride: listing.cargoCost ?? undefined,
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

    return {
      ...product,
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
    // Local stok bazında (Shopify/platform stoğu değil)
    filtered = filtered.filter((p) => p.stock === 0);
  }

  if (platformFilter) {
    filtered = filtered.filter((p) =>
      p.platforms.some((pl) => pl.platform === platformFilter)
    );
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
