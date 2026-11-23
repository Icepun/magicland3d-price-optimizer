"use client";

import type { CSSProperties, ReactNode } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { Coins, Receipt, ShoppingBag, TrendingUp, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { usePageHidden, usePrefersReducedMotion } from "@/lib/client-state";
import type { AyOzeti, TrendNoktasi } from "@/app/reports/rapor-gorunum";
import { Adet, DegisimRozeti, Para } from "./rapor-ortak";

/** Net kâr ana kartı + ciro / sipariş kârı / gider / sipariş kutuları. */
export function RaporOzet({
  ozet,
  donem,
  trend,
}: {
  ozet: AyOzeti;
  /** "1–23 Kasım" / "Ekim 2026". */
  donem: string;
  trend: TrendNoktasi[];
}) {
  const { ay, kiyas, tahmin, ilerleme } = ozet;
  const reduce = usePrefersReducedMotion();
  const gizli = usePageHidden();
  const animasyon = !reduce && !gizli;
  const negatif = ay.netProfit < 0;
  const sparkVeri = trend.slice(-8).map((t) => ({ k: t.anahtar, v: t.netKar }));
  const gecenOran = ilerleme?.ongoing ? ilerleme.elapsed / ilerleme.totalDays : null;

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      {/* NET KÂR */}
      <section
        className={cn(
          "relative overflow-hidden rounded-2xl p-5 lg:col-span-2",
          "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(155,92,255,0.28),transparent_55%),radial-gradient(120%_120%_at_100%_100%,rgba(79,140,255,0.22),transparent_55%)] bg-card",
          "ring-1 ring-white/10 shadow-[0_30px_60px_-40px_rgba(122,126,255,0.6)]",
          "animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 motion-reduce:animate-none"
        )}
      >
        <div className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-[#7A7EFF]/15 blur-3xl" />
        <div className="relative flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-[#C9D2F2]/80">
              <Wallet className="size-3.5" /> Net kâr
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{donem}</p>
          </div>
          <DegisimRozeti degisim={kiyas.netKar} />
        </div>
        <Para
          deger={ay.netProfit}
          className={cn(
            "relative mt-3 block text-4xl font-semibold tracking-tight sm:text-5xl",
            negatif ? "text-rose-300" : "bg-gradient-to-r from-white to-[#C9D2F2] bg-clip-text text-transparent"
          )}
        />
        <p className="relative mt-2 text-xs text-muted-foreground">
          Sipariş kârı <span className="tabular-nums text-foreground/80">{formatCurrency(ay.orderProfit, { decimals: 0 })}</span>
          {" − "}giderler <span className="tabular-nums text-foreground/80">{formatCurrency(ay.expenses, { decimals: 0 })}</span>
          {kiyas.etiket && <span className="text-muted-foreground/70"> · {kiyas.etiket} ile kıyas</span>}
        </p>

        {sparkVeri.length > 1 && (
          <div className="relative -mx-1 mt-3 h-14">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={sparkVeri} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <defs>
                  <linearGradient id="rapor-spark" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#9B8CFF" stopOpacity={0.55} />
                    <stop offset="100%" stopColor="#4F8CFF" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="#A9AEFF"
                  strokeWidth={2}
                  fill="url(#rapor-spark)"
                  isAnimationActive={animasyon}
                  animationDuration={900}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {gecenOran != null && (
          <div className="relative mt-3 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{ilerleme?.elapsedDays} / {ilerleme?.totalDays} gün</span>
              {tahmin.netKar != null && (
                <span>
                  Ay sonu tahmini{" "}
                  <span className="font-medium tabular-nums text-foreground/85">
                    ≈ {formatCurrency(tahmin.netKar, { decimals: 0 })}
                  </span>
                </span>
              )}
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full origin-left rounded-full bg-gradient-to-r from-[#9B5CFF] to-[#4F8CFF] [animation:panel-bar-fill_0.9s_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:[animation:none]"
                style={{ width: `${gecenOran * 100}%` }}
              />
            </div>
          </div>
        )}
      </section>

      {/* KUTULAR */}
      <div className="grid grid-cols-2 gap-4 lg:col-span-3">
        <Kutu
          sira={1}
          ikon={<TrendingUp className="size-4" />}
          baslik="Ciro"
          deger={<Para deger={ay.revenue} />}
          rozet={<DegisimRozeti degisim={kiyas.ciro} />}
          alt={tahmin.ciro != null ? `Ay sonu ≈ ${formatCurrency(tahmin.ciro, { decimals: 0 })}` : `${formatNumber(ay.orderCount)} siparişten`}
        />
        <Kutu
          sira={2}
          ikon={<Coins className="size-4" />}
          baslik="Sipariş kârı"
          deger={<Para deger={ay.orderProfit} className={ay.orderProfit < 0 ? "text-rose-300" : undefined} />}
          rozet={<DegisimRozeti degisim={kiyas.siparisKari} />}
          alt={ozet.marj != null ? `Marj ${formatPercent(ozet.marj, 1)}` : "Ciro yok"}
          vurgu={ozet.marj}
        />
        <Kutu
          sira={3}
          ikon={<Receipt className="size-4" />}
          baslik="Giderler"
          deger={<Para deger={ay.expenses} />}
          rozet={<DegisimRozeti degisim={kiyas.gider} yuksekIyi={false} />}
          alt={ay.revenue > 0 ? `Ciroya oranı ${formatPercent(ay.expenses / ay.revenue, 1)}` : "Ödenen giderler"}
        />
        <Kutu
          sira={4}
          ikon={<ShoppingBag className="size-4" />}
          baslik="Sipariş"
          deger={<Adet deger={ay.orderCount} />}
          rozet={<DegisimRozeti degisim={kiyas.siparis} tur="adet" />}
          alt={ozet.ortalamaSepet != null ? `Ortalama sepet ${formatCurrency(ozet.ortalamaSepet, { decimals: 0 })}` : "Sipariş yok"}
        />
      </div>
    </div>
  );
}

function Kutu({
  ikon,
  baslik,
  deger,
  rozet,
  alt,
  vurgu,
  sira,
}: {
  ikon: ReactNode;
  baslik: string;
  deger: ReactNode;
  rozet?: ReactNode;
  alt: string;
  /** 0–1 arası oran verilirse altta ince bir marj çubuğu. */
  vurgu?: number | null;
  sira: number;
}) {
  return (
    <div
      className={cn(
        "group relative flex flex-col justify-between overflow-hidden rounded-2xl bg-card p-4 ring-1 ring-white/[0.07]",
        "transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:ring-white/[0.12] hover:shadow-[0_20px_40px_-30px_rgba(122,126,255,0.55)]",
        "animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 motion-reduce:animate-none motion-reduce:hover:translate-y-0"
      )}
      style={{ animationDelay: `${sira * 70}ms` } as CSSProperties}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="grid size-7 place-items-center rounded-lg bg-white/[0.05] text-[#C9D2F2] ring-1 ring-white/[0.08] transition-colors group-hover:bg-[#7A7EFF]/15">
            {ikon}
          </span>
          {baslik}
        </span>
        {rozet}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight sm:text-[1.7rem]">{deger}</div>
      <p className="mt-1 truncate text-xs text-muted-foreground">{alt}</p>
      {vurgu != null && Number.isFinite(vurgu) && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full origin-left rounded-full bg-emerald-400/70 transition-[width] duration-500 [animation:panel-bar-fill_0.8s_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:[animation:none]"
            style={{ width: `${Math.max(0, Math.min(1, vurgu)) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
