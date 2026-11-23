"use client";

import { useState, type CSSProperties } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { Store } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCompactCurrency, formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { usePageHidden, usePrefersReducedMotion } from "@/lib/client-state";
import { PlatformLogo } from "@/components/PlatformLogo";
import type { PlatformAnahtari, PlatformSatiri } from "@/app/reports/rapor-gorunum";
import { BosDurum, DolanCubuk, RaporKart } from "./rapor-ortak";

/** Marka renkleri yerine uygulamanın paleti (turuncu yok). */
export const PLATFORM_RENGI: Record<PlatformAnahtari, string> = {
  trendyol: "#F27A1A", // Trendyol marka turuncusu — Berke: "trendyol her yerde turuncu olmalı"
  hepsiburada: "#4F8CFF",
  shopify: "#34D399",
  manual: "#C9D2F2",
};

export function RaporPlatformlar({
  satirlar,
  sira,
  className,
}: {
  satirlar: PlatformSatiri[];
  sira?: number;
  className?: string;
}) {
  const reduce = usePrefersReducedMotion();
  const gizli = usePageHidden();
  const animasyon = !reduce && !gizli;
  const [odak, setOdak] = useState<PlatformAnahtari | null>(null);
  const toplam = satirlar.reduce((t, s) => t + s.ciro, 0);
  const odakSatiri = satirlar.find((s) => s.platform === odak) ?? null;

  return (
    <RaporKart
      baslik="Platformlar"
      aciklama="Ciro payı, kâr ve marj"
      ikon={<Store className="size-4" />}
      sira={sira}
      className={className}
    >
      {satirlar.length === 0 ? (
        <BosDurum metin="Bu ay satış yok." />
      ) : (
        // Kart darsa (yan sütun) halka üstte, satırlar tam genişlikte — rakamlar ikiye kırılmasın.
        <div className="@container">
        <div className="flex flex-col gap-5 @[36rem]:flex-row @[36rem]:items-center">
          <div className="relative mx-auto size-40 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={satirlar}
                  dataKey="ciro"
                  nameKey="ad"
                  innerRadius="68%"
                  outerRadius="100%"
                  paddingAngle={satirlar.length > 1 ? 2.5 : 0}
                  stroke="none"
                  isAnimationActive={animasyon}
                  animationDuration={800}
                  onMouseEnter={(_, i) => setOdak(satirlar[i]?.platform ?? null)}
                  onMouseLeave={() => setOdak(null)}
                >
                  {satirlar.map((s) => (
                    <Cell
                      key={s.platform}
                      fill={PLATFORM_RENGI[s.platform]}
                      fillOpacity={odak == null || odak === s.platform ? 1 : 0.35}
                      style={{ transition: "fill-opacity 200ms ease", outline: "none" }}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
              <div className="animate-in fade-in duration-300" key={odak ?? "toplam"}>
                <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  {odakSatiri ? odakSatiri.ad : "Toplam"}
                </p>
                <p className="text-base font-semibold tabular-nums">
                  {formatCompactCurrency(odakSatiri ? odakSatiri.ciro : toplam)}
                </p>
                {odakSatiri && (
                  <p className="text-[10px] tabular-nums text-muted-foreground">{formatPercent(odakSatiri.pay, 0)}</p>
                )}
              </div>
            </div>
          </div>

          <ul className="min-w-0 flex-1 space-y-1">
            {satirlar.map((s, i) => (
              <li
                key={s.platform}
                onMouseEnter={() => setOdak(s.platform)}
                onMouseLeave={() => setOdak(null)}
                className={cn(
                  "rounded-xl px-2.5 py-2 transition-colors duration-200",
                  odak === s.platform ? "bg-white/[0.05]" : "hover:bg-white/[0.03]",
                  "animate-in fade-in slide-in-from-right-2 fill-mode-both duration-500 motion-reduce:animate-none"
                )}
                style={{ animationDelay: `${i * 60}ms` } as CSSProperties}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="grid size-7 shrink-0 place-items-center rounded-lg ring-1 ring-white/10"
                    style={{ background: `${PLATFORM_RENGI[s.platform]}22`, color: PLATFORM_RENGI[s.platform] }}
                  >
                    <PlatformLogo platform={s.platform} className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">{s.ad}</span>
                      <span className="text-sm font-semibold tabular-nums">{formatCurrency(s.ciro, { decimals: 0 })}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span className="tabular-nums">
                        {formatNumber(s.siparis)} sipariş
                        {s.ortalamaSepet != null && ` · ort. ${formatCurrency(s.ortalamaSepet, { decimals: 0 })}`}
                      </span>
                      <span className={cn("tabular-nums", s.kar < 0 ? "text-rose-300" : "text-emerald-300/90")}>
                        {formatCurrency(s.kar, { decimals: 0 })}
                        {s.marj != null && <span className="text-muted-foreground"> · {formatPercent(s.marj, 0)}</span>}
                      </span>
                    </div>
                  </div>
                </div>
                <DolanCubuk oran={s.pay} renk={PLATFORM_RENGI[s.platform]} className="mt-2" gecikme={150 + i * 60} />
              </li>
            ))}
          </ul>
        </div>
        </div>
      )}
    </RaporKart>
  );
}
