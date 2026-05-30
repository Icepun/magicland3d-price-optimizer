import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Field, PrimaryButton, ScreenHeader, TextField } from "@/components/form";
import { getSettingsMap } from "@/lib/db/rules";
import { updateSetting } from "@/lib/db/rule-crud";
import { ML } from "@/theme/colors";

const FIELDS: { key: string; label: string; fallback: string }[] = [
  { key: "vatRate", label: "KDV ORANI (%)", fallback: "20" },
  { key: "shopifyCommissionRate", label: "SHOPIFY KOMİSYON (%)", fallback: "3.2" },
  { key: "discountBuffer", label: "İNDİRİM PAYI (%)", fallback: "0" },
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
    mutationFn: async () => {
      for (const f of FIELDS) {
        await updateSetting(f.key, vals[f.key] ?? f.fallback);
      }
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["dashboard-data"] });
      qc.invalidateQueries({ queryKey: ["product"] });
      router.back();
    },
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
