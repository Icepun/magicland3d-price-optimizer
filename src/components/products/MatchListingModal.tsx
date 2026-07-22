"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { Search, RefreshCw, Loader2, Package } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";

interface UnmatchedListing {
  id: string;
  barcode: string;
  externalSku: string | null;
  name: string;
  price: number;
  stock: number;
  imageUrl: string | null;
}

/**
 * Pazaryeri (Trendyol/HB) listing'ini mevcut bir ürüne EŞLEŞTİRME modalı.
 * İki yol: (1) Barkod/SKU yapıştır → Enter → havuzda tam eşleşeni bul → bağla (barkod otomatik girilir).
 *          (2) Listeden seç → bağla. Eşleşince listing.barcode otomatik set edilir.
 *
 * onMatched: eşleşme tamamlanınca çağrılır — çağıran sayfa kendi cache'ini tazeler
 * (örn. ürün detayında ["product", id] + ["profit-preview", id]). Ürünler listesi zaten içeride invalidate edilir.
 */
export function MatchListingModal({
  productId,
  productName,
  platform,
  onClose,
  onMatched,
}: {
  productId: string;
  productName: string;
  platform: "trendyol" | "hepsiburada";
  onClose: () => void;
  onMatched?: () => void;
}) {
  const qc = useQueryClient();
  const platformLabel = platform === "hepsiburada" ? "Hepsiburada" : "Trendyol";
  const [search, setSearch] = useState("");
  const [quickCode, setQuickCode] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Arama debounce: her tuşta fetch + yeni cache anahtarı oluşturma (250ms sonra bir kez).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: unmatched = [], isLoading } = useQuery<UnmatchedListing[]>({
    queryKey: ["unmatched-listings", platform, debouncedSearch],
    queryFn: () =>
      fetchJson(
        `/api/unmatched-listings?platform=${platform}${debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : ""}`
      ),
  });

  const match = useMutation({
    // Tüm yan-etkiler mutationFn İÇİNDE: onMutate modalı anında kapatıp komponenti
    // unmount edince onSuccess/onError tetiklenmeyebilir; mutationFn ise her hâlde tamamlanır.
    mutationFn: async (unmatchedListingId: string) => {
      try {
        const res = await fetchJson("/api/listings/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unmatchedListingId, productId }),
        });
        qc.invalidateQueries({ queryKey: ["products"] });
        qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        onMatched?.();
        toast.success("Ürün eşleştirildi");
        return res;
      } catch (e) {
        toast.error(`Eşleştirilemedi: ${e instanceof Error ? e.message : "tekrar dene"}`);
        throw e;
      }
    },
    onMutate: () => onClose(), // modalı ANINDA kapat — kullanıcı server'ı beklemez
  });

  // Barkod/SKU ile HIZLI eşleştir: havuzda tam eşleşeni bul → bağla. match rotası Listing.barcode'u
  // da otomatik set eder → ürün detayına girip barkod eklemeye gerek kalmaz.
  const quickMatch = useMutation({
    mutationFn: async (raw: string) => {
      const val = raw.trim();
      if (!val) throw new Error("Önce SKU/barkod yapıştır");
      const pool = await fetchJson<UnmatchedListing[]>(
        `/api/unmatched-listings?platform=${platform}&search=${encodeURIComponent(val)}`
      );
      const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
      const exact = pool.find((u) => norm(u.externalSku) === norm(val) || norm(u.barcode) === norm(val));
      const hit = exact ?? (pool.length === 1 ? pool[0] : undefined);
      if (!hit) {
        throw new Error(
          pool.length > 1
            ? "Birden çok eşleşme var — tam SKU/barkod yapıştır"
            : `"${val}" ${platformLabel} havuzunda yok — "Tazele"yi dene`
        );
      }
      await fetchJson("/api/listings/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unmatchedListingId: hit.id, productId }),
      });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      onMatched?.();
      return hit;
    },
    onSuccess: (hit) => {
      toast.success(`Eşleştirildi + barkod girildi: ${hit.name}`);
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Eşleştirilemedi"),
  });

  const refreshPool = useMutation({
    mutationFn: () =>
      fetchJson(`/api/${platform}/sync-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "add-new" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success(`${platformLabel} listesi tazelendi`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Windowed render: 300+ listing'i tek seferde DOM'a basmak modalı kasıyordu → başta 60, scroll'da artar.
  const [visibleWindow, setVisibleWindow] = useState({ search: "", count: 60 });
  const visibleCount = visibleWindow.search === debouncedSearch ? visibleWindow.count : 60;
  const visible = unmatched.slice(0, visibleCount);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{platformLabel} Ürünü Eşleştir</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            <strong className="text-foreground line-clamp-1">{productName}</strong>{" "}
            ürününe bağlanacak {platformLabel} listing&apos;ini seç.
          </p>
        </DialogHeader>

        {/* HIZLI yol: SKU/barkod yapıştır → Enter → direkt eşleştir (barkod otomatik girilir) */}
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 space-y-1.5">
          <p className="text-[11px] font-semibold text-foreground">⚡ Barkod / SKU ile hızlı eşleştir</p>
          <div className="flex gap-2">
            <Input
              value={quickCode}
              onChange={(e) => setQuickCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && quickCode.trim() && !quickMatch.isPending) quickMatch.mutate(quickCode);
              }}
              placeholder="SKU veya barkodu yapıştır → Enter"
              className="h-8 font-mono text-xs"
              autoFocus
            />
            <Button
              size="sm"
              className="h-8 shrink-0"
              disabled={quickMatch.isPending || !quickCode.trim()}
              onClick={() => quickMatch.mutate(quickCode)}
            >
              {quickMatch.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Eşleştir"}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Barkod otomatik girilir — ürün detayına girip tekrar eklemene gerek kalmaz.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Barkod, SKU veya ürün adı..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={refreshPool.isPending}
            onClick={() => refreshPool.mutate()}
            title={`${platformLabel}'dan güncel ürün listesini çek`}
          >
            <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshPool.isPending ? "animate-spin" : ""}`} />
            {refreshPool.isPending ? "Tazeleniyor…" : "Tazele"}
          </Button>
        </div>

        <div
          className="flex-1 overflow-y-auto -mx-2 px-2"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 240 && visibleCount < unmatched.length) {
              setVisibleWindow((current) => ({
                search: debouncedSearch,
                count: (current.search === debouncedSearch ? current.count : 60) + 60,
              }));
            }
          }}
        >
          {isLoading ? (
            <div className="py-8 flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Yükleniyor...
            </div>
          ) : unmatched.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {search
                ? `"${search}" için sonuç yok`
                : `Eşleşmemiş ${platformLabel} listing'i bulunmuyor. Önce ${platformLabel} ürünlerini senkronize et.`}
            </div>
          ) : (
            <div className="space-y-1">
              {visible.map((u) => (
                <button
                  key={u.id}
                  onClick={() => match.mutate(u.id)}
                  disabled={match.isPending}
                  className="w-full text-left p-3 rounded-md hover:bg-muted/60 transition-colors flex items-center gap-3 border border-transparent hover:border-primary/30 disabled:opacity-50"
                >
                  {u.imageUrl ? (
                    <div className="w-10 h-10 rounded border bg-muted shrink-0 overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={u.imageUrl}
                        alt={u.name}
                        className="w-full h-full object-contain"
                      />
                    </div>
                  ) : (
                    <div className="w-10 h-10 rounded bg-muted shrink-0 flex items-center justify-center">
                      <Package className="h-5 w-5 text-muted-foreground/60" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium line-clamp-1">{u.name}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">
                      {u.barcode} · {u.externalSku ?? "no-sku"}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-semibold tabular-nums">
                      {formatCurrency(u.price)}
                    </p>
                    <p className="text-[10px] text-muted-foreground tabular-nums">
                      Stok: {u.stock}
                    </p>
                  </div>
                </button>
              ))}
              {visibleCount < unmatched.length && (
                <p className="text-center text-[11px] text-muted-foreground py-2">
                  {visible.length} / {unmatched.length} gösteriliyor — kaydır veya ara
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
