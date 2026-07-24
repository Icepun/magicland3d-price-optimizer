"use client";
/**
 * Fiyat geçmişi çizgi grafiği — recharts (~ağır) YALNIZ burada. PriceHistoryCard bunu
 * next/dynamic({ssr:false}) ile yükler → recharts Ürün detay initial bundle'ına GİRMEZ,
 * grafik alanı görününce yüklenir. Renk-context div (text-muted-foreground → currentColor)
 * grafikle birlikte burada tutulur ki eksen/ızgara renkleri korunsun.
 */
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { formatCurrency } from "@/lib/utils";

interface PriceHistoryChartProps {
  chartData: Record<string, number | string>[];
  sources: string[];
  resolveSource: (src: string) => { label: string; color: string };
}

export function PriceHistoryChart({ chartData, sources, resolveSource }: PriceHistoryChartProps) {
  return (
    <div className="h-[240px] w-full text-muted-foreground">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="currentColor"
            strokeOpacity={0.12}
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "currentColor" }}
            tickLine={false}
            axisLine={{ stroke: "currentColor", strokeOpacity: 0.15 }}
            minTickGap={20}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "currentColor" }}
            tickLine={false}
            axisLine={false}
            width={56}
            domain={["auto", "auto"]}
            tickFormatter={(v) => `₺${Math.round(Number(v))}`}
          />
          <RTooltip
            contentStyle={{
              background: "oklch(0.2 0.02 278)",
              border: "1px solid oklch(1 0 0 / 12%)",
              borderRadius: 8,
              fontSize: 12,
              color: "oklch(0.95 0 0)",
            }}
            labelStyle={{ color: "oklch(0.85 0 0)", marginBottom: 4 }}
            formatter={(value: number, name: string) => [
              formatCurrency(Number(value)),
              resolveSource(name).label,
            ]}
          />
          <Legend
            formatter={(value) => resolveSource(String(value)).label}
            wrapperStyle={{ fontSize: 11 }}
          />
          {sources.map((src) => (
            <Line
              key={src}
              type="monotone"
              dataKey={src}
              name={src}
              stroke={resolveSource(src).color}
              strokeWidth={2}
              dot={{ r: 2.5 }}
              activeDot={{ r: 4 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
