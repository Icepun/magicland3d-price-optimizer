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
import { Download, Upload, Database, Cloud, CloudOff } from "lucide-react";
import { cn } from "@/lib/utils";

const Schema = z.object({
  defaultMinNetProfit: z.coerce.number().min(0).default(0),
  defaultMinMargin: z.coerce.number().min(0).max(100).default(0),
  vatRate: z.coerce.number().min(0).max(100).default(20),
  discountBuffer: z.coerce.number().min(0).max(50).default(0),
});

type FormData = z.infer<typeof Schema>;

export default function SettingsPage() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery<Record<string, string>>({
    queryKey: ["settings"],
    queryFn: () => fetch("/api/settings").then((r) => r.json()),
  });

  const form = useForm<FormData>({
    resolver: zodResolver(Schema),
    defaultValues: {
      defaultMinNetProfit: 0,
      defaultMinMargin: 0,
      vatRate: 20,
      discountBuffer: 0,
    },
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        defaultMinNetProfit: Number(settings.defaultMinNetProfit ?? 0),
        defaultMinMargin: Number(settings.defaultMinMargin ?? 0) * 100,
        vatRate: Number(settings.vatRate ?? 20),
        discountBuffer: Number(settings.discountBuffer ?? 0),
      });
    }
  }, [settings, form]);

  const saveMutation = useMutation({
    mutationFn: (data: FormData) =>
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultMinNetProfit: String(data.defaultMinNetProfit),
          defaultMinMargin: String(data.defaultMinMargin / 100),
          vatRate: String(data.vatRate),
          discountBuffer: String(data.discountBuffer),
        }),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["app-settings"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["product-profit"] });
      queryClient.invalidateQueries({ queryKey: ["profit-preview"] });
      toast.success("Ayarlar kaydedildi — tüm ürünlere uygulandı");
    },
    onError: () => toast.error("Kaydedilemedi"),
  });

  return (
    <div className="p-6 space-y-6 max-w-xl">
      <h1 className="text-2xl font-bold">Ayarlar</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Minimum Kâr Eşikleri</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={form.handleSubmit((d) => saveMutation.mutate(d))}
            className="space-y-4"
          >
            <div>
              <Label>Minimum Net Kâr (TL)</Label>
              <Input
                type="number"
                step="1"
                {...form.register("defaultMinNetProfit")}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Bu değerin altındaki kâra sahip fiyatlar simülasyonda &quot;geçersiz&quot; sayılır.
              </p>
            </div>
            <div>
              <Label>Minimum Kâr Oranı (%)</Label>
              <Input
                type="number"
                step="0.5"
                {...form.register("defaultMinMargin")}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Örnek: 20 girerseniz kâr oranı %20&apos;nin altındaki fiyatlar elenir.
              </p>
            </div>

            <div className="border-t border-border/50 pt-4">
              <Label>Trendyol İndirim Payı (%)</Label>
              <Input
                type="number"
                step="1"
                min="0"
                max="50"
                {...form.register("discountBuffer")}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Trendyol kampanyaları sırasında listed fiyat üzerinden indirim uygulanır.
                Bu pay, &quot;kampanya inse bile kâr garantisi&quot; bırakır.
                Önerilen fiyat <strong>%10 indirim sonrasına</strong> göre hesaplanır;
                yani Trendyol %10 indirim uyguladığında bile minimum kâr korunur.
                Sıfır girersen indirim payı yok (tam fiyatla satış varsayılır).
              </p>
            </div>

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
                Trendyol&apos;da girilen satış fiyatı KDV dahil sayılır. Net kâr,
                fiyatın <code className="text-foreground">/(1 + KDV/100)</code> ile bölünmüş
                KDV hariç bazından hesaplanır. Türkiye&apos;de standart oran <strong>%20</strong>.
                <br />
                Sıfır girerseniz KDV uygulanmaz (eski davranış).
              </p>
            </div>

            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Kaydediliyor..." : "Kaydet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <TursoSyncCard />

      <DataManagementCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Uygulama Hakkında</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          <p>Magicland 3D Hub</p>
          <p className="mt-2">
            Veritabanı: SQLite (lokal). Otomatik güncelleme: GitHub Releases.
            Veri update sırasında userData klasöründe korunur.
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
      toast.success(
        `Veri içe aktarıldı: ${s.products} ürün, ${s.listings} listing, ${s.commissionRules + s.cargoRules + s.expenseRules} kural`
      );
      queryClient.invalidateQueries();
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
          Tüm verilerini (ürünler, listings, maliyet, kurallar, fiyat geçmişi) JSON
          olarak indir. Update ya da yeniden kurulum sırasında geri yüklemek için
          kullanabilirsin. Otomatik günlük backup zaten alınıyor (electron tarafı),
          bu manuel kontrol içindir.
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
          Kaydedip <strong>Test Et</strong>, sonra uygulamayı yeniden başlat.
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
