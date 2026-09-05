import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { DeleteButton, Field, PrimaryButton, TextField } from "@/components/form";
import { ErrorState, Screen, SubHeader, Tint } from "@/components/kit";
import { FormShimmer } from "@/components/kit/FormShimmer";
import {
  createCommissionRule,
  deleteCommissionRule,
  getAllCommissionRules,
  updateCommissionRule,
  type CommissionRuleFull,
} from "@/lib/db/rule-crud";
import { parseTrNumber } from "@/lib/number";
import { space } from "@/theme/tokens";

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
      <Screen header={<SubHeader title="Komisyon kuralı" />}>
        {rulesQuery.isPending || rulesQuery.isFetching || !rulesQuery.isFetchedAfterMount ? (
          <FormShimmer rows={5} />
        ) : (
          <ErrorState
            title="Kural yüklenemedi"
            error={rulesQuery.error ?? new Error("Komisyon kuralı bulunamadı.")}
            onRetry={() => void rulesQuery.refetch()}
            retrying={rulesQuery.isFetching}
          />
        )}
      </Screen>
    );
  }

  return <CommissionEditForm key={existing?.id ?? "new"} id={id} existing={existing ?? null} />;
}

function CommissionEditForm({ id, existing }: { id: string; existing: CommissionRuleFull | null }) {
  const isNew = existing === null;
  const qc = useQueryClient();

  const [name, setName] = useState(existing?.name ?? "");
  const [category, setCategory] = useState(existing?.categoryName ?? "");
  const [rate, setRate] = useState(existing ? String(existing.commissionRate * 100) : "");
  const [fixed, setFixed] = useState(existing?.fixedCommission ? String(existing.fixedCommission) : "");
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

      if (parsedRate === null || parsedFixed === null || parsedMinPrice === null || parsedMaxPrice === null) {
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
    <Screen header={<SubHeader title={isNew ? "Yeni komisyon kuralı" : "Komisyon kuralı"} subtitle={existing?.name} />}>
      <Tint strong style={styles.card}>
        <Field label="Kural adı">
          <TextField value={name} onChange={setName} placeholder="Trendyol Oyuncak" />
        </Field>
        <Field label="Kategori (isteğe bağlı)">
          <TextField value={category} onChange={setCategory} placeholder="Boş = tüm kategoriler" />
        </Field>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Field label="Oran (%)">
              <TextField value={rate} onChange={setRate} placeholder="21" numeric />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Sabit (₺)">
              <TextField value={fixed} onChange={setFixed} placeholder="0" numeric />
            </Field>
          </View>
        </View>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Field label="Min fiyat (₺)">
              <TextField value={minP} onChange={setMinP} numeric />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Max fiyat (₺)">
              <TextField value={maxP} onChange={setMaxP} numeric />
            </Field>
          </View>
        </View>
      </Tint>

      <PrimaryButton label={isNew ? "Oluştur" : "Kaydet"} onPress={() => save.mutate()} loading={save.isPending} />
      {!isNew ? (
        <DeleteButton
          onPress={() =>
            Alert.alert("Kuralı sil?", existing?.name ?? "", [
              { text: "Vazgeç", style: "cancel" },
              { text: "Sil", style: "destructive", onPress: () => remove.mutate() },
            ])
          }
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  row: { flexDirection: "row", gap: space.sm },
});
