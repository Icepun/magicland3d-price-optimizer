import { simulatePrice, calculateExpenses, splitExpenseRulesByScope } from "./pricing-engine";
import { withProductCommissionRule, resolveListingCommissionOverride } from "./product-commission";
import { filterRulesByPlatform, findCargoRule } from "./cargo-calculator";
import type { CommissionRuleInput, CargoRuleInput, ExpenseRuleInput } from "./types";

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
  filamentCost: number;
  /** Siparişin platformundaki listing (yoksa null) — komisyon + elle girilen kargo kaynağı. */
  listing: OrderProfitListing | null;
}

export interface OrderProfitLine {
  unitPrice: number;
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
  /** true = bazı satırlar kâra girmedi (kısmi hesap). */
  partial: boolean;
  matchedLines: number;
  unmatchedLines: number;
  unmatchedQty: number;
  /** Maliyeti bilinmeyen satırların cirosu — kâra GİRMEDİ (UI uyarısı için). */
  unmatchedRevenue: number;
  totalQty: number;
}

export function computeOrderProfit(input: OrderProfitInput): OrderProfitResult {
  const { platform, orderTotal, lines, commissionRules, cargoRules, expenseRules, settings } = input;
  const vatRate = Number(settings.vatRate ?? 0);
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
  let totalDesi = 0;
  let cargoCategory = "";
  let soloCargo: number | null = null;

  for (const line of lines) {
    totalQty += line.quantity;
    const p = line.product;
    if (!p || p.productionCost + p.packagingCost <= 0 || !(line.unitPrice > 0)) {
      unmatchedLines++;
      unmatchedQty += line.quantity;
      unmatchedRevenue += Math.max(0, line.unitPrice) * line.quantity;
      continue;
    }
    const lst = p.listing ?? { platform, commissionRate: null, commissionFixed: null, cargoCost: null };
    const sim = simulatePrice({
      salePrice: line.unitPrice,
      productCost: p.productionCost,
      packagingCost: p.packagingCost,
      categoryName: p.categoryName,
      desi: p.desi ?? 1,
      commissionRules: withProductCommissionRule(p, commissionRules),
      cargoRules: platCargo,
      expenseRules: perUnit, // YALNIZ yüzdesel — sabit gider siparişe bir kez
      vatRate,
      ...resolveListingCommissionOverride(lst, settings),
      cargoCostOverride: 0, // kargo sipariş düzeyinde
      minOrderQty: line.quantity, // adet motorun İÇİNDE (dıştan × qty YOK)
      vatableProductCost: p.filamentCost,
    });
    profit += sim.netProfit;
    matchedQty += line.quantity;
    totalDesi += (p.desi ?? 1) * line.quantity;
    if (matchedLines === 0) {
      cargoCategory = p.categoryName;
      soloCargo = lst.cargoCost;
    }
    matchedLines++;
  }

  if (matchedLines === 0) {
    return { profit: null, partial: false, matchedLines: 0, unmatchedLines, unmatchedQty, unmatchedRevenue, totalQty };
  }

  // Maliyeti bilinmeyen adetler de KUTUDA — desilerini yok saymak kargo baremini olduğundan ucuz
  // seçtiriyordu (kâr şişiyordu). Eşleşenlerin ortalamasıyla tahmin et, YUKARI yuvarla (tedbirli).
  if (unmatchedQty > 0) {
    totalDesi += Math.ceil((totalDesi / matchedQty) * unmatchedQty);
  }

  // SABİT GİDER — siparişe BİR KEZ (kargoyla simetrik: aynı taban, aynı KDV formülü).
  const { fixed: orderFixed } = calculateExpenses(perOrder, orderTotal, cargoCategory);
  profit -= orderFixed;
  profit += orderFixed * vatFactor;

  // KARGO — siparişe BİR KEZ. Tek ürünlü ve eksiksiz siparişte listing'e ELLE girilen bedel kazanır
  // (Ürünler ekranı da onu kullanıyor → iki ekran aynı rakamı gösterir).
  const cargoCost =
    matchedLines === 1 && unmatchedLines === 0 && soloCargo != null
      ? soloCargo
      : (findCargoRule(platCargo, orderTotal, cargoCategory, totalDesi || 1)?.cargoCost ?? 0);
  profit -= cargoCost;
  profit += cargoCost * vatFactor;

  return { profit, partial: unmatchedLines > 0, matchedLines, unmatchedLines, unmatchedQty, unmatchedRevenue, totalQty };
}
