import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { RuleList } from "@/components/RuleList";
import { getAllCargoRules, setCargoRuleActive } from "@/lib/db/rule-crud";

function platformLabel(p: string | null): string {
  if (!p) return "Tümü";
  return p === "shopify" ? "Shopify" : "Trendyol";
}

export default function CargoRulesScreen() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["cargo-rules-all"],
    queryFn: getAllCargoRules,
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => setCargoRuleActive(id, active),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cargo-rules-all"] });
      qc.invalidateQueries({ queryKey: ["rules"] });
      qc.invalidateQueries({ queryKey: ["dashboard-data"] });
    },
  });

  const items = data?.map((r) => ({
    id: r.id,
    name: r.name,
    badge: platformLabel(r.platform),
    subtitle: `Desi ${r.minDesi}–${r.maxDesi >= 999 ? "∞" : r.maxDesi} · ₺${r.cargoCost.toFixed(2)}`,
    isActive: !!r.isActive,
  }));

  return (
    <RuleList
      title="Kargo Kuralları"
      note="Platform + desi aralığına göre kargo bareni."
      addHref="/rules/cargo-edit/new"
      editHrefBase="/rules/cargo-edit"
      items={items}
      isLoading={isLoading}
      onToggle={(id, active) => toggle.mutate({ id, active })}
    />
  );
}
