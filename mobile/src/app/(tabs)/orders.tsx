import { useQuery } from "@tanstack/react-query";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
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
  ErrorState,
  Bolum,
  FadeInView,
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
import { getOrderMatchProducts } from "@/lib/db/dashboard";
import { kayitliSiparisKarlari } from "@/lib/db/finance";
import { basilanEtiketler } from "@/lib/db/etiket";
import { basilabilirEtiketAnahtari } from "@/lib/etiket";
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
  { value: "ay", label: "Bu ay" },
];
const DURUM_SIRASI: DurumGrubu[] = ["acik", "kargoda", "teslim", "iptal", "diger"];
const DURUM_RENGI: Record<DurumGrubu, string> = {
  acik: color.accentBright,
  kargoda: "#818CF8",
  teslim: color.good,
  iptal: color.bad,
  diger: color.textFaint,
};
const PLATFORM_SIRASI = ["shopify", "trendyol", "hepsiburada", "n11", "manual"] as const;
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
  const { data, isLoading, refetch, dataUpdatedAt, error, isFetching } = useQuery({
    queryKey: ["orders"],
    queryFn: getAllOrders,
    staleTime: ORDERS_STALE_MS,
  });
  const { refreshing, onRefresh } = useManualRefresh(refetch);
  // Eşleştirme haritası: görünürlük filtresiz set (masaüstü orders route ile birebir).
  const { data: products } = useQuery({ queryKey: ["match-products"], queryFn: getOrderMatchProducts });
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  // Basılan kargo etiketleri (masaüstü ve telefon) — satırdaki yazıcı işareti.
  const { data: basilanlar } = useQuery({ queryKey: ["etiket-basilanlar"], queryFn: basilanEtiketler, staleTime: 30_000 });

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

  // Dönemin başı — "Bu ay" = Türkiye takviminde ayın 1'i (masaüstü Panel/Siparişler/Raporlar ile aynı).
  const kesim = useMemo(() => donemBaslangici(donem, simdi), [donem, simdi]);
  // KAYITLI kâr (Panel/Raporlar'ın kullandığı) — özet bunu kullanır, masaüstüyle aynı.
  const { data: kayitli } = useQuery({
    queryKey: ["kayitli-siparis-kari", kesim],
    queryFn: () => kayitliSiparisKarlari(kesim),
    staleTime: ORDERS_STALE_MS,
  });
  // Liste: "Bu ay" = pencerenin tamamı (geçen ayın kargolanmamışı ve işi bitmemiş elle sipariş
  // DAHİL — masaüstü listesi gibi); ÖZET yalnız bu ayın siparişlerini sayar (aşağıda kesimle).
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

  // ÖZET listeden değil ÇEKİLEN TÜM siparişlerden sayılır (masaüstüyle aynı): 31 çeken ayın son
  // gününde ayın 1'i 30 günlük liste penceresinin birkaç saat dışına düşebiliyor.
  const ozetSiparisleri = useMemo(
    () =>
      (data?.orders ?? []).filter(
        (o) => (platform === "hepsi" || o.platform === platform) && (o.date == null || o.date >= kesim)
      ),
    [data, platform, kesim],
  );

  // Kâr: özet (dönem + platform) ve liste için aynı harita.
  const profitOf = useMemo(() => {
    const map = new Map<string, OrderProfit>();
    if (!products || !rules || !settings) return map;
    const pm = getProductMap(products);
    for (const o of platformdaki) map.set(o.id, computeOrderProfit(o, pm, rules, settings));
    for (const o of ozetSiparisleri) if (!map.has(o.id)) map.set(o.id, computeOrderProfit(o, pm, rules, settings));
    return map;
  }, [platformdaki, ozetSiparisleri, products, rules, settings]);
  const karHazir = !!products && !!rules && !!settings;

  const ozet = useMemo(
    () =>
      siparisOzeti(
        ozetSiparisleri.map((o) => {
          const p = profitOf.get(o.id);
          const tryDisi = !!o.currency && o.currency.trim().toUpperCase() !== "TRY";
          const iptal = isCancelledOrder(o);
          const kayit = o.platform === "manual" ? undefined : kayitli?.get(`${o.platform}\u0000${o.id}`);
          // İade bilgisi okunamayan turda geçmişte iptal/iade kayıtlı Trendyol siparişi satış sayılmaz.
          const iadeSuphesi = o.platform === "trendyol" && o.iadeBilinmiyor === true && kayit?.status === "cancelled" && !iptal;
          // Kayıtlı kâr varsa O (Panel/Raporlar ile aynı); yoksa canlı hesap.
          const kayitliKar = !iptal && kayit && kayit.profit != null;
          return {
            platform: o.platform,
            date: o.date,
            ciro: o.total,
            kar: kayitliKar ? kayit.profit : (p?.profit ?? null),
            karKismi: kayitliKar ? kayit.partial : p?.partial === true,
            haric: isExcludedFromTotals(o) || tryDisi || iadeSuphesi,
            // Kargolanıp geri gelen siparişin zararı kârdan düşer (masaüstü özetiyle aynı).
            iadeZarari: iptal && !tryDisi && !iadeSuphesi ? (p?.returnLoss ?? null) : null,
          };
        }),
        kesim,
        // "Bu ay": tarihi bilinmeyen sipariş de sayılır (masaüstü yalnız tarihi önceki ayı eler).
        { tarihsizDahil: donem === "ay" },
      ),
    [ozetSiparisleri, profitOf, kesim, kayitli, donem],
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
          icon="list.clipboard.fill"
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
      ) : error && !data ? (
        // Veri HİÇ gelmediyse "Sipariş yok" yazılmaz — alınamamış veri sıfır gibi okunuyordu.
        <View style={styles.list}>
          <ErrorState error={error} onRetry={() => void refetch()} retrying={isFetching} />
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
              {error && data ? (
                <Tint strong style={styles.errBox}>
                  <Txt v="small" tone="warn">
                    Liste güncellenemedi — son alınan gösteriliyor.
                  </Txt>
                </Tint>
              ) : null}
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
            const etiketAnahtari = basilabilirEtiketAnahtari(item.siparis);
            const card = (
              <OrderRow
                order={item.siparis}
                profit={profitOf.get(item.siparis.id)}
                etiketBasildi={etiketAnahtari != null && basilanlar?.[etiketAnahtari] != null}
              />
            );
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
  const baslik = DONEM_SECENEKLERI.find((d) => d.value === donem)?.label ?? "Bu ay";
  return (
    <Bolum
      title={baslik}
      desc={karHazir && marjYuzde != null ? `Marj %${marjYuzde.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}` : undefined}
      icon="chart.line.uptrend.xyaxis"
      style={{ gap: 0 }}
    >
      <Segmented<Donem> options={DONEM_SECENEKLERI} value={donem} onChange={onDonem} />

      <View style={styles.ozetSatir}>
        <View style={styles.ozetHucre}>
          <Txt v="small" tone="faint">
            Sipariş
          </Txt>
          <Count value={ozet.adet} v="heading" />
        </View>
        <View style={styles.ozetHucre}>
          <Txt v="small" tone="faint">
            Ciro
          </Txt>
          <Money value={ozet.ciro} v="heading" compact />
        </View>
        <View style={styles.ozetHucre}>
          <Txt v="small" tone="faint">
            Kâr
          </Txt>
          {karHazir ? (
            <Money value={ozet.kar} v="heading" compact tone={ozet.kar < 0 ? "bad" : "good"} />
          ) : (
            <Txt v="heading" tone="dim">
              —
            </Txt>
          )}
        </View>
      </View>

      {karHazir && ozet.maliyetEksik > 0 ? (
        <Txt v="small" style={{ color: color.caution, marginTop: space.md }}>
          {ozet.maliyetEksik} siparişte maliyet eksik — kâr yaklaşık.
        </Txt>
      ) : null}
      {karHazir && ozet.iadeAdet > 0 ? (
        <Txt v="small" tone="dim" style={{ marginTop: space.sm }}>
          {ozet.iadeAdet} iadenin kargo zararı ({formatCurrency(ozet.iadeZarari)}) kârdan düşüldü.
        </Txt>
      ) : null}

      {/* Platform dağılımı — yalnız birden çok platform görünürken anlamlı. */}
      {!platformSecili && ozet.platformlar.length > 1 && ozet.ciro > 0 ? (
        <View style={{ gap: space.sm, marginTop: space.md }}>
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
    </Bolum>
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
      <View>
        <View style={[styles.photo, styles.countBox]}>
          <Txt v="heading" num>
            {profit.distinctCount}
          </Txt>
          <Txt v="label" tone="faint" style={{ fontSize: 10, lineHeight: 12 }}>
            çeşit
          </Txt>
        </View>
        <View style={[styles.platRozet, { backgroundColor: accent }]} />
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
          <SymbolView name="cube.box" tintColor={color.textFaint} style={{ width: 20, height: 20 }} />
        </View>
      )}
      <View style={[styles.platRozet, { backgroundColor: accent }]} />
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

function OrderRow({
  order,
  profit,
  etiketBasildi,
}: {
  order: UnifiedOrder;
  profit?: OrderProfit;
  etiketBasildi?: boolean;
}) {
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
          <Txt v="bodyStrong" num numberOfLines={1} style={{ flexShrink: 1 }}>
            {order.orderNumber}
          </Txt>
          <Pill color={STATUS_TONE[st.tone]}>{st.label}</Pill>
          {order.isManual ? <Pill color={color.manual}>Manuel</Pill> : null}
          {order.microExport ? <Pill color={color.info}>Mikro ihracat</Pill> : null}
          {etiketBasildi ? (
            <SymbolView
              name="printer.fill"
              tintColor={color.good}
              style={{ width: 13, height: 13 }}
              accessibilityLabel="Kargo etiketi basıldı"
            />
          ) : null}
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
  ozetSatir: { flexDirection: "row", alignItems: "flex-end", gap: space.md, marginTop: space.lg },
  ozetHucre: { flex: 1, gap: 2, minWidth: 0 },
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
  platRozet: {
    position: "absolute",
    right: -3,
    bottom: -3,
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: color.card,
  },
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
  right: { alignItems: "flex-end", gap: 4 },
});
