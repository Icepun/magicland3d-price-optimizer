import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  DeleteButton,
  Field,
  PrimaryButton,
  ScreenHeader,
  Segmented,
  TextField,
} from "@/components/form";
import {
  createCargoRule,
  deleteCargoRule,
  getAllCargoRules,
  updateCargoRule,
} from "@/lib/db/rule-crud";
import { parseTrNumber } from "@/lib/number";
import { ML } from "@/theme/colors";

const PLATFORMS = [
  { key: "all", label: "Tümü" },
  { key: "shopify", label: "Shopify" },
  { key: "trendyol", label: "Trendyol" },
  { key: "hepsiburada", label: "Hepsiburada" },
];

export default function CargoEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const qc = useQueryClient();
  const { data: all } = useQuery({ queryKey: ["cargo-rules-all"], queryFn: getAllCargoRules });
  const existing = isNew ? null : all?.find((r) => r.id === id);

  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("all");
  const [minDesi, setMinDesi] = useState("0");
  const [maxDesi, setMaxDesi] = useState("999");
  const [minPrice, setMinPrice] = useState("0");
  const [maxPrice, setMaxPrice] = useState("999999");
  const [category, setCategory] = useState("");
  const [cargoCost, setCargoCost] = useState("");

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setPlatform(existing.platform ?? "all");
    setMinDesi(String(existing.minDesi));
    setMaxDesi(String(existing.maxDesi));
    setMinPrice(String(existing.minPrice));
    setMaxPrice(String(existing.maxPrice));
    setCategory(existing.categoryName ?? "");
    setCargoCost(String(existing.cargoCost));
  }, [existing]);

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

      if (
        parsedMinDesi === null ||
        parsedMaxDesi === null ||
        parsedMinPrice === null ||
        parsedMaxPrice === null ||
        parsedCargoCost === null
      ) {
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
        platform: platform === "all" ? null : platform,
        minDesi: parsedMinDesi,
        maxDesi: parsedMaxDesi,
        minPrice: parsedMinPrice,
        maxPrice: parsedMaxPrice,
        cargoCost: parsedCargoCost,
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
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title={isNew ? "Yeni Kargo" : "Kargo Düzenle"} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Field label="KURAL ADI">
          <TextField value={name} onChange={setName} placeholder="Trendyol 0-1 Desi" />
        </Field>
        <Field label="PLATFORM">
          <Segmented items={PLATFORMS} selected={platform} onSelect={setPlatform} />
        </Field>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Field label="MİN DESİ">
              <TextField value={minDesi} onChange={setMinDesi} numeric />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="MAX DESİ">
              <TextField value={maxDesi} onChange={setMaxDesi} numeric />
            </Field>
          </View>
        </View>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Field label="MİN FİYAT (₺)">
              <TextField value={minPrice} onChange={setMinPrice} numeric />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="MAX FİYAT (₺)">
              <TextField value={maxPrice} onChange={setMaxPrice} numeric />
            </Field>
          </View>
        </View>
        <Field label="KATEGORİ (opsiyonel)">
          <TextField value={category} onChange={setCategory} placeholder="Boş = tüm kategoriler" />
        </Field>
        <Field label="KARGO ÜCRETİ (₺)">
          <TextField value={cargoCost} onChange={setCargoCost} placeholder="0" numeric />
        </Field>

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
