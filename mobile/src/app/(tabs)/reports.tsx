import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  getAllOrders,
  isCancelledOrder,
  ORDERS_STALE_MS,
} from "@/lib/api/orders";
import { orderWindowCutoff } from "@/lib/api/window";
import { syncFinanceFromCache } from "@/lib/finance-sync";
import { getDashboardData, getOrderMatchProducts } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { getProductMap, computeOrderProfit } from "@/lib/order-profit";
import { computeProductProfitMemo } from "@/lib/profit";
import { formatCurrency, formatMonthYear, formatNumber } from "@/lib/format";
import {
  AnimatedBar,
  AnimatedNumber,
  FadeInView,
  Skeleton,
  SkeletonCard,
} from "@/components/fade-in";
import { ML, motion, radius } from "@/theme/colors";
import { ORDER_PLATFORMS, ORDER_PLATFORM_LABEL } from "@/lib/platforms";
import {
  getMonthlyFinanceSummary,
} from "@/lib/db/finance";

export default function ReportsScreen() {
  const qc = useQueryClient();
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const { data: orders, dataUpdatedAt: ordersUpdatedAt, isLoading } = useQuery({
    // Panel/Siparişler ile AYNI sorgu (60 gün) — Raporlar'a geçmek artık tüm pazaryeri
    // boru hattını yeniden tetiklemiyor ve iki sekme aynı anlık görüntüden hesaplıyor.
    queryKey: ["orders"],
    queryFn: getAllOrders,
    staleTime: ORDERS_STALE_MS,
  });
  const { data: products } = useQuery({ queryKey: ["dashboard-data"], queryFn: getDashboardData });
  // Tek batch round-trip (getRules) — eski hali 3 ardışık Turso çağrısıydı.
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  // Sipariş eşleştirme haritası: görünürlük filtresiz set (masaüstü orders route ile birebir).
  const { data: matchProducts } = useQuery({ queryKey: ["match-products"], queryFn: getOrderMatchProducts });
  const monthlyQuery = useQuery({
    queryKey: ["monthly-finance", 12],
    queryFn: () => getMonthlyFinanceSummary(12),
    staleTime: 30_000,
  });

  const rev = useMemo(() => {
    const byPlat: Record<string, { rev: number; profit: number }> = Object.fromEntries(
      ORDER_PLATFORMS.map((p) => [p, { rev: 0, profit: 0 }])
    );
    let total = 0;
    let profit = 0;
    let count = 0;
    let unknownProfitOrders = 0;
    let partialProfitOrders = 0;
    let unsupportedCurrencyOrders = 0;
    if (!orders || !matchProducts || !rules || !settings) {
      return {
        total,
        profit,
        count,
        byPlat,
        unknownProfitOrders,
        partialProfitOrders,
        unsupportedCurrencyOrders,
      };
    }
    const pm = getProductMap(matchProducts);
    const visibleCutoff = orderWindowCutoff();
    for (const o of orders.orders) {
      const op = computeOrderProfit(o, pm, rules, settings);
      // Finans geçmişi 60 gün çekilir; kullanıcıya gösterilen üst kartlar yine son 30 gündür.
      if (o.date != null && o.date < visibleCutoff) continue;
      // Masaüstü özetiyle birebir: iptal/iade/teslim-edilemedi siparişler ciro/kâr/sayıma girmez
      // (orders/route.ts: statusKind==="cancelled" → continue; Panel index.tsx de aynısını yapıyor).
      if (isCancelledOrder(o)) continue;
      // Döviz çevrimi yapılmadan farklı para birimlerini TL toplamına eklemek yanlış sonuç verir.
      if ((o.currency ?? "TRY").trim().toUpperCase() !== "TRY") {
        unsupportedCurrencyOrders++;
        continue;
      }
      total += op.revenue;
      count++;
      const b = byPlat[o.platform];
      if (b) b.rev += op.revenue;
      if (op.profit != null) {
        profit += op.profit;
        if (b) b.profit += op.profit;
      } else unknownProfitOrders++;
      if (op.partial) partialProfitOrders++;
    }
    return {
      total,
      profit,
      count,
      byPlat,
      unknownProfitOrders,
      partialProfitOrders,
      unsupportedCurrencyOrders,
    };
  }, [orders, matchProducts, rules, settings]);

  useEffect(() => {
    if (!orders || orders.orders.length === 0) return;
    let active = true;
    /**
     * Ekran açıkken BEKLETMEDEN yaz (`zorla`) — ama yazma mantığı artık ORTAK modülde
     * (lib/finance-sync). Kök bekçisi de aynı fonksiyonu çağırıyor; iki ayrı kopya olsaydı
     * biri güncellenmeyi unutulduğunda iki cihaz farklı geçmiş yazardı.
     */
    void syncFinanceFromCache(qc, { zorla: true })
      .then(() => {
        if (active) setSnapshotError(null);
      })
      .catch(() => {
        // Teknik ayrıntı ekrana basılmaz; kullanıcıya tek satır bilgi yeter.
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
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, qty]) => ({ name, qty }));
  }, [orders]);

  // Son 30 gün — 6 ardışık 5 günlük kovaya ciro (yalnızca yüklü sipariş verisinden).
  const trend = useMemo(() => {
    const DAY = 86_400_000;
    const BUCKETS = 6;
    const SPAN = 5 * DAY;
    // React Query'nin sabit güncellenme zamanı render sırasında Date.now() çağırmadan
    // aynı 30 günlük pencereyi verir; veri yenilenince pencere de yenilenir.
    const now = ordersUpdatedAt;
    const start = now - BUCKETS * SPAN; // son 30 gün
    const sums = new Array(BUCKETS).fill(0) as number[];
    if (orders) {
      for (const o of orders.orders) {
        // Aynı ekranın Ciro kartıyla tutarlı: iptal/iade trend'e de girmez; tarihsizler atlanır.
        if (
          o.date == null ||
          isCancelledOrder(o) ||
          (o.currency ?? "TRY").trim().toUpperCase() !== "TRY"
        ) continue;
        if (o.date < start || o.date > now) continue;
        const idx = Math.min(BUCKETS - 1, Math.floor((o.date - start) / SPAN));
        sums[idx] += o.total;
      }
    }
    const fmtDay = (t: number) => {
      const d = new Date(t);
      return `${d.getDate()}.${d.getMonth() + 1}`;
    };
    return sums.map((rev, i) => {
      const from = start + i * SPAN;
      const to = from + SPAN - DAY; // kovanın son günü
      return { label: `${fmtDay(from)}–${fmtDay(to)}`, rev };
    });
  }, [orders, ordersUpdatedAt]);

  const profitability = useMemo(() => {
    if (!products || !rules || !settings) return { top: [], loss: [] };
    // Masaüstü reports/page.tsx ile BİREBİR metrik: currentNetProfit (currentSalePrice simülasyonu).
    // (Eski: listing kârlarının ortalaması → iki cihazda farklı sıralama/listeler üretiyordu.)
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

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Raporlar</Text>
          <Text style={styles.subtitle}>Son 30 gün — tüm satışlar</Text>
        </View>
        <ReportsSkeleton />
      </SafeAreaView>
    );
  }

  const avgBasket = rev.count > 0 ? rev.total / rev.count : 0;
  const maxBar = Math.max(...ORDER_PLATFORMS.map((p) => rev.byPlat[p].rev), 1);
  const maxQty = topSellers[0]?.qty ?? 1;
  const maxTrend = Math.max(...trend.map((t) => t.rev), 1);
  const trendHasData = trend.some((t) => t.rev > 0);
  const monthly = monthlyQuery.data?.periods ?? [];
  const currentMonth = monthly.at(-1);
  const maxMonthlyRevenue = Math.max(...monthly.map((period) => period.revenueKurus), 1);
  const maxMonthlyProfit = Math.max(
    ...monthly.map((period) => Math.abs(period.netProfitKurus)),
    1
  );
  const monthlyHasData = monthly.some(
    (period) => period.revenueKurus !== 0 || period.expensesKurus !== 0
  );
  const monthlyIncomplete = monthly.reduce(
    (sum, period) => sum + period.incompleteOrders,
    0
  );
  const unsupportedCurrencyOrders = monthly.reduce(
    (sum, period) => sum + period.unsupportedCurrencyOrders,
    0
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Raporlar</Text>
        <Text style={styles.subtitle}>Son 30 gün — tüm satışlar</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Stat kartları */}
        <View style={styles.statGrid}>
          <Stat label="Ciro" value={rev.total} tone="accent" index={0} />
          <Stat
            label="Sipariş kârı"
            value={rev.profit}
            tone={rev.profit < 0 ? "red" : "green"}
            index={1}
          />
          <Stat
            label="Sipariş"
            value={rev.count}
            tone="text"
            index={2}
            format={(n) => formatNumber(Math.round(n))}
          />
          <Stat label="Ort. sepet" value={avgBasket} tone="text" index={3} />
        </View>
        {rev.unsupportedCurrencyOrders > 0 ? (
          <Text style={styles.warningText}>
            {rev.unsupportedCurrencyOrders} sipariş farklı para biriminde — toplamlara katılmadı.
          </Text>
        ) : null}

        <Text style={styles.sectionLabel}>AYLIK CİRO VE NET KÂR</Text>
        <FadeInView style={styles.card}>
          {monthlyQuery.isLoading ? (
            <View style={{ gap: 12 }}>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} width="100%" height={22} delay={i * 70} />
              ))}
            </View>
          ) : monthlyQuery.error ? (
            <Text style={styles.warningText}>Aylık özet şu an yüklenemedi.</Text>
          ) : !monthlyHasData ? (
            <Text style={styles.chartNote}>
              Siparişler yüklendikçe aylık geçmiş burada birikecek.
            </Text>
          ) : (
            monthly.map((period, i) => (
              <MonthlyRow
                key={period.month}
                index={i}
                label={period.label}
                revenue={period.revenueKurus / 100}
                netProfit={period.netProfitKurus / 100}
                revenuePct={(period.revenueKurus / maxMonthlyRevenue) * 100}
                profitPct={(Math.abs(period.netProfitKurus) / maxMonthlyProfit) * 50}
              />
            ))
          )}
          {currentMonth && (currentMonth.revenueKurus !== 0 || currentMonth.expensesKurus !== 0) ? (
            <View style={styles.monthSummary}>
              <View style={styles.monthSummaryPair}>
                <Text style={styles.monthSummaryText}>Bu ay gider</Text>
                <AnimatedNumber
                  value={currentMonth.expensesKurus / 100}
                  format={(n) => formatCurrency(n)}
                  style={styles.monthSummaryText}
                />
              </View>
              <View style={styles.monthSummaryPair}>
                <Text style={styles.monthSummaryText}>Net</Text>
                <AnimatedNumber
                  value={currentMonth.netProfitKurus / 100}
                  format={(n) => formatCurrency(n)}
                  style={[
                    styles.monthSummaryProfit,
                    { color: currentMonth.netProfitKurus < 0 ? ML.red : ML.green },
                  ]}
                />
              </View>
            </View>
          ) : null}
          {monthlyQuery.data?.historyStartedAt ? (
            <Text style={styles.chartNote}>
              Geçmiş {formatMonthYear(monthlyQuery.data.historyStartedAt)} ayından beri birikiyor.
            </Text>
          ) : null}
          {monthlyIncomplete > 0 ? (
            <Text style={styles.warningText}>
              {monthlyIncomplete} siparişin kârı henüz kesinleşmedi.
            </Text>
          ) : null}
          {unsupportedCurrencyOrders > 0 ? (
            <Text style={styles.warningText}>
              {unsupportedCurrencyOrders} sipariş farklı para biriminde — aylık toplama katılmadı.
            </Text>
          ) : null}
          {snapshotError ? <Text style={styles.warningText}>{snapshotError}</Text> : null}
        </FadeInView>

        {/* Platform karşılaştırma */}
        <Text style={styles.sectionLabel}>PLATFORM</Text>
        <FadeInView style={styles.card}>
          {ORDER_PLATFORMS.map((plat, i) => (
            <PlatformBar
              key={plat}
              index={i}
              name={ORDER_PLATFORM_LABEL[plat]}
              color={ML[plat]}
              rev={rev.byPlat[plat].rev}
              profit={rev.byPlat[plat].profit}
              pct={(rev.byPlat[plat].rev / maxBar) * 100}
            />
          ))}
        </FadeInView>

        {/* 30 günlük ciro trendi */}
        {trendHasData && (
          <>
            <Text style={styles.sectionLabel}>30 GÜN CİRO TRENDİ</Text>
            <FadeInView style={styles.card}>
              {trend.map((t, i) => (
                <View key={i} style={styles.trendRow}>
                  <Text style={styles.trendLabel}>{t.label}</Text>
                  <AnimatedBar
                    percent={(t.rev / maxTrend) * 100}
                    minPercent={2}
                    color={ML.accent}
                    height={8}
                    delay={i * motion.stagger}
                    style={{ flex: 1 }}
                  />
                  <AnimatedNumber
                    value={t.rev}
                    format={(n) => formatCurrency(n)}
                    style={styles.trendVal}
                  />
                </View>
              ))}
            </FadeInView>
          </>
        )}

        {/* En çok satanlar */}
        {topSellers.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>EN ÇOK SATANLAR</Text>
            <FadeInView style={styles.card}>
              {topSellers.map((s, i) => (
                <View key={i} style={styles.sellerRow}>
                  <Text style={styles.sellerName} numberOfLines={1}>
                    {s.name}
                  </Text>
                  <AnimatedBar
                    percent={(s.qty / maxQty) * 100}
                    minPercent={2}
                    color={ML.accent}
                    height={8}
                    delay={i * motion.stagger}
                    style={{ flex: 1 }}
                  />
                  <AnimatedNumber
                    value={s.qty}
                    format={(n) => formatNumber(Math.round(n))}
                    style={styles.sellerQty}
                  />
                </View>
              ))}
            </FadeInView>
          </>
        )}

        {/* Kârlılık */}
        {profitability.top.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>EN KÂRLI</Text>
            <FadeInView style={styles.card}>
              {profitability.top.map((p) => (
                <ProfitRow key={p.id} name={p.name} profit={p.profit} />
              ))}
            </FadeInView>
          </>
        )}
        {profitability.loss.length > 0 && (
          <>
            <Text style={[styles.sectionLabel, { color: ML.red }]}>ZARAR EDENLER</Text>
            <FadeInView style={styles.card}>
              {profitability.loss.map((p) => (
                <ProfitRow key={p.id} name={p.name} profit={p.profit} />
              ))}
            </FadeInView>
          </>
        )}
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({
  label,
  value,
  tone,
  index,
  format,
}: {
  label: string;
  value: number;
  tone: "accent" | "green" | "red" | "text";
  index: number;
  /** Varsayılan para; sayım kartları için formatNumber geçilir. */
  format?: (n: number) => string;
}) {
  const color = { accent: ML.accent, green: ML.green, red: ML.red, text: ML.text }[tone];
  return (
    <FadeInView index={index} style={styles.statWrap}>
      <View style={styles.stat}>
        <Text style={styles.statLabel}>{label}</Text>
        <AnimatedNumber
          value={value}
          format={format ?? ((n) => formatCurrency(n))}
          style={[styles.statValue, { color }]}
        />
      </View>
    </FadeInView>
  );
}

function PlatformBar({
  name,
  color,
  rev,
  profit,
  pct,
  index,
}: {
  name: string;
  color: string;
  rev: number;
  profit: number;
  pct: number;
  index: number;
}) {
  return (
    <View style={styles.platBlock}>
      <View style={styles.platHead}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={[styles.platName, { color }]}>{name}</Text>
        <AnimatedNumber value={rev} format={(n) => formatCurrency(n)} style={styles.platRev} />
      </View>
      <AnimatedBar
        percent={pct}
        minPercent={2}
        color={color}
        height={10}
        delay={index * motion.stagger}
      />
      <View style={styles.platProfitRow}>
        <Text style={styles.platProfitLabel}>Kâr</Text>
        <AnimatedNumber
          value={profit}
          format={(n) => formatCurrency(n)}
          style={[styles.platProfit, { color: profit < 0 ? ML.red : ML.green }]}
        />
      </View>
    </View>
  );
}

function MonthlyRow({
  label,
  revenue,
  netProfit,
  revenuePct,
  profitPct,
  index,
}: {
  label: string;
  revenue: number;
  netProfit: number;
  revenuePct: number;
  profitPct: number;
  index: number;
}) {
  const negative = netProfit < 0;
  const delay = index * motion.stagger;
  return (
    <View style={styles.monthRow}>
      <Text style={styles.monthLabel}>{label}</Text>
      <View style={styles.monthCharts}>
        <View style={styles.monthMetricRow}>
          <Text style={styles.metricKey}>C</Text>
          <AnimatedBar
            percent={revenuePct}
            minPercent={revenue === 0 ? 0 : 2}
            color={ML.accent}
            height={7}
            delay={delay}
            style={{ flex: 1 }}
          />
          <AnimatedNumber
            value={revenue}
            format={(n) => formatCurrency(n)}
            style={styles.monthValue}
          />
        </View>
        <View style={styles.monthMetricRow}>
          <Text style={styles.metricKey}>N</Text>
          {/* Sıfır çizgisinin iki yanına dolan bar: solda zarar, sağda kâr. */}
          <View style={styles.monthProfitTrack}>
            <View style={styles.monthProfitHalf}>
              {negative ? (
                <AnimatedBar
                  percent={profitPct * 2}
                  color={ML.red}
                  height={7}
                  trackColor="transparent"
                  align="right"
                  delay={delay}
                  style={styles.monthProfitBar}
                />
              ) : null}
            </View>
            <View style={styles.zeroLine} />
            <View style={styles.monthProfitHalf}>
              {!negative && netProfit !== 0 ? (
                <AnimatedBar
                  percent={profitPct * 2}
                  color={ML.green}
                  height={7}
                  trackColor="transparent"
                  delay={delay}
                  style={styles.monthProfitBar}
                />
              ) : null}
            </View>
          </View>
          <AnimatedNumber
            value={netProfit}
            format={(n) => formatCurrency(n)}
            style={[styles.monthValue, { color: negative ? ML.red : ML.green }]}
          />
        </View>
      </View>
    </View>
  );
}

function ProfitRow({ name, profit }: { name: string; profit: number }) {
  return (
    <View style={styles.profitRow}>
      <Text style={styles.profitName} numberOfLines={1}>
        {name}
      </Text>
      <AnimatedNumber
        value={profit}
        format={(n) => `${n >= 0 ? "+" : ""}${formatCurrency(n)}`}
        style={[styles.profitVal, { color: profit < 0 ? ML.red : ML.green }]}
      />
    </View>
  );
}

/** Raporlar açılırken kartların yerini tutan iskelet. */
function ReportsSkeleton() {
  return (
    <View style={styles.content}>
      <View style={styles.statGrid}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={styles.statWrap}>
            <SkeletonCard height={78} delay={i * 70} />
          </View>
        ))}
      </View>
      <View style={{ height: 8 }} />
      <View style={styles.card}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} width="100%" height={18} delay={200 + i * 70} />
        ))}
      </View>
      <View style={{ height: 8 }} />
      <View style={styles.card}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} width="100%" height={26} delay={420 + i * 70} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "transparent" }, // zemin kökte (kit/Backdrop)
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  title: { color: ML.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: ML.textDim, fontSize: 14, marginTop: 2 },
  content: { padding: 16, gap: 8 },
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statWrap: { flexGrow: 1, flexBasis: "47%" },
  stat: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 14,
  },
  statLabel: { color: ML.textDim, fontSize: 12 },
  statValue: { fontSize: 22, fontWeight: "800", marginTop: 4, letterSpacing: -0.5 },
  sectionLabel: {
    color: ML.textFaint,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    marginTop: 12,
    marginLeft: 4,
  },
  card: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 14,
    gap: 12,
  },
  platBlock: { gap: 6 },
  platHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  platName: { fontSize: 15, fontWeight: "700", flex: 1 },
  platRev: { color: ML.text, fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] },
  platProfitRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  platProfitLabel: { color: ML.textFaint, fontSize: 12, fontWeight: "600" },
  platProfit: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  sellerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  sellerName: { color: ML.textDim, fontSize: 13, width: 110 },
  sellerQty: { color: ML.text, fontSize: 13, fontWeight: "700", width: 28, textAlign: "right" },
  trendRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  trendLabel: { color: ML.textDim, fontSize: 12, width: 78, fontVariant: ["tabular-nums"] },
  trendVal: { color: ML.text, fontSize: 13, fontWeight: "700", width: 72, textAlign: "right", fontVariant: ["tabular-nums"] },
  monthRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: ML.borderSoft,
    paddingBottom: 9,
  },
  monthLabel: {
    color: ML.textDim,
    fontSize: 11,
    width: 48,
    textTransform: "capitalize",
  },
  monthCharts: { flex: 1, gap: 5 },
  monthMetricRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  metricKey: { color: ML.textFaint, fontSize: 9, fontWeight: "800", width: 10 },
  monthProfitTrack: {
    flex: 1,
    height: 7,
    flexDirection: "row",
    backgroundColor: ML.cardElevated,
    overflow: "hidden",
  },
  monthProfitHalf: { width: "50%", height: "100%", flexDirection: "row" },
  zeroLine: { width: 1, height: "100%", backgroundColor: ML.textFaint },
  monthProfitBar: { flex: 1, borderRadius: 0 },
  monthValue: {
    color: ML.text,
    fontSize: 10,
    fontWeight: "700",
    width: 76,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  monthSummary: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 2,
  },
  monthSummaryPair: { flexDirection: "row", alignItems: "baseline", gap: 5 },
  monthSummaryText: { color: ML.textDim, fontSize: 12 },
  monthSummaryProfit: { fontSize: 13, fontWeight: "800" },
  chartNote: { color: ML.textFaint, fontSize: 11, lineHeight: 16 },
  warningText: {
    color: ML.orange,
    fontSize: 11,
    lineHeight: 16,
    backgroundColor: ML.orangeSoft,
    borderRadius: radius.sm,
    padding: 9,
  },
  profitRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  profitName: { color: ML.textDim, fontSize: 13, flex: 1 },
  profitVal: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
