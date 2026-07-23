import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  calculateManualOrder,
  type ManualOrderCalculationInput,
  type ManualOrderCustomExpense,
  type ManualOrderMode,
  type ManualOrderResolvedItem,
  type ManualOrderSelectedExpense,
  type ManualOrderStatusKind,
} from "@core/manual-order";
import { resolveProductCost } from "@core/product-cost";
import type { ExpenseRuleInput } from "@core/types";

import {
  DeleteButton,
  Field,
  PrimaryButton,
  ScreenHeader,
  Segmented,
  TextField,
} from "@/components/form";
import { getDashboardData } from "@/lib/db/dashboard";
import {
  createManualOrder,
  deleteManualOrder,
  getManualOrder,
  updateManualOrder,
  type ManualOrder,
} from "@/lib/db/manual-orders";
import type { ProductDetail } from "@/lib/db/product-detail";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { formatCurrency, formatPercent } from "@/lib/format";
import { thumbUrl } from "@/lib/image";
import { parseTrNumber } from "@/lib/number";
import { ML, radius } from "@/theme/colors";

type FormItem = ManualOrderResolvedItem & { manualCostText: string };
type CustomExpenseForm = Omit<ManualOrderCustomExpense, "amount"> & { amountText: string };

const MODES: { key: ManualOrderMode; label: string }[] = [
  { key: "catalog", label: "Katalog ürünü" },
  { key: "freeform", label: "Ürünsüz / özel" },
];

const STATUSES: { key: ManualOrderStatusKind; label: string }[] = [
  { key: "pending", label: "Bekliyor" },
  { key: "processing", label: "Hazırlanıyor" },
  { key: "shipped", label: "Gönderildi" },
  { key: "delivered", label: "Tamamlandı" },
  { key: "cancelled", label: "İptal" },
];

function newLineId(): string {
  return `mi_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function newExpenseId(): string {
  return `mx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function istanbulParts(value = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

function orderDateIso(dateValue: string, timeValue: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !/^\d{2}:\d{2}$/.test(timeValue)) {
    return null;
  }
  const date = new Date(`${dateValue}T${timeValue}:00.000+03:00`);
  if (!Number.isFinite(date.getTime())) return null;
  const roundTrip = istanbulParts(date);
  return roundTrip.date === dateValue && roundTrip.time === timeValue
    ? date.toISOString()
    : null;
}

function numberText(value: number | null | undefined): string {
  if (value == null) return "";
  return String(Number(value.toFixed(4))).replace(".", ",");
}

function resolveCatalogItem(
  product: ProductDetail,
  settings: Record<string, string>,
  id = newLineId()
): FormItem {
  const resolved = resolveProductCost(
    product.cost ? { ...product.cost, tapeUsed: Boolean(product.cost.tapeUsed) } : null,
    settings,
    product.cost?.costPerGram ?? 0
  );
  return {
    id,
    productId: product.id,
    name: product.name,
    imageUrl: product.imageUrl,
    quantity: 1,
    costKnown: product.cost != null,
    productionCost: resolved?.productionCost ?? 0,
    packagingCost: resolved?.packagingCost ?? 0,
    filamentCost: resolved?.filamentCost ?? 0,
    packagingComponents: resolved?.packagingBreakdown?.components ?? null,
    manualUnitCost: null,
    manualCostHasVatInvoice: false,
    manualCostText: "",
  };
}

function emptyFreeformItem(): FormItem {
  return {
    id: newLineId(),
    productId: null,
    name: "",
    imageUrl: null,
    quantity: 1,
    costKnown: false,
    productionCost: 0,
    packagingCost: 0,
    filamentCost: 0,
    packagingComponents: null,
    manualUnitCost: null,
    manualCostHasVatInvoice: false,
    manualCostText: "",
  };
}

function formItems(items: ManualOrderResolvedItem[]): FormItem[] {
  return items.map((item) => ({
    ...item,
    manualCostText: numberText(item.manualUnitCost),
  }));
}

function fold(value: string): string {
  return value
    .toLocaleLowerCase("tr-TR")
    .replace(/[çÇ]/g, "c")
    .replace(/[ğĞ]/g, "g")
    .replace(/[ıİ]/g, "i")
    .replace(/[öÖ]/g, "o")
    .replace(/[şŞ]/g, "s")
    .replace(/[üÜ]/g, "u");
}

export default function ManualOrderEditScreen() {
  const { id, productId } = useLocalSearchParams<{ id: string; productId?: string }>();
  const isNew = id === "new";
  const orderQuery = useQuery({
    queryKey: ["manual-order", id],
    queryFn: () => getManualOrder(id),
    enabled: !isNew,
    refetchOnMount: "always",
  });
  const productsQuery = useQuery({
    queryKey: ["dashboard-data"],
    queryFn: getDashboardData,
  });
  const rulesQuery = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

  const loading =
    productsQuery.isLoading ||
    rulesQuery.isLoading ||
    settingsQuery.isLoading ||
    (!isNew && orderQuery.isLoading);
  const error =
    productsQuery.error ??
    rulesQuery.error ??
    settingsQuery.error ??
    (!isNew && !orderQuery.data ? orderQuery.error ?? new Error("Manuel sipariş bulunamadı.") : null);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader title={isNew ? "Yeni Manuel Sipariş" : "Manuel Sipariş"} />
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (
    error ||
    !productsQuery.data ||
    !rulesQuery.data ||
    !settingsQuery.data ||
    (!isNew && !orderQuery.data)
  ) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader title="Manuel Sipariş" />
        <View style={styles.errorState}>
          <Text style={styles.errorText}>
            {error instanceof Error ? error.message : "Veriler yüklenemedi."}
          </Text>
          <PrimaryButton
            label="Tekrar dene"
            onPress={() => {
              void productsQuery.refetch();
              void rulesQuery.refetch();
              void settingsQuery.refetch();
              if (!isNew) void orderQuery.refetch();
            }}
          />
        </View>
      </SafeAreaView>
    );
  }

  const initialProduct = isNew
    ? productsQuery.data.find((product) => product.id === productId) ?? null
    : null;

  return (
    <ManualOrderForm
      key={orderQuery.data?.updatedAt ?? "new"}
      existing={orderQuery.data ?? null}
      products={productsQuery.data}
      expenseRules={rulesQuery.data.expense}
      settings={settingsQuery.data}
      initialProduct={initialProduct}
    />
  );
}

function ManualOrderForm({
  existing,
  products,
  expenseRules,
  settings,
  initialProduct,
}: {
  existing: ManualOrder | null;
  products: ProductDetail[];
  expenseRules: ExpenseRuleInput[];
  settings: Record<string, string>;
  initialProduct: ProductDetail | null;
}) {
  const qc = useQueryClient();
  const initialDate = istanbulParts(existing ? new Date(existing.orderedAt) : new Date());
  const [mode, setMode] = useState<ManualOrderMode>(existing?.mode ?? "catalog");
  const [orderNumber, setOrderNumber] = useState(existing?.orderNumber ?? "");
  const [customerName, setCustomerName] = useState(existing?.customerName ?? "");
  const [dateValue, setDateValue] = useState(initialDate.date);
  const [timeValue, setTimeValue] = useState(initialDate.time);
  const [statusKind, setStatusKind] = useState<ManualOrderStatusKind>(
    existing?.statusKind ?? "processing"
  );
  const [saleTotal, setSaleTotal] = useState(
    existing ? numberText(existing.draft.saleTotal) : ""
  );
  const [includeProductCost, setIncludeProductCost] = useState(
    existing?.draft.includeProductCost ?? true
  );
  const [includePackaging, setIncludePackaging] = useState(
    existing?.draft.includePackaging ?? true
  );
  const [commissionAmount, setCommissionAmount] = useState(
    numberText(existing?.draft.commission.amount)
  );
  const [commissionVat, setCommissionVat] = useState(
    existing?.draft.commission.hasVatInvoice ?? false
  );
  const [cargoAmount, setCargoAmount] = useState(numberText(existing?.draft.cargo.amount));
  const [cargoVat, setCargoVat] = useState(
    existing?.draft.cargo.hasVatInvoice ?? false
  );
  const [selectedExpenses, setSelectedExpenses] = useState<ManualOrderSelectedExpense[]>(
    () => existing?.draft.expenseRules.map((expense) => ({ ...expense })) ?? []
  );
  const [customExpenses, setCustomExpenses] = useState<CustomExpenseForm[]>(
    () =>
      existing?.draft.customExpenses.map((expense) => ({
        id: expense.id,
        name: expense.name,
        amountText: numberText(expense.amount),
        hasVatInvoice: expense.hasVatInvoice,
      })) ?? []
  );
  const [note, setNote] = useState(existing?.note ?? "");
  const [items, setItems] = useState<FormItem[]>(() => {
    if (existing) return formItems(existing.draft.items);
    if (initialProduct) return [resolveCatalogItem(initialProduct, settings)];
    return [];
  });
  const [pickerOpen, setPickerOpen] = useState(false);

  const availableExpenseRules = useMemo(() => {
    const byId = new Map<
      string,
      Pick<ManualOrderSelectedExpense, "id" | "name" | "type" | "value">
    >();
    for (const rule of expenseRules) {
      byId.set(rule.id, {
        id: rule.id,
        name: rule.name,
        type: rule.type,
        value: rule.value,
      });
    }
    for (const selected of selectedExpenses) {
      if (!byId.has(selected.id)) byId.set(selected.id, selected);
    }
    return [...byId.values()];
  }, [expenseRules, selectedExpenses]);

  const resolvedItems = useMemo<ManualOrderResolvedItem[]>(
    () =>
      items.map(({ manualCostText, ...item }) => {
        if (mode === "catalog") {
          return {
            ...item,
            manualUnitCost: null,
            manualCostHasVatInvoice: false,
          };
        }
        const parsed = parseTrNumber(manualCostText);
        return {
          ...item,
          productId: null,
          imageUrl: null,
          productionCost: 0,
          packagingCost: 0,
          filamentCost: 0,
          packagingComponents: null,
          costKnown: manualCostText.trim() !== "" && parsed != null,
          manualUnitCost: parsed,
        };
      }),
    [items, mode]
  );

  const normalizedCustomExpenses = useMemo<ManualOrderCustomExpense[]>(
    () =>
      customExpenses
        .filter(
          (expense) =>
            expense.name.trim() !== "" || expense.amountText.trim() !== ""
        )
        .map((expense) => ({
          id: expense.id,
          name: expense.name.trim(),
          amount: Math.max(0, parseTrNumber(expense.amountText) ?? 0),
          hasVatInvoice: expense.hasVatInvoice,
        })),
    [customExpenses]
  );

  const draft = useMemo<ManualOrderCalculationInput>(
    () => ({
      saleTotal: Math.max(0, parseTrNumber(saleTotal) ?? 0),
      vatRate: existing?.draft.vatRate ?? Number(settings.vatRate ?? 20),
      mode,
      items: resolvedItems,
      includeProductCost,
      includePackaging: mode === "catalog" && includePackaging,
      commission: {
        amount: Math.max(0, parseTrNumber(commissionAmount) ?? 0),
        hasVatInvoice: commissionVat,
      },
      cargo: {
        amount: Math.max(0, parseTrNumber(cargoAmount) ?? 0),
        hasVatInvoice: cargoVat,
      },
      expenseRules: selectedExpenses.map(({ amount: _amount, ...expense }) => expense),
      customExpenses: normalizedCustomExpenses,
    }),
    [
      cargoAmount,
      cargoVat,
      commissionAmount,
      commissionVat,
      existing?.draft.vatRate,
      includePackaging,
      includeProductCost,
      mode,
      normalizedCustomExpenses,
      resolvedItems,
      saleTotal,
      selectedExpenses,
      settings.vatRate,
    ]
  );
  const breakdown = useMemo(() => calculateManualOrder(draft), [draft]);

  function invalidateManualOrderQueries(id?: string) {
    const tasks = [
      qc.invalidateQueries({ queryKey: ["orders"] }),
      qc.invalidateQueries({ queryKey: ["orders-finance-history"] }),
      qc.invalidateQueries({ queryKey: ["monthly-finance"] }),
    ];
    if (id) tasks.push(qc.invalidateQueries({ queryKey: ["manual-order", id] }));
    return Promise.all(tasks);
  }

  function writeInput() {
    const total = parseTrNumber(saleTotal);
    if (total == null || total < 0) throw new Error("Geçerli bir satış tutarı girin.");
    const parseOptionalCost = (value: string, label: string) => {
      if (value.trim() === "") return 0;
      const parsed = parseTrNumber(value);
      if (parsed == null || parsed < 0) {
        throw new Error(`${label} tutarını kontrol edin.`);
      }
      return parsed;
    };
    const validatedCommission = parseOptionalCost(commissionAmount, "Komisyon");
    const validatedCargo = parseOptionalCost(cargoAmount, "Kargo");
    const orderedAt = orderDateIso(dateValue, timeValue);
    if (!orderedAt) throw new Error("Tarih YYYY-AA-GG, saat SS:DD biçiminde olmalı.");
    if (resolvedItems.length === 0) throw new Error("En az bir sipariş kalemi ekleyin.");
    if (mode === "freeform" && resolvedItems.some((item) => !item.name.trim())) {
      throw new Error("Ürünsüz satırların adı boş olamaz.");
    }
    if (mode === "freeform") {
      for (const item of items) {
        if (item.manualCostText.trim() === "") continue;
        const unitCost = parseTrNumber(item.manualCostText);
        if (unitCost == null || unitCost < 0) {
          throw new Error(`${item.name.trim() || "Sipariş kalemi"} birim maliyetini kontrol edin.`);
        }
      }
    }
    for (const expense of customExpenses) {
      const hasName = expense.name.trim() !== "";
      const hasAmount = expense.amountText.trim() !== "";
      if (!hasName && !hasAmount) continue;
      if (hasName !== hasAmount) {
        throw new Error("Özel giderlerde ad ve tutarı birlikte girin.");
      }
      const amount = parseTrNumber(expense.amountText);
      if (amount == null || amount < 0) {
        throw new Error("Özel gider tutarlarını kontrol edin.");
      }
    }

    return {
      orderNumber: orderNumber.trim() || null,
      orderedAt,
      statusKind,
      customerName: customerName.trim() || null,
      note: note.trim() || null,
      draft: {
        ...draft,
        saleTotal: total,
        commission: { ...draft.commission, amount: validatedCommission },
        cargo: { ...draft.cargo, amount: validatedCargo },
      },
    };
  }

  const save = useMutation({
    mutationFn: async () => {
      const input = writeInput();
      if (existing) {
        await updateManualOrder(existing.id, input);
        return existing.id;
      }
      return createManualOrder(input);
    },
    onSuccess: async (savedId) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await invalidateManualOrderQueries(savedId);
      router.replace("/orders");
    },
    onError: (error) =>
      Alert.alert(
        "Kaydedilemedi",
        error instanceof Error ? error.message : "Bilinmeyen hata"
      ),
  });

  const remove = useMutation({
    mutationFn: () => deleteManualOrder(existing!.id),
    onSuccess: async () => {
      await invalidateManualOrderQueries(existing!.id);
      router.replace("/orders");
    },
    onError: (error) =>
      Alert.alert(
        "Silinemedi",
        error instanceof Error ? error.message : "Bilinmeyen hata"
      ),
  });

  function changeMode(next: ManualOrderMode) {
    if (next === mode) return;
    const apply = () => {
      setMode(next);
      setItems(next === "freeform" ? [emptyFreeformItem()] : []);
    };
    if (items.length === 0) apply();
    else {
      Alert.alert(
        "Sipariş türü değişsin mi?",
        "Mevcut kalemler temizlenecek.",
        [
          { text: "Vazgeç", style: "cancel" },
          { text: "Değiştir", style: "destructive", onPress: apply },
        ]
      );
    }
  }

  function addCatalogProduct(product: ProductDetail) {
    setItems((current) => {
      const existingIndex = current.findIndex((item) => item.productId === product.id);
      if (existingIndex < 0) return [...current, resolveCatalogItem(product, settings)];
      return current.map((item, index) =>
        index === existingIndex ? { ...item, quantity: item.quantity + 1 } : item
      );
    });
    setPickerOpen(false);
    void Haptics.selectionAsync();
  }

  function setQuantity(id: string, quantity: number) {
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, quantity: Math.max(1, Math.min(10_000, quantity)) } : item
      )
    );
  }

  function toggleExpense(
    expense: Pick<ManualOrderSelectedExpense, "id" | "name" | "type" | "value">
  ) {
    setSelectedExpenses((current) => {
      if (current.some((item) => item.id === expense.id)) {
        return current.filter((item) => item.id !== expense.id);
      }
      return [...current, { ...expense, hasVatInvoice: false }];
    });
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title={existing ? "Manuel Siparişi Düzenle" : "Yeni Manuel Sipariş"} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Section title="SİPARİŞ TÜRÜ">
          <Segmented items={MODES} selected={mode} onSelect={changeMode} />
          <Text style={styles.help}>
            {mode === "catalog"
              ? "Kayıtlı ürün maliyeti ve paketleme anlık görüntü olarak saklanır."
              : "Kayıtlı ürüne bağlı olmayan satış; birim maliyet boş bırakılabilir."}
          </Text>
        </Section>

        <Section title="GENEL BİLGİ">
          <Field label="SATIŞ TUTARI · KDV DAHİL (₺)">
            <TextField
              value={saleTotal}
              onChange={setSaleTotal}
              placeholder="0,00"
              numeric
            />
          </Field>
          <View style={styles.twoCol}>
            <View style={{ flex: 1 }}>
              <Field label="TARİH">
                <TextField value={dateValue} onChange={setDateValue} placeholder="YYYY-AA-GG" />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="SAAT">
                <TextField value={timeValue} onChange={setTimeValue} placeholder="SS:DD" />
              </Field>
            </View>
          </View>
          <Field label="SİPARİŞ NO (boşsa otomatik)">
            <TextField value={orderNumber} onChange={setOrderNumber} placeholder="M-..." />
          </Field>
          <Field label="MÜŞTERİ (opsiyonel)">
            <TextField value={customerName} onChange={setCustomerName} placeholder="Ad soyad" />
          </Field>
          <Field label="DURUM">
            <View style={styles.statusWrap}>
              {STATUSES.map((status) => {
                const selected = statusKind === status.key;
                return (
                  <Pressable
                    key={status.key}
                    onPress={() => setStatusKind(status.key)}
                    style={[styles.statusChip, selected && styles.statusChipOn]}
                  >
                    <Text style={[styles.statusChipText, selected && styles.statusChipTextOn]}>
                      {status.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Field>
        </Section>

        <Section title={`KALEMLER · ${items.length}`}>
          {mode === "catalog" ? (
            <>
              {items.map((item) => (
                <CatalogItemCard
                  key={item.id}
                  item={item}
                  onQuantity={(quantity) => setQuantity(item.id, quantity)}
                  onRemove={() =>
                    setItems((current) => current.filter((row) => row.id !== item.id))
                  }
                />
              ))}
              <OutlineButton label="+ Ürün seç" onPress={() => setPickerOpen(true)} />
            </>
          ) : (
            <>
              {items.map((item, index) => (
                <FreeformItemCard
                  key={item.id}
                  index={index}
                  item={item}
                  onChange={(patch) =>
                    setItems((current) =>
                      current.map((row) => (row.id === item.id ? { ...row, ...patch } : row))
                    )
                  }
                  onQuantity={(quantity) => setQuantity(item.id, quantity)}
                  onRemove={() =>
                    setItems((current) => current.filter((row) => row.id !== item.id))
                  }
                />
              ))}
              <OutlineButton
                label="+ Ürünsüz satır ekle"
                onPress={() => setItems((current) => [...current, emptyFreeformItem()])}
              />
            </>
          )}
        </Section>

        <Section title="MALİYET KAPSAMI">
          <ToggleRow
            title="Ürün maliyetini düş"
            note="Kapalıysa ürün/birim maliyeti bilinçli olarak hesap dışında kalır."
            value={includeProductCost}
            onChange={setIncludeProductCost}
          />
          {mode === "catalog" ? (
            <ToggleRow
              title="Paketlemeyi düş"
              note="Kayıtlı paketleme bileşenlerini adet/sipariş kapsamıyla uygular."
              value={includePackaging}
              onChange={setIncludePackaging}
            />
          ) : null}
        </Section>

        <Section title="DIŞ GİDERLER">
          <MoneyCostField
            title="Komisyon"
            value={commissionAmount}
            onChange={setCommissionAmount}
            hasVatInvoice={commissionVat}
            onVatChange={setCommissionVat}
          />
          <MoneyCostField
            title="Kargo"
            value={cargoAmount}
            onChange={setCargoAmount}
            hasVatInvoice={cargoVat}
            onVatChange={setCargoVat}
          />
        </Section>

        <Section title="AKTİF GİDER KURALLARI">
          {availableExpenseRules.length === 0 ? (
            <Text style={styles.help}>Aktif gider kuralı yok.</Text>
          ) : (
            availableExpenseRules.map((expense) => {
              const selected = selectedExpenses.find((item) => item.id === expense.id);
              const valueLabel =
                expense.type === "percentage"
                  ? `%${Number((expense.value * 100).toFixed(2))}`
                  : formatCurrency(expense.value);
              return (
                <View key={expense.id} style={styles.expenseCard}>
                  <Pressable
                    onPress={() => toggleExpense(expense)}
                    style={styles.expenseSelectRow}
                  >
                    <View style={[styles.check, selected && styles.checkOn]}>
                      <Text style={styles.checkText}>{selected ? "✓" : ""}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.expenseName}>{expense.name}</Text>
                      <Text style={styles.help}>{valueLabel}</Text>
                    </View>
                  </Pressable>
                  {selected ? (
                    <InvoiceToggle
                      value={selected.hasVatInvoice}
                      onChange={(value) =>
                        setSelectedExpenses((current) =>
                          current.map((item) =>
                            item.id === expense.id
                              ? { ...item, hasVatInvoice: value, amount: undefined }
                              : item
                          )
                        )
                      }
                    />
                  ) : null}
                </View>
              );
            })
          )}
        </Section>

        <Section title="ÖZEL GİDERLER">
          {customExpenses.map((expense) => (
            <View key={expense.id} style={styles.customExpense}>
              <TextField
                value={expense.name}
                onChange={(name) =>
                  setCustomExpenses((current) =>
                    current.map((item) => (item.id === expense.id ? { ...item, name } : item))
                  )
                }
                placeholder="Gider adı"
              />
              <View style={styles.customExpenseBottom}>
                <View style={{ flex: 1 }}>
                  <TextField
                    value={expense.amountText}
                    onChange={(amountText) =>
                      setCustomExpenses((current) =>
                        current.map((item) =>
                          item.id === expense.id ? { ...item, amountText } : item
                        )
                      )
                    }
                    placeholder="0,00 ₺"
                    numeric
                  />
                </View>
                <Pressable
                  onPress={() =>
                    setCustomExpenses((current) =>
                      current.filter((item) => item.id !== expense.id)
                    )
                  }
                  hitSlop={8}
                >
                  <Text style={styles.removeText}>Sil</Text>
                </Pressable>
              </View>
              <InvoiceToggle
                value={expense.hasVatInvoice}
                onChange={(hasVatInvoice) =>
                  setCustomExpenses((current) =>
                    current.map((item) =>
                      item.id === expense.id ? { ...item, hasVatInvoice } : item
                    )
                  )
                }
              />
            </View>
          ))}
          <OutlineButton
            label="+ Özel gider ekle"
            onPress={() =>
              setCustomExpenses((current) => [
                ...current,
                {
                  id: newExpenseId(),
                  name: "",
                  amountText: "",
                  hasVatInvoice: false,
                },
              ])
            }
          />
        </Section>

        <Section title="CANLI NET KÂR">
          <BreakdownRow label="Brüt satış" value={breakdown.grossRevenue} />
          <BreakdownRow label={`Net satış · KDV %${draft.vatRate}`} value={breakdown.netRevenue} />
          <BreakdownRow label="Ürün maliyeti" value={-breakdown.productCost} muted />
          <BreakdownRow label="Paketleme" value={-breakdown.packagingCost} muted />
          <BreakdownRow label="Komisyon" value={-breakdown.commissionCost} muted />
          <BreakdownRow label="Kargo" value={-breakdown.cargoCost} muted />
          <BreakdownRow label="Seçili gider kuralları" value={-breakdown.expenseRulesCost} muted />
          <BreakdownRow label="Özel giderler" value={-breakdown.customExpensesCost} muted />
          <BreakdownRow label="İndirilecek KDV" value={breakdown.inputVatCredit} positive />
          <View style={styles.profitDivider} />
          <View style={styles.profitRow}>
            <View>
              <Text style={styles.profitLabel}>NET KÂR</Text>
              <Text style={styles.help}>
                {breakdown.profitMargin == null
                  ? "Marj hesaplanamadı"
                  : `Marj ${formatPercent(breakdown.profitMargin)}`}
              </Text>
            </View>
            <Text
              style={[
                styles.profitValue,
                {
                  color:
                    breakdown.netProfit == null
                      ? ML.orange
                      : breakdown.netProfit < 0
                        ? ML.red
                        : ML.green,
                },
              ]}
            >
              {breakdown.netProfit == null
                ? "Maliyet eksik"
                : formatCurrency(breakdown.netProfit)}
            </Text>
          </View>
          {breakdown.missingCostItems > 0 ? (
            <Text style={styles.warning}>
              {breakdown.missingCostItems} kalemin maliyeti boş. Birim maliyet gir veya “Ürün
              maliyetini düş” seçeneğini kapat.
            </Text>
          ) : null}
        </Section>

        <Section title="NOT (opsiyonel)">
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Siparişle ilgili kısa not"
            placeholderTextColor={ML.textFaint}
            multiline
            maxLength={1_000}
            style={[styles.input, styles.noteInput]}
          />
        </Section>

        <PrimaryButton
          label={existing ? "Değişiklikleri Kaydet" : "Manuel Siparişi Oluştur"}
          onPress={() => save.mutate()}
          loading={save.isPending}
        />
        {existing ? (
          <DeleteButton
            onPress={() =>
              Alert.alert("Manuel sipariş silinsin mi?", existing.orderNumber, [
                { text: "Vazgeç", style: "cancel" },
                {
                  text: "Sil",
                  style: "destructive",
                  onPress: () => remove.mutate(),
                },
              ])
            }
          />
        ) : null}
        <View style={{ height: 32 }} />
      </ScrollView>

      <ProductPicker
        visible={pickerOpen}
        products={products}
        onClose={() => setPickerOpen(false)}
        onPick={addCatalogProduct}
      />
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

function OutlineButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.outlineButton, pressed && { opacity: 0.75 }]}
    >
      <Text style={styles.outlineButtonText}>{label}</Text>
    </Pressable>
  );
}

function QuantityControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <View style={styles.quantity}>
      <Pressable onPress={() => onChange(value - 1)} style={styles.quantityButton}>
        <Text style={styles.quantityButtonText}>−</Text>
      </Pressable>
      <Text style={styles.quantityValue}>{value}</Text>
      <Pressable onPress={() => onChange(value + 1)} style={styles.quantityButton}>
        <Text style={styles.quantityButtonText}>+</Text>
      </Pressable>
    </View>
  );
}

function CatalogItemCard({
  item,
  onQuantity,
  onRemove,
}: {
  item: FormItem;
  onQuantity: (value: number) => void;
  onRemove: () => void;
}) {
  return (
    <View style={styles.itemCard}>
      <View style={styles.itemTop}>
        {item.imageUrl ? (
          <Image
            source={{ uri: thumbUrl(item.imageUrl, 128)! }}
            style={styles.itemImage}
            contentFit="cover"
          />
        ) : (
          <View style={[styles.itemImage, styles.imageEmpty]} />
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.itemName} numberOfLines={2}>
            {item.name}
          </Text>
          <Text style={styles.help}>
            {item.costKnown
              ? `Ürün ${formatCurrency(item.productionCost)} · paket ${formatCurrency(item.packagingCost)}`
              : "Maliyet kaydı yok"}
          </Text>
        </View>
        <Pressable onPress={onRemove} hitSlop={8}>
          <Text style={styles.removeText}>Sil</Text>
        </Pressable>
      </View>
      <View style={styles.quantityLine}>
        <Text style={styles.help}>Adet</Text>
        <QuantityControl value={item.quantity} onChange={onQuantity} />
      </View>
    </View>
  );
}

function FreeformItemCard({
  item,
  index,
  onChange,
  onQuantity,
  onRemove,
}: {
  item: FormItem;
  index: number;
  onChange: (patch: Partial<FormItem>) => void;
  onQuantity: (value: number) => void;
  onRemove: () => void;
}) {
  return (
    <View style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <Text style={styles.itemIndex}>KALEM {index + 1}</Text>
        <Pressable onPress={onRemove} hitSlop={8}>
          <Text style={styles.removeText}>Sil</Text>
        </Pressable>
      </View>
      <Field label="KALEM ADI">
        <TextField
          value={item.name}
          onChange={(name) => onChange({ name })}
          placeholder="Örn. özel tasarım baskı"
        />
      </Field>
      <View style={styles.quantityLine}>
        <Text style={styles.help}>Adet</Text>
        <QuantityControl value={item.quantity} onChange={onQuantity} />
      </View>
      <Field label="BİRİM MALİYET (boş bırakılabilir)">
        <TextField
          value={item.manualCostText}
          onChange={(manualCostText) => onChange({ manualCostText })}
          placeholder="0,00"
          numeric
        />
      </Field>
      <InvoiceToggle
        value={Boolean(item.manualCostHasVatInvoice)}
        onChange={(manualCostHasVatInvoice) => onChange({ manualCostHasVatInvoice })}
        disabled={item.manualCostText.trim() === ""}
      />
    </View>
  );
}

function ToggleRow({
  title,
  note,
  value,
  onChange,
}: {
  title: string;
  note: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.toggleTitle}>{title}</Text>
        <Text style={styles.help}>{note}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: ML.border, true: ML.accent }}
        thumbColor="#fff"
      />
    </View>
  );
}

function InvoiceToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.invoiceRow, disabled && { opacity: 0.45 }]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.invoiceTitle}>KDV faturası var</Text>
        <Text style={styles.help}>İç KDV indirilecek KDV’ye eklenir.</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: ML.border, true: ML.green }}
        thumbColor="#fff"
      />
    </View>
  );
}

function MoneyCostField({
  title,
  value,
  onChange,
  hasVatInvoice,
  onVatChange,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
  hasVatInvoice: boolean;
  onVatChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.moneyCost}>
      <Field label={`${title.toLocaleUpperCase("tr-TR")} · KDV DAHİL (₺)`}>
        <TextField value={value} onChange={onChange} placeholder="0,00" numeric />
      </Field>
      <InvoiceToggle
        value={hasVatInvoice}
        onChange={onVatChange}
        disabled={value.trim() === ""}
      />
    </View>
  );
}

function BreakdownRow({
  label,
  value,
  positive,
  muted,
}: {
  label: string;
  value: number;
  positive?: boolean;
  muted?: boolean;
}) {
  const formatted =
    value > 0 && positive
      ? `+${formatCurrency(value)}`
      : value < 0
        ? `−${formatCurrency(Math.abs(value))}`
        : formatCurrency(value);
  return (
    <View style={styles.breakdownRow}>
      <Text style={styles.breakdownLabel}>{label}</Text>
      <Text
        style={[
          styles.breakdownValue,
          muted && { color: ML.textDim },
          positive && value > 0 && { color: ML.green },
        ]}
      >
        {formatted}
      </Text>
    </View>
  );
}

function ProductPicker({
  visible,
  products,
  onClose,
  onPick,
}: {
  visible: boolean;
  products: ProductDetail[];
  onClose: () => void;
  onPick: (product: ProductDetail) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const tokens = fold(search.trim()).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return products;
    return products.filter((product) => {
      const haystack = fold(
        [product.name, product.alias, product.sku, product.barcode, product.categoryName]
          .filter(Boolean)
          .join(" ")
      );
      return tokens.every((token) => haystack.includes(token));
    });
  }, [products, search]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.pickerSafe} edges={["top", "bottom"]}>
        <View style={styles.pickerHeader}>
          <Text style={styles.pickerTitle}>Ürün seç</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.pickerClose}>Kapat</Text>
          </Pressable>
        </View>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Ürün, SKU veya barkod ara"
          placeholderTextColor={ML.textFaint}
          autoCorrect={false}
          style={[styles.input, styles.pickerSearch]}
        />
        <FlatList
          data={filtered}
          keyExtractor={(product) => product.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.pickerList}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onPick(item)}
              style={({ pressed }) => [
                styles.pickerItem,
                pressed && { backgroundColor: ML.cardElevated },
              ]}
            >
              {item.imageUrl ? (
                <Image
                  source={{ uri: thumbUrl(item.imageUrl, 128)! }}
                  style={styles.pickerImage}
                  contentFit="cover"
                />
              ) : (
                <View style={[styles.pickerImage, styles.imageEmpty]} />
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName} numberOfLines={2}>
                  {item.name}
                </Text>
                <Text style={styles.help} numberOfLines={1}>
                  {item.sku} · {item.categoryName}
                </Text>
              </View>
            </Pressable>
          )}
          ListEmptyComponent={<Text style={styles.pickerEmpty}>Ürün bulunamadı.</Text>}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },
  errorText: { color: ML.textDim, fontSize: 14, textAlign: "center" },
  content: { padding: 16, gap: 16, paddingBottom: 60 },
  section: { gap: 7 },
  sectionTitle: {
    color: ML.textFaint,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
    marginLeft: 4,
  },
  sectionCard: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 14,
    gap: 14,
  },
  help: { color: ML.textFaint, fontSize: 12, lineHeight: 17 },
  twoCol: { flexDirection: "row", gap: 10 },
  statusWrap: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  statusChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ML.border,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  statusChipOn: { backgroundColor: ML.accentSoft, borderColor: ML.accent },
  statusChipText: { color: ML.textDim, fontSize: 12, fontWeight: "600" },
  statusChipTextOn: { color: ML.accent, fontWeight: "800" },
  outlineButton: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: ML.accent + "88",
    paddingVertical: 12,
    alignItems: "center",
  },
  outlineButtonText: { color: ML.accent, fontSize: 14, fontWeight: "800" },
  itemCard: {
    backgroundColor: ML.cardElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    padding: 12,
    gap: 12,
  },
  itemTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  itemImage: { width: 48, height: 48, borderRadius: 10, backgroundColor: ML.card },
  imageEmpty: { borderWidth: 1, borderColor: ML.border },
  itemName: { color: ML.text, fontSize: 14, fontWeight: "700" },
  itemHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  itemIndex: { color: ML.textFaint, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  removeText: { color: ML.red, fontSize: 12, fontWeight: "700" },
  quantityLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  quantity: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: ML.border,
    borderRadius: 999,
    overflow: "hidden",
  },
  quantityButton: {
    width: 36,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ML.card,
  },
  quantityButtonText: { color: ML.accent, fontSize: 20, fontWeight: "700" },
  quantityValue: {
    color: ML.text,
    minWidth: 34,
    textAlign: "center",
    fontSize: 14,
    fontWeight: "800",
  },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  toggleTitle: { color: ML.text, fontSize: 14, fontWeight: "700" },
  invoiceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 2,
  },
  invoiceTitle: { color: ML.textDim, fontSize: 13, fontWeight: "600" },
  moneyCost: { gap: 9 },
  expenseCard: {
    backgroundColor: ML.cardElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    padding: 11,
    gap: 8,
  },
  expenseSelectRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: ML.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: ML.accent, borderColor: ML.accent },
  checkText: { color: "#fff", fontSize: 13, fontWeight: "900" },
  expenseName: { color: ML.text, fontSize: 14, fontWeight: "700" },
  customExpense: {
    backgroundColor: ML.cardElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    padding: 11,
    gap: 9,
  },
  customExpenseBottom: { flexDirection: "row", alignItems: "center", gap: 12 },
  breakdownRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  breakdownLabel: { color: ML.textDim, fontSize: 13 },
  breakdownValue: {
    color: ML.text,
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  profitDivider: { height: 1, backgroundColor: ML.borderSoft },
  profitRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  profitLabel: { color: ML.textFaint, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  profitValue: { fontSize: 20, fontWeight: "900", textAlign: "right" },
  warning: {
    color: ML.orange,
    backgroundColor: ML.orangeSoft,
    borderRadius: radius.sm,
    padding: 9,
    fontSize: 12,
    lineHeight: 17,
  },
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
  noteInput: { minHeight: 90, textAlignVertical: "top" },
  pickerSafe: { flex: 1, backgroundColor: ML.bg },
  pickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  pickerTitle: { color: ML.text, fontSize: 24, fontWeight: "800" },
  pickerClose: { color: ML.accent, fontSize: 15, fontWeight: "800" },
  pickerSearch: { marginHorizontal: 16, marginBottom: 10 },
  pickerList: { padding: 16, gap: 8 },
  pickerItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 11,
  },
  pickerImage: { width: 46, height: 46, borderRadius: 9, backgroundColor: ML.cardElevated },
  pickerEmpty: { color: ML.textDim, textAlign: "center", marginTop: 40 },
});
