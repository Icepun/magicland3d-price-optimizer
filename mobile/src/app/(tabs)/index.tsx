import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { FadeInView } from "@/components/fade-in";
import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SymbolView } from "expo-symbols";

import { getAllOrders, isCancelledOrder, ORDERS_STALE_MS } from "@/lib/api/orders";
import { getNotifications } from "@/lib/db/notifications";
import { getDashboardData, getOrderMatchProducts } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { computeDashboard, type PlatformSummary } from "@/lib/dashboard";
import { getProductMap, computeOrderProfit } from "@/lib/order-profit";
import { useManualRefresh } from "@/lib/use-refresh";
import { formatCurrency, formatPercent } from "@/lib/format";
import { ML, radius } from "@/theme/colors";
import { PLATFORMS, PLATFORM_LABEL } from "@/lib/platforms";

export default function DashboardScreen() {
  const { data: products, isLoading, isError, error, refetch: refetchProducts } = useQuery({
    queryKey: ["dashboard-data"],
    queryFn: getDashboardData,
  });
  // Tek batch round-trip (getRules) — eski hali 3 ardışık Turso çağrısıydı.
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  const { data: ordersData, refetch: refetchOrders } = useQuery({
    queryKey: ["orders"],
    queryFn: getAllOrders,
    staleTime: ORDERS_STALE_MS,
  });
  const { data: notif } = useQuery({
    queryKey: ["notifications"],
    queryFn: getNotifications,
    refetchInterval: 60_000,
  });

  const summary = useMemo(
    () => (products && rules && settings ? computeDashboard(products, rules, settings) : null),
    [products, rules, settings]
  );
  const qc = useQueryClient();
  const { refreshing, onRefresh } = useManualRefresh(() =>
    Promise.all([
      refetchProducts(),
      refetchOrders(),
      // Masaüstünde değişen kural/ayarlar da pull ile gelsin (batch → 1-2 round-trip).
      qc.invalidateQueries({ queryKey: ["rules"] }),
      qc.invalidateQueries({ queryKey: ["settings"] }),
      qc.invalidateQueries({ queryKey: ["match-products"] }),
    ])
  );

  // Sipariş eşleştirme haritası: görünürlük filtresiz set (masaüstü orders route ile birebir).
  const { data: matchProducts } = useQuery({
    queryKey: ["match-products"],
    queryFn: getOrderMatchProducts,
  });

  const rev = useMemo(() => {
    if (!ordersData || !matchProducts || !rules || !settings) return null;
    const pm = getProductMap(matchProducts);
    const byPlat: Record<string, { rev: number; n: number }> = Object.fromEntries(
      PLATFORMS.map((p) => [p, { rev: 0, n: 0 }])
    );
    let total = 0;
    let profit = 0;
    let count = 0;
    for (const o of ordersData.orders) {
      // Masaüstü özetiyle birebir: iptal/iade/teslim-edilemedi siparişler ciro/kâr/sayıma girmez.
      if (isCancelledOrder(o)) continue;
      const op = computeOrderProfit(o, pm, rules, settings);
      total += op.revenue;
      const b = byPlat[o.platform];
      if (b) {
        b.rev += op.revenue;
        b.n++;
      }
      if (op.profit != null) profit += op.profit;
      count++;
    }
    return { total, profit, byPlat, count };
  }, [ordersData, matchProducts, rules, settings]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Panel</Text>
          <Text style={styles.subtitle}>Shopify + Trendyol + Hepsiburada</Text>
        </View>
        <Pressable onPress={() => router.push("/notifications" as never)} hitSlop={12} style={styles.bell}>
          <SymbolView name="bell.fill" tintColor={ML.textDim} style={{ width: 24, height: 24 }} />
          {notif && notif.counts.total > 0 ? (
            <View
              style={[
                styles.bellBadge,
                { backgroundColor: notif.counts.critical > 0 ? ML.red : ML.orange },
              ]}
            >
              <Text style={styles.bellBadgeText}>
                {notif.counts.total > 9 ? "9+" : notif.counts.total}
              </Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      {isError ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Bağlanılamadı</Text>
          <Text style={styles.subtitle}>{(error as Error)?.message}</Text>
          <Pressable onPress={() => refetchProducts()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Tekrar dene</Text>
          </Pressable>
        </View>
      ) : isLoading || !summary ? (
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ML.accent} />
          }
        >
          {/* Son 30 gün ciro/kâr */}
          <View style={styles.revCard}>
            <Text style={styles.revLabel}>SON 30 GÜN</Text>
            <View style={styles.revTopRow}>
              <View>
                <Text style={styles.revCiroLabel}>Ciro</Text>
                <Text style={styles.revCiro}>{rev ? formatCurrency(rev.total) : "…"}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.revCiroLabel}>Sipariş kârı</Text>
                <Text style={[styles.revProfit, { color: (rev?.profit ?? 0) < 0 ? ML.red : ML.green }]}>
                  {rev ? formatCurrency(rev.profit) : "…"}
                </Text>
              </View>
            </View>
            <View style={styles.revSplit}>
              {PLATFORMS.map((plat) => (
                <View key={plat} style={styles.revPlat}>
                  <View style={[styles.dot, { backgroundColor: ML[plat] }]} />
                  <Text style={styles.revPlatText}>
                    {PLATFORM_LABEL[plat]} {rev ? formatCurrency(rev.byPlat[plat].rev) : "…"}
                    <Text style={styles.revPlatN}>{rev ? `  ${rev.byPlat[plat].n}` : ""}</Text>
                  </Text>
                </View>
              ))}
            </View>
          </View>

          {/* Stok/ürün durumu */}
          <View style={styles.grid}>
            <Stat
              label="Toplam Ürün"
              value={String(summary.totalProducts)}
              tone="accent"
              onPress={() => router.push({ pathname: "/products", params: { filter: "all" } })}
            />
            <Stat
              label="Stokta Biten"
              value={String(summary.outOfStock)}
              tone="orange"
              onPress={() => router.push({ pathname: "/products", params: { filter: "out-of-stock" } })}
            />
            <Stat
              label="Zarar Eden Ürün"
              value={String(summary.lossListings)}
              tone="red"
              onPress={() => router.push({ pathname: "/products", params: { filter: "loss" } })}
              wide
            />
          </View>

          <Text style={styles.sectionLabel}>PLATFORM BAZLI (MARJ)</Text>
          {summary.platforms.map((p) => (
            <PlatformRow key={p.platform} p={p} />
          ))}

          {summary.missingCost > 0 && (
            <Text style={styles.note}>
              {summary.missingCost} üründe maliyet girilmemiş — kâr hesabı dışı.
            </Text>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function PlatformRow({ p }: { p: PlatformSummary }) {
  const accent = ML[p.platform];
  return (
    <FadeInView duration={360} baseDelay={120} style={styles.platformCard}>
      <View style={styles.platformHead}>
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <Text style={[styles.platformName, { color: accent }]}>
          {PLATFORM_LABEL[p.platform]}
        </Text>
        <Text style={styles.listingCount}>{p.listingCount} listing</Text>
      </View>
      <View style={styles.platformStats}>
        <View>
          <Text style={styles.miniLabel}>Ortalama Marj</Text>
          <Text style={[styles.miniValue, { color: p.avgMargin < 0 ? ML.red : ML.green }]}>
            {formatPercent(p.avgMargin)}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.miniLabel}>Zarar Eden</Text>
          <Text style={[styles.miniValue, { color: p.lossCount ? ML.red : ML.textDim }]}>
            {p.lossCount} / {p.listingCount}
          </Text>
        </View>
      </View>
    </FadeInView>
  );
}

function Stat({
  label,
  value,
  tone,
  wide,
  onPress,
}: {
  label: string;
  value: string;
  tone: "accent" | "green" | "red" | "orange";
  wide?: boolean;
  onPress?: () => void;
}) {
  const color = { accent: ML.accent, green: ML.green, red: ML.red, orange: ML.orange }[tone];
  return (
    <FadeInView duration={320} style={[wide && styles.statWide, !wide && styles.statHalf]}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.stat, pressed && onPress ? { opacity: 0.7 } : null]}
      >
        <Text style={styles.statLabel}>{label}</Text>
        <Text style={[styles.statValue, { color }]}>{value}</Text>
        {onPress ? <Text style={styles.statChevron}>›</Text> : null}
      </Pressable>
    </FadeInView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  bell: { padding: 6 },
  bellBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 999,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: ML.bg,
  },
  bellBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800" },
  title: { color: ML.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: ML.textDim, fontSize: 14, marginTop: 2 },
  content: { padding: 16, gap: 12, paddingBottom: 24 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
  errorTitle: { color: ML.text, fontSize: 17, fontWeight: "700" },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ML.accent + "77",
  },
  retryText: { color: ML.accent, fontSize: 14, fontWeight: "700" },
  revCard: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.border,
    padding: 18,
    gap: 14,
  },
  revLabel: { color: ML.accent, fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  revTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  revCiroLabel: { color: ML.textDim, fontSize: 12 },
  revCiro: { color: ML.text, fontSize: 30, fontWeight: "800", letterSpacing: -0.5, marginTop: 2 },
  revProfit: { fontSize: 22, fontWeight: "800", marginTop: 2 },
  revSplit: { gap: 8 },
  revPlat: { flexDirection: "row", alignItems: "center", gap: 6 },
  revPlatText: { color: ML.textDim, fontSize: 13, fontWeight: "600" },
  revPlatN: { color: ML.textFaint, fontSize: 12, fontWeight: "400" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  statHalf: { flexGrow: 1, flexBasis: "47%" },
  statWide: { flexGrow: 1, flexBasis: "100%" },
  stat: {
    flex: 1,
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 16,
  },
  statChevron: { position: "absolute", top: 12, right: 14, color: ML.textFaint, fontSize: 20 },
  statLabel: { color: ML.textDim, fontSize: 13 },
  statValue: { fontSize: 28, fontWeight: "800", marginTop: 6, letterSpacing: -0.5 },
  sectionLabel: {
    color: ML.textFaint,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    marginTop: 8,
    marginLeft: 4,
  },
  platformCard: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 16,
    gap: 12,
  },
  platformHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  platformName: { fontSize: 16, fontWeight: "700", flex: 1 },
  listingCount: { color: ML.textFaint, fontSize: 13 },
  platformStats: { flexDirection: "row", justifyContent: "space-between" },
  miniLabel: { color: ML.textFaint, fontSize: 11 },
  miniValue: { color: ML.text, fontSize: 18, fontWeight: "700", marginTop: 3 },
  note: { color: ML.textFaint, fontSize: 12, textAlign: "center", marginTop: 8 },
});
