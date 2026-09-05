import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { basilacakAdet, hedefStok, parseHedefModu, parseKapsamGun, type HedefAyari } from "@/core/planner-target";
import { Pill } from "@/components/kit/Chip";
import { Count, EmptyState, ErrorState, FadeInView, Glass, IconButton, Screen, ShimmerList, SubHeader, Tint, Txt } from "@/components/kit";
import { getDashboardData } from "@/lib/db/dashboard";
import { updateSetting } from "@/lib/db/rule-crud";
import { getSettingsMap } from "@/lib/db/rules";
import { getSatisHizi } from "@/lib/db/sales-rate";
import { formatNumber } from "@/lib/format";
import { thumbUrl } from "@/lib/image";
import { color, radius, space } from "@/theme/tokens";

interface PlanItem {
  id: string;
  name: string;
  imageUrl: string | null;
  stock: number;
  printQty: number;
  filament: number;
}

const RowGap = () => <View style={{ height: space.sm }} />;

/**
 * ÜRETİM PLANI — hedef stok (masaüstüyle ortak ayar) altına düşen ürünler ve kaç adet basılacağı.
 * Hedef kuralı `@/core/planner-target` (masaüstüyle aynı). Veri katmanı öncekiyle aynı.
 */
export default function PlannerScreen() {
  const qc = useQueryClient();
  const { data, isLoading, refetch, error, isFetching } = useQuery({ queryKey: ["dashboard-data"], queryFn: getDashboardData });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

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

  const mod = parseHedefModu(settings?.plannerTargetMode);
  const kapsamGun = parseKapsamGun(settings?.plannerCoverDays);

  const { data: hiz } = useQuery({
    queryKey: ["sales-rate"],
    queryFn: getSatisHizi,
    enabled: mod === "talep",
    staleTime: 5 * 60_000,
  });

  const plan = useMemo<PlanItem[]>(() => {
    if (!data) return [];
    const ayar: HedefAyari = mod === "talep" && hiz ? { mod: "talep", tavan: t, kapsamGun } : { mod: "sabit", tavan: t, kapsamGun };
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
    <Screen
      scroll={false}
      padded={false}
      header={<SubHeader title="Üretim planı" subtitle={mod === "talep" ? `satışa göre · ${kapsamGun} gün kapsam` : "sabit hedef"} />}
    >
      <View style={styles.pad}>
        <Glass style={styles.target}>
          <View style={{ flex: 1 }}>
            <Txt v="label" tone="faint" style={{ letterSpacing: 1 }}>
              {mod === "talep" ? "EN FAZLA" : "HEDEF STOK"}
            </Txt>
            <Txt v="small" tone="dim">
              Ürün başına bulunması gereken adet
            </Txt>
          </View>
          <View style={styles.stepper}>
            <IconButton icon="minus" size={40} onPress={() => changeTarget(-1)} accessibilityLabel="Hedefi azalt" style={t <= 1 ? { opacity: 0.35 } : null} />
            <Count value={t} v="title" style={{ minWidth: 44, textAlign: "center" }} />
            <IconButton icon="plus" size={40} accent onPress={() => changeTarget(1)} accessibilityLabel="Hedefi artır" />
          </View>
        </Glass>
      </View>

      {error && !data ? (
        <View style={styles.pad}>
          <ErrorState error={error} onRetry={() => void refetch()} retrying={isFetching} />
        </View>
      ) : isLoading ? (
        <View style={styles.pad}>
          <ShimmerList count={5} height={76} />
        </View>
      ) : plan.length === 0 ? (
        <EmptyState icon="checkmark.seal.fill" title="Üretim gerekmiyor" hint="Tüm stoklar hedefin üstünde." />
      ) : (
        <FlashList
          data={plan}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Tint strong style={styles.summary}>
              <Ozet value={plan.length} label="ürün" />
              <View style={styles.sep} />
              <Ozet value={totalPrints} label="baskı" />
              <View style={styles.sep} />
              <Ozet value={totalFilament / 1000} label="filament" format={(n) => `${formatNumber(n, 2)} kg`} />
            </Tint>
          }
          ItemSeparatorComponent={RowGap}
          renderItem={({ item, index }) => (
            <FadeInView index={index}>
              <Tint strong onPress={() => router.push(`/product/${item.id}`)} style={styles.row} accessibilityLabel={item.name}>
                {item.imageUrl ? (
                  <Image source={{ uri: thumbUrl(item.imageUrl, 120)! }} alt={item.name} style={styles.thumb} contentFit="cover" recyclingKey={item.id} />
                ) : (
                  <View style={[styles.thumb, styles.thumbEmpty]}>
                    <SymbolView name="cube.box" tintColor={color.textFaint} style={{ width: 18, height: 18 }} />
                  </View>
                )}
                <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
                  <Txt v="bodyStrong" numberOfLines={1}>
                    {item.name}
                  </Txt>
                  <Pill color={item.stock <= 0 ? color.bad : color.warn}>{item.stock <= 0 ? "Stok bitti" : `${item.stock} adet`}</Pill>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Txt v="title" tone="accent" num>
                    {item.printQty}×
                  </Txt>
                  <Txt v="small" tone="faint" num>
                    {Math.round(item.filament)}g
                  </Txt>
                </View>
              </Tint>
            </FadeInView>
          )}
        />
      )}
    </Screen>
  );
}

function Ozet({ value, label, format }: { value: number; label: string; format?: (n: number) => string }) {
  return (
    <View style={styles.sumCell}>
      <Count value={value} v="heading" tone="accent" format={format} />
      <Txt v="small" tone="faint">
        {label}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  target: { flexDirection: "row", alignItems: "center", gap: space.md },
  stepper: { flexDirection: "row", alignItems: "center", gap: space.xs },
  list: { paddingHorizontal: space.lg, paddingBottom: space.xxl },
  summary: { flexDirection: "row", alignItems: "center", marginBottom: space.sm },
  sumCell: { flex: 1, alignItems: "center", gap: 2 },
  sep: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: color.lineStrong },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  thumb: { width: 48, height: 48, borderRadius: radius.sm, backgroundColor: color.tint },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
});
