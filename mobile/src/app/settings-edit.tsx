import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Field, PrimaryButton, ScreenHeader, TextField } from "@/components/form";
import { getSettingsMap } from "@/lib/db/rules";
import { updateSettings } from "@/lib/db/rule-crud";
import { parseTrNumber } from "@/lib/number";
import { ML } from "@/theme/colors";

const FIELDS: { key: string; label: string; fallback: string; max?: number }[] = [
  { key: "vatRate", label: "KDV ORANI (%)", fallback: "20", max: 100 },
  { key: "shopifyCommissionRate", label: "SHOPIFY KOMİSYON (%)", fallback: "3.2", max: 100 },
  { key: "discountBuffer", label: "İNDİRİM PAYI (%)", fallback: "0", max: 100 },
  { key: "costElectricityPerHour", label: "ELEKTRİK / SAAT (₺)", fallback: "0" },
  { key: "costLaborPerHour", label: "İŞÇİLİK / SAAT (₺)", fallback: "0" },
  { key: "costMachineWearPerHour", label: "MAKİNE AŞINMA / SAAT (₺)", fallback: "0" },
];

export default function SettingsEditScreen() {
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: getSettingsMap,
    refetchOnMount: "always",
  });
  const [dataUpdatedAtOnMount] = useState(settingsQuery.dataUpdatedAt);
  const hasFreshData = settingsQuery.dataUpdatedAt > dataUpdatedAtOnMount;

  if (!hasFreshData || !settingsQuery.data) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader title="Genel Ayarlar" />
        <View style={styles.center}>
          {settingsQuery.isPending || settingsQuery.isFetching || !settingsQuery.isFetchedAfterMount ? (
            <ActivityIndicator color={ML.accent} size="large" />
          ) : (
            <>
              <Text style={styles.message}>
                {settingsQuery.error instanceof Error
                  ? settingsQuery.error.message
                  : "Ayarlar yüklenemedi."}
              </Text>
              <PrimaryButton
                label="Tekrar dene"
                onPress={() => void settingsQuery.refetch()}
                loading={settingsQuery.isFetching}
              />
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return <SettingsEditForm settings={settingsQuery.data} />;
}

function SettingsEditForm({ settings }: { settings: Record<string, string> }) {
  const qc = useQueryClient();
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((field) => [field.key, settings[field.key] ?? field.fallback])),
  );

  const save = useMutation({
    // Tek batch round-trip (eski hali 6 ardışık upsert ~300-1200ms + yarıda kalma riskiydi).
    mutationFn: () => {
      const normalized = Object.fromEntries(
        FIELDS.map((field) => {
          const parsed = parseTrNumber(vals[field.key] ?? field.fallback);
          if (parsed === null) {
            throw new Error(`${field.label} için geçerli bir sayı girin.`);
          }
          if (parsed < 0 || (field.max != null && parsed > field.max)) {
            throw new Error(
              field.max == null
                ? `${field.label} negatif olamaz.`
                : `${field.label} 0 ile ${field.max} arasında olmalı.`,
            );
          }
          return [field.key, String(parsed)];
        }),
      );
      return updateSettings(normalized);
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ["settings"] });
      router.back();
    },
    onError: (error) => Alert.alert("Kaydedilemedi", error.message),
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Genel Ayarlar" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <TextField
              value={vals[f.key] ?? ""}
              onChange={(v) => setVals((p) => ({ ...p, [f.key]: v }))}
              numeric
            />
          </Field>
        ))}
        <PrimaryButton label="Kaydet" onPress={() => save.mutate()} loading={save.isPending} />
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  message: { color: ML.textDim, fontSize: 14, textAlign: "center" },
  content: { padding: 16, gap: 18, paddingBottom: 40 },
});
