"use client";

/**
 * KARGO DENETİMİ — fazla desi kesilen siparişler (itiraz için) ve Trendyol gecikme bedelleri.
 * Veri: /api/cargo-audit (son 90 gün, kalıcı kayıtlardan).
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, Copy, Check, Ruler, Scale } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import type { KargoDenetimi } from "@/lib/kargo-denetim";

const para = (n: number) => n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tarih = (iso: string | number | null) =>
  iso == null || iso === ""
    ? "—"
    : new Date(iso).toLocaleDateString("tr-TR", { day: "numeric", month: "short", timeZone: "Europe/Istanbul" });
const gunEtiketi = (gun: string) =>
  gun ? new Date(`${gun}T12:00:00Z`).toLocaleDateString("tr-TR", { day: "numeric", month: "short", weekday: "short" }) : "—";
/** Trendyol damgası Türkiye duvar saatini taşıyor → UTC gibi okunur. */
const trendyolGunu = (ms: number | null) =>
  ms == null ? "—" : new Date(ms).toLocaleDateString("tr-TR", { day: "numeric", month: "short", weekday: "short", timeZone: "UTC" });

function Kopyala({ metin }: { metin: string }) {
  const [oldu, setOldu] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(metin).then(() => {
          setOldu(true);
          setTimeout(() => setOldu(false), 1200);
        });
      }}
      className="group inline-flex items-center gap-1 rounded px-1 py-0.5 tabular-nums transition-colors hover:bg-muted active:scale-95"
      title="Kopyala"
    >
      {metin}
      {oldu ? (
        <Check className="h-3 w-3 text-emerald-400 animate-in zoom-in-50 duration-200" />
      ) : (
        <Copy className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}

const DURUM: Record<string, { ad: string; cls: string }> = {
  gercek: { ad: "Kesildi", cls: "bg-red-500/15 text-red-300" },
  tahmini: { ad: "Kesilecek", cls: "bg-violet-500/15 text-violet-300" },
  kesilmedi: { ad: "Kesilmedi", cls: "bg-emerald-500/15 text-emerald-300" },
  muaf: { ad: "Muaf", cls: "bg-sky-500/15 text-sky-300" },
  zamaninda: { ad: "Zamanında", cls: "bg-emerald-500/15 text-emerald-300" },
};

function Ozet({ ikon: Ikon, baslik, adet, tutar, ton }: { ikon: typeof Ruler; baslik: string; adet: number; tutar: number; ton: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 transition-colors hover:border-primary/30 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", ton)}>
        <Ikon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{baslik}</p>
        <p className="text-sm font-semibold tabular-nums">
          {adet} sipariş ·{" "}
          <AnimatedNumber value={tutar} format={(n) => `${para(n)} ₺`} />
        </p>
      </div>
    </div>
  );
}

export function KargoDenetimiGorunumu() {
  const { data, isLoading, error, isFetching, refetch } = useQuery<KargoDenetimi>({
    queryKey: ["cargo-audit"],
    queryFn: () => fetchJson("/api/cargo-audit"),
    staleTime: 2 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-rose-300">Kargo denetimi yüklenemedi.</span>
        <button
          type="button"
          className="font-medium text-[#A9AEFF] hover:underline disabled:opacity-50"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Tekrar dene
        </button>
      </div>
    );
  }

  const cezalilar = data.gecikmeler.filter((g) => g.durum !== "zamaninda");

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <Ozet ikon={Ruler} baslik="Fazla desi kesilen" adet={data.fazlaDesi.length} tutar={data.toplamFazla} ton="bg-violet-500/15 text-violet-300" />
        <Ozet ikon={Clock} baslik="Gecikme bedeli" adet={cezalilar.filter((g) => g.ceza > 0 && (g.durum === "gercek" || g.durum === "tahmini")).length} tutar={data.toplamCeza} ton="bg-rose-500/15 text-rose-300" />
      </div>

      {/* FAZLA DESİ */}
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold">Fazla desi kesilen siparişler</h3>
          <p className="text-xs text-muted-foreground">Son 90 gün · ürün desisine göre beklenenden pahalı kesilenler.</p>
        </div>
        {data.fazlaDesi.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 p-4 text-sm text-muted-foreground animate-in fade-in duration-300">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            Fazla desi kesilen sipariş yok.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-[11px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Tarih</th>
                  <th className="px-3 py-2 text-left font-medium">Sipariş</th>
                  <th className="px-3 py-2 text-left font-medium">Paket no</th>
                  <th className="px-3 py-2 text-left font-medium">Ürün</th>
                  <th className="px-3 py-2 text-right font-medium">Desi</th>
                  <th className="px-3 py-2 text-right font-medium">Fazla</th>
                </tr>
              </thead>
              <tbody>
                {data.fazlaDesi.map((r, i) => (
                  <tr
                    key={`${r.platform}-${r.orderNumber}`}
                    style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
                    className="border-t border-border/40 transition-colors animate-in fade-in slide-in-from-left-1 fill-mode-backwards duration-300 hover:bg-muted/30"
                  >
                    <td className="px-3 py-1.5 text-muted-foreground">{tarih(r.orderedAt)}</td>
                    <td className="px-3 py-1.5">
                      <span className="mr-1 text-[10px] text-muted-foreground">{r.platform === "trendyol" ? "TY" : "HB"}</span>
                      <Kopyala metin={r.orderNumber} />
                    </td>
                    <td className="px-3 py-1.5">{r.paketNo ? <Kopyala metin={r.paketNo} /> : <span className="text-muted-foreground/50">—</span>}</td>
                    <td className="max-w-[16rem] truncate px-3 py-1.5" title={r.urunler}>{r.urunler}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.bizimDesi} → <span className="font-semibold text-red-300">{r.kesilenDesi}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-red-300">+{para(r.fazla)} ₺</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <p className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
            <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            {"Trendyol: Kargo İşlemleri → Desi İtiraz İşlemleri'nde paket numarasıyla itiraz et."}
          </p>
          <p className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
            <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            Hepsiburada: satıcı desteğinden ölçü fotoğrafıyla talep aç.
          </p>
        </div>
      </section>

      {/* GECİKMELER */}
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold">Geciken Trendyol siparişleri</h3>
          <p className="text-xs text-muted-foreground">Söz verilen günden sonraki ilk iş gününe kadar kargolanmayanlar.</p>
        </div>
        {cezalilar.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 p-4 text-sm text-muted-foreground animate-in fade-in duration-300">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            Geciken sipariş yok.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-[11px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Sipariş</th>
                  <th className="px-3 py-2 text-left font-medium">Son gün</th>
                  <th className="px-3 py-2 text-left font-medium">Kargoya verildi</th>
                  <th className="px-3 py-2 text-right font-medium">Bedel</th>
                  <th className="px-3 py-2 text-right font-medium">Durum</th>
                </tr>
              </thead>
              <tbody>
                {cezalilar.map((g, i) => {
                  const d = DURUM[g.durum] ?? DURUM.tahmini;
                  return (
                    <tr
                      key={g.orderNumber}
                      style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
                      className="border-t border-border/40 transition-colors animate-in fade-in slide-in-from-left-1 fill-mode-backwards duration-300 hover:bg-muted/30"
                    >
                      <td className="px-3 py-1.5"><Kopyala metin={g.orderNumber} /></td>
                      <td className="px-3 py-1.5">{gunEtiketi(g.sonGun)}</td>
                      <td className="px-3 py-1.5">
                        {g.kargolanmadi ? <span className="text-red-300">Henüz verilmedi</span> : trendyolGunu(g.kargolanma)}
                      </td>
                      <td className={cn("px-3 py-1.5 text-right tabular-nums", g.durum === "kesilmedi" || g.durum === "muaf" ? "text-muted-foreground line-through" : "font-semibold text-red-300")}>
                        {g.ceza > 0 ? `−${para(g.ceza)} ₺` : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", d.cls)}>{d.ad}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data.gecikmeFaturalari.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {"Trendyol'un kestiği: "}
            {data.gecikmeFaturalari.map((f) => `${tarih(f.tarih)} ${para(f.tutar)} ₺`).join(" · ")}
          </p>
        )}
      </section>
    </div>
  );
}
