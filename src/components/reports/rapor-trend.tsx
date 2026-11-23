"use client";

import { useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCompactCurrency, formatCurrency } from "@/lib/format";
import { usePageHidden, usePrefersReducedMotion } from "@/lib/client-state";
import type { TrendNoktasi } from "@/app/reports/rapor-gorunum";
import type { WeeklyBucket } from "@/app/reports/reports-view";
import { RaporKart } from "./rapor-ortak";

type Kip = "ay" | "hafta";

export function RaporTrend({
  aylar,
  haftalar,
  secili,
  onSec,
  sira,
  className,
}: {
  aylar: TrendNoktasi[];
  haftalar: WeeklyBucket[];
  secili: string;
  onSec: (month: string) => void;
  sira?: number;
  className?: string;
}) {
  const [kip, setKip] = useState<Kip>("ay");
  const reduce = usePrefersReducedMotion();
  // Recharts rAF ile büyütür; gizli pencerede kare gelmez ve çubuk sıfırda kalırdı.
  const gizli = usePageHidden();
  const animasyon = !reduce && !gizli;
  const veri: TrendNoktasi[] =
    kip === "ay"
      ? aylar
      : haftalar.map((h) => ({
          anahtar: h.week,
          etiket: h.label,
          ciro: h.revenue,
          netKar: h.netProfit,
          siparisKari: h.orderProfit,
          suruyor: h.ongoing,
        }));

  return (
    <RaporKart
      baslik="Ciro ve net kâr"
      aciklama={kip === "ay" ? "Bir aya tıkla, rapor o aya geçsin" : "Son 12 hafta"}
      ikon={<BarChart3 className="size-4" />}
      sira={sira}
      className={className}
      sag={
        <div className="flex rounded-lg bg-white/[0.05] p-0.5 ring-1 ring-white/[0.08]">
          {(["ay", "hafta"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKip(k)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-200",
                kip === k
                  ? "bg-[#7A7EFF] text-white shadow-[0_6px_16px_-8px_rgba(122,126,255,0.9)]"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {k === "ay" ? "Aylık" : "Haftalık"}
            </button>
          ))}
        </div>
      }
    >
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={veri} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="22%">
            <defs>
              <linearGradient id="rapor-ciro" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#8B8FFF" stopOpacity={0.95} />
                <stop offset="100%" stopColor="#4F8CFF" stopOpacity={0.55} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="etiket"
              tickLine={false}
              axisLine={false}
              tick={{ fill: "rgba(201,210,242,0.65)", fontSize: 11 }}
              interval={kip === "hafta" ? 1 : 0}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={52}
              tick={{ fill: "rgba(201,210,242,0.5)", fontSize: 11 }}
              tickFormatter={(v: number) => formatCompactCurrency(v)}
            />
            <Tooltip cursor={{ fill: "rgba(122,126,255,0.08)" }} content={<Ipucu />} />
            <Bar
              dataKey="ciro"
              name="Ciro"
              radius={[6, 6, 2, 2]}
              isAnimationActive={animasyon}
              animationDuration={700}
              onClick={(d: { payload?: TrendNoktasi }) => {
                if (kip === "ay" && d?.payload) onSec(d.payload.anahtar);
              }}
              className={kip === "ay" ? "cursor-pointer" : undefined}
            >
              {veri.map((n) => {
                const aktif = kip === "hafta" || n.anahtar === secili;
                return (
                  <Cell
                    key={n.anahtar}
                    fill="url(#rapor-ciro)"
                    fillOpacity={aktif ? 1 : 0.38}
                    stroke={n.suruyor ? "#A9AEFF" : "none"}
                    strokeDasharray={n.suruyor ? "4 3" : undefined}
                    strokeWidth={n.suruyor ? 1.5 : 0}
                    style={{ transition: "fill-opacity 250ms ease" }}
                  />
                );
              })}
            </Bar>
            <Line
              type="monotone"
              dataKey="netKar"
              name="Net kâr"
              stroke="#34D399"
              strokeWidth={2.5}
              dot={{ r: 3, fill: "#34D399", strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              isAnimationActive={animasyon}
              animationDuration={900}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-gradient-to-b from-[#8B8FFF] to-[#4F8CFF]" /> Ciro
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-emerald-400" /> Net kâr
        </span>
        {veri.some((n) => n.suruyor) && (
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm border border-dashed border-[#A9AEFF]" /> Devam ediyor
          </span>
        )}
      </div>
    </RaporKart>
  );
}

function Ipucu({ active, payload }: { active?: boolean; payload?: Array<{ payload: TrendNoktasi }> }) {
  if (!active || !payload?.length) return null;
  const n = payload[0].payload;
  const marj = n.ciro > 0 ? n.siparisKari / n.ciro : null;
  return (
    <div className="min-w-44 rounded-xl bg-[#0E1220]/95 px-3 py-2.5 text-xs shadow-xl ring-1 ring-white/10 backdrop-blur">
      <p className="mb-1.5 font-medium text-foreground">
        {n.etiket}
        {n.suruyor && <span className="ml-1.5 text-[10px] text-muted-foreground">devam ediyor</span>}
      </p>
      <Satir renk="#7A7EFF" ad="Ciro" deger={formatCurrency(n.ciro, { decimals: 0 })} />
      <Satir renk="#A9AEFF" ad="Sipariş kârı" deger={formatCurrency(n.siparisKari, { decimals: 0 })} />
      <Satir renk="#34D399" ad="Net kâr" deger={formatCurrency(n.netKar, { decimals: 0 })} />
      {marj != null && <p className="mt-1 text-[11px] text-muted-foreground">Marj %{(marj * 100).toFixed(1).replace(".", ",")}</p>}
    </div>
  );
}

function Satir({ renk, ad, deger }: { renk: string; ad: string; deger: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span className="size-2 rounded-full" style={{ background: renk }} />
        {ad}
      </span>
      <span className="tabular-nums text-foreground">{deger}</span>
    </div>
  );
}
