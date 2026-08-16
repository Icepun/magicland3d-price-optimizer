import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ConnectionError } from "@/components/ConnectionError";
import { ScreenHeader } from "@/components/form";
import { Card, Chip, Pill, SectionLabel, SkeletonList } from "@/components/ui";
import { PressableScale } from "@/components/ui/PressableScale";
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
import { formatCurrency } from "@/lib/format";
import { ML, radius, space, tabular, type } from "@/theme/colors";

/**
 * REKLAM BÜTÇESİ — günlük reklam harcaması, platform başına.
 *
 * NEDEN TELEFONDA: bu rakam TÜM kâr hesabını etkiliyor (her sipariş ciroya oranla reklam payı
 * taşıyor) ama yalnız masaüstünden girilebiliyordu. Kullanıcı reklamı telefondan açıp
 * kapatıyor; harcamayı günler sonra girince aradaki siparişlerin kârı yanlış kalıyordu.
 *
 * ⚠️ ESKİ DÖNEM SİLİNMEZ: geçmiş siparişlerin kârı kendi döneminin oranına bağlı. Yeni bütçe
 * eskisini bitirip başlar. Kaydettikten sonra donmuş kârlar (Raporlar) yeni oranla YENİDEN
 * YAZILIR — yoksa Siparişler yeni, Raporlar eski rakamı gösterirdi.
 */

function tarihYaz(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleDateString("tr-TR", { day: "2-digit", month: "short", year: "numeric" });
}

export default function AdBudgetScreen() {
  const qc = useQueryClient();
  const butceler = useQuery({ queryKey: ["ad-budgets"], queryFn: getAdBudgets });
  // Yürürlükteki oranlar kurallarla birlikte zaten hesaplanıyor (payda = dönemin cirosu).
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
      // Donmuş kârlar yeni reklam payıyla yeniden yazılsın (Raporlar ile Siparişler ayrışmasın).
      void syncFinanceFromCache(qc, { zorlaKarYaz: true });
      Alert.alert(
        "Bütçe kaydedildi",
        "Bu andan itibaren siparişler yeni reklam payını taşıyor. Raporlardaki kârlar arka planda güncelleniyor."
      );
    },
    onError: (e) => {
      Alert.alert(
        e instanceof AdBudgetOverlapError ? "Dönem çakışıyor" : "Kaydedilemedi",
        e instanceof Error ? e.message : "Reklam bütçesi kaydedilemedi."
      );
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

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Diğer tüm alt ekranlarla aynı başlık çubuğu. */}
      <ScreenHeader title="Reklam Bütçesi" />

      {butceler.error ? (
        <ConnectionError
          error={butceler.error}
          onRetry={() => void butceler.refetch()}
          retrying={butceler.isFetching}
        />
      ) : butceler.isLoading ? (
        <SkeletonList count={4} height={80} />
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <SectionLabel>Yeni dönem başlat</SectionLabel>
          <Card style={styles.form}>
            <View style={styles.chips}>
              {AD_PLATFORMS.map((p) => (
                <Chip
                  key={p}
                  label={AD_PLATFORM_LABEL[p]}
                  selected={platform === p}
                  onPress={() => setPlatform(p)}
                />
              ))}
            </View>
            <View style={styles.inputRow}>
              <Text style={styles.currency}>₺</Text>
              <TextInput
                value={tutar}
                onChangeText={setTutar}
                placeholder="Günlük tutar"
                placeholderTextColor={ML.textFaint}
                keyboardType="decimal-pad"
                style={[styles.input, tabular]}
                accessibilityLabel="Günlük reklam harcaması"
              />
              <Text style={styles.perDay}>/gün</Text>
            </View>
            <Text style={styles.hint}>
              Günlük harcama kâra doğrudan yansır. Bugünden itibaren geçerli olur. Aynı platformun yürürlükteki bütçesi kapanır — eski
              dönem silinmez, geçmiş siparişlerin kârı ona bağlıdır.
            </Text>
            <PressableScale
              onPress={() => kaydet.mutate()}
              disabled={!gecerliTutar || kaydet.isPending}
              haptic="orta"
              style={[styles.saveBtn, (!gecerliTutar || kaydet.isPending) && styles.saveBtnOff]}
              accessibilityRole="button"
            >
              <Text style={styles.saveText}>
                {kaydet.isPending ? "Kaydediliyor…" : "Bütçeyi başlat"}
              </Text>
            </PressableScale>
          </Card>

          <SectionLabel>Dönemler</SectionLabel>
          {liste.length === 0 ? (
            <Text style={styles.empty}>Henüz reklam bütçesi girilmemiş.</Text>
          ) : (
            liste.map((b) => {
              const yururlukte = b.isActive === 1 && b.validTo == null;
              const oran = oranlar.get(b.platform);
              return (
                <Card key={b.id} style={styles.row} accent={yururlukte ? ML.accent : undefined}>
                  <View style={styles.rowTop}>
                    <Text style={styles.platform}>
                      {AD_PLATFORM_LABEL[b.platform as AdPlatform] ?? b.platform}
                    </Text>
                    {yururlukte ? <Pill color={ML.green}>Yürürlükte</Pill> : null}
                  </View>
                  <Text style={[styles.amount, tabular]}>
                    {formatCurrency(b.dailyAmount)} <Text style={styles.perDaySmall}>/gün</Text>
                  </Text>
                  <Text style={styles.period}>
                    {tarihYaz(b.validFrom)} → {b.validTo == null ? "devam ediyor" : tarihYaz(b.validTo)}
                  </Text>
                  {yururlukte && oran != null ? (
                    <Text style={styles.rate}>Ciroya oranı: %{(oran * 100).toFixed(2)}</Text>
                  ) : null}
                  {yururlukte ? (
                    <PressableScale
                      onPress={() =>
                        Alert.alert("Reklamı durdur", "Bu bütçe bugün itibarıyla kapansın mı?", [
                          { text: "Vazgeç", style: "cancel" },
                          {
                            text: "Durdur",
                            style: "destructive",
                            onPress: () => durdur.mutate(b.id),
                          },
                        ])
                      }
                      haptic="orta"
                      style={styles.stopBtn}
                      accessibilityRole="button"
                    >
                      <Text style={styles.stopText}>Reklamı durdur</Text>
                    </PressableScale>
                  ) : null}
                </Card>
              );
            })
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  content: { padding: space.lg, paddingTop: 0, gap: space.md, paddingBottom: space.xxl },
  form: { gap: space.md },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  inputRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  currency: { ...type.heading, color: ML.textDim },
  input: {
    flex: 1,
    minHeight: 48,
    color: ML.text,
    fontSize: 20,
    fontWeight: "700",
    paddingHorizontal: space.sm,
    backgroundColor: ML.bg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: ML.borderSoft,
  },
  perDay: { ...type.small, color: ML.textDim },
  perDaySmall: { ...type.small, color: ML.textDim },
  hint: { ...type.small, color: ML.textFaint, lineHeight: 17 },
  saveBtn: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ML.accent,
    borderRadius: radius.md,
  },
  saveBtnOff: { opacity: 0.4 },
  saveText: { color: ML.bg, fontWeight: "800", fontSize: 16 },
  row: { gap: 4 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  platform: { ...type.heading, color: ML.text },
  amount: { ...type.title, color: ML.accent },
  period: { ...type.small, color: ML.textDim },
  rate: { ...type.small, color: ML.orange, fontWeight: "700" },
  stopBtn: {
    marginTop: space.sm,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.red,
  },
  stopText: { color: ML.red, fontWeight: "700" },
  empty: { ...type.small, color: ML.textFaint, textAlign: "center", paddingVertical: space.lg },
});
