import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";

import { Chip } from "@/components/kit/Chip";
import { Button, EmptyState, ErrorState, FadeInView, Glass, IconButton, Input, Money, Screen, ShimmerList, SubHeader, Tint, Txt } from "@/components/kit";
import {
  createActualExpense,
  deleteActualExpense,
  getActualExpenses,
  getExpenseCategories,
  tlToKurus,
  updateActualExpense,
  type ActualExpense,
} from "@/lib/db/finance";
import { formatNumber } from "@/lib/format";
import { parseTrNumber } from "@/lib/number";
import { color, space } from "@/theme/tokens";

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
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function emptyDraft(): Draft {
  return { id: null, name: "", amount: "", paidDate: todayInIstanbul(), category: "", note: "" };
}

function expenseDraft(expense: ActualExpense): Draft {
  const date = new Date(expense.paidAt);
  const paidDate = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
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
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  if (`${part("year")}-${part("month")}-${part("day")}` !== value) return null;
  return date.toISOString();
}

/**
 * GİDER ÖDEMELERİ — ödenen genel giderler; sipariş kârına karışmaz, ödeme ayının net kârından
 * düşer. Doğrulama ve kayıt mantığı öncekiyle aynı; sunum kit'e taşındı.
 */
export default function ExpensesScreen() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const { data: kategoriler = [] } = useQuery({ queryKey: ["expense-categories"], queryFn: getExpenseCategories, staleTime: 10 * 60_000 });
  const expensesQuery = useQuery({ queryKey: ["actual-expenses"], queryFn: getActualExpenses });

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
    onError: (error) => Alert.alert("Kaydedilemedi", error instanceof Error ? error.message : "Bilinmeyen hata"),
  });

  const remove = useMutation({
    mutationFn: deleteActualExpense,
    onSuccess: () => {
      setDraft(null);
      refreshFinance();
    },
    onError: (error) => Alert.alert("Silinemedi", error instanceof Error ? error.message : "Bilinmeyen hata"),
  });

  const totalKurus = useMemo(() => (expensesQuery.data ?? []).reduce((sum, expense) => sum + expense.amountKurus, 0), [expensesQuery.data]);
  const sayi = expensesQuery.data?.length ?? 0;

  return (
    <Screen
      header={
        <SubHeader
          title="Gider ödemeleri"
          subtitle={expensesQuery.data ? `${formatNumber(sayi)} ödeme` : undefined}
          right={<IconButton icon="plus" accent onPress={() => setDraft(emptyDraft())} accessibilityLabel="Ödeme ekle" />}
        />
      }
    >
      <FadeInView index={0}>
        <Glass style={styles.summary}>
          <View style={{ flex: 1 }}>
            <Txt v="label" tone="faint" style={styles.kicker}>
              KAYITLI TOPLAM
            </Txt>
            <Money value={totalKurus / 100} v="hero" tone="warn" />
          </View>
          <Txt v="small" tone="dim" style={{ maxWidth: 150 }}>
            Sipariş kârına karışmaz; ödeme tarihinin aylık net kârından düşer.
          </Txt>
        </Glass>
      </FadeInView>

      {draft ? (
        <FadeInView>
          <Tint strong style={styles.form}>
            <Txt v="heading">{draft.id ? "Ödemeyi düzenle" : "Yeni ödeme"}</Txt>
            <Alan label="Gider adı">
              <Input value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} placeholder="Örn. muhasebe ödemesi" autoFocus maxLength={120} />
            </Alan>
            <View style={styles.twoCol}>
              <Alan label="Tutar" flex>
                <Input value={draft.amount} onChangeText={(amount) => setDraft({ ...draft, amount })} numeric placeholder="0,00" suffix="₺" />
              </Alan>
              <Alan label="Ödeme tarihi" flex>
                <Input value={draft.paidDate} onChangeText={(paidDate) => setDraft({ ...draft, paidDate })} placeholder="YYYY-AA-GG" maxLength={10} />
              </Alan>
            </View>
            <Alan label="Kategori (isteğe bağlı)">
              <Input value={draft.category} onChangeText={(category) => setDraft({ ...draft, category })} placeholder="Örn. yazılım" maxLength={60} />
              {kategoriler.length > 0 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.katChips}>
                  {kategoriler.map((k) => (
                    <Chip
                      key={k}
                      label={k}
                      selected={draft.category.trim().toLocaleLowerCase("tr") === k.toLocaleLowerCase("tr")}
                      onPress={() => setDraft({ ...draft, category: draft.category.trim() === k ? "" : k })}
                    />
                  ))}
                </ScrollView>
              ) : null}
            </Alan>
            <Alan label="Not (isteğe bağlı)">
              <Input
                value={draft.note}
                onChangeText={(note) => setDraft({ ...draft, note })}
                placeholder="Kısa açıklama"
                multiline
                maxLength={500}
                style={{ minHeight: 76, alignItems: "flex-start", paddingVertical: space.sm }}
                inputStyle={{ minHeight: 60, textAlignVertical: "top" }}
              />
            </Alan>
            <View style={styles.twoCol}>
              <Button label="Vazgeç" variant="secondary" onPress={() => setDraft(null)} style={{ flex: 1 }} />
              <Button label="Kaydet" onPress={() => save.mutate(draft)} loading={save.isPending} style={{ flex: 1 }} />
            </View>
          </Tint>
        </FadeInView>
      ) : null}

      {expensesQuery.isLoading ? (
        <ShimmerList count={6} height={80} />
      ) : expensesQuery.error ? (
        <ErrorState title="Giderler yüklenemedi" error={expensesQuery.error} onRetry={() => void expensesQuery.refetch()} retrying={expensesQuery.isFetching} />
      ) : sayi === 0 ? (
        <EmptyState icon="creditcard" title="Henüz ödeme yok" hint="Sağ üstteki artı ile ilk gider ödemeni kaydet." actionLabel="Ödeme ekle" onAction={() => setDraft(emptyDraft())} />
      ) : (
        (expensesQuery.data ?? []).map((expense, i) => (
          <FadeInView key={expense.id} index={i + 1}>
            <Tint strong onPress={() => setDraft(expenseDraft(expense))} style={styles.card} accessibilityLabel={expense.name}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Txt v="bodyStrong" numberOfLines={1}>
                  {expense.name}
                </Txt>
                <Txt v="small" tone="dim" numberOfLines={1}>
                  {new Date(expense.paidAt).toLocaleDateString("tr-TR", { day: "2-digit", month: "short", year: "numeric", timeZone: "Europe/Istanbul" })}
                  {expense.category ? ` · ${expense.category}` : ""}
                </Txt>
                {expense.note ? (
                  <Txt v="small" tone="faint" numberOfLines={2}>
                    {expense.note}
                  </Txt>
                ) : null}
              </View>
              <View style={styles.cardRight}>
                <Money value={expense.amountKurus / 100} v="bodyStrong" tone="warn" animate={false} />
                <IconButton
                  icon="trash"
                  size={30}
                  tint={color.bad}
                  haptic="orta"
                  accessibilityLabel="Ödemeyi sil"
                  onPress={() =>
                    Alert.alert("Ödemeyi sil?", expense.name, [
                      { text: "Vazgeç", style: "cancel" },
                      { text: "Sil", style: "destructive", onPress: () => remove.mutate(expense.id) },
                    ])
                  }
                />
              </View>
            </Tint>
          </FadeInView>
        ))
      )}
    </Screen>
  );
}

function Alan({ label, children, flex }: { label: string; children: React.ReactNode; flex?: boolean }) {
  return (
    <View style={flex ? { flex: 1, gap: 6 } : { gap: 6 }}>
      <Txt v="label" tone="faint" style={styles.kicker}>
        {label.toLocaleUpperCase("tr-TR")}
      </Txt>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  kicker: { letterSpacing: 1 },
  summary: { flexDirection: "row", alignItems: "center", gap: space.md },
  form: { gap: space.md, borderColor: color.accent + "66" },
  twoCol: { flexDirection: "row", gap: space.sm },
  katChips: { flexDirection: "row", gap: space.xs, paddingTop: space.sm, paddingRight: space.xs },
  card: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  cardRight: { alignItems: "flex-end", gap: space.xs },
});
