"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import { Download, Upload, Database, Cloud, CloudOff, FileSpreadsheet } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { ImageMobileFixCard } from "@/components/settings/ImageMobileFixCard";
import { R2StorageCard } from "@/components/settings/R2StorageCard";
import { fetchJson } from "@/lib/fetch-json";
import { clearPricingQueryCache } from "@/lib/pricing-query-cache";

const Schema = z.object({
  vatRate: z.coerce.number().min(0).max(100).default(20),
});

type FormData = z.infer<typeof Schema>;

export default function SettingsPage() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery<Record<string, string>>({
    queryKey: ["settings"],
    queryFn: () => fetchJson("/api/settings"),
  });

  const form = useForm<FormData>({
    resolver: zodResolver(Schema),
    defaultValues: { vatRate: 20 },
  });

  useEffect(() => {
    if (settings) {
      form.reset({ vatRate: Number(settings.vatRate ?? 20) });
    }
  }, [settings, form]);

  const saveMutation = useMutation({
    mutationFn: (data: FormData) =>
      fetchJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vatRate: String(data.vatRate) }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["app-settings"] });
      clearPricingQueryCache(queryClient);
      toast.success("Ayarlar kaydedildi — tüm ürünlere uygulandı");
    },
    onError: () => toast.error("Kaydedilemedi"),
  });

  return (
    <div className="p-6 space-y-6 max-w-xl">
      <h1 className="text-2xl font-bold">Ayarlar</h1>

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
                {...form.register("vatRate")}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Satış fiyatları KDV <strong>dahil</strong> kabul edilir. Net kâr,
                fiyatın{" "}<code className="text-foreground">/(1 + KDV/100)</code>{" "}ile
                KDV hariç bazından hesaplanır. Türkiye&apos;de standart oran <strong>%20</strong>.
                Sıfır girerseniz KDV uygulanmaz.
              </p>
            </div>

            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Kaydediliyor..." : "Kaydet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <TursoSyncCard />

      <R2StorageCard />

      <DataManagementCard />

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
            Veritabanı yerel SQLite veya Turso bulut (libSQL) olarak çalışabilir. Turso
            bağlıysa Windows ve Mac aynı veriyi paylaşır; bağlantı durumu yukarıdaki kartta gösterilir.
          </p>
          <p>
            Otomatik güncelleme GitHub Releases üzerinden (Windows + Mac). Ayarlar
            ve veriler güncelleme sırasında korunur.
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
      const data = JSON.parse(text);
      const res = await fetch("/api/data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error ?? "Import başarısız");
      }
      const s = result.stats;
      const summary = `Veri içe aktarıldı: ${s.products} ürün, ${s.listings} listing, ${s.commissionRules + s.cargoRules + s.expenseRules} kural`;
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
      toast.error(`İçe aktarma hatası: ${e instanceof Error ? e.message : "bilinmiyor"}`);
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
          Taşınabilir verilerini (ürünler, listingler, maliyetler, kurallar, fiyat geçmişi,
          makaralar ve yazıcı ayarları) JSON olarak indir. Yerel model dosyalarının fiziksel
          baytları dahil değildir; R2 model referansları korunur. Dosya bağlantı/API ayarlarını
          da içerebildiği için yedeği güvenli sakla. Otomatik günlük yedek ayrıca Electron
          tarafında alınır.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <a
            href="/api/data/export"
            download
            className={cn(buttonVariants({ variant: "outline" }), "w-full justify-center")}
          >
            <Download className="h-4 w-4 mr-2" /> JSON Dışa Aktar
          </a>
          <Button
            variant="outline"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-4 w-4 mr-2" />
            {importing ? "İçe Aktarılıyor..." : "JSON İçe Aktar"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImport(file);
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
    queryFn: () => fetch("/api/turso/settings").then((r) => r.json()),
  });

  const [url, setUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (data) setUrl(data.url || "");
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      fetch("/api/turso/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, authToken: authToken || undefined }),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["turso-settings"] });
      setAuthToken("");
      toast.success("Turso bilgileri kaydedildi. Test edip uygulamayı yeniden başlat.");
    },
    onError: () => toast.error("Kaydedilemedi"),
  });

  const test = useMutation({
    mutationFn: () =>
      fetch("/api/turso/test", { method: "POST" }).then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? "Test başarısız");
        return body as { ok: boolean; message: string };
      }),
    onSuccess: (res) => {
      setTestResult(res);
      if (res.ok) toast.success("Turso bağlantısı başarılı");
    },
    onError: (e: Error) => {
      setTestResult({ ok: false, message: e.message });
      toast.error(e.message);
    },
  });

  const disconnect = useMutation({
    mutationFn: () => fetch("/api/turso/settings", { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["turso-settings"] });
      setUrl("");
      setTestResult(null);
      toast.success("Turso bağlantısı kaldırıldı. Yeniden başlatınca local DB'ye döner.");
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
          Veritabanı / Çoklu Cihaz Senkron (Turso)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className={cn(
            "text-xs rounded-md px-3 py-2 border",
            activeMode === "turso"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
              : "bg-muted/40 border-border text-muted-foreground"
          )}
        >
          {activeMode === "turso" ? (
            <>✓ Şu an <strong>bulut DB (Turso)</strong> aktif — Mac ve Windows aynı veriyi görür.</>
          ) : (
            <>Şu an <strong>local veritabanı</strong> kullanılıyor (bu makineye özel). Bulut senkron için aşağıya Turso bilgilerini gir.</>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground leading-relaxed">
          turso.tech&apos;te ücretsiz veritabanı aç → <strong>Database URL</strong> ve
          <strong> Auth Token</strong>&apos;ı buraya gir. <u>Aynı bilgileri iki makineye de gir.</u>
          {" "}Kaydedip <strong>Test Et</strong>, sonra uygulamayı yeniden başlat.
        </p>

        <div>
          <Label className="text-xs">Database URL</Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="libsql://magicland-hub-xxxx.turso.io"
          />
        </div>
        <div>
          <Label className="text-xs">Auth Token</Label>
          <Input
            type="password"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder={data?.hasAuthToken ? data.authTokenMasked : "eyJ..."}
          />
          {data?.hasAuthToken && (
            <p className="text-[10px] text-muted-foreground mt-1">
              Token kayıtlı. Değiştirmek istemiyorsan boş bırak.
            </p>
          )}
        </div>

        {testResult && (
          <div
            className={cn(
              "text-xs rounded-md px-3 py-2 border",
              testResult.ok
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
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
              if (confirm("Turso bağlantısı kaldırılsın mı? Yeniden başlatınca local DB'ye döner."))
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
