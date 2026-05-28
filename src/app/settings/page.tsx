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
import { Download, Upload, Database } from "lucide-react";
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
