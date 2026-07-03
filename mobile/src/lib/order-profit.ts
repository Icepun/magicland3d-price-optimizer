import { simulatePrice } from "@core/pricing-engine";
import { resolveProductCost } from "@core/product-cost";
import { withProductCommissionRule } from "@core/product-commission";
import {
  filterCargoRulesByPlatform,
  filterRulesByPlatform,
  findCargoRule,
} from "@core/cargo-calculator";

import type { ProductDetail } from "@/lib/db/product-detail";
import type { Rules } from "@/lib/profit";
import type { UnifiedOrder } from "@/lib/api/orders";

export interface MatchedProduct {
  imageUrl: string | null;
  name: string;
  detail: ProductDetail;
}

/** Türkçe-duyarlı ad normalizasyonu (masaüstü orders route normName ile birebir). */
const normName = (s: string | null | undefined) =>
  (s ?? "").toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();

export interface ProductMap {
  byKey: Map<string, ProductDetail>;
  /** Shopify ad-eşleştirme (Shopify barkod tutmaz): normalize ad → ürün; aynı ad çoklu ürün → null (belirsiz). */
  byName: Map<string, ProductDetail | null>;
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

/** Çok-anahtarlı ürün haritası: Product.barcode/sku + Listing.externalId/externalSku → ürün,
 *  + Shopify için ada göre eşleştirme (masaüstü orders route ile birebir). */
export function buildProductMap(products: ProductDetail[]): ProductMap {
  const byKey = new Map<string, ProductDetail>();
  const byName = new Map<string, ProductDetail | null>();
  const add = (k: string | null | undefined, p: ProductDetail) => {
    if (k && !byKey.has(k)) byKey.set(k, p);
  };
  for (const p of products) {
    add(p.barcode, p);
    add(p.sku, p);
    for (const l of p.listings) {
      add(l.externalId, p);
      add(l.externalSku, p);
      add(l.barcode, p); // platform-bazlı listing barkodu (Trendyol/HB barkodu) — masaüstü byKey ile birebir
    }
    const nk = normName(p.name);
    if (nk) byName.set(nk, byName.has(nk) ? null : p);
  }
  return { byKey, byName };
}

/** Bir sipariş satırını aday anahtarlarıyla ürüne eşle. */
function matchLine(
  keys: string[] | undefined,
  byKey: Map<string, ProductDetail>
): ProductDetail | undefined {
  for (const k of keys ?? []) {
    const p = byKey.get(k);
    if (p) return p;
  }
  return undefined;
}
export { matchLine };

/** Satır eşleştirme (anahtar + Shopify ad-fallback) — computeOrderProfit ile AYNI mantık.
 *  Sipariş detay ekranı da bunu kullansın ki "kâr hesaplandı ama satır eşleşmedi" çelişkisi olmasın. */
export function matchOrderLine(
  line: { matchKeys?: string[]; name: string },
  platform: UnifiedOrder["platform"],
  pm: ProductMap
): ProductDetail | undefined {
  let p = matchLine(line.matchKeys, pm.byKey);
  if (!p && platform === "shopify") {
    const named = pm.byName.get(normName(line.name));
    if (named) p = named;
  }
  return p;
}

export interface OrderProfit {
  revenue: number;
  profit: number | null; // null = hiç eşleşme/maliyet yok
  partial: boolean; // bazı satırlar eşleşmedi
  /** kapak görseli: tek farklı ürün varsa onun fotosu */
  image: string | null;
  distinctCount: number; // farklı ürün sayısı
  totalQty: number; // toplam adet
}

export function computeOrderProfit(
  order: UnifiedOrder,
  pm: ProductMap,
  rules: Rules,
  settings: Record<string, string>
): OrderProfit {
  const vatRate = Number(settings.vatRate ?? 0);
  let profit = 0;
  let matched = 0;
  let unknown = false;
  let totalQty = 0;
  let image: string | null = null;
  // Kargo, gönderiye BİR KEZ (sipariş düzeyinde) düşülür → satır döngüsünde toplam desi + kategori biriktir.
  let totalDesi = 0;
  let cargoCategory = "";

  for (const line of order.items) {
    totalQty += line.quantity;
    const p = matchOrderLine(line, order.platform, pm);
    if (p && !image) image = p.imageUrl;
    if (!p) {
      unknown = true;
      continue;
    }
    const resolved = resolveProductCost(
      p.cost ? { ...p.cost, tapeUsed: !!p.cost.tapeUsed } : null,
      settings,
      p.cost?.costPerGram ?? 0
    );
    // Masaüstü lineProfitNoCargo gate'i ile BİREBİR: (a) maliyet = üretim+paketleme toplamı,
    // (b) 0₺ satır (hediye/%100 kupon/fiyatsız) kâra GİRMEZ → satır "eşleşmedi" gibi kısmi sayılır.
    // (Eski HATA: 0₺ satır liste fiyatına düşüyordu → kâr olduğundan YÜKSEK ve "kesin" görünüyordu.)
    if (!resolved || resolved.productionCost + resolved.packagingCost <= 0 || !(line.unitPrice > 0)) {
      unknown = true;
      continue;
    }
    // Satır kârı — KARGOSUZ (cargoCostOverride: 0). Kargo aşağıda gönderiye bir kez düşülür.
    // (Eski HATA: her satıra kargo uygulanıyordu → çok ürünlü siparişte kâr olduğundan DÜŞÜK görünüyordu.)
    const sim = simulatePrice({
      salePrice: line.unitPrice,
      productCost: resolved.productionCost,
      packagingCost: resolved.packagingCost,
      categoryName: p.categoryName,
      desi: p.desi ?? 1,
      commissionRules: withProductCommissionRule(p, rules.commission),
      cargoRules: filterCargoRulesByPlatform(rules.cargo, order.platform),
      expenseRules: filterRulesByPlatform(rules.expense, order.platform),
      vatRate,
      // Komisyon SADECE withProductCommissionRule ile (masaüstü orders route lineProfitNoCargo ile birebir).
      // (Listing override / Shopify 3.2% override KALDIRILDI → orders ekranı masaüstüyle aynı kâr.)
      cargoCostOverride: 0,
      vatableProductCost: resolved.filamentCost,
    });
    profit += sim.netProfit * line.quantity;
    totalDesi += (p.desi ?? 1) * line.quantity;
    if (!cargoCategory) cargoCategory = p.categoryName;
    matched++;
  }

  // KARGO: tüm gönderiye BİR KEZ — toplam desiye göre (masaüstüyle birebir aynı mantık).
  if (matched > 0) {
    const cargoRule = findCargoRule(
      filterCargoRulesByPlatform(rules.cargo, order.platform),
      order.total,
      cargoCategory,
      totalDesi || 1
    );
    if (cargoRule) {
      // Kargoyu düş + içindeki indirilebilir KDV'yi iade et (kâr, KDV'siz kargoyu görür) —
      // satır kârı zaten komisyon/gider/filament KDV iadesini içeriyor; kargo gönderiye bir kez burada.
      profit -= cargoRule.cargoCost;
      profit += cargoRule.cargoCost * (vatRate > 0 ? vatRate / (100 + vatRate) : 0);
    }
  }

  const distinctCount = order.items.length;
  return {
    revenue: order.total,
    profit: matched === 0 ? null : profit,
    // Masaüstü orders route ile birebir: profitPartial = anyProfit && anyUnmatched.
    // (Hiç eşleşme yoksa "kısmi" değil "bilinmeyen" → profit null + partial false; ürün gerçekten yok.)
    partial: matched > 0 && unknown,
    image: distinctCount === 1 ? image : null,
    distinctCount,
    totalQty,
  };
}
