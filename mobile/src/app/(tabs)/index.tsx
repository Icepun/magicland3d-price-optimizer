import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Chip } from "@/components/ui";
import { AppHeader } from "@/components/AppHeader";
import { PressableScale } from "@/components/ui/PressableScale";
import { AnimatedBar, AnimatedNumber, FadeInView, Skeleton, SkeletonCard } from "@/components/fade-in";
import { useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getAllOrders, isCancelledOrder, ORDERS_STALE_MS } from "@/lib/api/orders";
import { getDashboardData, getOrderMatchProducts } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { computeDashboard, type PlatformSummary } from "@/lib/dashboard";
import { getProductMap, computeOrderProfit } from "@/lib/order-profit";
import { useManualRefresh } from "@/lib/use-refresh";
import { formatCurrency, formatNumber, formatPercent, friendlyError } from "@/lib/format";
import { ML, motion, radius } from "@/theme/colors";
import { ORDER_PLATFORMS, ORDER_PLATFORM_LABEL } from "@/lib/platforms";

export default function DashboardScreen() {
  const { data: products, isLoading, isError, error, refetch: refetchProducts } = useQuery({
    queryKey: ["dashboard-data"],
    queryFn: getDashboardData,
  });
  // Tek batch round-trip (getRules) — eski hali 3 ardışık Turso çağrısıydı.
  /** Panel dönemi: 7 / 30 / 60 gün. Kaynak sorgu zaten 60 gün, ek ağ isteği YOK. */
  const [donem, setDonem] = useState<7 | 30 | 60>(30);
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  const { data: ordersData, refetch: refetchOrders, dataUpdatedAt: ordersAt } = useQuery({
    queryKey: ["orders"],
    queryFn: getAllOrders,
    staleTime: ORDERS_STALE_MS,
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
      ORDER_PLATFORMS.map((p) => [p, { rev: 0, n: 0 }])
    );
    let total = 0;
    let profit = 0;
    let count = 0;
    /**
     * DÖNEM SÜZGECİ — kaynak sorgu 60 gün getiriyor; kullanıcı 7/30/60 arasında seçiyor.
     * "Şimdi" olarak sorgunun ÇEKİLDİĞİ an kullanılır (`dataUpdatedAt`): render sırasında
     * `Date.now()` çağırmak React Compiler hatası veriyor ve mobil lint adımını düşürüyor.
     */
    const kesim = ordersAt ? ordersAt - donem * 86_400_000 : 0;
    for (const o of ordersData.orders.filter((o) => o.date == null || o.date >= kesim)) {
      // Masaüstü özetiyle birebir: iptal/iade/teslim-edilemedi siparişler ciro/kâr/sayıma girmez.
      if (isCancelledOrder(o)) continue;
      // Döviz çevrimi yapılmadan farklı para birimlerini TL toplamına eklemek yanlış sonuç verir
      // (masaüstü ve Raporlar sekmesi de bu siparişleri hariç tutuyor — üçü artık aynı).
      if ((o.currency ?? "TRY").trim().toUpperCase() !== "TRY") continue;
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
  }, [ordersData, matchProducts, rules, settings, donem, ordersAt]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title="Panel" subtitle="Pazaryerleri + manuel satışlar" />

      {isError ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Veriler alınamadı</Text>
          <Text style={styles.subtitle}>{friendlyError(error)}</Text>
          <PressableScale onPress={() => refetchProducts()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Tekrar dene</Text>
          </PressableScale>
        </View>
      ) : isLoading || !summary ? (
        <DashboardSkeleton />
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ML.accent} />
          }
        >
          {/* Son 30 gün ciro/kâr */}
          <FadeInView style={styles.revCard}>
            <View style={styles.revHead}>
              <Text style={styles.revLabel}>SON {donem} GÜN</Text>
              <View style={styles.periodChips}>
                {([7, 30, 60] as const).map((d) => (
                  <Chip key={d} label={`${d}g`} selected={donem === d} onPress={() => setDonem(d)} />
                ))}
              </View>
            </View>
            <View style={styles.revTopRow}>
              <View>
                <Text style={styles.revCiroLabel}>Ciro</Text>
                {rev ? (
                  <AnimatedNumber
                    value={rev.total}
                    format={(n) => formatCurrency(n)}
                    style={styles.revCiro}
                  />
                ) : (
                  <Skeleton width={150} height={28} style={{ marginTop: 4 }} />
                )}
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.revCiroLabel}>Sipariş kârı</Text>
                {rev ? (
                  <AnimatedNumber
                    value={rev.profit}
                    format={(n) => formatCurrency(n)}
                    style={[styles.revProfit, { color: rev.profit < 0 ? ML.red : ML.green }]}
                  />
                ) : (
                  <Skeleton width={110} height={22} delay={90} style={{ marginTop: 4 }} />
                )}
              </View>
            </View>
            <View style={styles.revSplit}>
              {ORDER_PLATFORMS.map((plat, i) => (
                <View key={plat} style={styles.revPlat}>
                  <View style={[styles.dot, { backgroundColor: ML[plat] }]} />
                  <Text style={styles.revPlatText}>{ORDER_PLATFORM_LABEL[plat]}</Text>
                  {rev ? (
                    <>
                      <AnimatedNumber
                        value={rev.byPlat[plat].rev}
                        format={(n) => formatCurrency(n)}
                        style={styles.revPlatText}
                      />
                      <AnimatedNumber
                        value={rev.byPlat[plat].n}
                        format={(n) => formatNumber(Math.round(n))}
                        style={styles.revPlatN}
                      />
                    </>
                  ) : (
                    <Skeleton width={92} height={12} delay={i * 70} />
                  )}
                </View>
              ))}
            </View>
          </FadeInView>

          {/* Stok/ürün durumu */}
          <View style={styles.grid}>
            <Stat
              label="Toplam Ürün"
              value={summary.totalProducts}
              tone="accent"
              index={0}
              onPress={() => router.push({ pathname: "/products", params: { filter: "all" } })}
            />
            <Stat
              label="Stokta Biten"
              value={summary.outOfStock}
              tone="orange"
              index={1}
              onPress={() => router.push({ pathname: "/products", params: { filter: "out-of-stock" } })}
            />
            <Stat
              label="Zarar Eden Ürün"
              value={summary.lossListings}
              tone="red"
              index={2}
              onPress={() => router.push({ pathname: "/products", params: { filter: "loss" } })}
              wide
            />
          </View>

          <Text style={styles.sectionLabel}>PLATFORM BAZLI (MARJ)</Text>
          {summary.platforms.map((p, i) => (
            <PlatformRow key={p.platform} p={p} index={i} />
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

function PlatformRow({ p, index }: { p: PlatformSummary; index: number }) {
  const accent = ML[p.platform];
  const lossPct = p.listingCount > 0 ? (p.lossCount / p.listingCount) * 100 : 0;
  return (
    <FadeInView index={index} baseDelay={140} style={styles.platformCard}>
      <View style={styles.platformHead}>
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <Text style={[styles.platformName, { color: accent }]}>
          {ORDER_PLATFORM_LABEL[p.platform]}
        </Text>
        <Text style={styles.listingCount}>{p.listingCount} listing</Text>
      </View>
      <View style={styles.platformStats}>
        <View>
          <Text style={styles.miniLabel}>Ortalama Marj</Text>
          <AnimatedNumber
            value={p.avgMargin}
            format={(n) => formatPercent(n)}
            style={[styles.miniValue, { color: p.avgMargin < 0 ? ML.red : ML.green }]}
          />
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.miniLabel}>Zarar Eden</Text>
          <AnimatedNumber
            value={p.lossCount}
            format={(n) => `${formatNumber(Math.round(n))} / ${formatNumber(p.listingCount)}`}
            style={[styles.miniValue, { color: p.lossCount ? ML.red : ML.textDim }]}
          />
        </View>
      </View>
      <AnimatedBar
        percent={lossPct}
        color={ML.red}
        height={5}
        minPercent={lossPct > 0 ? 3 : 0}
        delay={index * motion.stagger}
      />
    </FadeInView>
  );
}

function Stat({
  label,
  value,
  tone,
  wide,
  index,
  onPress,
}: {
  label: string;
  value: number;
  tone: "accent" | "green" | "red" | "orange";
  wide?: boolean;
  index: number;
  onPress?: () => void;
}) {
  const color = { accent: ML.accent, green: ML.green, red: ML.red, orange: ML.orange }[tone];
  return (
    <FadeInView index={index} style={[wide && styles.statWide, !wide && styles.statHalf]}>
      <PressableScale
        onPress={onPress}
        style={({ pressed }) => [styles.stat, pressed && onPress ? { opacity: 0.7 } : null]}
      >
        <Text style={styles.statLabel}>{label}</Text>
        <AnimatedNumber
          value={value}
          format={(n) => formatNumber(Math.round(n))}
          style={[styles.statValue, { color }]}
        />
        {onPress ? <Text style={styles.statChevron}>›</Text> : null}
      </PressableScale>
    </FadeInView>
  );
}

/** Panel yüklenirken kartların yerini tutan iskelet — boş ekran ya da tek çark yerine. */
function DashboardSkeleton() {
  return (
    <View style={styles.content}>
      <View style={styles.revCard}>
        <Skeleton width={90} height={11} />
        <View style={styles.revTopRow}>
          <View style={{ gap: 8 }}>
            <Skeleton width={54} height={11} />
            <Skeleton width={160} height={28} delay={60} />
          </View>
          <View style={{ gap: 8, alignItems: "flex-end" }}>
            <Skeleton width={72} height={11} delay={40} />
            <Skeleton width={104} height={22} delay={100} />
          </View>
        </View>
        <View style={styles.revSplit}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} width="62%" height={12} delay={140 + i * 60} />
          ))}
        </View>
      </View>
      <View style={styles.grid}>
        <View style={styles.statHalf}>
          <SkeletonCard height={92} />
        </View>
        <View style={styles.statHalf}>
          <SkeletonCard height={92} delay={80} />
        </View>
        <View style={styles.statWide}>
          <SkeletonCard height={92} delay={160} />
        </View>
      </View>
      <SkeletonCard height={104} delay={240} />
      <SkeletonCard height={104} delay={320} />
    </View>
  );
}

const styles = StyleSheet.create({
  revHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  periodChips: { flexDirection: "row", gap: 6 },
  safe: { flex: 1, backgroundColor: ML.bg },
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
