import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { DeleteButton, Field, PrimaryButton, ScreenHeader, TextField } from "@/components/form";
import {
  createCommissionRule,
  deleteCommissionRule,
  getAllCommissionRules,
  updateCommissionRule,
} from "@/lib/db/rule-crud";
import { ML } from "@/theme/colors";

export default function CommissionEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const qc = useQueryClient();
  const { data: all } = useQuery({ queryKey: ["commission-rules-all"], queryFn: getAllCommissionRules });
  const existing = isNew ? null : all?.find((r) => r.id === id);

  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [rate, setRate] = useState("");
  const [fixed, setFixed] = useState("");
  const [minP, setMinP] = useState("0");
  const [maxP, setMaxP] = useState("999999");

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setCategory(existing.categoryName ?? "");
    setRate(String(existing.commissionRate * 100));
    setFixed(existing.fixedCommission ? String(existing.fixedCommission) : "");
    setMinP(String(existing.minPrice));
    setMaxP(String(existing.maxPrice));
  }, [existing]);

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["commission-rules-all"] });
    qc.invalidateQueries({ queryKey: ["rules"] });
  }

  const save = useMutation({
    mutationFn: async () => {
      const draft = {
        name: name.trim() || "Komisyon",
        categoryName: category.trim() || null,
        commissionRate: (parseFloat(rate) || 0) / 100,
        fixedCommission: parseFloat(fixed) || 0,
        minPrice: parseFloat(minP) || 0,
        maxPrice: parseFloat(maxP) || 999999,
      };
      if (isNew) await createCommissionRule(draft);
      else await updateCommissionRule(id, draft);
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      invalidate();
      router.back();
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteCommissionRule(id),
    onSuccess: () => {
      invalidate();
      router.back();
    },
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title={isNew ? "Yeni Komisyon" : "Komisyon Düzenle"} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Field label="KURAL ADI">
          <TextField value={name} onChange={setName} placeholder="Trendyol Oyuncak" />
        </Field>
        <Field label="KATEGORİ (opsiyonel)">
          <TextField value={category} onChange={setCategory} placeholder="Boş = tüm kategoriler" />
        </Field>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Field label="ORAN (%)">
              <TextField value={rate} onChange={setRate} placeholder="21" numeric />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="SABİT (₺)">
              <TextField value={fixed} onChange={setFixed} placeholder="0" numeric />
            </Field>
          </View>
        </View>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Field label="MİN FİYAT (₺)">
              <TextField value={minP} onChange={setMinP} numeric />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="MAX FİYAT (₺)">
              <TextField value={maxP} onChange={setMaxP} numeric />
            </Field>
          </View>
        </View>

        <PrimaryButton
          label={isNew ? "Oluştur" : "Kaydet"}
          onPress={() => save.mutate()}
          loading={save.isPending}
        />
        {!isNew && (
          <DeleteButton
            onPress={() =>
              Alert.alert("Kuralı sil?", existing?.name ?? "", [
                { text: "Vazgeç", style: "cancel" },
                { text: "Sil", style: "destructive", onPress: () => remove.mutate() },
              ])
            }
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  content: { padding: 16, gap: 18, paddingBottom: 60 },
  row: { flexDirection: "row", gap: 12 },
});
