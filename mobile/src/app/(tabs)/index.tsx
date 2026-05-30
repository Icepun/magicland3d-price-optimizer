import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { MotiView } from "moti";
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

import { getDashboardData } from "@/lib/db/dashboard";
import { getCargoRules, getCommissionRules, getExpenseRules, getSettingsMap } from "@/lib/db/rules";
import { computeDashboard, type PlatformSummary } from "@/lib/dashboard";
import { formatCurrency, formatPercent } from "@/lib/format";
import { ML, radius } from "@/theme/colors";

export default function DashboardScreen() {
  const { data: products, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["dashboard-data"],
    queryFn: getDashboardData,
  });
  const { data: rules } = useQuery({
    queryKey: ["rules"],
    queryFn: async () => ({
      commission: await getCommissionRules(),
      cargo: await getCargoRules(),
      expense: await getExpenseRules(),
    }),
  });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

  const summary =
    products && rules && settings ? computeDashboard(products, rules, settings) : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Panel</Text>
        <Text style={styles.subtitle}>3 platformda net durum</Text>
      </View>

      {isLoading || !summary ? (
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={ML.accent} />
          }
        >
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
              label="Zarar Eden"
              value={String(summary.lossListings)}
              tone="red"
              onPress={() => router.push({ pathname: "/products", params: { filter: "loss" } })}
            />
            <Stat
              label="Tahmini Kâr"
              value={formatCurrency(summary.totalProfit)}
              tone={summary.totalProfit >= 0 ? "green" : "red"}
              wide
            />
          </View>

          <Text style={styles.sectionLabel}>PLATFORM BAZLI</Text>
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
  const accent = p.platform === "shopify" ? ML.shopify : ML.trendyol;
  const loss = p.totalProfit < 0;
  return (
    <MotiView
      from={{ opacity: 0, translateY: 12 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: "timing", duration: 360, delay: 120 }}
      style={styles.platformCard}
    >
      <View style={styles.platformHead}>
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <Text style={[styles.platformName, { color: accent }]}>
          {p.platform === "shopify" ? "Shopify" : "Trendyol"}
        </Text>
        <Text style={styles.listingCount}>{p.listingCount} listing</Text>
      </View>
      <View style={styles.platformStats}>
        <View>
          <Text style={styles.miniLabel}>Toplam Kâr</Text>
          <Text style={[styles.miniValue, { color: loss ? ML.red : ML.green }]}>
            {formatCurrency(p.totalProfit)}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.miniLabel}>Ort. Marj</Text>
          <Text style={styles.miniValue}>{formatPercent(p.avgMargin)}</Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.miniLabel}>Zarar</Text>
          <Text style={[styles.miniValue, { color: p.lossCount ? ML.red : ML.textDim }]}>
            {p.lossCount}
          </Text>
        </View>
      </View>
    </MotiView>
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
    <MotiView
      from={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "timing", duration: 320 }}
      style={[wide && styles.statWide, !wide && styles.statHalf]}
    >
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.stat, pressed && onPress ? { opacity: 0.7 } : null]}
      >
        <Text style={styles.statLabel}>{label}</Text>
        <Text style={[styles.statValue, { color }]}>{value}</Text>
        {onPress ? <Text style={styles.statChevron}>›</Text> : null}
      </Pressable>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  title: { color: ML.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: ML.textDim, fontSize: 14, marginTop: 2 },
  content: { padding: 16, gap: 12, paddingBottom: 110 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
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
