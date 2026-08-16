"use client";

/**
 * YENİ TARİFE BAŞLAT — kargo zammını kod değiştirmeden girme akışı.
 *
 * Eskiden yeni bir kargo tarifesi girmek elle yazılmış bir veri göçü gerektiriyordu. Burası
 * aynı işi yapar: başlangıç tarihini seç, fiyatları gir, kaydet. Sunucu eski dönemi başlangıçtan
 * 1 ms önce kapatır (silmez — geçmiş siparişlerin kârı ona bağlı) ve yeni dönemi açar.
 *
 * Form YÜRÜRLÜKTEKİ tarifenin kopyasıyla açılır; kullanıcı çoğu zaman yalnız fiyatları
 * güncelleyecek. Toplu zam kutusu tek hamlede hepsini oranlar — tarife zamları genelde
 * yüzdesel geliyor.
 */

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CalendarClock, ArrowRight, TrendingUp } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { fetchJson } from "@/lib/fetch-json";

export interface TarifeKurali {
  id: string;
  name: string;
  platform: string | null;
  cargoProvider: string | null;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  minDesi: number;
  maxDesi: number;
  cargoCost: number;
  vatIncluded: boolean;
  priority: number;
  isActive: boolean;
  validFrom: string | null;
  validTo: string | null;
}

/** "2026-08-01" → "2026-08-01T00:00:00.000+03:00" (Türkiye saati). */
function isoBaslangic(gun: string): string {
  return `${gun}T00:00:00.000+03:00`;
}

/** Bugünün Türkiye tarihi, `<input type="date">` biçiminde. */
function bugunInput(): string {
  const tr = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return tr.toISOString().slice(0, 10);
}

function bandEtiketi(r: TarifeKurali): string {
  const duz = r.minDesi <= 0 && r.maxDesi >= 999;
  if (duz) {
    const ust = r.maxPrice >= 999999 ? "∞" : r.maxPrice;
    return `${r.minPrice} – ${ust} ₺ sipariş`;
  }
  const ust = r.maxDesi >= 999 ? "∞" : r.maxDesi;
  return `${r.minDesi} – ${ust} desi`;
}

export function NewTariffDialog({
  open,
  onOpenChange,
  platform,
  platformAdi,
  yururluktekiKurallar,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  platform: "trendyol" | "shopify" | "hepsiburada";
  platformAdi: string;
  /** O platformun BUGÜN yürürlükte olan kuralları (pasifler dahil — barem modu korunsun). */
  yururluktekiKurallar: TarifeKurali[];
}) {
  const queryClient = useQueryClient();
  const [baslangic, setBaslangic] = useState(bugunInput);
  const [zamYuzde, setZamYuzde] = useState("");
  /** kural id → yeni fiyat (metin; kullanıcı yazarken serbest kalsın) */
  const [fiyatlar, setFiyatlar] = useState<Record<string, string>>({});

  const sirali = useMemo(
    () =>
      [...yururluktekiKurallar].sort(
        (a, b) => a.minDesi - b.minDesi || a.minPrice - b.minPrice
      ),
    [yururluktekiKurallar]
  );

  const yeniFiyat = (r: TarifeKurali): number => {
    const yazilan = fiyatlar[r.id];
    if (yazilan != null && yazilan !== "") {
      const n = Number(yazilan.replace(",", "."));
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return r.cargoCost;
  };

  const degisenSayisi = sirali.filter((r) => yeniFiyat(r) !== r.cargoCost).length;

  const zamUygula = () => {
    const oran = Number(zamYuzde.replace(",", "."));
    if (!Number.isFinite(oran) || oran === 0) {
      toast.error("Geçerli bir yüzde gir");
      return;
    }
    const yeni: Record<string, string> = {};
    for (const r of sirali) {
      yeni[r.id] = (Math.round(r.cargoCost * (1 + oran / 100) * 100) / 100).toFixed(2);
    }
    setFiyatlar(yeni);
    toast.success(`Tüm baremlere %${oran} uygulandı`);
  };

  const kaydet = useMutation({
    mutationFn: () =>
      fetchJson("/api/cargo-rules/tariff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          startsAt: isoBaslangic(baslangic),
          rules: sirali.map((r) => ({
            name: r.name,
            cargoProvider: r.cargoProvider,
            categoryName: r.categoryName,
            minPrice: r.minPrice,
            maxPrice: r.maxPrice,
            minDesi: r.minDesi,
            maxDesi: r.maxDesi,
            cargoCost: yeniFiyat(r),
            vatIncluded: r.vatIncluded,
            priority: r.priority,
            isActive: r.isActive,
          })),
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
      toast.success(`${platformAdi} için yeni tarife başladı`);
      setFiyatlar({});
      setZamYuzde("");
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message || "Tarife başlatılamadı"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" />
            {platformAdi} — yeni kargo tarifesi
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Seçtiğin tarihten itibaren bu fiyatlar geçerli olur. Bugünkü tarife silinmez; o
            tarihe kadar verilmiş siparişler eski fiyatlarıyla hesaplanmaya devam eder.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Başlangıç tarihi</Label>
              <Input type="date" value={baslangic} onChange={(e) => setBaslangic(e.target.value)} />
            </div>
            <div>
              <Label>Toplu zam (%)</Label>
              <div className="flex gap-1.5">
                <Input
                  inputMode="decimal"
                  placeholder="örn. 6"
                  value={zamYuzde}
                  onChange={(e) => setZamYuzde(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); zamUygula(); }
                  }}
                />
                <Button type="button" variant="secondary" onClick={zamUygula} title="Tüm baremlere uygula">
                  <TrendingUp className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>

          <div className="rounded-lg border overflow-hidden">
            <div className="bg-muted/50 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground flex items-center justify-between">
              <span>Barem</span>
              <span>Bugün → Yeni</span>
            </div>
            <div className="max-h-[45vh] overflow-y-auto">
              <table className="w-full text-sm">
                <tbody>
                  {sirali.map((r) => {
                    const yeni = yeniFiyat(r);
                    const degisti = yeni !== r.cargoCost;
                    return (
                      <tr
                        key={r.id}
                        className={cn(
                          "border-t border-border/50 transition-colors",
                          degisti && "bg-primary/5",
                          !r.isActive && "opacity-45"
                        )}
                      >
                        <td className="px-3 py-1.5">
                          <div className="text-xs tabular-nums">{bandEtiketi(r)}</div>
                          {!r.isActive && (
                            <div className="text-[10px] text-muted-foreground">kapalı barem</div>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                          {formatCurrency(r.cargoCost)}
                        </td>
                        <td className="px-1 py-1.5 text-muted-foreground">
                          <ArrowRight className="h-3 w-3" />
                        </td>
                        <td className="px-3 py-1.5 w-28">
                          <Input
                            inputMode="decimal"
                            className="h-7 text-right text-xs tabular-nums"
                            value={fiyatlar[r.id] ?? ""}
                            placeholder={r.cargoCost.toFixed(2)}
                            onChange={(e) =>
                              setFiyatlar((o) => ({ ...o, [r.id]: e.target.value }))
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            {degisenSayisi === 0
              ? "Henüz fiyat değiştirmedin."
              : `${degisenSayisi} baremin fiyatı değişecek · ${sirali.length} barem yeni tarifeye taşınacak.`}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Vazgeç
          </Button>
          <Button
            onClick={() => kaydet.mutate()}
            disabled={kaydet.isPending || degisenSayisi === 0 || !baslangic}
          >
            {kaydet.isPending ? "Başlatılıyor..." : "Tarifeyi başlat"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
