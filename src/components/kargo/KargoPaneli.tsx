"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Loader2, RefreshCw, Store, Truck, X } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { siparisKimligi } from "@/core/order-line-cost";
import {
  KARGO_DURUM_ETIKETI,
  kargoIptalEdilebilir,
  type KargoGonderiOzeti,
} from "@/core/kargo-gonderisi";
import { KargoOlusturDialog } from "./KargoOlusturDialog";
import { KARGO_DURUM_STILI, saatYaz } from "./kargo-stil";

export const KARGO_GONDERILERI_ANAHTARI = ["kargo-gonderileri"] as const;

/** Shopify siparişlerinin HepsiJet gönderileri ("sh-<no>" → özet). Sipariş listesinden AYRI, sık tazelenir. */
export function useKargoGonderileri(etkin: boolean) {
  const q = useQuery<{ gonderiler: Record<string, KargoGonderiOzeti> }>({
    queryKey: KARGO_GONDERILERI_ANAHTARI,
    queryFn: () => fetchJson("/api/kargo/gonderiler"),
    enabled: etkin,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  return q.data?.gonderiler;
}

interface KargoluSiparis {
  platform: string;
  id: string;
  trackingNumber: string | null;
  cargoProvider: string | null;
  hepsijetBarkodu?: string | null;
  kargoGonderisi?: KargoGonderiOzeti | null;
}

/**
 * Gönderiyi siparişe işle: etiket anahtarı (barkod) ve — Shopify'da henüz takip yoksa — takip
 * numarası/firma. İptal edilen gönderinin barkodu etikete ve takibe girmez.
 */
export function kargoyuSipariseEkle<T extends KargoluSiparis>(o: T, gonderiler: Record<string, KargoGonderiOzeti> | undefined): T {
  if (o.platform !== "shopify" || !gonderiler) return o;
  const g = gonderiler[siparisKimligi("shopify", o.id)];
  if (!g) return o;
  const gecerli = g.durum !== "iptal";
  return {
    ...o,
    kargoGonderisi: g,
    hepsijetBarkodu: gecerli ? g.barkod : null,
    trackingNumber: o.trackingNumber ?? (gecerli ? g.barkod : null),
    cargoProvider: o.cargoProvider ?? (gecerli ? "HepsiJet" : null),
  };
}

/** Satır başlığındaki küçük durum rozeti. */
export function KargoDurumRozeti({ gonderi }: { gonderi?: KargoGonderiOzeti | null }) {
  if (!gonderi || gonderi.durum === "iptal") return null;
  const stil = KARGO_DURUM_STILI[gonderi.durum];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9px] font-semibold ring-1 animate-in fade-in zoom-in-95 duration-300",
        stil.rozet
      )}
      title={`HepsiJet · ${gonderi.metin}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {stil.canli && <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-70 animate-ping motion-reduce:animate-none", stil.nokta)} />}
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", stil.nokta)} />
      </span>
      {KARGO_DURUM_ETIKETI[gonderi.durum]}
      {gonderi.ortam === "test" && <span className="opacity-70">· test</span>}
    </span>
  );
}

/**
 * Açılır paneldeki kargo bölümü (Shopify): gönderi yoksa "Kargo oluştur"; varsa durum, hareketler,
 * Shopify'a yazılma durumu, yenile ve (kurye almadan önce) iptal. Etiket düğmesi ortak etiket
 * bileşeninden gelir (barkod siparişe işlendiği için).
 */
export function KargoPaneli({
  siparis,
}: {
  siparis: { id: string; orderNumber: string; statusKind: string; kargoGonderisi?: KargoGonderiOzeti | null };
}) {
  const qc = useQueryClient();
  const [acik, setAcik] = useState(false);
  const [gecmisAcik, setGecmisAcik] = useState(false);
  const [iptalOnay, setIptalOnay] = useState(false);
  const g = siparis.kargoGonderisi ?? null;

  const guncelle = (yeni: KargoGonderiOzeti | null) => {
    if (!yeni) return;
    qc.setQueryData<{ gonderiler: Record<string, KargoGonderiOzeti> }>(KARGO_GONDERILERI_ANAHTARI, (eski) =>
      eski ? { gonderiler: { ...eski.gonderiler, [siparisKimligi("shopify", siparis.id)]: yeni } } : eski
    );
  };

  const yenile = useMutation({
    mutationFn: () =>
      fetchJson<{ gonderi: KargoGonderiOzeti | null }>("/api/kargo/takip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barkod: g?.barkod }),
      }),
    onSuccess: (d) => {
      guncelle(d.gonderi);
      void qc.invalidateQueries({ queryKey: KARGO_GONDERILERI_ANAHTARI });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const iptal = useMutation({
    mutationFn: () =>
      fetchJson<{ gonderi: KargoGonderiOzeti }>("/api/kargo/gonderi", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barkod: g?.barkod }),
      }),
    onSuccess: (d) => {
      guncelle(d.gonderi);
      setIptalOnay(false);
      toast.success("Kargo iptal edildi");
    },
    onError: (e: Error) => {
      setIptalOnay(false);
      toast.error(e.message);
    },
  });

  const olusturulabilir = siparis.statusKind !== "cancelled" && siparis.statusKind !== "delivered" && (!g || g.durum === "iptal");

  return (
    <div className="space-y-1.5 pt-1">
      {g && g.durum !== "iptal" ? (
        <div className="space-y-1.5 rounded-lg border border-white/[0.06] bg-muted/20 p-2 animate-in fade-in slide-in-from-bottom-1 duration-300">
          <div className="flex items-center gap-1.5">
            <Truck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <KargoDurumRozeti gonderi={g} />
            <button
              type="button"
              onClick={() => yenile.mutate()}
              disabled={yenile.isPending}
              className="ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
              title="Durumu yenile"
            >
              <RefreshCw className={cn("h-3 w-3", yenile.isPending && "animate-spin")} />
            </button>
          </div>
          {g.metin !== KARGO_DURUM_ETIKETI[g.durum] && <p className="text-[11px] leading-snug text-foreground/85">{g.metin}</p>}
          <ShopifySatiri g={g} />

          {g.olaylar.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setGecmisAcik((v) => !v)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown className={cn("h-3 w-3 transition-transform duration-200", gecmisAcik && "rotate-180")} />
                Hareketler ({g.olaylar.length})
              </button>
              {gecmisAcik && (
                <ol className="mt-1.5 space-y-1.5 border-l border-border/60 pl-2.5">
                  {[...g.olaylar].reverse().map((o, i) => (
                    <li
                      key={`${o.an}-${i}`}
                      className="relative text-[10px] animate-in fade-in slide-in-from-left-1 duration-300 motion-reduce:animate-none"
                      style={{ animationDelay: `${i * 40}ms`, animationFillMode: "both" }}
                    >
                      <span className={cn("absolute -left-[13px] top-1 h-1.5 w-1.5 rounded-full", i === 0 ? KARGO_DURUM_STILI[g.durum].nokta : "bg-muted-foreground/50")} />
                      <span className="text-foreground/85">{o.metin}</span>
                      <span className="ml-1 text-muted-foreground tabular-nums">{saatYaz(o.an)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {kargoIptalEdilebilir(g) &&
            (iptalOnay ? (
              <div className="flex items-center gap-1.5 pt-0.5 animate-in fade-in duration-200">
                <span className="text-[10px] text-muted-foreground">Kargo iptal edilsin mi?</span>
                <button
                  type="button"
                  onClick={() => iptal.mutate()}
                  disabled={iptal.isPending}
                  className="ml-auto inline-flex items-center gap-1 rounded-md bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive transition-colors hover:bg-destructive/25 disabled:opacity-60"
                >
                  {iptal.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                  Evet, iptal et
                </button>
                <button type="button" onClick={() => setIptalOnay(false)} className="rounded p-0.5 text-muted-foreground hover:bg-muted" title="Vazgeç">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIptalOnay(true)}
                className="text-[10px] text-muted-foreground underline-offset-2 transition-colors hover:text-destructive hover:underline"
              >
                Kargoyu iptal et
              </button>
            ))}
        </div>
      ) : null}

      {olusturulabilir && (
        <>
          {g?.durum === "iptal" && <p className="text-[10px] text-muted-foreground">Önceki kargo iptal edildi.</p>}
          <button
            type="button"
            onClick={() => setAcik(true)}
            className="group inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-gradient-to-r from-[#9B5CFF]/20 to-[#4F8CFF]/20 px-2.5 py-1.5 text-xs font-semibold text-foreground ring-1 ring-[#7A7EFF]/30 transition-all duration-200 hover:from-[#9B5CFF]/30 hover:to-[#4F8CFF]/30 hover:ring-[#7A7EFF]/50 active:scale-[0.98]"
          >
            <Truck className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
            Kargo oluştur
          </button>
        </>
      )}
      {acik && <KargoOlusturDialog siparisId={siparis.id} siparisNo={siparis.orderNumber} onClose={() => setAcik(false)} />}
    </div>
  );
}

function ShopifySatiri({ g }: { g: KargoGonderiOzeti }) {
  const metin =
    g.ortam === "test"
      ? "Test gönderisi · Shopify'a yazılmaz"
      : g.shopifyTeslim
        ? `Shopify'da teslim edildi · ${saatYaz(g.shopifyTeslim)}`
        : g.shopifyGonderildi
          ? `Shopify'da gönderildi · ${saatYaz(g.shopifyGonderildi)}`
          : g.shopifyHata ?? "Kurye alınca Shopify'da gönderildi işaretlenecek";
  return (
    <p className={cn("flex items-center gap-1 text-[10px]", g.shopifyHata && !g.shopifyGonderildi ? "text-amber-400" : "text-muted-foreground")}>
      <Store className="h-3 w-3 shrink-0" />
      <span className="min-w-0">{metin}</span>
    </p>
  );
}
