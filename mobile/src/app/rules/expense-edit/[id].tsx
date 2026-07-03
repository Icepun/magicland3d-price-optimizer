import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  createExpenseRule,
  deleteExpenseRule,
  getAllExpenseRules,
  updateExpenseRule,
  type ExpenseType,
} from "@/lib/db/rule-crud";
import { ML, radius } from "@/theme/colors";

const PLATFORMS = [
  { key: "all", label: "Tümü" },
  { key: "shopify", label: "Shopify" },
  { key: "trendyol", label: "Trendyol" },
];
const TYPES: { key: ExpenseType; label: string }[] = [
  { key: "fixed", label: "Sabit ₺" },
  { key: "percentage", label: "Yüzde %" },
  { key: "per_order", label: "Sipariş ₺" },
];

export default function ExpenseEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const qc = useQueryClient();

  const { data: all } = useQuery({ queryKey: ["expense-rules-all"], queryFn: getAllExpenseRules });
  const existing = isNew ? null : all?.find((r) => r.id === id);

  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<string>("all");
  const [type, setType] = useState<ExpenseType>("fixed");
  const [value, setValue] = useState("");
  const [category, setCategory] = useState("");

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setPlatform(existing.platform ?? "all");
    setType(existing.type);
    setValue(existing.type === "percentage" ? String(existing.value * 100) : String(existing.value));
    setCategory(existing.categoryName ?? "");
  }, [existing]);

  const save = useMutation({
    mutationFn: async () => {
      const raw = parseFloat(value) || 0;
      const draft = {
        name: name.trim() || "Gider",
        platform: platform === "all" ? null : platform,
        type,
        value: type === "percentage" ? raw / 100 : raw,
        categoryName: category.trim() || null,
        minPrice: 0,
        maxPrice: 999999,
      };
      if (isNew) await createExpenseRule(draft);
      else await updateExpenseRule(id, draft);
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      invalidate();
      router.back();
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteExpenseRule(id),
    onSuccess: () => {
      invalidate();
      router.back();
    },
  });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["expense-rules-all"] });
    qc.invalidateQueries({ queryKey: ["rules"] });
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{isNew ? "Yeni Gider" : "Gider Düzenle"}</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Field label="GİDER ADI">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Platform Hizmet Bedeli"
            placeholderTextColor={ML.textFaint}
            style={styles.input}
          />
        </Field>

        <Field label="PLATFORM">
          <Segmented items={PLATFORMS} selected={platform} onSelect={setPlatform} />
        </Field>

        <Field label="TİP">
          <Segmented items={TYPES} selected={type} onSelect={(k) => setType(k as ExpenseType)} />
        </Field>

        <Field label={type === "percentage" ? "DEĞER (%)" : "DEĞER (₺)"}>
          <TextInput
            value={value}
            onChangeText={setValue}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={ML.textFaint}
            style={styles.input}
          />
        </Field>

        <Field label="KATEGORİ (opsiyonel)">
          <TextInput
            value={category}
            onChangeText={setCategory}
            placeholder="Boş = tüm kategoriler"
            placeholderTextColor={ML.textFaint}
            style={styles.input}
          />
        </Field>

        <Pressable
          onPress={() => save.mutate()}
          disabled={save.isPending}
          style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.saveText}>{isNew ? "Oluştur" : "Kaydet"}</Text>
        </Pressable>

        {!isNew && (
          <Pressable
            onPress={() =>
              Alert.alert("Kuralı sil?", existing?.name ?? "", [
                { text: "Vazgeç", style: "cancel" },
                { text: "Sil", style: "destructive", onPress: () => remove.mutate() },
              ])
            }
            style={styles.deleteBtn}
          >
            <Text style={styles.deleteText}>Sil</Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function Segmented({
  items,
  selected,
  onSelect,
}: {
  items: { key: string; label: string }[];
  selected: string;
  onSelect: (k: string) => void;
}) {
  return (
    <View style={styles.segmented}>
      {items.map((it) => {
        const on = it.key === selected;
        return (
          <Pressable
            key={it.key}
            onPress={() => {
              Haptics.selectionAsync();
              onSelect(it.key);
            }}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Text style={[styles.segmentText, on && { color: "#fff", fontWeight: "700" }]}>
              {it.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, height: 48 },
  back: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  backText: { color: ML.text, fontSize: 34, marginTop: -4 },
  headerTitle: { flex: 1, color: ML.text, fontSize: 17, fontWeight: "700", textAlign: "center" },
  content: { padding: 16, gap: 18, paddingBottom: 60 },
  label: { color: ML.textFaint, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  input: {
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    color: ML.text,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    padding: 4,
    gap: 4,
  },
  segment: { flex: 1, paddingVertical: 10, borderRadius: radius.sm, alignItems: "center" },
  segmentOn: { backgroundColor: ML.accent },
  segmentText: { color: ML.textDim, fontSize: 14 },
  saveBtn: {
    backgroundColor: ML.accent,
    borderRadius: radius.lg,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
  },
  saveText: { color: "#fff", fontSize: 17, fontWeight: "800" },
  deleteBtn: { paddingVertical: 14, alignItems: "center" },
  deleteText: { color: ML.red, fontSize: 16, fontWeight: "700" },
});
