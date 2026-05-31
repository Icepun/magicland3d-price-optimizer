import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getAllOrders } from "@/lib/api/orders";
import { getDashboardData } from "@/lib/db/dashboard";
import { getCargoRules, getCommissionRules, getExpenseRules, getSettingsMap } from "@/lib/db/rules";
import { buildProductMap, computeOrderProfit } from "@/lib/order-profit";
import { computeProductProfit } from "@/lib/profit";
import { formatCurrency } from "@/lib/format";
import { ML, radius } from "@/theme/colors";

export default function ReportsScreen() {
  const { data: orders, isLoading } = useQuery({ queryKey: ["orders"], queryFn: getAllOrders, staleTime: 60_000 });
  const { data: products } = useQuery({ queryKey: ["dashboard-data"], queryFn: getDashboardData });
  const { data: rules } = useQuery({
    queryKey: ["rules"],
    queryFn: async () => ({
      commission: await getCommissionRules(),
      cargo: await getCargoRules(),
      expense: await getExpenseRules(),
    }),
  });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

  const rev = useMemo(() => {
    const acc = {
      total: 0,
      profit: 0,
      count: 0,
      shopify: { rev: 0, profit: 0 },
      trendyol: { rev: 0, profit: 0 },
    };
    if (!orders || !products || !rules || !settings) return acc;
    const pm = buildProductMap(products);
    for (const o of orders.orders) {
      const op = computeOrderProfit(o, pm, rules, settings);
      acc.total += op.revenue;
      acc.count++;
      acc[o.platform].rev += op.revenue;
      if (op.profit != null) {
        acc.profit += op.profit;
        acc[o.platform].profit += op.profit;
      }
    }
    return acc;
  }, [orders, products, rules, settings]);

  const topSellers = useMemo(() => {
    if (!orders) return [];
    const m = new Map<string, number>();
    for (const o of orders.orders) for (const it of o.items) m.set(it.name, (m.get(it.name) ?? 0) + it.quantity);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, qty]) => ({ name, qty }));
  }, [orders]);

  const profitability = useMemo(() => {
    if (!products || !rules || !settings) return { top: [], loss: [] };
    const rows = products
      .map((p) => {
        const pr = computeProductProfit(p, rules, settings);
        if (!pr.hasCost || pr.platforms.length === 0) return null;
        const avg = pr.platforms.reduce((s, pl) => s + pl.result.netProfit, 0) / pr.platforms.length;
        return { id: p.id, name: p.name, profit: avg };
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
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const avgBasket = rev.count > 0 ? rev.total / rev.count : 0;
  const maxBar = Math.max(rev.shopify.rev, rev.trendyol.rev, 1);
  const maxQty = topSellers[0]?.qty ?? 1;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Raporlar</Text>
        <Text style={styles.subtitle}>Son 30 gün — Shopify + Trendyol</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Stat kartları */}
        <View style={styles.statGrid}>
          <Stat label="Ciro" value={formatCurrency(rev.total)} tone="accent" />
          <Stat label="Net kâr" value={formatCurrency(rev.profit)} tone={rev.profit < 0 ? "red" : "green"} />
          <Stat label="Sipariş" value={String(rev.count)} tone="text" />
          <Stat label="Ort. sepet" value={formatCurrency(avgBasket)} tone="text" />
        </View>

        {/* Platform karşılaştırma */}
        <Text style={styles.sectionLabel}>PLATFORM</Text>
        <View style={styles.card}>
          <PlatformBar
            name="Shopify"
            color={ML.shopify}
            rev={rev.shopify.rev}
            profit={rev.shopify.profit}
            pct={(rev.shopify.rev / maxBar) * 100}
          />
          <PlatformBar
            name="Trendyol"
            color={ML.trendyol}
            rev={rev.trendyol.rev}
            profit={rev.trendyol.profit}
            pct={(rev.trendyol.rev / maxBar) * 100}
          />
        </View>

        {/* En çok satanlar */}
        {topSellers.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>EN ÇOK SATANLAR</Text>
            <View style={styles.card}>
              {topSellers.map((s, i) => (
                <View key={i} style={styles.sellerRow}>
                  <Text style={styles.sellerName} numberOfLines={1}>
                    {s.name}
                  </Text>
                  <View style={styles.sellerBarWrap}>
                    <View style={[styles.sellerBar, { width: `${(s.qty / maxQty) * 100}%` }]} />
                  </View>
                  <Text style={styles.sellerQty}>{s.qty}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {/* Kârlılık */}
        {profitability.top.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>EN KÂRLI</Text>
            <View style={styles.card}>
              {profitability.top.map((p) => (
                <ProfitRow key={p.id} name={p.name} profit={p.profit} />
              ))}
            </View>
          </>
        )}
        {profitability.loss.length > 0 && (
          <>
            <Text style={[styles.sectionLabel, { color: ML.red }]}>ZARAR EDENLER</Text>
            <View style={styles.card}>
              {profitability.loss.map((p) => (
                <ProfitRow key={p.id} name={p.name} profit={p.profit} />
              ))}
            </View>
          </>
        )}
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "accent" | "green" | "red" | "text" }) {
  const color = { accent: ML.accent, green: ML.green, red: ML.red, text: ML.text }[tone];
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
    </View>
  );
}

function PlatformBar({ name, color, rev, profit, pct }: { name: string; color: string; rev: number; profit: number; pct: number }) {
  return (
    <View style={styles.platBlock}>
      <View style={styles.platHead}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={[styles.platName, { color }]}>{name}</Text>
        <Text style={styles.platRev}>{formatCurrency(rev)}</Text>
      </View>
      <View style={styles.platTrack}>
        <View style={[styles.platFill, { width: `${Math.max(2, pct)}%`, backgroundColor: color }]} />
      </View>
      <Text style={[styles.platProfit, { color: profit < 0 ? ML.red : ML.green }]}>
        Kâr {formatCurrency(profit)}
      </Text>
    </View>
  );
}

function ProfitRow({ name, profit }: { name: string; profit: number }) {
  return (
    <View style={styles.profitRow}>
      <Text style={styles.profitName} numberOfLines={1}>
        {name}
      </Text>
      <Text style={[styles.profitVal, { color: profit < 0 ? ML.red : ML.green }]}>
        {profit >= 0 ? "+" : ""}
        {formatCurrency(profit)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  title: { color: ML.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: ML.textDim, fontSize: 14, marginTop: 2 },
  content: { padding: 16, gap: 8 },
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  stat: {
    flexGrow: 1,
    flexBasis: "47%",
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
  platTrack: { height: 10, borderRadius: 5, backgroundColor: ML.cardElevated, overflow: "hidden" },
  platFill: { height: "100%", borderRadius: 5 },
  platProfit: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  sellerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  sellerName: { color: ML.textDim, fontSize: 13, width: 110 },
  sellerBarWrap: { flex: 1, height: 8, borderRadius: 4, backgroundColor: ML.cardElevated, overflow: "hidden" },
  sellerBar: { height: "100%", borderRadius: 4, backgroundColor: ML.accent },
  sellerQty: { color: ML.text, fontSize: 13, fontWeight: "700", width: 28, textAlign: "right" },
  profitRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  profitName: { color: ML.textDim, fontSize: 13, flex: 1 },
  profitVal: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
