"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Plus, Search, Trash2, Package } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

interface Product {
  id: string;
  barcode: string;
  sku: string;
  name: string;
  categoryName: string;
  currentSalePrice: number;
  listPrice: number | null;
  stock: number;
  desi: number | null;
  imageUrl: string | null;
  isActive: boolean;
  source: string;
  cost: {
    totalCost: number | null;
    manualCost: number | null;
    packagingCost: number | null;
  } | null;
  recommendations: {
    recommendedPrice: number;
    currentProfit: number;
    recommendedProfit: number;
    profitDifference: number;
    currentMargin: number;
    status: string;
  }[];
}

const AddProductSchema = z.object({
  barcode: z.string().min(1, "Barkod zorunlu"),
  sku: z.string().min(1, "SKU zorunlu"),
  name: z.string().min(1, "Ad zorunlu"),
  categoryName: z.string().min(1, "Kategori zorunlu"),
  currentSalePrice: z.coerce.number().positive("Pozitif olmali"),
  stock: z.coerce.number().int().min(0).default(0),
  desi: z.coerce.number().positive().optional().or(z.literal("")),
  productCost: z.coerce.number().min(0).optional().or(z.literal("")),
  packagingCost: z.coerce.number().min(0).optional().or(z.literal("")),
});

type AddProductForm = z.infer<typeof AddProductSchema>;

type FilterMode = "active" | "inactive" | "all";

const STATUS_COLORS = {
  missing: "text-muted-foreground",
  negative: "text-destructive font-medium",
  good: "text-green-600 font-medium",
  no_cost: "text-muted-foreground",
};

function getProfitStatus(product: Product): keyof typeof STATUS_COLORS {
  const cost = product.cost?.totalCost ?? product.cost?.manualCost;
  if (cost === null || cost === undefined) return "missing";
  const rec = product.recommendations[0];
  if (!rec) return "no_cost";
  if (rec.currentProfit < 0) return "negative";
  return "good";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function ProductImage({ src, name }: { src: string | null; name: string }) {
  const [errored, setErrored] = useState(false);

  if (!src || errored) {
    return (
      <div className="w-10 h-10 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
        <Package className="h-5 w-5 text-muted-foreground" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name}
      className="w-10 h-10 rounded-md object-cover flex-shrink-0 border"
      onError={() => setErrored(true)}
      loading="lazy"
    />
  );
}

export default function ProductsPage() {
  const [globalFilter, setGlobalFilter] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("active");
  const [addOpen, setAddOpen] = useState(false);
  const queryClient = useQueryClient();

  const {
    data: products = [],
    isLoading,
    isError,
  } = useQuery<Product[]>({
    queryKey: ["products", filterMode],
    queryFn: () => fetchJson<Product[]>(`/api/products?filter=${filterMode}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/products/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Urun silindi");
    },
  });

  const form = useForm<AddProductForm>({
    resolver: zodResolver(AddProductSchema),
    defaultValues: { stock: 0 },
  });

  const addMutation = useMutation({
    mutationFn: async (data: AddProductForm) => {
      const product = await fetchJson<Product>("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          barcode: data.barcode,
          sku: data.sku,
          name: data.name,
          categoryName: data.categoryName,
          currentSalePrice: data.currentSalePrice,
          stock: data.stock,
          desi: data.desi || undefined,
        }),
      });

      if (data.productCost || data.packagingCost) {
        const totalCost = (Number(data.productCost) || 0) + (Number(data.packagingCost) || 0);
        await fetch(`/api/products/${product.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cost: {
              manualCost: Number(data.productCost) || 0,
              packagingCost: Number(data.packagingCost) || 0,
              totalCost,
            },
          }),
        });
      }
      return product;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Urun eklendi");
      setAddOpen(false);
      form.reset();
    },
    onError: () => toast.error("Urun eklenemedi"),
  });

  const filteredProducts = useMemo(() => {
    const q = globalFilter.trim().toLocaleLowerCase("tr-TR");
    const list = Array.isArray(products) ? products : [];

    return list.filter((product) => {
      if (!q) return true;
      return [product.name, product.barcode, product.sku, product.categoryName]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase("tr-TR").includes(q));
    });
  }, [globalFilter, products]);

  const FILTER_OPTIONS: { value: FilterMode; label: string }[] = [
    { value: "active", label: "Aktif" },
    { value: "inactive", label: "Inaktif" },
    { value: "all", label: "Tumu" },
  ];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Urunler</h1>
        <Button onClick={() => setAddOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-2" /> Urun Ekle
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Ara: ad, barkod, SKU, kategori..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex items-center rounded-md border bg-muted/30 p-0.5 gap-0.5">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilterMode(opt.value)}
              className={`px-3 py-1.5 text-sm font-medium rounded-sm transition-colors ${
                filterMode === opt.value
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <span className="text-sm text-muted-foreground">
          {filteredProducts.length} urun
        </span>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[52px]" />
              <TableHead>Urun Adi</TableHead>
              <TableHead>Barkod</TableHead>
              <TableHead>Kategori</TableHead>
              <TableHead>Satis Fiyati</TableHead>
              <TableHead>Maliyet</TableHead>
              <TableHead>Mevcut Kar</TableHead>
              <TableHead>Kar %</TableHead>
              <TableHead>Oneri</TableHead>
              <TableHead>Stok</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center py-8 text-muted-foreground">
                  Yukleniyor...
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center py-8 text-destructive">
                  Urunler yuklenemedi.
                </TableCell>
              </TableRow>
            ) : filteredProducts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center py-8 text-muted-foreground">
                  {filterMode === "inactive"
                    ? "Inaktif urun bulunmuyor."
                    : "Urun bulunamadi. CSV ile ice aktarin veya manuel ekleyin."}
                </TableCell>
              </TableRow>
            ) : (
              filteredProducts.map((product) => {
                const rec = product.recommendations[0];
                const status = getProfitStatus(product);
                const cost = product.cost?.totalCost ?? product.cost?.manualCost;

                return (
                  <TableRow
                    key={product.id}
                    className={`hover:bg-muted/50 ${!product.isActive ? "opacity-50" : ""}`}
                  >
                    <TableCell className="py-2 pr-0">
                      <ProductImage src={product.imageUrl} name={product.name} />
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/products/${product.id}`}
                        className="font-medium hover:underline"
                      >
                        {product.name}
                      </Link>
                      {!product.isActive && (
                        <Badge variant="secondary" className="ml-2 text-xs">
                          Inaktif
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground font-mono">
                        {product.barcode}
                      </span>
                    </TableCell>
                    <TableCell>{product.categoryName}</TableCell>
                    <TableCell>{formatCurrency(product.currentSalePrice)}</TableCell>
                    <TableCell>
                      {cost !== null && cost !== undefined ? (
                        formatCurrency(cost)
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          Eksik
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {rec ? (
                        <span className={STATUS_COLORS[status]}>
                          {formatCurrency(rec.currentProfit)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {rec ? formatPercent(rec.currentMargin) : <span className="text-muted-foreground text-xs">-</span>}
                    </TableCell>
                    <TableCell>
                      {!rec || rec.status === "no_better_price" ? (
                        <span className="text-muted-foreground text-xs">-</span>
                      ) : rec.status === "needs_cost" ? (
                        <Badge variant="secondary" className="text-xs">Maliyet Eksik</Badge>
                      ) : (
                        <span className="text-green-600 text-sm font-medium">
                          {formatCurrency(rec.recommendedPrice)}{" "}
                          <span className="text-xs">(+{formatCurrency(rec.profitDifference)})</span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{product.stock}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Link
                          href={`/products/${product.id}`}
                          className="inline-flex h-8 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
                        >
                          Detay
                        </Link>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          title="Sil"
                          onClick={() => deleteMutation.mutate(product.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Yeni Urun Ekle</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={form.handleSubmit((d) => addMutation.mutate(d))}
            className="space-y-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Barkod *</Label>
                <Input {...form.register("barcode")} />
                {form.formState.errors.barcode && (
                  <p className="text-xs text-destructive">{form.formState.errors.barcode.message}</p>
                )}
              </div>
              <div>
                <Label>SKU *</Label>
                <Input {...form.register("sku")} />
              </div>
            </div>
            <div>
              <Label>Urun Adi *</Label>
              <Input {...form.register("name")} />
              {form.formState.errors.name && (
                <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>
            <div>
              <Label>Kategori *</Label>
              <Input {...form.register("categoryName")} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Satis Fiyati (TL) *</Label>
                <Input type="number" step="0.01" {...form.register("currentSalePrice")} />
              </div>
              <div>
                <Label>Stok</Label>
                <Input type="number" {...form.register("stock")} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Desi</Label>
                <Input type="number" step="0.1" {...form.register("desi")} />
              </div>
              <div>
                <Label>Urun Maliyeti (TL)</Label>
                <Input type="number" step="0.01" {...form.register("productCost")} />
              </div>
            </div>
            <div>
              <Label>Ambalaj Maliyeti (TL)</Label>
              <Input type="number" step="0.01" {...form.register("packagingCost")} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Iptal
              </Button>
              <Button type="submit" disabled={addMutation.isPending}>
                {addMutation.isPending ? "Ekleniyor..." : "Ekle"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
