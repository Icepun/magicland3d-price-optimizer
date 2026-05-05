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
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Zap, Download, Check, X, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { toast } from "sonner";

interface Recommendation {
  id: string;
  productId: string;
  currentPrice: number;
  recommendedPrice: number;
  currentProfit: number;
  recommendedProfit: number;
  profitDifference: number;
  currentMargin: number;
  recommendedMargin: number;
  reason: string;
  status: string;
  product: {
    id: string;
    name: string;
    barcode: string;
    sku: string;
  };
}

const STATUS_BADGE: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  ready: { label: "Hazir", variant: "default" },
  accepted: { label: "Kabul Edildi", variant: "secondary" },
  ignored: { label: "Yoksayildi", variant: "outline" },
  needs_cost: { label: "Maliyet Eksik", variant: "destructive" },
  no_better_price: { label: "Iyi Fiyat Yok", variant: "outline" },
  sent_to_trendyol: { label: "Trendyol'a Gonderildi", variant: "secondary" },
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export default function RecommendationsPage() {
  const [globalFilter, setGlobalFilter] = useState("");
  const queryClient = useQueryClient();

  const {
    data: recs = [],
    isLoading,
    isError,
  } = useQuery<Recommendation[]>({
    queryKey: ["recommendations"],
    queryFn: () => fetchJson<Recommendation[]>("/api/recommendations"),
  });

  const runMutation = useMutation({
    mutationFn: () =>
      fetch("/api/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json()),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(`${data.count} urun icin simulasyon tamamlandi`);
    },
    onError: () => toast.error("Simulasyon basarisiz"),
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      fetch(`/api/recommendations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["recommendations"] }),
  });

  const filteredRecs = useMemo(() => {
    const q = globalFilter.trim().toLocaleLowerCase("tr-TR");
    const list = Array.isArray(recs) ? recs : [];

    return list
      .filter((rec) => {
        if (!q) return true;
        return [
          rec.product?.name,
          rec.product?.barcode,
          rec.product?.sku,
          rec.reason,
          rec.status,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLocaleLowerCase("tr-TR").includes(q));
      })
      .sort((a, b) => b.profitDifference - a.profitDifference);
  }, [globalFilter, recs]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Fiyat Onerileri</h1>
        <div className="flex gap-2">
          <a
            href="/api/export?type=recommendations"
            download
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            <Download className="h-4 w-4 mr-2" /> CSV Indir
          </a>
          <Button
            size="sm"
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
          >
            <Zap className="h-4 w-4 mr-2" />
            {runMutation.isPending ? "Hesaplaniyor..." : "Simulasyon Calistir"}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Urun ara..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="pl-9"
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {filteredRecs.length} urun
        </span>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Durum</TableHead>
              <TableHead>Urun</TableHead>
              <TableHead>Mevcut Fiyat</TableHead>
              <TableHead>Onerilen Fiyat</TableHead>
              <TableHead>Mevcut Kar</TableHead>
              <TableHead>Kar Farki</TableHead>
              <TableHead>Gerekce</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  Yukleniyor...
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-destructive">
                  Oneriler yuklenemedi.
                </TableCell>
              </TableRow>
            ) : filteredRecs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  Henuz oneri yok. Simulasyon Calistir butonuna basin.
                </TableCell>
              </TableRow>
            ) : (
              filteredRecs.map((rec) => {
                const status = STATUS_BADGE[rec.status] ?? {
                  label: rec.status,
                  variant: "outline" as const,
                };

                return (
                  <TableRow key={rec.id} className="hover:bg-muted/50">
                    <TableCell>
                      <Badge variant={status.variant} className="text-xs">
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Link href={`/products/${rec.productId}`} className="hover:underline font-medium">
                        {rec.product.name}
                      </Link>
                    </TableCell>
                    <TableCell>{formatCurrency(rec.currentPrice)}</TableCell>
                    <TableCell>
                      <span className="font-medium text-primary">
                        {formatCurrency(rec.recommendedPrice)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={rec.currentProfit < 0 ? "text-destructive" : ""}>
                        {formatCurrency(rec.currentProfit)}
                        <span className="text-xs text-muted-foreground ml-1">
                          ({formatPercent(rec.currentMargin)})
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={rec.profitDifference > 0 ? "text-green-600 font-medium" : "text-muted-foreground"}>
                        {rec.profitDifference > 0 ? "+" : ""}
                        {formatCurrency(rec.profitDifference)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground line-clamp-1 max-w-xs" title={rec.reason}>
                        {rec.reason}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {rec.status === "ready" && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-green-600"
                              title="Kabul et"
                              onClick={() => updateStatus.mutate({ id: rec.id, status: "accepted" })}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground"
                              title="Yoksay"
                              onClick={() => updateStatus.mutate({ id: rec.id, status: "ignored" })}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                        {rec.status !== "ready" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Tekrar hazir yap"
                            onClick={() => updateStatus.mutate({ id: rec.id, status: "ready" })}
                          >
                            <Zap className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
