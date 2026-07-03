import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { RuleList } from "@/components/RuleList";
import { getAllCommissionRules, setCommissionRuleActive } from "@/lib/db/rule-crud";

export default function CommissionRulesScreen() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["commission-rules-all"],
    queryFn: getAllCommissionRules,
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      setCommissionRuleActive(id, active),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commission-rules-all"] });
      qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });

  const items = data?.map((r) => ({
    id: r.id,
    name: r.name,
    badge: r.categoryName ?? "Genel",
    subtitle: `%${(r.commissionRate * 100).toFixed(1)}${
      r.fixedCommission ? ` + ₺${r.fixedCommission}` : ""
    } · ₺${r.minPrice}–${r.maxPrice >= 999999 ? "∞" : r.maxPrice}`,
    isActive: !!r.isActive,
  }));

  return (
    <RuleList
      title="Komisyon Kuralları"
      note="Kategori + fiyat aralığına göre platform komisyonu."
      addHref="/rules/commission-edit/new"
      editHrefBase="/rules/commission-edit"
      items={items}
      isLoading={isLoading}
      onToggle={(id, active) => toggle.mutate({ id, active })}
    />
  );
}
