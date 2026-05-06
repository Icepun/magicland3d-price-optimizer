"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Percent, Settings2, PlugZap, RefreshCw, UploadCloud, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

interface TrendyolSettings {
  sellerId: string;
  hasIntegrationReferenceCode: boolean;
  integrationReferenceCodeMasked: string;
  environment: "prod" | "stage";
  integratorName: string;
  hasApiKey: boolean;
  hasApiSecret: boolean;
  apiKeyMasked: string;
  apiSecretMasked: string;
}

const Schema = z.object({
  sellerId: z.string().min(1, "Satici ID gerekli"),
  integrationReferenceCode: z.string().optional(),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  environment: z.enum(["prod", "stage"]).default("prod"),
  integratorName: z.string().min(1).max(30).default("SelfIntegration"),
});

type FormData = z.infer<typeof Schema>;
const DRAFT_KEY = "trendyol-api-settings-draft";
const DAY_MS = 24 * 60 * 60 * 1000;
const COMMISSION_DAYS = 365;
const COMMISSION_RANGE_DAYS = 15;

interface OperationProgress {
  label: string;
  detail: string;
  value: number;
  startedAt: number;
}

interface ProductSyncResult {
  created: number;
  updated: number;
  skipped: number;
  totalElements: number;
  totalPages: number;
  processedPages: number;
  nextPage: number;
}

interface CommissionSyncResult {
  updated: number;
  unchanged: number;
  foundBarcodes: number;
  matchedProducts: number;
  unmatchedBarcodes: number;
  scannedRecords: number;
}

function getInitialFormValues(): FormData {
  const fallback: FormData = {
    sellerId: "",
    integrationReferenceCode: "",
    apiKey: "",
    apiSecret: "",
    environment: "prod",
    integratorName: "SelfIntegration",
  };

  if (typeof window === "undefined") return fallback;

  try {
    const rawDraft = window.sessionStorage.getItem(DRAFT_KEY);
    if (!rawDraft) return fallback;
    return { ...fallback, ...Schema.partial().parse(JSON.parse(rawDraft)) };
  } catch {
    return fallback;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      typeof data === "object" && data && "error" in data
        ? String((data as { error?: unknown }).error)
        : `${url} ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

function formatDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} sn`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} dk ${rest} sn` : `${minutes} dk`;
}

function mergeProductSyncResult(
  total: ProductSyncResult,
  next: ProductSyncResult
): ProductSyncResult {
  return {
    created: total.created + next.created,
    updated: total.updated + next.updated,
    skipped: total.skipped + next.skipped,
    totalElements: next.totalElements || total.totalElements,
    totalPages: next.totalPages || total.totalPages,
    processedPages: total.processedPages + next.processedPages,
    nextPage: next.nextPage,
  };
}

function mergeCommissionSyncResult(
  total: CommissionSyncResult,
  next: CommissionSyncResult
): CommissionSyncResult {
  return {
    updated: total.updated + next.updated,
    unchanged: total.unchanged + next.unchanged,
    foundBarcodes: total.foundBarcodes + next.foundBarcodes,
    matchedProducts: total.matchedProducts + next.matchedProducts,
    unmatchedBarcodes: total.unmatchedBarcodes + next.unmatchedBarcodes,
    scannedRecords: total.scannedRecords + next.scannedRecords,
  };
}

function buildCommissionRanges() {
  const now = Date.now();
  const startLimit = now - COMMISSION_DAYS * DAY_MS;
  const ranges: Array<{ startDate: number; endDate: number }> = [];
  let endDate = now;

  while (endDate > startLimit) {
    const startDate = Math.max(startLimit, endDate - COMMISSION_RANGE_DAYS * DAY_MS + 1);
    ranges.push({ startDate, endDate });
    endDate = startDate - 1;
  }

  return ranges.reverse();
}

export default function ApiSettingsPage() {
  const queryClient = useQueryClient();
  const [lastResult, setLastResult] = useState<string>("");
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const hasDraftRef = useRef(
    typeof window !== "undefined" && Boolean(window.sessionStorage.getItem(DRAFT_KEY))
  );

  const { data: settings } = useQuery<TrendyolSettings>({
    queryKey: ["trendyol-settings"],
    queryFn: () => fetchJson<TrendyolSettings>("/api/trendyol/settings"),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const form = useForm<FormData>({
    resolver: zodResolver(Schema),
    defaultValues: getInitialFormValues(),
  });
  const draftValues = useWatch({ control: form.control });
  const sellerIdPreview = useWatch({ control: form.control, name: "sellerId" });
  const integratorNamePreview = useWatch({ control: form.control, name: "integratorName" });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!form.formState.isDirty) return;

    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draftValues));
    hasDraftRef.current = true;
  }, [draftValues, form.formState.isDirty]);

  useEffect(() => {
    if (!settings) return;
    if (hasDraftRef.current) return;
    if (form.formState.isDirty) return;

    form.reset({
      sellerId: settings.sellerId,
      integrationReferenceCode: "",
      apiKey: "",
      apiSecret: "",
      environment: settings.environment,
      integratorName: settings.integratorName,
    });
  }, [settings, form]);

  const saveMutation = useMutation({
    mutationFn: (data: FormData) =>
      fetchJson<TrendyolSettings>("/api/trendyol/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["trendyol-settings"], data);
      window.sessionStorage.removeItem(DRAFT_KEY);
      hasDraftRef.current = false;
      form.reset({
        sellerId: data.sellerId,
        integrationReferenceCode: "",
        apiKey: "",
        apiSecret: "",
        environment: data.environment,
        integratorName: data.integratorName,
      });
      toast.success("Trendyol API bilgileri kaydedildi");
    },
    onError: (error) => toast.error(error.message),
  });

  const testMutation = useMutation({
    mutationFn: () =>
      fetchJson<{ totalElements: number; totalPages: number }>("/api/trendyol/test", {
        method: "POST",
      }),
    onSuccess: (data) => {
      setLastResult(`Baglanti tamam. Trendyol ${data.totalElements} urun raporladi.`);
      toast.success("Trendyol baglantisi basarili");
    },
    onError: (error) => {
      setLastResult(error.message);
      toast.error(error.message);
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const startedAt = Date.now();
      let page = 0;
      let total: ProductSyncResult = {
        created: 0,
        updated: 0,
        skipped: 0,
        totalElements: 0,
        totalPages: 0,
        processedPages: 0,
        nextPage: 0,
      };

      setProgress({
        label: "Urunler cekiliyor",
        detail: "Trendyol ilk sayfa okunuyor...",
        value: 3,
        startedAt,
      });

      while (page < 100) {
        const result = await fetchJson<ProductSyncResult>("/api/trendyol/sync-products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            approved: true,
            archived: false,
            startPage: page,
            maxPages: 1,
            size: 100,
          }),
        });

        total = mergeProductSyncResult(total, result);
        const totalPages = Math.max(1, result.totalPages || total.totalPages || page + 1);
        const nextPage = result.nextPage ?? page + 1;
        const value = Math.min(100, Math.round((nextPage / totalPages) * 100));

        setProgress({
          label: "Urunler cekiliyor",
          detail: `${nextPage}/${totalPages} sayfa islendi. Gecen sure: ${formatDuration(Date.now() - startedAt)}.`,
          value,
          startedAt,
        });

        page = nextPage;
        if (page >= totalPages || result.processedPages === 0) break;
      }

      return total;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setLastResult(
        `Sync tamam. Yeni: ${data.created}, guncellenen: ${data.updated}, atlanan: ${data.skipped}, sayfa: ${data.processedPages}/${data.totalPages}.`
      );
      setProgress(null);
      toast.success("Trendyol urunleri senkronize edildi");
    },
    onError: (error) => {
      setLastResult(error.message);
      setProgress(null);
      toast.error(error.message);
    },
  });

  const updatePricesMutation = useMutation({
    mutationFn: () =>
      fetchJson<{ sent: number; skipped: unknown[]; batchRequestId?: string }>(
        "/api/trendyol/update-prices",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ onlyAccepted: true, dryRun: false }),
        }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setLastResult(
        `Fiyat gonderimi tamam. Gonderilen: ${data.sent}, atlanan: ${data.skipped.length}${
          data.batchRequestId ? `, batch: ${data.batchRequestId}` : ""
        }.`
      );
      toast.success("Kabul edilen oneriler Trendyol'a gonderildi");
    },
    onError: (error) => {
      setLastResult(error.message);
      toast.error(error.message);
    },
  });

  const syncCommissionsMutation = useMutation({
    mutationFn: async () => {
      const startedAt = Date.now();
      const ranges = buildCommissionRanges();
      let total: CommissionSyncResult = {
        updated: 0,
        unchanged: 0,
        foundBarcodes: 0,
        matchedProducts: 0,
        unmatchedBarcodes: 0,
        scannedRecords: 0,
      };

      setProgress({
        label: "Komisyonlar guncelleniyor",
        detail: `${ranges.length} donem taranacak.`,
        value: 1,
        startedAt,
      });

      for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index];
        const result = await fetchJson<CommissionSyncResult>("/api/trendyol/sync-commissions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            days: COMMISSION_DAYS,
            startDate: range.startDate,
            endDate: range.endDate,
          }),
        });

        total = mergeCommissionSyncResult(total, result);
        const done = index + 1;
        const value = Math.round((done / ranges.length) * 100);
        const elapsed = Date.now() - startedAt;
        const estimatedTotal = (elapsed / done) * ranges.length;
        const remaining = Math.max(0, estimatedTotal - elapsed);

        setProgress({
          label: "Komisyonlar guncelleniyor",
          detail: `${done}/${ranges.length} donem islendi. Kalan tahmini: ${formatDuration(remaining)}.`,
          value,
          startedAt,
        });
      }

      return total;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      setLastResult(
        `Komisyon sync tamam. Guncellenen: ${data.updated}, ayni kalan: ${data.unchanged}, eslesen urun: ${data.matchedProducts}, finans barkodu: ${data.foundBarcodes}, taranan kayit: ${data.scannedRecords}.`
      );
      setProgress(null);
      toast.success("Komisyonlar guncellendi");
    },
    onError: (error) => {
      setLastResult(error.message);
      setProgress(null);
      toast.error(error.message);
    },
  });

  const configured = Boolean(settings?.sellerId && settings.hasApiKey && settings.hasApiSecret);
  const busy =
    testMutation.isPending ||
    syncMutation.isPending ||
    syncCommissionsMutation.isPending ||
    updatePricesMutation.isPending;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings2 className="h-6 w-6" /> Trendyol API
        </h1>
        <Badge variant={configured ? "default" : "secondary"}>
          {configured ? "Hazir" : "Eksik Bilgi"}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> API Bilgileri
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((data) => saveMutation.mutate(data))}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label>Satıcı ID (Cari ID)</Label>
                <Input {...form.register("sellerId")} placeholder="123456" />
              </div>
              <div>
                <Label>Ortam</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  {...form.register("environment")}
                >
                  <option value="prod">Canli</option>
                  <option value="stage">Stage</option>
                </select>
              </div>
            </div>

            <div>
              <Label>Entegrasyon Referans Kodu</Label>
              <Input
                type="password"
                autoComplete="off"
                {...form.register("integrationReferenceCode")}
                placeholder={settings?.integrationReferenceCodeMasked || "Paneldeki referans kodu"}
              />
            </div>

            <div>
              <Label>User-Agent Entegratör Adı</Label>
              <Input {...form.register("integratorName")} placeholder="SelfIntegration" />
              <p className="text-xs text-muted-foreground mt-1">
                Kendi yazılımınız için varsayılan değer SelfIntegration; header:
                {" "}
                {sellerIdPreview || "SatıcıID"} - {integratorNamePreview || "SelfIntegration"}.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label>API Key</Label>
                <Input
                  type="password"
                  autoComplete="off"
                  {...form.register("apiKey")}
                  placeholder={settings?.apiKeyMasked || "Yeni API Key"}
                />
              </div>
              <div>
                <Label>API Secret</Label>
                <Input
                  type="password"
                  autoComplete="off"
                  {...form.register("apiSecret")}
                  placeholder={settings?.apiSecretMasked || "Yeni API Secret"}
                />
              </div>
            </div>

            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Kaydediliyor..." : "Kaydet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <PlugZap className="h-4 w-4" /> Bağlantı Testi
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              className="w-full"
              disabled={!configured || busy}
              onClick={() => testMutation.mutate()}
            >
              {testMutation.isPending ? "Test ediliyor..." : "Test Et"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Percent className="h-4 w-4" /> Komisyon
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              className="w-full"
              disabled={!configured || busy}
              onClick={() => syncCommissionsMutation.mutate()}
            >
              {syncCommissionsMutation.isPending ? "Guncelleniyor..." : "Komisyonlari Guncelle"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <RefreshCw className="h-4 w-4" /> Ürün Sync
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              className="w-full"
              disabled={!configured || busy}
              onClick={() => syncMutation.mutate()}
            >
              {syncMutation.isPending ? "Cekiliyor..." : "Urunleri Cek"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <UploadCloud className="h-4 w-4" /> Fiyat Gönder
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              className="w-full"
              disabled={!configured || busy}
              onClick={() => updatePricesMutation.mutate()}
            >
              {updatePricesMutation.isPending ? "Gonderiliyor..." : "Kabul Edilenleri Gonder"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {progress && (
        <Card>
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">{progress.label}</span>
              <span className="text-muted-foreground">%{Math.round(progress.value)}</span>
            </div>
            <Progress value={progress.value} />
            <p className="text-xs text-muted-foreground">{progress.detail}</p>
          </CardContent>
        </Card>
      )}

      {lastResult && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            {lastResult}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
