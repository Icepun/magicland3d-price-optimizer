import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { font } from "@/theme/tokens";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PressableScale } from "@/components/ui/PressableScale";
import { Chip, SkeletonList } from "@/components/ui";
import { ScreenHeader } from "@/components/form";
import {
  createActualExpense,
  deleteActualExpense,
  getActualExpenses,
  getExpenseCategories,
  tlToKurus,
  updateActualExpense,
  type ActualExpense,
} from "@/lib/db/finance";
import { formatCurrency } from "@/lib/format";
import { parseTrNumber } from "@/lib/number";
import { ML, radius } from "@/theme/colors";

interface Draft {
  id: string | null;
  name: string;
  amount: string;
  paidDate: string;
  category: string;
  note: string;
}

function todayInIstanbul(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function emptyDraft(): Draft {
  return {
    id: null,
    name: "",
    amount: "",
    paidDate: todayInIstanbul(),
    category: "",
    note: "",
  };
}

function expenseDraft(expense: ActualExpense): Draft {
  const date = new Date(expense.paidAt);
  const paidDate = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Istanbul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date)
    : String(expense.paidAt).slice(0, 10);
  return {
    id: expense.id,
    name: expense.name,
    amount: (expense.amountKurus / 100).toFixed(2).replace(".", ","),
    paidDate,
    category: expense.category ?? "",
    note: expense.note ?? "",
  };
}

function paidDateIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00.000+03:00`);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  if (`${part("year")}-${part("month")}-${part("day")}` !== value) return null;
  return date.toISOString();
}

export default function ExpensesScreen() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  // Kategori önerileri: masaüstünde tanımlılar + zaten kullanılanlar.
  const { data: kategoriler = [] } = useQuery({
    queryKey: ["expense-categories"],
    queryFn: getExpenseCategories,
    staleTime: 10 * 60_000,
  });
  const expensesQuery = useQuery({
    queryKey: ["actual-expenses"],
    queryFn: getActualExpenses,
  });

  const refreshFinance = () => {
    qc.invalidateQueries({ queryKey: ["actual-expenses"] });
      void qc.invalidateQueries({ queryKey: ["expense-categories"] });
    qc.invalidateQueries({ queryKey: ["monthly-finance"] });
  };

  const save = useMutation({
    mutationFn: async (value: Draft) => {
      const amount = parseTrNumber(value.amount);
      const paidAt = paidDateIso(value.paidDate);
      if (!value.name.trim()) throw new Error("Gider adı boş olamaz.");
      if (value.name.trim().length > 120) throw new Error("Gider adı en fazla 120 karakter olabilir.");
      if (amount == null || amount <= 0) throw new Error("Tutar sıfırdan büyük olmalı.");
      if (amount > 21_474_836.47) throw new Error("Tutar çok büyük.");
      if (!paidAt) throw new Error("Tarih YYYY-AA-GG biçiminde olmalı.");
      if (value.category.trim().length > 60) throw new Error("Kategori en fazla 60 karakter olabilir.");
      if (value.note.trim().length > 500) throw new Error("Not en fazla 500 karakter olabilir.");
      const input = {
        name: value.name.trim(),
        amountKurus: tlToKurus(amount),
        paidAt,
        category: value.category.trim() || null,
        note: value.note.trim() || null,
      };
      if (value.id) await updateActualExpense(value.id, input);
      else await createActualExpense(input);
    },
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDraft(null);
      refreshFinance();
    },
    onError: (error) =>
      Alert.alert("Kaydedilemedi", error instanceof Error ? error.message : "Bilinmeyen hata"),
  });

  const remove = useMutation({
    mutationFn: deleteActualExpense,
    onSuccess: () => {
      setDraft(null);
      refreshFinance();
    },
    onError: (error) =>
      Alert.alert("Silinemedi", error instanceof Error ? error.message : "Bilinmeyen hata"),
  });

  const totalKurus = useMemo(
    () => (expensesQuery.data ?? []).reduce((sum, expense) => sum + expense.amountKurus, 0),
    [expensesQuery.data]
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Gider Ödemeleri" onAdd={() => setDraft(emptyDraft())} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.summary}>
          <View>
            <Text style={styles.summaryLabel}>KAYITLI TOPLAM</Text>
            <Text style={styles.summaryValue}>{formatCurrency(totalKurus / 100)}</Text>
          </View>
          <Text style={styles.summaryCount}>{expensesQuery.data?.length ?? 0} ödeme</Text>
        </View>
        <Text style={styles.note}>
          Ödediğin genel giderleri buraya gir. Sipariş kârına karışmaz; ödeme tarihinin
          aylık net kârından düşer.
        </Text>

        {draft && (
          <View style={styles.form}>
            <Text style={styles.formTitle}>{draft.id ? "Ödemeyi düzenle" : "Yeni ödeme"}</Text>
            <Field label="GİDER ADI">
              <TextInput
                value={draft.name}
                onChangeText={(name) => setDraft({ ...draft, name })}
                placeholder="Örn. muhasebe ödemesi"
                placeholderTextColor={ML.textFaint}
                style={styles.input}
                autoFocus
                maxLength={120}
              />
            </Field>
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}>
                <Field label="TUTAR (₺)">
                  <TextInput
                    value={draft.amount}
                    onChangeText={(amount) => setDraft({ ...draft, amount })}
                    keyboardType="decimal-pad"
                    placeholder="0,00"
                    placeholderTextColor={ML.textFaint}
                    style={styles.input}
                  />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="ÖDEME TARİHİ">
                  <TextInput
                    value={draft.paidDate}
                    onChangeText={(paidDate) => setDraft({ ...draft, paidDate })}
                    placeholder="YYYY-AA-GG"
                    placeholderTextColor={ML.textFaint}
                    style={styles.input}
                    maxLength={10}
                  />
                </Field>
              </View>
            </View>
            <Field label="KATEGORİ (opsiyonel)">
              <TextInput
                value={draft.category}
                onChangeText={(category) => setDraft({ ...draft, category })}
                placeholder="Örn. yazılım"
                placeholderTextColor={ML.textFaint}
                style={styles.input}
                maxLength={60}
              />
              {/* Var olan kategoriler — yazım farkı ("yazılım"/"yazilim") gider kırılımını
                  ikiye bölüyordu. Dokunmak hem hızlı hem tutarlı. */}
              {kategoriler.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={styles.katChips}
                >
                  {kategoriler.map((k) => (
                    <Chip
                      key={k}
                      label={k}
                      selected={draft.category.trim().toLocaleLowerCase("tr") === k.toLocaleLowerCase("tr")}
                      onPress={() =>
                        setDraft({
                          ...draft,
                          category: draft.category.trim() === k ? "" : k,
                        })
                      }
                    />
                  ))}
                </ScrollView>
              ) : null}
            </Field>
            <Field label="NOT (opsiyonel)">
              <TextInput
                value={draft.note}
                onChangeText={(note) => setDraft({ ...draft, note })}
                placeholder="Kısa açıklama"
                placeholderTextColor={ML.textFaint}
                style={[styles.input, styles.noteInput]}
                multiline
                maxLength={500}
              />
            </Field>
            <View style={styles.formActions}>
              <PressableScale onPress={() => setDraft(null)} style={styles.cancelBtn}>
                <Text style={styles.cancelText}>Vazgeç</Text>
              </PressableScale>
              <PressableScale
                onPress={() => save.mutate(draft)}
                disabled={save.isPending}
                style={({ pressed }) => [
                  styles.saveBtn,
                  pressed && { opacity: 0.8 },
                  save.isPending && { opacity: 0.6 },
                ]}
              >
                {save.isPending ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.saveText}>Kaydet</Text>
                )}
              </PressableScale>
            </View>
          </View>
        )}

        {expensesQuery.isLoading ? (
          <SkeletonList count={6} />
        ) : expensesQuery.error ? (
          <View style={styles.empty}>
            <Text style={styles.errorText}>
              {expensesQuery.error instanceof Error
                ? expensesQuery.error.message
                : "Giderler yüklenemedi."}
            </Text>
            <PressableScale onPress={() => void expensesQuery.refetch()}>
              <Text style={styles.retryText}>Tekrar dene</Text>
            </PressableScale>
          </View>
        ) : (expensesQuery.data?.length ?? 0) === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Henüz ödeme yok</Text>
            <Text style={styles.emptyText}>+ Ekle ile ilk gider ödemeni kaydedebilirsin.</Text>
          </View>
        ) : (
          (expensesQuery.data ?? []).map((expense) => (
            <PressableScale
              key={expense.id}
              onPress={() => setDraft(expenseDraft(expense))}
              style={({ pressed }) => [
                styles.card,
                pressed && { backgroundColor: ML.cardElevated },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.expenseName}>{expense.name}</Text>
                <Text style={styles.expenseMeta}>
                  {new Date(expense.paidAt).toLocaleDateString("tr-TR", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    timeZone: "Europe/Istanbul",
                  })}
                  {expense.category ? ` · ${expense.category}` : ""}
                </Text>
                {expense.note ? (
                  <Text style={styles.expenseNote} numberOfLines={2}>
                    {expense.note}
                  </Text>
                ) : null}
              </View>
              <View style={styles.cardRight}>
                <Text style={styles.expenseAmount}>
                  {formatCurrency(expense.amountKurus / 100)}
                </Text>
                <PressableScale
                  hitSlop={10}
                  onPress={(event) => {
                    event.stopPropagation();
                    Alert.alert("Ödemeyi sil?", expense.name, [
                      { text: "Vazgeç", style: "cancel" },
                      {
                        text: "Sil",
                        style: "destructive",
                        onPress: () => remove.mutate(expense.id),
                      },
                    ]);
                  }}
                >
                  <Text style={styles.deleteText}>Sil</Text>
                </PressableScale>
              </View>
            </PressableScale>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  katChips: { flexDirection: "row", gap: 6, paddingTop: 8, paddingRight: 4 },
  safe: { flex: 1, backgroundColor: "transparent" }, // zemin kökte (kit/Backdrop)
  content: { padding: 16, gap: 10, paddingBottom: 48 },
  center: { paddingVertical: 50, alignItems: "center" },
  summary: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 16,
  },
  summaryLabel: { color: ML.textFaint, fontSize: 11, fontFamily: font.bold, letterSpacing: 1 },
  summaryValue: { color: ML.orange, fontSize: 26, fontFamily: font.extrabold, marginTop: 4 },
  summaryCount: { color: ML.textDim, fontFamily: font.medium, fontSize: 13 },
  note: { color: ML.textFaint, fontFamily: font.medium, fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
  form: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.accent,
    padding: 16,
    gap: 14,
  },
  formTitle: { color: ML.text, fontSize: 18, fontFamily: font.extrabold },
  fieldLabel: { color: ML.textFaint, fontSize: 11, fontFamily: font.bold, letterSpacing: 1 },
  input: {
    backgroundColor: ML.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    color: ML.text,
    paddingHorizontal: 13,
    paddingVertical: 12,
    fontFamily: font.medium, fontSize: 15,
  },
  noteInput: { minHeight: 72, textAlignVertical: "top" },
  twoCol: { flexDirection: "row", gap: 10 },
  formActions: { flexDirection: "row", gap: 10, marginTop: 2 },
  cancelBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    paddingVertical: 13,
  },
  cancelText: { color: ML.textDim, fontSize: 15, fontFamily: font.bold },
  saveBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: ML.accent,
    paddingVertical: 13,
  },
  saveText: { color: "#fff", fontSize: 15, fontFamily: font.extrabold },
  empty: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 42,
    paddingHorizontal: 20,
  },
  emptyTitle: { color: ML.text, fontSize: 17, fontFamily: font.bold },
  emptyText: { color: ML.textDim, fontFamily: font.medium, fontSize: 13, textAlign: "center" },
  errorText: { color: ML.red, fontFamily: font.medium, fontSize: 13, textAlign: "center" },
  retryText: { color: ML.accent, fontSize: 14, fontFamily: font.bold },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 15,
  },
  expenseName: { color: ML.text, fontSize: 16, fontFamily: font.bold },
  expenseMeta: { color: ML.textDim, fontFamily: font.medium, fontSize: 12, marginTop: 4 },
  expenseNote: { color: ML.textFaint, fontFamily: font.medium, fontSize: 12, marginTop: 4 },
  cardRight: { alignItems: "flex-end", gap: 8 },
  expenseAmount: { color: ML.orange, fontSize: 16, fontFamily: font.extrabold },
  deleteText: { color: ML.red, fontSize: 12, fontFamily: font.bold },
});
