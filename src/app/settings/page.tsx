"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import { Download, Upload, Database, Cloud, CloudOff, FileSpreadsheet, AlertTriangle, Settings as SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { ImageMobileFixCard } from "@/components/settings/ImageMobileFixCard";
import { R2StorageCard } from "@/components/settings/R2StorageCard";
import { BackupCard } from "@/components/settings/BackupCard";
import { NotificationSettingsCard } from "@/components/settings/NotificationSettingsCard";
import { fetchJson } from "@/lib/fetch-json";
import { DEFAULT_VAT_RATE, resolveVatRate } from "@/core/vat";
import { clearPricingQueryCache } from "@/lib/pricing-query-cache";

/** Boş KDV alanı %0 DEĞİL (kârlar ~%16,7 şişerdi) — "gerekli" hatası. */
const Schema = z.object({
  vatRate: z.preprocess(
    (v) => (v === "" || v == null ? undefined : typeof v === "string" ? v.replace(",", ".") : v),
    z.coerce.number({ message: "KDV oranı gir" }).min(0, "0 ile 100 arasında olmalı").max(100, "0 ile 100 arasında olmalı")
  ),
});

type FormData = z.infer<typeof Schema>;

export default function SettingsPage() {
  const queryClient = useQueryClient();

  const {
    data: settings,
    isLoading: ayarYukleniyor,
    isError: ayarHatasi,
    isFetching: ayarCekiliyor,
    refetch: ayarlariYenidenCek,
  } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetchJson("/api/settings"),
  });

  const form = useForm<FormData>({
    resolver: zodResolver(Schema) as unknown as Resolver<FormData>,
    defaultValues: { vatRate: 20 },
  });

  // Kayıtlı oran okunamıyorsa hesap varsayılana düşer; kullanıcı bunu BİLMELİ.
  const vat = resolveVatRate(settings);

  // Kayıtlı oran değişince forma yansır — kullanıcı yazıyorsa (kirli) ezilmez (eskiden R2 kaydı
  // ayarları tazeleyince yazılmış KDV kayboluyordu).
  useEffect(() => {
    if (settings && !form.formState.isDirty) {
      form.reset({ vatRate: vat.rate });
    }
  }, [settings, form, vat.rate]);

  const saveMutation = useMutation({
    mutationFn: (data: FormData) =>
      fetchJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vatRate: String(data.vatRate) }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-settings"] });
      clearPricingQueryCache(queryClient);
      toast.success("KDV oranı kaydedildi");
      form.reset(form.getValues());
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Kaydedilemedi"),
  });

  return (
    <div className="p-6 space-y-6 mx-auto w-full max-w-3xl">
      <header className="flex min-w-0 items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-500 motion-reduce:animate-none">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_12px_30px_-12px_rgba(122,126,255,0.9)]">
          <SettingsIcon className="size-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Ayarlar</h1>
          <p className="text-xs text-muted-foreground">Vergi, bildirimler, bulut depolama ve yedekler.</p>
        </div>
      </header>

      <ImageMobileFixCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Vergi (KDV)</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={form.handleSubmit((d) => saveMutation.mutate(d))}
            className="space-y-4"
          >
            <div>
              <Label>KDV Oranı (%)</Label>
              <Input
                type="number"
                step="1"
                min="0"
                max="100"
                disabled={!settings}
                {...form.register("vatRate")}
              />
              {form.formState.errors.vatRate?.message && (
                <p className="mt-1 text-xs font-medium text-rose-300">{String(form.formState.errors.vatRate.message)}</p>
              )}
              {ayarHatasi && !settings && (
                <p className="mt-2 flex items-center gap-2 text-xs text-rose-300">
                  Ayarlar alınamadı.
                  <button type="button" className="font-medium text-[#A9AEFF] hover:underline disabled:opacity-50" disabled={ayarCekiliyor} onClick={() => void ayarlariYenidenCek()}>
                    Tekrar dene
                  </button>
                </p>
              )}
              {settings && vat.invalid && (
                <p className="mt-2 flex items-start gap-2 rounded-xl bg-[#7A7EFF]/[0.07] p-2.5 text-xs text-[#E4E7FF] ring-1 ring-[#7A7EFF]/30 animate-in fade-in slide-in-from-bottom-1 duration-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  KDV oranı okunamadı, geçici olarak %{DEFAULT_VAT_RATE} kullanılıyor. Doğru
                  oranı girip kaydet.
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Satış fiyatları KDV dahil kabul edilir. Standart oran %20. Geçmiş siparişlerin kârı değişmez.
              </p>
            </div>

            <Button type="submit" disabled={saveMutation.isPending || !settings || ayarYukleniyor || !form.formState.isDirty}>
              {saveMutation.isPending ? "Kaydediliyor..." : "Kaydet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <TursoSyncCard />

      <R2StorageCard />

      <BackupCard />

      <DataManagementCard />

      <NotificationSettingsCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Uygulama Hakkında</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p className="text-foreground font-medium">Magicland 3D Hub</p>
          <p>
            Shopify (ana ürün kaynağı), Trendyol ve Hepsiburada fiyat & kâr yönetimi.
            Ürün maliyeti, paketleme, komisyon, kargo ve KDV&apos;den net kâr hesaplar.
          </p>
          <p>
            Veriler bu bilgisayarda ya da bulutta tutulabilir. Bulut senkron açıkken
            Windows ve Mac aynı veriyi paylaşır.
          </p>
          <p>
            Uygulama kendini otomatik günceller; ayarların ve verilerin korunur.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function DataManagementCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const queryClient = useQueryClient();

  async function handleImport(file: File) {
    setImporting(true);
    try {
      const text = await file.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("dosya okunamadı");
      }
      const result = await fetchJson<{
        stats: { products: number; listings: number; commissionRules: number; cargoRules: number; expenseRules: number };
        warnings?: unknown;
      }>("/api/data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const s = result.stats;
      const summary = `Yedek geri yüklendi: ${s.products} ürün, ${s.listings} ilan, ${s.commissionRules + s.cargoRules + s.expenseRules} kural`;
      const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
      if (warnings.length > 0) {
        toast.warning(`${summary}. ${warnings.join(" ")}`, { duration: 10_000 });
      } else {
        toast.success(summary);
      }
      // Global refetchOnMount kapalı olduğundan eski inaktif ekran cache'lerini bırakma.
      queryClient.removeQueries({ type: "inactive" });
      await queryClient.invalidateQueries({ type: "active" });
    } catch (e) {
      toast.error(`Yedek geri yüklenemedi: ${e instanceof Error ? e.message : "dosya okunamadı"}`);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Database className="h-4 w-4" /> Veri Yönetimi (Yedek / Geri Yükle)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Ürünlerini, maliyetlerini, kurallarını ve sipariş geçmişini tek dosyaya indirir.
          Baskı dosyalarının kendisi dahil değildir. Bağlantı şifreleri dosyaya yazılmaz.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <a
            href="/api/data/export"
            download
            className={cn(buttonVariants({ variant: "outline" }), "w-full justify-center")}
          >
            <Download className="h-4 w-4 mr-2" /> Yedeği İndir
          </a>
          <Button
            variant="outline"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-4 w-4 mr-2" />
            {importing ? "Yükleniyor..." : "Yedekten Yükle"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              // Geri yükleme mevcut ürün, maliyet, ayar ve sipariş finansını yedekteki değerlerle EZER.
              const tarih = new Date(file.lastModified).toLocaleString("tr-TR");
              if (
                window.confirm(
                  `"${file.name}" (${tarih}) yedeği geri yüklensin mi?\n\nMevcut ürünler, maliyetler, ayarlar ve sipariş kârları bu yedekteki değerlerle değiştirilir. Önce "Yedeği İndir" ile bugünkü hâlini saklaman önerilir.`
                )
              ) {
                handleImport(file);
              } else if (fileRef.current) {
                fileRef.current.value = "";
              }
            }}
          />
        </div>

        <div className="pt-3 border-t border-border/50">
          <p className="text-[11px] text-muted-foreground mb-2">
            Ürünleri tablo (CSV) olarak toplu içe/dışa aktarmak için:
          </p>
          <Link
            href="/import-export"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "w-full justify-center"
            )}
          >
            <FileSpreadsheet className="h-4 w-4 mr-2" /> CSV İçe / Dışa Aktarma
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

interface TursoPublicSettings {
  url: string;
  hasAuthToken: boolean;
  authTokenMasked: string;
  activeMode: "turso" | "local";
}

function TursoSyncCard() {
  const qc = useQueryClient();
  const { data } = useQuery<TursoPublicSettings>({
    queryKey: ["turso-settings"],
    queryFn: () => fetchJson("/api/turso/settings"),
  });

  const sourceUrl = data?.url ?? "";
  const [urlDraft, setUrlDraft] = useState({ source: "", value: "" });
  const url = urlDraft.source === sourceUrl ? urlDraft.value : sourceUrl;
  const setUrl = (value: string) => setUrlDraft({ source: sourceUrl, value });
  const [authToken, setAuthToken] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const save = useMutation({
    // fetchJson: sunucu reddederse "kaydedildi" denmesin (eskiden hata gövdesi başarı sayılıyordu).
    mutationFn: () =>
      fetchJson("/api/turso/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, authToken: authToken || undefined }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["turso-settings"] });
      setAuthToken("");
      toast.success("Bilgiler kaydedildi. Test edip uygulamayı yeniden başlat.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Kaydedilemedi"),
  });

  const test = useMutation({
    mutationFn: () =>
      fetchJson<{ ok: boolean; message: string }>("/api/turso/test", { method: "POST" }),
    onSuccess: (res) => {
      setTestResult(res);
      if (res.ok) toast.success("Bulut bağlantısı başarılı");
    },
    onError: (e: Error) => {
      setTestResult({ ok: false, message: e.message });
      toast.error(e.message);
    },
  });

  const disconnect = useMutation({
    mutationFn: () => fetchJson("/api/turso/settings", { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["turso-settings"] });
      setUrl("");
      setTestResult(null);
      toast.success("Bulut senkron kapatıldı. Yeniden başlatınca veriler bu bilgisayarda tutulur.");
    },
  });

  const activeMode = data?.activeMode ?? "local";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          {activeMode === "turso" ? (
            <Cloud className="h-4 w-4 text-emerald-500" />
          ) : (
            <CloudOff className="h-4 w-4 text-muted-foreground" />
          )}
          Cihazlar Arası Senkron
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className={cn(
            "text-xs rounded-md px-3 py-2 border",
            activeMode === "turso"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-muted/40 border-border text-muted-foreground"
          )}
        >
          {activeMode === "turso" ? (
            <>✓ <strong>Bulut senkron açık</strong> — Mac ve Windows aynı veriyi görüyor.</>
          ) : (
            <>Veriler şu an <strong>yalnızca bu bilgisayarda</strong> tutuluyor. Cihazlar arası senkron için aşağıdaki bilgileri gir.</>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground leading-relaxed">
          turso.tech&apos;te ücretsiz bir veritabanı aç, adresini ve erişim anahtarını buraya
          yapıştır. <u>Aynı bilgileri iki bilgisayara da gir.</u> Kaydedip{" "}
          <strong>Test Et</strong>, sonra uygulamayı yeniden başlat.
        </p>

        <div>
          <Label className="text-xs">Veritabanı Adresi</Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="libsql://magicland-hub-xxxx.turso.io"
          />
        </div>
        <div>
          <Label className="text-xs">Erişim Anahtarı</Label>
          <Input
            type="password"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder={data?.hasAuthToken ? data.authTokenMasked : "eyJ..."}
          />
          {data?.hasAuthToken && (
            <p className="text-[10px] text-muted-foreground mt-1">
              Anahtar kayıtlı. Değiştirmek istemiyorsan boş bırak.
            </p>
          )}
        </div>

        {testResult && (
          <div
            className={cn(
              "text-xs rounded-md px-3 py-2 border",
              testResult.ok
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                : "bg-destructive/10 border-destructive/30 text-destructive"
            )}
          >
            {testResult.ok ? "✓ " : "✗ "}
            {testResult.message}
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !url}>
            {save.isPending ? "..." : "Kaydet"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => test.mutate()}
            disabled={test.isPending}
          >
            {test.isPending ? "Test ediliyor…" : "Test Et"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            onClick={() => {
              if (confirm("Bulut senkron kapatılsın mı? Yeniden başlatınca veriler bu bilgisayarda tutulur."))
                disconnect.mutate();
            }}
            disabled={disconnect.isPending}
          >
            Kaldır
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
