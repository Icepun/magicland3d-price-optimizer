import { useQuery } from "@tanstack/react-query";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { slugifyTr } from "@core/filament-groups";
import { Chip, Pill } from "@/components/kit/Chip";
import {
  EmptyState,
  FadeInView,
  Header,
  IconButton,
  Screen,
  SearchInput,
  ShimmerList,
  Tint,
  Txt,
} from "@/components/kit";
import {
  getAllOrders,
  isCancelledOrder,
  ORDERS_STALE_MS,
  statusInfo,
  visibleOrders,
  type UnifiedOrder,
} from "@/lib/api/orders";
import { getOrderMatchProducts } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { formatCurrency, formatDate } from "@/lib/format";
import { thumbUrl } from "@/lib/image";
import { computeOrderProfit, getProductMap, type OrderProfit } from "@/lib/order-profit";
import { ORDER_PLATFORM_COLOR, PLATFORM_LABEL, type OrderPlatform } from "@/lib/platforms";
import { STATUS_TONE } from "@/lib/status-tone";
import { useManualRefresh } from "@/lib/use-refresh";
import { color, radius, space } from "@/theme/tokens";

const RowGap = () => <View style={{ height: space.sm }} />;

/**
 * SİPARİŞLER — son 30 gün, platform süzgeci, sipariş no / müşteri / ürün araması.
 * Veri katmanı öncekiyle aynı (60 günlük ortak sorgu, batch kurallar, masaüstüyle birebir kâr).
 * Liste satırları blur'suz saydam yüzey (FlashList geri dönüşümüyle uyumlu, ucuz).
 */
export default function OrdersScreen() {
  const { data, isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["orders"],
    queryFn: getAllOrders,
    staleTime: ORDERS_STALE_MS,
  });
  const { refreshing, onRefresh } = useManualRefresh(refetch);
  // Eşleştirme haritası: görünürlük filtresiz set (masaüstü orders route ile birebir).
  const { data: products } = useQuery({ queryKey: ["match-products"], queryFn: getOrderMatchProducts });
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

  const [arama, setArama] = useState("");
  const [platform, setPlatform] = useState<"hepsi" | OrderPlatform>("hepsi");

  const gorunur = useMemo(() => (data ? visibleOrders(data.orders) : []), [data]);

  const platformSayilari = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of gorunur) m.set(o.platform, (m.get(o.platform) ?? 0) + 1);
    return m;
  }, [gorunur]);

  /** Arama: sipariş no, müşteri, ürün adı — Türkçe karakter duyarsız (ortak slugifyTr). */
  const shown = useMemo(() => {
    let liste = gorunur;
    if (platform !== "hepsi") liste = liste.filter((o) => o.platform === platform);
    const q = slugifyTr(arama.trim());
    if (q.length > 0) {
      liste = liste.filter((o) => {
        if (slugifyTr(o.orderNumber).includes(q)) return true;
        if (o.customer && slugifyTr(o.customer).includes(q)) return true;
        return o.items.some((it) => slugifyTr(it.name ?? "").includes(q));
      });
    }
    return liste;
  }, [gorunur, platform, arama]);

  const profitOf = useMemo(() => {
    const map = new Map<string, OrderProfit>();
    if (!products || !rules || !settings) return map;
    const pm = getProductMap(products);
    for (const o of shown) map.set(o.id, computeOrderProfit(o, pm, rules, settings));
    return map;
  }, [shown, products, rules, settings]);

  // Başlık sayısı masaüstü özetiyle aynı: iptal/iade hariç "aktif" sipariş. Liste yine hepsini gösterir.
  const counts = useMemo(() => {
    if (!data) return null;
    const active = gorunur.filter((o) => !isCancelledOrder(o)).length;
    return { active, cancelled: gorunur.length - active };
  }, [data, gorunur]);

  return (
    <Screen
      scroll={false}
      padded={false}
      header={
        <Header
          title="Siparişler"
          updatedAt={dataUpdatedAt}
          subtitle={
            counts
              ? counts.cancelled > 0
                ? `${counts.active} sipariş · ${counts.cancelled} iptal · son 30 gün`
                : `${counts.active} sipariş · son 30 gün`
              : "yükleniyor…"
          }
          right={
            <IconButton
              icon="plus"
              accent
              onPress={() => router.push("/manual-order/new")}
              accessibilityLabel="Manuel sipariş ekle"
            />
          }
        />
      }
    >
      <View style={styles.filterBar}>
        <SearchInput
          value={arama}
          onChangeText={setArama}
          placeholder="Sipariş no, müşteri veya ürün ara"
          accessibilityLabel="Siparişlerde ara"
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          keyboardShouldPersistTaps="handled"
        >
          <Chip label="Hepsi" selected={platform === "hepsi"} onPress={() => setPlatform("hepsi")} count={gorunur.length} />
          {(["shopify", "trendyol", "hepsiburada", "manual"] as const).map((p) =>
            platformSayilari.get(p) ? (
              <Chip
                key={p}
                label={p === "manual" ? "Manuel" : PLATFORM_LABEL[p]}
                dot={ORDER_PLATFORM_COLOR[p]}
                selected={platform === p}
                onPress={() => setPlatform(p)}
                count={platformSayilari.get(p)}
              />
            ) : null
          )}
        </ScrollView>
      </View>

      {isLoading ? (
        <View style={styles.list}>
          <ShimmerList count={7} height={84} />
        </View>
      ) : (
        <FlashList
          data={shown}
          keyExtractor={(o) => o.id}
          contentContainerStyle={styles.list}
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.accentBright} />
          }
          ListHeaderComponent={
            data?.errors.length ? (
              <Tint strong style={styles.errBox}>
                <Txt v="small" tone="warn">
                  {failedChannels(data.errors)} siparişleri şu an alınamadı.
                </Txt>
              </Tint>
            ) : null
          }
          renderItem={({ item, index }) => {
            const card = <OrderRow order={item} profit={profitOf.get(item.id)} />;
            // Giriş animasyonu yalnız ilk ekrandaki öğelerde — derin kaydırmada kasmasın.
            if (index >= 10) return card;
            return <FadeInView index={index}>{card}</FadeInView>;
          }}
          ListEmptyComponent={
            <EmptyState
              icon="bag"
              title={arama.trim() || platform !== "hepsi" ? "Eşleşen sipariş yok" : "Sipariş yok"}
              hint={arama.trim() ? "Aramayı sadeleştirmeyi dene." : undefined}
            />
          }
          ItemSeparatorComponent={RowGap}
        />
      )}
    </Screen>
  );
}

/** Hangi satış kanalının gelmediğini yazar; teknik hata metni ekrana ASLA basılmaz. */
function failedChannels(errors: string[]): string {
  const names = errors.map((e) => e.split(":")[0]?.trim()).filter((n): n is string => Boolean(n));
  const unique = [...new Set(names)];
  if (unique.length === 0) return "Bazı satış kanalları";
  if (unique.length === 1) return unique[0];
  return `${unique.slice(0, -1).join(", ")} ve ${unique[unique.length - 1]}`;
}

function PhotoBox({ profit, accent, orderId }: { profit?: OrderProfit; accent: string; orderId: string }) {
  if (profit && profit.distinctCount > 1) {
    return (
      <View style={[styles.photo, styles.countBox]}>
        <Txt v="heading" num>
          {profit.distinctCount}
        </Txt>
        <Txt v="label" tone="faint" style={{ fontSize: 10, lineHeight: 12 }}>
          çeşit
        </Txt>
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
          <Txt v="label" tone="onAccent" num style={{ fontSize: 11, lineHeight: 13 }}>
            ×{qty}
          </Txt>
        </View>
      ) : null}
    </View>
  );
}

function OrderRow({ order, profit }: { order: UnifiedOrder; profit?: OrderProfit }) {
  const accent = ORDER_PLATFORM_COLOR[order.platform];
  const st = statusInfo(order);
  const first = order.items[0];
  return (
    <Tint
      strong
      onPress={() => router.push(`/order/${order.id}`)}
      style={styles.card}
      accessibilityLabel={`Sipariş ${order.orderNumber}`}
    >
      <PhotoBox profit={profit} accent={accent} orderId={order.id} />

      <View style={styles.body}>
        <View style={styles.bodyTop}>
          <View style={[styles.platDot, { backgroundColor: accent }]} />
          <Txt v="bodyStrong" num numberOfLines={1} style={{ flexShrink: 1 }}>
            {order.orderNumber}
          </Txt>
          {order.isManual ? <Pill color={color.manual}>Manuel</Pill> : null}
        </View>
        <Txt v="small" tone="dim" numberOfLines={1}>
          {order.customer ?? "—"} · {formatDate(order.date)}
        </Txt>
        <Txt v="small" tone="faint" numberOfLines={1}>
          {first ? first.name : "—"}
        </Txt>
      </View>

      <View style={styles.right}>
        <Txt v="bodyStrong" num>
          {formatCurrency(order.total)}
        </Txt>
        <Pill color={STATUS_TONE[st.tone]}>{st.label}</Pill>
        {profit && profit.profit != null ? (
          <Txt v="smallStrong" tone={profit.profit < 0 ? "bad" : "good"} num>
            {profit.partial ? "~" : ""}
            {formatCurrency(profit.profit)}
            {profit.desiEstimated ? " ◆" : ""}
          </Txt>
        ) : null}
      </View>
    </Tint>
  );
}

const styles = StyleSheet.create({
  filterBar: { paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm },
  chips: { gap: space.sm, paddingRight: space.lg },
  list: { paddingHorizontal: space.lg, paddingTop: space.xs, paddingBottom: space.xxl },
  errBox: { marginBottom: space.sm, padding: space.md, borderColor: color.warn + "66" },
  card: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  photo: { width: 52, height: 52, borderRadius: radius.sm, backgroundColor: color.tintStrong },
  photoEmpty: { alignItems: "center", justifyContent: "center" },
  platDotBig: { width: 12, height: 12, borderRadius: 6 },
  countBox: { alignItems: "center", justifyContent: "center" },
  qtyBadge: {
    position: "absolute",
    top: -6,
    right: -6,
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    minWidth: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
    borderWidth: 2,
    borderColor: color.bg0,
  },
  body: { flex: 1, gap: 2, minWidth: 0 },
  bodyTop: { flexDirection: "row", alignItems: "center", gap: 6 },
  platDot: { width: 7, height: 7, borderRadius: 4 },
  right: { alignItems: "flex-end", gap: 4 },
});
