"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Check, Link2, Loader2, Package, Search, Sparkles, Unlink } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { PlatformLogo } from "@/components/PlatformLogo";
import { fetchJson } from "@/lib/fetch-json";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { baglanacakUrunler } from "@/lib/urun-bagla-oneri";

export interface UrunBaglaHedefi {
  platform: "shopify" | "trendyol" | "hepsiburada";
  satirAdi: string;
  gorsel: string | null;
  /** Satır şu an elle bağlıysa bağlı ürün (bağı değiştirme/kaldırma). */
  bagliUrunId: string | null;
}

/** `/api/manual-orders/options` ürün satırı — manuel sipariş penceresiyle aynı liste. */
interface UrunSecenegi {
  id: string;
  name: string;
  alias: string | null;
  variantLabel: string | null;
  variantGroupName: string | null;
  imageUrl: string | null;
  productionCost: number;
  packagingCost: number;
  costKnown: boolean;
}

interface Onizleme {
  bag: { urun: { id: string; name: string; imageUrl: string | null } } | null;
  siparisSayisi: number;
}

const PLATFORM_ADI: Record<UrunBaglaHedefi["platform"], string> = {
  shopify: "Shopify",
  trendyol: "Trendyol",
  hepsiburada: "Hepsiburada",
};

function gorunenAd(u: Pick<UrunSecenegi, "name" | "alias" | "variantLabel">): string {
  const ana = u.alias?.trim() || u.name;
  const varyant = u.variantLabel?.trim();
  return varyant && !ana.includes(varyant) ? `${ana} · ${varyant}` : ana;
}

function Kucukresim({ src, className }: { src: string | null; className?: string }) {
  const [bozuk, setBozuk] = useState(false);
  if (!src || bozuk) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center rounded-md border bg-muted/40", className)}>
        <Package className="h-4 w-4 text-muted-foreground/50" />
      </span>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt=""
      onError={() => setBozuk(true)}
      className={cn("shrink-0 rounded-md border object-cover", className)}
    />
  );
}

/**
 * ÜRÜNE BAĞLA — katalogla eşleşmeyen satırı bir ürüne bağlar. Bağ o ADLA gelen tüm siparişlere
 * uygulanır (geçmiş + gelecek) ve kâr seçilen ürünün maliyetiyle hesaplanır.
 */
export function UrunBaglaDialog({ hedef, onClose }: { hedef: UrunBaglaHedefi; onClose: () => void }) {
  const qc = useQueryClient();
  const [arama, setArama] = useState("");
  const [secili, setSecili] = useState<string | null>(hedef.bagliUrunId);
  const [kaldirSor, setKaldirSor] = useState(false);

  const secenekler = useQuery<{ products: UrunSecenegi[] }>({
    queryKey: ["manual-order-options"],
    queryFn: () => fetchJson("/api/manual-orders/options"),
    staleTime: 60_000,
  });
  const onizleme = useQuery<Onizleme>({
    queryKey: ["satir-bagla", hedef.platform, hedef.satirAdi],
    queryFn: () =>
      fetchJson(
        `/api/orders/satir-bagla?platform=${hedef.platform}&ad=${encodeURIComponent(hedef.satirAdi)}`
      ),
    staleTime: 0,
  });

  const urunler = useMemo(() => secenekler.data?.products ?? [], [secenekler.data]);
  const { liste, tur } = useMemo(
    () => baglanacakUrunler(hedef.satirAdi, urunler, arama),
    [hedef.satirAdi, urunler, arama]
  );
  // Seçili ürün listede görünmese de (arama değişti) özet kartında kalır.
  const seciliUrun = urunler.find((u) => u.id === secili) ?? null;
  const mevcutBag = onizleme.data?.bag?.urun ?? null;
  const siparisSayisi = onizleme.data?.siparisSayisi ?? 0;
  const degisiklikYok = Boolean(mevcutBag && secili === mevcutBag.id);

  const bitti = () => {
    void qc.invalidateQueries({ queryKey: ["orders"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
    void qc.invalidateQueries({ queryKey: ["finance-monthly"] });
    void qc.invalidateQueries({ queryKey: ["products", "profitability"] });
    void qc.invalidateQueries({ queryKey: ["planner-insights"] });
    void qc.invalidateQueries({ queryKey: ["planner-queue"] });
    qc.removeQueries({ queryKey: ["satir-bagla", hedef.platform, hedef.satirAdi] });
    onClose();
  };

  const bagla = useMutation({
    mutationFn: (productId: string) =>
      fetchJson<{ urun: { name: string }; siparisSayisi: number }>("/api/orders/satir-bagla", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: hedef.platform, ad: hedef.satirAdi, productId }),
      }),
    onSuccess: (r) => {
      toast.success(r.siparisSayisi > 0 ? `${r.siparisSayisi} sipariş bağlandı` : "Ürüne bağlandı", {
        description: `${r.urun.name} · kârlar güncelleniyor`,
      });
      bitti();
    },
    onError: (e) => toast.error("Bağlanamadı", { description: e instanceof Error ? e.message : undefined }),
  });

  const kaldir = useMutation({
    mutationFn: () =>
      fetchJson("/api/orders/satir-bagla", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: hedef.platform, ad: hedef.satirAdi }),
      }),
    onSuccess: () => {
      toast.success("Bağ kaldırıldı");
      bitti();
    },
    onError: () => toast.error("Kaldırılamadı"),
  });

  const mesgul = bagla.isPending || kaldir.isPending;
  const yukleniyor = secenekler.isLoading;

  return (
    <Dialog open onOpenChange={(o) => !o && !mesgul && onClose()}>
      <DialogContent className="max-w-lg max-h-[88vh] overflow-hidden flex flex-col gap-3">
        <DialogHeader className="space-y-2">
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary animate-in zoom-in-50 duration-300">
              <Link2 className="h-3.5 w-3.5" />
            </span>
            {hedef.bagliUrunId ? "Ürün bağı" : "Ürüne bağla"}
          </DialogTitle>
          <div className="flex items-center gap-2.5 rounded-lg border bg-muted/20 p-2 animate-in fade-in slide-in-from-top-1 duration-300">
            <Kucukresim src={hedef.gorsel} className="h-10 w-10" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={hedef.satirAdi}>
                {hedef.satirAdi}
              </p>
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <PlatformLogo platform={hedef.platform} className="h-3 w-3" />
                {PLATFORM_ADI[hedef.platform]}
                {onizleme.isLoading ? (
                  <span className="ml-1 inline-block h-3 w-20 animate-pulse rounded bg-muted/60" />
                ) : siparisSayisi > 0 ? (
                  <span className="animate-in fade-in duration-300">
                    {" · bu adla "}
                    <AnimatedNumber value={siparisSayisi} durationMs={420} format={(n) => String(Math.round(n))} className="font-semibold tabular-nums text-foreground" />
                    {" sipariş"}
                  </span>
                ) : null}
              </span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Bu adla gelen tüm siparişler seçtiğin ürünün maliyetiyle hesaplanır.
          </p>
        </DialogHeader>

        {/* Mevcut bağ — değiştir ya da kaldır */}
        {mevcutBag && (
          <div className="flex items-center gap-2.5 rounded-lg border border-sky-500/30 bg-sky-500/5 p-2 animate-in fade-in slide-in-from-top-1 duration-300">
            <Kucukresim src={mevcutBag.imageUrl} className="h-8 w-8" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wider text-sky-500">Şu an bağlı</p>
              <p className="truncate text-xs font-medium">{mevcutBag.name}</p>
            </div>
            {kaldirSor ? (
              <div className="flex items-center gap-1 animate-in fade-in slide-in-from-right-1 duration-200">
                <Button size="sm" variant="destructive" disabled={mesgul} onClick={() => kaldir.mutate()}>
                  {kaldir.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Kaldır
                </Button>
                <Button size="sm" variant="ghost" disabled={mesgul} onClick={() => setKaldirSor(false)}>
                  Vazgeç
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={mesgul}
                onClick={() => setKaldirSor(true)}
              >
                <Unlink className="mr-1.5 h-3.5 w-3.5" />
                Bağı kaldır
              </Button>
            )}
          </div>
        )}

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={arama}
            onChange={(e) => setArama(e.target.value)}
            placeholder="Ürün ara…"
            className="pl-9"
            autoFocus
            disabled={yukleniyor || secenekler.isError}
          />
        </div>

        {/* Ürün listesi */}
        <div className="-mx-1 min-h-[12rem] flex-1 overflow-y-auto px-1">
          {yukleniyor ? (
            <div className="space-y-1.5">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" style={{ opacity: 1 - i * 0.15 }} />
              ))}
            </div>
          ) : secenekler.isError ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              Ürünler yüklenemedi. Pencereyi kapatıp tekrar dene.
            </p>
          ) : liste.length === 0 ? (
            <div className="py-10 text-center animate-in fade-in duration-300">
              <Search className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">
                {arama.trim() ? "Ürün bulunamadı." : "Henüz ürün yok."}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {tur !== "arama" && (
                <p className="flex items-center gap-1 px-1 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {tur === "oneri" && <Sparkles className="h-3 w-3 text-primary" />}
                  {tur === "oneri" ? "Önerilen" : "Tüm ürünler"}
                </p>
              )}
              {liste.map(({ urun }, i) => {
                const seciliMi = urun.id === secili;
                return (
                  <button
                    key={urun.id}
                    type="button"
                    onClick={() => setSecili(urun.id)}
                    disabled={mesgul}
                    className={cn(
                      "group flex w-full items-center gap-2.5 rounded-lg border p-2 text-left transition-all duration-150",
                      "animate-in fade-in slide-in-from-bottom-1 active:scale-[0.99]",
                      seciliMi
                        ? "border-primary/60 bg-primary/10 ring-1 ring-primary/30"
                        : "border-transparent hover:border-border hover:bg-muted/50"
                    )}
                    style={{ animationDelay: `${Math.min(i, 12) * 22}ms`, animationFillMode: "both" }}
                  >
                    <Kucukresim src={urun.imageUrl} className="h-9 w-9" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{gorunenAd(urun)}</span>
                      <span
                        className={cn(
                          "block truncate text-[10px]",
                          urun.costKnown ? "text-muted-foreground" : "text-amber-500"
                        )}
                      >
                        {urun.variantGroupName ? `${urun.variantGroupName} · ` : ""}
                        {urun.costKnown
                          ? `Maliyet ${formatCurrency(urun.productionCost + urun.packagingCost)}`
                          : "Maliyet girilmemiş"}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-all duration-200",
                        seciliMi
                          ? "scale-100 border-primary bg-primary text-primary-foreground"
                          : "scale-90 border-muted-foreground/30 text-transparent group-hover:border-muted-foreground/60"
                      )}
                    >
                      <Check className="h-3 w-3" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Özet + onay */}
        <div className="space-y-2 border-t pt-3">
          {seciliUrun && !degisiklikYok && (
            <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-2.5 py-2 text-xs animate-in fade-in slide-in-from-bottom-1 duration-200">
              <span className="min-w-0 max-w-[40%] truncate text-muted-foreground" title={hedef.satirAdi}>
                {hedef.satirAdi}
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate font-medium">{gorunenAd(seciliUrun)}</span>
            </div>
          )}
          {seciliUrun && !seciliUrun.costKnown && !degisiklikYok && (
            <p className="text-[11px] text-amber-500 animate-in fade-in duration-200">
              Bu ürünün maliyeti girilmemiş; kâr yine eksik görünür.
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={mesgul}>
              Vazgeç
            </Button>
            <Button
              size="sm"
              onClick={() => secili && bagla.mutate(secili)}
              disabled={mesgul || !secili || degisiklikYok}
            >
              {bagla.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Link2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              {mevcutBag ? "Bağı değiştir" : "Bağla"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
