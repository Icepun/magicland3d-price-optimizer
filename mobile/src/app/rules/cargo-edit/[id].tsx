import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { DeleteButton, Field, PrimaryButton, Segmented, TextField } from "@/components/form";
import { ErrorState, Screen, SubHeader, Tint, Txt } from "@/components/kit";
import { FormShimmer } from "@/components/kit/FormShimmer";
import { createCargoRule, deleteCargoRule, getAllCargoRules, updateCargoRule, type CargoRuleFull } from "@/lib/db/rule-crud";
import { parseTrNumber } from "@/lib/number";
import { space } from "@/theme/tokens";

/**
 * Elle kargo kuralı YALNIZ Shopify içindir (Trendyol/HB pazaryerinin listesinden gelir).
 * "Tümü" seçeneği kaldırıldı: platformsuz kural bir sonraki güncellemede Trendyol'a taşınıp
 * Shopify siparişlerinde etkisiz kalıyordu (denetim, 23 Kas 2026).
 */

export default function CargoEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const rulesQuery = useQuery({
    queryKey: ["cargo-rules-all"],
    queryFn: getAllCargoRules,
    enabled: !isNew,
    refetchOnMount: "always",
  });
  const [dataUpdatedAtOnMount] = useState(rulesQuery.dataUpdatedAt);
  const hasFreshData = rulesQuery.dataUpdatedAt > dataUpdatedAtOnMount;
  const existing = isNew ? null : rulesQuery.data?.find((rule) => rule.id === id);

  if (!isNew && (!hasFreshData || !existing)) {
    return (
      <Screen header={<SubHeader title="Kargo kuralı" />}>
        {rulesQuery.isPending || rulesQuery.isFetching || !rulesQuery.isFetchedAfterMount ? (
          <FormShimmer rows={6} />
        ) : (
          <ErrorState
            title="Kural yüklenemedi"
            error={rulesQuery.error ?? new Error("Kargo kuralı bulunamadı.")}
            onRetry={() => void rulesQuery.refetch()}
            retrying={rulesQuery.isFetching}
          />
        )}
      </Screen>
    );
  }

  return <CargoEditForm key={existing?.id ?? "new"} id={id} existing={existing ?? null} />;
}

function CargoEditForm({ id, existing }: { id: string; existing: CargoRuleFull | null }) {
  const isNew = existing === null;
  const qc = useQueryClient();

  const [name, setName] = useState(existing?.name ?? "");
  const platform = existing?.platform ?? "shopify";
  const pazaryeriKurali = platform === "trendyol" || platform === "hepsiburada";
  const [minDesi, setMinDesi] = useState(existing ? String(existing.minDesi) : "0");
  const [maxDesi, setMaxDesi] = useState(existing ? String(existing.maxDesi) : "999");
  const [minPrice, setMinPrice] = useState(existing ? String(existing.minPrice) : "0");
  const [maxPrice, setMaxPrice] = useState(existing ? String(existing.maxPrice) : "999999");
  const [category, setCategory] = useState(existing?.categoryName ?? "");
  const [cargoCost, setCargoCost] = useState(existing ? String(existing.cargoCost) : "");
  const [vatBasis, setVatBasis] = useState(existing?.vatIncluded === 0 ? "excluded" : "included");

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["cargo-rules-all"] });
    qc.invalidateQueries({ queryKey: ["rules"] });
  }

  const save = useMutation({
    mutationFn: async () => {
      const parsedMinDesi = parseTrNumber(minDesi);
      const parsedMaxDesi = parseTrNumber(maxDesi);
      const parsedMinPrice = parseTrNumber(minPrice);
      const parsedMaxPrice = parseTrNumber(maxPrice);
      const parsedCargoCost = parseTrNumber(cargoCost);

      if (parsedMinDesi === null || parsedMaxDesi === null || parsedMinPrice === null || parsedMaxPrice === null || parsedCargoCost === null) {
        throw new Error("Lütfen tüm sayısal alanlara geçerli bir değer girin.");
      }
      if (parsedMinDesi < 0 || parsedMaxDesi < parsedMinDesi) {
        throw new Error("Desi aralığı geçersiz.");
      }
      if (parsedMinPrice < 0 || parsedMaxPrice < parsedMinPrice) {
        throw new Error("Fiyat aralığı geçersiz.");
      }
      if (parsedCargoCost < 0) {
        throw new Error("Kargo ücreti negatif olamaz.");
      }

      const draft = {
        name: name.trim() || "Kargo",
        platform,
        minDesi: parsedMinDesi,
        maxDesi: parsedMaxDesi,
        minPrice: parsedMinPrice,
        maxPrice: parsedMaxPrice,
        cargoCost: parsedCargoCost,
        vatIncluded: vatBasis === "included",
        categoryName: category.trim() || null,
      };
      if (isNew) await createCargoRule(draft);
      else await updateCargoRule(id, draft);
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      invalidate();
      router.back();
    },
    onError: (error) => Alert.alert("Kaydedilemedi", error.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteCargoRule(id),
    onSuccess: () => {
      invalidate();
      router.back();
    },
    onError: () => Alert.alert("Silinemedi", "Bağlantını kontrol edip tekrar dene."),
  });

  if (pazaryeriKurali) {
    return (
      <Screen header={<SubHeader title="Kargo kuralı" subtitle={existing?.name} />}>
        <Tint strong style={styles.card}>
          <Txt v="body">Bu fiyat pazaryerinin kendi listesinden gelir; buradan değiştirilemez.</Txt>
        </Tint>
      </Screen>
    );
  }

  return (
    <Screen header={<SubHeader title={isNew ? "Yeni kargo kuralı" : "Kargo kuralı"} subtitle={existing?.name} />}>
      <Tint strong style={styles.card}>
        <Field label="Kural adı">
          <TextField value={name} onChange={setName} placeholder="Trendyol 0-1 Desi" />
        </Field>
        <Field label="Platform">
          <Txt v="body" tone="dim">Shopify</Txt>
        </Field>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Field label="Min desi">
              <TextField value={minDesi} onChange={setMinDesi} numeric />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Max desi">
              <TextField value={maxDesi} onChange={setMaxDesi} numeric />
            </Field>
          </View>
        </View>
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
        <Field label="Kategori (isteğe bağlı)">
          <TextField value={category} onChange={setCategory} placeholder="Boş = tüm kategoriler" />
        </Field>
      </Tint>

      <Tint strong style={styles.card}>
        <Field label="Kargo ücreti (₺)">
          <TextField value={cargoCost} onChange={setCargoCost} placeholder="0" numeric />
        </Field>
        <Field label="KDV durumu">
          <Segmented
            items={[
              { key: "included", label: "KDV dahil" },
              { key: "excluded", label: "KDV hariç" },
            ]}
            selected={vatBasis}
            onSelect={setVatBasis}
          />
        </Field>
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
