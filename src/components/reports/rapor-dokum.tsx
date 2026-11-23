"use client";

import { Fragment, type CSSProperties } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatPercent } from "@/lib/format";
import type { Selale, SelaleSatiri } from "@/app/reports/rapor-gorunum";
import { RaporKart } from "./rapor-ortak";

const RENK: Record<SelaleSatiri["tur"], string> = {
  baslangic: "linear-gradient(90deg,#9B5CFF,#4F8CFF)",
  kesinti: "rgba(251,113,133,0.62)",
  notr: "repeating-linear-gradient(135deg,rgba(148,163,184,0.45) 0 6px,rgba(148,163,184,0.2) 6px 12px)",
  ara: "linear-gradient(90deg,#A9AEFF,#7A7EFF)",
  sonuc: "linear-gradient(90deg,#34D399,#10B981)",
};

/** Ciro → kesintiler → sipariş kârı → iade/gider → net kâr (yatay şelale). */
export function RaporDokum({
  selale,
  yukleniyor,
  hata,
  onYenile,
  sira,
  className,
}: {
  selale: Selale | null;
  yukleniyor: boolean;
  hata: boolean;
  onYenile: () => void;
  sira?: number;
  className?: string;
}) {
  return (
    <RaporKart
      baslik="Kâr nereye gitti"
      aciklama="Cirodan net kâra her kesinti"
      ikon={<GitBranch className="size-4" />}
      sira={sira}
      className={className}
    >
      {selale ? (
        <Govde selale={selale} />
      ) : hata ? (
        <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
          Döküm şu an hesaplanamadı.
          <button
            type="button"
            onClick={onYenile}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-foreground ring-1 ring-white/10 transition hover:bg-white/[0.1] active:scale-[0.98]"
          >
            <RefreshCw className="size-3.5" /> Tekrar dene
          </button>
        </div>
      ) : (
        <Iskelet yukleniyor={yukleniyor} />
      )}
    </RaporKart>
  );
}

/** Her satırın çubuk konumu (ciroya oranla): kesinti, kalan tutarın sağ ucundan sola düşer. */
function konumlar(satirlar: readonly SelaleSatiri[]): { sol: number; genislik: number }[] {
  const ciro = satirlar[0]?.amount ?? 0;
  let kalan = ciro;
  return satirlar.map((s) => {
    if (ciro <= 0) return { sol: 0, genislik: 0 };
    if (s.tur === "kesinti" || s.tur === "notr") {
      kalan -= s.amount;
      return { sol: Math.max(0, kalan / ciro), genislik: Math.abs(s.amount) / ciro };
    }
    if (s.tur === "ara" || s.tur === "sonuc") {
      kalan = s.amount;
      return { sol: 0, genislik: Math.max(0, s.amount) / ciro };
    }
    return { sol: 0, genislik: Math.abs(s.amount) / ciro };
  });
}

function Govde({ selale }: { selale: Selale }) {
  const yer = konumlar(selale.satirlar);
  return (
    <div className="space-y-1">
      {selale.satirlar.map((s, i) => {
        const { sol, genislik } = yer[i];
        // Eksi tutarlı kesinti (kayıtlı kâr motorun hesabından yüksek) kâra eklenmiş demektir.
        const kazanc = s.tur === "kesinti" && s.amount < 0;
        const eksi = (s.tur === "kesinti" || s.tur === "notr") && !kazanc;
        const vurgu = s.tur === "ara" || s.tur === "sonuc" || s.tur === "baslangic";
        const negatifSonuc = s.tur === "sonuc" && s.amount < 0;
        return (
          <Fragment key={s.key}>
            {s.tur === "ara" && <div className="my-1.5 h-px bg-white/[0.06]" />}
            <div
              className={cn(
                "group grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04]",
                "animate-in fade-in slide-in-from-left-2 fill-mode-both duration-500 motion-reduce:animate-none",
                s.tur === "sonuc" && "mt-1 bg-white/[0.03] ring-1 ring-white/[0.06]"
              )}
              style={{ animationDelay: `${i * 45}ms` } as CSSProperties}
              title={s.oran != null ? `Ciroya oranı ${formatPercent(Math.abs(s.oran), 1)}` : undefined}
            >
              <span className={cn("truncate text-xs", vurgu ? "font-semibold text-foreground" : "text-muted-foreground")}>
                {s.label}
              </span>
              <div className="relative h-2.5 overflow-hidden rounded-full bg-white/[0.05]">
                <div
                  className="absolute inset-y-0 rounded-full transition-[left,width] duration-700 ease-out [animation:panel-bar-fill_0.8s_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:[animation:none]"
                  style={{
                    left: `${sol * 100}%`,
                    width: `${Math.min(1, genislik) * 100}%`,
                    background: negatifSonuc ? "rgba(251,113,133,0.75)" : RENK[s.tur],
                    transformOrigin: eksi ? "right" : "left",
                    animationDelay: `${120 + i * 45}ms`,
                  }}
                />
              </div>
              <span className="flex min-w-[7.5rem] items-baseline justify-end gap-1.5 text-right">
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    eksi && "text-rose-200/90",
                    kazanc && "text-emerald-300/90",
                    s.tur === "notr" && "text-slate-300/80",
                    vurgu && "text-sm font-semibold",
                    s.tur === "sonuc" && (negatifSonuc ? "text-rose-300" : "text-emerald-300")
                  )}
                >
                  {kazanc ? "+" : eksi || s.amount < 0 ? "−" : ""}
                  {formatCurrency(Math.abs(s.amount), { decimals: 0 })}
                </span>
                {s.oran != null && s.tur !== "baslangic" && (
                  <span className="w-10 text-[10px] tabular-nums text-muted-foreground/70">
                    {formatPercent(Math.abs(s.oran), 0)}
                  </span>
                )}
              </span>
            </div>
          </Fragment>
        );
      })}
      {selale.satirlar.some((s) => s.tur === "notr") && (
        <p className="px-2 pt-2 text-[11px] text-muted-foreground/80">
          Çizgili satır: maliyeti girilmemiş ürünlerin satışı — kâra katılmadı.
        </p>
      )}
    </div>
  );
}

function Iskelet({ yukleniyor }: { yukleniyor: boolean }) {
  return (
    <div className="space-y-2.5">
      {yukleniyor && (
        <div className="mb-3 space-y-1.5">
          <p className="text-xs text-muted-foreground">Kesintiler hesaplanıyor…</p>
          <div className="relative h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-[#7A7EFF] to-transparent [animation:indeterminate-bar_1.4s_ease-in-out_infinite] motion-reduce:[animation:none]" />
          </div>
        </div>
      )}
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-3 px-2">
          <div className="h-3 w-24 animate-pulse rounded bg-white/[0.06]" style={{ animationDelay: `${i * 80}ms` }} />
          <div className="h-2.5 animate-pulse rounded-full bg-white/[0.05]" style={{ animationDelay: `${i * 80}ms` }} />
          <div className="h-3 w-20 animate-pulse rounded bg-white/[0.06]" style={{ animationDelay: `${i * 80}ms` }} />
        </div>
      ))}
    </div>
  );
}
