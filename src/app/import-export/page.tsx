"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Upload, Download, FileText } from "lucide-react";
import { toast } from "sonner";
import Papa from "papaparse";

export default function ImportExportPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<{
    created: number;
    updated: number;
    errors: string[];
  } | null>(null);
  const queryClient = useQueryClient();

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      const rows = parsed.data as Record<string, string>[];

      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "products", rows }),
      });
      return res.json();
    },
    onSuccess: (data) => {
      setImportResult(data);
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success(`${data.created} yeni, ${data.updated} güncelleme`);
    },
    onError: () => toast.error("İçe aktarma başarısız"),
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
            <p className="text-sm text-muted-foreground">
              CSV dosyası şu kolonları içermelidir:{" "}
              <code className="text-xs bg-muted px-1 rounded">
                barcode, sku, name, category, sale_price
              </code>
              <br />
              Opsiyonel:{" "}
              <code className="text-xs bg-muted px-1 rounded">
                list_price, stock, desi, weight, product_cost, packaging_cost
              </code>
            </p>

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
              <div className="text-sm space-y-1">
                <p className="text-green-600">
                  ✓ {importResult.created} ürün eklendi, {importResult.updated} güncellendi
                </p>
                {importResult.errors.length > 0 && (
                  <div>
                    <p className="text-destructive">{importResult.errors.length} hata:</p>
                    {importResult.errors.slice(0, 5).map((e, i) => (
                      <p key={i} className="text-xs text-muted-foreground">{e}</p>
                    ))}
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
                <Download className="h-4 w-4" /> Öneri Raporu İndir
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Tüm önerileri CSV olarak indirin. Mevcut ve önerilen fiyat, kâr farkı ve gerekçe dahildir.
              </p>
              <a
                href="/api/export?type=recommendations"
                download
                className={cn(buttonVariants({ variant: "outline" }), "w-full justify-center")}
              >
                <Download className="h-4 w-4 mr-2" /> Önerileri İndir
              </a>
            </CardContent>
          </Card>

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
