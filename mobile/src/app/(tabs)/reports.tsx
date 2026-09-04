import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Svg, { G, Rect } from "react-native-svg";

import { Pill } from "@/components/kit/Chip";
import {
  Bars,
  Count,
  FadeInView,
  Glass,
  Header,
  Money,
  Progress,
  Screen,
  Shimmer,
  ShimmerCard,
  Tint,
  Txt,
} from "@/components/kit";
import { getAllOrders, isCancelledOrder, ORDERS_STALE_MS } from "@/lib/api/orders";
import { orderWindowCutoff } from "@/lib/api/window";
import { getDashboardData, getOrderMatchProducts } from "@/lib/db/dashboard";
import { getMonthlyFinanceSummary } from "@/lib/db/finance";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { syncFinanceFromCache } from "@/lib/finance-sync";
import { formatCompactCurrency, formatCurrency, formatMonthYear, formatNumber } from "@/lib/format";
import { computeOrderProfit, getProductMap } from "@/lib/order-profit";
import { ORDER_PLATFORM_COLOR, ORDER_PLATFORM_LABEL, ORDER_PLATFORMS } from "@/lib/platforms";
import { computeProductProfitMemo } from "@/lib/profit";
import { color, radius, space } from "@/theme/tokens";

/**
 * RAPORLAR — son 30 gün özeti, aylık ciro/net kâr grafiği (12 ay), platform payları, 30 günlük
 * ciro dalgası, en çok satanlar, en kârlı / zarar eden ürünler. Hesaplar masaüstüyle birebir;
 * aylık geçmişi yazan senkron ortak modülde (lib/finance-sync).
 */
export default function ReportsScreen() {
  const qc = useQueryClient();
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const { data: orders, dataUpdatedAt: ordersUpdatedAt, isLoading } = useQuery({
    queryKey: ["orders"],
    queryFn: getAllOrders,
    staleTime: ORDERS_STALE_MS,
  });
  const { data: products } = useQuery({ queryKey: ["dashboard-data"], queryFn: getDashboardData });
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  const { data: matchProducts } = useQuery({ queryKey: ["match-products"], queryFn: getOrderMatchProducts });
  const monthlyQuery = useQuery({
    queryKey: ["monthly-finance", 12],
    queryFn: () => getMonthlyFinanceSummary(12),
    staleTime: 30_000,
  });

  const rev = useMemo(() => {
    const byPlat: Record<string, { rev: number; profit: number; n: number }> = Object.fromEntries(
      ORDER_PLATFORMS.map((p) => [p, { rev: 0, profit: 0, n: 0 }])
    );
    let total = 0;
    let profit = 0;
    let count = 0;
    let unknownProfitOrders = 0;
    let partialProfitOrders = 0;
    let unsupportedCurrencyOrders = 0;
    if (!orders || !matchProducts || !rules || !settings) {
      return { total, profit, count, byPlat, unknownProfitOrders, partialProfitOrders, unsupportedCurrencyOrders };
    }
    const pm = getProductMap(matchProducts);
    const visibleCutoff = orderWindowCutoff();
    for (const o of orders.orders) {
      const op = computeOrderProfit(o, pm, rules, settings);
      if (o.date != null && o.date < visibleCutoff) continue;
      if (isCancelledOrder(o)) continue;
      if ((o.currency ?? "TRY").trim().toUpperCase() !== "TRY") {
        unsupportedCurrencyOrders++;
        continue;
      }
      total += op.revenue;
      count++;
      const b = byPlat[o.platform];
      if (b) {
        b.rev += op.revenue;
        b.n++;
      }
      if (op.profit != null) {
        profit += op.profit;
        if (b) b.profit += op.profit;
      } else unknownProfitOrders++;
      if (op.partial) partialProfitOrders++;
    }
    return { total, profit, count, byPlat, unknownProfitOrders, partialProfitOrders, unsupportedCurrencyOrders };
  }, [orders, matchProducts, rules, settings]);

  useEffect(() => {
    if (!orders || orders.orders.length === 0) return;
    let active = true;
    void syncFinanceFromCache(qc, { zorla: true })
      .then(() => {
        if (active) setSnapshotError(null);
      })
      .catch(() => {
        if (active) setSnapshotError("Aylık geçmiş şu an güncellenemedi.");
      });
    return () => {
      active = false;
    };
  }, [qc, orders]);

  const topSellers = useMemo(() => {
    if (!orders) return [];
    const m = new Map<string, number>();
    const cutoff = orderWindowCutoff();
    for (const o of orders.orders) {
      if (o.date != null && o.date < cutoff) continue;
      if (isCancelledOrder(o)) continue;
      for (const it of o.items) m.set(it.name, (m.get(it.name) ?? 0) + it.quantity);
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, qty]) => ({ name, qty }));
  }, [orders]);

  /** Son 30 gün, günlük ciro (grafik). "Şimdi" = sorgunun çekildiği an (render'da Date.now yok). */
  const gunluk = useMemo(() => {
    const GUN = 86_400_000;
    const N = 30;
    const now = ordersUpdatedAt;
    const sums = new Array<number>(N).fill(0);
    if (orders && now) {
      for (const o of orders.orders) {
        if (o.date == null || isCancelledOrder(o) || (o.currency ?? "TRY").trim().toUpperCase() !== "TRY") continue;
        const geri = Math.floor((now - o.date) / GUN);
        if (geri < 0 || geri >= N) continue;
        sums[N - 1 - geri] += o.total;
      }
    }
    return sums;
  }, [orders, ordersUpdatedAt]);

  const profitability = useMemo(() => {
    if (!products || !rules || !settings) return { top: [], loss: [] };
    const rows = products
      .map((p) => {
        const pr = computeProductProfitMemo(p, rules, settings);
        if (!pr.hasCost || pr.currentNetProfit == null) return null;
        return { id: p.id, name: p.name, profit: pr.currentNetProfit };
      })
      .filter((x): x is { id: string; name: string; profit: number } => !!x);
    return {
      top: [...rows].sort((a, b) => b.profit - a.profit).slice(0, 6),
      loss: rows.filter((r) => r.profit < 0).sort((a, b) => a.profit - b.profit).slice(0, 6),
    };
  }, [products, rules, settings]);

  const header = <Header title="Raporlar" subtitle="Son 30 gün · tüm satışlar" updatedAt={ordersUpdatedAt} />;

  if (isLoading) {
    return (
      <Screen header={header}>
        <View style={styles.grid}>
          <ShimmerCard height={92} style={{ flex: 1 }} />
          <ShimmerCard height={92} delay={60} style={{ flex: 1 }} />
        </View>
        <View style={styles.grid}>
          <ShimmerCard height={92} delay={120} style={{ flex: 1 }} />
          <ShimmerCard height={92} delay={180} style={{ flex: 1 }} />
        </View>
        <ShimmerCard height={220} delay={240} />
        <ShimmerCard height={160} delay={320} />
      </Screen>
    );
  }

  const avgBasket = rev.count > 0 ? rev.total / rev.count : 0;
  const maxPlat = Math.max(...ORDER_PLATFORMS.map((p) => rev.byPlat[p].rev), 1);
  const maxQty = topSellers[0]?.qty ?? 1;
  const gunlukVar = gunluk.some((v) => v > 0);
  const monthly = monthlyQuery.data?.periods ?? [];
  const currentMonth = monthly.at(-1);
  const monthlyHasData = monthly.some((p) => p.revenueKurus !== 0 || p.expensesKurus !== 0);
  const monthlyIncomplete = monthly.reduce((sum, p) => sum + p.incompleteOrders, 0);
  const unsupportedCurrencyOrders = monthly.reduce((sum, p) => sum + p.unsupportedCurrencyOrders, 0);

  return (
    <Screen header={header}>
      {/* ÖZET */}
      <FadeInView index={0}>
        <View style={styles.grid}>
          <Tint strong style={styles.stat}>
            <Txt v="small" tone="dim">
              Ciro
            </Txt>
            <Money value={rev.total} v="heading" compact />
          </Tint>
          <Tint strong style={styles.stat}>
            <Txt v="small" tone="dim">
              Sipariş kârı
            </Txt>
            <Money value={rev.profit} v="heading" tone={rev.profit < 0 ? "bad" : "good"} compact />
          </Tint>
        </View>
        <View style={[styles.grid, { marginTop: space.sm }]}>
          <Tint strong style={styles.stat}>
            <Txt v="small" tone="dim">
              Sipariş
            </Txt>
            <Count value={rev.count} v="heading" />
          </Tint>
          <Tint strong style={styles.stat}>
            <Txt v="small" tone="dim">
              Ortalama sepet
            </Txt>
            <Money value={avgBasket} v="heading" compact />
          </Tint>
        </View>
      </FadeInView>
      {rev.unsupportedCurrencyOrders > 0 ? (
        <Uyari>{rev.unsupportedCurrencyOrders} sipariş farklı para biriminde — toplamlara katılmadı.</Uyari>
      ) : null}

      {/* AYLIK CİRO VE NET KÂR */}
      <Txt v="label" tone="faint" style={styles.section}>
        AYLIK CİRO VE NET KÂR
      </Txt>
      <FadeInView index={1}>
        <Glass style={{ gap: space.md }}>
          {monthlyQuery.isLoading ? (
            <View style={{ gap: space.md }}>
              <Shimmer width="100%" height={120} radius={radius.sm} />
              <Shimmer width="60%" height={12} delay={80} />
            </View>
          ) : monthlyQuery.error ? (
            <Uyari>Aylık özet şu an yüklenemedi.</Uyari>
          ) : !monthlyHasData ? (
            <Txt v="small" tone="faint">
              Siparişler yüklendikçe aylık geçmiş burada birikecek.
            </Txt>
          ) : (
            <>
              <View style={styles.legend}>
                <View style={[styles.legendDot, { backgroundColor: color.accent }]} />
                <Txt v="label" tone="dim">
                  Ciro
                </Txt>
                <View style={[styles.legendDot, { backgroundColor: color.good, marginLeft: space.sm }]} />
                <Txt v="label" tone="dim">
                  Net kâr
                </Txt>
                <View style={[styles.legendDot, { backgroundColor: color.bad, marginLeft: space.sm }]} />
                <Txt v="label" tone="dim">
                  Zarar
                </Txt>
              </View>
              <AylikGrafik
                data={monthly.map((p) => ({
                  label: p.label,
                  revenue: p.revenueKurus / 100,
                  profit: p.netProfitKurus / 100,
                }))}
              />
              {currentMonth && (currentMonth.revenueKurus !== 0 || currentMonth.expensesKurus !== 0) ? (
                <View style={styles.rowBetween}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                    <Txt v="small" tone="dim">
                      Bu ay gider
                    </Txt>
                    <Money value={currentMonth.expensesKurus / 100} v="smallStrong" compact />
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                    <Txt v="small" tone="dim">
                      Net
                    </Txt>
                    <Money
                      value={currentMonth.netProfitKurus / 100}
                      v="bodyStrong"
                      tone={currentMonth.netProfitKurus < 0 ? "bad" : "good"}
                      compact
                    />
                  </View>
                </View>
              ) : null}
            </>
          )}
          {monthlyQuery.data?.historyStartedAt ? (
            <Txt v="small" tone="faint">
              Geçmiş {formatMonthYear(monthlyQuery.data.historyStartedAt)} ayından beri birikiyor.
            </Txt>
          ) : null}
          {monthlyIncomplete > 0 ? <Uyari>{monthlyIncomplete} siparişin kârı henüz kesinleşmedi.</Uyari> : null}
          {unsupportedCurrencyOrders > 0 ? (
            <Uyari>{unsupportedCurrencyOrders} sipariş farklı para biriminde — aylık toplama katılmadı.</Uyari>
          ) : null}
          {snapshotError ? <Uyari>{snapshotError}</Uyari> : null}
        </Glass>
      </FadeInView>

      {/* PLATFORM */}
      <Txt v="label" tone="faint" style={styles.section}>
        PLATFORM PAYI
      </Txt>
      <FadeInView index={2}>
        <Tint strong style={{ gap: space.md }}>
          {ORDER_PLATFORMS.map((plat) => {
            const b = rev.byPlat[plat];
            return (
              <View key={plat} style={{ gap: 6 }}>
                <View style={styles.rowBetween}>
                  <View style={styles.rowGap}>
                    <View style={[styles.legendDot, { backgroundColor: ORDER_PLATFORM_COLOR[plat] }]} />
                    <Txt v="bodyStrong">{ORDER_PLATFORM_LABEL[plat]}</Txt>
                    {b.n > 0 ? (
                      <Txt v="small" tone="faint" num>
                        {formatNumber(b.n)} sipariş
                      </Txt>
                    ) : null}
                  </View>
                  <Money value={b.rev} v="bodyStrong" compact />
                </View>
                <Progress value={b.rev / maxPlat} color={ORDER_PLATFORM_COLOR[plat]} height={8} />
                <View style={styles.rowBetween}>
                  <Txt v="small" tone="faint">
                    Kâr
                  </Txt>
                  <Money value={b.profit} v="smallStrong" tone={b.profit < 0 ? "bad" : "good"} compact />
                </View>
              </View>
            );
          })}
        </Tint>
      </FadeInView>

      {/* 30 GÜN CİRO */}
      {gunlukVar ? (
        <>
          <Txt v="label" tone="faint" style={styles.section}>
            30 GÜNLÜK CİRO DALGASI
          </Txt>
          <FadeInView index={3}>
            <Glass style={{ gap: space.sm }}>
              <Bars values={gunluk} height={72} emphasis={(i) => i >= gunluk.length - 7} />
              <View style={styles.rowBetween}>
                <Txt v="label" tone="faint">
                  30 GÜN ÖNCE
                </Txt>
                <Txt v="label" tone="faint">
                  SON 7 GÜN
                </Txt>
              </View>
            </Glass>
          </FadeInView>
        </>
      ) : null}

      {/* EN ÇOK SATANLAR */}
      {topSellers.length > 0 ? (
        <>
          <Txt v="label" tone="faint" style={styles.section}>
            EN ÇOK SATANLAR
          </Txt>
          <FadeInView index={4}>
            <Tint strong style={{ gap: space.md }}>
              {topSellers.map((s) => (
                <View key={s.name} style={{ gap: 5 }}>
                  <View style={styles.rowBetween}>
                    <Txt v="small" numberOfLines={1} style={{ flex: 1 }}>
                      {s.name}
                    </Txt>
                    <Count value={s.qty} v="smallStrong" />
                  </View>
                  <Progress value={s.qty / maxQty} height={5} />
                </View>
              ))}
            </Tint>
          </FadeInView>
        </>
      ) : null}

      {/* KÂRLILIK */}
      {profitability.top.length > 0 ? (
        <>
          <Txt v="label" tone="faint" style={styles.section}>
            EN KÂRLI ÜRÜNLER
          </Txt>
          <FadeInView index={5}>
            <Tint strong padded={false} style={styles.listCard}>
              {profitability.top.map((p, i) => (
                <View key={p.id} style={[styles.profitRow, i > 0 ? styles.rowBorder : null]}>
                  <Txt v="small" numberOfLines={1} style={{ flex: 1 }}>
                    {p.name}
                  </Txt>
                  <Pill color={color.good}>+{formatCompactCurrency(p.profit)}</Pill>
                </View>
              ))}
            </Tint>
          </FadeInView>
        </>
      ) : null}
      {profitability.loss.length > 0 ? (
        <>
          <Txt v="label" tone="bad" style={styles.section}>
            ZARAR EDENLER
          </Txt>
          <FadeInView index={6}>
            <Tint strong padded={false} style={styles.listCard}>
              {profitability.loss.map((p, i) => (
                <View key={p.id} style={[styles.profitRow, i > 0 ? styles.rowBorder : null]}>
                  <Txt v="small" numberOfLines={1} style={{ flex: 1 }}>
                    {p.name}
                  </Txt>
                  <Pill color={color.bad}>{formatCurrency(p.profit)}</Pill>
                </View>
              ))}
            </Tint>
          </FadeInView>
        </>
      ) : null}
    </Screen>
  );
}

/**
 * AYLIK GRAFİK — ay başına iki ince çubuk: ciro (mor) ve net kâr (yeşil, zararda kırmızı ve
 * sıfır çizgisinin altına iner). Genişliği kendi ölçer; etiketler ay kısaltması.
 */
function AylikGrafik({ data }: { data: { label: string; revenue: number; profit: number }[] }) {
  const [width, setWidth] = useState(0);
  const H = 120;
  const AXIS = 18; // alt etiket alanı
  const n = Math.max(1, data.length);
  const maxRev = Math.max(1, ...data.map((d) => d.revenue));
  const maxLoss = Math.max(0, ...data.map((d) => (d.profit < 0 ? -d.profit : 0)));
  // Pozitif alan ciro ölçeğinde; negatif alan zararın büyüklüğüne göre küçük bir pay alır.
  const negH = maxLoss > 0 ? 22 : 0;
  const posH = H - negH;
  const zeroY = posH;
  const slot = width / n;
  const gap = Math.max(2, slot * 0.18);
  const bw = Math.max(2, (slot - gap * 3) / 2);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w !== width) setWidth(w);
  };

  return (
    <View onLayout={onLayout} style={{ width: "100%" }}>
      {width > 0 ? (
        <>
          <Svg width={width} height={H}>
            <Rect x={0} y={zeroY - 0.5} width={width} height={1} fill={color.lineStrong} />
            {data.map((d, i) => {
              const x0 = i * slot + gap;
              const revH = Math.max(d.revenue > 0 ? 3 : 0, (d.revenue / maxRev) * (posH - 4));
              const kar = d.profit;
              const karH = kar >= 0 ? Math.max(kar > 0 ? 3 : 0, (kar / maxRev) * (posH - 4)) : Math.max(3, (-kar / Math.max(1, maxLoss)) * (negH - 4));
              return (
                <G key={d.label}>
                  <Rect x={x0} y={zeroY - revH} width={bw} height={revH} rx={bw / 2} fill={color.accent} opacity={0.9} />
                  {kar >= 0 ? (
                    <Rect x={x0 + bw + gap} y={zeroY - karH} width={bw} height={karH} rx={bw / 2} fill={color.good} />
                  ) : (
                    <Rect x={x0 + bw + gap} y={zeroY} width={bw} height={karH} rx={bw / 2} fill={color.bad} />
                  )}
                </G>
              );
            })}
          </Svg>
          <View style={[styles.axis, { height: AXIS }]}>
            {data.map((d, i) => (
              <Txt key={d.label} v="label" tone="faint" style={{ width: slot, textAlign: "center", fontSize: 9, lineHeight: 12 }} numberOfLines={1}>
                {i % (n > 8 ? 2 : 1) === 0 ? d.label.slice(0, 3) : ""}
              </Txt>
            ))}
          </View>
        </>
      ) : (
        <View style={{ height: H + AXIS }} />
      )}
    </View>
  );
}

function Uyari({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.warn}>
      <Txt v="small" tone="warn">
        {children}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", gap: space.sm },
  stat: { flex: 1, gap: 4, minHeight: 84, padding: space.md },
  section: { letterSpacing: 1.2, marginTop: space.sm, marginLeft: space.xs },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  rowGap: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  legend: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  axis: { flexDirection: "row", marginTop: 4 },
  listCard: { paddingHorizontal: space.lg },
  profitRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.md },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  warn: { backgroundColor: color.warnSoft, borderRadius: radius.sm, padding: space.sm },
});
