"use client";

/**
 * REKLAM BÜTÇESİ KARTI — platform başına günlük reklam harcaması.
 *
 * Bu tutar Giderler listesine YAZILMAZ; doğrudan ürün/sipariş maliyetine yedirilir (kullanıcı
 * kararı: tek yerde sayılsın, rapor net kârından bir kez daha düşülmesin). Kart bu yüzden
 * "gider ekleme" değil, "kâr hesabına giren oran" olarak anlatılır.
 *
 * Dağıtım ciroya orantılıdır: günlük tutarı gün içi sipariş sayısına bölmek ölçüldüğünde
 * aynı ürüne 15 kat farklı pay bindiriyordu (bkz. `core/ad-cost.ts`).
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Megaphone, TriangleAlert, Loader2 } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { fetchJson } from "@/lib/fetch-json";
import { clearPricingQueryCache } from "@/lib/pricing-query-cache";

/**
 * "all" en üstte: marka reklamı tek kanala yüklenemez — reklamı görüp mağazaya giren müşteri
 * Trendyol'dan da alabilir (kullanıcı kararı). Paydası TOPLAM ciro.
 * Platform satırları isteğe bağlı: bir kanala AYRICA reklam verilirse üstüne eklenir.
 */
const PLATFORMLAR = [
  { id: "all", ad: "Tüm platformlar", renk: "text-primary" },
  { id: "trendyol", ad: "Trendyol", renk: "text-orange-500" },
  { id: "shopify", ad: "Shopify", renk: "text-emerald-500" },
  { id: "hepsiburada", ad: "Hepsiburada", renk: "text-violet-500" },
] as const;

interface Butce {
  id: string;
  platform: string;
  dailyAmount: number;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
}
interface Oran {
  oran: number;
  yuzde: number;
  toplamHarcama: number;
  guvenilir: boolean;
  cirodanBuyuk: boolean;
}
interface Yanit {
  butceler: Butce[];
  oranlar: Record<string, Oran>;
  pencereGun: number;
}

/** "2026-08-01" — Türkiye saatiyle bugünün input biçimi. */
function bugunInput(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const kisaTarih = (iso: string) =>
  new Date(iso).toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Istanbul" });

export function AdBudgetCard() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<Yanit>({
    queryKey: ["ad-budgets"],
    queryFn: () => fetchJson("/api/ad-budgets"),
    staleTime: 60_000,
  });

  const [acikPlatform, setAcikPlatform] = useState<string | null>(null);
  const [tutar, setTutar] = useState("");
  const [baslangic, setBaslangic] = useState(bugunInput);

  /** Mevcut dönemi YERİNDE düzelt — "yanlış girdim" durumu. Geçmişe de işler. */
  const duzelt = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      fetchJson(`/api/ad-budgets/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dailyAmount: Number(tutar.replace(",", ".")) || 0,
          startsAt: `${baslangic}T00:00:00.000+03:00`,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ad-budgets"] });
      clearPricingQueryCache(queryClient);
      toast.success("Reklam bütçesi güncellendi");
      setAcikPlatform(null);
      setTutar("");
    },
    onError: (e: Error) => toast.error(e.message || "Güncellenemedi"),
  });

  const kaldir = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/ad-budgets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ad-budgets"] });
      clearPricingQueryCache(queryClient);
      toast.success("Reklam bütçesi kaldırıldı");
      setAcikPlatform(null);
      setTutar("");
    },
    onError: (e: Error) => toast.error(e.message || "Kaldırılamadı"),
  });

  const kaydet = useMutation({
    mutationFn: (platform: string) =>
      fetchJson("/api/ad-budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          dailyAmount: Number(tutar.replace(",", ".")) || 0,
          startsAt: `${baslangic}T00:00:00.000+03:00`,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ad-budgets"] });
      // Kâr rakamı değişti → ürün/sipariş/rapor önbelleklerinin hepsi tazelensin.
      clearPricingQueryCache(queryClient);
      toast.success("Reklam bütçesi kaydedildi");
      setAcikPlatform(null);
      setTutar("");
    },
    onError: (e: Error) => toast.error(e.message || "Kaydedilemedi"),
  });

  const yururlukte = (p: string) =>
    data?.butceler.find((b) => b.platform === p && !b.validTo && b.isActive) ?? null;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-2.5">
          <Megaphone className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight">Reklam Bütçesi</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
              Günlük reklam harcaman ürünlerin maliyetine dağıtılır; kâr rakamları buna göre
              görünür. Giderler listesine ayrıca eklenmez. Marka reklamı için &quot;Tüm
              platformlar&quot; kullan — pay tüm satışlara yayılır.
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> yükleniyor…
          </div>
        ) : (
          <div className="space-y-2">
            {PLATFORMLAR.map((p) => {
              const b = yururlukte(p.id);
              const o = data?.oranlar[p.id];
              const acik = acikPlatform === p.id;
              return (
                <div key={p.id} className="rounded-lg border bg-muted/20 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <span className={cn("text-xs font-medium w-24 shrink-0", p.renk)}>{p.ad}</span>

                    {b && b.dailyAmount > 0 ? (
                      <span className="text-xs tabular-nums">
                        {formatCurrency(b.dailyAmount)} <span className="text-muted-foreground">/ gün</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">bütçe yok</span>
                    )}

                    {o && o.guvenilir && o.oran > 0 && (
                      <span
                        className={cn(
                          "text-[11px] tabular-nums px-1.5 py-0.5 rounded",
                          o.cirodanBuyuk ? "bg-destructive/15 text-destructive" : "bg-primary/10 text-primary"
                        )}
                        title={p.id === "all" ? "Toplam ciroya oranlandı" : `Yalnız ${p.ad} cirosuna oranlandı`}
                      >
                        ciro payı %{o.yuzde.toFixed(1)}
                      </span>
                    )}
                    {o && !o.guvenilir && b && b.dailyAmount > 0 && (
                      <span className="text-[11px] text-amber-500 flex items-center gap-1">
                        <TriangleAlert className="h-3 w-3" /> ciro yok, oran hesaplanamadı
                      </span>
                    )}

                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[11px] ml-auto"
                      onClick={() => {
                        setAcikPlatform(acik ? null : p.id);
                        setTutar(b ? String(b.dailyAmount) : "");
                        // Mevcut dönemin tarihi forma gelsin — kullanıcı onu düzeltmek istiyor.
                        if (b?.validFrom) {
                          setBaslangic(new Date(b.validFrom).toISOString().slice(0, 10));
                        }
                      }}
                    >
                      {acik ? "Vazgeç" : b ? "Değiştir" : "Bütçe gir"}
                    </Button>
                  </div>

                  {b?.validFrom && (
                    <div className="px-3 pb-1.5 text-[10px] text-muted-foreground">
                      {kisaTarih(b.validFrom)} tarihinden beri geçerli
                    </div>
                  )}

                  {acik && (
                    <div className="px-3 pb-3 pt-1 border-t bg-background/40 animate-in fade-in slide-in-from-top-1 duration-200">
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <div>
                          <Label className="text-[11px]">Günlük tutar (₺)</Label>
                          <Input
                            inputMode="decimal"
                            className="h-8 text-sm"
                            placeholder="800"
                            value={tutar}
                            onChange={(e) => setTutar(e.target.value)}
                          />
                        </div>
                        <div>
                          <Label className="text-[11px]">Şu tarihten itibaren</Label>
                          <Input
                            type="date"
                            className="h-8 text-sm"
                            value={baslangic}
                            onChange={(e) => setBaslangic(e.target.value)}
                          />
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
                        {b
                          ? "Düzelt: mevcut dönemi değiştirir, geçmiş siparişler de yeni tutara göre hesaplanır. Yeni dönem: bu tarihe kadarki siparişler eski bütçeyle kalır."
                          : "Bu tarihten sonraki siparişlerin kârı reklam payını içerir."}
                      </p>
                      <div className="flex items-center gap-1.5 mt-2">
                        {b && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-destructive/80 hover:text-destructive mr-auto"
                            disabled={kaldir.isPending}
                            onClick={() => kaldir.mutate(b.id)}
                          >
                            {kaldir.isPending ? "Kaldırılıyor…" : "Kaldır"}
                          </Button>
                        )}
                        {b ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={duzelt.isPending || tutar.trim() === ""}
                              onClick={() => duzelt.mutate({ id: b.id })}
                            >
                              {duzelt.isPending ? "…" : "Düzelt"}
                            </Button>
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              disabled={kaydet.isPending || tutar.trim() === ""}
                              onClick={() => kaydet.mutate(p.id)}
                            >
                              {kaydet.isPending ? "…" : "Yeni dönem başlat"}
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            className="h-7 text-xs ml-auto"
                            disabled={kaydet.isPending || tutar.trim() === ""}
                            onClick={() => kaydet.mutate(p.id)}
                          >
                            {kaydet.isPending ? "Kaydediliyor…" : "Kaydet"}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
