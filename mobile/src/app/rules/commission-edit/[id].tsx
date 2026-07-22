import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { DeleteButton, Field, PrimaryButton, ScreenHeader, TextField } from "@/components/form";
import {
  createCommissionRule,
  deleteCommissionRule,
  getAllCommissionRules,
  updateCommissionRule,
  type CommissionRuleFull,
} from "@/lib/db/rule-crud";
import { parseTrNumber } from "@/lib/number";
import { ML } from "@/theme/colors";

export default function CommissionEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const rulesQuery = useQuery({
    queryKey: ["commission-rules-all"],
    queryFn: getAllCommissionRules,
    enabled: !isNew,
    refetchOnMount: "always",
  });
  const [dataUpdatedAtOnMount] = useState(rulesQuery.dataUpdatedAt);
  const hasFreshData = rulesQuery.dataUpdatedAt > dataUpdatedAtOnMount;
  const existing = isNew ? null : rulesQuery.data?.find((rule) => rule.id === id);

  if (!isNew && (!hasFreshData || !existing)) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader title="Komisyon Düzenle" />
        <View style={styles.center}>
          {rulesQuery.isPending || rulesQuery.isFetching || !rulesQuery.isFetchedAfterMount ? (
            <ActivityIndicator color={ML.accent} size="large" />
          ) : (
            <>
              <Text style={styles.message}>
                {rulesQuery.error instanceof Error
                  ? rulesQuery.error.message
                  : "Komisyon kuralı bulunamadı."}
              </Text>
              <PrimaryButton
                label="Tekrar dene"
                onPress={() => void rulesQuery.refetch()}
                loading={rulesQuery.isFetching}
              />
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return <CommissionEditForm key={existing?.id ?? "new"} id={id} existing={existing ?? null} />;
}

function CommissionEditForm({
  id,
  existing,
}: {
  id: string;
  existing: CommissionRuleFull | null;
}) {
  const isNew = existing === null;
  const qc = useQueryClient();

  const [name, setName] = useState(existing?.name ?? "");
  const [category, setCategory] = useState(existing?.categoryName ?? "");
  const [rate, setRate] = useState(existing ? String(existing.commissionRate * 100) : "");
  const [fixed, setFixed] = useState(
    existing?.fixedCommission ? String(existing.fixedCommission) : "",
  );
  const [minP, setMinP] = useState(existing ? String(existing.minPrice) : "0");
  const [maxP, setMaxP] = useState(existing ? String(existing.maxPrice) : "999999");

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["commission-rules-all"] });
    qc.invalidateQueries({ queryKey: ["rules"] });
  }

  const save = useMutation({
    mutationFn: async () => {
      const parsedRate = parseTrNumber(rate);
      const parsedFixed = fixed.trim() ? parseTrNumber(fixed) : 0;
      const parsedMinPrice = parseTrNumber(minP);
      const parsedMaxPrice = parseTrNumber(maxP);

      if (
        parsedRate === null ||
        parsedFixed === null ||
        parsedMinPrice === null ||
        parsedMaxPrice === null
      ) {
        throw new Error("Lütfen tüm sayısal alanlara geçerli bir değer girin.");
      }
      if (parsedRate < 0 || parsedRate > 100) {
        throw new Error("Komisyon oranı 0 ile 100 arasında olmalı.");
      }
      if (parsedFixed < 0) {
        throw new Error("Sabit komisyon negatif olamaz.");
      }
      if (parsedMinPrice < 0 || parsedMaxPrice < parsedMinPrice) {
        throw new Error("Fiyat aralığı geçersiz.");
      }

      const draft = {
        name: name.trim() || "Komisyon",
        categoryName: category.trim() || null,
        commissionRate: parsedRate / 100,
        fixedCommission: parsedFixed,
        minPrice: parsedMinPrice,
        maxPrice: parsedMaxPrice,
      };
      if (isNew) await createCommissionRule(draft);
      else await updateCommissionRule(id, draft);
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      invalidate();
      router.back();
    },
    onError: (error) => Alert.alert("Kaydedilemedi", error.message),
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  message: { color: ML.textDim, fontSize: 14, textAlign: "center" },
  content: { padding: 16, gap: 18, paddingBottom: 60 },
  row: { flexDirection: "row", gap: 12 },
});
