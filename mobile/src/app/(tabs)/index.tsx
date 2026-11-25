import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  Bars,
  Bolum,
  Count,
  CubukSatiri,
  ErrorState,
  FadeInView,
  Header,
  Money,
  NotSatiri,
  Pill,
  Screen,
  Segmented,
  Shimmer,
  ShimmerCard,
  StatKutu,
  Txt,
} from "@/components/kit";
import { getAllOrders, isCancelledOrder, isExcludedFromTotals, ORDERS_STALE_MS } from "@/lib/api/orders";
import { computeDashboard, type PlatformSummary } from "@/lib/dashboard";
import { getDashboardData, getOrderMatchProducts } from "@/lib/db/dashboard";
import { getExpenseTotalSince } from "@/lib/db/finance";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { formatCompactCurrency, formatNumber, formatPercent } from "@/lib/format";
import { computeOrderProfit, getProductMap } from "@/lib/order-profit";
import { donemKesimi, panelCirosu } from "@/lib/panel-ciro";
import { ayBasi } from "@core/siparis-listesi";
import {
  ORDER_PLATFORM_COLOR,
  ORDER_PLATFORM_LABEL,
  ORDER_PLATFORMS,
  PLATFORM_COLOR,
  PLATFORM_LABEL,
} from "@/lib/platforms";
import { useManualRefresh } from "@/lib/use-refresh";
import { color, space } from "@/theme/tokens";

type PanelDonemi = 7 | "ay" | 60;
// "Bu ay" varsayılan: masaüstü Panel, Siparişler ve Raporlar bu ayı gösterir (Berke kararı).
const DONEMLER: { value: PanelDonemi; label: string }[] = [
  { value: 7, label: "7g" },
  { value: "ay", label: "Bu ay" },
  { value: 60, label: "60g" },
];

/**
 * PANEL — günün ilk bakışı: ciro, kâr, günlük satış dalgası, stok/zarar sayıları, platform marjı.
 *
 * Veri katmanı öncekiyle AYNI (batch sorgular, 60 günlük sipariş penceresi, masaüstüyle birebir
 * kâr hesabı); yalnız sunum yeniden yazıldı. Dönem süzgeci ek ağ isteği açmaz: 60 günlük veri
 * elde, 7 gün / bu ay / 60 gün yalnız yerel kesim.
 */
export default function DashboardScreen() {
  const { data: products, isLoading, isError, error, refetch: refetchProducts } = useQuery({
    queryKey: ["dashboard-data"],
    queryFn: getDashboardData,
  });
  const [donem, setDonem] = useState<PanelDonemi>("ay");
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
    /**
     * "Şimdi" olarak sorgunun ÇEKİLDİĞİ an kullanılır (`dataUpdatedAt`): render sırasında
     * `Date.now()` çağırmak React Compiler hatası veriyor ve mobil lint adımını düşürüyor.
     * Kesim ve kovalar `panelCirosu` içinde — masaüstü özetiyle aynı UTC gün başı.
     */
    return panelCirosu(ordersData.orders, {
      gun: donem === "ay" ? 0 : donem,
      simdi: ordersAt || 0,
      kesimMs: donem === "ay" && ordersAt ? ayBasi(ordersAt) : undefined,
      platformlar: ORDER_PLATFORMS,
      // Masaüstü özetiyle birebir: iptal/iade, tutarı alınamayan ve tanınmayan pazaryeri
      // durumu ciroya girmez (Raporlar da aynı fonksiyonu kullanır).
      sayilmazMi: isExcludedFromTotals,
      hesapla: (o) => computeOrderProfit(o, pm, rules, settings),
      iadeMi: isCancelledOrder,
    });
  }, [ordersData, matchProducts, rules, settings, donem, ordersAt]);

  /**
   * NET KÂR = sipariş kârı − AYNI dönemde ödenen giderler (masaüstü Panel'iyle aynı). Kesim ciro
   * penceresiyle birebir; Gider ekranı `["actual-expenses"]` önekini düşürünce bu da tazelenir.
   */
  const kesim = ordersAt ? (donem === "ay" ? ayBasi(ordersAt) : donemKesimi(ordersAt, donem)) : null;
  const { data: giderKurus } = useQuery({
    queryKey: ["actual-expenses", "toplam", kesim, ordersAt],
    queryFn: () => getExpenseTotalSince(kesim ?? 0, ordersAt || undefined),
    enabled: kesim != null,
  });
  const gider = giderKurus == null ? null : giderKurus / 100;
  const net = rev && gider != null ? rev.profit - gider : null;
  const gosterilenKar = net ?? rev?.profit ?? 0;

  return (
    <Screen
      header={<Header title="Panel" icon="square.grid.2x2.fill" updatedAt={ordersAt} />}
      refreshing={refreshing}
      onRefresh={onRefresh}
    >
      {isError ? (
        <ErrorState error={error} onRetry={() => void refetchProducts()} />
      ) : isLoading || !summary ? (
        <PanelIskeleti />
      ) : (
        <>
          {/* CİRO — dönem seçici, büyük tutar, net kâr, günlük dalga, platform payları */}
          <FadeInView index={0}>
            <Bolum
              title={donem === "ay" ? "Ciro · Bu ay" : `Ciro · Son ${donem} gün`}
              desc={rev ? `${formatNumber(rev.count)} sipariş` : undefined}
              icon="chart.line.uptrend.xyaxis"
              right={<Segmented options={DONEMLER} value={donem} onChange={setDonem} style={styles.segment} />}
            >
              {rev ? <Money value={rev.total} v="hero" /> : <Shimmer width={210} height={40} radius={10} />}

              <View style={styles.profitRow}>
                <Txt v="small" tone="dim">
                  {net != null ? "Net kâr" : "Sipariş kârı"}
                </Txt>
                {rev ? (
                  <>
                    <Money value={gosterilenKar} v="bodyStrong" tone={gosterilenKar < 0 ? "bad" : "good"} compact />
                    {rev.total > 0 ? (
                      <Pill color={gosterilenKar < 0 ? color.bad : color.good}>{formatPercent(gosterilenKar / rev.total)}</Pill>
                    ) : null}
                    {gider != null && gider > 0 ? (
                      <Txt v="small" tone="faint" num>
                        · {formatCompactCurrency(gider)} gider düşüldü
                      </Txt>
                    ) : null}
                  </>
                ) : (
                  <Shimmer width={120} height={16} />
                )}
              </View>

              <Bars
                values={rev?.gunluk ?? []}
                height={64}
                emphasis={(i) => i >= (rev?.gunluk.length ?? 0) - 7}
                style={styles.bars}
              />
              <View style={styles.rowBetween}>
                <Txt v="label" tone="faint">
                  {donem === "ay" ? "AYIN 1'İ" : `${donem} GÜN ÖNCE`}
                </Txt>
                <Txt v="label" tone="faint">
                  SON 7 GÜN
                </Txt>
              </View>

              <View style={styles.platformlar}>
                {ORDER_PLATFORMS.map((plat) => {
                  const b = rev?.byPlat[plat];
                  const enCok = rev ? Math.max(1, ...ORDER_PLATFORMS.map((p) => rev.byPlat[p].rev)) : 1;
                  return (
                    <CubukSatiri
                      key={plat}
                      renk={ORDER_PLATFORM_COLOR[plat]}
                      label={ORDER_PLATFORM_LABEL[plat]}
                      meta={b ? `${formatNumber(b.n)} sip.` : undefined}
                      sag={b ? formatCompactCurrency(b.rev) : "—"}
                      oran={b ? b.rev / enCok : 0}
                    />
                  );
                })}
              </View>
            </Bolum>
          </FadeInView>

          {/* STOK / ZARAR SAYILARI */}
          <FadeInView index={1}>
            <View style={styles.tiles}>
              <StatKutu
                icon="shippingbox.fill"
                label="Ürünler"
                onPress={() => router.push({ pathname: "/products", params: { filter: "all" } })}
                accessibilityLabel={`Ürünler: ${formatNumber(summary.totalProducts)}`}
              >
                <Count value={summary.totalProducts} v="stat" />
              </StatKutu>
              <StatKutu
                icon="xmark.bin.fill"
                label="Stoksuz"
                onPress={() => router.push({ pathname: "/products", params: { filter: "out-of-stock" } })}
                accessibilityLabel={`Stoksuz: ${formatNumber(summary.outOfStock)}`}
              >
                <Count value={summary.outOfStock} v="stat" style={summary.outOfStock > 0 ? { color: color.caution } : null} />
              </StatKutu>
              <StatKutu
                icon="chart.line.downtrend.xyaxis"
                label="Zarar eden"
                onPress={() => router.push({ pathname: "/products", params: { filter: "loss" } })}
                accessibilityLabel={`Zarar eden: ${formatNumber(summary.lossListings)}`}
              >
                <Count value={summary.lossListings} v="stat" tone={summary.lossListings > 0 ? "bad" : "default"} />
              </StatKutu>
            </View>
          </FadeInView>

          {/* PLATFORM MARJI */}
          <FadeInView index={2}>
            <Bolum title="Platform marjı" desc="Aktif ilanların ortalaması" icon="storefront.fill">
              <View style={styles.platformlar}>
                {summary.platforms.map((p) => (
                  <PlatformMarji key={p.platform} p={p} />
                ))}
              </View>
            </Bolum>
          </FadeInView>

          {summary.missingCost > 0 ? (
            <FadeInView index={3}>
              <NotSatiri
                icon="wrench.and.screwdriver.fill"
                onPress={() => router.push({ pathname: "/products", params: { filter: "no-cost" } })}
                sag={<SymbolView name="chevron.right" tintColor={color.textFaint} style={{ width: 14, height: 14 }} />}
              >
                <Txt v="small">
                  <Txt v="smallStrong" num>
                    {formatNumber(summary.missingCost)}
                  </Txt>{" "}
                  üründe maliyet girilmemiş
                </Txt>
              </NotSatiri>
            </FadeInView>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function PlatformMarji({ p }: { p: PlatformSummary }) {
  const marka = PLATFORM_COLOR[p.platform];
  const marj = Number.isFinite(p.avgMargin) ? p.avgMargin : 0;
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/products", params: { filter: p.lossCount > 0 ? "loss" : "all" } })}
      accessibilityRole="button"
      accessibilityLabel={`${PLATFORM_LABEL[p.platform]} ortalama marj ${formatPercent(marj)}`}
    >
      <CubukSatiri
        renk={marj < 0 ? color.bad : marka}
        label={PLATFORM_LABEL[p.platform]}
        rozet={p.lossCount > 0 ? <Pill color={color.bad}>{`${formatNumber(p.lossCount)} zarar eden`}</Pill> : null}
        sag={formatPercent(marj, 0)}
        oran={Math.max(0, marj) / 0.6}
        alt={`${formatNumber(p.listingCount)} ilan`}
      />
    </Pressable>
  );
}

/** Panel yüklenirken kartların yerini tutan iskelet — boş ekran ya da tek çark yerine. */
function PanelIskeleti() {
  return (
    <>
      <ShimmerCard height={380} />
      <View style={styles.tiles}>
        <ShimmerCard height={104} delay={60} style={{ flex: 1 }} />
        <ShimmerCard height={104} delay={120} style={{ flex: 1 }} />
        <ShimmerCard height={104} delay={180} style={{ flex: 1 }} />
      </View>
      <ShimmerCard height={220} delay={240} />
    </>
  );
}

const styles = StyleSheet.create({
  segment: { width: 150 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  profitRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap", marginTop: space.sm },
  bars: { marginTop: space.lg },
  platformlar: { gap: space.md, marginTop: space.lg },
  tiles: { flexDirection: "row", gap: space.sm },
});
