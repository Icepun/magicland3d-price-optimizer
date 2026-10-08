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
  { anahtar: "basiyor", ad: "Bastı", renk: "var(--status-printing, oklch(0.62 0.20 278))" },
  { anahtar: "bosta", ad: "Boşta", renk: "oklch(0.70 0.02 265 / 55%)" },
  { anahtar: "sorun", ad: "Durdu/hata", renk: "oklch(0.75 0.16 60)" },
  { anahtar: "cevrimdisi", ad: "Çevrimdışı", renk: "oklch(0.45 0.02 265 / 70%)" },
  { anahtar: "bilinmiyor", ad: "Ölçülmedi", renk: "oklch(0.50 0.01 265 / 22%)" },
];

/**
 * SON 7 GÜN DOLULUK — yazıcı başına ne kadar bastı, ne kadar boşta kaldı (9 Eki 2026 denetimi).
 * Veri v0.19.249'dan itibaren birikiyor; ölçüm kısaysa bunu açıkça söyler.
 */
export function DolulukSeridi() {
  const { data, isError } = useQuery<Yanit>({
    queryKey: ["yazici-doluluk", 7],
    queryFn: ({ signal }) => fetchJson("/api/yazici-doluluk?gun=7", { signal }),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
  if (isError || !data || data.yazicilar.length === 0) return null;
  const olcumSaat = data.olcumBaslangici == null ? 0 : (data.pencereDilim * DILIM_MS) / 3_600_000;

  return (
    <div className="rounded-xl border bg-card px-4 py-3 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Son {data.gun} gün doluluk</span>
        <span className="text-[11px] text-muted-foreground">
          {data.olcumBaslangici == null
            ? "Ölçüm başladı — ilk veriler birkaç dakika içinde görünür"
            : olcumSaat < data.gun * 24 - 1
              ? `Ölçüm ${olcumSaat < 48 ? `${Math.max(1, Math.round(olcumSaat))} saattir` : `${Math.round(olcumSaat / 24)} gündür`} sürüyor`
              : "Masaüstü kapalıyken geçen süre “ölçülmedi” sayılır"}
        </span>
      </div>
      {data.olcumBaslangici != null && (
        <div className="grid gap-2 sm:grid-cols-2">
          {data.yazicilar.map((y) => {
            const toplam = Math.max(1, data.pencereDilim);
            return (
              <div key={y.printerConfigId} className="min-w-0 space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-medium">{y.ad}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {y.basmaOrani == null ? "veri yok" : `%${Math.round(y.basmaOrani * 100)} bastı`}
                  </span>
                </div>
                <div
                  className="flex h-2 w-full overflow-hidden rounded-full bg-muted/40"
                  role="img"
                  aria-label={DILIMLER.map((d) => `${d.ad} ${Math.round((y[d.anahtar] / toplam) * 100)}%`).join(", ")}
                >
                  {DILIMLER.map((d) =>
                    y[d.anahtar] > 0 ? (
                      <div
                        key={d.anahtar}
                        style={{ width: `${(y[d.anahtar] / toplam) * 100}%`, backgroundColor: d.renk }}
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
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: d.renk }} />
            {d.ad}
          </span>
        ))}
      </div>
    </div>
  );
}
