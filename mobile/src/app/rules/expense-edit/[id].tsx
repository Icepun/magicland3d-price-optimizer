import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { DeleteButton, Field, PrimaryButton, Segmented, TextField } from "@/components/form";
import { ErrorState, Screen, SubHeader, Tint } from "@/components/kit";
import { FormShimmer } from "@/components/kit/FormShimmer";
import {
  createExpenseRule,
  deleteExpenseRule,
  getAllExpenseRules,
  updateExpenseRule,
  type ExpenseRuleFull,
  type ExpenseType,
} from "@/lib/db/rule-crud";
import { parseTrNumber } from "@/lib/number";
import { space } from "@/theme/tokens";

const PLATFORMS = [
  { key: "all", label: "Tümü" },
  { key: "shopify", label: "Shopify" },
  { key: "trendyol", label: "Trendyol" },
  { key: "hepsiburada", label: "HB" },
];
const TYPES: { key: ExpenseType; label: string }[] = [
  { key: "percentage", label: "Yüzde %" },
  { key: "per_order", label: "Sipariş başına ₺" },
];

export default function ExpenseEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const rulesQuery = useQuery({
    queryKey: ["expense-rules-all"],
    queryFn: getAllExpenseRules,
    enabled: !isNew,
    refetchOnMount: "always",
  });
  const [dataUpdatedAtOnMount] = useState(rulesQuery.dataUpdatedAt);
  const hasFreshData = rulesQuery.dataUpdatedAt > dataUpdatedAtOnMount;
  const existing = isNew ? null : rulesQuery.data?.find((rule) => rule.id === id);

  if (!isNew && (!hasFreshData || !existing)) {
    return (
      <Screen header={<SubHeader title="Gider kuralı" />}>
        {rulesQuery.isPending || rulesQuery.isFetching || !rulesQuery.isFetchedAfterMount ? (
          <FormShimmer rows={5} />
        ) : (
          <ErrorState
            title="Kural yüklenemedi"
            error={rulesQuery.error ?? new Error("Gider kuralı bulunamadı.")}
            onRetry={() => void rulesQuery.refetch()}
            retrying={rulesQuery.isFetching}
          />
        )}
      </Screen>
    );
  }

  return <ExpenseEditForm key={existing?.id ?? "new"} id={id} existing={existing ?? null} />;
}

function ExpenseEditForm({ id, existing }: { id: string; existing: ExpenseRuleFull | null }) {
  const isNew = existing === null;
  const qc = useQueryClient();

  const [name, setName] = useState(existing?.name ?? "");
  const [platform, setPlatform] = useState<string>(existing?.platform ?? "all");
  const [type, setType] = useState<ExpenseType>(existing?.type === "fixed" ? "per_order" : (existing?.type ?? "per_order"));
  const [value, setValue] = useState(existing ? (existing.type === "percentage" ? String(existing.value * 100) : String(existing.value)) : "");
  const [category, setCategory] = useState(existing?.categoryName ?? "");
  const [minPrice, setMinPrice] = useState(existing ? String(existing.minPrice) : "0");
  const [maxPrice, setMaxPrice] = useState(existing ? String(existing.maxPrice) : "999999");

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["expense-rules-all"] });
    qc.invalidateQueries({ queryKey: ["rules"] });
  }

  const save = useMutation({
    mutationFn: async () => {
      const raw = parseTrNumber(value);
      const parsedMinPrice = parseTrNumber(minPrice);
      const parsedMaxPrice = parseTrNumber(maxPrice);

      if (raw === null || parsedMinPrice === null || parsedMaxPrice === null) {
        throw new Error("Lütfen tüm sayısal alanlara geçerli bir değer girin.");
      }
      if (raw < 0 || (type === "percentage" && raw > 100)) {
        throw new Error(type === "percentage" ? "Yüzde değeri 0 ile 100 arasında olmalı." : "Gider değeri negatif olamaz.");
      }
      if (parsedMinPrice < 0 || parsedMaxPrice < parsedMinPrice) {
        throw new Error("Fiyat aralığı geçersiz.");
      }

      const draft = {
        name: name.trim() || "Gider",
        platform: platform === "all" ? null : platform,
        type,
        value: type === "percentage" ? raw / 100 : raw,
        categoryName: category.trim() || null,
        minPrice: parsedMinPrice,
        maxPrice: parsedMaxPrice,
      };
      if (isNew) await createExpenseRule(draft);
      else await updateExpenseRule(id, draft);
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      invalidate();
      router.back();
    },
    onError: (error) => Alert.alert("Kaydedilemedi", error.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteExpenseRule(id),
    onSuccess: () => {
      invalidate();
      router.back();
    },
  });

  return (
    <Screen header={<SubHeader title={isNew ? "Yeni gider kuralı" : "Gider kuralı"} subtitle={existing?.name} />}>
      <Tint strong style={styles.card}>
        <Field label="Gider adı">
          <TextField value={name} onChange={setName} placeholder="Platform Hizmet Bedeli" />
        </Field>
        <Field label="Platform">
          <Segmented items={PLATFORMS} selected={platform} onSelect={setPlatform} />
        </Field>
        <Field label="Tip">
          <Segmented items={TYPES} selected={type} onSelect={(k) => setType(k)} />
        </Field>
        <Field label={type === "percentage" ? "Değer (%)" : "Değer (₺)"}>
          <TextField value={value} onChange={setValue} placeholder="0" numeric />
        </Field>
      </Tint>

      <Tint strong style={styles.card}>
        <Field label="Kategori (isteğe bağlı)">
          <TextField value={category} onChange={setCategory} placeholder="Boş = tüm kategoriler" />
        </Field>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Field label="Min fiyat (₺)">
              <TextField value={minPrice} onChange={setMinPrice} numeric />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Max fiyat (₺)">
              <TextField value={maxPrice} onChange={setMaxPrice} numeric />
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
