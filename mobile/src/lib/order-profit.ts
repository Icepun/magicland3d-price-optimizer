import { reklamOraniIcin } from "@core/ad-cost";
import { resolveProductCost } from "@core/product-cost";
import { satiriEsle, urunIndeksiKur, type UrunIndeksi } from "@core/order-match";
import { resolveOrderProfit, type OrderProfitLine } from "@core/order-profit";
import {
  satirAnahtari,
  satirMaliyetiHaritaAnahtari,
  satirMaliyetliUrun,
  type SatirMaliyetKaydi,
} from "@core/order-line-cost";

import type { ProductDetail } from "@/lib/db/product-detail";
import { kuralFilamentFiyatlari, type Rules } from "@/lib/profit";
import { isCancelledOrder, type UnifiedOrder } from "@/lib/api/orders";

export interface MatchedProduct {
  imageUrl: string | null;
  name: string;
  detail: ProductDetail;
}

export interface ProductMap {
  byId: Map<string, ProductDetail>;
  /**
   * Eşleştirme indeksi — masaüstü Siparişler ucuyla AYNI kural (`@core/order-match`): anahtar
   * türüne göre güven sırası, belirsiz (birden çok ürüne düşen) anahtar hiç kullanılmaz, anahtar
   * biçimi tek (boşluk/büyük-küçük/Türkçe I). Eski mobil kopya tek haritada "ilk gelen kazanır"
   * diyordu; belirsiz bir barkod yanlış ürünün maliyetiyle kâr hesaplatabilirdi.
   */
  indeks: UrunIndeksi<ProductDetail>;
}

/** Ürün dizisi kimliğine göre harita önbelleği: aynı react-query dizi referansı için harita BİR KEZ
 *  kurulur (Panel + Siparişler + Raporlar + detay aynı ["match-products"] dizisini paylaşır —
 *  eskiden her ekran 424 ürün × ~5 Map insert'i ayrı ayrı tekrarlıyordu). */
const pmCache = new WeakMap<ProductDetail[], ProductMap>();
export function getProductMap(products: ProductDetail[]): ProductMap {
  let pm = pmCache.get(products);
  if (!pm) {
    pm = buildProductMap(products);
    pmCache.set(products, pm);
  }
  return pm;
}

/** Çok-anahtarlı ürün indeksi: Product.barcode/sku + Listing.barcode/externalId/externalSku + ad. */
export function buildProductMap(products: ProductDetail[]): ProductMap {
  const byId = new Map<string, ProductDetail>();
  for (const p of products) byId.set(p.id, p);
  return { byId, indeks: urunIndeksiKur(products, (p) => p) };
}

/** Satır eşleştirme — computeOrderProfit ile AYNI mantık. Sipariş detay ekranı da bunu kullansın
 *  ki "kâr hesaplandı ama satır eşleşmedi" çelişkisi olmasın. */
export function matchOrderLine(
  line: {
    productId?: string | null;
    name: string;
    matchKeys?: string[];
    barcodes?: string[];
    externalIds?: string[];
    skus?: string[];
  },
  platform: UnifiedOrder["platform"],
  pm: ProductMap
): ProductDetail | undefined {
  const p = line.productId ? pm.byId.get(line.productId) : undefined;
  if (p) return p;
  // Türlü anahtar yoksa (eski önbellek kaydı) birleşik liste son çare türsüz aramaya girer.
  const turlu = !!(line.barcodes || line.externalIds || line.skus);
  return (
    satiriEsle(
      pm.indeks,
      {
        name: line.name,
        barcodes: line.barcodes ?? [],
        externalIds: line.externalIds ?? [],
        skus: turlu ? (line.skus ?? []) : (line.matchKeys ?? []),
      },
      platform
    ) ?? undefined
  );
}

/**
 * Bu satıra masaüstünden "siparişe özel maliyet" girilmiş mi? (Masaüstü Siparişler → "Maliyet gir")
 * Satır anahtarı masaüstüyle AYNI: eşleşen üründe ürün kimliği, eşleşmeyende satır adı.
 */
export function ozelMaliyetKaydi(
  order: Pick<UnifiedOrder, "platform" | "id">,
  line: { name: string },
  eslesen: ProductDetail | undefined,
  rules: Rules
): SatirMaliyetKaydi | null {
  const harita = rules.satirMaliyetleri instanceof Map ? rules.satirMaliyetleri : null;
  if (!harita || harita.size === 0 || order.platform === "manual") return null;
  return (
    harita.get(
      satirMaliyetiHaritaAnahtari(order.platform, order.id, satirAnahtari({ productId: eslesen?.id ?? null, name: line.name }))
    ) ?? null
  );
}

export interface OrderProfit {
  revenue: number;
  profit: number | null; // null = hiç eşleşme/maliyet yok
  partial: boolean; // bazı satırlar eşleşmedi
  /** "platform" = Trendyol GERÇEK komisyonuyla düzeltildi (masaüstüyle aynı kaynak). */
  profitSource: "calculated" | "platform";
  /** Uygulanan gerçek komisyon; uygulanmadıysa null. */
  actualCommission: number | null;
  /** Kuraldan hesaplanan brüt komisyon (snapshot yazımı için). */
  estimatedCommission: number;
  /** kapak görseli: tek farklı ürün varsa onun fotosu */
  image: string | null;
  distinctCount: number; // farklı ürün sayısı
  totalQty: number; // toplam adet
  /** Maliyeti bilinmeyen satırların cirosu — kâra girmedi (uyarı için). */
  unmatchedRevenue: number;
  missingDesiCount: number;
  desiEstimated: boolean;
  orderRevenueAdjustment: number;
}

export function computeOrderProfit(
  order: UnifiedOrder,
  pm: ProductMap,
  rules: Rules,
  settings: Record<string, string>
): OrderProfit {
  if (order.isManual) {
    const totalQty = order.items.reduce((sum, line) => sum + line.quantity, 0);
    const onlyLine = order.items.length === 1 ? order.items[0] : null;
    const matched = onlyLine ? matchOrderLine(onlyLine, order.platform, pm) : undefined;
    return {
      revenue: order.total,
      profit: order.profit ?? null,
      partial: Boolean(order.profitPartial),
      // Manuel siparişin kârı ManualOrder satırında saklıdır; pazaryeri komisyonu yok.
      profitSource: "calculated",
      actualCommission: null,
      estimatedCommission: 0,
      image: onlyLine?.image ?? matched?.imageUrl ?? null,
      distinctCount: order.items.length,
      totalQty,
      unmatchedRevenue: order.profit == null ? order.total : 0,
      missingDesiCount: 0,
      desiEstimated: false,
      orderRevenueAdjustment: 0,
    };
  }

  // Kâr hesabının TAMAMI @core/order-profit'te — masaüstü /api/orders ile AYNI fonksiyon.
  // (Eski mobil kopya: listing komisyonunu uygulamıyordu + sabit gideri adet başına tekrar
  //  kesiyordu → telefondaki kârlar masaüstünden şişik çıkıyordu.)
  let image: string | null = null;
  const fiyatlar = kuralFilamentFiyatlari(rules);
  const lines: OrderProfitLine[] = order.items.map((line) => {
    const p = matchOrderLine(line, order.platform, pm);
    if (p && !image) image = p.imageUrl;
    // Siparişe özel maliyet varsa o kullanılır (masaüstüyle aynı kural ve aynı motor).
    const ozel = ozelMaliyetKaydi(order, line, p, rules);
    const ozelUrun = ozel
      ? satirMaliyetliUrun(
          ozel,
          p
            ? {
                id: p.id,
                name: p.name,
                categoryName: p.categoryName,
                desi: p.desi,
                commissionRate: p.commissionRate,
                listing: p.listings.find((l) => l.platform === order.platform) ?? null,
              }
            : null,
          settings,
          fiyatlar
        )
      : null;
    if (ozelUrun) return { unitPrice: line.unitPrice, quantity: line.quantity, product: ozelUrun };
    const resolved = p
      ? resolveProductCost(
          p.cost ? { ...p.cost, tapeUsed: !!p.cost.tapeUsed } : null,
          settings,
          p.cost?.costPerGram ?? 0,
          fiyatlar
        )
      : null;
    return {
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      product:
        p && resolved
          ? {
              id: p.id,
              name: p.name,
              categoryName: p.categoryName,
              desi: p.desi,
              commissionRate: p.commissionRate,
              productionCost: resolved.productionCost,
              packagingCost: resolved.packagingCost,
              packagingComponents: resolved.packagingBreakdown?.components ?? null,
              filamentCost: resolved.filamentCost,
              productionCostKnown: resolved.productionCostKnown,
              listing: p.listings.find((l) => l.platform === order.platform) ?? null,
            }
          : null,
    };
  });

  // Trendyol GERÇEK komisyonu (settlement) — masaüstüyle AYNI iki anahtar: önce dış sipariş
  // kimliği, olmazsa sipariş numarası TEKİLSE fallback. Yoksa kural-tabanlı kâr aynen kalır.
  //
  // ⚠️ `?.` YETMİYOR, `instanceof Map` ŞART. Bu iki alan birer `Map`; kurallar bir tur
  // çevrimdışı önbelleğe yazıldı ve `JSON.stringify(new Map())` → `{}` olduğu için geri
  // yüklendiğinde DÜZ NESNE oldu. `{}` truthy olduğundan `?.` devreye girmedi ve
  // ".get is not a function" fırladı — Panel ilk render'da patlıyor, UYGULAMA HİÇ AÇILMIYORDU.
  // Kurallar artık diske yazılmıyor; bu kontrol ikinci savunma: en kötü ihtimalle Trendyol'un
  // gerçek komisyonu o tur kullanılamaz, uygulama çalışmaya devam eder.
  const disKimlikHaritasi =
    rules.financialByExternalId instanceof Map ? rules.financialByExternalId : null;
  const siparisNoHaritasi =
    rules.financialByOrderNumber instanceof Map ? rules.financialByOrderNumber : null;

  let financial =
    order.platform === "trendyol" ? disKimlikHaritasi?.get(order.id) ?? null : null;
  if (!financial && order.platform === "trendyol") {
    const candidates = siparisNoHaritasi?.get(order.orderNumber) ?? [];
    if (candidates.length === 1) financial = candidates[0];
  }

  const r = resolveOrderProfit(
    {
      platform: order.platform,
      orderTotal: order.total,
      lines,
      commissionRules: rules.commission,
      cargoRules: rules.cargo,
      expenseRules: rules.expense,
      settings,
      // Kargo kuralı siparişin KENDİ tarihine göre — masaüstüyle aynı. Geçilmezse tarife
      // değiştiği anda telefon geçmiş siparişleri yeni fiyatla gösterirdi.
      orderedAt: order.date != null ? new Date(order.date) : null,
      // Reklam payı — masaüstüyle AYNI çekirdek fonksiyonundan.
      adRate: reklamOraniIcin(
        rules.adBudgets ?? [],
        order.platform,
        order.date != null ? new Date(order.date).getTime() : Date.now()
      ),
    },
    {
      forceProfitPartial: !!order.financialPartial,
      // İptal siparişe gerçek komisyon uygulanmaz (masaüstü statusKind==='cancelled' ile aynı).
      statusKind: isCancelledOrder(order) ? "cancelled" : undefined,
      financial,
    }
  );

  const distinctCount = order.items.length;
  return {
    revenue: order.total,
    profit: r.profit,
    partial: r.profitPartial,
    profitSource: r.profitSource,
    actualCommission: r.actualCommission,
    estimatedCommission: r.estimatedCommission,
    image: distinctCount === 1 ? image : null,
    distinctCount,
    totalQty: r.totalQty,
    unmatchedRevenue: r.unmatchedRevenue,
    missingDesiCount: r.missingDesiLines,
    desiEstimated: r.desiEstimated,
    orderRevenueAdjustment: r.orderRevenueAdjustment,
  };
}
