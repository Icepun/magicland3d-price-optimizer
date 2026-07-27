import { batch } from "@/lib/turso";
import type { ProductDetail, ListingRow, ProductCostRow } from "@/lib/db/product-detail";

interface ProductCostFlat extends ProductCostRow {
  productId: string;
  hasCost: number;
}

/**
 * Dashboard için TÜM aktif ürünleri + maliyet + listing'leri TOPLU çeker (2 statement, 1 round-trip).
 * Per-ürün getProductDetail çağırmak yerine bulk — 421 ürün için tek round-trip seti.
 */
export async function getDashboardData(): Promise<ProductDetail[]> {
  // UI listeleri: yalnız görünür ürünler + AKTİF listing'ler (pasif listing için kâr hesaplanmaz).
  // Artık ayrı sorgu ATMIYOR: eşleştirme üst kümesini paylaşıp istemcide filtreliyor
  // (eskiden aynı 425 ürün + 732 listing telefona İKİ KEZ iniyordu).
  const all = await fetchSuperset();
  return all
    .filter((p) => p._active && !p._hidden)
    .map((p) => ({ ...p, listings: p.listings.filter((l) => Number(l.isActive ?? 1) !== 0) }));
}

/**
 * Sipariş EŞLEŞTİRME haritası için ürünler — masaüstü orders route ile birebir: görünürlük
 * filtresi YOK (gizli/pasif ürün + pasif listing dahil; route.ts:490-501 filtresiz tarar).
 * Gerekçe: satılmış bir ürünü sonradan gizlemek/pasifleştirmek eski siparişleri "eşleşmedi"ye
 * düşürüp kâr toplamını masaüstünden saptırıyordu. UI listeleri bu seti GÖSTERMEZ.
 */
export async function getOrderMatchProducts(): Promise<ProductDetail[]> {
  return fetchSuperset();
}

/** Filtresiz ürün+listing üst kümesi — kısa ömürlü paylaşım.
 *  Panel/Ürünler ["dashboard-data"] ve Siparişler ["match-products"] farklı React Query
 *  anahtarları olduğu için aynı veriyi iki kez indiriyordu; bu tampon ikisini tek çekimde
 *  birleştirir (React Query önbellekleri ayrı kalmaya devam eder). */
const SUPERSET_TTL_MS = 30_000;
let supersetCache: { at: number; promise: Promise<SupersetProduct[]> } | null = null;

function fetchSuperset(): Promise<SupersetProduct[]> {
  if (supersetCache && Date.now() - supersetCache.at < SUPERSET_TTL_MS) {
    return supersetCache.promise;
  }
  const attempt = fetchProductSet("", "").catch((error) => {
    if (supersetCache?.promise === attempt) supersetCache = null; // hata önbelleklenmesin
    throw error;
  });
  supersetCache = { at: Date.now(), promise: attempt };
  return attempt;
}

type SupersetProduct = ProductDetail & { _active: boolean; _hidden: boolean };

async function fetchProductSet(productWhere: string, listingWhere: string): Promise<SupersetProduct[]> {
  const [prodRes, listRes] = await batch([
    {
      sql: `SELECT p.id, p.name, p.alias, p.sku, p.barcode, p.categoryName, p.currentSalePrice,
                   p.stock, p.desi, p.imageUrl, p.source, p.madeToOrder, p.commissionRate,
                   p.isActive AS pIsActive, p.hidden AS pHidden,
                   p.variantGroupId, p.variantLabel, vg.name AS variantGroupName,
                   pc.productId AS hasCost, pc.costMode, pc.manualCost, pc.totalCost, pc.packagingCost,
                   pc.filamentTypeId, pc.filamentWeight, pc.printTimeHours, pc.wasteRate,
                   pc.packagingOptionId, pc.nylonLevel, pc.tapeUsed,
                   COALESCE(ft.costPerGram, 0) AS costPerGram
              FROM Product p
              LEFT JOIN ProductCost pc ON pc.productId = p.id
              LEFT JOIN FilamentType ft ON ft.id = pc.filamentTypeId
              LEFT JOIN VariantGroup vg ON vg.id = p.variantGroupId
             ${productWhere}`,
    },
    {
      sql: `SELECT id, productId, platform, salePrice, stock, commissionRate,
                   commissionFixed, cargoCost, externalId, externalSku, barcode, isActive
              FROM Listing ${listingWhere}`,
    },
  ]);

  const byProduct = new Map<string, ListingRow[]>();
  for (const row of listRes.rows as unknown as (ListingRow & { productId: string })[]) {
    const arr = byProduct.get(row.productId) ?? [];
    arr.push(row);
    byProduct.set(row.productId, arr);
  }

  return (prodRes.rows as unknown as (ProductDetail & ProductCostFlat)[]).map((p) => ({
    id: p.id,
    name: p.name,
    alias: p.alias,
    sku: p.sku,
    barcode: p.barcode,
    categoryName: p.categoryName,
    currentSalePrice: p.currentSalePrice,
    stock: p.stock,
    desi: p.desi,
    imageUrl: p.imageUrl,
    source: p.source,
    madeToOrder: p.madeToOrder,
    commissionRate: p.commissionRate,
    variantGroupId: p.variantGroupId,
    variantLabel: p.variantLabel,
    variantGroupName: p.variantGroupName ?? null,
    // Görünürlük bayrakları — üst kümeden istemci tarafı filtrelemek için taşınır (aşağıya bak).
    _active: Number((p as unknown as { pIsActive?: unknown }).pIsActive ?? 1) !== 0,
    _hidden: Number((p as unknown as { pHidden?: unknown }).pHidden ?? 0) !== 0,
    cost: p.hasCost
      ? {
          costMode: p.costMode,
          manualCost: p.manualCost,
          totalCost: p.totalCost,
          packagingCost: p.packagingCost,
          filamentTypeId: p.filamentTypeId,
          filamentWeight: p.filamentWeight,
          printTimeHours: p.printTimeHours,
          wasteRate: p.wasteRate,
          packagingOptionId: p.packagingOptionId,
          nylonLevel: p.nylonLevel,
          tapeUsed: p.tapeUsed,
          costPerGram: p.costPerGram,
        }
      : null,
    listings: byProduct.get(p.id) ?? [],
  }));
}
