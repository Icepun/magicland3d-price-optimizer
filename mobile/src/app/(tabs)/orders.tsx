import { useQuery } from "@tanstack/react-query";
import { MotiView } from "moti";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getAllOrders, statusInfo, type StatusTone, type UnifiedOrder } from "@/lib/api/orders";
import { formatCurrency, formatDate } from "@/lib/format";
import { ML, radius } from "@/theme/colors";

const TONE: Record<StatusTone, string> = {
  green: ML.green,
  orange: ML.orange,
  accent: ML.accent,
  red: ML.red,
  dim: ML.textDim,
};

export default function OrdersScreen() {
  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["orders"],
    queryFn: getAllOrders,
    staleTime: 60_000,
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Siparişler</Text>
        <Text style={styles.subtitle}>
          {data ? `${data.orders.length} sipariş · son 30` : "yükleniyor…"}
        </Text>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
          <Text style={styles.dim}>Shopify + Trendyol çekiliyor…</Text>
        </View>
      ) : (
        <FlatList
          data={data?.orders ?? []}
          keyExtractor={(o) => o.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={ML.accent} />
          }
          ListHeaderComponent={
            data?.errors.length ? (
              <View style={styles.errBox}>
                {data.errors.map((e, i) => (
                  <Text key={i} style={styles.errText} numberOfLines={2}>
                    ⚠ {e}
                  </Text>
                ))}
              </View>
            ) : null
          }
          renderItem={({ item, index }) => (
            <MotiView
              from={{ opacity: 0, translateY: 12 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={{ type: "timing", duration: 260, delay: Math.min(index, 10) * 24 }}
            >
              <OrderCard order={item} />
            </MotiView>
          )}
          ListEmptyComponent={
            <Text style={[styles.dim, { textAlign: "center", marginTop: 40 }]}>Sipariş yok</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

function OrderCard({ order }: { order: UnifiedOrder }) {
  const accent = order.platform === "shopify" ? ML.shopify : ML.trendyol;
  const st = statusInfo(order);
  const first = order.items[0];
  const extra = order.items.length - 1;
  return (
    <View style={styles.card}>
      <View style={styles.row1}>
        <View style={styles.row1Left}>
          <View style={[styles.dot, { backgroundColor: accent }]} />
          <Text style={styles.orderNo}>{order.orderNumber}</Text>
        </View>
        <Text style={styles.total}>{formatCurrency(order.total)}</Text>
      </View>

      <View style={styles.row2}>
        <Text style={styles.meta} numberOfLines={1}>
          {order.customer ?? "—"} · {formatDate(order.date)}
        </Text>
        <View style={[styles.statusBadge, { backgroundColor: TONE[st.tone] + "22" }]}>
          <Text style={[styles.statusText, { color: TONE[st.tone] }]}>{st.label}</Text>
        </View>
      </View>

      {first ? (
        <Text style={styles.item} numberOfLines={1}>
          {first.quantity > 1 ? `${first.quantity}× ` : ""}
          {first.name}
          {extra > 0 ? `  +${extra}` : ""}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  title: { color: ML.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: ML.textDim, fontSize: 14, marginTop: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  dim: { color: ML.textDim, fontSize: 14 },
  list: { padding: 16, paddingBottom: 110, gap: 10 },
  errBox: {
    backgroundColor: ML.redSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.red,
    padding: 12,
    marginBottom: 10,
    gap: 4,
  },
  errText: { color: ML.red, fontSize: 12 },
  card: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 16,
    gap: 8,
  },
  row1: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  row1Left: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  orderNo: { color: ML.text, fontSize: 16, fontWeight: "700" },
  total: { color: ML.text, fontSize: 16, fontWeight: "800" },
  row2: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  meta: { color: ML.textDim, fontSize: 13, flex: 1 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  statusText: { fontSize: 12, fontWeight: "700" },
  item: { color: ML.textFaint, fontSize: 13 },
});
