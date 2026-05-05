import { simulatePrice, simulateRange } from "./pricing-engine";
import type {
  SimulationInput,
  SimulationResult,
  RecommendationOutput,
} from "./types";
import { PSYCHOLOGICAL_PRICES } from "./types";

function buildReason(
  result: SimulationResult,
  currentResult: SimulationResult
): string {
  const parts: string[] = [];

  const profitDiff = result.netProfit - currentResult.netProfit;
  const marginDiff = result.profitMargin - currentResult.profitMargin;

  if (
    result.appliedCargoRule?.id !== currentResult.appliedCargoRule?.id &&
    result.appliedCargoRule &&
    currentResult.appliedCargoRule
  ) {
    const saving = currentResult.cargoCost - result.cargoCost;
    parts.push(
      `Kargo baremi değişiyor: ${currentResult.cargoCost.toFixed(0)} TL → ${result.cargoCost.toFixed(0)} TL (${saving > 0 ? "+" : ""}${saving.toFixed(0)} TL avantaj)`
    );
  }

  if (
    result.appliedCommissionRule?.id !== currentResult.appliedCommissionRule?.id &&
    result.appliedCommissionRule
  ) {
    const oldRate = currentResult.appliedCommissionRule
      ? (currentResult.appliedCommissionRule.commissionRate * 100).toFixed(0)
      : "?";
    const newRate = (result.appliedCommissionRule.commissionRate * 100).toFixed(0);
    parts.push(`Komisyon oranı değişiyor: %${oldRate} → %${newRate}`);
  }

  if (Math.abs(profitDiff) > 0.01) {
    parts.push(
      `Net kâr: ${currentResult.netProfit.toFixed(2)} TL → ${result.netProfit.toFixed(2)} TL (${profitDiff > 0 ? "+" : ""}${profitDiff.toFixed(2)} TL)`
    );
  }

  if (Math.abs(marginDiff) > 0.001) {
    parts.push(
      `Kâr oranı: %${(currentResult.profitMargin * 100).toFixed(1)} → %${(result.profitMargin * 100).toFixed(1)}`
    );
  }

  return parts.length > 0
    ? parts.join(" | ")
    : "Minimum kâr/oran koşullarını sağlıyor";
}

export function generateRecommendations(
  baseInput: Omit<SimulationInput, "salePrice">,
  currentPrice: number,
  priceRange?: { min: number; max: number; step?: number }
): RecommendationOutput {
  const min = priceRange?.min ?? Math.max(currentPrice * 0.5, 49);
  const max = priceRange?.max ?? currentPrice * 2;

  const pricesToTest = PSYCHOLOGICAL_PRICES.filter((p) => p >= min && p <= max);
  if (!pricesToTest.includes(currentPrice)) pricesToTest.push(currentPrice);
  pricesToTest.sort((a, b) => a - b);

  const results = simulateRange(baseInput, pricesToTest);
  const currentResult = simulatePrice({ ...baseInput, salePrice: currentPrice });
  const validResults = results.filter((r) => r.isValid);

  if (validResults.length === 0) {
    return { allValid: [] };
  }

  const byProfit = [...validResults].sort((a, b) => b.netProfit - a.netProfit);
  const byMargin = [...validResults].sort(
    (a, b) => b.profitMargin - a.profitMargin
  );

  const bestNetProfitResult = byProfit[0];
  const bestMarginResult = byMargin[0];

  const MEANINGFUL_PROFIT_DELTA = 10;
  const MEANINGFUL_PROFIT_RATIO = 0.08;

  const safeCandidate = validResults
    .filter((r) => {
      const delta = r.netProfit - currentResult.netProfit;
      const ratio =
        currentResult.netProfit > 0
          ? delta / currentResult.netProfit
          : delta > 0
            ? 1
            : 0;
      return delta >= MEANINGFUL_PROFIT_DELTA || ratio >= MEANINGFUL_PROFIT_RATIO;
    })
    .sort((a, b) => {
      const aDist = Math.abs(a.salePrice - currentPrice);
      const bDist = Math.abs(b.salePrice - currentPrice);
      if (Math.abs(aDist - bDist) < 30) return b.netProfit - a.netProfit;
      return aDist - bDist;
    })[0];

  const output: RecommendationOutput = { allValid: validResults };

  if (bestNetProfitResult) {
    output.bestNetProfit = {
      salePrice: bestNetProfitResult.salePrice,
      result: bestNetProfitResult,
      type: "bestNetProfit",
      reason: buildReason(bestNetProfitResult, currentResult),
    };
  }

  if (bestMarginResult) {
    output.bestMargin = {
      salePrice: bestMarginResult.salePrice,
      result: bestMarginResult,
      type: "bestMargin",
      reason: buildReason(bestMarginResult, currentResult),
    };
  }

  if (safeCandidate) {
    output.safe = {
      salePrice: safeCandidate.salePrice,
      result: safeCandidate,
      type: "safe",
      reason: buildReason(safeCandidate, currentResult),
    };
  }

  return output;
}
