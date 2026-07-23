"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Calculator,
  Check,
  CirclePlus,
  Loader2,
  Package,
  Plus,
  ReceiptText,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  calculateManualOrder,
  type ManualOrderBreakdown,
  type ManualOrderResolvedItem,
  type ManualOrderSelectedExpense,
  type ManualOrderStatusKind,
} from "@/core/manual-order";
import { thumbUrl } from "@/lib/image";
import { fetchJson } from "@/lib/fetch-json";
import { cn, formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

type ManualOrderMode = "catalog" | "freeform";

interface ManualProductOption {
  id: string;
  name: string;
  alias?: string | null;
  variantLabel?: string | null;
  variantGroupName?: string | null;
  imageUrl?: string | null;
  currentSalePrice: number;
  productionCost: number;
  packagingCost: number;
  filamentCost: number;
  packagingComponents?: ManualOrderResolvedItem["packagingComponents"];
  costKnown: boolean;
}

interface ManualExpenseRuleOption {
  id: string;
  name: string;
  type: "fixed" | "percentage" | "per_order";
  value: number;
  platform?: string | null;
  categoryName?: string | null;
  isActive?: boolean;
}

interface ManualOrderOptions {
  vatRate: number;
  products: ManualProductOption[];
  expenseRules: ManualExpenseRuleOption[];
}

interface MoneyCostDraft {
  amount: number;
  hasVatInvoice: boolean;
}

interface CatalogItemDraft {
  id?: string;
  productId: string;
  quantity: number;
}

interface FreeformItemDraft {
  id?: string;
  name: string;
  quantity: number;
  unitCost: number | null;
  manualCostHasVatInvoice?: boolean;
}

interface SelectedExpenseDraft {
  ruleId: string;
  hasVatInvoice: boolean;
}

interface CustomExpenseDraft {
  id?: string;
  name: string;
  amount: number;
  hasVatInvoice: boolean;
}

export interface ManualOrderDraft {
  orderedAt: string;
  orderNumber?: string | null;
  customerName?: string | null;
  statusKind: ManualOrderStatusKind;
  currency: "TRY";
  saleTotal: number;
  note?: string | null;
  mode: ManualOrderMode;
  includeProductCost: boolean;
  includePackaging: boolean;
  commission: MoneyCostDraft;
  cargo: MoneyCostDraft;
  expenseRules: SelectedExpenseDraft[];
  customExpenses: CustomExpenseDraft[];
  items: Array<CatalogItemDraft | FreeformItemDraft>;
}

interface ManualOrderDetailResponse {
  draft?: ManualOrderDraft;
  breakdown?: ManualOrderBreakdown;
  breakdownJson?: { draft?: ManualOrderDraft } | null;
  items?: ManualOrderCapturedItem[];
  resolvedExpenseRules?: ManualOrderSelectedExpense[];
  vatRate?: number;
}

interface ManualOrderCapturedItem extends ManualOrderResolvedItem {
  alias?: string | null;
  variantLabel?: string | null;
  currentSalePrice?: number | null;
}

export interface ManualOrderEditTarget {
  id: string;
  manualOrderId?: string | null;
  editHref?: string | null;
  orderNumber?: string;
  date?: string | null;
  customer?: string | null;
  statusKind?: ManualOrderStatusKind;
  total?: number;
  items?: Array<{
    name: string;
    quantity: number;
    productId?: string | null;
  }>;
}

interface CatalogLineState {
  key: string;
  persistedId?: string;
  productId: string;
  quantity: string;
}

interface FreeformLineState {
  key: string;
  persistedId?: string;
  name: string;
  quantity: string;
  unitCost: string;
  manualCostHasVatInvoice: boolean;
}

interface CustomExpenseState {
  key: string;
  persistedId?: string;
  name: string;
  amount: string;
  hasVatInvoice: boolean;
}

interface MoneyCostState {
  amount: string;
  hasVatInvoice: boolean;
}

interface FormState {
  orderedAt: string;
  orderNumber: string;
  customerName: string;
  statusKind: ManualOrderStatusKind;
  saleTotal: string;
  note: string;
  mode: ManualOrderMode;
  includeProductCost: boolean;
  includePackaging: boolean;
  commission: MoneyCostState;
  cargo: MoneyCostState;
  catalogItems: CatalogLineState[];
  freeformItems: FreeformLineState[];
  selectedExpenses: Record<string, { hasVatInvoice: boolean }>;
  customExpenses: CustomExpenseState[];
}

interface ManualOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: ManualOrderEditTarget | null;
  onSaved?: () => void | Promise<void>;
}

let draftKey = 0;
function nextKey(prefix: string) {
  draftKey += 1;
  return `${prefix}-${draftKey}`;
}

function newPersistentId(prefix: string) {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${nextKey("fallback")}`;
  return `${prefix}-${uuid}`;
}

function istanbulDateTimeInput(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function orderedAtPayload(value: string) {
  if (!value) return new Date().toISOString();
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  return new Date(`${withSeconds}+03:00`).toISOString();
}

function numberOrZero(value: string | number | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function quantityValue(value: string | number | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : 1;
}

function validQuantity(value: string | number | null | undefined) {
  const raw = String(value ?? "").trim();
  const parsed = Number(raw);
  return (
    raw !== "" &&
    Number.isSafeInteger(parsed) &&
    parsed >= 1 &&
    parsed <= 10_000
  );
}

function invalidOptionalMoney(value: string | number | null | undefined) {
  const raw = String(value ?? "").trim();
  if (raw === "") return false;
  const parsed = Number(raw);
  return !Number.isFinite(parsed) || parsed < 0 || parsed > 21_474_836.47;
}

function emptyForm(): FormState {
  return {
    orderedAt: istanbulDateTimeInput(),
    orderNumber: "",
    customerName: "",
    statusKind: "processing",
    saleTotal: "",
    note: "",
    mode: "catalog",
    includeProductCost: true,
    includePackaging: true,
    commission: { amount: "0", hasVatInvoice: false },
    cargo: { amount: "0", hasVatInvoice: false },
    catalogItems: [],
    freeformItems: [
      {
        key: nextKey("free"),
        persistedId: newPersistentId("manual-item"),
        name: "",
        quantity: "1",
        unitCost: "",
        manualCostHasVatInvoice: false,
      },
    ],
    selectedExpenses: {},
    customExpenses: [],
  };
}

function stateFromDraft(draft: ManualOrderDraft): FormState {
  const catalogItems: CatalogLineState[] = [];
  const freeformItems: FreeformLineState[] = [];
  for (const item of draft.items ?? []) {
    if ("productId" in item && item.productId) {
      catalogItems.push({
        key: item.id ?? nextKey("catalog"),
        persistedId: item.id ?? newPersistentId("manual-item"),
        productId: item.productId,
        quantity: String(quantityValue(item.quantity)),
      });
    } else {
      const freeform = item as FreeformItemDraft;
      freeformItems.push({
        key: freeform.id ?? nextKey("free"),
        persistedId: freeform.id ?? newPersistentId("manual-item"),
        name: freeform.name ?? "",
        quantity: String(quantityValue(freeform.quantity)),
        unitCost:
          freeform.unitCost == null || !Number.isFinite(Number(freeform.unitCost))
            ? ""
            : String(freeform.unitCost),
        manualCostHasVatInvoice: Boolean(freeform.manualCostHasVatInvoice),
      });
    }
  }
  return {
    orderedAt: istanbulDateTimeInput(new Date(draft.orderedAt)),
    orderNumber: draft.orderNumber ?? "",
    customerName: draft.customerName ?? "",
    statusKind: draft.statusKind ?? "processing",
    saleTotal: String(draft.saleTotal ?? ""),
    note: draft.note ?? "",
    mode: draft.mode ?? "catalog",
    includeProductCost: draft.includeProductCost ?? true,
    includePackaging: draft.includePackaging ?? true,
    commission: {
      amount: String(draft.commission?.amount ?? 0),
      hasVatInvoice: Boolean(draft.commission?.hasVatInvoice),
    },
    cargo: {
      amount: String(draft.cargo?.amount ?? 0),
      hasVatInvoice: Boolean(draft.cargo?.hasVatInvoice),
    },
    catalogItems,
    freeformItems:
      freeformItems.length > 0
        ? freeformItems
        : [
            {
              key: nextKey("free"),
              persistedId: newPersistentId("manual-item"),
              name: "",
              quantity: "1",
              unitCost: "",
              manualCostHasVatInvoice: false,
            },
          ],
    selectedExpenses: Object.fromEntries(
      (draft.expenseRules ?? []).map((expense) => [
        expense.ruleId,
        { hasVatInvoice: Boolean(expense.hasVatInvoice) },
      ])
    ),
    customExpenses: (draft.customExpenses ?? []).map((expense) => ({
      key: expense.id ?? nextKey("expense"),
      persistedId: expense.id ?? newPersistentId("manual-expense"),
      name: expense.name,
      amount: String(expense.amount),
      hasVatInvoice: Boolean(expense.hasVatInvoice),
    })),
  };
}

function productDisplayName(product: ManualProductOption) {
  const main = product.alias?.trim() || product.name;
  const variant = product.variantLabel?.trim();
  return variant ? `${main} · ${variant}` : main;
}

function capturedItemAsProduct(
  item: ManualOrderCapturedItem
): ManualProductOption | null {
  if (!item.productId) return null;
  return {
    id: item.productId,
    name: item.name,
    alias: item.alias ?? null,
    variantLabel: item.variantLabel ?? null,
    variantGroupName: null,
    imageUrl: item.imageUrl ?? null,
    currentSalePrice: numberOrZero(item.currentSalePrice),
    productionCost: numberOrZero(item.productionCost),
    packagingCost: numberOrZero(item.packagingCost),
    filamentCost: numberOrZero(item.filamentCost),
    packagingComponents: item.packagingComponents ?? null,
    costKnown: item.costKnown,
  };
}

function expenseAmount(rule: ManualExpenseRuleOption, saleTotal: number) {
  if (rule.type === "percentage") return saleTotal * rule.value;
  return rule.value;
}

function invoiceLabel(checked: boolean) {
  return checked ? "KDV faturası var" : "KDV faturası yok";
}

export function ManualOrderDialog({
  open,
  onOpenChange,
  editing = null,
  onSaved,
}: ManualOrderDialogProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [productSearch, setProductSearch] = useState("");
  const initializedFor = useRef<string | null>(null);

  const optionsQuery = useQuery<ManualOrderOptions>({
    queryKey: ["manual-order-options"],
    queryFn: () => fetchJson<ManualOrderOptions>("/api/manual-orders/options"),
    enabled: open,
    staleTime: 60_000,
  });

  const manualOrderId = editing?.manualOrderId || editing?.id || null;
  const detailHref =
    editing?.editHref || (manualOrderId ? `/api/manual-orders/${manualOrderId}` : null);
  const detailQuery = useQuery<ManualOrderDetailResponse>({
    queryKey: ["manual-order", manualOrderId],
    queryFn: () => fetchJson<ManualOrderDetailResponse>(detailHref!),
    enabled: open && Boolean(editing && detailHref),
    staleTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (!open) {
      initializedFor.current = null;
      return;
    }
    const key = editing ? `edit:${manualOrderId}` : "create";
    if (initializedFor.current === key) return;
    if (editing && detailQuery.isLoading) return;

    const detail = detailQuery.data;
    const draft = detail?.draft ?? detail?.breakdownJson?.draft ?? null;
    if (editing && !draft) return;
    initializedFor.current = key;
    const timeout = window.setTimeout(() => {
      setForm(draft ? stateFromDraft(draft) : emptyForm());
      setProductSearch("");
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [
    detailQuery.data,
    detailQuery.isLoading,
    editing,
    manualOrderId,
    open,
  ]);

  const options = optionsQuery.data;
  const products = useMemo(
    () => (Array.isArray(options?.products) ? options.products : []),
    [options]
  );
  const capturedItemsById = useMemo(
    () =>
      new Map(
        (editing && Array.isArray(detailQuery.data?.items)
          ? detailQuery.data.items
          : []
        ).map((item) => [item.id, item])
      ),
    [detailQuery.data, editing]
  );
  const capturedExpenseRules = useMemo(
    () =>
      editing && Array.isArray(detailQuery.data?.resolvedExpenseRules)
        ? detailQuery.data.resolvedExpenseRules
        : [],
    [detailQuery.data, editing]
  );
  const expenseRules = useMemo(() => {
    const rulesById = new Map(
      (Array.isArray(options?.expenseRules) ? options.expenseRules : [])
        .filter((rule) => rule.isActive !== false)
        .map((rule) => [rule.id, rule])
    );
    for (const captured of capturedExpenseRules) {
      rulesById.set(captured.id, {
        id: captured.id,
        name: captured.name,
        type: captured.type,
        value: captured.value,
        isActive: true,
      });
    }
    return [...rulesById.values()];
  }, [capturedExpenseRules, options]);
  const calculationVatRate =
    editing && detailQuery.data?.vatRate != null
      ? numberOrZero(detailQuery.data.vatRate)
      : numberOrZero(options?.vatRate);
  const productById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  );
  const catalogProductByLineKey = useMemo(
    () =>
      new Map(
        form.catalogItems.flatMap((line) => {
          const captured = line.persistedId
            ? capturedItemsById.get(line.persistedId)
            : null;
          const capturedProduct =
            captured?.productId === line.productId
              ? capturedItemAsProduct(captured)
              : null;
          const product =
            capturedProduct ?? productById.get(line.productId) ?? null;
          return product ? [[line.key, product] as const] : [];
        })
      ),
    [capturedItemsById, form.catalogItems, productById]
  );

  const productResults = useMemo(() => {
    const query = productSearch.trim().toLocaleLowerCase("tr-TR");
    if (!query) return [];
    return products
      .filter((product) =>
        [
          product.name,
          product.alias,
          product.variantLabel,
          product.variantGroupName,
        ]
          .filter(Boolean)
          .some((value) =>
            String(value).toLocaleLowerCase("tr-TR").includes(query)
          )
      )
      .slice(0, 10);
  }, [productSearch, products]);

  const resolvedItems = useMemo<ManualOrderResolvedItem[]>(() => {
    if (form.mode === "catalog") {
      return form.catalogItems.flatMap((line) => {
        const product = catalogProductByLineKey.get(line.key);
        if (!product) return [];
        return [
          {
            id: line.persistedId ?? line.key,
            productId: product.id,
            name: productDisplayName(product),
            imageUrl: product.imageUrl ?? null,
            quantity: quantityValue(line.quantity),
            costKnown: product.costKnown,
            productionCost: numberOrZero(product.productionCost),
            packagingCost: numberOrZero(product.packagingCost),
            filamentCost: numberOrZero(product.filamentCost),
            packagingComponents: product.packagingComponents ?? null,
          },
        ];
      });
    }
    return form.freeformItems.map((line) => {
      const costIsKnown = line.unitCost.trim() !== "";
      return {
        id: line.persistedId ?? line.key,
        productId: null,
        name: line.name.trim() || "Adsız ürün",
        imageUrl: null,
        quantity: quantityValue(line.quantity),
        costKnown: costIsKnown,
        productionCost: costIsKnown ? numberOrZero(line.unitCost) : 0,
        packagingCost: 0,
        filamentCost: 0,
        manualUnitCost: costIsKnown ? numberOrZero(line.unitCost) : null,
        manualCostHasVatInvoice: line.manualCostHasVatInvoice,
      };
    });
  }, [
    catalogProductByLineKey,
    form.catalogItems,
    form.freeformItems,
    form.mode,
  ]);

  const saleTotal = numberOrZero(form.saleTotal);
  const selectedRuleInputs = useMemo(
    () =>
      expenseRules.flatMap((rule) => {
        const selected = form.selectedExpenses[rule.id];
        if (!selected) return [];
        return [
          {
            id: rule.id,
            name: rule.name,
            type: rule.type,
            value: rule.value,
            hasVatInvoice: selected.hasVatInvoice,
          },
        ];
      }),
    [expenseRules, form.selectedExpenses]
  );
  const customExpenseInputs = useMemo(
    () =>
      form.customExpenses
        .filter((expense) => expense.name.trim() || numberOrZero(expense.amount) > 0)
        .map((expense) => ({
          id: expense.persistedId ?? expense.key,
          name: expense.name.trim() || "Ek gider",
          amount: numberOrZero(expense.amount),
          hasVatInvoice: expense.hasVatInvoice,
        })),
    [form.customExpenses]
  );

  const breakdown = useMemo(
    () =>
      calculateManualOrder({
        saleTotal,
        vatRate: calculationVatRate,
        mode: form.mode,
        items: resolvedItems,
        includeProductCost: form.includeProductCost,
        includePackaging: form.includePackaging,
        commission: {
          amount: numberOrZero(form.commission.amount),
          hasVatInvoice: form.commission.hasVatInvoice,
        },
        cargo: {
          amount: numberOrZero(form.cargo.amount),
          hasVatInvoice: form.cargo.hasVatInvoice,
        },
        expenseRules: selectedRuleInputs,
        customExpenses: customExpenseInputs,
      }),
    [
      customExpenseInputs,
      form.cargo,
      form.commission,
      form.includePackaging,
      form.includeProductCost,
      form.mode,
      calculationVatRate,
      resolvedItems,
      saleTotal,
      selectedRuleInputs,
    ]
  );

  const formError = useMemo(() => {
    if (!form.orderedAt) return "Sipariş tarihi zorunlu.";
    if (form.saleTotal.trim() === "") return "Satış tutarı zorunlu.";
    const parsedSaleTotal = Number(form.saleTotal);
    if (
      !Number.isFinite(parsedSaleTotal) ||
      parsedSaleTotal < 0 ||
      parsedSaleTotal > 21_474_836.47
    ) {
      return "Satış tutarını kontrol et.";
    }
    if (form.mode === "catalog" && form.catalogItems.length === 0) {
      return "En az bir katalog ürünü ekle.";
    }
    if (
      form.mode === "catalog" &&
      form.catalogItems.some(
        (line) => !line.productId || !validQuantity(line.quantity)
      )
    ) {
      return "Ürün adetleri 1 ile 10.000 arasında tam sayı olmalı.";
    }
    if (
      form.mode === "freeform" &&
      (form.freeformItems.length === 0 ||
        form.freeformItems.some(
          (line) => !line.name.trim() || !validQuantity(line.quantity)
        ))
    ) {
      return "Her serbest kalemin adını ve adedini gir.";
    }
    if (
      form.mode === "freeform" &&
      form.freeformItems.some((line) => invalidOptionalMoney(line.unitCost))
    ) {
      return "Birim maliyetleri kontrol et.";
    }
    if (invalidOptionalMoney(form.commission.amount)) {
      return "Komisyon tutarını kontrol et.";
    }
    if (invalidOptionalMoney(form.cargo.amount)) {
      return "Kargo tutarını kontrol et.";
    }
    if (
      form.customExpenses.some(
        (expense) => {
          const hasName = expense.name.trim() !== "";
          const hasAmount = expense.amount.trim() !== "";
          if (!hasName && !hasAmount) return false;
          return hasName !== hasAmount || invalidOptionalMoney(expense.amount);
        }
      )
    ) {
      return "Ek giderlerin adını ve geçerli tutarını birlikte gir.";
    }
    return null;
  }, [
    form.catalogItems,
    form.cargo.amount,
    form.commission.amount,
    form.customExpenses,
    form.freeformItems,
    form.mode,
    form.orderedAt,
    form.saleTotal,
  ]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: ManualOrderDraft = {
        orderedAt: orderedAtPayload(form.orderedAt),
        orderNumber: form.orderNumber.trim() || null,
        customerName: form.customerName.trim() || null,
        statusKind: form.statusKind,
        currency: "TRY",
        saleTotal,
        note: form.note.trim() || null,
        mode: form.mode,
        includeProductCost: form.includeProductCost,
        includePackaging: form.includePackaging,
        commission: {
          amount: numberOrZero(form.commission.amount),
          hasVatInvoice: form.commission.hasVatInvoice,
        },
        cargo: {
          amount: numberOrZero(form.cargo.amount),
          hasVatInvoice: form.cargo.hasVatInvoice,
        },
        expenseRules: Object.entries(form.selectedExpenses).map(
          ([ruleId, selected]) => ({
            ruleId,
            hasVatInvoice: selected.hasVatInvoice,
          })
        ),
        customExpenses: form.customExpenses
          .filter(
            (expense) =>
              expense.name.trim() || numberOrZero(expense.amount) > 0
          )
          .map((expense) => ({
            ...(expense.persistedId ? { id: expense.persistedId } : {}),
            name: expense.name.trim(),
            amount: numberOrZero(expense.amount),
            hasVatInvoice: expense.hasVatInvoice,
          })),
        items:
          form.mode === "catalog"
            ? form.catalogItems.map((line) => ({
                ...(line.persistedId ? { id: line.persistedId } : {}),
                productId: line.productId,
                quantity: quantityValue(line.quantity),
              }))
            : form.freeformItems.map((line) => ({
                ...(line.persistedId ? { id: line.persistedId } : {}),
                name: line.name.trim(),
                quantity: quantityValue(line.quantity),
                unitCost:
                  line.unitCost.trim() === ""
                    ? null
                    : numberOrZero(line.unitCost),
                manualCostHasVatInvoice: line.manualCostHasVatInvoice,
              })),
      };
      return fetchJson(
        editing && detailHref ? detailHref : "/api/manual-orders",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["orders"] }),
        queryClient.invalidateQueries({ queryKey: ["finance-monthly"] }),
      ]);
      if (manualOrderId) {
        queryClient.removeQueries({ queryKey: ["manual-order", manualOrderId] });
      }
      await onSaved?.();
      toast.success(editing ? "Manuel sipariş güncellendi" : "Manuel sipariş eklendi");
      onOpenChange(false);
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Manuel sipariş kaydedilemedi"
      ),
  });

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function addCatalogProduct(product: ManualProductOption) {
    setForm((current) => {
      const existing = current.catalogItems.find(
        (item) => item.productId === product.id
      );
      return {
        ...current,
        catalogItems: existing
          ? current.catalogItems.map((item) =>
              item.key === existing.key
                ? {
                    ...item,
                    quantity: String(quantityValue(item.quantity) + 1),
                  }
                : item
            )
          : [
              ...current.catalogItems,
              {
                key: nextKey("catalog"),
                persistedId: newPersistentId("manual-item"),
                productId: product.id,
                quantity: "1",
              },
            ],
      };
    });
    setProductSearch("");
  }

  const editDraft =
    detailQuery.data?.draft ?? detailQuery.data?.breakdownJson?.draft ?? null;
  const waitingForEdit = Boolean(
    editing &&
      !editDraft &&
      (detailQuery.isLoading || detailQuery.isFetching)
  );
  const editDetailFailed = Boolean(
    editing &&
      !waitingForEdit &&
      (detailQuery.isError || (detailQuery.isSuccess && !editDraft))
  );
  const optionsFailed = optionsQuery.isError;
  const busy = saveMutation.isPending || waitingForEdit;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="flex h-[min(92vh,920px)] w-full max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-4 py-4 pr-12 sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <ReceiptText className="h-4 w-4" />
            </span>
            {editing ? "Manuel Siparişi Düzenle" : "Manuel Sipariş Ekle"}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Satışı ve gerçek giderlerini gir; net kâr aşağıda anında hesaplanır.
          </p>
        </DialogHeader>

        {waitingForEdit ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Sipariş bilgileri yükleniyor...
          </div>
        ) : editDetailFailed ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </span>
            <div className="max-w-sm">
              <p className="text-sm font-semibold">
                Sipariş ayrıntıları alınamadı
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Kayıtlı maliyet ayrıntılarını korumak için düzenleme kapatıldı.
                Bağlantıyı kontrol edip tekrar deneyebilirsin.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={detailQuery.isFetching}
              onClick={() => detailQuery.refetch()}
            >
              {detailQuery.isFetching && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Tekrar dene
            </Button>
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!formError && !busy) saveMutation.mutate();
            }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="grid items-start gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="min-w-0 space-y-5">
                  <section className="space-y-3">
                    <SectionTitle step="1" title="Sipariş Bilgileri" />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Tarih ve saat *" htmlFor="manual-ordered-at">
                        <Input
                          id="manual-ordered-at"
                          type="datetime-local"
                          value={form.orderedAt}
                          onChange={(event) =>
                            updateForm("orderedAt", event.target.value)
                          }
                        />
                      </Field>
                      <Field
                        label="Sipariş no"
                        htmlFor="manual-order-number"
                        hint="Boş bırakırsan otomatik oluşur."
                      >
                        <Input
                          id="manual-order-number"
                          maxLength={80}
                          value={form.orderNumber}
                          placeholder="Örn. DM-1042"
                          onChange={(event) =>
                            updateForm("orderNumber", event.target.value)
                          }
                        />
                      </Field>
                      <Field label="Müşteri" htmlFor="manual-customer">
                        <Input
                          id="manual-customer"
                          maxLength={120}
                          value={form.customerName}
                          placeholder="İsteğe bağlı"
                          onChange={(event) =>
                            updateForm("customerName", event.target.value)
                          }
                        />
                      </Field>
                      <Field label="Durum">
                        <Select
                          value={form.statusKind}
                          onValueChange={(value) =>
                            updateForm(
                              "statusKind",
                              value as ManualOrderStatusKind
                            )
                          }
                        >
                          <SelectTrigger className="h-9 w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="pending">Bekleyen</SelectItem>
                            <SelectItem value="processing">
                              Hazırlanıyor
                            </SelectItem>
                            <SelectItem value="shipped">Kargoda</SelectItem>
                            <SelectItem value="delivered">Teslim</SelectItem>
                            <SelectItem value="cancelled">İptal</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      <div className="sm:col-span-2">
                        <Field
                          label="Satış tutarı (TRY) *"
                          htmlFor="manual-sale-total"
                          hint="Müşteriden aldığın KDV dahil toplam."
                        >
                          <div className="relative">
                            <Input
                              id="manual-sale-total"
                              type="number"
                              min="0"
                              step="0.01"
                              inputMode="decimal"
                              className="pr-10 text-base font-semibold tabular-nums"
                              value={form.saleTotal}
                              placeholder="0,00"
                              onChange={(event) =>
                                updateForm("saleTotal", event.target.value)
                              }
                            />
                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">
                              TL
                            </span>
                          </div>
                        </Field>
                      </div>
                    </div>
                  </section>

                  <section className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <SectionTitle step="2" title="Ürünler" />
                      <div className="inline-flex rounded-lg border bg-muted/30 p-0.5">
                        {(
                          [
                            ["catalog", "Katalogdan"],
                            ["freeform", "Serbest giriş"],
                          ] as const
                        ).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => updateForm("mode", mode)}
                            className={cn(
                              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                              form.mode === mode
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {form.mode === "catalog" ? (
                      <div className="space-y-3">
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={productSearch}
                            onChange={(event) =>
                              setProductSearch(event.target.value)
                            }
                            placeholder="Ürün ara ve ekle..."
                            className="pl-9"
                            disabled={optionsQuery.isLoading || optionsFailed}
                          />
                          {productSearch.trim() && (
                            <div className="absolute inset-x-0 top-[calc(100%+4px)] z-30 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1.5 shadow-xl">
                              {productResults.length === 0 ? (
                                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                                  Ürün bulunamadı.
                                </p>
                              ) : (
                                productResults.map((product) => (
                                  <button
                                    key={product.id}
                                    type="button"
                                    onClick={() => addCatalogProduct(product)}
                                    className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left hover:bg-muted"
                                  >
                                    <ProductThumb product={product} />
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-sm font-medium">
                                        {productDisplayName(product)}
                                      </span>
                                      <span className="block truncate text-[10px] text-muted-foreground">
                                        {product.variantGroupName
                                          ? `${product.variantGroupName} · `
                                          : ""}
                                        {product.costKnown
                                          ? `Maliyet ${formatCurrency(
                                              product.productionCost
                                            )}`
                                          : "Maliyet eksik"}
                                      </span>
                                    </span>
                                    <Plus className="h-4 w-4 shrink-0 text-primary" />
                                  </button>
                                ))
                              )}
                            </div>
                          )}
                        </div>

                        {optionsQuery.isLoading ? (
                          <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed py-8 text-xs text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Ürünler yükleniyor...
                          </div>
                        ) : optionsFailed ? (
                          <InlineWarning>
                            Ürün seçenekleri alınamadı. Diyaloğu kapatıp tekrar dene.
                          </InlineWarning>
                        ) : form.catalogItems.length === 0 ? (
                          <div className="rounded-xl border border-dashed px-4 py-8 text-center">
                            <Package className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
                            <p className="text-sm font-medium">
                              Henüz ürün eklenmedi
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Yukarıdan ürün ara; aynı ürünü tekrar seçersen adedi artar.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {form.catalogItems.map((line) => {
                              const product = catalogProductByLineKey.get(
                                line.key
                              );
                              if (!product) return null;
                              return (
                                <div
                                  key={line.key}
                                  className="flex items-center gap-2.5 rounded-xl border bg-muted/15 p-2.5"
                                >
                                  <ProductThumb product={product} />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium">
                                      {productDisplayName(product)}
                                    </p>
                                    <p
                                      className={cn(
                                        "text-[10px]",
                                        product.costKnown
                                          ? "text-muted-foreground"
                                          : "text-amber-600 dark:text-amber-400"
                                      )}
                                    >
                                      {product.costKnown
                                        ? `Ürün ${formatCurrency(
                                            product.productionCost
                                          )} · paketleme ${formatCurrency(
                                            product.packagingCost
                                          )}`
                                        : "Ürün maliyeti eksik"}
                                    </p>
                                  </div>
                                  <div className="w-20 shrink-0">
                                    <Label
                                      htmlFor={`catalog-qty-${line.key}`}
                                      className="sr-only"
                                    >
                                      Adet
                                    </Label>
                                    <Input
                                      id={`catalog-qty-${line.key}`}
                                      type="number"
                                      min="1"
                                      step="1"
                                      value={line.quantity}
                                      onChange={(event) =>
                                        setForm((current) => ({
                                          ...current,
                                          catalogItems:
                                            current.catalogItems.map((item) =>
                                              item.key === line.key
                                                ? {
                                                    ...item,
                                                    quantity:
                                                      event.target.value,
                                                  }
                                                : item
                                            ),
                                        }))
                                      }
                                      className="h-8 text-center tabular-nums"
                                      title="Adet"
                                    />
                                  </div>
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                                    title="Ürünü kaldır"
                                    onClick={() =>
                                      setForm((current) => ({
                                        ...current,
                                        catalogItems:
                                          current.catalogItems.filter(
                                            (item) => item.key !== line.key
                                          ),
                                      }))
                                    }
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {form.freeformItems.map((line, index) => (
                          <div
                            key={line.key}
                            className="rounded-xl border bg-muted/15 p-3"
                          >
                            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_80px_130px_auto]">
                              <Field
                                label={`Ürün adı${index === 0 ? " *" : ""}`}
                                htmlFor={`free-name-${line.key}`}
                              >
                                <Input
                                  id={`free-name-${line.key}`}
                                  value={line.name}
                                  placeholder="Örn. Özel tasarım baskı"
                                  onChange={(event) =>
                                    setForm((current) => ({
                                      ...current,
                                      freeformItems:
                                        current.freeformItems.map((item) =>
                                          item.key === line.key
                                            ? {
                                                ...item,
                                                name: event.target.value,
                                              }
                                            : item
                                        ),
                                    }))
                                  }
                                />
                              </Field>
                              <Field
                                label="Adet"
                                htmlFor={`free-qty-${line.key}`}
                              >
                                <Input
                                  id={`free-qty-${line.key}`}
                                  type="number"
                                  min="1"
                                  step="1"
                                  value={line.quantity}
                                  onChange={(event) =>
                                    setForm((current) => ({
                                      ...current,
                                      freeformItems:
                                        current.freeformItems.map((item) =>
                                          item.key === line.key
                                            ? {
                                                ...item,
                                                quantity: event.target.value,
                                              }
                                            : item
                                        ),
                                    }))
                                  }
                                />
                              </Field>
                              <Field
                                label="Birim maliyet"
                                htmlFor={`free-cost-${line.key}`}
                              >
                                <Input
                                  id={`free-cost-${line.key}`}
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={line.unitCost}
                                  placeholder="Bilinmiyorsa boş"
                                  onChange={(event) =>
                                    setForm((current) => ({
                                      ...current,
                                      freeformItems:
                                        current.freeformItems.map((item) =>
                                          item.key === line.key
                                            ? {
                                                ...item,
                                                unitCost: event.target.value,
                                              }
                                            : item
                                        ),
                                    }))
                                  }
                                />
                              </Field>
                              <div className="flex items-end justify-end">
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  className="h-9 w-9 text-muted-foreground hover:text-destructive"
                                  disabled={form.freeformItems.length === 1}
                                  title="Satırı kaldır"
                                  onClick={() =>
                                    setForm((current) => ({
                                      ...current,
                                      freeformItems:
                                        current.freeformItems.filter(
                                          (item) => item.key !== line.key
                                        ),
                                    }))
                                  }
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                            <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                              <Checkbox
                                checked={line.manualCostHasVatInvoice}
                                disabled={line.unitCost.trim() === ""}
                                onCheckedChange={(checked) =>
                                  setForm((current) => ({
                                    ...current,
                                    freeformItems:
                                      current.freeformItems.map((item) =>
                                        item.key === line.key
                                          ? {
                                              ...item,
                                              manualCostHasVatInvoice:
                                                Boolean(checked),
                                            }
                                          : item
                                      ),
                                  }))
                                }
                              />
                              Birim maliyet için KDV faturası var
                            </label>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setForm((current) => ({
                              ...current,
                              freeformItems: [
                                ...current.freeformItems,
                                {
                                  key: nextKey("free"),
                                  persistedId: newPersistentId("manual-item"),
                                  name: "",
                                  quantity: "1",
                                  unitCost: "",
                                  manualCostHasVatInvoice: false,
                                },
                              ],
                            }))
                          }
                        >
                          <CirclePlus className="h-4 w-4" />
                          Serbest ürün ekle
                        </Button>
                      </div>
                    )}
                  </section>

                  <section className="space-y-3">
                    <SectionTitle step="3" title="Maliyetler" />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <ToggleCard
                        title="Ürün maliyetini dahil et"
                        description={
                          form.includeProductCost
                            ? "Üretim veya manuel maliyet düşülür."
                            : "Ürün maliyeti net kârdan düşülmez."
                        }
                        checked={form.includeProductCost}
                        onCheckedChange={(checked) =>
                          updateForm("includeProductCost", checked)
                        }
                      />
                      <ToggleCard
                        title="Paketlemeyi dahil et"
                        description={
                          form.mode === "catalog"
                            ? "Katalogdaki paketleme seçimleri kullanılır."
                            : "Serbest girişte paketleme bilgisi yok."
                        }
                        checked={
                          form.mode === "catalog" && form.includePackaging
                        }
                        disabled={form.mode === "freeform"}
                        onCheckedChange={(checked) =>
                          updateForm("includePackaging", checked)
                        }
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <MoneyCostCard
                        id="manual-commission"
                        title="Komisyon"
                        value={form.commission}
                        onChange={(commission) =>
                          updateForm("commission", commission)
                        }
                      />
                      <MoneyCostCard
                        id="manual-cargo"
                        title="Kargo"
                        value={form.cargo}
                        onChange={(cargo) => updateForm("cargo", cargo)}
                      />
                    </div>
                  </section>

                  <section className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <SectionTitle step="4" title="Diğer Giderler" />
                      <span className="text-[10px] text-muted-foreground">
                        İsteğe bağlı
                      </span>
                    </div>
                    {expenseRules.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          Bu siparişe uygulanacak aktif gider kurallarını seç.
                        </p>
                        {expenseRules.map((rule) => {
                          const selected = form.selectedExpenses[rule.id];
                          const amount = expenseAmount(rule, saleTotal);
                          return (
                            <div
                              key={rule.id}
                              className={cn(
                                "rounded-xl border p-3 transition-colors",
                                selected && "border-primary/35 bg-primary/5"
                              )}
                            >
                              <div className="flex items-start gap-3">
                                <Checkbox
                                  checked={Boolean(selected)}
                                  onCheckedChange={(checked) =>
                                    setForm((current) => {
                                      const next = {
                                        ...current.selectedExpenses,
                                      };
                                      if (checked) {
                                        next[rule.id] = {
                                          hasVatInvoice: false,
                                        };
                                      } else {
                                        delete next[rule.id];
                                      }
                                      return {
                                        ...current,
                                        selectedExpenses: next,
                                      };
                                    })
                                  }
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="text-sm font-medium">
                                      {rule.name}
                                    </span>
                                    <span className="text-xs font-semibold tabular-nums">
                                      {formatCurrency(amount)}
                                    </span>
                                  </div>
                                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                                    {rule.type === "percentage"
                                      ? `%${(rule.value * 100).toFixed(2)}`
                                      : "Sipariş başına sabit tutar"}
                                    {rule.categoryName
                                      ? ` · ${rule.categoryName}`
                                      : ""}
                                  </p>
                                </div>
                              </div>
                              {selected && (
                                <label className="mt-2 flex cursor-pointer items-center gap-2 border-t pt-2 text-[11px] text-muted-foreground">
                                  <Checkbox
                                    checked={selected.hasVatInvoice}
                                    onCheckedChange={(checked) =>
                                      setForm((current) => ({
                                        ...current,
                                        selectedExpenses: {
                                          ...current.selectedExpenses,
                                          [rule.id]: {
                                            hasVatInvoice: Boolean(checked),
                                          },
                                        },
                                      }))
                                    }
                                  />
                                  Bu gider için KDV faturası var
                                </label>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="rounded-xl border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                        Seçilebilecek aktif gider kuralı yok.
                      </p>
                    )}

                    <div className="space-y-2">
                      {form.customExpenses.map((expense) => (
                        <div
                          key={expense.key}
                          className="rounded-xl border bg-muted/15 p-3"
                        >
                          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_130px_auto]">
                            <Field
                              label="Gider adı"
                              htmlFor={`custom-name-${expense.key}`}
                            >
                              <Input
                                id={`custom-name-${expense.key}`}
                                value={expense.name}
                                placeholder="Örn. Hediye paketi"
                                onChange={(event) =>
                                  setForm((current) => ({
                                    ...current,
                                    customExpenses:
                                      current.customExpenses.map((item) =>
                                        item.key === expense.key
                                          ? {
                                              ...item,
                                              name: event.target.value,
                                            }
                                          : item
                                      ),
                                  }))
                                }
                              />
                            </Field>
                            <Field
                              label="Tutar (TL)"
                              htmlFor={`custom-amount-${expense.key}`}
                            >
                              <Input
                                id={`custom-amount-${expense.key}`}
                                type="number"
                                min="0"
                                step="0.01"
                                value={expense.amount}
                                onChange={(event) =>
                                  setForm((current) => ({
                                    ...current,
                                    customExpenses:
                                      current.customExpenses.map((item) =>
                                        item.key === expense.key
                                          ? {
                                              ...item,
                                              amount: event.target.value,
                                            }
                                          : item
                                      ),
                                  }))
                                }
                              />
                            </Field>
                            <div className="flex items-end justify-end">
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="h-9 w-9 text-muted-foreground hover:text-destructive"
                                title="Gideri kaldır"
                                onClick={() =>
                                  setForm((current) => ({
                                    ...current,
                                    customExpenses:
                                      current.customExpenses.filter(
                                        (item) => item.key !== expense.key
                                      ),
                                  }))
                                }
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                          <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                            <Checkbox
                              checked={expense.hasVatInvoice}
                              onCheckedChange={(checked) =>
                                setForm((current) => ({
                                  ...current,
                                  customExpenses:
                                    current.customExpenses.map((item) =>
                                      item.key === expense.key
                                        ? {
                                            ...item,
                                            hasVatInvoice: Boolean(checked),
                                          }
                                        : item
                                    ),
                                }))
                              }
                            />
                            KDV faturası var
                          </label>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            customExpenses: [
                              ...current.customExpenses,
                              {
                                key: nextKey("expense"),
                                persistedId: newPersistentId(
                                  "manual-expense"
                                ),
                                name: "",
                                amount: "",
                                hasVatInvoice: false,
                              },
                            ],
                          }))
                        }
                      >
                        <CirclePlus className="h-4 w-4" />
                        Özel gider ekle
                      </Button>
                    </div>
                  </section>

                  <section className="space-y-2">
                    <SectionTitle step="5" title="Not" />
                    <Label htmlFor="manual-note" className="sr-only">
                      Sipariş notu
                    </Label>
                    <textarea
                      id="manual-note"
                      rows={3}
                      maxLength={1000}
                      value={form.note}
                      placeholder="İsteğe bağlı kısa not..."
                      onChange={(event) => updateForm("note", event.target.value)}
                      className="flex w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                  </section>
                </div>

                <div className="lg:sticky lg:top-5">
                  <ProfitBreakdown
                    breakdown={breakdown}
                    vatRate={calculationVatRate}
                  />
                </div>
              </div>
            </div>

            <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none border-t bg-background/95 px-4 py-3 backdrop-blur sm:px-5">
              <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {formError ? (
                  <>
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                    <span className="truncate text-xs text-muted-foreground">
                      {formError}
                    </span>
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                    <span className="text-xs text-muted-foreground">
                      Kaydetmeye hazır
                    </span>
                  </>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Vazgeç
              </Button>
              <Button
                type="submit"
                disabled={Boolean(formError) || busy || optionsFailed}
                className="min-w-28"
              >
                {saveMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Kaydediliyor...
                  </>
                ) : editing ? (
                  "Değişiklikleri Kaydet"
                ) : (
                  "Siparişi Kaydet"
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SectionTitle({ step, title }: { step: string; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/12 text-[10px] font-bold text-primary">
        {step}
      </span>
      <h2 className="text-sm font-semibold">{title}</h2>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <Label htmlFor={htmlFor} className="text-xs">
          {label}
        </Label>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function ProductThumb({ product }: { product: ManualProductOption }) {
  const src = thumbUrl(product.imageUrl, 80);
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
      {src ? (
        <img
          src={src}
          alt=""
          className="max-h-full max-w-full object-contain"
          loading="lazy"
        />
      ) : (
        <Package className="h-4 w-4 text-muted-foreground/40" />
      )}
    </span>
  );
}

function ToggleCard({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-xl border p-3",
        checked && !disabled && "border-primary/30 bg-primary/5",
        disabled && "opacity-55"
      )}
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold">{title}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function MoneyCostCard({
  id,
  title,
  value,
  onChange,
}: {
  id: string;
  title: string;
  value: MoneyCostState;
  onChange: (value: MoneyCostState) => void;
}) {
  return (
    <div className="space-y-2 rounded-xl border p-3">
      <Field label={`${title} tutarı (TL)`} htmlFor={id}>
        <Input
          id={id}
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={value.amount}
          onChange={(event) =>
            onChange({ ...value, amount: event.target.value })
          }
        />
      </Field>
      <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
        <Checkbox
          checked={value.hasVatInvoice}
          disabled={numberOrZero(value.amount) <= 0}
          onCheckedChange={(checked) =>
            onChange({ ...value, hasVatInvoice: Boolean(checked) })
          }
        />
        {invoiceLabel(value.hasVatInvoice)}
      </label>
    </div>
  );
}

function InlineWarning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      {children}
    </div>
  );
}

function ProfitBreakdown({
  breakdown,
  vatRate,
}: {
  breakdown: ManualOrderBreakdown;
  vatRate: number;
}) {
  const netProfitColor =
    breakdown.netProfit == null
      ? "text-amber-600 dark:text-amber-400"
      : breakdown.netProfit >= 0
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-destructive";
  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="border-b bg-primary/[0.04] px-4 py-3">
        <div className="flex items-center gap-2">
          <Calculator className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Canlı Net Kâr</h2>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Satış ve giderler KDV dahil · KDV oranı %{vatRate}
        </p>
      </div>
      <div className="space-y-2.5 p-4 text-xs">
        <BreakdownRow
          label="KDV dahil satış"
          value={breakdown.grossRevenue}
          strong
        />
        <BreakdownRow
          label="KDV hariç gelir"
          value={breakdown.netRevenue}
          strong
        />
        <BreakdownRow label="Hesaplanan KDV" value={breakdown.outputVat} muted />
        <div className="my-2 border-t" />
        <BreakdownRow label="Ürün maliyeti" value={-breakdown.productCost} />
        <BreakdownRow label="Paketleme" value={-breakdown.packagingCost} />
        <BreakdownRow label="Komisyon" value={-breakdown.commissionCost} />
        <BreakdownRow label="Kargo" value={-breakdown.cargoCost} />
        <BreakdownRow
          label="Seçili giderler"
          value={-breakdown.expenseRulesCost}
        />
        <BreakdownRow
          label="Özel ek giderler"
          value={-breakdown.customExpensesCost}
        />
        <BreakdownRow
          label="İndirilecek KDV"
          value={breakdown.inputVatCredit}
          positive
        />
        <div className="my-2 border-t" />
        <BreakdownRow label="Toplam maliyet" value={breakdown.totalCost} strong />
      </div>
      <div className="border-t bg-muted/25 p-4">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Net kâr
        </p>
        <p className={cn("mt-1 text-2xl font-bold tabular-nums", netProfitColor)}>
          {breakdown.netProfit == null
            ? "Hesaplanamadı"
            : formatCurrency(breakdown.netProfit)}
        </p>
        {breakdown.netProfit != null && breakdown.profitMargin != null && (
          <p className="mt-1 text-xs text-muted-foreground">
            KDV hariç gelirin %{(breakdown.profitMargin * 100).toFixed(1)}’i
          </p>
        )}
        {breakdown.profitPartial && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {breakdown.missingCostItems} kalemin maliyeti eksik. Maliyeti gir veya
            ürün maliyetini kapat.
          </div>
        )}
      </div>
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  strong,
  muted,
  positive,
}: {
  label: string;
  value: number;
  strong?: boolean;
  muted?: boolean;
  positive?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3",
        muted && "text-muted-foreground",
        strong && "font-semibold"
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "shrink-0 tabular-nums",
          positive && value > 0 && "text-emerald-600 dark:text-emerald-400"
        )}
      >
        {value > 0 && positive ? "+" : ""}
        {formatCurrency(value)}
      </span>
    </div>
  );
}
