import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "react-native";

import { RuleList } from "@/components/RuleList";
import { getAllCommissionRules, komisyonKuraliYururlukte, setCommissionRuleActive } from "@/lib/db/rule-crud";
import { formatNumber } from "@/lib/format";

/** Kesir → "%21,5" (kayan nokta artığı yok). */
const yuzde = (kesir: number) => `%${formatNumber(Math.round(kesir * 10000) / 100, Number.isInteger(Math.round(kesir * 10000) / 100) ? 0 : 2)}`;

const PAZARYERI: Record<string, string> = { trendyol: "Trendyol", hepsiburada: "Hepsiburada" };

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

  // Yalnız yürürlükteki kurallar; kapanmış dönemler geçmiş siparişler için arka planda durur.
  const items = data
    ?.filter((r) => komisyonKuraliYururlukte(r))
    .map((r) => ({
      id: r.id,
      name: r.name,
      badge: `${PAZARYERI[r.platform ?? "trendyol"] ?? "Trendyol"} · ${r.categoryName ?? "Genel"}`,
      subtitle: `${yuzde(r.commissionRate)}${
        r.fixedCommission ? ` + ₺${formatNumber(r.fixedCommission, 2)}` : ""
      } · ₺${formatNumber(r.minPrice)}–${r.maxPrice >= 999999 ? "sınırsız" : `₺${formatNumber(r.maxPrice)}`} · öncelik ${r.priority}`,
      isActive: true,
    }));

  return (
    <RuleList
      error={error}
      onRetry={() => void refetch()}
      retrying={isFetching}
      title="Komisyon Kuralları"
      note="Oranı olmayan ilanlara uygulanır. Değişiklik bu ayın başından geçerli olur."
      addHref="/rules/commission-edit/new"
      editHrefBase="/rules/commission-edit"
      items={items}
      isLoading={isLoading}
      onToggle={(id, active) => {
        if (active) return toggle.mutate({ id, active });
        Alert.alert("Kural kapatılsın mı?", "Bu ayın başından itibaren uygulanmaz. Önceki aylar değişmez.", [
          { text: "Vazgeç", style: "cancel" },
          { text: "Kapat", style: "destructive", onPress: () => toggle.mutate({ id, active: false }) },
        ]);
      }}
    />
  );
}
