import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import { FlashList } from "@shopify/flash-list";
import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getAllOrders, isCancelledOrder, ORDERS_STALE_MS, statusInfo, type StatusTone, type UnifiedOrder } from "@/lib/api/orders";
import { thumbUrl } from "@/lib/image";
import { getOrderMatchProducts } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { getProductMap, computeOrderProfit, type OrderProfit } from "@/lib/order-profit";
import { useManualRefresh } from "@/lib/use-refresh";
import { formatCurrency, formatDate } from "@/lib/format";
import { FadeInView } from "@/components/fade-in";
import { ML, radius } from "@/theme/colors";

const TONE: Record<StatusTone, string> = {
  green: ML.green,
  orange: ML.orange,
  accent: ML.accent,
  red: ML.red,
  dim: ML.textDim,
};

const RowGap = () => <View style={{ height: 10 }} />;

export default function OrdersScreen() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["orders"],
    queryFn: getAllOrders,
    staleTime: ORDERS_STALE_MS,
  });
  const { refreshing, onRefresh } = useManualRefresh(refetch);
  // Eşleştirme haritası: görünürlük filtresiz set (masaüstü orders route ile birebir) —
  // gizlenen/pasifleşen ürünün eski siparişi kârsız düşmesin.
  const { data: products } = useQuery({ queryKey: ["match-products"], queryFn: getOrderMatchProducts });
  // Tek batch round-trip (getRules) — eski hali 3 ardışık Turso çağrısıydı.
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

  const profitOf = useMemo(() => {
    const map = new Map<string, OrderProfit>();
    if (!data || !products || !rules || !settings) return map;
    const pm = getProductMap(products);
    for (const o of data.orders) map.set(o.id, computeOrderProfit(o, pm, rules, settings));
    return map;
  }, [data, products, rules, settings]);

  // Başlık sayısı masaüstü özetiyle aynı: iptal/iade hariç "aktif" sipariş. Liste yine hepsini gösterir.
  const counts = useMemo(() => {
    if (!data) return null;
    const active = data.orders.filter((o) => !isCancelledOrder(o)).length;
    return { active, cancelled: data.orders.length - active };
  }, [data]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Siparişler</Text>
        <Text style={styles.subtitle}>
          {counts
            ? counts.cancelled > 0
              ? `${counts.active} sipariş · ${counts.cancelled} iptal · son 30`
              : `${counts.active} sipariş · son 30`
            : "yükleniyor…"}
        </Text>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
          <Text style={styles.dim}>Shopify + Trendyol + Hepsiburada çekiliyor…</Text>
        </View>
      ) : (
        <FlashList
          data={data?.orders ?? []}
          keyExtractor={(o) => o.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ML.accent} />
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
          renderItem={({ item, index }) => {
            const card = <OrderCard order={item} profit={profitOf.get(item.id)} />;
            // Giriş animasyonu yalnızca ilk ekrandaki öğelerde — derin kaydırmada kasmasın.
            if (index >= 10) return card;
            return (
              <FadeInView index={index}>
                {card}
              </FadeInView>
            );
          }}
          ListEmptyComponent={
            <Text style={[styles.dim, { textAlign: "center", marginTop: 40 }]}>Sipariş yok</Text>
          }
          ItemSeparatorComponent={RowGap}
        />
      )}
    </SafeAreaView>
  );
}

function PhotoBox({ profit, accent, orderId }: { profit?: OrderProfit; accent: string; orderId: string }) {
  if (profit && profit.distinctCount > 1) {
    return (
      <View style={[styles.photo, styles.countBox]}>
        <Text style={styles.countNum}>{profit.distinctCount}</Text>
        <Text style={styles.countLabel}>çeşit</Text>
      </View>
    );
  }
  const qty = profit?.totalQty ?? 1;
  return (
    <View>
      {profit?.image ? (
        <Image
          source={{ uri: thumbUrl(profit.image, 160)! }}
          alt="Sipariş ürünü"
          style={styles.photo}
          contentFit="cover"
          transition={150}
          recyclingKey={orderId}
        />
      ) : (
        <View style={[styles.photo, styles.photoEmpty]}>
          <View style={[styles.platDotBig, { backgroundColor: accent }]} />
        </View>
      )}
      {qty > 1 ? (
        <View style={styles.qtyBadge}>
          <Text style={styles.qtyText}>×{qty}</Text>
        </View>
      ) : null}
    </View>
  );
}

function OrderCard({ order, profit }: { order: UnifiedOrder; profit?: OrderProfit }) {
  const accent = ML[order.platform];
  const st = statusInfo(order);
  const first = order.items[0];
  return (
    <Pressable
      onPress={() => router.push(`/order/${order.id}`)}
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: ML.cardElevated }]}
    >
      <PhotoBox profit={profit} accent={accent} orderId={order.id} />

      <View style={styles.body}>
        <View style={styles.bodyTop}>
          <View style={[styles.platDot, { backgroundColor: accent }]} />
          <Text style={styles.orderNo} numberOfLines={1}>
            {order.orderNumber}
          </Text>
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          {order.customer ?? "—"} · {formatDate(order.date)}
        </Text>
        <Text style={styles.item} numberOfLines={1}>
          {first ? first.name : "—"}
        </Text>
      </View>

      <View style={styles.right}>
        <Text style={styles.total}>{formatCurrency(order.total)}</Text>
        <View style={[styles.statusBadge, { backgroundColor: TONE[st.tone] + "22" }]}>
          <Text style={[styles.statusText, { color: TONE[st.tone] }]}>{st.label}</Text>
        </View>
        {profit && profit.profit != null ? (
          <Text style={[styles.profit, { color: profit.profit < 0 ? ML.red : ML.green }]}>
            {profit.partial ? "~" : ""}
            {formatCurrency(profit.profit)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  title: { color: ML.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: ML.textDim, fontSize: 14, marginTop: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  dim: { color: ML.textDim, fontSize: 14 },
  list: { padding: 16, paddingBottom: 24 },
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
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 12,
  },
  photo: { width: 52, height: 52, borderRadius: radius.md, backgroundColor: ML.cardElevated },
  photoEmpty: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: ML.border },
  platDotBig: { width: 12, height: 12, borderRadius: 6 },
  countBox: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: ML.border },
  countNum: { color: ML.text, fontSize: 20, fontWeight: "800" },
  countLabel: { color: ML.textFaint, fontSize: 10, marginTop: -2 },
  qtyBadge: {
    position: "absolute",
    top: -6,
    right: -6,
    backgroundColor: ML.accent,
    borderRadius: 999,
    minWidth: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
    borderWidth: 2,
    borderColor: ML.card,
  },
  qtyText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  body: { flex: 1, gap: 3 },
  bodyTop: { flexDirection: "row", alignItems: "center", gap: 7 },
  platDot: { width: 7, height: 7, borderRadius: 4 },
  orderNo: { color: ML.text, fontSize: 15, fontWeight: "700", flex: 1 },
  meta: { color: ML.textDim, fontSize: 12 },
  item: { color: ML.textFaint, fontSize: 12 },
  right: { alignItems: "flex-end", gap: 4 },
  total: { color: ML.text, fontSize: 15, fontWeight: "800" },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  statusText: { fontSize: 11, fontWeight: "700" },
  profit: { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
