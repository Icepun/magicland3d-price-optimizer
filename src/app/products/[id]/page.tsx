"use client";

import { use, useState, useEffect, useMemo, memo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PriceHistoryCard } from "@/components/products/PriceHistoryCard";
import { PriceLabCard } from "@/components/products/PriceLabCard";
import { VariantsCard } from "@/components/products/VariantsCard";
import { ModelFilesCard } from "@/components/products/ModelFilesCard";
import { ProductImageEditorDialog } from "@/components/products/ProductImageEditorDialog";
import { formatCurrency, formatPercent, cn } from "@/lib/utils";
import { useStockWriter } from "@/lib/use-stock-writer";
import { ArrowLeft, Package, AlertTriangle, Plus, Trash2, Minus, Camera } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import Link from "next/link";
import { toast } from "sonner";
import type { SimulationResult } from "@/core/types";
import { parsePackagingSettings, computePackagingCost } from "@/core/packaging";

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

interface ProfitPreview {
  productionCost: number;
  packagingCost: number;
  totalCost: number;
  hasCost: boolean;
  platforms: Array<{
    platform: string;
    listingId: string;
    salePrice: number;
    result: SimulationResult | null;
  }>;
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

  const { data: product, isLoading } = useQuery<ProductDetail>({
    queryKey: ["product", id],
    queryFn: () => fetch(`/api/products/${id}`).then((r) => r.json()),
  });

  const { data: filaments = [] } = useQuery<FilamentType[]>({
    queryKey: ["filament-types"],
    queryFn: () => fetch("/api/filament-types").then((r) => r.json()),
  });

  const { data: globalSettings = {} } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetch("/api/settings").then((r) => r.json()),
  });

  // Form state
  const [filamentTypeId, setFilamentTypeId] = useState("");
  const [filamentWeight, setFilamentWeight] = useState("");
  const [printTimeHours, setPrintTimeHours] = useState("");
  const [wasteRate, setWasteRate] = useState("");
  const [packagingOptionId, setPackagingOptionId] = useState("");
  const [nylonLevel, setNylonLevel] = useState<"none" | "low" | "medium" | "high">("none");
  const [tapeUsed, setTapeUsed] = useState(false);
  const [desiInput, setDesiInput] = useState("");
  const [aliasInput, setAliasInput] = useState("");
  const [imageEditorOpen, setImageEditorOpen] = useState(false);
  const [barcodeInput, setBarcodeInput] = useState("");

  useEffect(() => {
    if (product?.cost) {
      const c = product.cost;
      setFilamentTypeId(c.filamentTypeId || "");
      setFilamentWeight(c.filamentWeight ? String(c.filamentWeight) : "");
      setPrintTimeHours(c.printTimeHours ? String(c.printTimeHours) : "");
      setWasteRate(c.wasteRate ? String(Number(c.wasteRate) * 100) : "");
      setPackagingOptionId(c.packagingOptionId || "");
      setNylonLevel((c.nylonLevel as "none" | "low" | "medium" | "high") || "none");
      setTapeUsed(Boolean(c.tapeUsed));
    }
  }, [product]);

  useEffect(() => {
    if (product) {
      setDesiInput(product.desi ? String(product.desi) : "");
      setAliasInput(product.alias ?? "");
      setBarcodeInput(product.barcode ?? "");
    }
  }, [product]);

  // Paketleme ayarları (Maliyet Ayarları'ndan)
  const packagingSettings = parsePackagingSettings(globalSettings);
  const packagingBreakdown = computePackagingCost(
    { packagingOptionId: packagingOptionId || null, nylonLevel, tapeUsed },
    packagingSettings
  );
  // Bant'ın "Var" seçildiğindeki maliyeti (seçimden bağımsız — label için)
  const tapeCostPerProduct =
    packagingSettings.tapeProductsPerRoll > 0
      ? packagingSettings.tapePrice / packagingSettings.tapeProductsPerRoll
      : 0;

  // Anlık maliyet hesabı
  const selectedFilament = filaments.find((f) => f.id === filamentTypeId);
  const costPerGram = selectedFilament?.costPerGram || 0;
  const fWeight = parseFloat(filamentWeight) || 0;
  const pTime = parseFloat(printTimeHours) || 0;
  const wRate = (parseFloat(wasteRate) || 0) / 100;
  const electricityRate = parseFloat(globalSettings.costElectricityPerHour || "0");
  const machineWearRate = parseFloat(globalSettings.costMachineWearPerHour || "0");
  const laborRate = parseFloat(globalSettings.costLaborPerHour || "0");

  const calcFilament = fWeight * costPerGram;
  const calcElectricity = pTime * electricityRate;
  const calcMachineWear = pTime * machineWearRate;
  const calcLabor = pTime * laborRate;
  // Fire sadece baskıya uygulanır, paketlemeye değil
  const printSubtotal = calcFilament + calcElectricity + calcMachineWear + calcLabor;
  const calcWaste = printSubtotal * wRate;
  const calcPackaging = packagingBreakdown.total;
  const calculatedTotalCost = printSubtotal + calcWaste + calcPackaging;
  // Sabit ek maliyetler (kart/sticker/sakız) — her üründe
  const fixedExtras = packagingBreakdown.card + packagingBreakdown.sticker + packagingBreakdown.sakiz;

  const saveCostMutation = useMutation({
    mutationFn: async () => {
      // Timeout: ağ ölürse istek asılı kalmasın → başarısız say (sonra retry / rollback).
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 12_000);
      try {
        const r = await fetch(`/api/products/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            desi: parseFloat(desiInput) || null,
            cost: {
              costMode: "detailed",
              filamentTypeId: filamentTypeId || null,
              filamentWeight: fWeight,
              printTimeHours: pTime,
              wasteRate: wRate,
              packagingOptionId: packagingOptionId || null,
              nylonLevel,
              tapeUsed,
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
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["product", id] });
      const prev = queryClient.getQueryData<ProductDetail>(["product", id]);
      queryClient.setQueryData<ProductDetail | undefined>(["product", id], (old) =>
        old
          ? {
              ...old,
              desi: parseFloat(desiInput) || null,
              cost: {
                ...(old.cost ?? {}),
                costMode: "detailed",
                filamentTypeId: filamentTypeId || null,
                filamentWeight: fWeight,
                printTimeHours: pTime,
                wasteRate: wRate,
                packagingOptionId: packagingOptionId || null,
                nylonLevel,
                tapeUsed,
              } as ProductDetail["cost"],
            }
          : old
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      // DÜRÜSTLÜK: yazma kalıcı başarısızsa UI'ı GERİ AL + net uyarı → kullanıcı yanıltılmaz.
      if (ctx?.prev) queryClient.setQueryData(["product", id], ctx.prev);
      toast.error("Kaydedilemedi — bağlantını kontrol et (değişiklik geri alındı)");
    },
    onSuccess: () => toast.success("Maliyet kaydedildi"),
    onSettled: () => {
      // Maliyet optimistic yazıldı + canlı önizleme (preview) zaten form'dan güncel →
      // ["product",id] ve preview REFETCH YOK (yaz-anında ağır refetch/donma sebebiydi).
      // Liste sadece bayat işaretlenir → tekrar ziyarette tazelenir.
      queryClient.invalidateQueries({ queryKey: ["products"], refetchType: "none" });
    },
  });

  // Bu maliyeti (ve desi) aynı varyant grubundaki TÜM ürünlere uygula
  const applyCostToVariantsMutation = useMutation({
    mutationFn: () =>
      fetch(`/api/products/${id}/apply-cost-to-variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          desi: parseFloat(desiInput) || null,
          cost: {
            costMode: "detailed",
            filamentTypeId: filamentTypeId || null,
            filamentWeight: fWeight,
            printTimeHours: pTime,
            wasteRate: wRate,
            packagingOptionId: packagingOptionId || null,
            nylonLevel,
            tapeUsed,
          },
        }),
      }).then((r) => r.json()),
    onSuccess: (d: { count?: number }) => {
      // Açık ürünün maliyeti zaten gösteriliyor; ağır refetch yok — sadece bayat işaretle.
      queryClient.invalidateQueries({ queryKey: ["product", id], refetchType: "none" });
      queryClient.invalidateQueries({ queryKey: ["products"], refetchType: "none" });
      toast.success(`Maliyet ${d?.count ?? ""} varyanta uygulandı`);
    },
    onError: () => toast.error("Varyantlara uygulanamadı"),
  });

  // Takma ad + barkod kaydet. Barkod siparişlerin ürünle eşleşmesini sağlar (UNIQUE);
  // çakışmada 409 → retry YOK (kalıcı hata). Geçici ağ kopmasında 2 kez tekrar dener.
  const saveIdentityMutation = useMutation({
    mutationFn: async () => {
      const body: { alias: string | null; barcode?: string } = {
        alias: aliasInput.trim() || null,
      };
      const bc = barcodeInput.trim();
      if (bc && bc !== product?.barcode) body.barcode = bc;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 12_000);
      try {
        const r = await fetch(`/api/products/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify(body),
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
    retry: (n, e) => n < 2 && !(e instanceof Error && /barkod|kullanıl/i.test(e.message)),
    retryDelay: (n) => Math.min(1000 * 2 ** n, 4000),
    // Optimistic: cache'i anında yama → ["product",id] REFETCH YOK (yaz-sonrası donma yok).
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["product", id] });
      const prev = queryClient.getQueryData<ProductDetail>(["product", id]);
      const alias = aliasInput.trim() || null;
      const bc = barcodeInput.trim();
      queryClient.setQueryData<ProductDetail | undefined>(["product", id], (old) =>
        old ? { ...old, alias, ...(bc ? { barcode: bc } : {}) } : old
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
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["product", id], ctx.prev);
      toast.error("Kaydedilemedi — bağlantını kontrol et (geri alındı)");
    },
    onSuccess: (_d, madeToOrder) =>
      toast.success(madeToOrder ? "Sipariş üzerine üretilir olarak işaretlendi" : "Stok takibine alındı"),
    // Optimistic onMutate yeterli → ["product",id]'i YENİDEN ÇEKME (yaz-sonrası ağır refetch = 2-3sn donma).
    // Liste/panel sadece "bayat" işaretlenir (refetchType:"none") → o ekrana gidince tazelenir, şimdi değil.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["products"], refetchType: "none" });
      queryClient.invalidateQueries({ queryKey: ["dashboard"], refetchType: "none" });
    },
  });

  // Stok güncelleme
  // Optimistic stok: UI anında güncellenir, yazma arka planda + debounce'lu + retry'lı.
  const { adjustStock } = useStockWriter();

  // Real-time kâr önizlemesi — KAYDETMEDEN. Maliyet formu değişince debounce'lu
  // olarak preview endpoint'e gider, sağ taraftaki platform kartları anında güncellenir.
  const previewInput = useMemo(
    () => ({
      filamentTypeId: filamentTypeId || null,
      filamentWeight: fWeight,
      printTimeHours: pTime,
      wasteRate: wRate,
      packagingOptionId: packagingOptionId || null,
      nylonLevel,
      tapeUsed,
      desi: parseFloat(desiInput) || null,
    }),
    [filamentTypeId, fWeight, pTime, wRate, packagingOptionId, nylonLevel, tapeUsed, desiInput]
  );
  const [debouncedInput, setDebouncedInput] = useState(previewInput);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedInput(previewInput), 200);
    return () => clearTimeout(t);
  }, [previewInput]);

  const { data: preview } = useQuery<ProfitPreview>({
    queryKey: ["profit-preview", id, debouncedInput],
    queryFn: () =>
      fetch(`/api/products/${id}/profit-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(debouncedInput),
      }).then((r) => r.json()),
    enabled: Boolean(product),
    placeholderData: (prev) => prev, // değişim sırasında eski sonucu koru (flicker yok)
    staleTime: 0,
    refetchOnMount: "always",
  });

  if (isLoading || !product) {
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

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-center gap-4">
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
            <span className="font-mono">{product.barcode}</span>
            <span className="mx-1.5">·</span>
            <span className="font-mono">{product.sku}</span>
            <span className="mx-1.5">·</span>
            {product.categoryName}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sol: Maliyet formu */}
        <div className="space-y-4 lg:col-span-1">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Üretim Maliyeti</CardTitle>
              <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">
                Filament + elektrik + paketleme. Kargo, komisyon ve KDV her platform için
                otomatik hesaplanır.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <p className="text-xs font-semibold text-primary">3D BASKI</p>
                <div>
                  <Label className="text-xs">Filament Türü</Label>
                  <select
                    value={filamentTypeId}
                    onChange={(e) => setFilamentTypeId(e.target.value)}
                    className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Seçin...</option>
                    {filaments.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name} ({formatCurrency(f.costPerGram)}/g)
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Ağırlık (g)</Label>
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      value={filamentWeight}
                      onChange={(e) => setFilamentWeight(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Süre (saat)</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.1"
                      value={printTimeHours}
                      onChange={(e) => setPrintTimeHours(e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Fire (%)</Label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={wasteRate}
                    onChange={(e) => setWasteRate(e.target.value)}
                  />
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-primary">PAKETLEME</p>
                  <Link
                    href="/cost-templates"
                    className="text-[10px] text-muted-foreground hover:text-primary underline underline-offset-2"
                  >
                    Fiyatları düzenle
                  </Link>
                </div>
                <div>
                  <Label className="text-xs">Poşet / Koli</Label>
                  <select
                    value={packagingOptionId}
                    onChange={(e) => setPackagingOptionId(e.target.value)}
                    className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Yok</option>
                    {packagingSettings.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} ({formatCurrency(o.price)})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Naylon</Label>
                    <select
                      value={nylonLevel}
                      onChange={(e) => setNylonLevel(e.target.value as "none" | "low" | "medium" | "high")}
                      className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="none">Yok</option>
                      <option value="low">Az ({packagingSettings.nylonLowGrams}g)</option>
                      <option value="medium">Orta ({packagingSettings.nylonMediumGrams}g)</option>
                      <option value="high">Çok ({packagingSettings.nylonHighGrams}g)</option>
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs">Bant</Label>
                    <select
                      value={tapeUsed ? "yes" : "no"}
                      onChange={(e) => setTapeUsed(e.target.value === "yes")}
                      className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="no">Yok</option>
                      <option value="yes">Var ({formatCurrency(tapeCostPerProduct)})</option>
                    </select>
                  </div>
                </div>
                {fixedExtras > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    + Sabit ek (Kart/Sticker/Sakız): {formatCurrency(fixedExtras)} — her ürüne otomatik
                  </p>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <p className="text-xs font-semibold text-primary">KARGO</p>
                <div>
                  <Label className="text-xs">Desi</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.1"
                    value={desiInput}
                    onChange={(e) => setDesiInput(e.target.value)}
                    placeholder="örn. 2"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Trendyol kargosu desi + barem'e göre otomatik hesaplanır. Shopify kargosu
                    Kargo Kuralları&apos;ndaki Shopify baremine göre.
                  </p>
                </div>
              </div>

              <Separator />

              <div className="space-y-1 text-xs text-muted-foreground tabular-nums">
                <div className="flex justify-between">
                  <span>Malzeme</span>
                  <span>{formatCurrency(calcFilament)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Elektrik</span>
                  <span>{formatCurrency(calcElectricity)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Aşınma</span>
                  <span>{formatCurrency(calcMachineWear)}</span>
                </div>
                {calcLabor > 0 && (
                  <div className="flex justify-between">
                    <span>İşçilik</span>
                    <span>{formatCurrency(calcLabor)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>Paketleme</span>
                  <span>{formatCurrency(calcPackaging)}</span>
                </div>
                {calcWaste > 0 && (
                  <div className="flex justify-between text-amber-500">
                    <span>Fire</span>
                    <span>+{formatCurrency(calcWaste)}</span>
                  </div>
                )}
              </div>

              <div className="flex justify-between items-baseline pt-1">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  Üretim Maliyeti
                </span>
                <span className="text-lg font-bold tabular-nums">
                  {formatCurrency(calculatedTotalCost)}
                </span>
              </div>

              <Button
                size="sm"
                className="w-full"
                onClick={() => saveCostMutation.mutate()}
                disabled={saveCostMutation.isPending}
              >
                {saveCostMutation.isPending ? "Kaydediliyor..." : "Kaydet ve Uygula"}
              </Button>

              {(product.variantGroup?.products?.length ?? 0) > 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => applyCostToVariantsMutation.mutate()}
                  disabled={applyCostToVariantsMutation.isPending}
                  title="Aynı varyant grubundaki tüm ürünlere bu maliyeti (ve desi) uygular"
                >
                  {applyCostToVariantsMutation.isPending
                    ? "Uygulanıyor..."
                    : `Bu maliyeti tüm varyantlara uygula (${product.variantGroup?.products?.length})`}
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Ürün Bilgileri</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {/* Takma ad + barkod — arama ve sipariş eşleşmesi için kimlik alanları */}
              <div className="space-y-2 pb-1">
                <div>
                  <label className="text-[11px] text-muted-foreground">
                    Takma ad <span className="opacity-60">(listede gösterilir + aramada bulunur)</span>
                  </label>
                  <Input
                    value={aliasInput}
                    onChange={(e) => setAliasInput(e.target.value)}
                    maxLength={80}
                    placeholder="örn. kırmızı vazo"
                    className="h-8 mt-1"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">
                    Barkod <span className="opacity-60">(siparişler bununla eşleşir)</span>
                  </label>
                  <Input
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    maxLength={120}
                    placeholder="GTIN / EAN / Trendyol barkodu"
                    className="h-8 mt-1 font-mono"
                  />
                  {barcodeInput.startsWith("shopify-variant-") && (
                    <p className="text-[10px] text-amber-500 mt-1 leading-snug">
                      ⚠ Bu otomatik bir kimlik. Trendyol/HB siparişlerinin eşleşmesi için ürünün
                      gerçek barkodunu girin (tüm platformlarda aynı olmalı).
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full h-8"
                  disabled={
                    saveIdentityMutation.isPending ||
                    (aliasInput.trim() === (product.alias ?? "") &&
                      barcodeInput.trim() === product.barcode)
                  }
                  onClick={() => saveIdentityMutation.mutate()}
                >
                  {saveIdentityMutation.isPending ? "Kaydediliyor..." : "Takma ad / barkodu kaydet"}
                </Button>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Stok (kendi deponuz)</span>
                {product.madeToOrder ? (
                  <span className="text-xs text-muted-foreground italic">takip edilmez</span>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      disabled={product.stock <= 0}
                      onClick={() => adjustStock(id, -1, product.stock)}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <span
                      className={cn(
                        "tabular-nums font-bold text-base min-w-[2ch] text-center",
                        product.stock === 0
                          ? "text-destructive"
                          : product.stock === 1
                            ? "text-amber-500"
                            : "text-foreground"
                      )}
                    >
                      {product.stock}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => adjustStock(id, 1, product.stock)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
              {!product.madeToOrder && product.stock <= 1 && (
                <p
                  className={cn(
                    "text-[11px]",
                    product.stock === 0 ? "text-destructive" : "text-amber-500"
                  )}
                >
                  {product.stock === 0 ? "⚠ Stok tükendi" : "⚠ Stok kritik (1 adet)"}
                </p>
              )}
              {/* Sipariş üzerine üretilir → stok takibi yok, "stok 0" uyarısı verilmez */}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Sipariş üzerine üretilir</span>
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
              {product.desi && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Desi</span>
                  <span className="tabular-nums">{product.desi}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Kaynak</span>
                <Badge variant="outline" className="text-xs uppercase">
                  {product.source}
                </Badge>
              </div>
            </CardContent>
          </Card>
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

      <ModelFilesCard productId={product.id} />

      <PriceLabCard productId={product.id} />

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
            queryClient.invalidateQueries({ queryKey: ["products"], refetchType: "none" });
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
  liveResult,
  hasCost,
}: {
  platform: "shopify" | "trendyol" | "hepsiburada";
  listing: Listing | null;
  productId: string;
  /** Parent'tan gelen real-time kâr önizlemesi (kaydetmeden) */
  liveResult: SimulationResult | null;
  /** Maliyet girilmiş mi (preview yüklendiyse). null = preview henüz yüklenmedi */
  hasCost: boolean | null;
}) {
  const info = PLATFORM_INFO[platform];
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [salePrice, setSalePrice] = useState(listing?.salePrice ? String(listing.salePrice) : "");
  const [commissionRate, setCommissionRate] = useState(
    listing?.commissionRate ? String(listing.commissionRate * 100) : ""
  );
  const [cargoCost, setCargoCost] = useState(
    listing?.cargoCost ? String(listing.cargoCost) : ""
  );

  useEffect(() => {
    if (listing) {
      setSalePrice(String(listing.salePrice));
      setCommissionRate(listing.commissionRate ? String(listing.commissionRate * 100) : "");
      setCargoCost(listing.cargoCost ? String(listing.cargoCost) : "");
    }
  }, [listing]);

  const createListing = useMutation({
    mutationFn: () =>
      fetch("/api/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          platform,
          salePrice: parseFloat(salePrice) || 0,
          commissionRate: commissionRate ? parseFloat(commissionRate) / 100 : null,
          cargoCost: cargoCost ? parseFloat(cargoCost) : null,
        }),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product", productId] });
      // Canlı kâr önizlemesini de tazele → yeni komisyon/fiyat/kargo ANINDA hesaba girsin
      // (yoksa oran etiketi güncellenir ama komisyon tutarı sayfaya tekrar girilene dek 0 kalır).
      queryClient.invalidateQueries({ queryKey: ["profit-preview", productId] });
      queryClient.invalidateQueries({ queryKey: ["products"], refetchType: "none" });
      toast.success(`${info.label} listing'i eklendi`);
      setEditing(false);
    },
    onError: () => toast.error("Eklenemedi"),
  });

  const updateListing = useMutation({
    mutationFn: () =>
      fetch(`/api/listings/${listing!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salePrice: parseFloat(salePrice) || 0,
          commissionRate: commissionRate ? parseFloat(commissionRate) / 100 : null,
          cargoCost: cargoCost ? parseFloat(cargoCost) : null,
        }),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product", productId] });
      // Canlı kâr önizlemesini de tazele → yeni komisyon/fiyat/kargo ANINDA hesaba girsin
      // (yoksa oran etiketi güncellenir ama komisyon tutarı sayfaya tekrar girilene dek 0 kalır).
      queryClient.invalidateQueries({ queryKey: ["profit-preview", productId] });
      queryClient.invalidateQueries({ queryKey: ["products"], refetchType: "none" });
      toast.success("Güncellendi");
      setEditing(false);
    },
    onError: () => toast.error("Güncellenemedi"),
  });

  const deleteListing = useMutation({
    mutationFn: () => fetch(`/api/listings/${listing!.id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product", productId] });
      queryClient.invalidateQueries({ queryKey: ["profit-preview", productId] });
      queryClient.invalidateQueries({ queryKey: ["products"], refetchType: "none" });
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
              <div>
                <Label className="text-xs">Kargo (TL) — boş bırak otomatik</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={cargoCost}
                  onChange={(e) => setCargoCost(e.target.value)}
                  placeholder="örn. 65"
                />
              </div>
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
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setEditing(true)}
            >
              <Plus className="h-4 w-4 mr-1.5" /> Bu Platforma Ekle
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const result = liveResult;
  const missingCost = hasCost === false;
  const isLoss = result && result.netProfit < 0;
  const isThin = result && !isLoss && result.profitMargin < 0.1;
  // Trendyol'da komisyon kaynağı yok (override yok + kural eşleşmedi) → uyar
  const commissionMissing =
    platform === "trendyol" &&
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
            <div>
              <Label className="text-xs">Kargo (TL)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={cargoCost}
                onChange={(e) => setCargoCost(e.target.value)}
                placeholder="otomatik"
              />
            </div>
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

            {commissionMissing && (
              <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-2.5 py-2 font-medium">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  Trendyol komisyonu girilmemiş! Kâr olduğundan yüksek görünüyor.
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
