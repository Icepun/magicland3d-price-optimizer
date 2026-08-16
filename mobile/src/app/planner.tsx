import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { SafeAreaView } from "react-native-safe-area-context";

import { AnimatedNumber } from "@/components/fade-in";
import { PressableScale } from "@/components/ui/PressableScale";
import { SkeletonList } from "@/components/ui";
import { ConnectionError } from "@/components/ConnectionError";
import { ScreenHeader } from "@/components/form";
import { getDashboardData } from "@/lib/db/dashboard";
import { getSatisHizi } from "@/lib/db/sales-rate";
import { thumbUrl } from "@/lib/image";
import { getSettingsMap } from "@/lib/db/rules";
import { updateSetting } from "@/lib/db/rule-crud";
import {
  basilacakAdet, hedefStok, parseHedefModu, parseKapsamGun, type HedefAyari,
} from "@/core/planner-target";
import { ML, radius, tabular } from "@/theme/colors";

interface PlanItem {
  id: string;
  name: string;
  imageUrl: string | null;
  stock: number;
  printQty: number;
  filament: number;
}

const RowGap = () => <View style={{ height: 8 }} />;

export default function PlannerScreen() {
  const qc = useQueryClient();
  const { data, isLoading, refetch, error, isFetching } = useQuery({ queryKey: ["dashboard-data"], queryFn: getDashboardData });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

  // Hedef stok DB'de (AppSetting) saklanır → masaüstü/telefon senkron, sayfa değişince sıfırlanmaz
  const savedTarget = Math.max(1, Math.floor(Number(settings?.plannerTargetStock) || 5));
  const [override, setOverride] = useState<number | null>(null);
  const t = override ?? savedTarget;

  const saveTarget = useMutation({
    mutationFn: (v: number) => updateSetting("plannerTargetStock", String(v)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const changeTarget = (delta: number) => {
    const next = Math.max(1, t + delta);
    setOverride(next);
    saveTarget.mutate(next);
  };

  /**
   * Hedef kuralı masaüstüyle ORTAK ayardan gelir (`plannerTargetMode`).
   *
   * Aynı kural iki uygulamada farklı çalışırsa aynı ürün için iki ayrı "kaç adet basmalı"
   * görünür. Kuralın kendisi `@/core/planner-target` içinde — masaüstü de onu çağırıyor.
   */
  const mod = parseHedefModu(settings?.plannerTargetMode);
  const kapsamGun = parseKapsamGun(settings?.plannerCoverDays);

  // Satış hızı yalnız "satışa göre" modunda gerekli — sabit modda sorgu hiç açılmaz.
  const { data: hiz } = useQuery({
    queryKey: ["sales-rate"],
    queryFn: getSatisHizi,
    enabled: mod === "talep",
    staleTime: 5 * 60_000,
  });

  const plan = useMemo<PlanItem[]>(() => {
    if (!data) return [];
    // Hız verisi henüz gelmediyse SABİT hedefe düş: yarım veriyle hesaplanmış bir plan
    // göstermektense bilinen davranışı göstermek daha doğru.
    const ayar: HedefAyari =
      mod === "talep" && hiz
        ? { mod: "talep", tavan: t, kapsamGun }
        : { mod: "sabit", tavan: t, kapsamGun };

    return data
      .filter((p) => !p.madeToOrder)
      .map((p) => {
        const hedef = hedefStok(ayar, hiz?.gunlukById.get(p.id) ?? 0);
        const printQty = basilacakAdet(hedef, p.stock);
        return {
          id: p.id,
          name: p.name,
          imageUrl: p.imageUrl,
          stock: p.stock,
          printQty,
          filament: printQty * (p.cost?.filamentWeight ?? 0),
        };
      })
      .filter((p) => p.printQty > 0)
      .sort((a, b) => a.stock - b.stock);
  }, [data, t, mod, kapsamGun, hiz]);

  const totalPrints = plan.reduce((s, p) => s + p.printQty, 0);
  const totalFilament = plan.reduce((s, p) => s + p.filament, 0);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Üretim Planlayıcı" />
      <View style={styles.targetRow}>
        <Text style={styles.targetLabel}>{mod === "talep" ? "En fazla" : "Hedef stok"}</Text>
        <View style={styles.stepper}>
          <PressableScale
            onPress={() => changeTarget(-1)}
            disabled={t <= 1}
            style={({ pressed }) => [styles.stepBtn, pressed && { opacity: 0.6 }, t <= 1 && { opacity: 0.3 }]}
          >
            <Text style={styles.stepBtnText}>−</Text>
          </PressableScale>
          <Text style={styles.stepValue}>{t}</Text>
          <PressableScale
            onPress={() => changeTarget(1)}
            style={({ pressed }) => [styles.stepBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.stepBtnText}>+</Text>
          </PressableScale>
        </View>
      </View>

      {error && !data ? (
        /* Ağ koptuğunda "Üretim gerekmiyor" YALANI yerine dürüst hata. */
        <ConnectionError error={error} onRetry={() => void refetch()} retrying={isFetching} />
      ) : isLoading ? (
        <SkeletonList count={4} />
      ) : plan.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emoji}>🎉</Text>
          <Text style={styles.dim}>Üretim gerekmiyor — tüm stoklar hedefin üstünde</Text>
        </View>
      ) : (
        <FlashList
          data={plan}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View style={styles.summary}>
              <Summary value={plan.length} label="ürün" />
              <Summary value={totalPrints} label="baskı" />
              <Summary value={totalFilament / 1000} label="filament" suffix=" kg" decimals={2} />
            </View>
          }
          ItemSeparatorComponent={RowGap}
          renderItem={({ item }) => (
            <PressableScale
              onPress={() => router.push(`/product/${item.id}`)}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: ML.cardElevated }]}
            >
              {item.imageUrl ? (
                <Image
                  source={{ uri: thumbUrl(item.imageUrl, 120)! }}
                  alt={item.name}
                  style={styles.thumb}
                  contentFit="cover"
                  recyclingKey={item.id}
                />
              ) : (
                <View style={[styles.thumb, styles.thumbEmpty]} />
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <View
                  style={[
                    styles.stockPill,
                    { backgroundColor: (item.stock <= 0 ? ML.red : ML.orange) + "22" },
                  ]}
                >
                  <Text
                    style={[styles.stockText, { color: item.stock <= 0 ? ML.red : ML.orange }]}
                  >
                    {item.stock <= 0 ? "Stok bitti" : `${item.stock} adet`}
                  </Text>
                </View>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.qty}>{item.printQty}×</Text>
                <Text style={styles.gram}>{Math.round(item.filament)}g</Text>
              </View>
            </PressableScale>
          )}
        />
      )}
    </SafeAreaView>
  );
}

/**
 * Özet hücresi — hedef stok +/- basıldıkça üç sayı da AKARAK değişir.
 * Eskiden metin olarak anında zıplıyordu; akış, hangi sayının ne kadar değiştiğini gösteriyor.
 * Rakamlar sabit genişlikte (tabular) → akarken hücre genişliği titremiyor.
 */
function Summary({
  value,
  label,
  suffix = "",
  decimals = 0,
}: {
  value: number;
  label: string;
  suffix?: string;
  decimals?: number;
}) {
  return (
    <View style={styles.sumCell}>
      <AnimatedNumber
        value={value}
        format={(n) => `${n.toFixed(decimals)}${suffix}`}
        style={[styles.sumValue, tabular]}
      />
      <Text style={styles.sumLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
  emoji: { fontSize: 40 },
  dim: { color: ML.textDim, fontSize: 14, textAlign: "center" },
  targetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  targetLabel: { color: ML.textDim, fontSize: 14 },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    overflow: "hidden",
  },
  stepBtn: { width: 44, height: 40, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: ML.accent, fontSize: 24, fontWeight: "700" },
  stepValue: { color: ML.text, fontSize: 18, fontWeight: "800", minWidth: 40, textAlign: "center" },
  list: { padding: 16, paddingBottom: 24 },
  summary: {
    flexDirection: "row",
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 14,
    marginBottom: 10,
  },
  sumCell: { flex: 1, alignItems: "center" },
  sumValue: { color: ML.accent, fontSize: 20, fontWeight: "800" },
  sumLabel: { color: ML.textFaint, fontSize: 12, marginTop: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 12,
  },
  thumb: { width: 46, height: 46, borderRadius: radius.md, backgroundColor: ML.cardElevated },
  thumbEmpty: { borderWidth: 1, borderColor: ML.border },
  name: { color: ML.text, fontSize: 14, fontWeight: "600" },
  stockPill: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, marginTop: 4 },
  stockText: { fontSize: 11, fontWeight: "700" },
  qty: { color: ML.text, fontSize: 18, fontWeight: "800" },
  gram: { color: ML.textFaint, fontSize: 12, fontVariant: ["tabular-nums"] },
});
