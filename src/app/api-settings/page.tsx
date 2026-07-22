"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { PlugZap, RefreshCw, ShieldCheck, ShoppingBag, Settings2, Plus, KeyRound, Store } from "lucide-react";

interface TrendyolPublicSettings {
  sellerId: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  hasApiSecret: boolean;
  apiSecretMasked: string;
  integratorName: string;
}

interface ShopifyPublicSettings {
  shopDomain: string;
  apiVersion: string;
  hasStorefrontAccessToken: boolean;
  storefrontAccessTokenMasked: string;
  clientId: string;
  hasClientSecret: boolean;
  clientSecretMasked: string;
}

interface HepsiburadaPublicSettings {
  merchantId: string;
  developerUsername: string;
  environment: "test" | "prod";
  hasSecretKey: boolean;
  secretKeyMasked: string;
}

interface ShopifyDebugResult {
  steps: Array<{
    name: string;
    status: "ok" | "fail";
    detail: string;
    responseStatus?: number;
    responseBody?: unknown;
  }>;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `${url} ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

// ───────────── Trendyol Form ─────────────
const TrendyolSchema = z.object({
  sellerId: z.string().min(1, "Seller ID gerekli"),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  integratorName: z.string().default("SelfIntegration"),
});
type TrendyolForm = z.infer<typeof TrendyolSchema>;

function TrendyolTab() {
  const qc = useQueryClient();
  const { data: settings } = useQuery<TrendyolPublicSettings>({
    queryKey: ["trendyol-settings"],
    queryFn: () => fetchJson("/api/trendyol/settings"),
  });

  const form = useForm<TrendyolForm>({
    resolver: zodResolver(TrendyolSchema),
    defaultValues: {
      sellerId: settings?.sellerId ?? "",
      integratorName: settings?.integratorName ?? "SelfIntegration",
    },
    values: settings
      ? {
          sellerId: settings.sellerId,
          apiKey: "",
          apiSecret: "",
          integratorName: settings.integratorName,
        }
      : undefined,
  });

  const save = useMutation({
    mutationFn: (data: TrendyolForm) =>
      fetchJson("/api/trendyol/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, environment: "prod" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trendyol-settings"] });
      toast.success("Trendyol ayarları kaydedildi");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const test = useMutation({
    mutationFn: () => fetchJson("/api/trendyol/test", { method: "POST" }),
    onSuccess: () => toast.success("Trendyol bağlantısı başarılı"),
    onError: (e: Error) => toast.error(e.message),
  });

  const sync = useMutation({
    meta: { silent: true }, // kendi SyncProgressCard'ı var → global katman gösterme
    mutationFn: (mode: "add-new" | "refresh-prices") =>
      fetchJson<{ linked?: number; unmatched?: number; checked?: number; changed?: number }>(
        "/api/trendyol/sync-products",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        }
      ),
    onSuccess: (d, mode) => {
      if (mode === "add-new") {
        toast.success(`Trendyol: ${d.linked ?? 0} ürün bağlandı, ${d.unmatched ?? 0} eşleşmemiş havuzda`);
      } else {
        toast.success(`Trendyol fiyatlar: ${d.changed ?? 0} değişti (${d.checked ?? 0} kontrol edildi)`);
      }
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Trendyol API
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={form.handleSubmit((d) => save.mutate(d))} className="space-y-3">
            <div>
              <Label className="text-xs">Seller ID</Label>
              <Input {...form.register("sellerId")} placeholder="123456" />
            </div>
            <div>
              <Label className="text-xs">API Key</Label>
              <Input
                {...form.register("apiKey")}
                type="password"
                placeholder={settings?.hasApiKey ? settings.apiKeyMasked : "Yeni API key girin"}
              />
            </div>
            <div>
              <Label className="text-xs">API Secret</Label>
              <Input
                {...form.register("apiSecret")}
                type="password"
                placeholder={settings?.hasApiSecret ? settings.apiSecretMasked : "Yeni secret girin"}
              />
            </div>
            <div>
              <Label className="text-xs">Integrator Name</Label>
              <Input {...form.register("integratorName")} />
            </div>
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? "Kaydediliyor…" : "Kaydet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
          <PlugZap className="h-4 w-4 mr-2" />
          {test.isPending ? "Test ediliyor…" : "Bağlantıyı Test Et"}
        </Button>
        <Button disabled={sync.isPending} onClick={() => sync.mutate("refresh-prices")}>
          <RefreshCw className={`h-4 w-4 mr-2 ${sync.isPending ? "animate-spin" : ""}`} />
          {sync.isPending ? "Güncelleniyor…" : "Fiyatları Güncelle"}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Trendyol ürünleri buradan eklenmez — Shopify ana ürününe karşılık gelen
        Trendyol ürününü <strong>Ürünler</strong> sekmesindeki &quot;Ürün Seç&quot; ile eşleştir.
        Bu buton yalnızca eşleşmiş ürünlerin fiyatlarını günceller.
      </p>

      {sync.isPending && <SyncProgressCard platform="Trendyol" />}
    </div>
  );
}

/**
 * Sync sırasında DÜRÜST belirsiz (indeterminate) gösterge.
 * İşin gerçek ilerlemesi client'a akmadığı için sahte yüzde göstermiyoruz —
 * sürekli akan bir bar + geçen saniye sayacı (yanıltıcı "%X" yok).
 */
function SyncProgressCard({ platform }: { platform: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, []);

  return (
    <Card className="border-primary/30 bg-primary/5 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium flex items-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin text-primary" />
            {platform} işleniyor
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{elapsed}s</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full w-1/3 rounded-full bg-primary"
            style={{ animation: "indeterminate-bar 1.2s ease-in-out infinite" }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {platform} API taranıyor. Mağaza büyüklüğüne göre 10 saniye – birkaç dakika
          sürebilir. Bu pencereyi kapatma.
        </p>
      </CardContent>
    </Card>
  );
}

// ───────────── Shopify Form ─────────────
const ShopifySchema = z.object({
  shopDomain: z.string().min(1, "Shopify mağaza adı gerekli"),
  apiVersion: z.string().optional(),
  storefrontAccessToken: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});
type ShopifyForm = z.infer<typeof ShopifySchema>;

function ShopifyTab() {
  const qc = useQueryClient();
  const { data: settings } = useQuery<ShopifyPublicSettings>({
    queryKey: ["shopify-settings"],
    queryFn: () => fetchJson("/api/shopify/settings"),
  });

  const form = useForm<ShopifyForm>({
    resolver: zodResolver(ShopifySchema),
    values: settings
      ? {
          shopDomain: settings.shopDomain,
          apiVersion: settings.apiVersion,
          storefrontAccessToken: "",
          clientId: settings.clientId ?? "",
          clientSecret: "",
        }
      : {
          shopDomain: "",
          apiVersion: "2024-10",
          storefrontAccessToken: "",
          clientId: "",
          clientSecret: "",
        },
  });

  const save = useMutation({
    mutationFn: (data: ShopifyForm) =>
      fetchJson("/api/shopify/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shopify-settings"] });
      toast.success("Shopify ayarları kaydedildi");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const disconnect = useMutation({
    mutationFn: () => fetchJson("/api/shopify/settings", { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shopify-settings"] });
      qc.invalidateQueries({ queryKey: ["integrations-status"] });
      toast.success("Shopify token silindi");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [debugResult, setDebugResult] = useState<ShopifyDebugResult | null>(null);
  const testConnection = useMutation({
    mutationFn: () =>
      fetchJson<ShopifyDebugResult>("/api/shopify/generate-token", { method: "POST" }),
    onSuccess: (data) => {
      setDebugResult(data);
      const allOk = data.steps.every((s) => s.status === "ok");
      if (allOk) {
        toast.success("Bağlantı başarılı — ürün çekmeye hazır");
      } else {
        toast.error("Bir adımda hata var — detayları aşağıda gör");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sync = useMutation({
    meta: { silent: true }, // kendi SyncProgressCard'ı var → global katman gösterme
    mutationFn: (mode: "add-new" | "refresh-prices") =>
      fetchJson<{ added?: number; checked?: number; changed?: number; totalProducts: number }>(
        "/api/shopify/sync-products",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        }
      ),
    onSuccess: (d, mode) => {
      if (d.totalProducts === 0) {
        toast.error("Shopify mağazasında ürün bulunamadı. Storefront izinleri açık mı?");
      } else if (mode === "add-new") {
        toast.success(`Shopify: ${d.added ?? 0} yeni ürün eklendi`);
      } else {
        toast.success(`Shopify fiyatlar: ${d.changed ?? 0} değişti (${d.checked ?? 0} kontrol edildi)`);
      }
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ShoppingBag className="h-4 w-4" /> Shopify API
          </CardTitle>
          <p className="text-[11px] text-muted-foreground mt-1">
            Admin API Access Token ile çalışır. Aşağıdaki rehberi açıp adımları
            izle.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={form.handleSubmit((d) => save.mutate(d))} className="space-y-3">
            <div>
              <Label className="text-xs">Mağaza Alan Adı</Label>
              <Input {...form.register("shopDomain")} placeholder="magicland-3d.myshopify.com" />
            </div>

            <ShopifyStorefrontGuide />

            <div>
              <Label className="text-xs">Storefront Private Access Token</Label>
              <Input
                {...form.register("storefrontAccessToken")}
                type="password"
                placeholder={
                  settings?.hasStorefrontAccessToken
                    ? settings.storefrontAccessTokenMasked
                    : "shpat_..."
                }
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                {settings?.hasStorefrontAccessToken
                  ? "Token kayıtlı. Değiştirmek istemiyorsan boş bırak."
                  : `Headless kanalı → Storefront API → "Özel Erişim Belirteci" üzerinden kopyala.`}
              </p>
            </div>

            <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2.5">
              <Label className="text-xs flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5" /> Siparişler için — Client ID + Secret (opsiyonel)
              </Label>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Siparişleri görmek için gerekir (Storefront token siparişleri vermez). Shopify dev
                dashboard → uygulaman → <strong>Ayarlar → Kimlik bilgileri</strong>&apos;ndeki{" "}
                <strong>İstemci Kimliği</strong> ve <strong>Gizli anahtar</strong>&apos;ı gir. Uygulama
                bunlarla 24 saatlik erişim token&apos;ını otomatik üretir ve yeniler. Uygulamanın erişim
                kapsamlarında <strong>sipariş okuma (read_orders)</strong> açık olmalı.
              </p>
              <div>
                <Label className="text-[11px] text-muted-foreground">İstemci Kimliği (Client ID)</Label>
                <Input {...form.register("clientId")} placeholder="örn. a6aa7fdbb1421cd9..." />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">Gizli Anahtar (Client Secret)</Label>
                <Input
                  {...form.register("clientSecret")}
                  type="password"
                  placeholder={settings?.hasClientSecret ? settings.clientSecretMasked : "shpss_..."}
                />
                {settings?.hasClientSecret && (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Gizli anahtar kayıtlı. Değiştirmeyeceksen boş bırak.
                  </p>
                )}
              </div>
            </div>

            <div>
              <Label className="text-xs">API Versiyonu (opsiyonel)</Label>
              <Input {...form.register("apiVersion")} placeholder="2024-10" />
            </div>
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? "Kaydediliyor…" : "Kaydet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {settings?.hasStorefrontAccessToken && (
        <Card className="border-green-500/40 bg-green-500/5">
          <CardContent className="pt-4 pb-4 flex items-center justify-between gap-3">
            <div className="text-sm">
              <div className="flex items-center gap-2 font-medium text-green-500">
                ✓ Storefront token kayıtlı
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {settings.shopDomain} · token: {settings.storefrontAccessTokenMasked}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={disconnect.isPending}
              onClick={() => {
                if (confirm("Storefront token silinsin mi? Yeniden yapıştırman gerekir.")) {
                  disconnect.mutate();
                }
              }}
            >
              {disconnect.isPending ? "Siliniyor…" : "Token'ı Sıfırla"}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="outline"
          disabled={testConnection.isPending || !settings?.hasStorefrontAccessToken}
          onClick={() => testConnection.mutate()}
        >
          <PlugZap className={`h-4 w-4 mr-2 ${testConnection.isPending ? "animate-spin" : ""}`} />
          {testConnection.isPending ? "Test ediliyor…" : "Bağlantıyı Test Et"}
        </Button>
        <Button
          variant="outline"
          disabled={sync.isPending || !settings?.hasStorefrontAccessToken}
          onClick={() => sync.mutate("add-new")}
        >
          <Plus className={`h-4 w-4 mr-2 ${sync.isPending && sync.variables === "add-new" ? "animate-spin" : ""}`} />
          {sync.isPending && sync.variables === "add-new" ? "Ekleniyor…" : "Yeni Ürün Ekle"}
        </Button>
      </div>
      <Button
        className="w-full"
        disabled={sync.isPending || !settings?.hasStorefrontAccessToken}
        onClick={() => sync.mutate("refresh-prices")}
      >
        <RefreshCw className={`h-4 w-4 mr-2 ${sync.isPending && sync.variables === "refresh-prices" ? "animate-spin" : ""}`} />
        {sync.isPending && sync.variables === "refresh-prices" ? "Fiyatlar güncelleniyor…" : "Fiyatları Güncelle"}
      </Button>

      {debugResult && !testConnection.isPending && (
        <ShopifyDebugCard result={debugResult} />
      )}

      {sync.isPending && <SyncProgressCard platform="Shopify" />}
    </div>
  );
}

function ShopifyStorefrontGuide() {
  return (
    <details className="text-[11px] bg-muted/40 rounded-md leading-relaxed group" open>
      <summary className="cursor-pointer p-2.5 font-medium hover:bg-muted/60 rounded-md select-none">
        🔑 Storefront API token nasıl alınır? (tıkla aç)
      </summary>
      <ol className="list-decimal pl-7 pr-3 pb-3 space-y-1.5 text-muted-foreground">
        <li>
          Shopify Admin&apos;e gir →{" "}
          <code className="text-foreground">magicland-3d.myshopify.com/admin</code>
        </li>
        <li>
          Sol menüde <strong className="text-foreground">Apps and sales channels</strong>{" "}
          (veya Uygulamalar) altında <strong className="text-foreground">Headless</strong>{" "}
          uygulamasını aç
        </li>
        <li>
          Üstte <strong className="text-foreground">Storefronts</strong> →
          mağaza vitrinini seç → <strong className="text-foreground">Storefront API</strong>{" "}
          sekmesine geç
        </li>
        <li>
          <strong className="text-foreground">Storefront API izinleri</strong>{" "}
          kartında en az şunlar açık olmalı (kalem ikonuyla düzenle):
          <div className="mt-1 pl-3 font-mono text-[10px] text-foreground">
            unauthenticated_read_product_listings
            <br />
            unauthenticated_read_product_inventory
          </div>
        </li>
        <li>
          <strong className="text-foreground">Özel Erişim Belirteci</strong>{" "}
          kartında token göz 👁 ikonuyla görünür kıl → kopyala
          (<code>shpat_...</code> ile başlar)
        </li>
        <li>
          Aşağıdaki <strong className="text-foreground">Storefront Private Access Token</strong>{" "}
          alanına yapıştır → <strong className="text-foreground">Kaydet</strong>
        </li>
        <li>
          <strong className="text-foreground">Bağlantıyı Test Et</strong> → iki
          ✓ yeşil görmelisin → sonra <strong className="text-foreground">Ürünleri Senkronize Et</strong>
        </li>
      </ol>
      <div className="px-3 pb-3 pt-1 text-[10px] text-muted-foreground">
        <strong>Not:</strong> Storefront API sadece &quot;active&quot; (yayında)
        ürünleri döner — draft / archive görmek istiyorsan Admin API gerekir, o
        ayrı bir kurulum.
      </div>
    </details>
  );
}

function ShopifyDebugCard({ result }: { result: ShopifyDebugResult }) {
  const allOk = result.steps.every((s) => s.status === "ok");
  return (
    <Card className={allOk ? "border-green-500/40 bg-green-500/5" : "border-amber-500/40 bg-amber-500/5"}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Token + API Test Sonucu</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {result.steps.map((step, i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-semibold">
                {step.status === "ok" ? "✓" : "✗"} {step.name}
              </span>
              {step.responseStatus && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  HTTP {step.responseStatus}
                </span>
              )}
            </div>
            <p className={step.status === "ok" ? "text-muted-foreground" : "text-amber-500"}>
              {step.detail}
            </p>
            {step.responseBody !== undefined && (
              <pre className="text-[10px] bg-muted/40 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                {typeof step.responseBody === "string"
                  ? step.responseBody
                  : JSON.stringify(step.responseBody, null, 2)}
              </pre>
            )}
          </div>
        ))}

        {!allOk && (
          <div className="border-t border-border/50 pt-3 mt-3 text-[11px] text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Sık karşılaşılan sorunlar:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>
                <strong>401/403:</strong> Storefront token yanlış ya da rotate
                edilmiş. Headless → Storefront API → Özel Erişim Belirteci&apos;ni
                yeniden kopyala.
              </li>
              <li>
                <strong>0 ürün:</strong> Storefront API izinlerinde{" "}
                <code>unauthenticated_read_product_listings</code> + {" "}
                <code>unauthenticated_read_product_inventory</code> kapalı. İzinleri
                aç ve kaydet.
              </li>
              <li>
                <strong>404:</strong> Mağaza alan adı yanlış.{" "}
                <code>magaza.myshopify.com</code> formatında olmalı.
              </li>
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────── Hepsiburada Form ─────────────
const HepsiburadaSchema = z.object({
  merchantId: z.string().min(1, "merchantId gerekli"),
  secretKey: z.string().optional(),
  developerUsername: z.string().optional(),
  environment: z.enum(["test", "prod"]),
});
type HepsiburadaForm = z.infer<typeof HepsiburadaSchema>;

function HepsiburadaTab() {
  const qc = useQueryClient();
  const { data: settings } = useQuery<HepsiburadaPublicSettings>({
    queryKey: ["hepsiburada-settings"],
    queryFn: () => fetchJson("/api/hepsiburada/settings"),
  });

  const form = useForm<HepsiburadaForm>({
    resolver: zodResolver(HepsiburadaSchema),
    defaultValues: { merchantId: "", secretKey: "", developerUsername: "", environment: "test" },
    values: settings
      ? { merchantId: settings.merchantId, secretKey: "", developerUsername: settings.developerUsername, environment: settings.environment }
      : undefined,
  });
  const environment = useWatch({ control: form.control, name: "environment" });

  const save = useMutation({
    mutationFn: (data: HepsiburadaForm) =>
      fetchJson("/api/hepsiburada/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hepsiburada-settings"] });
      qc.invalidateQueries({ queryKey: ["integrations-status"] });
      toast.success("Hepsiburada ayarları kaydedildi");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [sample, setSample] = useState<unknown>(null);
  const test = useMutation({
    mutationFn: () => fetchJson<{ ok: boolean; environment?: "test" | "prod"; totalCount?: number; sample?: unknown }>("/api/hepsiburada/test", { method: "POST" }),
    onSuccess: (d) => {
      setSample(d.sample ?? null);
      const envLabel = d.environment === "prod" ? "Canlı" : "Test";
      const count = typeof d.totalCount === "number" ? ` · ${d.totalCount} ürün` : "";
      toast.success(`Hepsiburada bağlantısı başarılı (${envLabel})${count}`);
    },
    onError: (e: Error) => {
      setSample(null);
      toast.error(e.message);
    },
  });

  const sync = useMutation({
    mutationFn: (mode: "add-new" | "refresh-prices") =>
      fetchJson<{ linked?: number; unmatched?: number; checked?: number; changed?: number }>(
        "/api/hepsiburada/sync-products",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) }
      ),
    onSuccess: (d, mode) => {
      if (mode === "add-new") {
        toast.success(`Hepsiburada: ${d.linked ?? 0} ürün bağlandı, ${d.unmatched ?? 0} eşleşmemiş havuzda`);
      } else {
        toast.success(`Hepsiburada fiyatlar: ${d.changed ?? 0} değişti (${d.checked ?? 0} kontrol edildi)`);
      }
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Store className="h-4 w-4" /> Hepsiburada API
          </CardTitle>
          <p className="text-[11px] text-muted-foreground mt-1">
            Mağaza kimliği + gizli anahtar + geliştirici kullanıcı adı. Önce Test, onaylanınca Canlı.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={form.handleSubmit((d) => save.mutate(d))} className="space-y-3">
            <div>
              <Label className="text-xs">Ortam</Label>
              <div className="mt-1 grid grid-cols-2 gap-1 rounded-lg border bg-muted/30 p-1">
                {(["test", "prod"] as const).map((env) => (
                  <button
                    key={env}
                    type="button"
                    onClick={() => form.setValue("environment", env, { shouldDirty: true })}
                    className={cn(
                      "rounded-md py-1.5 text-xs font-medium transition-colors",
                      environment === env
                        ? env === "prod"
                          ? "bg-green-600 text-white shadow-sm"
                          : "bg-amber-500 text-white shadow-sm"
                        : "text-muted-foreground hover:bg-muted"
                    )}
                  >
                    {env === "test" ? "Test" : "Canlı"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs">Merchant ID (Mağaza ID)</Label>
              <Input {...form.register("merchantId")} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            </div>
            <div>
              <Label className="text-xs">Gizli Anahtar (Secret Key)</Label>
              <Input
                {...form.register("secretKey")}
                type="password"
                placeholder={settings?.hasSecretKey ? settings.secretKeyMasked : "Gizli anahtar"}
              />
            </div>
            <div>
              <Label className="text-xs">Geliştirici Kullanıcı Adı</Label>
              <Input {...form.register("developerUsername")} placeholder="örn. firmaadi_dev" />
            </div>
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? "Kaydediliyor…" : "Kaydet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
          <PlugZap className={`h-4 w-4 mr-2 ${test.isPending ? "animate-spin" : ""}`} />
          {test.isPending ? "Test ediliyor…" : "Bağlantıyı Test Et"}
        </Button>
        <Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate("add-new")}>
          <Plus className={`h-4 w-4 mr-2 ${sync.isPending && sync.variables === "add-new" ? "animate-spin" : ""}`} />
          {sync.isPending && sync.variables === "add-new" ? "Ekleniyor…" : "Yeni Ürün Ekle"}
        </Button>
      </div>
      <Button className="w-full" disabled={sync.isPending} onClick={() => sync.mutate("refresh-prices")}>
        <RefreshCw className={`h-4 w-4 mr-2 ${sync.isPending && sync.variables === "refresh-prices" ? "animate-spin" : ""}`} />
        {sync.isPending && sync.variables === "refresh-prices" ? "Fiyatlar güncelleniyor…" : "Fiyatları Güncelle"}
      </Button>

      {sample !== null && (
        <Card className="border-green-500/40 bg-green-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Test başarılı — dönen örnek</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-[10px] bg-muted/40 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all max-h-64">
              {JSON.stringify(sample, null, 2).slice(0, 4000)}
            </pre>
            <p className="text-[11px] text-muted-foreground mt-2">
              Bu örneği bana iletirsen ürün/sipariş alan adlarını birebir eşleyip senkronu kurarım.
            </p>
          </CardContent>
        </Card>
      )}

      <p className="text-[11px] text-muted-foreground">
        Önce kaydet + <strong>Bağlantıyı Test Et</strong>. Sonra <strong>Yeni Ürün Ekle</strong> →
        barkodu eşleşenler bağlanır, kalanlar <strong>Ürünler → &quot;Ürün Seç&quot;</strong> ile manuel
        eşleştirilir. <strong>Fiyatları Güncelle</strong> yalnızca eşleşmiş HB listing fiyatlarını tazeler.
      </p>

      {sync.isPending && <SyncProgressCard platform="Hepsiburada" />}
    </div>
  );
}

// ───────────── Ana Sayfa ─────────────
export default function ApiSettingsPage() {
  return (
    <div className="p-6 space-y-5 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Settings2 className="h-6 w-6" /> Platform API Ayarları
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Shopify ana ürün kaynağı; Trendyol + Hepsiburada satış kanalları — her birinin
          listing&apos;leri ana ürünlere bağlanır.
        </p>
      </div>

      <Tabs defaultValue="shopify">
        <TabsList>
          <TabsTrigger value="shopify">
            <ShoppingBag className="h-3.5 w-3.5 mr-1.5" /> Shopify
          </TabsTrigger>
          <TabsTrigger value="trendyol">
            <ShieldCheck className="h-3.5 w-3.5 mr-1.5" /> Trendyol
          </TabsTrigger>
          <TabsTrigger value="hepsiburada">
            <Store className="h-3.5 w-3.5 mr-1.5" /> Hepsiburada
          </TabsTrigger>
        </TabsList>

        <TabsContent value="shopify">
          <ShopifyTab />
        </TabsContent>
        <TabsContent value="trendyol">
          <TrendyolTab />
        </TabsContent>
        <TabsContent value="hepsiburada">
          <HepsiburadaTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
