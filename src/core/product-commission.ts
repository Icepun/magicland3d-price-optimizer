import type { CommissionRuleInput } from "./types";

export function withProductCommissionRule<T extends { id: string; name: string; categoryName: string; commissionRate?: number | null }>(
  product: T,
  commissionRules: CommissionRuleInput[]
): CommissionRuleInput[] {
  if (product.commissionRate === null || product.commissionRate === undefined) {
    return commissionRules;
  }

  return [
    {
      id: `product-commission-${product.id}`,
      name: `Ürün bazlı komisyon - ${product.name}`,
      categoryName: product.categoryName,
      minPrice: 0,
      maxPrice: 999999,
      commissionRate: product.commissionRate,
      fixedCommission: 0,
      priority: 10_000,
      isActive: true,
    },
    ...commissionRules,
  ];
}
