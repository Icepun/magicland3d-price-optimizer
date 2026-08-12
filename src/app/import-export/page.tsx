"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Upload, Download, FileText, Check } from "lucide-react";
import { toast } from "sonner";
import Papa from "papaparse";

interface ImportResult {
  created: number;
  updated: number;
  errors: string[];
}

/** CSV başlıkları teknik; kullanıcıya NE anlama geldiklerini gösteriyoruz. */
const REQUIRED_COLUMNS = [
  { key: "barcode", label: "Barkod" },
  { key: "sku", label: "Stok kodu" },
  { key: "name", label: "Ürün adı" },
  { key: "category", label: "Kategori" },
  { key: "sale_price", label: "Satış fiyatı" },
];
const OPTIONAL_COLUMNS = [
  { key: "list_price", label: "Liste fiyatı" },
  { key: "stock", label: "Stok" },
  { key: "desi", label: "Desi" },
  { key: "weight", label: "Ağırlık" },
  { key: "product_cost", label: "Ürün maliyeti" },
  { key: "packaging_cost", label: "Paketleme maliyeti" },
];

function ColumnList({
  title,
  columns,
}: {
  title: string;
  columns: { key: string; label: string }[];
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {columns.map((c, i) => (
          <span
            key={c.key}
            className="inline-flex items-baseline gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-xs animate-in fade-in slide-in-from-bottom-1 duration-300"
            style={{ animationDelay: `${i * 40}ms`, animationFillMode: "both" }}
          >
            <span className="font-medium">{c.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{c.key}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ImportExportPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const queryClient = useQueryClient();

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      const rows = parsed.data as Record<string, string>[];
      if (rows.length === 0) throw new Error("Dosyada okunabilir satır yok.");

      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "products", rows }),
      });
      // res.ok KONTROLÜ ŞART: eskiden doğrudan res.json() dönülüyordu, sunucu 500 verse bile
      // "başarılı" sayılıp "undefined yeni, undefined güncelleme" bildirimi çıkıyor, ardından
      // sonuç kutusu undefined üzerinde okuma yapıp sayfayı hata ekranına düşürüyordu.
      if (!res.ok) throw new Error("Dosya işlenemedi. Kolon başlıklarını kontrol edip tekrar dene.");
      return (await res.json()) as ImportResult;
    },
    onSuccess: (data) => {
      setImportResult({
        created: data.created ?? 0,
        updated: data.updated ?? 0,
        errors: data.errors ?? [],
      });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success(
        `${data.created ?? 0} ürün eklendi, ${data.updated ?? 0} ürün güncellendi`
      );
    },
    onError: (e) => {
      setImportResult(null);
      toast.error(e instanceof Error ? e.message : "İçe aktarma tamamlanamadı.");
    },
  });

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">İçe / Dışa Aktarma</h1>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Import */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Upload className="h-4 w-4" /> Ürün İçe Aktar (CSV)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Dosyanın ilk satırı kolon başlıklarını içermeli.
              </p>
              <ColumnList title="Zorunlu" columns={REQUIRED_COLUMNS} />
              <ColumnList title="İsteğe bağlı" columns={OPTIONAL_COLUMNS} />
            </div>

            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importMutation.mutate(file);
                e.target.value = "";
              }}
            />

            <Button
              onClick={() => fileRef.current?.click()}
              disabled={importMutation.isPending}
              className="w-full"
              variant="outline"
            >
              <Upload className="h-4 w-4 mr-2" />
              {importMutation.isPending ? "İçe Aktarılıyor..." : "CSV Dosyası Seç"}
            </Button>

            {importResult && (
              <div className="space-y-2 rounded-lg border border-border/70 bg-muted/25 p-3 text-sm animate-in fade-in slide-in-from-bottom-2 duration-400">
                <p className="flex items-center gap-2 font-medium text-emerald-400">
                  <Check className="h-4 w-4 shrink-0" />
                  {importResult.created} ürün eklendi, {importResult.updated} ürün güncellendi
                </p>
                {importResult.errors.length > 0 && (
                  <div className="space-y-1 border-t border-border/60 pt-2">
                    <p className="text-destructive text-xs font-medium">
                      {importResult.errors.length} satır alınamadı
                    </p>
                    {importResult.errors.slice(0, 5).map((e, i) => (
                      <p key={i} className="text-xs text-muted-foreground">
                        {e}
                      </p>
                    ))}
                    {importResult.errors.length > 5 && (
                      <p className="text-xs text-muted-foreground/70">
                        ve {importResult.errors.length - 5} satır daha
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Export */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" /> Ürün Listesi İndir
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Tüm ürünleri maliyet bilgileriyle birlikte CSV olarak indirin.
              </p>
              <a
                href="/api/export?type=products"
                download
                className={cn(buttonVariants({ variant: "outline" }), "w-full justify-center")}
              >
                <Download className="h-4 w-4 mr-2" /> Ürünleri İndir
              </a>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* CSV Format Guide */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">CSV Format Örneği</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted p-3 rounded overflow-x-auto">
{`barcode,sku,name,category,sale_price,stock,desi,product_cost,packaging_cost
8680000000001,SKU-001,Gamepad Standı - Siyah,Gamepad Standı,399,50,1,85,8
8680000000002,SKU-002,PS5 Dualshock Standı,Gamepad Standı,299,30,0.8,65,7`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
