import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { RuleList } from "@/components/RuleList";
import { getAllExpenseRules, setExpenseRuleActive, type ExpenseRuleFull } from "@/lib/db/rule-crud";

const TYPE_LABEL: Record<string, string> = {
  fixed: "Sipariş başına",
  percentage: "Yüzdesel",
  per_order: "Sipariş başına",
};

function platformLabel(p: string | null): string {
  if (!p) return "Tümü";
  if (p === "shopify") return "Shopify";
  if (p === "trendyol") return "Trendyol";
  if (p === "hepsiburada") return "Hepsiburada";
  return p;
}

function valueLabel(r: ExpenseRuleFull): string {
  if (r.type === "percentage") return `%${(r.value * 100).toFixed(2)}`;
  return `₺${r.value.toFixed(2)}`;
}

/** Sipariş gider kuralları — üç kural ekranıyla aynı liste bileşeni (RuleList). */
export default function ExpenseRulesScreen() {
  const qc = useQueryClient();
  const { data: rules, isLoading, refetch, error, isFetching } = useQuery({
    queryKey: ["expense-rules-all"],
    queryFn: getAllExpenseRules,
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => setExpenseRuleActive(id, active),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expense-rules-all"] });
      qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });

  const items = rules?.map((r) => ({
    id: r.id,
    name: r.name,
    badge: platformLabel(r.platform),
    subtitle: `${TYPE_LABEL[r.type]} · ${valueLabel(r)}`,
    isActive: !!r.isActive,
  }));

  return (
    <RuleList
      error={error}
      onRetry={() => void refetch()}
      retrying={isFetching}
      title="Sipariş gider kuralları"
      note="Her siparişin kâr hesabına otomatik giren platform bedeli ve yüzdesel giderler. Ödediğin genel giderleri Gider Ödemeleri ekranına kaydet."
      addHref="/rules/expense-edit/new"
      editHrefBase="/rules/expense-edit"
      items={items}
      isLoading={isLoading}
      onToggle={(id, active) => toggle.mutate({ id, active })}
    />
  );
}
