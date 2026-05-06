"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

export default function ApiSettingsPage() {
  const queryClient = useQueryClient();
  const [lastResult, setLastResult] = useState<string>("");
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
    mutationFn: () =>
      fetchJson<{
        created: number;
        updated: number;
        skipped: number;
        totalElements: number;
        totalPages: number;
      }>("/api/trendyol/sync-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, archived: false, maxPages: 10, size: 100 }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setLastResult(
        `Sync tamam. Yeni: ${data.created}, guncellenen: ${data.updated}, atlanan: ${data.skipped}.`
      );
      toast.success("Trendyol urunleri senkronize edildi");
    },
    onError: (error) => {
      setLastResult(error.message);
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
    mutationFn: () =>
      fetchJson<{
        updated: number;
        unchanged: number;
        foundBarcodes: number;
        scannedRecords: number;
      }>("/api/trendyol/sync-commissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 180 }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      setLastResult(
        `Komisyon sync tamam. Güncellenen: ${data.updated}, aynı kalan: ${data.unchanged}, bulunan barkod: ${data.foundBarcodes}.`
      );
      toast.success("Komisyonlar güncellendi");
    },
    onError: (error) => {
      setLastResult(error.message);
      toast.error(error.message);
    },
  });

  const configured = Boolean(settings?.sellerId && settings.hasApiKey && settings.hasApiSecret);

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
              disabled={!configured || testMutation.isPending}
              onClick={() => testMutation.mutate()}
            >
              Test Et
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
              disabled={!configured || syncCommissionsMutation.isPending}
              onClick={() => syncCommissionsMutation.mutate()}
            >
              Komisyonları Güncelle
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
              disabled={!configured || syncMutation.isPending}
              onClick={() => syncMutation.mutate()}
            >
              Ürünleri Çek
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
              disabled={!configured || updatePricesMutation.isPending}
              onClick={() => updatePricesMutation.mutate()}
            >
              Kabul Edilenleri Gönder
            </Button>
          </CardContent>
        </Card>
      </div>

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
