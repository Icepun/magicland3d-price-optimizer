"use client";

import type { CSSProperties, ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { deltaTone, type StatDelta } from "@/app/reports/reports-view";

/** Raporlar'ın bölüm kartı — sırayla belirir (gecikme `sira` ile). */
export function RaporKart({
  baslik,
  aciklama,
  ikon,
  sag,
  sira = 0,
  className,
  children,
}: {
  baslik: string;
  aciklama?: ReactNode;
  ikon?: ReactNode;
  sag?: ReactNode;
  sira?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "group/rk relative flex flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-white/[0.07]",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)]",
        "transition-[box-shadow,transform] duration-300 hover:ring-white/[0.11]",
        "animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 motion-reduce:animate-none",
        className
      )}
      style={{ animationDelay: `${sira * 70}ms` } as CSSProperties}
    >
      <header className="flex items-start justify-between gap-3 px-5 pt-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {ikon && (
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[#9B5CFF]/25 to-[#4F8CFF]/20 text-[#C9D2F2] ring-1 ring-white/10">
              {ikon}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight">{baslik}</h2>
            {aciklama && <p className="truncate text-xs text-muted-foreground">{aciklama}</p>}
          </div>
        </div>
        {sag}
      </header>
      <div className="flex-1 px-5 pb-5 pt-4">{children}</div>
    </section>
  );
}

/** Akan TL tutarı (kuruşsuz). */
export function Para({ deger, kurus = false, className }: { deger: number; kurus?: boolean; className?: string }) {
  return (
    <AnimatedNumber
      value={deger}
      className={cn("tabular-nums", className)}
      format={(n) => formatCurrency(n, { decimals: kurus ? 2 : 0 })}
    />
  );
}

/** Akan adet. */
export function Adet({ deger, className }: { deger: number; className?: string }) {
  return <AnimatedNumber value={deger} className={cn("tabular-nums", className)} format={(n) => formatNumber(Math.round(n))} />;
}

const TON: Record<"good" | "bad" | "neutral", string> = {
  good: "bg-emerald-500/12 text-emerald-300 ring-emerald-400/20",
  bad: "bg-rose-500/12 text-rose-300 ring-rose-400/20",
  neutral: "bg-white/[0.06] text-muted-foreground ring-white/10",
};

/** Önceki döneme göre değişim rozeti. `yuksekIyi=false` → artış kötü (gider). */
export function DegisimRozeti({
  degisim,
  yuksekIyi = true,
  tur = "para",
  className,
}: {
  degisim: StatDelta | null;
  yuksekIyi?: boolean;
  tur?: "para" | "adet";
  className?: string;
}) {
  // İki taraf da sıfır: söylenecek bir değişim yok.
  if (!degisim || (degisim.diff === 0 && degisim.ratio == null)) return null;
  const ton = deltaTone(degisim.diff, yuksekIyi);
  const Ok = degisim.diff > 0 ? ArrowUpRight : degisim.diff < 0 ? ArrowDownRight : Minus;
  const fark = tur === "para" ? formatCurrency(Math.abs(degisim.diff), { decimals: 0 }) : formatNumber(Math.abs(degisim.diff));
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ring-1",
        TON[ton],
        className
      )}
    >
      <Ok className="size-3" />
      {degisim.ratio != null ? formatPercent(Math.abs(degisim.ratio), 0) : fark}
    </span>
  );
}

/** İnce, dolarak gelen yatay çubuk (0–1). */
export function DolanCubuk({
  oran,
  renk,
  className,
  gecikme = 0,
}: {
  oran: number;
  renk: string;
  className?: string;
  gecikme?: number;
}) {
  const w = Math.max(0, Math.min(1, Number.isFinite(oran) ? oran : 0));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]", className)}>
      <div
        className="h-full origin-left rounded-full transition-[width] duration-500 ease-out [animation:panel-bar-fill_0.7s_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:[animation:none]"
        style={{ width: `${w * 100}%`, background: renk, animationDelay: `${gecikme}ms` }}
      />
    </div>
  );
}

/** Boş bölüm için sade, olumlu bir satır. */
export function BosDurum({ ikon, metin }: { ikon?: ReactNode; metin: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-sm text-muted-foreground">
      {ikon && <span className="text-muted-foreground/60">{ikon}</span>}
      {metin}
    </div>
  );
}
