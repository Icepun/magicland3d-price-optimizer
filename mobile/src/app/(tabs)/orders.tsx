import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { FlashList } from "@shopify/flash-list";
import { useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { slugifyTr } from "@core/filament-groups";
import { Chip } from "@/components/ui";
import { PLATFORM_LABEL, type OrderPlatform } from "@/lib/platforms";
import { AppHeader } from "@/components/AppHeader";
import { PressableScale } from "@/components/ui/PressableScale";
import { getAllOrders, isCancelledOrder, ORDERS_STALE_MS, statusInfo, visibleOrders, type StatusTone, type UnifiedOrder } from "@/lib/api/orders";
import { thumbUrl } from "@/lib/image";
import { getPrepDone } from "@/lib/db/prep";
import { prepItemsFromOrders } from "@/lib/prep";
import { getOrderMatchProducts } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { getProductMap, computeOrderProfit, type OrderProfit } from "@/lib/order-profit";
import { useManualRefresh } from "@/lib/use-refresh";
import { formatCurrency, formatDate } from "@/lib/format";
import { FadeInView, Skeleton } from "@/components/fade-in";
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
  const { data, isLoading, refetch, dataUpdatedAt } = useQuery({
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

  // Kaynak sorgu 60 gün (Raporlar ile paylaşılıyor) → bu ekran son 30 günü gösterir.
  const [arama, setArama] = useState("");
  const [platform, setPlatform] = useState<"hepsi" | OrderPlatform>("hepsi");

  const gorunur = useMemo(() => (data ? visibleOrders(data.orders) : []), [data]);

  /** Platform başına sayı — çiplerde gösterilir, kullanıcı hangi kanalda kaç sipariş var görsün. */
  const platformSayilari = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of gorunur) m.set(o.platform, (m.get(o.platform) ?? 0) + 1);
    return m;
  }, [gorunur]);

  /**
   * ARAMA — sipariş no, müşteri ve ÜRÜN ADI üzerinde.
   * 60 günlük liste düz akıyordu ve aranan sipariş elle kaydırılarak bulunuyordu; sahada
   * "şu müşterinin siparişi hangisiydi" en sık sorulan şey. Türkçe karakter duyarsız
   * (ortak `slugifyTr`) → "Şeyhmus" yazarken "seyhmus" da bulur.
   */
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

  /**
   * Başlıktaki hazırlık rozeti: kaç ÜRÜN satırı hâlâ toplanmayı bekliyor.
   * İşaretler masaüstüyle ortak (`PrepDone`) — orada işaretlenen burada da düşer.
   */
  const { data: prepDone } = useQuery({ queryKey: ["prep-done"], queryFn: getPrepDone });
  const prepKalan = useMemo(() => {
    if (!data) return 0;
    const isaretli = new Set(prepDone ?? []);
    return prepItemsFromOrders(gorunur, products).filter((i) => !isaretli.has(i.key)).length;
  }, [data, gorunur, products, prepDone]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader
        title="Siparişler"
        updatedAt={dataUpdatedAt}
        subtitle={
          counts
            ? counts.cancelled > 0
              ? `${counts.active} sipariş · ${counts.cancelled} iptal · son 30`
              : `${counts.active} sipariş · son 30`
            : "yükleniyor…"
        }
        right={
          <>
            {/* HAZIRLIK — paketleme rafın önünde yapılıyor; liste bir dokunuş uzakta olsun.
                Rozet "kaç ürün kaldı"yı söyler, işaretler masaüstüyle ortaktır. */}
            <PressableScale
              onPress={() => router.push("/hazirlik")}
              style={styles.prepButton}
              accessibilityRole="button"
              accessibilityLabel={
                prepKalan > 0 ? `Hazırlık listesi, ${prepKalan} ürün kaldı` : "Hazırlık listesi"
              }
            >
              <SymbolView name="shippingbox.fill" size={16} tintColor={ML.orange} />
              {prepKalan > 0 ? <Text style={styles.prepCount}>{prepKalan}</Text> : null}
            </PressableScale>
            <PressableScale
              onPress={() => router.push("/manual-order/new")}
              style={({ pressed }) => [styles.addButton, pressed && { opacity: 0.75 }]}
            >
              <Text style={styles.addButtonText}>+ Ekle</Text>
            </PressableScale>
          </>
        }
      />

      {/* ARAMA + PLATFORM ÇİPLERİ — 60 günlük listede aranan siparişi elle kaydırmak zorunda
          kalmamak için. Çipler hangi kanalda kaç sipariş olduğunu da gösterir. */}
      <View style={styles.filterBar}>
        <TextInput
          value={arama}
          onChangeText={setArama}
          placeholder="Sipariş no, müşteri veya ürün ara"
          placeholderTextColor={ML.textFaint}
          style={styles.search}
          clearButtonMode="while-editing"
          autoCorrect={false}
          returnKeyType="search"
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
                selected={platform === p}
                onPress={() => setPlatform(p)}
                count={platformSayilari.get(p)}
              />
            ) : null
          )}
        </ScrollView>
      </View>

      {isLoading ? (
        <OrderListSkeleton />
      ) : (
        <FlashList
          data={shown}
          keyExtractor={(o) => o.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ML.accent} />
          }
          ListHeaderComponent={
            data?.errors.length ? (
              <View style={styles.errBox}>
                <Text style={styles.errText}>
                  {failedChannels(data.errors)} siparişleri şu an alınamadı.
                </Text>
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
            <Text style={[styles.dim, { textAlign: "center", marginTop: 40 }]}>
              {arama.trim() || platform !== "hepsi"
                ? "Aramanla eşleşen sipariş yok"
                : "Sipariş yok"}
            </Text>
          }
          ItemSeparatorComponent={RowGap}
        />
      )}
    </SafeAreaView>
  );
}

/**
 * Hangi satış kanalının gelmediğini yazar; teknik hata metni ekrana ASLA basılmaz.
 * Kaynak dizideki her kayıt "Kanal: ham hata" biçiminde geliyor — yalnız kanal adı alınır.
 */
function failedChannels(errors: string[]): string {
  const names = errors
    .map((e) => e.split(":")[0]?.trim())
    .filter((n): n is string => Boolean(n));
  const unique = [...new Set(names)];
  if (unique.length === 0) return "Bazı satış kanalları";
  if (unique.length === 1) return unique[0];
  return `${unique.slice(0, -1).join(", ")} ve ${unique[unique.length - 1]}`;
}

/** Siparişler yüklenirken kartların yerini tutan iskelet. */
function OrderListSkeleton() {
  return (
    <View style={styles.skeletonList}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <View key={i} style={styles.skeletonRow}>
          <Skeleton width={52} height={52} radius={14} delay={i * 70} />
          <View style={styles.skeletonBody}>
            <Skeleton width="55%" height={14} delay={i * 70 + 40} />
            <Skeleton width="75%" height={11} delay={i * 70 + 90} />
          </View>
          <View style={styles.skeletonRight}>
            <Skeleton width={70} height={14} delay={i * 70 + 120} />
            <Skeleton width={54} height={12} delay={i * 70 + 160} />
          </View>
        </View>
      ))}
    </View>
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
    <PressableScale
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
          {order.isManual ? (
            <View style={styles.manualBadge}>
              <Text style={styles.manualBadgeText}>Manuel</Text>
            </View>
          ) : null}
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
            {profit.desiEstimated ? " ◆" : ""}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  filterBar: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  search: {
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: ML.card,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    color: ML.text,
    fontSize: 15,
  },
  chips: { gap: 8, paddingRight: 16 },
  safe: { flex: 1, backgroundColor: ML.bg },
  prepButton: {
    minWidth: 44,
    height: 40,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    backgroundColor: ML.card,
  },
  prepCount: { color: ML.orange, fontSize: 14, fontWeight: "800", fontVariant: ["tabular-nums"] },
  addButton: {
    backgroundColor: ML.accentSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.accent + "66",
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  addButtonText: { color: ML.accent, fontSize: 14, fontWeight: "800" },
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
  skeletonList: { padding: 16, gap: 10 },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 12,
  },
  skeletonBody: { flex: 1, gap: 8 },
  skeletonRight: { alignItems: "flex-end", gap: 8 },
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
  manualBadge: {
    backgroundColor: ML.manual + "22",
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  manualBadgeText: { color: ML.manual, fontSize: 10, fontWeight: "800" },
  meta: { color: ML.textDim, fontSize: 12 },
  item: { color: ML.textFaint, fontSize: 12 },
  right: { alignItems: "flex-end", gap: 4 },
  total: { color: ML.text, fontSize: 15, fontWeight: "800" },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  statusText: { fontSize: 11, fontWeight: "700" },
  profit: { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
