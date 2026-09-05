import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { StyleSheet, View } from "react-native";

import { Pill } from "@/components/kit/Chip";
import {
  Button,
  ErrorState,
  FadeInView,
  Glass,
  Money,
  Ring,
  Screen,
  Shimmer,
  ShimmerCard,
  SubHeader,
  Tint,
  Txt,
} from "@/components/kit";
import { getAllOrders, ORDERS_STALE_MS, statusInfo } from "@/lib/api/orders";
import { getOrderMatchProducts } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { formatCurrency, formatDate, formatPercent } from "@/lib/format";
import { thumbUrl } from "@/lib/image";
import { computeOrderProfit, getProductMap, matchOrderLine } from "@/lib/order-profit";
import { ORDER_PLATFORM_COLOR, ORDER_PLATFORM_LABEL } from "@/lib/platforms";
import { STATUS_TONE } from "@/lib/status-tone";
import { color, radius, space } from "@/theme/tokens";

/**
 * SİPARİŞ DETAYI — platform + durum, ciro/kâr/marj kartı, satırlar. Kâr hesabı listeyle aynı
 * (tek ürün haritası; satır eşleştirmesi de aynı haritadan → "eşleşmedi" çelişkisi yok).
 */
export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    data: orders,
    error: ordersError,
    isLoading: ordersLoading,
    isError: ordersFailed,
    isRefetching,
    refetch,
  } = useQuery({ queryKey: ["orders"], queryFn: getAllOrders, staleTime: ORDERS_STALE_MS });
  const order = orders?.orders.find((o) => o.id === id);

  const { data: products } = useQuery({ queryKey: ["match-products"], queryFn: getOrderMatchProducts });
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

  if (ordersLoading) {
    return (
      <Screen header={<SubHeader title="Sipariş" />}>
        <Shimmer width="55%" height={18} />
        <Shimmer width="40%" height={12} delay={70} />
        <ShimmerCard height={110} delay={140} />
        {[0, 1, 2].map((i) => (
          <ShimmerCard key={i} height={68} delay={280 + i * 80} />
        ))}
      </Screen>
    );
  }

  if (ordersFailed || !order) {
    // Ham hata metni gösterilmez: kullanıcı için tek satır, eyleme dönük bir cümle.
    return (
      <Screen header={<SubHeader title="Sipariş" />}>
        <ErrorState
          title={ordersFailed ? "Siparişler alınamadı" : "Sipariş bulunamadı"}
          error={
            ordersFailed
              ? ordersError
              : orders?.errors.length
                ? new Error("Bazı satış kanalları şu an yüklenemedi.")
                : new Error("Bu sipariş son 60 günün listesinde yok.")
          }
          onRetry={() => void refetch()}
          retrying={isRefetching}
        />
      </Screen>
    );
  }

  const accent = ORDER_PLATFORM_COLOR[order.platform];
  const st = statusInfo(order);
  const pm = getProductMap(products ?? []);
  const profit = products && rules && settings ? computeOrderProfit(order, pm, rules, settings) : null;
  const margin = profit && profit.profit != null && order.total > 0 ? profit.profit / order.total : null;
  const notlar: string[] = [];
  if (profit?.partial) notlar.push("Bazı ürünler eşleşmedi, kâr kısmi (~).");
  if (profit?.desiEstimated) {
    notlar.push(
      profit.missingDesiCount > 0
        ? `${profit.missingDesiCount} ürünün desisi eksik; kargo 1 desiyle hesaplandı (◆).`
        : "Eşleşmeyen ürünlerin desisi ortalamayla tahmin edildi (◆)."
    );
  }
  if (profit && Math.abs(profit.orderRevenueAdjustment) >= 0.01) {
    notlar.push(
      `Kargo geliri / sipariş indirimi: ${profit.orderRevenueAdjustment >= 0 ? "+" : ""}${formatCurrency(profit.orderRevenueAdjustment)}`
    );
  }

  return (
    <Screen header={<SubHeader title={order.orderNumber} subtitle={formatDate(order.date)} />}>
      {/* Üst bilgi */}
      <FadeInView index={0}>
        <View style={styles.headRow}>
          <View style={[styles.platDot, { backgroundColor: accent }]} />
          <Txt v="heading" style={{ color: accent, flex: 1 }} numberOfLines={1}>
            {ORDER_PLATFORM_LABEL[order.platform]}
          </Txt>
          <Pill color={STATUS_TONE[st.tone]}>{st.label}</Pill>
        </View>
        <Txt v="body" tone="dim" numberOfLines={1}>
          {order.customer ?? "Müşteri adı yok"}
        </Txt>
      </FadeInView>

      {order.isManual && order.editHref ? (
        <Button
          label="Manuel siparişi düzenle"
          icon="pencil"
          variant="secondary"
          size="sm"
          onPress={() => router.push(order.editHref as never)}
          style={{ alignSelf: "flex-start" }}
        />
      ) : null}

      {/* Ciro / kâr / marj */}
      <FadeInView index={1}>
        <Glass style={styles.kpi}>
          <View style={{ flex: 1, gap: space.md }}>
            <View>
              <Txt v="label" tone="faint" style={styles.kicker}>
                CİRO
              </Txt>
              <Money value={order.total} v="title" />
            </View>
            <View>
              <Txt v="label" tone="faint" style={styles.kicker}>
                KÂR
              </Txt>
              {profit?.profit == null ? (
                <Txt v="title" tone="dim">
                  —
                </Txt>
              ) : (
                <View style={styles.rowGap}>
                  {profit.partial ? (
                    <Txt v="heading" tone="dim">
                      ~
                    </Txt>
                  ) : null}
                  <Money value={profit.profit} v="title" tone={profit.profit < 0 ? "bad" : "good"} />
                </View>
              )}
            </View>
          </View>
          <View style={styles.marjCol}>
            <Ring
              value={margin ?? 0}
              size={84}
              stroke={9}
              color={margin == null ? color.textFaint : margin < 0 ? color.bad : margin < 0.2 ? color.warn : color.good}
            >
              <Txt v="smallStrong" num>
                {margin == null ? "—" : formatPercent(margin, 0)}
              </Txt>
            </Ring>
            <Txt v="label" tone="faint" style={styles.kicker}>
              MARJ
            </Txt>
          </View>
        </Glass>
      </FadeInView>

      {notlar.length > 0 ? (
        <Tint style={styles.notes}>
          {notlar.map((n) => (
            <View key={n} style={styles.noteRow}>
              <SymbolView name="info.circle" tintColor={color.textFaint} style={{ width: 14, height: 14 }} />
              <Txt v="small" tone="dim" style={{ flex: 1 }}>
                {n}
              </Txt>
            </View>
          ))}
        </Tint>
      ) : null}

      {/* Satırlar */}
      <Txt v="label" tone="faint" style={styles.section}>
        ÜRÜNLER ({order.items.length})
      </Txt>
      {order.items.map((line, i) => {
        const p = matchOrderLine(line, order.platform, pm);
        const lineImage = line.image ?? p?.imageUrl ?? null;
        return (
          <FadeInView key={i} index={i + 2}>
            <Tint strong style={styles.line}>
              {lineImage ? (
                <Image source={{ uri: thumbUrl(lineImage, 128)! }} alt={line.name} style={styles.lineImg} contentFit="cover" />
              ) : (
                <View style={[styles.lineImg, styles.lineImgEmpty]}>
                  <SymbolView name="cube.box" tintColor={color.textFaint} style={{ width: 18, height: 18 }} />
                </View>
              )}
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="bodyStrong" numberOfLines={2}>
                  {line.name}
                </Txt>
                <Txt v="small" tone="faint" num>
                  {order.isManual ? `${line.quantity} adet` : `${line.quantity} × ${formatCurrency(line.unitPrice)}`}
                  {p || order.isManual ? "" : "  · eşleşmedi"}
                </Txt>
              </View>
              {!order.isManual ? (
                <Txt v="bodyStrong" tone="dim" num>
                  {formatCurrency(line.unitPrice * line.quantity)}
                </Txt>
              ) : null}
            </Tint>
          </FadeInView>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: 2 },
  platDot: { width: 9, height: 9, borderRadius: 5 },
  rowGap: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  kicker: { letterSpacing: 1, marginBottom: 2 },
  kpi: { flexDirection: "row", alignItems: "center", gap: space.lg },
  marjCol: { alignItems: "center", gap: space.xs },
  notes: { gap: space.sm },
  noteRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  section: { letterSpacing: 1.2, marginTop: space.sm, marginLeft: space.xs },
  line: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  lineImg: { width: 48, height: 48, borderRadius: radius.sm, backgroundColor: color.tintStrong },
  lineImgEmpty: { alignItems: "center", justifyContent: "center" },
});
