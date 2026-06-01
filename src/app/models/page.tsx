"use client";
/* eslint-disable @next/next/no-img-element */

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Boxes, Search, Package, Play, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface LibPrinter { id: string; name: string; brand: string; type: string }
interface LibFile { id: string; printerConfigId: string; originalName: string; sizeBytes: number; gramaj: number | null; fileType: string }
interface LibProduct { productId: string; name: string; imageUrl: string | null; files: LibFile[] }

export default function ModelsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ products: LibProduct[]; printers: LibPrinter[] }>({
    queryKey: ["models"],
    queryFn: () => fetch("/api/models").then((r) => r.json()),
    staleTime: 0,
  });
  const [q, setQ] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [printTarget, setPrintTarget] = useState<{ fileId: string; productName: string; printerName: string } | null>(null);

  const printers = useMemo(() => data?.printers ?? [], [data]);
  const products = useMemo(() => {
    let list = data?.products ?? [];
    const query = q.trim().toLocaleLowerCase("tr-TR");
    if (query) list = list.filter((p) => p.name.toLocaleLowerCase("tr-TR").includes(query));
    if (onlyMissing && printers.length) list = list.filter((p) => p.files.length < printers.length);
    return list;
  }, [data, q, onlyMissing, printers.length]);

  const print = useMutation({
    mutationFn: (fileId: string) =>
      fetch(`/api/models/${fileId}/print`, { method: "POST" }).then(async (r) => {
        if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || "Başlatılamadı"); }
        return r.json();
      }),
    onSuccess: () => {
      toast.success("Baskı başlatıldı 🎉");
      setPrintTarget(null);
      setTimeout(() => qc.invalidateQueries({ queryKey: ["printers"] }), 800);
    },
    onError: (e: Error) => { toast.error(e.message); setPrintTarget(null); },
  });

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Boxes className="h-6 w-6 text-primary" /> Modeller
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Ürünlerin baskı dosyaları. Yeşil yazıcı rozetine tıkla → o yazıcıda baskıyı başlat. Dosya eklemek için ürün sayfasına git.
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Ürün ara…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <Button variant={onlyMissing ? "default" : "outline"} size="sm" onClick={() => setOnlyMissing((v) => !v)}>
          Eksik dosyası olanlar
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[72px] w-full rounded-lg" />)}</div>
      ) : printers.length === 0 ? (
        <EmptyHint title="Önce yazıcı ekle" desc="Yazıcılar → Yönet'ten yazıcılarını ekledikten sonra ürünlere baskı dosyası yükleyebilirsin." />
      ) : products.length === 0 ? (
        <EmptyHint title="Henüz model yok" desc="Bir ürünün detay sayfasındaki 'Baskı Dosyaları' kartından yazıcı başına dosya yükle; hepsi burada toplanır." />
      ) : (
        <div className="space-y-2">
          {products.map((p) => (
            <Card key={p.productId}>
              <CardContent className="p-3 flex items-center gap-3">
                <div className="h-12 w-12 shrink-0 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
                  {p.imageUrl ? <img src={p.imageUrl} alt="" className="max-w-full max-h-full object-contain" /> : <Package className="h-5 w-5 text-muted-foreground/40" />}
                </div>
                <Link href={`/products/${p.productId}`} className="min-w-0 flex-1 font-medium text-sm hover:underline truncate" title={p.name}>
                  {p.name}
                </Link>
                <div className="flex items-center gap-1.5 flex-wrap justify-end max-w-[60%]">
                  {printers.map((pr) => {
                    const f = p.files.find((x) => x.printerConfigId === pr.id);
                    const canPrint = !!f && pr.type === "moonraker";
                    return (
                      <button
                        key={pr.id}
                        disabled={!f || print.isPending}
                        onClick={() => {
                          if (!f) return;
                          if (pr.type === "moonraker") setPrintTarget({ fileId: f.id, productName: p.name, printerName: pr.name });
                          else toast.info("Bambu'da uygulamadan baskı başlatma henüz yok");
                        }}
                        className={cn(
                          "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors",
                          f
                            ? canPrint
                              ? "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 cursor-pointer"
                              : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : "border-dashed border-border text-muted-foreground/45"
                        )}
                        title={f ? (canPrint ? `${pr.name}: baskıyı başlat` : "Bambu — yakında") : `${pr.name}: dosya yok`}
                      >
                        {f && <Play className="h-3 w-3" />}
                        {pr.name}
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!printTarget} onOpenChange={(o) => !o && setPrintTarget(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Baskıyı başlat?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">{printTarget?.productName}</strong> →{" "}
            <strong className="text-foreground">{printTarget?.printerName}</strong> yazıcısına yüklenip baskı hemen başlatılacak.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrintTarget(null)}>Vazgeç</Button>
            <Button disabled={print.isPending} onClick={() => printTarget && print.mutate(printTarget.fileId)}>
              {print.isPending ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Gönderiliyor…</> : <><Play className="h-4 w-4 mr-1.5" />Bas</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyHint({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-xl border border-dashed py-16 text-center">
      <Boxes className="h-10 w-10 mx-auto text-muted-foreground/30" />
      <p className="mt-3 font-medium">{title}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">{desc}</p>
    </div>
  );
}
