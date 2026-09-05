import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { Chip, Pill } from "@/components/kit/Chip";
import { Button, EmptyState, ErrorState, FadeInView, Glass, Input, Money, Screen, ShimmerList, SubHeader, Tint, Txt } from "@/components/kit";
import {
  AD_PLATFORMS,
  AD_PLATFORM_LABEL,
  AdBudgetOverlapError,
  getAdBudgets,
  saveAdBudget,
  stopAdBudget,
  type AdPlatform,
} from "@/lib/db/ad-budgets";
import { getRules } from "@/lib/db/rules";
import { syncFinanceFromCache } from "@/lib/finance-sync";
import { color, space } from "@/theme/tokens";

/**
 * REKLAM BÜTÇESİ — günlük reklam harcaması, platform başına. Bu rakam TÜM kâr hesabını etkiler.
 * ⚠️ Eski dönem silinmez (geçmiş siparişlerin kârı ona bağlı); yeni bütçe eskisini kapatıp başlar,
 * donmuş kârlar yeni oranla yeniden yazılır. Mantık öncekiyle aynı; sunum kit'e taşındı.
 */

function tarihYaz(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleDateString("tr-TR", { day: "2-digit", month: "short", year: "numeric" });
}

export default function AdBudgetScreen() {
  const qc = useQueryClient();
  const butceler = useQuery({ queryKey: ["ad-budgets"], queryFn: getAdBudgets });
  const rules = useQuery({ queryKey: ["rules"], queryFn: getRules });

  const [platform, setPlatform] = useState<AdPlatform>("all");
  const [tutar, setTutar] = useState("");

  const oranlar = new Map((rules.data?.adBudgets ?? []).map((b) => [b.platform, b.oran]));

  const kaydet = useMutation({
    mutationFn: async () => {
      const deger = Number(tutar.replace(",", "."));
      await saveAdBudget({ platform, dailyAmount: deger, startsAt: new Date() });
    },
    onSuccess: async () => {
      setTutar("");
      await qc.invalidateQueries({ queryKey: ["ad-budgets"] });
      await qc.invalidateQueries({ queryKey: ["rules"] });
      void syncFinanceFromCache(qc, { zorlaKarYaz: true });
      Alert.alert("Bütçe kaydedildi", "Bu andan itibaren siparişler yeni reklam payını taşıyor. Raporlardaki kârlar arka planda güncelleniyor.");
    },
    onError: (e) => {
      Alert.alert(e instanceof AdBudgetOverlapError ? "Dönem çakışıyor" : "Kaydedilemedi", e instanceof Error ? e.message : "Reklam bütçesi kaydedilemedi.");
    },
  });

  const durdur = useMutation({
    mutationFn: (id: string) => stopAdBudget(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["ad-budgets"] });
      await qc.invalidateQueries({ queryKey: ["rules"] });
      void syncFinanceFromCache(qc, { zorlaKarYaz: true });
    },
  });

  const liste = butceler.data ?? [];
  const gecerliTutar = Number(tutar.replace(",", ".")) >= 0 && tutar.trim().length > 0;
  const yururlukteSayisi = liste.filter((b) => b.isActive === 1 && b.validTo == null).length;

  return (
    <Screen header={<SubHeader title="Reklam bütçesi" subtitle={liste.length ? `${yururlukteSayisi} yürürlükte · ${liste.length} dönem` : undefined} />}>
      {butceler.error ? (
        <ErrorState error={butceler.error} onRetry={() => void butceler.refetch()} retrying={butceler.isFetching} />
      ) : butceler.isLoading ? (
        <ShimmerList count={4} height={96} />
      ) : (
        <>
          <Txt v="label" tone="faint" style={styles.section}>
            YENİ DÖNEM BAŞLAT
          </Txt>
          <FadeInView index={0}>
            <Glass style={styles.form}>
              <View style={styles.chips}>
                {AD_PLATFORMS.map((p) => (
                  <Chip key={p} label={AD_PLATFORM_LABEL[p]} selected={platform === p} onPress={() => setPlatform(p)} />
                ))}
              </View>
              <Input
                value={tutar}
                onChangeText={setTutar}
                numeric
                placeholder="Günlük tutar"
                icon="turkishlirasign"
                suffix="₺ / gün"
                accessibilityLabel="Günlük reklam harcaması"
              />
              <Txt v="small" tone="faint">
                Günlük harcama kâra doğrudan yansır ve bugünden itibaren geçerli olur. Aynı platformun yürürlükteki bütçesi kapanır; eski dönem
                silinmez, geçmiş siparişlerin kârı ona bağlıdır.
              </Txt>
              <Button label="Bütçeyi başlat" icon="play.fill" onPress={() => kaydet.mutate()} disabled={!gecerliTutar} loading={kaydet.isPending} />
            </Glass>
          </FadeInView>

          <Txt v="label" tone="faint" style={styles.section}>
            DÖNEMLER
          </Txt>
          {liste.length === 0 ? (
            <EmptyState icon="megaphone" title="Henüz reklam bütçesi yok" hint="Yukarıdan platform seçip günlük tutarı gir." />
          ) : (
            liste.map((b, i) => {
              const yururlukte = b.isActive === 1 && b.validTo == null;
              const oran = oranlar.get(b.platform);
              return (
                <FadeInView key={b.id} index={i + 1}>
                  <Tint strong style={[styles.row, yururlukte ? styles.rowActive : null]}>
                    <View style={styles.rowTop}>
                      <Txt v="heading">{AD_PLATFORM_LABEL[b.platform as AdPlatform] ?? b.platform}</Txt>
                      {yururlukte ? <Pill color={color.good}>Yürürlükte</Pill> : <Pill color={color.textFaint}>Kapandı</Pill>}
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                      <Money value={b.dailyAmount} v="title" tone={yururlukte ? "accent" : "dim"} animate={false} />
                      <Txt v="small" tone="dim">
                        / gün
                      </Txt>
                    </View>
                    <Txt v="small" tone="dim" num>
                      {tarihYaz(b.validFrom)} → {b.validTo == null ? "devam ediyor" : tarihYaz(b.validTo)}
                    </Txt>
                    {yururlukte && oran != null ? (
                      <Txt v="smallStrong" tone="warn" num>
                        Ciroya oranı %{(oran * 100).toFixed(2)}
                      </Txt>
                    ) : null}
                    {yururlukte ? (
                      <Button
                        label="Reklamı durdur"
                        icon="stop.fill"
                        variant="danger"
                        size="sm"
                        onPress={() =>
                          Alert.alert("Reklamı durdur", "Bu bütçe bugün itibarıyla kapansın mı?", [
                            { text: "Vazgeç", style: "cancel" },
                            { text: "Durdur", style: "destructive", onPress: () => durdur.mutate(b.id) },
                          ])
                        }
                        style={{ alignSelf: "flex-start", marginTop: space.xs }}
                      />
                    ) : null}
                  </Tint>
                </FadeInView>
              );
            })
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { letterSpacing: 1.2, marginTop: space.sm, marginLeft: space.xs },
  form: { gap: space.md },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  row: { gap: 4 },
  rowActive: { borderColor: color.accent + "66" },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
});
