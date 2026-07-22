import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
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
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  const [vals, setVals] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!settings) return;
    const next: Record<string, string> = {};
    for (const f of FIELDS) next[f.key] = settings[f.key] ?? f.fallback;
    setVals(next);
  }, [settings]);

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
  content: { padding: 16, gap: 18, paddingBottom: 40 },
});
