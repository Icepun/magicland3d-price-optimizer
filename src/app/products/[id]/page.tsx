"use client";

import { use, useState, useEffect, useMemo, memo, useCallback, useDeferredValue, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { patchProductsInCache } from "@/lib/products-cache";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { PriceHistoryCard } from "@/components/products/PriceHistoryCard";
import { PriceLabCard } from "@/components/products/PriceLabCard";
import { VariantsCard } from "@/components/products/VariantsCard";
import { StockInput } from "@/components/products/StockInput";
import { ModelFilesCard } from "@/components/products/ModelFilesCard";
import { ProductImageEditorDialog } from "@/components/products/ProductImageEditorDialog";
import { MatchListingModal } from "@/components/products/MatchListingModal";
import { CostEditor, type CostValues, type CostInitial } from "@/components/products/CostEditor";
import { formatCurrency, formatPercent, cn } from "@/lib/utils";
import { useStockWriter } from "@/lib/use-stock-writer";
import { ArrowLeft, Package, AlertTriangle, Plus, Trash2, Minus, Camera, RefreshCw } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import Link from "next/link";
import { toast } from "sonner";
import type { SimulationResult, CommissionRuleInput, CargoRuleInput, ExpenseRuleInput } from "@/core/types";
import { parsePackagingSettings, type NylonLevel } from "@/core/packaging";
import { computeProfitPreview, computePriceLab, type ProfitPreview } from "@/lib/client-pricing";
import { fetchJson } from "@/lib/fetch-json";

interface FilamentType {
  id: string;
  name: string;
  costPerGram: number;
}

interface Listing {
  id: string;
  productId: string;
  platform: "shopify" | "trendyol" | "hepsiburada";
  externalId: string | null;
  externalSku: string | null;
  barcode: string | null;
  salePrice: number;
  listPrice: number | null;
  stock: number;
  commissionRate: number | null;
  commissionFixed: number | null;
  cargoCost: number | null;
  isActive: boolean;
  lastSyncedAt: string | null;
}

interface ProductDetail {
  id: string;
  barcode: string;
  sku: string;
  name: string;
  alias: string | null;
  categoryName: string;
  currentSalePrice: number;
  commissionRate: number | null;
  stock: number;
  madeToOrder: boolean;
  desi: number | null;
  imageUrl: string | null;
  imageManual?: boolean;
  source: string;
  cost: {
    costMode: string;
    manualCost: number | null;
    packagingCost: number | null;
    totalCost: number | null;
    filamentTypeId: string | null;
    filamentWeight: number | null;
    printTimeHours: number | null;
    wasteRate: number | null;
    packagingPoset: number | null;
    packagingNaylon: number | null;
    packagingBant: number | null;
    packagingKart: number | null;
    packagingOptionId: string | null;
    nylonLevel: string | null;
    tapeUsed: boolean | null;
  } | null;
  listings: Listing[];
  variantLabel: string | null;
  variantGroupId: string | null;
  variantGroup: {
    id: string;
    name: string;
    shareModels: boolean;
    products: {
      id: string;
      name: string;
      variantLabel: string | null;
      imageUrl: string | null;
      stock: number;
      currentSalePrice: number;
    }[];
  } | null;
}

interface CostSaveAttempt {
  productId: string;
  values: CostValues;
  revision: number;
}

const PLATFORM_INFO = {
  shopify: { label: "Shopify", color: "oklch(0.60 0.16 152)" },
  trendyol: { label: "Trendyol", color: "oklch(0.72 0.17 60)" },
  hepsiburada: { label: "Hepsiburada", color: "oklch(0.66 0.19 38)" },
} as const;

export default function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();

  const { data: product, isLoading, isError, refetch: refetchProduct } = useQuery<ProductDetail>({
    queryKey: ["product", id],
    queryFn: () => fetchJson(`/api/products/${id}`),
  });

  const { data: filaments = [] } = useQuery<FilamentType[]>({
    queryKey: ["filament-types"],
    queryFn: () => fetchJson("/api/filament-types"),
  });

  const { data: globalSettings = {} } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetchJson("/api/settings"),
  });

  // Kâr kuralları — bir kez çekilip uygulama genelinde cache'lenir (staleTime uzun, nadir değişir).
  // Maliyet önizlemesi + Fiyat Lab BUNLARLA İSTEMCİDE hesaplanır → maliyet değişince Electron ana
  // sürecine otomatik okuma gitmez (eskiden her değişimde profit-preview, her kayıtta price-lab
  // ana süreçte koşup pencereyi donduruyordu).
  const { data: commissionRules } = useQuery<CommissionRuleInput[]>({
    queryKey: ["commission-rules"],
    queryFn: () => fetchJson("/api/commission-rules"),
    staleTime: 5 * 60_000,
  });
  const { data: cargoRules } = useQuery<CargoRuleInput[]>({
    queryKey: ["cargo-rules"],
    queryFn: () => fetchJson("/api/cargo-rules"),
    staleTime: 5 * 60_000,
  });
  const { data: expenseRules } = useQuery<ExpenseRuleInput[]>({
    queryKey: ["expense-rules"],
    queryFn: () => fetchJson("/api/expense-rules"),
    staleTime: 5 * 60_000,
  });

  // Kimlik formu state (maliyet formu artık izole CostEditor'da → yazarken bu dev sayfa render olmaz)
  const productKey = product?.id ?? "";
  const aliasSource = product?.alias ?? "";
  const [aliasDraft, setAliasDraft] = useState({ productId: "", value: "" });
  const aliasInput = aliasDraft.productId === productKey ? aliasDraft.value : aliasSource;
  const setAliasInput = (value: string) => setAliasDraft({ productId: productKey, value });
  const [imageEditorOpen, setImageEditorOpen] = useState(false);

  // Paketleme ayarları — globalSettings değişmedikçe yeniden parse etme (her render'da JSON.parse YOK).
  const packagingSettings = useMemo(() => parsePackagingSettings(globalSettings), [globalSettings]);

  // ── İzole maliyet formu ⇄ parent köprüsü ──
  // CostEditor tüm input state'ini LOCAL tutar; 250ms debounce'la buraya bildirir. Böylece tuşa
  // basınca yalnız o küçük kart render olur; bu dev sayfa (3 platform kartı + grafikler) DEĞİL.
  const seededCostValues = useMemo<CostValues | null>(() => {
    if (!product) return null;
    const cost = product.cost;
    return {
      filamentTypeId: cost?.filamentTypeId || "",
      filamentWeight: cost?.filamentWeight ?? 0,
      printTimeHours: cost?.printTimeHours ?? 0,
      wasteRate: Number(cost?.wasteRate) || 0,
      packagingOptionId: cost?.packagingOptionId || "",
      nylonLevel: (cost?.nylonLevel as NylonLevel) || "none",
      tapeUsed: Boolean(cost?.tapeUsed),
      desi: product.desi ?? null,
    };
    // Yalnız ürün kimliği değişince seed et; aynı üründeki cache güncellemesi formu ezmemeli.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);
  const [costDraft, setCostDraft] = useState<{ productId: string; values: CostValues } | null>(null);
  const costValues = costDraft?.productId === productKey ? costDraft.values : seededCostValues;
  const latestCostRef = useRef<CostValues | null>(null);
  const costRevisionRef = useRef(0);
  const attemptedCostRevisionRef = useRef(0);
  const handleCostChange = useCallback((v: CostValues) => {
    latestCostRef.current = v;
    costRevisionRef.current += 1;
    setCostDraft({ productId: productKey, values: v });
  }, [productKey]);

  // CostEditor başlangıç değerleri — yalnız ürün kimliği değişince yeniden hesaplanır (sabit prop → memo tutar).
  const initialCost = useMemo<CostInitial>(() => {
    const c = product?.cost;
    return {
      filamentTypeId: c?.filamentTypeId || "",
      filamentWeight: c?.filamentWeight ? String(c.filamentWeight) : "",
      printTimeHours: c?.printTimeHours ? String(c.printTimeHours) : "",
      wasteRate: c?.wasteRate ? String(Number(c.wasteRate) * 100) : "",
      packagingOptionId: c?.packagingOptionId || "",
      nylonLevel: (c?.nylonLevel as NylonLevel) || "none",
      tapeUsed: Boolean(c?.tapeUsed),
      desiInput: product?.desi ? String(product.desi) : "",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  // Ürün değişince autosave revizyonlarını sıfırla; form değeri render sırasında ürün anahtarından türetilir.
  useEffect(() => {
    latestCostRef.current = seededCostValues;
    costRevisionRef.current = 0;
    attemptedCostRevisionRef.current = 0;
  }, [productKey, seededCostValues]);

  const saveCostMutation = useMutation({
    mutationFn: async ({ productId, values: v }: CostSaveAttempt) => {
      // Timeout: ağ ölürse istek asılı kalmasın → başarısız say (sonra retry / rollback).
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 12_000);
      try {
        const r = await fetch(`/api/products/${productId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            desi: v.desi,
            cost: {
              costMode: "detailed",
              filamentTypeId: v.filamentTypeId || null,
              filamentWeight: v.filamentWeight,
              printTimeHours: v.printTimeHours,
              wasteRate: v.wasteRate,
              packagingOptionId: v.packagingOptionId || null,
              nylonLevel: v.nylonLevel,
              tapeUsed: v.tapeUsed,
            },
          }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      } finally {
        clearTimeout(to);
      }
    },
    retry: 2, // geçici kopmada otomatik tekrar (PATCH idempotent → çift-yazma riski yok)
    retryDelay: (n) => Math.min(1000 * 2 ** n, 4000),
    // OPTIMISTIC: detay cache'ini anında güncelle → kullanıcı beklemez.
    onMutate: async ({ productId, values: v }) => {
      await queryClient.cancelQueries({ queryKey: ["product", productId] });
      const prev = queryClient.getQueryData<ProductDetail>(["product", productId]);
      queryClient.setQueryData<ProductDetail | undefined>(["product", productId], (old) =>
        old
          ? {
              ...old,
              desi: v.desi,
              cost: {
                ...(old.cost ?? {}),
                costMode: "detailed",
                filamentTypeId: v.filamentTypeId || null,
                filamentWeight: v.filamentWeight,
                printTimeHours: v.printTimeHours,
                wasteRate: v.wasteRate,
                packagingOptionId: v.packagingOptionId || null,
                nylonLevel: v.nylonLevel,
                tapeUsed: v.tapeUsed,
              } as ProductDetail["cost"],
            }
          : old
      );
      return { prev, productId };
    },
    onError: (_e, _v, ctx) => {
      // Sunucudaki/cache'teki kayıtlı değeri geri al. CostEditor yerel alanları korur; kullanıcı
      // bağlantı geldikten sonra küçük bir düzenlemeyle tekrar kaydetmeyi tetikleyebilir.
      if (ctx?.prev) queryClient.setQueryData(["product", ctx.productId], ctx.prev);
      toast.error("Kaydedilemedi — alanlardaki değişiklikler korunuyor");
    },
    onSuccess: (_data, { productId }) => {
      toast.success("Maliyet kaydedildi");
      // Önizleme + Fiyat Lab zaten İSTEMCİDE (optimistic cost'tan) günceldir → ekstra okuma YOK.
      // Listede yalnız bu ürünü tazele (tüm 368 değil → minimum okuma, donma yok).
      patchProductsInCache(queryClient, [productId]);
    },
  });

  // Bu maliyeti (ve desi) aynı varyant grubundaki TÜM ürünlere uygula
  const applyCostToVariantsMutation = useMutation({
    mutationFn: () => {
      const v = costValues;
      if (!v) return Promise.resolve({});
      return fetchJson<{ count?: number }>(`/api/products/${id}/apply-cost-to-variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          desi: v.desi,
          cost: {
            costMode: "detailed",
            filamentTypeId: v.filamentTypeId || null,
            filamentWeight: v.filamentWeight,
            printTimeHours: v.printTimeHours,
            wasteRate: v.wasteRate,
            packagingOptionId: v.packagingOptionId || null,
            nylonLevel: v.nylonLevel,
            tapeUsed: v.tapeUsed,
          },
        }),
      });
    },
    meta: { blocking: true }, // çok varyanta yayılan ağır yazma → bitene dek ekranı kibarca bloke et
    onSuccess: (d: { count?: number }) => {
      // Maliyet grup üyelerine uygulandı.
      const groupIds = product?.variantGroup?.products.map((p) => p.id) ?? [];
      const siblingIds = groupIds.filter((gid) => gid !== id);
      // Mevcut varyant: aktif sorgu → hemen tazele.
      queryClient.invalidateQueries({ queryKey: ["price-lab", id] });
      // Diğer varyantların pasif detay/önizleme cache'lerini TEMİZLE → o varyanta girince taze çekilir.
      // (refetchOnMount:false olduğundan sadece "stale" işaretlemek yetmiyor; eski maliyet görünüyordu →
      //  "gir-çık edince geliyor" sorunu. removeQueries: veri silinince bir sonraki ziyarette zorunlu fetch.)
      for (const sid of siblingIds) {
        queryClient.removeQueries({ queryKey: ["product", sid] });
        queryClient.removeQueries({ queryKey: ["profit-preview", sid] });
        queryClient.removeQueries({ queryKey: ["price-lab", sid] });
      }
      // Listede SADECE grup üyelerini güncelle (tüm liste değil → minimum okuma).
      patchProductsInCache(queryClient, [id, ...groupIds]);
      toast.success(`Maliyet ${d?.count ?? ""} varyanta uygulandı`);
    },
    onError: () => toast.error("Varyantlara uygulanamadı"),
  });

  // Takma ad + barkod kaydet. Barkod siparişlerin ürünle eşleşmesini sağlar (UNIQUE);
  // çakışmada 409 → retry YOK (kalıcı hata). Geçici ağ kopmasında 2 kez tekrar dener.
  const saveIdentityMutation = useMutation({
    mutationFn: async () => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 12_000);
      try {
        const r = await fetch(`/api/products/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({ alias: aliasInput.trim() || null }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error || `HTTP ${r.status}`);
        }
        return r.json();
      } finally {
        clearTimeout(to);
      }
    },
    retry: 2,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 4000),
    // Optimistic: cache'i anında yama → ["product",id] REFETCH YOK (yaz-sonrası donma yok).
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["product", id] });
      const prev = queryClient.getQueryData<ProductDetail>(["product", id]);
      const alias = aliasInput.trim() || null;
      queryClient.setQueryData<ProductDetail | undefined>(["product", id], (old) =>
        old ? { ...old, alias } : old
      );
      // Alias listede gösterilir → orada da optimistic yamala (fetch YOK).
      queryClient.setQueriesData<Array<{ id: string; alias?: string | null }>>(
        { queryKey: ["products"] },
        (old) => (Array.isArray(old) ? old.map((p) => (p.id === id ? { ...p, alias } : p)) : old)
      );
      return { prev };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["product", id], ctx.prev);
      toast.error(e?.message || "Kaydedilemedi");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"], refetchType: "none" });
      toast.success("Kaydedildi");
    },
  });

  // "Sipariş üzerine üretilir" toggle — optimistic (anında, hata olursa geri al).
  const setMadeToOrderMutation = useMutation({
    mutationFn: async (madeToOrder: boolean) => {
      const r = await fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ madeToOrder }),
      });
      if (!r.ok) throw new Error("Kaydedilemedi");
      return r.json();
    },
    onMutate: async (madeToOrder) => {
      await queryClient.cancelQueries({ queryKey: ["product", id] });
      const prev = queryClient.getQueryData<ProductDetail>(["product", id]);
      queryClient.setQueryData<ProductDetail | undefined>(["product", id], (old) =>
        old ? { ...old, madeToOrder } : old
      );
      // M2O kâr-etkilemez → listede de optimistic yamala (fetch YOK, anında doğru).
      queryClient.setQueriesData<Array<{ id: string; madeToOrder?: boolean }>>(
        { queryKey: ["products"] },
        (old) => (Array.isArray(old) ? old.map((p) => (p.id === id ? { ...p, madeToOrder } : p)) : old)
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["product", id], ctx.prev);
      toast.error("Kaydedilemedi — bağlantını kontrol et (geri alındı)");
    },
    onSuccess: (_d, madeToOrder) =>
      toast.success(madeToOrder ? "Sipariş üzerine üretilir olarak işaretlendi" : "Stok takibine alındı"),
    // Optimistic yeter → REFETCH YOK. Panel sadece bayat işaretlenir (o ekrana gidince tazelenir).
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard"], refetchType: "none" });
    },
  });

  // Stok güncelleme
  // Optimistic stok: UI anında güncellenir, yazma arka planda + debounce'lu + retry'lı.
  const { adjustStock, setStock } = useStockWriter();

  // Real-time kâr önizlemesi + Fiyat Lab — KAYDETMEDEN, İSTEMCİDE hesaplanır (ana sürece okuma YOK
  // → donma yok). costValues (CostEditor'dan 250ms debounce'lu), ürün veya kurallar değişince anında
  // yeniden hesaplanır. Sunucu profit-preview/price-lab route'larıyla BİREBİR aynı @/core mantığı.
  // ÖNİZLEME — UCUZ (~0.4ms): her maliyet değişiminde CANLI hesaplanır → platform kartları anında.
  const preview: ProfitPreview | undefined = useMemo(() => {
    if (!product || !costValues || !commissionRules || !cargoRules || !expenseRules) return undefined;
    return computeProfitPreview({
      product,
      cost: costValues,
      filaments,
      settings: globalSettings,
      commissionRules,
      cargoRules,
      expenseRules,
    });
  }, [product, costValues, filaments, globalSettings, commissionRules, cargoRules, expenseRules]);

  // FİYAT LAB — PAHALI (~36ms, hedef-marj ikili araması): ERTELENMİŞ maliyetle hesaplanır. Böylece
  // poşet/naylon dropdown'larına tıklamak/yazı yazmak bu hesabı BEKLEMEZ (donma yok); kullanıcı
  // durunca lab boşta yetişir. (useDeferredValue: ara değerleri atlar, düşük öncelikte çalışır.)
  const deferredCost = useDeferredValue(costValues);
  const priceLab = useMemo(() => {
    if (!product || !deferredCost || !commissionRules || !cargoRules || !expenseRules) return undefined;
    return computePriceLab({
      product,
      cost: deferredCost,
      filaments,
      settings: globalSettings,
      commissionRules,
      cargoRules,
      expenseRules,
    });
  }, [product, deferredCost, filaments, globalSettings, commissionRules, cargoRules, expenseRules]);

  // Maliyet OTOMATİK kaydedilir (costValues değişince 800ms sonra) — optimistic, "Kaydet" butonu yok.
  // Form, ürünün kayıtlı maliyetiyle aynıysa kaydetmez (ilk yükleme / değişiklik yok → gereksiz yazma yok).
  useEffect(() => {
    if (!product || !costValues) return;
    const c = product.cost;
    const unchanged =
      (c?.filamentTypeId || "") === (costValues.filamentTypeId || "") &&
      (c?.filamentWeight ?? 0) === costValues.filamentWeight &&
      (c?.printTimeHours ?? 0) === costValues.printTimeHours &&
      (Number(c?.wasteRate) || 0) === costValues.wasteRate &&
      (c?.packagingOptionId || "") === (costValues.packagingOptionId || "") &&
      ((c?.nylonLevel as string) || "none") === costValues.nylonLevel &&
      Boolean(c?.tapeUsed) === costValues.tapeUsed &&
      (product.desi ?? null) === costValues.desi;
    const revision = costRevisionRef.current;
    if (unchanged) {
      attemptedCostRevisionRef.current = Math.max(attemptedCostRevisionRef.current, revision);
      return;
    }
    // Devam eden istek bitince isPending değişir ve effect tekrar çalışır. Revision guard'ı,
    // başarısız bir snapshot'ı değişiklik yokken sonsuza kadar tekrar denemeyi engeller.
    if (revision <= attemptedCostRevisionRef.current || saveCostMutation.isPending) return;
    const t = setTimeout(() => {
      const values = latestCostRef.current;
      const latestRevision = costRevisionRef.current;
      if (!values || latestRevision <= attemptedCostRevisionRef.current || saveCostMutation.isPending) return;
      attemptedCostRevisionRef.current = latestRevision;
      saveCostMutation.mutate({ productId: id, values, revision: latestRevision });
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costValues, product, saveCostMutation.isPending]);

  // CostEditor'a STABİL onApply ver (memo bozulmasın) — mutate referansı zaten sabit.
  const applyMutate = applyCostToVariantsMutation.mutate;
  const handleApplyToVariants = useCallback(() => applyMutate(), [applyMutate]);

  // Bu ürünü elle tazele (her ihtimale karşı) — uygulama mount'ta otomatik refetch yapmaz, bu yüzden
  // başka cihazdaki değişiklik veya kargo/komisyon kuralı güncellemesi için manuel yenileme.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["product", id] }),
        // Kurallar/ayarlar da tazelensin → önizleme + Fiyat Lab (istemcide) güncel kurallarla yeniden hesaplanır.
        queryClient.refetchQueries({ queryKey: ["commission-rules"] }),
        queryClient.refetchQueries({ queryKey: ["cargo-rules"] }),
        queryClient.refetchQueries({ queryKey: ["expense-rules"] }),
        queryClient.refetchQueries({ queryKey: ["app-settings"] }),
        queryClient.refetchQueries({ queryKey: ["price-history", id] }),
        queryClient.refetchQueries({ queryKey: ["product-models", id] }),
      ]);
      toast.success("Ürün verileri tazelendi");
    } catch {
      toast.error("Tazelenemedi");
    } finally {
      setRefreshing(false);
    }
  }, [id, queryClient]);

  if (isLoading) {
    return (
      <div className="p-6 space-y-6 max-w-7xl animate-in fade-in duration-300">
        <div className="flex items-center gap-4">
          <Skeleton className="h-9 w-9 rounded-md" />
          <Skeleton className="h-16 w-16 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-[440px] lg:col-span-1" />
          <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-3">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !product) {
    return (
      <div className="p-6 max-w-xl">
        <Card>
          <CardContent className="py-10 text-center space-y-4">
            <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto" />
            <div>
              <h1 className="font-semibold">Ürün yüklenemedi</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Ürün bulunamadı veya bağlantı kurulamadı.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2">
              <Button variant="outline" onClick={() => void refetchProduct()}>
                Tekrar dene
              </Button>
              <Link href="/products" className={buttonVariants()}>
                Ürünlere dön
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href="/products" className={buttonVariants({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <button
          type="button"
          onClick={() => setImageEditorOpen(true)}
          title="Görseli düzenle"
          className="group relative w-16 h-16 rounded-lg border bg-muted flex items-center justify-center flex-shrink-0 overflow-hidden focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          {product.imageUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={product.imageUrl}
              alt={product.name}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <Package className="h-8 w-8 text-muted-foreground" />
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 group-hover:opacity-100 transition-opacity">
            <Camera className="h-5 w-5 text-white" />
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold tracking-tight line-clamp-2 leading-tight">
            {product.name}
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            <span className="font-mono">{product.sku}</span>
            <span className="mx-1.5">·</span>
            {product.categoryName}
          </p>
          {/* Hızlı kimlik + stok — eski "Ürün Bilgileri" kartından buraya taşındı (barkod artık platform kartlarında) */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">Takma ad</span>
              <Input
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                onBlur={() => {
                  if (aliasInput.trim() !== (product.alias ?? "")) saveIdentityMutation.mutate();
                }}
                maxLength={80}
                placeholder="örn. kırmızı vazo"
                className="h-7 w-44 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">Stok</span>
              {product.madeToOrder ? (
                <span className="text-xs text-muted-foreground italic">takip edilmez</span>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    disabled={product.stock <= 0}
                    onClick={() => adjustStock(id, -1, product.stock)}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  {/* Elle giriş: 900 → 0 gibi büyük değişiklikler için (+/- ile tek tek imkânsızdı) */}
                  <StockInput
                    value={product.stock}
                    onCommit={(next) => setStock(id, next)}
                    className="text-sm w-[5ch] py-0.5"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => adjustStock(id, 1, product.stock)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                  {product.stock <= 1 && (
                    <span
                      className={cn(
                        "text-[11px] ml-0.5",
                        product.stock === 0 ? "text-destructive" : "text-amber-500"
                      )}
                    >
                      {product.stock === 0 ? "⚠ tükendi" : "⚠ kritik"}
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">Sipariş üzerine</span>
              <Button
                variant={product.madeToOrder ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                disabled={setMadeToOrderMutation.isPending}
                onClick={() => setMadeToOrderMutation.mutate(!product.madeToOrder)}
              >
                {product.madeToOrder ? "Evet" : "Hayır"}
              </Button>
            </div>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 shrink-0"
          disabled={refreshing}
          onClick={handleRefresh}
          title="Bu ürünün verilerini sunucudan tazele"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          Yenile
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sol: Maliyet formu (izole — yazarken sadece bu kart render olur) */}
        <div className="space-y-4 lg:col-span-1">
          <CostEditor
            key={id}
            initial={initialCost}
            filaments={filaments}
            packagingSettings={packagingSettings}
            globalSettings={globalSettings}
            savePending={saveCostMutation.isPending}
            variantCount={product.variantGroup?.products?.length ?? 0}
            applyPending={applyCostToVariantsMutation.isPending}
            onApply={handleApplyToVariants}
            onChange={handleCostChange}
          />
        </div>

        {/* Sağ: 3 Platform Yan Yana */}
        <div className="lg:col-span-2 space-y-4">
          <div>
            <h2 className="text-base font-semibold mb-1">Platform Kâr/Zarar Durumu</h2>
            <p className="text-xs text-muted-foreground">
              Bu ürünün her platformdaki listing&apos;i için ayrı kâr hesabı (KDV + kargo +
              komisyon dahil, indirim payı uygulanmış).
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {(["shopify", "trendyol", "hepsiburada"] as const).map((platform) => {
              const listing = product.listings.find((l) => l.platform === platform);
              const platformPreview = preview?.platforms.find((p) => p.platform === platform);
              return (
                <PlatformProfitCard
                  key={platform}
                  platform={platform}
                  listing={listing ?? null}
                  productId={product.id}
                  productName={product.name}
                  liveResult={platformPreview?.result ?? null}
                  hasCost={preview?.hasCost ?? null}
                />
              );
            })}
          </div>
        </div>
      </div>

      <VariantsCard
        productId={product.id}
        productName={product.name}
        group={product.variantGroup}
      />

      <ModelFilesCard productId={product.id} variantGroup={product.variantGroup} />

      <PriceLabCard data={priceLab} />

      <PriceHistoryCard productId={product.id} />

      {imageEditorOpen && (
        <ProductImageEditorDialog
          productId={product.id}
          productName={product.name}
          imageUrl={product.imageUrl}
          onClose={() => setImageEditorOpen(false)}
          onChanged={(url) => {
            queryClient.setQueryData<ProductDetail | undefined>(["product", id], (old) =>
              old ? { ...old, imageUrl: url, imageManual: url != null } : old
            );
            // Görsel kâr-etkilemez → listede de optimistic yamala (fetch YOK).
            queryClient.setQueriesData<Array<{ id: string; imageUrl?: string | null }>>(
              { queryKey: ["products"] },
              (old) => (Array.isArray(old) ? old.map((p) => (p.id === id ? { ...p, imageUrl: url } : p)) : old)
            );
          }}
        />
      )}
    </div>
  );
}

/**
 * Bir platform için listing kâr/zarar kartı. Listing yoksa "Ekle" formu gösterir.
 * memo: detay cache'i değişince (örn. madeToOrder/alias optimistic toggle — listings ref'i AYNI
 * kalır) bu ağır kart GEREKSİZ yere render olmasın → toggle anlık hisseder. (Impl hoist edilir.)
 */
const PlatformProfitCard = memo(PlatformProfitCardImpl);
function PlatformProfitCardImpl({
  platform,
  listing,
  productId,
  productName,
  liveResult,
  hasCost,
}: {
  platform: "shopify" | "trendyol" | "hepsiburada";
  listing: Listing | null;
  productId: string;
  productName: string;
  /** Parent'tan gelen real-time kâr önizlemesi (kaydetmeden) */
  liveResult: SimulationResult | null;
  /** Maliyet girilmiş mi (preview yüklendiyse). null = preview henüz yüklenmedi */
  hasCost: boolean | null;
}) {
  const info = PLATFORM_INFO[platform];
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);
  const listingSource = {
    key: `${productId}:${listing?.id ?? "new"}:${listing?.salePrice ?? ""}:${listing?.commissionRate ?? ""}:${listing?.barcode ?? ""}`,
    salePrice: listing?.salePrice ? String(listing.salePrice) : "",
    commissionRate: listing?.commissionRate ? String(listing.commissionRate * 100) : "",
    listingBarcode: listing?.barcode ?? "",
  };
  const [listingDraft, setListingDraft] = useState(listingSource);
  const activeDraft = listingDraft.key === listingSource.key ? listingDraft : listingSource;
  const { salePrice, commissionRate, listingBarcode } = activeDraft;
  const updateListingDraft = (patch: Partial<Omit<typeof listingSource, "key">>) =>
    setListingDraft((current) => ({
      ...(current.key === listingSource.key ? current : listingSource),
      ...patch,
      key: listingSource.key,
    }));
  const setSalePrice = (value: string) => updateListingDraft({ salePrice: value });
  const setCommissionRate = (value: string) => updateListingDraft({ commissionRate: value });
  const setListingBarcode = (value: string) => updateListingDraft({ listingBarcode: value });

  // Barkod alanı pazaryeri kartlarında (Trendyol + Hepsiburada): her platformun sipariş-eşleşme
  // barkodu ayrı tutulur. Shopify ana ürün kaynağı → barkodu zaten oradan gelir, kartta gösterilmez.
  const showBarcodeField = platform !== "shopify";

  const createListing = useMutation({
    mutationFn: () =>
      fetchJson("/api/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          platform,
          salePrice: parseFloat(salePrice) || 0,
          commissionRate: commissionRate ? parseFloat(commissionRate) / 100 : null,
          cargoCost: null, // kargo her zaman otomatik (manuel override kaldırıldı)
          ...(showBarcodeField ? { barcode: listingBarcode.trim() || null } : {}),
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product", productId] });
      // Canlı kâr önizlemesini de tazele → yeni komisyon/fiyat/kargo ANINDA hesaba girsin
      // (yoksa oran etiketi güncellenir ama komisyon tutarı sayfaya tekrar girilene dek 0 kalır).
      queryClient.invalidateQueries({ queryKey: ["profit-preview", productId] });
      queryClient.invalidateQueries({ queryKey: ["price-lab", productId] });
      patchProductsInCache(queryClient, [productId]); // listede yalnız bu ürün (tüm liste değil)
      toast.success(`${info.label} listing'i eklendi`);
      setEditing(false);
    },
    onError: () => toast.error("Eklenemedi"),
  });

  const updateListing = useMutation({
    mutationFn: () =>
      fetchJson(`/api/listings/${listing!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salePrice: parseFloat(salePrice) || 0,
          commissionRate: commissionRate ? parseFloat(commissionRate) / 100 : null,
          cargoCost: null, // kargo her zaman otomatik (manuel override kaldırıldı)
          ...(showBarcodeField ? { barcode: listingBarcode.trim() || null } : {}),
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product", productId] });
      // Canlı kâr önizlemesini de tazele → yeni komisyon/fiyat/kargo ANINDA hesaba girsin
      // (yoksa oran etiketi güncellenir ama komisyon tutarı sayfaya tekrar girilene dek 0 kalır).
      queryClient.invalidateQueries({ queryKey: ["profit-preview", productId] });
      queryClient.invalidateQueries({ queryKey: ["price-lab", productId] });
      patchProductsInCache(queryClient, [productId]); // listede yalnız bu ürün (tüm liste değil)
      toast.success("Güncellendi");
      setEditing(false);
    },
    onError: () => toast.error("Güncellenemedi"),
  });

  const deleteListing = useMutation({
    mutationFn: () => fetchJson(`/api/listings/${listing!.id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product", productId] });
      queryClient.invalidateQueries({ queryKey: ["profit-preview", productId] });
      queryClient.invalidateQueries({ queryKey: ["price-lab", productId] });
      patchProductsInCache(queryClient, [productId]); // listede yalnız bu ürün (tüm liste değil)
      toast.success(`${info.label} listing kaldırıldı`);
    },
  });

  if (!listing) {
    return (
      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: info.color }}
            />
            <span style={{ color: info.color }}>{info.label}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {editing ? (
            <div className="space-y-2">
              <div>
                <Label className="text-xs">Satış Fiyatı (TL)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  placeholder="0"
                />
              </div>
              <div>
                <Label className="text-xs">Komisyon (%) — boş bırak otomatik</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={commissionRate}
                  onChange={(e) => setCommissionRate(e.target.value)}
                  placeholder="örn. 14"
                />
              </div>
              {showBarcodeField && (
                <div>
                  <Label className="text-xs">{info.label} Barkodu</Label>
                  <Input
                    value={listingBarcode}
                    onChange={(e) => setListingBarcode(e.target.value)}
                    placeholder={`${info.label} siparişleri bununla eşleşir`}
                    className="font-mono"
                  />
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => createListing.mutate()}
                  disabled={createListing.isPending || !salePrice}
                >
                  Kaydet
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(false)}
                >
                  İptal
                </Button>
              </div>
            </div>
          ) : platform !== "shopify" ? (
            // Trendyol / HB: ürünler sayfasındaki gibi eşleştirme akışı (barkod yapıştır / listeden seç).
            <div className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setMatchOpen(true)}
              >
                <Plus className="h-4 w-4 mr-1.5" /> Bu Platforma Ekle
              </Button>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Listede yok mu? Manuel gir
              </button>
            </div>
          ) : (
            // Shopify ana ürün kaynağı — eşleştirme havuzu yok, manuel ekleme.
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setEditing(true)}
            >
              <Plus className="h-4 w-4 mr-1.5" /> Bu Platforma Ekle
            </Button>
          )}
          {matchOpen && platform !== "shopify" && (
            <MatchListingModal
              productId={productId}
              productName={productName}
              platform={platform}
              onClose={() => setMatchOpen(false)}
              onMatched={() => {
                queryClient.invalidateQueries({ queryKey: ["product", productId] });
                queryClient.invalidateQueries({ queryKey: ["profit-preview", productId] });
                queryClient.invalidateQueries({ queryKey: ["price-lab", productId] });
                patchProductsInCache(queryClient, [productId]);
              }}
            />
          )}
        </CardContent>
      </Card>
    );
  }

  const result = liveResult;
  const missingCost = hasCost === false;
  const isLoss = result && result.netProfit < 0;
  const isThin = result && !isLoss && result.profitMargin < 0.1;
  // Pazaryerinde (Trendyol/HB) komisyon kaynağı yok (override yok + kural eşleşmedi) → uyar.
  // Shopify sabit komisyonlu → uyarı gerekmez.
  const commissionMissing =
    (platform === "trendyol" || platform === "hepsiburada") &&
    Boolean(result) &&
    !result?.appliedCommissionRule &&
    (listing?.commissionRate == null);

  return (
    <Card
      className={cn(
        "border-2 transition-colors",
        isLoss && "border-destructive/40",
        !isLoss && isThin && "border-amber-500/40",
        result && !isLoss && !isThin && "border-green-500/30",
        !result && "border-muted"
      )}
      style={
        result
          ? undefined
          : { borderTopColor: info.color, borderTopWidth: 3, borderTopStyle: "solid" }
      }
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: info.color }}
            />
            <span style={{ color: info.color }}>{info.label}</span>
          </CardTitle>
          <div className="flex gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setEditing((v) => !v)}
              title="Düzenle"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive/70 hover:text-destructive"
              onClick={() => deleteListing.mutate()}
              title="Sil"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <div className="space-y-2">
            <div>
              <Label className="text-xs">Satış Fiyatı</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={salePrice}
                onChange={(e) => setSalePrice(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Komisyon (%)</Label>
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={commissionRate}
                onChange={(e) => setCommissionRate(e.target.value)}
                placeholder="otomatik"
              />
            </div>
            {showBarcodeField && (
              <div>
                <Label className="text-xs">{info.label} Barkodu</Label>
                <Input
                  value={listingBarcode}
                  onChange={(e) => setListingBarcode(e.target.value)}
                  placeholder={`${info.label} siparişleri bununla eşleşir`}
                  className="font-mono"
                />
              </div>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1"
                onClick={() => updateListing.mutate()}
                disabled={updateListing.isPending}
              >
                Kaydet
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                İptal
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
                Satış Fiyatı
              </p>
              <p className="text-2xl font-bold tabular-nums mt-0.5">
                {formatCurrency(listing.salePrice)}
              </p>
            </div>

            {showBarcodeField && (
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="uppercase tracking-wider text-[10px] text-muted-foreground/80">Barkod</span>
                {listing.barcode ? (
                  <span className="font-mono text-foreground">{listing.barcode}</span>
                ) : (
                  <span className="text-amber-500">girilmedi — siparişler eşleşmeyebilir</span>
                )}
              </div>
            )}

            {commissionMissing && (
              <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-2.5 py-2 font-medium">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  {info.label} komisyonu girilmemiş! Kâr olduğundan yüksek görünüyor.
                  Düzenle&apos;den komisyon oranını gir veya Komisyon Kuralları&apos;na ekle.
                </span>
              </div>
            )}

            {missingCost ? (
              <div className="flex items-start gap-2 text-xs text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>Maliyet eksik — net kâr hesaplanamaz</span>
              </div>
            ) : result ? (
              <>
                <Separator />
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
                      Net Kâr
                    </p>
                    <p
                      className={cn(
                        "text-lg font-bold tabular-nums",
                        isLoss
                          ? "text-destructive"
                          : isThin
                            ? "text-amber-500"
                            : "text-green-500"
                      )}
                    >
                      {formatCurrency(result.netProfit)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
                      Marj
                    </p>
                    <p className="text-lg font-bold tabular-nums">
                      {formatPercent(result.profitMargin)}
                    </p>
                  </div>
                </div>

                {result.minOrderQty > 1 && (
                  <div
                    className="rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-1 text-[11px] font-medium"
                    title="Trendyol min sipariş adedi — kâr bu adetlik sipariş üzerinden hesaplandı"
                  >
                    Trendyol min sipariş: {result.minOrderQty} adet · kâr {formatCurrency(result.salePrice * result.minOrderQty)} ciro üzerinden
                  </div>
                )}

                <Separator />

                <div className="space-y-1 text-[11px] tabular-nums">
                  <div className="flex justify-between text-muted-foreground">
                    <span>KDV (%{result.vatRate})</span>
                    <span>−{formatCurrency(result.vatAmount)}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Ürün + Paketleme</span>
                    <span>
                      −{formatCurrency(result.productCost + result.packagingCost)}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>
                      Komisyon
                      {listing.commissionRate !== null && (
                        <span className="opacity-60 ml-1">
                          (%{(listing.commissionRate * 100).toFixed(1)})
                        </span>
                      )}
                    </span>
                    <span>−{formatCurrency(result.commissionCost)}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Kargo</span>
                    <span>−{formatCurrency(result.cargoCost)}</span>
                  </div>
                  {result.appliedExpenseRules
                    .filter((exp) => exp.amount !== 0)
                    .map((exp) => (
                      <div
                        key={exp.id}
                        className="flex justify-between text-muted-foreground"
                      >
                        <span>{exp.name}</span>
                        <span>−{formatCurrency(exp.amount)}</span>
                      </div>
                    ))}
                  {result.inputVatCredit > 0 && (
                    <div
                      className="flex justify-between text-green-600 dark:text-green-500 font-medium pt-0.5"
                      title="Komisyon, kargo, platform ve filament faturalarındaki indirilebilen KDV"
                    >
                      <span>KDV İadesi</span>
                      <span>+{formatCurrency(result.inputVatCredit)}</span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Hesaplanıyor...</p>
            )}

            {listing.lastSyncedAt && (
              <div className="text-[10px] text-muted-foreground/70 flex justify-end pt-1">
                <span>
                  Sync: {new Date(listing.lastSyncedAt).toLocaleDateString("tr-TR")}
                </span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
