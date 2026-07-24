export interface ActualCommissionProfitInput {
  profit: number | null;
  profitPartial: boolean;
  orderRevenue: number;
  estimatedCommission: number;
  actualCommission: number;
  settlementRevenue: number;
  vatRate: number;
}

export interface ActualCommissionProfitResult {
  profit: number | null;
  applied: boolean;
  revenueDifference: number;
  revenueTolerance: number;
}

/**
 * Kuraldan hesaplanan komisyonu, pazaryerinin sipariş/paket finans hareketindeki
 * gerçek komisyonuyla değiştirir.
 *
 * Güvenlik:
 * - Ürün maliyeti eksik/kısmi siparişe dokunmaz.
 * - Settlement cirosu sipariş cirosuyla uyuşmuyorsa farklı paket veya eksik hareket
 *   olabileceği için gerçek komisyonu uygulamaz.
 * - Mevcut kâr motoruyla aynı KDV varsayımını korur: KDV faturası olan komisyonun
 *   içindeki indirilecek KDV net maliyetten düşer.
 */
export function applyActualCommissionToProfit(
  input: ActualCommissionProfitInput
): ActualCommissionProfitResult {
  const revenueDifference = Math.abs(input.orderRevenue - input.settlementRevenue);
  const revenueTolerance = Math.max(1, Math.abs(input.orderRevenue) * 0.01);
  const validMoney =
    Number.isFinite(input.orderRevenue) &&
    Number.isFinite(input.settlementRevenue) &&
    Number.isFinite(input.estimatedCommission) &&
    Number.isFinite(input.actualCommission) &&
    input.orderRevenue >= 0 &&
    input.settlementRevenue >= 0 &&
    input.estimatedCommission >= 0 &&
    input.actualCommission >= 0;

  if (
    input.profit == null ||
    input.profitPartial ||
    !validMoney ||
    revenueDifference > revenueTolerance
  ) {
    return {
      profit: input.profit,
      applied: false,
      revenueDifference,
      revenueTolerance,
    };
  }

  const vatRate = Number.isFinite(input.vatRate) ? Math.max(0, input.vatRate) : 0;
  const vatFactor = vatRate > 0 ? vatRate / (100 + vatRate) : 0;
  const estimatedNetCost = input.estimatedCommission * (1 - vatFactor);
  const actualNetCost = input.actualCommission * (1 - vatFactor);

  return {
    profit: input.profit + estimatedNetCost - actualNetCost,
    applied: true,
    revenueDifference,
    revenueTolerance,
  };
}
