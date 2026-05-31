"use client";
/* eslint-disable @next/next/no-img-element */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";
import { Layers, Plus, X, Search, Unlink, Package, ArrowUpRight, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, cn } from "@/lib/utils";

interface VChild {
  id: string;
  name: string;
  variantLabel: string | null;
  imageUrl: string | null;
  stock: number;
  currentSalePrice: number;
}
interface PickProduct {
  id: string;
  name: string;
  imageUrl: string | null;
  currentSalePrice: number;
}

function Thumb({ src }: { src: string | null }) {
  return (
    <div className="h-9 w-9 shrink-0 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
      {src ? <img src={src} alt="" className="max-w-full max-h-full object-contain" loading="lazy" /> : <Package className="h-4 w-4 text-muted-foreground/40" />}
    </div>
  );
}

export function VariantsCard({
  productId,
  productName,
  variantLabel,
  parent,
  childrenVariants,
}: {
  productId: string;
  productName: string;
  variantLabel: string | null;
  parent: { id: string; name: string } | null;
  childrenVariants: VChild[];
}) {
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["product", productId] });
    qc.invalidateQueries({ queryKey: ["products"] });
  };

  const unlink = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentProductId: null, variantLabel: null }),
      }).then((r) => r.json()),
    onSuccess: () => {
      refresh();
      toast.success("Varyant bağı kaldırıldı");
    },
    onError: () => toast.error("İşlem başarısız"),
  });

  // Bu ürün başka bir ürünün varyantıysa
  if (parent) {
    return (
      <Card>
        <CardContent className="py-3 flex items-center gap-3">
          <Layers className="h-4 w-4 text-primary shrink-0" />
          <div className="text-sm flex-1 min-w-0">
            <span className="text-muted-foreground">Bu ürün </span>
            <Link href={`/products/${parent.id}`} className="font-medium text-primary hover:underline">
              {parent.name}
            </Link>
            <span className="text-muted-foreground"> ürününün varyantı</span>
            {variantLabel && <span className="font-medium"> — {variantLabel}</span>}
          </div>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs shrink-0" onClick={() => unlink.mutate(productId)} disabled={unlink.isPending}>
            <Unlink className="h-3.5 w-3.5" /> Bağı kaldır
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500" style={{ animationDelay: "20ms", animationFillMode: "both" }}>
      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers className="h-4 w-4 text-primary" />
            Varyantlar
            {childrenVariants.length > 0 && <Badge variant="outline" className="ml-1 tabular-nums">{childrenVariants.length}</Badge>}
          </CardTitle>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setPickerOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Varyant Ekle
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-3">
        {childrenVariants.length === 0 ? (
          <p className="text-xs text-muted-foreground py-1.5">
            Henüz varyant yok. Aynı ürünün renk/boy seçeneklerini (Shopify&apos;dan çekilmiş ayrı ürünleri) buraya
            bağla; ana listeden gizlenip burada toplanırlar.
          </p>
        ) : (
          <div className="space-y-1.5">
            {childrenVariants.map((v) => (
              <div key={v.id} className="flex items-center gap-2.5 py-1">
                <Thumb src={v.imageUrl} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{v.variantLabel || v.name}</p>
                  {v.variantLabel && <p className="text-[10px] text-muted-foreground truncate">{v.name}</p>}
                </div>
                <div className="text-right shrink-0 tabular-nums">
                  <p className="text-xs font-medium">{formatCurrency(v.currentSalePrice)}</p>
                  <p className="text-[10px] text-muted-foreground">stok {v.stock}</p>
                </div>
                <Link href={`/products/${v.id}`} className="shrink-0 p-1.5 rounded text-muted-foreground hover:text-foreground" title="Ürüne git">
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
                <button onClick={() => unlink.mutate(v.id)} className="shrink-0 p-1.5 rounded text-muted-foreground/60 hover:text-destructive" title="Bağı kaldır">
                  <Unlink className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {pickerOpen && <VariantPicker productId={productId} productName={productName} onClose={() => setPickerOpen(false)} />}
    </Card>
  );
}

function VariantPicker({ productId, productName, onClose }: { productId: string; productName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery<PickProduct[]>({
    queryKey: ["products", "variant-picker"],
    queryFn: () => fetch("/api/products?filter=all").then((r) => r.json()),
  });
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<PickProduct | null>(null);
  const [label, setLabel] = useState("");

  const list = useMemo(() => {
    const all = Array.isArray(data) ? data : [];
    const query = q.trim().toLocaleLowerCase("tr-TR");
    return all
      .filter((p) => p.id !== productId)
      .filter((p) => !query || p.name.toLocaleLowerCase("tr-TR").includes(query))
      .slice(0, 50);
  }, [data, q, productId]);

  const link = useMutation({
    mutationFn: () =>
      fetch(`/api/products/${selected!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentProductId: productId, variantLabel: label.trim() || null }),
      }).then((r) => {
        if (!r.ok) throw new Error("Bağlanamadı");
        return r.json();
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product", productId] });
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Varyant eklendi");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 animate-in fade-in" onClick={onClose} />
      <Card className="relative w-full max-w-md animate-in fade-in zoom-in-95 duration-200">
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Varyant Ekle</h2>
            <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>

          {!selected ? (
            <>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{productName}</span> ürününe varyant olarak bağlanacak
                ürünü seç:
              </p>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ürün ara…" className="pl-8 h-9" autoFocus />
              </div>
              <div className="max-h-72 overflow-y-auto -mx-1 px-1 space-y-0.5">
                {list.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-6">Ürün bulunamadı.</p>
                ) : (
                  list.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setSelected(p)}
                      className="w-full flex items-center gap-2.5 p-1.5 rounded-lg hover:bg-muted text-left"
                    >
                      <Thumb src={p.imageUrl} />
                      <span className="flex-1 min-w-0 text-sm truncate">{p.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums shrink-0">{formatCurrency(p.currentSalePrice)}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2.5 rounded-lg border bg-muted/30 p-2">
                <Thumb src={selected.imageUrl} />
                <span className="flex-1 min-w-0 text-sm font-medium truncate">{selected.name}</span>
                <button onClick={() => setSelected(null)} className="text-[11px] text-primary hover:underline shrink-0">değiştir</button>
              </div>
              <div>
                <Label className="text-xs">Varyant adı (örn. Kırmızı)</Label>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Kırmızı / Büyük Boy…" autoFocus />
                <p className="text-[10px] text-muted-foreground mt-1">Boş bırakırsan ürün adı kullanılır. Kolay anlaşılsın diye renk/boy yazabilirsin.</p>
              </div>
              <div className="flex gap-2">
                <Button className="flex-1 gap-1" disabled={link.isPending} onClick={() => link.mutate()}>
                  <Check className="h-4 w-4" /> {link.isPending ? "Bağlanıyor…" : "Varyant olarak bağla"}
                </Button>
                <Button variant="ghost" onClick={() => setSelected(null)}>Geri</Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
