import {
  simulatePrice,
  calculateExpenses,
  splitExpenseRulesByScope,
  resolveVatableCost,
} from "./pricing-engine";
import { vatRateOf } from "./vat";
import { withProductCommissionRule, resolveListingCommissionOverride } from "./product-commission";
import { applyActualCommissionToProfit } from "./platform-financials";
import { filterRulesByPlatform, findCargoRule } from "./cargo-calculator";
import type { CommissionRuleInput, CargoRuleInput, ExpenseRuleInput } from "./types";
import type {
  PackagingComponentKey,
  PackagingScope,
} from "./packaging";

/**
 * SİPARİŞ KÂRI — masaüstü (/api/orders) ve mobil için TEK kaynak.
 *
 * Kapsam kuralı (kullanıcı teyidi: Trendyol hizmet bedelini SİPARİŞ başına kesiyor):
 *   • Adet başına : ürün + paketleme + komisyon + YÜZDESEL gider
 *   • Siparişe BİR KEZ : kargo + SABİT / sipariş-başına gider (Platform Hizmet Bedeli)
 *
 * Eski hata: her satır için simulatePrice çağrıldığından sabit gider her FARKLI üründe tekrar
 * kesiliyordu (aynı üründen N adet ise bir kez) → 3 kalemli siparişte kâr ~₺22 eksik görünüyordu.
 */

export interface OrderProfitListing {
  platform: string;
  commissionRate: number | null;
  commissionFixed: number | null;
  cargoCost: number | null;
}

export interface OrderProfitProduct {
  id: string;
  name: string;
  categoryName: string;
  desi: number | null;
  commissionRate: number | null;
  productionCost: number;
  packagingCost: number;
  packagingComponents?: {
    key: PackagingComponentKey;
    scope: PackagingScope;
    cost: number;
  }[] | null;
  filamentCost: number;
  /**
   * Üretim maliyeti gerçekten girilmiş mi (resolveProductCost.productionCostKnown).
   * Paketleme her üründe otomatik eklendiği için "maliyet var mı" kararı tutara BAKAMAZ.
   */
  productionCostKnown: boolean;
  /** Siparişin platformundaki listing (yoksa null) — komisyon + elle girilen kargo kaynağı. */
  listing: OrderProfitListing | null;
}

export interface OrderProfitLine {
  unitPrice: number;
  /** İade sonrası KALAN adet. 0 = satır tamamen iade edildi → kâra hiç girmez. */
  quantity: number;
  /** null = ürün eşleşmedi / maliyeti girilmemiş → kâra girmez. */
  product: OrderProfitProduct | null;
}

export interface OrderProfitInput {
  platform: string;
  orderTotal: number;
  lines: OrderProfitLine[];
  commissionRules: CommissionRuleInput[];
  cargoRules: CargoRuleInput[];
  expenseRules: ExpenseRuleInput[];
  settings: Record<string, string | undefined>;
}

export interface OrderProfitResult {
  /** null = hiçbir satırın maliyeti bilinmiyor → kâr gösterilmemeli. */
  profit: number | null;
  /** Kural/listing üzerinden siparişe düşülen brüt komisyon. */
  estimatedCommission: number;
  /** true = bazı satırlar kâra girmedi (kısmi hesap). */
  partial: boolean;
  matchedLines: number;
  unmatchedLines: number;
  unmatchedQty: number;
  /** Maliyeti bilinmeyen satırların cirosu — kâra GİRMEDİ (UI uyarısı için). */
  unmatchedRevenue: number;
  totalQty: number;
  missingDesiLines: number;
  missingDesiQty: number;
  desiEstimated: boolean;
  /** Sipariş toplamı ile ürün satırları toplamı arasındaki kargo geliri / sipariş indirimi (brüt). */
  orderRevenueAdjustment: number;
  orderRevenueAdjustmentNet: number;
}

export function computeOrderProfit(input: OrderProfitInput): OrderProfitResult {
  const { platform, orderTotal, lines, commissionRules, cargoRules, expenseRules, settings } = input;
  const vatRate = vatRateOf(settings);
  // Bir maliyetin içindeki KDV payı (indirilecek KDV) — kargo/gider için aynı formül.
  const vatFactor = vatRate > 0 ? vatRate / (100 + vatRate) : 0;

  const platCargo = filterRulesByPlatform(cargoRules, platform);
  // SABİT gider satır hesabından ÇIKARILIR → aşağıda siparişe bir kez uygulanır.
  const { perUnit, perOrder } = splitExpenseRulesByScope(filterRulesByPlatform(expenseRules, platform));

  let profit = 0;
  let matchedLines = 0;
  let matchedQty = 0;
  let unmatchedLines = 0;
  let unmatchedQty = 0;
  let unmatchedRevenue = 0;
  let totalQty = 0;
  let lineRevenueGross = 0;
  let matchedRevenueGross = 0;
  let commissionRateRevenue = 0;
  let estimatedCommission = 0;
  let missingDesiLines = 0;
  let missingDesiQty = 0;
  let totalDesi = 0;
  let soloCargo: number | null = null;
  const matchedCategories = new Set<string>();
  const sharedPackaging = new Map<
    string,
    { scope: "per_order" | "per_shipment"; cost: number }
  >();

  for (const line of lines) {
    // TAMAMEN İADE EDİLMİŞ SATIR (kalan adet 0) → ne cirosu ne maliyeti vardır; hesaba HİÇ girmez.
    //
    // Eleme neden ÇEKİRDEKTE: adet zaten çekirdeğin girdisi ve "0 adetten 0 ciro, 0 maliyet çıkar"
    // aritmetik bir gerçek — platforma özel bir bilgi değil (forceProfitPartial gibi dışarıda
    // kalması gerekmiyor). Çağırana bırakılsaydı masaüstü ve mobil aynı sipariş için farklı kâr
    // gösterme riski doğardı. Ayrıca çekirdek 0 adetli satırı eskiden ya "maliyeti bilinmiyor"
    // sayıp siparişi boş yere kısmi işaretliyor ya da eşleşmişse motorun qty = max(1, …) tabanı
    // yüzünden İADE EDİLEN ürünün TAM maliyetini kesmeye devam ediyordu.
    const quantity = Number.isFinite(line.quantity) ? line.quantity : 0;
    if (quantity <= 0) continue;
    totalQty += quantity;
    const p = line.product;
    // Promosyon/hediye satırının satış fiyatı 0 olabilir; ürün eşleşmişse üretim ve paketleme
    // maliyeti yine vardır ve kârdan düşülmelidir. Geçersiz/negatif fiyatı da güvenli tarafta
    // kalarak 0 gelir kabul et; "maliyet eksik" yalnız ürün veya maliyet gerçekten yokken denir.
    const unitPrice = Number.isFinite(line.unitPrice) ? Math.max(0, line.unitPrice) : 0;
    const lineGross = unitPrice * quantity;
    lineRevenueGross += lineGross;
    // "Maliyet eksik" kararı ÜRETİM payına bakar: paketleme her üründe otomatik eklendiği için
    // tutarların toplamı hiçbir zaman 0 olmuyor ve maliyeti girilmemiş satır kâra dahil oluyordu.
    if (!p || !p.productionCostKnown) {
      unmatchedLines++;
      unmatchedQty += quantity;
      unmatchedRevenue += lineGross;
      continue;
    }
    // desi = 0 GEÇERLİ bir değerdir (çok küçük ürünler için bilerek girilir) → "girilmemiş"
    // sayılmaz, uyarı üretmez. Yalnız desi HİÇ girilmemişse (null) uyarılır ve 1 varsayılır.
    // Kâr etkisi yok: kargo baremlerinin tamamı 0'dan başlıyor, yani 0 ile 1 aynı barime düşer.
    const lineDesi = p.desi != null && p.desi >= 0 ? p.desi : 1;
    if (p.desi == null) {
      missingDesiLines++;
      missingDesiQty += quantity;
    }
    const lst = p.listing ?? { platform, commissionRate: null, commissionFixed: null, cargoCost: null };
    matchedCategories.add(p.categoryName);
    const scopedPackaging = p.packagingComponents?.length
      ? p.packagingComponents
      : null;
    const unitPackaging = scopedPackaging
      ? scopedPackaging.reduce(
          (sum, component) =>
            sum + (component.scope === "per_unit" ? component.cost : 0),
          0
        )
      : p.packagingCost;
    for (const component of scopedPackaging ?? []) {
      if (component.scope === "per_unit") continue;
      const current = sharedPackaging.get(component.key);
      if (!current || component.cost > current.cost) {
        sharedPackaging.set(component.key, {
          scope: component.scope,
          cost: component.cost,
        });
      }
    }
    const commissionOverride = resolveListingCommissionOverride(lst, settings);
    const sim = simulatePrice({
      salePrice: unitPrice,
      productCost: p.productionCost,
      packagingCost: unitPackaging,
      categoryName: p.categoryName,
      desi: lineDesi,
      commissionRules: withProductCommissionRule(p, commissionRules),
      cargoRules: platCargo,
      expenseRules: perUnit, // YALNIZ yüzdesel — sabit gider siparişe bir kez
      vatRate,
      ...commissionOverride,
      cargoCostOverride: 0, // kargo sipariş düzeyinde
      minOrderQty: quantity, // adet motorun İÇİNDE (dıştan × qty YOK)
      vatableProductCost: p.filamentCost,
    });
    profit += sim.netProfit;
    estimatedCommission += sim.commissionCost;
    matchedRevenueGross += lineGross;
    commissionRateRevenue +=
      lineGross *
      (commissionOverride.commissionRateOverride ??
        sim.appliedCommissionRule?.commissionRate ??
        0);
    matchedQty += quantity;
    totalDesi += lineDesi * quantity;
    if (matchedLines === 0) {
      soloCargo = lst.cargoCost;
    }
    matchedLines++;
  }

  if (matchedLines === 0) {
    return {
      profit: null,
      estimatedCommission: 0,
      partial: false,
      matchedLines: 0,
      unmatchedLines,
      unmatchedQty,
      unmatchedRevenue,
      totalQty,
      missingDesiLines,
      missingDesiQty,
      desiEstimated: missingDesiLines > 0 || unmatchedQty > 0,
      orderRevenueAdjustment: 0,
      orderRevenueAdjustmentNet: 0,
    };
  }

  // Maliyeti bilinmeyen adetler de KUTUDA — desilerini yok saymak kargo baremini olduğundan ucuz
  // seçtiriyordu (kâr şişiyordu). Eşleşenlerin ortalamasıyla tahmin et, YUKARI yuvarla (tedbirli).
  if (unmatchedQty > 0) {
    totalDesi += Math.ceil((totalDesi / matchedQty) * unmatchedQty);
  }

  // Shopify gibi platformlarda müşteri tarafından ödenen kargo, satır fiyatlarına değil sipariş
  // toplamına girer. Tersine sipariş-geneli indirim de satır toplamını aşağı çekebilir. Farkı KDV
  // hariç gelire bir kez ekle/çıkar; yüzde komisyonu da aynı fark üzerinde düzelt.
  const orderRevenueAdjustment = Number.isFinite(orderTotal)
    ? orderTotal - lineRevenueGross
    : 0;
  const vatMultiplier = 1 + (vatRate > 0 ? vatRate / 100 : 0);
  const adjustmentRevenueExVat = orderRevenueAdjustment / vatMultiplier;
  const adjustmentCommissionRate =
    matchedRevenueGross > 0 ? commissionRateRevenue / matchedRevenueGross : 0;
  const adjustmentCommission = orderRevenueAdjustment * adjustmentCommissionRate;
  estimatedCommission += adjustmentCommission;
  const orderRevenueAdjustmentNet =
    adjustmentRevenueExVat -
    adjustmentCommission +
    adjustmentCommission * vatFactor;
  profit += orderRevenueAdjustmentNet;

  // SABİT GİDER — siparişe BİR KEZ (kargoyla simetrik: aynı taban, aynı KDV formülü).
  const categories = [...matchedCategories];
  const orderFixed = Math.max(
    0,
    ...categories.map(
      (categoryName) => calculateExpenses(perOrder, orderTotal, categoryName).fixed
    )
  );
  profit -= orderFixed;
  profit += orderFixed * vatFactor;

  // Kart/sticker gibi sipariş ve kutu/bant gibi gönderi kalemleri, aynı bileşen için
  // siparişte yalnız bir kez uygulanır. Farklı ürün seçimlerinde pahalı olan kazanır.
  const sharedPackagingCost = [...sharedPackaging.values()].reduce(
    (sum, component) => sum + component.cost,
    0
  );
  profit -= sharedPackagingCost;
  profit += sharedPackagingCost * vatFactor;

  // KARGO — siparişe BİR KEZ. Tek ürünlü ve eksiksiz siparişte listing'e ELLE girilen bedel kazanır
  // (Ürünler ekranı da onu kullanıyor → iki ekran aynı rakamı gösterir).
  const canUseSoloCargo =
    matchedLines === 1 &&
    matchedQty === 1 &&
    unmatchedLines === 0 &&
    soloCargo != null;
  const appliedCargoRule = canUseSoloCargo
    ? null
    : categories
        .map((categoryName) =>
          findCargoRule(platCargo, orderTotal, categoryName, totalDesi || 1)
        )
        .filter((rule): rule is CargoRuleInput => rule != null)
        .reduce<CargoRuleInput | null>((selected, rule) => {
          if (!selected) return rule;
          const selectedCost = resolveVatableCost(
            selected.cargoCost,
            selected.vatIncluded !== false,
            vatRate
          );
          const ruleCost = resolveVatableCost(
            rule.cargoCost,
            rule.vatIncluded !== false,
            vatRate
          );
          return ruleCost.gross - ruleCost.inputVat >
            selectedCost.gross - selectedCost.inputVat
            ? rule
            : selected;
        }, null);
  const rawCargoCost =
    canUseSoloCargo
      ? (soloCargo ?? 0)
      : (appliedCargoRule?.cargoCost ?? 0);
  const cargo = resolveVatableCost(
    rawCargoCost,
    appliedCargoRule?.vatIncluded !== false,
    vatRate
  );
  profit -= cargo.gross;
  profit += cargo.inputVat;

  return {
    profit,
    estimatedCommission,
    partial: unmatchedLines > 0,
    matchedLines,
    unmatchedLines,
    unmatchedQty,
    unmatchedRevenue,
    totalQty,
    missingDesiLines,
    missingDesiQty,
    desiEstimated: missingDesiLines > 0 || unmatchedQty > 0,
    orderRevenueAdjustment,
    orderRevenueAdjustmentNet,
  };
}

/** Pazaryerinin settlement kaydı (TL) — Trendyol gerçek komisyonu. */
export interface OrderProfitFinancial {
  /** Gerçek (kesilen) komisyon. */
  actualCommission: number;
  /** Settlement'taki brüt ciro — sipariş cirosuyla uyuşmazsa uygulanmaz. */
  settlementRevenue: number;
}

export interface ResolveOrderProfitOptions {
  /** Platforma özel kısmi işareti (Shopify: satır kırpıldı / kısmi iade). Çekirdek bunu türetemez. */
  forceProfitPartial?: boolean;
  /** İptal siparişe gerçek komisyon UYGULANMAZ. */
  statusKind?: string;
  /** Settlement kaydı yoksa null. */
  financial?: OrderProfitFinancial | null;
}

export interface ResolvedOrderProfit extends OrderProfitResult {
  /** partial || forceProfitPartial — snapshot ve UI bunu kullanır. */
  profitPartial: boolean;
  /** "platform" = kâr gerçek komisyonla düzeltildi. */
  profitSource: "calculated" | "platform";
  /** Uygulanan gerçek komisyon; uygulanmadıysa null. */
  actualCommission: number | null;
}

/**
 * SİPARİŞ KÂRI (TAM) — masaüstü ve mobilin ORTAK giriş noktası.
 *
 * computeOrderProfit yalnız kural-tabanlı kârı verir. Gerçek hayatta Trendyol teslimden sonra
 * GERÇEK komisyonu bildirir (PlatformOrderFinancial) ve kâr ona göre düzeltilmelidir. Bu düzeltme
 * masaüstünde /api/orders içinde yapılıyordu; mobil aynı adımı hiç yapmadığından iki cihaz aynı
 * sipariş için FARKLI kâr gösteriyordu. Artık iki taraf da bu fonksiyonu çağırır.
 *
 * ⚠️ forceProfitPartial ve statusKind çekirdeğin göremediği platform bilgileridir; computeOrderProfit
 * içine gömülemezler (kısmi/iptal siparişe yanlış komisyon uygulanır). Bu yüzden ayrı seçenekler.
 */
export function resolveOrderProfit(
  input: OrderProfitInput,
  options: ResolveOrderProfitOptions = {}
): ResolvedOrderProfit {
  const base = computeOrderProfit(input);
  const profitPartial = base.partial || Boolean(options.forceProfitPartial);
  const financial = options.financial ?? null;

  // Settlement yok veya sipariş iptal → kural-tabanlı kâr aynen kalır.
  if (financial == null || options.statusKind === "cancelled") {
    return { ...base, profitPartial, profitSource: "calculated", actualCommission: null };
  }

  const applied = applyActualCommissionToProfit({
    profit: base.profit,
    profitPartial,
    orderRevenue: input.orderTotal,
    estimatedCommission: base.estimatedCommission,
    actualCommission: financial.actualCommission,
    settlementRevenue: financial.settlementRevenue,
    vatRate: vatRateOf(input.settings),
  });

  return {
    ...base,
    profit: applied.profit,
    profitPartial,
    profitSource: applied.applied ? "platform" : "calculated",
    actualCommission: applied.applied ? financial.actualCommission : null,
  };
}
