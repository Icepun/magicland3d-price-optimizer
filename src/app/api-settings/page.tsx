"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { baglantiDurumu, type BaglantiTonu } from "@/lib/baglanti-ozeti";
import { PlugZap, RefreshCw, ShieldCheck, ShoppingBag, Settings2, Plus, KeyRound, Store, Truck, CheckCircle2 } from "lucide-react";

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
    // Adres/durum kodu kullanıcıya hitap etmiyor → sade bir mesaja düş.
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : "İşlem tamamlanamadı";
    throw new Error(msg);
  }
  return body as T;
}

// ───────────── Trendyol Form ─────────────
const TrendyolSchema = z.object({
  sellerId: z.string().min(1, "Satıcı ID gerekli"),
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
      qc.invalidateQueries({ queryKey: ["integrations-status"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Trendyol ayarları kaydedildi");
      form.reset(form.getValues());
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const test = useMutation({
    mutationFn: () => fetchJson<{ fiyatOkunuyor?: boolean }>("/api/trendyol/test", { method: "POST" }),
    onSuccess: (r) =>
      r?.fiyatOkunuyor === false
        ? toast.warning("Bağlantı kuruldu ama fiyatlar okunamadı")
        : toast.success("Trendyol bağlantısı başarılı"),
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
        toast.success(`Trendyol: ${d.linked ?? 0} ürün bağlandı, ${d.unmatched ?? 0} ürün eşleşme bekliyor`);
      } else {
        toast.success(`Trendyol fiyatlar: ${d.changed ?? 0} değişti (${d.checked ?? 0} kontrol edildi)`);
      }
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Trendyol Bağlantısı
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={form.handleSubmit((d) => save.mutate(d))} className="space-y-3">
            <div>
              <Label className="text-xs">Satıcı ID</Label>
              <Input {...form.register("sellerId")} placeholder="123456" />
            </div>
            <div>
              <Label className="text-xs">API Anahtarı</Label>
              <Input
                {...form.register("apiKey")}
                type="password"
                placeholder={settings?.hasApiKey ? settings.apiKeyMasked : "Yeni anahtarı gir"}
              />
            </div>
            <div>
              <Label className="text-xs">API Gizli Anahtarı</Label>
              <Input
                {...form.register("apiSecret")}
                type="password"
                placeholder={settings?.hasApiSecret ? settings.apiSecretMasked : "Yeni gizli anahtarı gir"}
              />
            </div>
            <div>
              <Label className="text-xs">Entegratör Adı</Label>
              <Input {...form.register("integratorName")} />
            </div>
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? "Kaydediliyor…" : "Kaydet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        {/* Test KAYITLI bilgiyi dener: kaydedilmemiş değişiklik varken "başarılı" yanıltıcı olurdu. */}
        <Button
          variant="outline"
          disabled={test.isPending || form.formState.isDirty}
          title={form.formState.isDirty ? "Önce kaydet" : undefined}
          onClick={() => test.mutate()}
        >
          <PlugZap className="h-4 w-4 mr-2" />
          {test.isPending ? "Test ediliyor…" : form.formState.isDirty ? "Önce kaydet" : "Bağlantıyı Test Et"}
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
          {platform} ürünleri taranıyor. Mağaza büyüklüğüne göre birkaç dakika sürebilir.
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
      toast.success("Shopify bağlantısı kaldırıldı");
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

  // Yeni ürün ekleme artık Ürünler → "Shopify'dan Ekle" penceresinde (seçerek, adını vererek).
  // Buradaki toplu ekleme her eksik ürünü Shopify adıyla birden ekliyordu; kaldırıldı.
  const sync = useMutation({
    meta: { silent: true }, // kendi SyncProgressCard'ı var → global katman gösterme
    mutationFn: (mode: "refresh-prices") =>
      fetchJson<{ added?: number; checked?: number; changed?: number; totalProducts: number }>(
        "/api/shopify/sync-products",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        }
      ),
    onSuccess: (d) => {
      if (d.totalProducts === 0) {
        toast.error("Shopify mağazanda ürün bulunamadı — ürün okuma izinlerini kontrol et");
      } else {
        toast.success(`Shopify fiyatlar: ${d.changed ?? 0} değişti (${d.checked ?? 0} kontrol edildi)`);
      }
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ShoppingBag className="h-4 w-4" /> Shopify Bağlantısı
          </CardTitle>
          <p className="text-[11px] text-muted-foreground mt-1">
            Aşağıdaki adımları izleyerek mağazanı bağla.
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
              <Label className="text-xs">Ürün Erişim Anahtarı</Label>
              <Input
                {...form.register("storefrontAccessToken")}
                type="password"
                placeholder={
                  settings?.hasStorefrontAccessToken
                    ? settings.storefrontAccessTokenMasked
                    : "Erişim anahtarı"
                }
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                {settings?.hasStorefrontAccessToken
                  ? "Anahtar kayıtlı. Değiştirmek istemiyorsan boş bırak."
                  : `Shopify'da Headless → "Özel Erişim Belirteci" bölümünden kopyala.`}
              </p>
            </div>

            <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2.5">
              <Label className="text-xs flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5" /> Siparişler için (opsiyonel)
              </Label>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Siparişleri görebilmek için gerekir. Shopify uygulamanın{" "}
                <strong>Ayarlar → Kimlik bilgileri</strong> bölümündeki{" "}
                <strong>İstemci Kimliği</strong> ve <strong>Gizli anahtar</strong>&apos;ı gir;
                uygulamanın sipariş okuma izni açık olsun.
              </p>
              <div>
                <Label className="text-[11px] text-muted-foreground">İstemci Kimliği</Label>
                <Input {...form.register("clientId")} placeholder="örn. a6aa7fdbb1421cd9..." />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">Gizli Anahtar</Label>
                <Input
                  {...form.register("clientSecret")}
                  type="password"
                  placeholder={settings?.hasClientSecret ? settings.clientSecretMasked : "Gizli anahtar"}
                />
                {settings?.hasClientSecret && (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Gizli anahtar kayıtlı. Değiştirmeyeceksen boş bırak.
                  </p>
                )}
              </div>
            </div>

            <div>
              <Label className="text-xs">Bağlantı Sürümü (opsiyonel)</Label>
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
                ✓ Mağaza bağlı
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {settings.shopDomain}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={disconnect.isPending}
              onClick={() => {
                if (confirm("Kayıtlı erişim anahtarı silinsin mi? Yeniden girmen gerekir.")) {
                  disconnect.mutate();
                }
              }}
            >
              {disconnect.isPending ? "Siliniyor…" : "Bağlantıyı Sıfırla"}
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
        {settings?.hasStorefrontAccessToken ? (
          <Link href="/products?ekle=shopify" className={buttonVariants({ variant: "outline" })}>
            <Plus className="h-4 w-4 mr-2" />
            Shopify&apos;dan Ürün Ekle
          </Link>
        ) : (
          <Button variant="outline" disabled>
            <Plus className="h-4 w-4 mr-2" />
            Shopify&apos;dan Ürün Ekle
          </Button>
        )}
      </div>
      <Button
        className="w-full"
        disabled={sync.isPending || !settings?.hasStorefrontAccessToken}
        onClick={() => sync.mutate("refresh-prices")}
      >
        <RefreshCw className={`h-4 w-4 mr-2 ${sync.isPending ? "animate-spin" : ""}`} />
        {sync.isPending ? "Fiyatlar güncelleniyor…" : "Fiyatları Güncelle"}
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
        🔑 Erişim anahtarı nasıl alınır?
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
          mağaza vitrinini seç → izinler sekmesine geç
        </li>
        <li>
          <strong className="text-foreground">İzinler</strong> kartında{" "}
          <strong className="text-foreground">ürün listesi</strong> ve{" "}
          <strong className="text-foreground">stok okuma</strong> izinlerini aç (kalem ikonuyla düzenle)
        </li>
        <li>
          <strong className="text-foreground">Özel Erişim Belirteci</strong>{" "}
          kartında göz 👁 ikonuyla anahtarı görünür kıl → kopyala
        </li>
        <li>
          Aşağıdaki <strong className="text-foreground">Ürün Erişim Anahtarı</strong>{" "}
          alanına yapıştır → <strong className="text-foreground">Kaydet</strong>
        </li>
        <li>
          <strong className="text-foreground">Bağlantıyı Test Et</strong> → iki
          ✓ yeşil görmelisin → sonra <strong className="text-foreground">Shopify&apos;dan Ürün Ekle</strong>
        </li>
      </ol>
      <div className="px-3 pb-3 pt-1 text-[10px] text-muted-foreground">
        <strong>Not:</strong> Yalnızca mağazanda yayında olan ürünler gelir.
      </div>
    </details>
  );
}

function ShopifyDebugCard({ result }: { result: ShopifyDebugResult }) {
  const allOk = result.steps.every((s) => s.status === "ok");
  const okCount = result.steps.filter((s) => s.status === "ok").length;
  return (
    <Card className={allOk ? "border-green-500/40 bg-green-500/5" : "border-[#7A7EFF]/35 bg-[#7A7EFF]/[0.06]"}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">
          {allOk ? "Bağlantı çalışıyor" : "Bağlantı kurulamadı"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <p className="text-muted-foreground tabular-nums">
          {okCount} / {result.steps.length} adım tamam
        </p>
        {result.steps.map((step, i) => (
          <div
            key={i}
            className="space-y-1 animate-in fade-in slide-in-from-left-1 duration-300"
            style={{ animationDelay: `${i * 60}ms`, animationFillMode: "both" }}
          >
            <span className="font-semibold flex items-center gap-1.5">
              <span className={step.status === "ok" ? "text-emerald-500" : "text-[#C9D2F2]"}>
                {step.status === "ok" ? "✓" : "✗"}
              </span>
              {step.name}
            </span>
            <p className={step.status === "ok" ? "text-muted-foreground" : "text-[#C9D2F2]"}>
              {step.detail}
            </p>
            {/* Ham yanıt ARTIK GİZLİ. Eskiden durum kodu ve JSON gövdesi doğrudan ekrana
                dökülüyordu — kullanıcıya hitap etmiyor. Sorun ayıklamak gerektiğinde açılıyor. */}
            {step.responseBody !== undefined && step.status !== "ok" && (
              <details className="group">
                <summary className="cursor-pointer select-none text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors">
                  Teknik ayrıntı
                </summary>
                <pre className="mt-1 text-[10px] bg-muted/40 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                  {step.responseStatus ? `HTTP ${step.responseStatus}\n` : ""}
                  {typeof step.responseBody === "string"
                    ? step.responseBody
                    : JSON.stringify(step.responseBody, null, 2)}
                </pre>
              </details>
            )}
          </div>
        ))}

        {!allOk && (
          <div className="border-t border-border/50 pt-3 mt-3 text-[11px] text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Bunları dene:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Erişim anahtarını Shopify&apos;dan yeniden kopyalayıp kaydet.</li>
              <li>Shopify&apos;da ürün listesi ve stok okuma izinlerini aç.</li>
              <li>
                Mağaza alan adını kontrol et — <code>magaza.myshopify.com</code>{" "}
                biçiminde olmalı.
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
  merchantId: z.string().min(1, "Mağaza kimliği gerekli"),
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
        toast.success(`Hepsiburada: ${d.linked ?? 0} ürün bağlandı, ${d.unmatched ?? 0} ürün eşleşme bekliyor`);
      } else {
        toast.success(`Hepsiburada fiyatlar: ${d.changed ?? 0} değişti (${d.checked ?? 0} kontrol edildi)`);
      }
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Store className="h-4 w-4" /> Hepsiburada Bağlantısı
          </CardTitle>
          <p className="text-[11px] text-muted-foreground mt-1">
            Önce Test ortamında dene, çalışınca Canlı&apos;ya geç.
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
                          ? "bg-emerald-600 text-white shadow-sm"
                          : "bg-[#7A7EFF] text-white shadow-sm"
                        : "text-muted-foreground hover:bg-muted"
                    )}
                  >
                    {env === "test" ? "Test" : "Canlı"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs">Mağaza Kimliği</Label>
              <Input {...form.register("merchantId")} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            </div>
            <div>
              <Label className="text-xs">Gizli Anahtar</Label>
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
        <Card className="border-green-500/40 bg-green-500/5 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Test başarılı — mağazaya ulaşıldı</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-[11px] text-muted-foreground">
              Şimdi <strong>Yeni Ürün Ekle</strong> ile ürünlerini bağlayabilirsin.
            </p>
            {/* Ham yanıt kullanıcıya hitap etmiyor → yalnız gerektiğinde açılır. */}
            <details className="group mt-2">
              <summary className="cursor-pointer select-none text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors">
                Teknik ayrıntı
              </summary>
              <pre className="mt-1 text-[10px] bg-muted/40 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all max-h-64">
                {JSON.stringify(sample, null, 2).slice(0, 4000)}
              </pre>
            </details>
          </CardContent>
        </Card>
      )}

      <p className="text-[11px] text-muted-foreground">
        Önce kaydet + <strong>Bağlantıyı Test Et</strong>. Sonra <strong>Yeni Ürün Ekle</strong> →
        barkodu eşleşenler bağlanır, kalanlar <strong>Ürünler → &quot;Ürün Seç&quot;</strong> ile elle
        eşleştirilir. <strong>Fiyatları Güncelle</strong> yalnızca eşleşmiş ilanların fiyatını tazeler.
      </p>

      {sync.isPending && <SyncProgressCard platform="Hepsiburada" />}
    </div>
  );
}

// ───────────── HepsiJet (kargo) ─────────────
interface HepsijetAcikAyarlar {
  ortam: "test" | "prod";
  test: { kullaniciAdi: string; sifreVar: boolean };
  prod: { kullaniciAdi: string; sifreVar: boolean };
}

function HepsijetTab() {
  const qc = useQueryClient();
  const { data: ayarlar } = useQuery<HepsijetAcikAyarlar>({
    queryKey: ["hepsijet-settings"],
    queryFn: () => fetchJson("/api/hepsijet/settings"),
  });
  // Seçim yapılana kadar kayıtlı ortam; test ve canlının bilgileri ayrı tutulur.
  const [secilenOrtam, setSecilenOrtam] = useState<"test" | "prod" | null>(null);
  const ortam = secilenOrtam ?? ayarlar?.ortam ?? "test";
  const kayitli = ayarlar?.[ortam];
  // Yazılanlar ortama bağlıdır: ortam değişince öbür ortamın taslağı görünmez.
  const [taslak, setTaslak] = useState<{ ortam: string; kullaniciAdi: string | null; sifre: string }>({
    ortam: "", kullaniciAdi: null, sifre: "",
  });
  const buTaslak = taslak.ortam === ortam ? taslak : { ortam, kullaniciAdi: null, sifre: "" };
  const kullaniciAdi = buTaslak.kullaniciAdi ?? kayitli?.kullaniciAdi ?? "";
  const sifre = buTaslak.sifre;
  const [sonuc, setSonuc] = useState<{ ortam: "test" | "prod"; sirket: string | null; sube: string | null } | null>(null);

  const kaydet = useMutation({
    mutationFn: () =>
      fetchJson<HepsijetAcikAyarlar>("/api/hepsijet/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ortam, kullaniciAdi, sifre: sifre || undefined }),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["hepsijet-settings"], d);
      setTaslak({ ortam: "", kullaniciAdi: null, sifre: "" });
      setSecilenOrtam(null);
      setSonuc(null);
      toast.success("HepsiJet bilgileri kaydedildi");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dene = useMutation({
    mutationFn: () =>
      fetchJson<{ ok: boolean; ortam: "test" | "prod"; sirket: string | null; sube: string | null }>(
        "/api/hepsijet/test",
        { method: "POST" }
      ),
    onSuccess: (d) => {
      setSonuc({ ortam: d.ortam, sirket: d.sirket, sube: d.sube });
      toast.success("HepsiJet bağlantısı çalışıyor");
    },
    onError: (e: Error) => {
      setSonuc(null);
      toast.error(e.message);
    },
  });

  const kaydedilmemis =
    ortam !== ayarlar?.ortam || kullaniciAdi !== (kayitli?.kullaniciAdi ?? "") || sifre !== "";
  const denenebilir = !kaydedilmemis && !!kayitli?.kullaniciAdi && !!kayitli.sifreVar;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Truck className="h-4 w-4" /> HepsiJet Bağlantısı
          </CardTitle>
          <p className="text-[11px] text-muted-foreground mt-1">
            HepsiJet&apos;in gönderdiği kullanıcı adı ve şifreyi gir. Şifre yalnız bu bilgisayarda saklanır.
          </p>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              kaydet.mutate();
            }}
            className="space-y-3"
          >
            <div>
              <Label className="text-xs">Ortam</Label>
              <div className="mt-1 grid grid-cols-2 gap-1 rounded-lg border bg-muted/30 p-1">
                {(["test", "prod"] as const).map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => {
                      setSecilenOrtam(o);
                      setSonuc(null);
                    }}
                    className={cn(
                      "rounded-md py-1.5 text-xs font-medium transition-all duration-200 active:scale-[0.98]",
                      ortam === o
                        ? o === "prod"
                          ? "bg-green-600 text-white shadow-sm"
                          : "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-muted"
                    )}
                  >
                    {o === "test" ? "Test" : "Canlı"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs">Kullanıcı Adı</Label>
              <Input
                value={kullaniciAdi}
                onChange={(e) => setTaslak({ ortam, kullaniciAdi: e.target.value, sifre })}
                autoComplete="off"
                placeholder="HepsiJet kullanıcı adı"
              />
            </div>
            <div>
              <Label className="text-xs">Şifre</Label>
              <Input
                type="password"
                value={sifre}
                onChange={(e) => setTaslak({ ortam, kullaniciAdi: buTaslak.kullaniciAdi, sifre: e.target.value })}
                autoComplete="new-password"
                placeholder={kayitli?.sifreVar ? "•••••••• (kayıtlı)" : "HepsiJet şifresi"}
              />
            </div>
            <Button type="submit" size="sm" disabled={kaydet.isPending || !kullaniciAdi.trim() || !kaydedilmemis}>
              {kaydet.isPending ? "Kaydediliyor…" : "Kaydet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Button
        variant="outline"
        className="w-full"
        disabled={dene.isPending || !denenebilir}
        onClick={() => dene.mutate()}
      >
        <PlugZap className={`h-4 w-4 mr-2 ${dene.isPending ? "animate-spin" : ""}`} />
        {dene.isPending ? "Deneniyor…" : "Bağlantıyı Dene"}
      </Button>

      {sonuc && (
        <Card className="border-green-500/40 bg-green-500/5 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <CardContent className="flex items-start gap-3 py-4">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500 animate-in zoom-in-50 duration-300" />
            <div className="min-w-0 text-sm">
              <p className="font-semibold">Bağlandı{sonuc.ortam === "test" ? " (test ortamı)" : ""}</p>
              {(sonuc.sirket || sonuc.sube) && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {[sonuc.sirket, sonuc.sube ? `Şube: ${sonuc.sube}` : null].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ───────────── Ana Sayfa ─────────────
export default function ApiSettingsPage() {
  return (
    <div className="p-6 space-y-5 max-w-3xl">
      <header className="flex min-w-0 items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-500 motion-reduce:animate-none">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_12px_30px_-12px_rgba(122,126,255,0.9)]">
          <Settings2 className="size-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Platform Bağlantıları</h1>
          <p className="text-xs text-muted-foreground">
            Shopify ana ürün kaynağın; Trendyol ve Hepsiburada ilanları ana ürünlere bağlanır.
          </p>
        </div>
      </header>

      <BaglantiOzetiKarti />

      <Tabs defaultValue="shopify">
        <TabsList className="h-auto gap-0.5 rounded-xl bg-white/[0.03] p-0.5 ring-1 ring-white/[0.08]">
          <TabsTrigger value="shopify">
            <ShoppingBag className="h-3.5 w-3.5 mr-1.5" /> Shopify
          </TabsTrigger>
          <TabsTrigger value="trendyol">
            <ShieldCheck className="h-3.5 w-3.5 mr-1.5" /> Trendyol
          </TabsTrigger>
          <TabsTrigger value="hepsiburada">
            <Store className="h-3.5 w-3.5 mr-1.5" /> Hepsiburada
          </TabsTrigger>
          <TabsTrigger value="hepsijet">
            <Truck className="h-3.5 w-3.5 mr-1.5" /> HepsiJet
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
        <TabsContent value="hepsijet">
          <HepsijetTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const OZET_PLATFORMLARI = [
  { anahtar: "shopify", ad: "Shopify" },
  { anahtar: "trendyol", ad: "Trendyol" },
  { anahtar: "hepsiburada", ad: "Hepsiburada" },
] as const;

const TON_SINIFI: Record<BaglantiTonu, string> = {
  iyi: "ring-emerald-400/25 bg-emerald-500/[0.04]",
  uyari: "ring-[#7A7EFF]/30 bg-[#7A7EFF]/[0.05]",
  hata: "ring-rose-400/30 bg-rose-500/[0.05]",
  kapali: "ring-white/[0.08] bg-white/[0.02]",
};
const PLATFORM_NOKTASI: Record<string, string> = { shopify: "#34D399", trendyol: "#F27A1A", hepsiburada: "#4F8CFF" };

/** Üç platformun durumu tek bakışta: bağlı mı, siparişler geliyor mu, fiyatlar ne zaman eşitlendi. */
function BaglantiOzetiKarti() {
  const [simdi] = useState(() => Date.now());
  const durum = useQuery<Record<string, boolean>>({
    queryKey: ["integrations-status"],
    queryFn: () => fetchJson("/api/integrations/status"),
    staleTime: 60_000,
  });
  const ayarlar = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetchJson("/api/settings"),
  });
  const siparis = useQuery<Record<string, { ok?: boolean; count?: number; needsAdminToken?: boolean; notConfigured?: boolean } | undefined>>({
    queryKey: ["orders"],
    queryFn: ({ signal }) => fetchJson("/api/orders", { signal }),
    staleTime: 5 * 60_000,
  });
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {OZET_PLATFORMLARI.map((p) => {
        const d = baglantiDurumu({
          bagli: durum.data?.[p.anahtar],
          siparis: siparis.data?.[p.anahtar],
          sonEsitlemeIso: ayarlar.data?.[`${p.anahtar}LastSyncAt`],
          nowMs: simdi,
        });
        return (
          <div
            key={p.anahtar}
            className={cn("rounded-2xl px-3 py-2.5 text-sm ring-1 transition-colors animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500", TON_SINIFI[d.ton])}
          >
            <p className="flex items-center gap-2 font-medium">
              <span className="size-1.5 rounded-full" style={{ background: PLATFORM_NOKTASI[p.anahtar] }} />
              {p.ad}
            </p>
            {durum.isLoading ? (
              <p className="text-xs text-muted-foreground">…</p>
            ) : durum.isError && !durum.data ? (
              // Okunamadı ≠ bağlı değil: kullanıcı doğru anahtarı yeniden girip ezmeye yönelmesin.
              <p className="text-xs text-rose-300">
                Durum alınamadı ·{" "}
                <button type="button" className="font-medium text-[#A9AEFF] hover:underline" onClick={() => void durum.refetch()}>
                  Tekrar dene
                </button>
              </p>
            ) : !d.bagli ? (
              <p className="text-xs text-muted-foreground">Bağlı değil</p>
            ) : (
              <>
                <p className={cn("text-xs", d.ton === "hata" ? "text-rose-300" : "text-muted-foreground")}>
                  {d.siparisMetni ?? (siparis.isError ? "Siparişler alınamadı" : "Siparişler okunuyor…")}
                </p>
                <p className={cn("text-xs", d.ton === "uyari" ? "text-[#C9D2F2]" : "text-muted-foreground")}>
                  {d.esitlemeGun == null
                    ? "Fiyatlar hiç eşitlenmedi"
                    : d.esitlemeGun === 0
                      ? "Fiyatlar bugün eşitlendi"
                      : `Fiyatlar ${d.esitlemeGun} gün önce eşitlendi`}
                </p>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
