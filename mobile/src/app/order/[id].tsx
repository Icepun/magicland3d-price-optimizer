import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useLocalSearchParams } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/form";
import { thumbUrl } from "@/lib/image";
import { statusInfo, type OrdersResult, type StatusTone, type UnifiedOrder } from "@/lib/api/orders";
import { getOrderMatchProducts } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { getProductMap, computeOrderProfit, matchOrderLine } from "@/lib/order-profit";
import { formatCurrency, formatDate } from "@/lib/format";
import { ML, radius } from "@/theme/colors";
import { PLATFORM_LABEL } from "@/lib/platforms";

const TONE: Record<StatusTone, string> = {
  green: ML.green,
  orange: ML.orange,
  accent: ML.accent,
  red: ML.red,
  dim: ML.textDim,
};

export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const cached = qc.getQueryData<OrdersResult>(["orders"]);
  const order = cached?.orders.find((o) => o.id === id);

  // Eşleştirme haritası: görünürlük filtresiz set (masaüstü orders route ile birebir).
  const { data: products } = useQuery({ queryKey: ["match-products"], queryFn: getOrderMatchProducts });
  // Tek batch round-trip (getRules) — eski hali 3 ardışık Turso çağrısıydı.
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

  if (!order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader title="Sipariş" />
        <View style={styles.center}>
          <Text style={styles.dim}>Sipariş bulunamadı (listeyi yenile).</Text>
        </View>
      </SafeAreaView>
    );
  }

  const accent = ML[order.platform];
  const st = statusInfo(order);
  // Tek harita: hem kâr hesabı hem satır eşleştirme aynı pm'i kullanır (çifte inşa + çelişki yok).
  const pm = getProductMap(products ?? []);
  const profit =
    products && rules && settings ? computeOrderProfit(order, pm, rules, settings) : null;
  const margin =
    profit && profit.profit != null && order.total > 0 ? profit.profit / order.total : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title={order.orderNumber} />
      <ScrollView contentContainerStyle={styles.content}>
        {/* Üst bilgi */}
        <View style={styles.headRow}>
          <View style={[styles.platDot, { backgroundColor: accent }]} />
          <Text style={[styles.platName, { color: accent }]}>
            {PLATFORM_LABEL[order.platform]}
          </Text>
          <View style={[styles.statusBadge, { backgroundColor: TONE[st.tone] + "22" }]}>
            <Text style={[styles.statusText, { color: TONE[st.tone] }]}>{st.label}</Text>
          </View>
        </View>
        <Text style={styles.sub}>
          {order.customer ?? "—"} · {formatDate(order.date)}
        </Text>

        {/* Kâr/ciro */}
        <View style={styles.kpiCard}>
          <View style={styles.kpiCol}>
            <Text style={styles.kpiLabel}>CİRO</Text>
            <Text style={styles.kpiValue}>{formatCurrency(order.total)}</Text>
          </View>
          <View style={styles.kpiCol}>
            <Text style={styles.kpiLabel}>KÂR</Text>
            <Text
              style={[
                styles.kpiValue,
                { color: profit?.profit == null ? ML.textDim : profit.profit < 0 ? ML.red : ML.green },
              ]}
            >
              {profit?.profit == null ? "—" : `${profit.partial ? "~" : ""}${formatCurrency(profit.profit)}`}
            </Text>
          </View>
          <View style={styles.kpiCol}>
            <Text style={styles.kpiLabel}>MARJ</Text>
            <Text style={styles.kpiValue}>{margin == null ? "—" : `%${(margin * 100).toFixed(1)}`}</Text>
          </View>
        </View>
        {profit?.partial ? (
          <Text style={styles.note}>~ bazı ürünler eşleşmedi, kâr kısmi.</Text>
        ) : null}

        {/* Satırlar */}
        <Text style={styles.sectionLabel}>ÜRÜNLER ({order.items.length})</Text>
        {order.items.map((line, i) => {
          // Kâr kutusuyla AYNI eşleştirme (anahtar + Shopify ad-fallback) — çelişkili "eşleşmedi" bitti.
          const p = matchOrderLine(line, order.platform, pm);
          return (
            <View key={i} style={styles.lineRow}>
              {p?.imageUrl ? (
                <Image source={{ uri: thumbUrl(p.imageUrl, 128)! }} style={styles.lineImg} contentFit="cover" />
              ) : (
                <View style={[styles.lineImg, styles.lineImgEmpty]} />
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.lineName} numberOfLines={2}>
                  {line.name}
                </Text>
                <Text style={styles.lineMeta}>
                  {line.quantity} × {formatCurrency(line.unitPrice)}
                  {p ? "" : "  · eşleşmedi"}
                </Text>
              </View>
              <Text style={styles.lineTotal}>{formatCurrency(line.unitPrice * line.quantity)}</Text>
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  dim: { color: ML.textDim, fontSize: 14 },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  headRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  platDot: { width: 9, height: 9, borderRadius: 5 },
  platName: { fontSize: 17, fontWeight: "700", flex: 1 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  statusText: { fontSize: 12, fontWeight: "700" },
  sub: { color: ML.textDim, fontSize: 14 },
  kpiCard: {
    flexDirection: "row",
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 16,
    marginTop: 6,
  },
  kpiCol: { flex: 1, gap: 4 },
  kpiLabel: { color: ML.textFaint, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  kpiValue: { color: ML.text, fontSize: 20, fontWeight: "800" },
  note: { color: ML.textFaint, fontSize: 12, marginLeft: 4 },
  sectionLabel: {
    color: ML.textFaint,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    marginTop: 10,
    marginLeft: 4,
  },
  lineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 12,
  },
  lineImg: { width: 44, height: 44, borderRadius: 8, backgroundColor: ML.cardElevated },
  lineImgEmpty: { borderWidth: 1, borderColor: ML.border },
  lineName: { color: ML.text, fontSize: 14, fontWeight: "600" },
  lineMeta: { color: ML.textFaint, fontSize: 12, marginTop: 3 },
  lineTotal: { color: ML.textDim, fontSize: 14, fontWeight: "700" },
});
