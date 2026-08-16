import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { RuleList } from "@/components/RuleList";
import { getAllCargoRules, kuralYururlukte, setCargoRuleActive } from "@/lib/db/rule-crud";

function platformLabel(p: string | null): string {
  if (!p) return "Tümü";
  if (p === "shopify") return "Shopify";
  if (p === "trendyol") return "Trendyol";
  if (p === "hepsiburada") return "Hepsiburada";
  return p;
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
    },
  });

  /**
   * Yalnız BUGÜN yürürlükte olan baremler listelenir.
   *
   * Kargo tarifeleri dönem dönem değişiyor ve eski kurallar silinmiyor — `validTo` ile
   * kapanıyor, çünkü o dönemde verilen siparişlerin kârı hâlâ onlardan hesaplanıyor.
   * Hepsi listelenince her barem iki kez, iki farklı fiyatla görünüyordu.
   */
  const simdiMs = Date.now();
  const yururlukteOlanlar = data?.filter((r) => kuralYururlukte(r, simdiMs));
  const gizlenen = (data?.length ?? 0) - (yururlukteOlanlar?.length ?? 0);

  const items = yururlukteOlanlar?.map((r) => ({
    id: r.id,
    name: r.name,
    badge: platformLabel(r.platform),
    subtitle: `Desi ${r.minDesi}–${r.maxDesi >= 999 ? "∞" : r.maxDesi} · ₺${r.cargoCost.toFixed(2)}`,
    isActive: !!r.isActive,
  }));

  return (
    <RuleList
      title="Kargo Kuralları"
      note={
        gizlenen > 0
          ? `Platform + desi aralığına göre kargo baremi. ${gizlenen} eski barem gizli — geçmiş siparişler için duruyor.`
          : "Platform + desi aralığına göre kargo baremi."
      }
      addHref="/rules/cargo-edit/new"
      editHrefBase="/rules/cargo-edit"
      items={items}
      isLoading={isLoading}
      onToggle={(id, active) => toggle.mutate({ id, active })}
    />
  );
}
