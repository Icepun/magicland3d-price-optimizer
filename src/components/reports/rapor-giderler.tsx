"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, PackageX, Receipt, ShieldCheck, Timer, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import type { GiderSatiri } from "@/app/reports/rapor-gorunum";
import { BosDurum, Para, RaporKart } from "./rapor-ortak";

/** Ödeme ayına göre giderler — kategori payları. */
export function RaporGiderler({
  satirlar,
  toplam,
  sira,
  className,
}: {
  satirlar: GiderSatiri[];
  toplam: number;
  sira?: number;
  className?: string;
}) {
  return (
    <RaporKart
      baslik="Giderler"
      aciklama="Bu ay ödenenler"
      ikon={<Receipt className="size-4" />}
      sira={sira}
      className={className}
      sag={
        <Link
          href="/expenses"
          className="group inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground"
        >
          Giderler <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
        </Link>
      }
    >
      {satirlar.length === 0 ? (
        <BosDurum metin="Bu ay gider ödemesi yok." />
      ) : (
        <>
          <div className="flex items-baseline justify-between">
            <Para deger={toplam} className="text-2xl font-semibold tracking-tight" />
            <span className="text-xs text-muted-foreground">{formatNumber(satirlar.reduce((t, s) => t + s.adet, 0))} ödeme</span>
          </div>
          {/* Kategori payları tek şeritte */}
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-white/[0.05]">
            {satirlar.map((s, i) => (
              <div
                key={s.kategori}
                className="h-full origin-left transition-[width] duration-500 first:rounded-l-full last:rounded-r-full [animation:panel-bar-fill_0.7s_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:[animation:none]"
                style={{ width: `${s.pay * 100}%`, background: s.renk, animationDelay: `${i * 80}ms` }}
                title={`${s.kategori} · ${formatPercent(s.pay, 0)}`}
              />
            ))}
          </div>
          <ul className="mt-3 space-y-1">
            {satirlar.slice(0, 6).map((s, i) => (
              <li
                key={s.kategori}
                className="flex items-center justify-between gap-3 rounded-lg px-1.5 py-1 text-xs transition-colors hover:bg-white/[0.04] animate-in fade-in fill-mode-both duration-500 motion-reduce:animate-none"
                style={{ animationDelay: `${120 + i * 50}ms` } as CSSProperties}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.renk }} />
                  <span className="truncate">{s.kategori}</span>
                </span>
                <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                  <span className="font-medium">{formatCurrency(s.tutar, { decimals: 0 })}</span>
                  <span className="w-8 text-right text-[10px] text-muted-foreground">{formatPercent(s.pay, 0)}</span>
                </span>
              </li>
            ))}
            {satirlar.length > 6 && (
              <li className="px-1.5 text-[11px] text-muted-foreground">+{satirlar.length - 6} kategori daha</li>
            )}
          </ul>
        </>
      )}
    </RaporKart>
  );
}

/** İade zararı ve pazaryeri cezaları. */
export function RaporKayiplar({
  iade,
  iadeAdet,
  ceza,
  cezaAdet,
  sira,
  className,
}: {
  iade: number;
  iadeAdet: number;
  ceza: number;
  cezaAdet: number;
  sira?: number;
  className?: string;
}) {
  const bos = iade <= 0 && ceza <= 0;
  return (
    <RaporKart
      baslik="İade ve cezalar"
      aciklama="Kârdan düşülenler"
      ikon={<Undo2 className="size-4" />}
      sira={sira}
      className={className}
      sag={
        <Link
          href="/cargo-rules?sekme=denetim"
          className="group inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground"
        >
          Denetim <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
        </Link>
      }
    >
      {bos ? (
        <div className="flex items-center gap-3 rounded-xl bg-emerald-500/[0.06] px-4 py-4 text-sm text-emerald-100/90 ring-1 ring-emerald-400/15">
          <ShieldCheck className="size-5 shrink-0 text-emerald-300" />
          Bu ay iade zararı ve ceza yok.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Kalem ikon={<PackageX className="size-4" />} baslik="İade zararı" tutar={iade} adet={iadeAdet} birim="iade" />
          <Kalem ikon={<Timer className="size-4" />} baslik="Ceza" tutar={ceza} adet={cezaAdet} birim="sipariş" />
        </div>
      )}
    </RaporKart>
  );
}

function Kalem({
  ikon,
  baslik,
  tutar,
  adet,
  birim,
}: {
  ikon: ReactNode;
  baslik: string;
  tutar: number;
  adet: number;
  birim: string;
}) {
  const var_ = tutar > 0;
  return (
    <div
      className={cn(
        "rounded-xl p-3 ring-1 transition-colors",
        var_ ? "bg-rose-500/[0.06] ring-rose-400/15" : "bg-white/[0.03] ring-white/[0.06]"
      )}
    >
      <p className={cn("flex items-center gap-1.5 text-xs", var_ ? "text-rose-200/90" : "text-muted-foreground")}>
        {ikon}
        {baslik}
      </p>
      <p className={cn("mt-2 text-lg font-semibold tabular-nums", var_ ? "text-rose-200" : "text-muted-foreground")}>
        {var_ ? "−" : ""}
        <Para deger={tutar} />
      </p>
      <p className="text-[11px] text-muted-foreground">{var_ ? `${formatNumber(adet)} ${birim}` : "Yok"}</p>
    </div>
  );
}
