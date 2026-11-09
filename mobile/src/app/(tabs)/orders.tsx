import { useQuery } from "@tanstack/react-query";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { slugifyTr } from "@core/filament-groups";
import {
  DURUM_GRUBU_ADI,
  donemBaslangici,
  durumGrubu,
  durumKovasi,
  gunlereBol,
  siparisOzeti,
  type Donem,
  type DurumGrubu,
  type ListeSatiri,
} from "@core/siparis-listesi";
import { Chip, Pill } from "@/components/kit/Chip";
import {
  Count,
  EmptyState,
  FadeInView,
  Glass,
  Header,
  IconButton,
  Money,
  Screen,
  SearchInput,
  Segmented,
  ShimmerList,
  Tint,
  Txt,
} from "@/components/kit";
import {
  getAllOrders,
  isCancelledOrder,
  isExcludedFromTotals,
  isIncompleteOrder,
  ORDERS_STALE_MS,
  statusInfo,
  visibleOrders,
  type UnifiedOrder,
} from "@/lib/api/orders";
import { orderWindowCutoff } from "@/lib/api/window";
import { getOrderMatchProducts } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { formatCurrency, formatDate } from "@/lib/format";
import { thumbUrl } from "@/lib/image";
import { computeOrderProfit, getProductMap, type OrderProfit } from "@/lib/order-profit";
import { ORDER_PLATFORM_COLOR, PLATFORM_LABEL, type OrderPlatform } from "@/lib/platforms";
import { STATUS_TONE } from "@/lib/status-tone";
import { useManualRefresh } from "@/lib/use-refresh";
import { color, radius, space } from "@/theme/tokens";

const DONEM_SECENEKLERI: { value: Donem; label: string }[] = [
  { value: "bugun", label: "Bugün" },
  { value: "hafta", label: "7 gün" },
  { value: "ay", label: "30 gün" },
];
const DURUM_SIRASI: DurumGrubu[] = ["acik", "kargoda", "teslim", "iptal", "diger"];
const DURUM_RENGI: Record<DurumGrubu, string> = {
  acik: color.warn,
  kargoda: color.accentBright,
  teslim: color.good,
  iptal: color.bad,
  diger: color.textFaint,
};
const PLATFORM_SIRASI = ["shopify", "trendyol", "hepsiburada", "manual"] as const;
const grupOf = (o: UnifiedOrder): DurumGrubu => durumGrubu(durumKovasi(o.platform, o.status));
const platformAdi = (p: string) => (p === "manual" ? "Manuel" : PLATFORM_LABEL[p as Exclude<OrderPlatform, "manual">] ?? p);

/**
 * SİPARİŞLER — masaüstü sipariş sayfasının telefondaki karşılığı.
 *
 * Üstte seçilen dönemin özeti (ciro, kâr, marj, sipariş sayısı, platform dağılımı); altında
 * durum (Açık / Kargoda / Teslim / İptal) ve platform süzgeçleri, arama ve güne göre bölünmüş
 * liste. Dönem hem özeti hem listeyi daraltır. Toplamlar masaüstüyle aynı kuralla hesaplanır
 * (iptal, bilgisi eksik ve durumu tanınmayan siparişler ciroya girmez — @core/siparis-listesi).
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
  const [durum, setDurum] = useState<"hepsi" | DurumGrubu>("hepsi");
  const [donem, setDonem] = useState<Donem>("ay");

  // "Bugün"/"Dün" başlıkları gece yarısı geçince kendiliğinden düzelsin.
  const [simdi, setSimdi] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setSimdi(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const gorunur = useMemo(() => (data ? visibleOrders(data.orders) : []), [data]);

  // Dönemin başı — 30 gün masaüstü özetiyle aynı kesim (UTC gün başı).
  const kesim = useMemo(() => donemBaslangici(donem, simdi, orderWindowCutoff()), [donem, simdi]);
  // Liste: 30 gün = pencerenin tamamı (işi bitmemiş eski elle sipariş DAHİL); kısa dönemler tarihe göre.
  const donemdeki = useMemo(
    () => (donem === "ay" ? gorunur : gorunur.filter((o) => o.date != null && o.date >= kesim)),
    [gorunur, donem, kesim],
  );

  const platformSayilari = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of donemdeki) m.set(o.platform, (m.get(o.platform) ?? 0) + 1);
    return m;
  }, [donemdeki]);

  const platformdaki = useMemo(
    () => (platform === "hepsi" ? donemdeki : donemdeki.filter((o) => o.platform === platform)),
    [donemdeki, platform],
  );

  /** Arama: sipariş no, müşteri, ürün adı — Türkçe karakter duyarsız (ortak slugifyTr). */
  const aranan = useMemo(() => {
    const q = slugifyTr(arama.trim());
    if (!q) return platformdaki;
    return platformdaki.filter((o) => {
      if (slugifyTr(o.orderNumber).includes(q)) return true;
      if (o.customer && slugifyTr(o.customer).includes(q)) return true;
      return o.items.some((it) => slugifyTr(it.name ?? "").includes(q));
    });
  }, [platformdaki, arama]);

  const durumSayilari = useMemo(() => {
    const m = new Map<DurumGrubu, number>();
    for (const o of aranan) {
      const g = grupOf(o);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  }, [aranan]);

  const shown = useMemo(
    () => (durum === "hepsi" ? aranan : aranan.filter((o) => grupOf(o) === durum)),
    [aranan, durum],
  );

  // Kâr: özet (dönem + platform) ve liste için aynı harita.
  const profitOf = useMemo(() => {
    const map = new Map<string, OrderProfit>();
    if (!products || !rules || !settings) return map;
    const pm = getProductMap(products);
    for (const o of platformdaki) map.set(o.id, computeOrderProfit(o, pm, rules, settings));
    return map;
  }, [platformdaki, products, rules, settings]);
  const karHazir = !!products && !!rules && !!settings;

  const ozet = useMemo(
    () =>
      siparisOzeti(
        platformdaki.map((o) => {
          const p = profitOf.get(o.id);
          const tryDisi = !!o.currency && o.currency.trim().toUpperCase() !== "TRY";
          return {
            platform: o.platform,
            date: o.date,
            ciro: o.total,
            kar: p?.profit ?? null,
            karKismi: p?.partial === true,
            haric: isExcludedFromTotals(o) || tryDisi,
          };
        }),
        // Özet dönemin içindekileri sayar: listede duran eski açık elle sipariş ve tarihsiz
        // sipariş ciroya girmez (masaüstü özetiyle aynı).
        kesim,
      ),
    [platformdaki, profitOf, kesim],
  );

  const satirlar = useMemo(() => gunlereBol(shown, simdi), [shown, simdi]);

  const counts = useMemo(() => {
    if (!data) return null;
    const active = gorunur.filter((o) => !isCancelledOrder(o)).length;
    return { active, cancelled: gorunur.length - active };
  }, [data, gorunur]);

  const filtreVar = arama.trim() !== "" || platform !== "hepsi" || durum !== "hepsi";

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
          <Chip label="Tümü" selected={durum === "hepsi"} onPress={() => setDurum("hepsi")} count={aranan.length} />
          {DURUM_SIRASI.map((g) =>
            durumSayilari.get(g) || durum === g ? (
              <Chip
                key={g}
                label={DURUM_GRUBU_ADI[g]}
                dot={DURUM_RENGI[g]}
                selected={durum === g}
                onPress={() => setDurum(durum === g ? "hepsi" : g)}
                count={durumSayilari.get(g) ?? 0}
              />
            ) : null
          )}
        </ScrollView>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          keyboardShouldPersistTaps="handled"
        >
          <Chip label="Tüm platformlar" selected={platform === "hepsi"} onPress={() => setPlatform("hepsi")} />
          {PLATFORM_SIRASI.map((p) =>
            platformSayilari.get(p) ? (
              <Chip
                key={p}
                label={platformAdi(p)}
                dot={ORDER_PLATFORM_COLOR[p]}
                selected={platform === p}
                onPress={() => setPlatform(platform === p ? "hepsi" : p)}
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
        <FlashList<ListeSatiri<UnifiedOrder>>
          data={satirlar}
          keyExtractor={(r) => (r.tur === "gun" ? `g-${r.anahtar}` : r.siparis.id)}
          getItemType={(r) => r.tur}
          contentContainerStyle={styles.list}
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.accentBright} />
          }
          ListHeaderComponent={
            <View style={{ gap: space.sm, marginBottom: space.sm }}>
              <OzetKarti
                donem={donem}
                onDonem={setDonem}
                ozet={ozet}
                karHazir={karHazir}
                platformSecili={platform !== "hepsi"}
              />
              {data?.errors.length ? (
                <Tint strong style={styles.errBox}>
                  <Txt v="small" tone="warn">
                    {failedChannels(data.errors)} siparişleri şu an alınamadı.
                  </Txt>
                </Tint>
              ) : null}
            </View>
          }
          renderItem={({ item, index }) => {
            if (item.tur === "gun") {
              return (
                <View style={styles.gunBaslik}>
                  <Txt v="label" tone="faint">
                    {item.etiket.toLocaleUpperCase("tr-TR")}
                  </Txt>
                  <Txt v="small" tone="faint" num>
                    {item.adet} sipariş
                  </Txt>
                </View>
              );
            }
            const card = <OrderRow order={item.siparis} profit={profitOf.get(item.siparis.id)} />;
            // Giriş animasyonu yalnız ilk ekrandaki öğelerde — derin kaydırmada kasmasın.
            if (index >= 12) return card;
            return <FadeInView index={index}>{card}</FadeInView>;
          }}
          ListEmptyComponent={
            <EmptyState
              icon="bag"
              title={filtreVar || donem !== "ay" ? "Eşleşen sipariş yok" : "Sipariş yok"}
              hint={filtreVar ? "Süzgeçleri gevşetmeyi dene." : donem === "bugun" ? "Bugün henüz sipariş gelmedi." : undefined}
            />
          }
        />
      )}
    </Screen>
  );
}

/** Dönem özeti — ciro, kâr, marj, sipariş sayısı ve platform dağılımı (rakamlar akarak gelir). */
function OzetKarti({
  donem,
  onDonem,
  ozet,
  karHazir,
  platformSecili,
}: {
  donem: Donem;
  onDonem: (d: Donem) => void;
  ozet: ReturnType<typeof siparisOzeti>;
  karHazir: boolean;
  platformSecili: boolean;
}) {
  const marjYuzde = ozet.marj != null ? ozet.marj * 100 : null;
  return (
    <Glass style={{ gap: space.md }}>
      <Segmented<Donem> options={DONEM_SECENEKLERI} value={donem} onChange={onDonem} />

      <View style={styles.ozetSatir}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label" tone="faint">
            CİRO
          </Txt>
          <Money value={ozet.ciro} v="stat" compact />
        </View>
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          <Txt v="label" tone="faint">
            SİPARİŞ
          </Txt>
          <Count value={ozet.adet} v="stat" />
        </View>
      </View>

      <View style={styles.ozetSatir}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label" tone="faint">
            KÂR
          </Txt>
          {karHazir ? (
            <Money value={ozet.kar} v="heading" compact tone={ozet.kar < 0 ? "bad" : "good"} />
          ) : (
            <Txt v="heading" tone="dim">
              —
            </Txt>
          )}
        </View>
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          <Txt v="label" tone="faint">
            MARJ
          </Txt>
          {karHazir && marjYuzde != null ? (
            <Count
              value={marjYuzde}
              v="heading"
              tone={marjYuzde < 0 ? "bad" : "good"}
              format={(n) => `%${n.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`}
            />
          ) : (
            <Txt v="heading" tone="dim">
              —
            </Txt>
          )}
        </View>
      </View>

      {karHazir && ozet.maliyetEksik > 0 ? (
        <Txt v="small" tone="warn">
          {ozet.maliyetEksik} siparişte maliyet eksik — kâr yaklaşık.
        </Txt>
      ) : null}

      {/* Platform dağılımı — yalnız birden çok platform görünürken anlamlı. */}
      {!platformSecili && ozet.platformlar.length > 1 && ozet.ciro > 0 ? (
        <View style={{ gap: space.sm }}>
          <View style={styles.dagilim}>
            {ozet.platformlar.map((p) => (
              <View
                key={p.platform}
                style={{
                  flex: Math.max(0.02, p.ciro / ozet.ciro),
                  backgroundColor: ORDER_PLATFORM_COLOR[p.platform as OrderPlatform] ?? color.textFaint,
                }}
              />
            ))}
          </View>
          <View style={styles.lejant}>
            {ozet.platformlar.map((p) => (
              <View key={p.platform} style={styles.lejantOge}>
                <View
                  style={[styles.lejantNokta, { backgroundColor: ORDER_PLATFORM_COLOR[p.platform as OrderPlatform] ?? color.textFaint }]}
                />
                <Txt v="small" tone="dim" numberOfLines={1}>
                  {platformAdi(p.platform)}
                </Txt>
                <Txt v="smallStrong" num numberOfLines={1}>
                  {formatCurrency(p.ciro)}
                </Txt>
                <Txt v="small" tone="faint" num>
                  · {p.adet}
                </Txt>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </Glass>
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
  // Tutarı alınamayan sipariş ₺0 değil, BİLİNMİYOR: tutar "—", kâr hiç gösterilmez.
  const tutarYok = isIncompleteOrder(order);
  const marj =
    !tutarYok && profit?.profit != null && !profit.partial && order.total > 0 ? (profit.profit / order.total) * 100 : null;
  return (
    <Tint
      strong
      onPress={() => router.push(`/order/${order.id}`)}
      style={[styles.card, { marginBottom: space.sm }]}
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
        <Txt v="bodyStrong" num tone={tutarYok ? "dim" : undefined}>
          {formatCurrency(tutarYok ? null : order.total)}
        </Txt>
        <Pill color={STATUS_TONE[st.tone]}>{st.label}</Pill>
        {!tutarYok && profit && profit.profit != null ? (
          <Txt v="smallStrong" tone={profit.profit < 0 ? "bad" : "good"} num>
            {profit.partial ? "~" : ""}
            {formatCurrency(profit.profit)}
            {marj != null ? ` · %${Math.round(marj)}` : ""}
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
  errBox: { padding: space.md, borderColor: color.warn + "66" },
  ozetSatir: { flexDirection: "row", alignItems: "flex-end", gap: space.md },
  dagilim: { flexDirection: "row", height: 8, borderRadius: radius.pill, overflow: "hidden", gap: 2 },
  lejant: { flexDirection: "row", flexWrap: "wrap", columnGap: space.md, rowGap: space.xs },
  lejantOge: { flexDirection: "row", alignItems: "center", gap: space.xs },
  lejantNokta: { width: 8, height: 8, borderRadius: 4 },
  gunBaslik: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingTop: space.md,
    paddingBottom: space.sm,
    paddingHorizontal: space.xs,
  },
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
