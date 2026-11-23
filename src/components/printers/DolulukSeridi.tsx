"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import type { YaziciDolulugu } from "@/lib/yazici-doluluk";
import { DILIM_MS } from "@/lib/yazici-doluluk";

interface Yanit {
  gun: number;
  pencereDilim: number;
  olcumBaslangici: number | null;
  yazicilar: (YaziciDolulugu & { ad: string })[];
}

const DILIMLER: { anahtar: keyof Pick<YaziciDolulugu, "basiyor" | "bosta" | "sorun" | "cevrimdisi" | "bilinmiyor">; ad: string; renk: string }[] = [
  { anahtar: "basiyor", ad: "Bastı", renk: "linear-gradient(90deg, #9B5CFF, #4F8CFF)" },
  { anahtar: "bosta", ad: "Boşta", renk: "rgb(201 210 242 / 32%)" },
  { anahtar: "sorun", ad: "Durdu/hata", renk: "#FB7185" },
  { anahtar: "cevrimdisi", ad: "Çevrimdışı", renk: "rgb(120 128 150 / 45%)" },
  { anahtar: "bilinmiyor", ad: "Ölçülmedi", renk: "rgb(255 255 255 / 6%)" },
];

/**
 * SON 7 GÜN DOLULUK — yazıcı başına ne kadar bastı, ne kadar boşta kaldı (9 Eki 2026 denetimi).
 * Veri v0.19.249'dan itibaren birikiyor; ölçüm kısaysa bunu açıkça söyler.
 */
export function DolulukSeridi() {
  const { data, isError } = useQuery<Yanit>({
    queryKey: ["yazici-doluluk", 7],
    queryFn: ({ signal }) => fetchJson("/api/yazici-doluluk?gun=7", { signal }),
    // 7 günlük pencerede tek dilim %0,05 — 15 dakikada bir tazelemek gözle ayırt edilemez.
    staleTime: 15 * 60_000,
    refetchInterval: 15 * 60_000,
  });
  if (isError || !data || data.yazicilar.length === 0) return null;
  const olcumSaat = data.olcumBaslangici == null ? 0 : (data.pencereDilim * DILIM_MS) / 3_600_000;

  return (
    <section className="space-y-3 rounded-2xl bg-card px-5 py-4 ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 motion-reduce:animate-none">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[#9B5CFF]/25 to-[#4F8CFF]/20 text-[#C9D2F2] ring-1 ring-white/10">
          <Activity className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold tracking-tight">Son {data.gun} gün doluluk</span>
        <span className="text-[11px] text-muted-foreground">
          {data.olcumBaslangici == null
            ? "Ölçüm başladı — ilk veriler birkaç dakika içinde görünür"
            : olcumSaat < data.gun * 24 - 1
              ? `Ölçüm ${olcumSaat < 48 ? `${Math.max(1, Math.round(olcumSaat))} saattir` : `${Math.round(olcumSaat / 24)} gündür`} sürüyor`
              : "Masaüstü kapalıyken geçen süre “ölçülmedi” sayılır"}
        </span>
      </div>
      {data.olcumBaslangici != null && (
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {data.yazicilar.map((y, i) => {
            const toplam = Math.max(1, data.pencereDilim);
            return (
              <div key={y.printerConfigId} className="min-w-0 space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-medium">{y.ad}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {y.basmaOrani == null ? (
                      "veri yok"
                    ) : (
                      <>
                        <span className="font-semibold text-[#C9D2F2]">%{Math.round(y.basmaOrani * 100)}</span> bastı
                      </>
                    )}
                  </span>
                </div>
                <div
                  className="flex h-2 w-full origin-left overflow-hidden rounded-full bg-white/[0.05] [animation:panel-bar-fill_0.8s_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:[animation:none]"
                  style={{ animationDelay: `${120 + i * 70}ms` }}
                  role="img"
                  aria-label={DILIMLER.map((d) => `${d.ad} ${Math.round((y[d.anahtar] / toplam) * 100)}%`).join(", ")}
                >
                  {DILIMLER.map((d) =>
                    y[d.anahtar] > 0 ? (
                      <div
                        key={d.anahtar}
                        style={{ width: `${(y[d.anahtar] / toplam) * 100}%`, background: d.renk }}
                        title={`${d.ad}: ${Math.round((y[d.anahtar] * DILIM_MS) / 3_600_000)} sa`}
                      />
                    ) : null
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        {DILIMLER.map((d) => (
          <span key={d.anahtar} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ background: d.renk }} />
            {d.ad}
          </span>
        ))}
      </div>
    </section>
  );
}
