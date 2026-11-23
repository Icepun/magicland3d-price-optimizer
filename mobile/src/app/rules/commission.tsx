import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "react-native";

import { RuleList } from "@/components/RuleList";
import { getAllCommissionRules, setCommissionRuleActive } from "@/lib/db/rule-crud";
import { formatNumber } from "@/lib/format";

/** Kesir → "%21,5" (kayan nokta artığı yok). */
const yuzde = (kesir: number) => `%${formatNumber(Math.round(kesir * 10000) / 100, Number.isInteger(Math.round(kesir * 10000) / 100) ? 0 : 2)}`;

export default function CommissionRulesScreen() {
  const qc = useQueryClient();
  const { data, isLoading, refetch, error, isFetching } = useQuery({
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
    onError: () => Alert.alert("Kaydedilemedi", "Bağlantını kontrol edip tekrar dene."),
  });

  const items = data?.map((r) => ({
    id: r.id,
    name: r.name,
    badge: r.categoryName ?? "Genel",
    subtitle: `${yuzde(r.commissionRate)}${
      r.fixedCommission ? ` + ₺${formatNumber(r.fixedCommission, 2)}` : ""
    } · ₺${formatNumber(r.minPrice)}–${r.maxPrice >= 999999 ? "sınırsız" : `₺${formatNumber(r.maxPrice)}`} · öncelik ${r.priority}`,
    isActive: !!r.isActive,
  }));

  return (
    <RuleList
      error={error}
      onRetry={() => void refetch()}
      retrying={isFetching}
      title="Komisyon Kuralları"
      note="İlanında komisyon oranı olmayan ürünlere kategori ve fiyat aralığına göre uygulanır."
      addHref="/rules/commission-edit/new"
      editHrefBase="/rules/commission-edit"
      items={items}
      isLoading={isLoading}
      onToggle={(id, active) => toggle.mutate({ id, active })}
    />
  );
}
