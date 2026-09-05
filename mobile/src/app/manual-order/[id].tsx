import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { vatRateOf } from "@core/vat";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import { Alert, FlatList, Modal, ScrollView, StyleSheet, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  calculateManualOrder,
  type ManualOrderCustomExpense,
  type ManualOrderMode,
  type ManualOrderSelectedExpense,
  type ManualOrderStatusKind,
} from "@core/manual-order";
import { resolveProductCost } from "@core/product-cost";
import type { ExpenseRuleInput } from "@core/types";

import { DeleteButton, Field, PrimaryButton, Segmented, TextField } from "@/components/form";
import { Chip } from "@/components/kit/Chip";
import {
  Backdrop,
  Button,
  Count,
  ErrorState,
  FadeInView,
  IconButton,
  Input,
  Money,
  Screen,
  SearchInput,
  Shimmer,
  SubHeader,
  Tint,
  Txt,
} from "@/components/kit";
import { PressableScale } from "@/components/kit/PressableScale";
import { getDashboardData } from "@/lib/db/dashboard";
import {
  applyFreeformResolution,
  createManualOrder,
  deleteManualOrder,
  getFreeformCostContext,
  getManualOrder,
  updateManualOrder,
  type FreeformCostContext,
  type ManualOrder,
  type ManualOrderDraft,
  type ManualOrderItem,
  type ManualOrderProduction,
} from "@/lib/db/manual-orders";
import type { ProductDetail } from "@/lib/db/product-detail";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { formatCurrency, formatPercent } from "@/lib/format";
import { thumbUrl } from "@/lib/image";
import { parseTrNumber } from "@/lib/number";
import { color, radius, space } from "@/theme/tokens";

type CostSource = "manual" | "detailed";

/** Form satırı: kaydedilen kalem + kullanıcının yazdığı ham metinler. */
type FormItem = ManualOrderItem & {
  costSource: CostSource;
  manualCostText: string;
  desiText: string;
  filamentTypeId: string | null;
  filamentWeightText: string;
  printTimeText: string;
  wasteRateText: string;
};

type CustomExpenseForm = Omit<ManualOrderCustomExpense, "amount"> & { amountText: string };

const MODES: { key: ManualOrderMode; label: string }[] = [
  { key: "catalog", label: "Katalog ürünü" },
  { key: "freeform", label: "Ürünsüz / özel" },
];

const COST_SOURCES: { key: CostSource; label: string }[] = [
  { key: "detailed", label: "Hesapla" },
  { key: "manual", label: "Elle gir" },
];

const STATUSES: { key: ManualOrderStatusKind; label: string }[] = [
  { key: "pending", label: "Bekliyor" },
  { key: "processing", label: "Hazırlanıyor" },
  { key: "shipped", label: "Gönderildi" },
  { key: "delivered", label: "Tamamlandı" },
  { key: "cancelled", label: "İptal" },
];

/** Formdaki rakamlar her tuşta değişir: kısa akış (kit varsayılanı 700 ms fazla geliyor). */
const FORM_TWEEN = 340;

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
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
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
  return roundTrip.date === dateValue && roundTrip.time === timeValue ? date.toISOString() : null;
}

function numberText(value: number | null | undefined): string {
  if (value == null) return "";
  return String(Number(value.toFixed(4))).replace(".", ",");
}

const EMPTY_TEXTS = {
  manualCostText: "",
  desiText: "",
  filamentTypeId: null,
  filamentWeightText: "",
  printTimeText: "",
  wasteRateText: "",
} as const;

function resolveCatalogItem(product: ProductDetail, settings: Record<string, string>, id = newLineId()): FormItem {
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
    costKnown: resolved?.productionCostKnown ?? false,
    productionCost: resolved?.productionCost ?? 0,
    packagingCost: resolved?.packagingCost ?? 0,
    filamentCost: resolved?.filamentCost ?? 0,
    packagingComponents: resolved?.packagingBreakdown?.components ?? null,
    manualUnitCost: null,
    manualCostHasVatInvoice: false,
    costSource: "manual",
    ...EMPTY_TEXTS,
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
    costSource: "detailed",
    ...EMPTY_TEXTS,
  };
}

function formItems(items: ManualOrderItem[]): FormItem[] {
  return items.map((item) => ({
    ...item,
    costSource: item.costSource === "detailed" ? "detailed" : "manual",
    manualCostText: numberText(item.manualUnitCost),
    desiText: numberText(item.desi),
    filamentTypeId: item.production?.filamentTypeId ?? null,
    filamentWeightText: numberText(item.production?.filamentWeight),
    printTimeText: numberText(item.production?.printTimeHours),
    wasteRateText: item.production?.wasteRate == null ? "" : numberText(item.production.wasteRate * 100),
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

/**
 * MANUEL SİPARİŞ — katalog ürünü veya ürünsüz/özel kalemlerle sipariş girişi; canlı net kâr.
 * Hesap ve doğrulama mantığı öncekiyle birebir (calculateManualOrder, applyFreeformResolution);
 * yalnız sunum kit'e taşındı.
 */
export default function ManualOrderEditScreen() {
  const { id, productId } = useLocalSearchParams<{ id: string; productId?: string }>();
  const isNew = id === "new";
  const orderQuery = useQuery({
    queryKey: ["manual-order", id],
    queryFn: () => getManualOrder(id),
    enabled: !isNew,
    refetchOnMount: "always",
  });
  const productsQuery = useQuery({ queryKey: ["dashboard-data"], queryFn: getDashboardData });
  const rulesQuery = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  const costContextQuery = useQuery({ queryKey: ["freeform-cost-context"], queryFn: getFreeformCostContext });

  const loading =
    productsQuery.isLoading ||
    rulesQuery.isLoading ||
    settingsQuery.isLoading ||
    costContextQuery.isLoading ||
    (!isNew && orderQuery.isLoading);
  const error =
    productsQuery.error ??
    rulesQuery.error ??
    settingsQuery.error ??
    costContextQuery.error ??
    (!isNew && !orderQuery.data ? (orderQuery.error ?? new Error("Manuel sipariş bulunamadı.")) : null);

  if (loading) {
    return (
      <Screen header={<SubHeader title={isNew ? "Yeni manuel sipariş" : "Manuel sipariş"} />}>
        {[0, 1, 2, 3, 4].map((i) => (
          <View key={i} style={{ gap: space.sm }}>
            <Shimmer width="35%" height={11} delay={i * 70} />
            <Shimmer width="100%" height={46} radius={radius.md} delay={i * 70 + 60} />
          </View>
        ))}
      </Screen>
    );
  }

  if (
    error ||
    !productsQuery.data ||
    !rulesQuery.data ||
    !settingsQuery.data ||
    !costContextQuery.data ||
    (!isNew && !orderQuery.data)
  ) {
    return (
      <Screen header={<SubHeader title="Manuel sipariş" />}>
        <ErrorState
          error={error ?? new Error("Veriler yüklenemedi.")}
          onRetry={() => {
            void productsQuery.refetch();
            void rulesQuery.refetch();
            void settingsQuery.refetch();
            void costContextQuery.refetch();
            if (!isNew) void orderQuery.refetch();
          }}
        />
      </Screen>
    );
  }

  const initialProduct = isNew ? (productsQuery.data.find((product) => product.id === productId) ?? null) : null;

  return (
    <ManualOrderForm
      key={orderQuery.data?.updatedAt ?? "new"}
      existing={orderQuery.data ?? null}
      products={productsQuery.data}
      expenseRules={rulesQuery.data.expense}
      settings={settingsQuery.data}
      costContext={costContextQuery.data}
      initialProduct={initialProduct}
    />
  );
}

function ManualOrderForm({
  existing,
  products,
  expenseRules,
  settings,
  costContext,
  initialProduct,
}: {
  existing: ManualOrder | null;
  products: ProductDetail[];
  expenseRules: ExpenseRuleInput[];
  settings: Record<string, string>;
  costContext: FreeformCostContext;
  initialProduct: ProductDetail | null;
}) {
  const qc = useQueryClient();
  const initialDate = istanbulParts(existing ? new Date(existing.orderedAt) : new Date());
  const [mode, setMode] = useState<ManualOrderMode>(existing?.mode ?? "catalog");
  const [orderNumber, setOrderNumber] = useState(existing?.orderNumber ?? "");
  const [customerName, setCustomerName] = useState(existing?.customerName ?? "");
  const [dateValue, setDateValue] = useState(initialDate.date);
  const [timeValue, setTimeValue] = useState(initialDate.time);
  const [statusKind, setStatusKind] = useState<ManualOrderStatusKind>(existing?.statusKind ?? "processing");
  const [saleTotal, setSaleTotal] = useState(existing ? numberText(existing.draft.saleTotal) : "");
  const [includeProductCost, setIncludeProductCost] = useState(existing?.draft.includeProductCost ?? true);
  const [includePackaging, setIncludePackaging] = useState(existing?.draft.includePackaging ?? true);
  const [commissionAmount, setCommissionAmount] = useState(numberText(existing?.draft.commission.amount));
  const [commissionVat, setCommissionVat] = useState(existing?.draft.commission.hasVatInvoice ?? false);
  const [cargoAmount, setCargoAmount] = useState(numberText(existing?.draft.cargo.amount));
  const [cargoVat, setCargoVat] = useState(existing?.draft.cargo.hasVatInvoice ?? false);
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

  const activeFilaments = useMemo(() => costContext.filaments.filter((filament) => filament.isActive), [costContext.filaments]);

  const availableExpenseRules = useMemo(() => {
    const byId = new Map<string, Pick<ManualOrderSelectedExpense, "id" | "name" | "type" | "value">>();
    for (const rule of expenseRules) {
      byId.set(rule.id, { id: rule.id, name: rule.name, type: rule.type, value: rule.value });
    }
    for (const selected of selectedExpenses) {
      if (!byId.has(selected.id)) byId.set(selected.id, selected);
    }
    return [...byId.values()];
  }, [expenseRules, selectedExpenses]);

  const resolvedItems = useMemo<ManualOrderItem[]>(
    () =>
      items.map((formItem) => {
        const { costSource, manualCostText, desiText, filamentTypeId, filamentWeightText, printTimeText, wasteRateText, ...item } = formItem;
        if (mode === "catalog") {
          return { ...item, manualUnitCost: null, manualCostHasVatInvoice: false };
        }
        const detailed = costSource === "detailed";
        const wastePercent = parseTrNumber(wasteRateText);
        const production: ManualOrderProduction | null = detailed
          ? {
              filamentTypeId,
              filamentWeight: parseTrNumber(filamentWeightText),
              printTimeHours: parseTrNumber(printTimeText),
              wasteRate: wastePercent == null ? null : wastePercent / 100,
            }
          : null;
        const manualUnitCost = detailed ? null : parseTrNumber(manualCostText);
        return {
          ...item,
          productId: null,
          imageUrl: null,
          productionCost: 0,
          packagingCost: 0,
          filamentCost: 0,
          packagingComponents: null,
          costSource: detailed ? "detailed" : "manual",
          costKnown: !detailed && manualCostText.trim() !== "" && manualUnitCost != null,
          desi: parseTrNumber(desiText),
          production,
          manualUnitCost,
          manualCostHasVatInvoice: detailed ? false : Boolean(item.manualCostHasVatInvoice),
        };
      }),
    [items, mode]
  );

  const normalizedCustomExpenses = useMemo<ManualOrderCustomExpense[]>(
    () =>
      customExpenses
        .filter((expense) => expense.name.trim() !== "" || expense.amountText.trim() !== "")
        .map((expense) => ({
          id: expense.id,
          name: expense.name.trim(),
          amount: Math.max(0, parseTrNumber(expense.amountText) ?? 0),
          hasVatInvoice: expense.hasVatInvoice,
        })),
    [customExpenses]
  );

  const draft = useMemo<ManualOrderDraft>(() => {
    const base: ManualOrderDraft = {
      saleTotal: Math.max(0, parseTrNumber(saleTotal) ?? 0),
      vatRate: existing?.draft.vatRate ?? vatRateOf(settings),
      mode,
      items: resolvedItems,
      includeProductCost,
      includePackaging: mode === "catalog" && includePackaging,
      commission: { amount: Math.max(0, parseTrNumber(commissionAmount) ?? 0), hasVatInvoice: commissionVat },
      cargo: { amount: Math.max(0, parseTrNumber(cargoAmount) ?? 0), hasVatInvoice: cargoVat },
      expenseRules: selectedExpenses.map(({ amount: _amount, ...expense }) => expense),
      customExpenses: normalizedCustomExpenses,
    };
    // Ürünsüz siparişte maliyet ve kargo, kayıt yolundaki ile AYNI yardımcıyla çözülür →
    // ekranda gördüğün rakam kaydedilen rakamdır.
    const onizlemeTarihi = orderDateIso(dateValue, timeValue);
    return mode === "freeform" ? applyFreeformResolution(base, costContext, onizlemeTarihi ? new Date(onizlemeTarihi) : null) : base;
  }, [
    cargoAmount,
    cargoVat,
    commissionAmount,
    commissionVat,
    costContext,
    // Tarih/saat de bağımlılık: kargo tarifesi siparişin tarihine göre seçiliyor.
    dateValue,
    timeValue,
    existing?.draft.vatRate,
    includePackaging,
    includeProductCost,
    mode,
    normalizedCustomExpenses,
    resolvedItems,
    saleTotal,
    selectedExpenses,
    settings.vatRate,
  ]);
  const breakdown = useMemo(() => calculateManualOrder(draft), [draft]);
  const resolvedById = useMemo(() => new Map(draft.items.map((item) => [item.id, item])), [draft]);

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
    // Ürünsüz siparişte kargo elle girilmez; desiden çözülen tutar kullanılır.
    const validatedCargo = mode === "freeform" ? draft.cargo.amount : parseOptionalCost(cargoAmount, "Kargo");
    const orderedAt = orderDateIso(dateValue, timeValue);
    if (!orderedAt) throw new Error("Tarih YYYY-AA-GG, saat SS:DD biçiminde olmalı.");
    if (resolvedItems.length === 0) throw new Error("En az bir sipariş kalemi ekleyin.");
    if (mode === "freeform" && resolvedItems.some((item) => !item.name.trim())) {
      throw new Error("Ürünsüz satırların adı boş olamaz.");
    }
    if (mode === "freeform") {
      for (const item of items) {
        const label = item.name.trim() || "Sipariş kalemi";
        const checks: [string, string, number][] = [
          [item.desiText, `${label} desisini`, 999],
          [item.filamentWeightText, `${label} filament gramajını`, 100_000],
          [item.printTimeText, `${label} baskı süresini`, 10_000],
          [item.wasteRateText, `${label} fire payını`, 100],
        ];
        if (item.costSource === "manual") {
          checks.push([item.manualCostText, `${label} birim maliyetini`, Number.MAX_SAFE_INTEGER]);
        }
        for (const [text, message, max] of checks) {
          if (text.trim() === "") continue;
          const parsed = parseTrNumber(text);
          if (parsed == null || parsed < 0 || parsed > max) {
            throw new Error(`${message} kontrol edin.`);
          }
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
    onError: (error) => Alert.alert("Kaydedilemedi", error instanceof Error ? error.message : "Bilinmeyen hata"),
  });

  const remove = useMutation({
    mutationFn: () => deleteManualOrder(existing!.id),
    onSuccess: async () => {
      await invalidateManualOrderQueries(existing!.id);
      router.replace("/orders");
    },
    onError: (error) => Alert.alert("Silinemedi", error instanceof Error ? error.message : "Bilinmeyen hata"),
  });

  function changeMode(next: ManualOrderMode) {
    if (next === mode) return;
    const apply = () => {
      setMode(next);
      setItems(next === "freeform" ? [emptyFreeformItem()] : []);
    };
    if (items.length === 0) apply();
    else {
      Alert.alert("Sipariş türü değişsin mi?", "Mevcut kalemler temizlenecek.", [
        { text: "Vazgeç", style: "cancel" },
        { text: "Değiştir", style: "destructive", onPress: apply },
      ]);
    }
  }

  function addCatalogProduct(product: ProductDetail) {
    setItems((current) => {
      const existingIndex = current.findIndex((item) => item.productId === product.id);
      if (existingIndex < 0) return [...current, resolveCatalogItem(product, settings)];
      return current.map((item, index) => (index === existingIndex ? { ...item, quantity: item.quantity + 1 } : item));
    });
    setPickerOpen(false);
    void Haptics.selectionAsync();
  }

  function setQuantity(id: string, quantity: number) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, quantity: Math.max(1, Math.min(10_000, quantity)) } : item))
    );
  }

  function toggleExpense(expense: Pick<ManualOrderSelectedExpense, "id" | "name" | "type" | "value">) {
    setSelectedExpenses((current) => {
      if (current.some((item) => item.id === expense.id)) {
        return current.filter((item) => item.id !== expense.id);
      }
      return [...current, { ...expense, hasVatInvoice: false }];
    });
  }

  return (
    <Screen
      header={<SubHeader title={existing ? "Manuel siparişi düzenle" : "Yeni manuel sipariş"} subtitle={existing?.orderNumber} />}
      contentStyle={{ gap: space.lg }}
    >
      <Section title="SİPARİŞ TÜRÜ" index={0}>
        <Segmented items={MODES} selected={mode} onSelect={changeMode} />
        <Txt v="small" tone="faint">
          {mode === "catalog"
            ? "Kayıtlı ürün maliyeti ve paketleme anlık görüntü olarak saklanır."
            : "Kargo, kalemlere yazdığın desiden otomatik hesaplanır."}
        </Txt>
      </Section>

      <Section title="GENEL BİLGİ" index={1}>
        <Field label="Satış tutarı · KDV dahil (₺)">
          <TextField value={saleTotal} onChange={setSaleTotal} placeholder="0,00" numeric />
        </Field>
        <View style={styles.twoCol}>
          <View style={{ flex: 1 }}>
            <Field label="Tarih">
              <TextField value={dateValue} onChange={setDateValue} placeholder="YYYY-AA-GG" />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Saat">
              <TextField value={timeValue} onChange={setTimeValue} placeholder="SS:DD" />
            </Field>
          </View>
        </View>
        <Field label="Sipariş no (boşsa otomatik)">
          <TextField value={orderNumber} onChange={setOrderNumber} placeholder="M-..." />
        </Field>
        <Field label="Müşteri (isteğe bağlı)">
          <TextField value={customerName} onChange={setCustomerName} placeholder="Ad soyad" />
        </Field>
        <Field label="Durum">
          <View style={styles.chipWrap}>
            {STATUSES.map((status) => (
              <Chip
                key={status.key}
                label={status.label}
                selected={statusKind === status.key}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setStatusKind(status.key);
                }}
              />
            ))}
          </View>
        </Field>
      </Section>

      <Section title={`KALEMLER · ${items.length}`} index={2}>
        {mode === "catalog" ? (
          <>
            {items.map((item, index) => (
              <FadeInView key={item.id} index={index}>
                <CatalogItemCard
                  item={item}
                  onQuantity={(quantity) => setQuantity(item.id, quantity)}
                  onRemove={() => setItems((current) => current.filter((row) => row.id !== item.id))}
                />
              </FadeInView>
            ))}
            <DashedButton label="Ürün seç" onPress={() => setPickerOpen(true)} />
          </>
        ) : (
          <>
            {items.map((item, index) => (
              <FadeInView key={item.id} index={index}>
                <FreeformItemCard
                  index={index}
                  item={item}
                  filaments={activeFilaments}
                  resolved={resolvedById.get(item.id)}
                  onChange={(patch) => setItems((current) => current.map((row) => (row.id === item.id ? { ...row, ...patch } : row)))}
                  onQuantity={(quantity) => setQuantity(item.id, quantity)}
                  onRemove={() => setItems((current) => current.filter((row) => row.id !== item.id))}
                />
              </FadeInView>
            ))}
            <DashedButton label="Ürünsüz satır ekle" onPress={() => setItems((current) => [...current, emptyFreeformItem()])} />
          </>
        )}
      </Section>

      <Section title="MALİYET KAPSAMI" index={3}>
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

      <Section title="DIŞ GİDERLER" index={4}>
        <MoneyCostField title="Komisyon" value={commissionAmount} onChange={setCommissionAmount} hasVatInvoice={commissionVat} onVatChange={setCommissionVat} />
        {mode === "freeform" ? (
          <AutoCargoCard amount={breakdown.cargoCost} desi={breakdown.cargoDesi} ruleMissing={breakdown.cargoRuleMissing} />
        ) : (
          <MoneyCostField title="Kargo" value={cargoAmount} onChange={setCargoAmount} hasVatInvoice={cargoVat} onVatChange={setCargoVat} />
        )}
      </Section>

      <Section title="AKTİF GİDER KURALLARI" index={5}>
        {availableExpenseRules.length === 0 ? (
          <Txt v="small" tone="faint">
            Aktif gider kuralı yok.
          </Txt>
        ) : (
          availableExpenseRules.map((expense, index) => {
            const selected = selectedExpenses.find((item) => item.id === expense.id);
            const valueLabel = expense.type === "percentage" ? `%${Number((expense.value * 100).toFixed(2))}` : formatCurrency(expense.value);
            return (
              <FadeInView key={expense.id} index={index}>
                <Tint style={styles.innerCard}>
                  <PressableScale
                    onPress={() => {
                      void Haptics.selectionAsync();
                      toggleExpense(expense);
                    }}
                    style={styles.selectRow}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: Boolean(selected) }}
                  >
                    <View style={[styles.check, selected ? styles.checkOn : null]}>
                      {selected ? <SymbolView name="checkmark" weight="bold" tintColor={color.onAccent} style={{ width: 12, height: 12 }} /> : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Txt v="bodyStrong">{expense.name}</Txt>
                      <Txt v="small" tone="faint" num>
                        {valueLabel}
                      </Txt>
                    </View>
                  </PressableScale>
                  {selected ? (
                    <InvoiceToggle
                      value={selected.hasVatInvoice}
                      onChange={(value) =>
                        setSelectedExpenses((current) =>
                          current.map((item) => (item.id === expense.id ? { ...item, hasVatInvoice: value, amount: undefined } : item))
                        )
                      }
                    />
                  ) : null}
                </Tint>
              </FadeInView>
            );
          })
        )}
      </Section>

      <Section title="ÖZEL GİDERLER" index={6}>
        {customExpenses.map((expense, index) => (
          <FadeInView key={expense.id} index={index}>
            <Tint style={styles.innerCard}>
              <TextField
                value={expense.name}
                onChange={(name) => setCustomExpenses((current) => current.map((item) => (item.id === expense.id ? { ...item, name } : item)))}
                placeholder="Gider adı"
              />
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}>
                  <TextField
                    value={expense.amountText}
                    onChange={(amountText) =>
                      setCustomExpenses((current) => current.map((item) => (item.id === expense.id ? { ...item, amountText } : item)))
                    }
                    placeholder="0,00 ₺"
                    numeric
                  />
                </View>
                <IconButton
                  icon="trash"
                  tint={color.bad}
                  onPress={() => setCustomExpenses((current) => current.filter((item) => item.id !== expense.id))}
                  accessibilityLabel="Gideri sil"
                  style={{ alignSelf: "center" }}
                />
              </View>
              <InvoiceToggle
                value={expense.hasVatInvoice}
                onChange={(hasVatInvoice) =>
                  setCustomExpenses((current) => current.map((item) => (item.id === expense.id ? { ...item, hasVatInvoice } : item)))
                }
              />
            </Tint>
          </FadeInView>
        ))}
        <DashedButton
          label="Özel gider ekle"
          onPress={() => setCustomExpenses((current) => [...current, { id: newExpenseId(), name: "", amountText: "", hasVatInvoice: false }])}
        />
      </Section>

      <Section title="CANLI NET KÂR" index={7} glass>
        <BreakdownRow label="Brüt satış" value={breakdown.grossRevenue} />
        <BreakdownRow label={`Net satış · KDV %${draft.vatRate}`} value={breakdown.netRevenue} />
        <BreakdownRow label="Ürün maliyeti" value={-breakdown.productCost} muted />
        <BreakdownRow label="Paketleme" value={-breakdown.packagingCost} muted />
        <BreakdownRow label="Komisyon" value={-breakdown.commissionCost} muted />
        <BreakdownRow label={mode === "freeform" ? "Kargo · desiye göre" : "Kargo"} value={-breakdown.cargoCost} muted />
        <BreakdownRow label="Seçili gider kuralları" value={-breakdown.expenseRulesCost} muted />
        <BreakdownRow label="Özel giderler" value={-breakdown.customExpensesCost} muted />
        <BreakdownRow label="İndirilecek KDV" value={breakdown.inputVatCredit} positive />
        <View style={styles.divider} />
        <View style={styles.rowBetween}>
          <View>
            <Txt v="label" tone="faint" style={styles.kicker}>
              NET KÂR
            </Txt>
            <Txt v="small" tone="faint" num>
              {breakdown.profitMargin == null ? "Marj hesaplanamadı" : `Marj ${formatPercent(breakdown.profitMargin)}`}
            </Txt>
          </View>
          {breakdown.netProfit == null ? (
            <Txt v="heading" tone="warn">
              Maliyet eksik
            </Txt>
          ) : (
            <Money value={breakdown.netProfit} v="title" tone={breakdown.netProfit < 0 ? "bad" : "good"} durationMs={FORM_TWEEN} />
          )}
        </View>
        {breakdown.missingCostItems > 0 ? (
          <View style={styles.warn}>
            <Txt v="small" tone="warn">
              {breakdown.missingCostItems} kalemin maliyeti boş. Maliyet gir veya “Ürün maliyetini düş” seçeneğini kapat.
            </Txt>
          </View>
        ) : null}
      </Section>

      <Section title="NOT (isteğe bağlı)" index={8}>
        <Input
          value={note}
          onChangeText={setNote}
          placeholder="Siparişle ilgili kısa not"
          multiline
          maxLength={1_000}
          style={{ minHeight: 96, alignItems: "flex-start", paddingVertical: space.sm }}
          inputStyle={{ minHeight: 80, textAlignVertical: "top" }}
        />
      </Section>

      <PrimaryButton label={existing ? "Değişiklikleri kaydet" : "Manuel siparişi oluştur"} onPress={() => save.mutate()} loading={save.isPending} />
      {existing ? (
        <DeleteButton
          onPress={() =>
            Alert.alert("Manuel sipariş silinsin mi?", existing.orderNumber, [
              { text: "Vazgeç", style: "cancel" },
              { text: "Sil", style: "destructive", onPress: () => remove.mutate() },
            ])
          }
        />
      ) : null}

      <ProductPicker visible={pickerOpen} products={products} onClose={() => setPickerOpen(false)} onPick={addCatalogProduct} />
    </Screen>
  );
}

function Section({ title, index = 0, glass = false, children }: { title: string; index?: number; glass?: boolean; children: React.ReactNode }) {
  return (
    <FadeInView index={index} style={{ gap: space.sm }}>
      <Txt v="label" tone="faint" style={styles.kicker}>
        {title}
      </Txt>
      <Tint strong style={[styles.sectionCard, glass ? styles.sectionGlass : null]}>
        {children}
      </Tint>
    </FadeInView>
  );
}

/** Kesikli çerçeveli "ekle" düğmesi — bölümün sonunda yeni satır/gider açar. */
function DashedButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <PressableScale
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={styles.dashed}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <SymbolView name="plus" tintColor={color.accentBright} weight="semibold" style={{ width: 14, height: 14 }} />
      <Txt v="bodyStrong" tone="accent">
        {label}
      </Txt>
    </PressableScale>
  );
}

function QuantityControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <View style={styles.quantity}>
      <IconButton
        icon="minus"
        size={32}
        onPress={() => {
          void Haptics.selectionAsync();
          onChange(value - 1);
        }}
        haptic="yok"
        accessibilityLabel="Adedi azalt"
      />
      <Count value={value} v="bodyStrong" animate={false} style={{ minWidth: 30, textAlign: "center" }} />
      <IconButton
        icon="plus"
        size={32}
        accent
        onPress={() => {
          void Haptics.selectionAsync();
          onChange(value + 1);
        }}
        haptic="yok"
        accessibilityLabel="Adedi artır"
      />
    </View>
  );
}

function CatalogItemCard({ item, onQuantity, onRemove }: { item: FormItem; onQuantity: (value: number) => void; onRemove: () => void }) {
  return (
    <Tint style={styles.innerCard}>
      <View style={styles.itemTop}>
        {item.imageUrl ? (
          <Image source={{ uri: thumbUrl(item.imageUrl, 128)! }} style={styles.itemImage} contentFit="cover" />
        ) : (
          <View style={[styles.itemImage, styles.imageEmpty]}>
            <SymbolView name="cube.box" tintColor={color.textFaint} style={{ width: 18, height: 18 }} />
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt v="bodyStrong" numberOfLines={2}>
            {item.name}
          </Txt>
          <Txt v="small" tone="faint" num>
            {item.costKnown ? `Ürün ${formatCurrency(item.productionCost)} · paket ${formatCurrency(item.packagingCost)}` : "Maliyet kaydı yok"}
          </Txt>
        </View>
        <IconButton icon="trash" size={32} tint={color.bad} onPress={onRemove} accessibilityLabel="Kalemi kaldır" />
      </View>
      <View style={styles.rowBetween}>
        <Txt v="small" tone="faint">
          Adet
        </Txt>
        <QuantityControl value={item.quantity} onChange={onQuantity} />
      </View>
    </Tint>
  );
}

function FilamentPicker({
  filaments,
  selectedId,
  onSelect,
}: {
  filaments: { id: string; name: string; costPerGram: number }[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (filaments.length === 0) {
    return (
      <Txt v="small" tone="faint">
        Kayıtlı filament yok.
      </Txt>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.chipRow}>
      {filaments.map((filament) => {
        const selected = filament.id === selectedId;
        return (
          <Chip
            key={filament.id}
            label={filament.name}
            selected={selected}
            onPress={() => {
              void Haptics.selectionAsync();
              onSelect(selected ? null : filament.id);
            }}
            style={{ maxWidth: 200 }}
          />
        );
      })}
    </ScrollView>
  );
}

function FreeformItemCard({
  item,
  index,
  filaments,
  resolved,
  onChange,
  onQuantity,
  onRemove,
}: {
  item: FormItem;
  index: number;
  filaments: { id: string; name: string; costPerGram: number }[];
  resolved: ManualOrderItem | undefined;
  onChange: (patch: Partial<FormItem>) => void;
  onQuantity: (value: number) => void;
  onRemove: () => void;
}) {
  const detailed = item.costSource === "detailed";
  const selectedFilament = filaments.find((filament) => filament.id === item.filamentTypeId);
  const unitCost = resolved?.productionCost ?? 0;

  return (
    <Tint style={styles.innerCard}>
      <View style={styles.rowBetween}>
        <Txt v="label" tone="faint" style={styles.kicker}>
          KALEM {index + 1}
        </Txt>
        <IconButton icon="trash" size={32} tint={color.bad} onPress={onRemove} accessibilityLabel="Kalemi kaldır" />
      </View>
      <Field label="Kalem adı">
        <TextField value={item.name} onChange={(name) => onChange({ name })} placeholder="Örn. özel tasarım baskı" />
      </Field>
      <View style={styles.rowBetween}>
        <Txt v="small" tone="faint">
          Adet
        </Txt>
        <QuantityControl value={item.quantity} onChange={onQuantity} />
      </View>
      <Field label="Desi (kargo için)">
        <TextField value={item.desiText} onChange={(desiText) => onChange({ desiText })} placeholder="Örn. 2" numeric />
      </Field>

      <Field label="Maliyet">
        <Segmented items={COST_SOURCES} selected={item.costSource} onSelect={(costSource) => onChange({ costSource })} />
      </Field>

      {detailed ? (
        <FadeInView key="detailed">
          <View style={styles.detailedBox}>
            <Field label="Filament türü">
              <FilamentPicker filaments={filaments} selectedId={item.filamentTypeId} onSelect={(filamentTypeId) => onChange({ filamentTypeId })} />
            </Field>
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}>
                <Field label="Gramaj (g)">
                  <TextField value={item.filamentWeightText} onChange={(filamentWeightText) => onChange({ filamentWeightText })} placeholder="0" numeric />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Baskı süresi (saat)">
                  <TextField value={item.printTimeText} onChange={(printTimeText) => onChange({ printTimeText })} placeholder="0" numeric />
                </Field>
              </View>
            </View>
            <Field label="Fire payı (%)">
              <TextField value={item.wasteRateText} onChange={(wasteRateText) => onChange({ wasteRateText })} placeholder="0" numeric />
            </Field>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1 }}>
                <Txt v="label" tone="faint" style={styles.kicker}>
                  BİRİM MALİYET
                </Txt>
                <Txt v="small" tone="faint">
                  {selectedFilament ? `${selectedFilament.name} · elektrik, aşınma ve işçilik dahil` : "Filament türü seç"}
                </Txt>
              </View>
              <Money value={unitCost} v="heading" durationMs={FORM_TWEEN} />
            </View>
          </View>
        </FadeInView>
      ) : (
        <FadeInView key="manual">
          <View style={styles.detailedBox}>
            <Field label="Birim maliyet (boş bırakılabilir)">
              <TextField value={item.manualCostText} onChange={(manualCostText) => onChange({ manualCostText })} placeholder="0,00" numeric />
            </Field>
            <InvoiceToggle
              value={Boolean(item.manualCostHasVatInvoice)}
              onChange={(manualCostHasVatInvoice) => onChange({ manualCostHasVatInvoice })}
              disabled={item.manualCostText.trim() === ""}
            />
          </View>
        </FadeInView>
      )}
    </Tint>
  );
}

function AutoCargoCard({ amount, desi, ruleMissing }: { amount: number; desi: number; ruleMissing: boolean }) {
  return (
    <View style={{ gap: space.sm }}>
      <View style={styles.rowBetween}>
        <View style={{ flex: 1 }}>
          <Txt v="label" tone="faint" style={styles.kicker}>
            KARGO
          </Txt>
          <Txt v="small" tone="faint" num>
            {desi > 0 ? `Toplam ${Number(desi.toFixed(2))} desi üzerinden` : "Kalemlere desi gir"}
          </Txt>
        </View>
        <Money value={amount} v="heading" durationMs={FORM_TWEEN} />
      </View>
      {ruleMissing && desi > 0 ? (
        <View style={styles.warn}>
          <Txt v="small" tone="warn">
            Bu desi için kargo fiyatı tanımlı değil.
          </Txt>
        </View>
      ) : null}
    </View>
  );
}

function ToggleRow({ title, note, value, onChange }: { title: string; note: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.rowBetween}>
      <View style={{ flex: 1 }}>
        <Txt v="bodyStrong">{title}</Txt>
        <Txt v="small" tone="faint">
          {note}
        </Txt>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: color.tintStrong, true: color.accent }}
        ios_backgroundColor={color.tintStrong}
        thumbColor="#fff"
      />
    </View>
  );
}

function InvoiceToggle({ value, onChange, disabled }: { value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <View style={[styles.rowBetween, disabled ? { opacity: 0.45 } : null]}>
      <View style={{ flex: 1 }}>
        <Txt v="smallStrong" tone="dim">
          KDV faturası var
        </Txt>
        <Txt v="small" tone="faint">
          İç KDV indirilecek KDV’ye eklenir.
        </Txt>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: color.tintStrong, true: color.good }}
        ios_backgroundColor={color.tintStrong}
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
    <View style={{ gap: space.sm }}>
      <Field label={`${title} · KDV dahil (₺)`}>
        <TextField value={value} onChange={onChange} placeholder="0,00" numeric />
      </Field>
      <InvoiceToggle value={hasVatInvoice} onChange={onVatChange} disabled={value.trim() === ""} />
    </View>
  );
}

function BreakdownRow({ label, value, positive, muted }: { label: string; value: number; positive?: boolean; muted?: boolean }) {
  const prefix = value > 0 && positive ? "+" : value < 0 ? "−" : "";
  const tone = positive && value > 0 ? "good" : muted ? "dim" : "default";
  return (
    <View style={styles.rowBetween}>
      <Txt v="small" tone="dim">
        {label}
      </Txt>
      <View style={{ flexDirection: "row", alignItems: "baseline" }}>
        {prefix ? (
          <Txt v="smallStrong" tone={tone} num>
            {prefix}
          </Txt>
        ) : null}
        <Money value={Math.abs(value)} v="smallStrong" tone={tone} durationMs={FORM_TWEEN} />
      </View>
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
      const haystack = fold([product.name, product.alias, product.sku, product.barcode, product.categoryName].filter(Boolean).join(" "));
      return tokens.every((token) => haystack.includes(token));
    });
  }, [products, search]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: color.bg0 }}>
        <Backdrop />
        <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
          <SubHeader
            title="Ürün seç"
            subtitle={`${filtered.length} ürün`}
            onBack={onClose}
            right={<Button label="Kapat" size="sm" variant="secondary" onPress={onClose} />}
          />
          <View style={styles.pickerSearch}>
            <SearchInput value={search} onChangeText={setSearch} placeholder="Ürün, SKU veya barkod ara" autoFocus />
          </View>
          <FlatList
            data={filtered}
            keyExtractor={(product) => product.id}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={styles.pickerList}
            ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
            renderItem={({ item }) => (
              <Tint strong onPress={() => onPick(item)} style={styles.pickerItem} accessibilityLabel={item.name}>
                {item.imageUrl ? (
                  <Image source={{ uri: thumbUrl(item.imageUrl, 128)! }} style={styles.itemImage} contentFit="cover" />
                ) : (
                  <View style={[styles.itemImage, styles.imageEmpty]}>
                    <SymbolView name="cube.box" tintColor={color.textFaint} style={{ width: 18, height: 18 }} />
                  </View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt v="bodyStrong" numberOfLines={2}>
                    {item.name}
                  </Txt>
                  <Txt v="small" tone="faint" numberOfLines={1}>
                    {item.sku} · {item.categoryName}
                  </Txt>
                </View>
                <SymbolView name="plus.circle.fill" tintColor={color.accentBright} style={{ width: 22, height: 22 }} />
              </Tint>
            )}
            ListEmptyComponent={
              <Txt v="body" tone="dim" center style={{ marginTop: space.xxl }}>
                Ürün bulunamadı.
              </Txt>
            }
          />
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  kicker: { letterSpacing: 1 },
  sectionCard: { gap: space.md },
  sectionGlass: { borderColor: color.accent + "55" },
  innerCard: { gap: space.md },
  twoCol: { flexDirection: "row", gap: space.sm },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chipRow: { gap: space.sm, paddingRight: space.xs },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  dashed: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: color.accent + "88",
  },
  quantity: { flexDirection: "row", alignItems: "center", gap: space.xs },
  selectRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  check: {
    width: 24,
    height: 24,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: color.lineStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: color.accent, borderColor: color.accent },
  itemTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  itemImage: { width: 48, height: 48, borderRadius: radius.xs, backgroundColor: color.tintStrong },
  imageEmpty: { alignItems: "center", justifyContent: "center" },
  detailedBox: { gap: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line, paddingTop: space.md },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.lineStrong },
  warn: { backgroundColor: color.warnSoft, borderRadius: radius.sm, padding: space.sm },
  pickerSearch: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  pickerList: { paddingHorizontal: space.lg, paddingBottom: space.xxl },
  pickerItem: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
});
