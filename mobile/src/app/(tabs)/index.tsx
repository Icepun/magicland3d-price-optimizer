import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import {
  Bars,
  CornerArrow,
  Count,
  ErrorState,
  FadeInView,
  Glass,
  Header,
  Money,
  Ring,
  Screen,
  Segmented,
  Shimmer,
  ShimmerCard,
  Tint,
  Txt,
  type TxtTone,
} from "@/components/kit";
import { getAllOrders, isCancelledOrder, ORDERS_STALE_MS } from "@/lib/api/orders";
import { computeDashboard, type PlatformSummary } from "@/lib/dashboard";
import { getDashboardData, getOrderMatchProducts } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { formatCompactCurrency, formatNumber, formatPercent } from "@/lib/format";
import { computeOrderProfit, getProductMap } from "@/lib/order-profit";
import {
  ORDER_PLATFORM_COLOR,
  ORDER_PLATFORM_SHORT_LABEL,
  ORDER_PLATFORMS,
  PLATFORM_COLOR,
  PLATFORM_LABEL,
  type OrderPlatform,
} from "@/lib/platforms";
import { useManualRefresh } from "@/lib/use-refresh";
import { color, radius, space } from "@/theme/tokens";

const GUN = 86_400_000;
const DONEMLER = [
  { value: 7 as const, label: "7g" },
  { value: 30 as const, label: "30g" },
  { value: 60 as const, label: "60g" },
];

/**
 * PANEL — günün ilk bakışı: ciro, kâr, günlük satış dalgası, stok/zarar sayıları, platform marjı.
 *
 * Veri katmanı öncekiyle AYNI (batch sorgular, 60 günlük sipariş penceresi, masaüstüyle birebir
 * kâr hesabı); yalnız sunum yeniden yazıldı. Dönem süzgeci ek ağ isteği açmaz: 60 günlük veri
 * elde, 7/30/60 yalnız yerel kesim.
 */
export default function DashboardScreen() {
  const { data: products, isLoading, isError, error, refetch: refetchProducts } = useQuery({
    queryKey: ["dashboard-data"],
    queryFn: getDashboardData,
  });
  const [donem, setDonem] = useState<7 | 30 | 60>(30);
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
    const byPlat: Record<string, { rev: number; n: number }> = Object.fromEntries(
      ORDER_PLATFORMS.map((p) => [p, { rev: 0, n: 0 }])
    );
    /** Günlük ciro kovaları: soldan sağa eskiden bugüne (grafik). */
    const gunluk = new Array<number>(donem).fill(0);
    let total = 0;
    let profit = 0;
    let count = 0;
    /**
     * "Şimdi" olarak sorgunun ÇEKİLDİĞİ an kullanılır (`dataUpdatedAt`): render sırasında
     * `Date.now()` çağırmak React Compiler hatası veriyor ve mobil lint adımını düşürüyor.
     */
    const simdi = ordersAt || 0;
    const kesim = simdi ? simdi - donem * GUN : 0;
    for (const o of ordersData.orders) {
      if (o.date != null && o.date < kesim) continue;
      // Masaüstü özetiyle birebir: iptal/iade/teslim-edilemedi siparişler ciro/kâr/sayıma girmez.
      if (isCancelledOrder(o)) continue;
      // Döviz çevrimi yapılmadan farklı para birimleri TL toplamına eklenmez (Raporlar da aynı).
      if ((o.currency ?? "TRY").trim().toUpperCase() !== "TRY") continue;
      const op = computeOrderProfit(o, pm, rules, settings);
      total += op.revenue;
      const b = byPlat[o.platform];
      if (b) {
        b.rev += op.revenue;
        b.n++;
      }
      if (op.profit != null) profit += op.profit;
      count++;
      if (o.date != null && simdi) {
        const geri = Math.min(donem - 1, Math.max(0, Math.floor((simdi - o.date) / GUN)));
        gunluk[donem - 1 - geri] += op.revenue;
      }
    }
    return { total, profit, byPlat, count, gunluk };
  }, [ordersData, matchProducts, rules, settings, donem, ordersAt]);

  return (
    <Screen
      header={<Header title="Panel" subtitle="Pazaryerleri + manuel satışlar" updatedAt={ordersAt} />}
      refreshing={refreshing}
      onRefresh={onRefresh}
    >
      {isError ? (
        <ErrorState error={error} onRetry={() => void refetchProducts()} />
      ) : isLoading || !summary ? (
        <PanelIskeleti />
      ) : (
        <>
          {/* CİRO KARTI — dönem seçici, büyük tutar, kâr, günlük dalga, platform çipleri */}
          <FadeInView index={0}>
            <Glass style={styles.hero}>
              <View style={styles.rowBetween}>
                <Txt v="label" tone="accent" style={styles.kicker}>
                  CİRO · SON {donem} GÜN
                </Txt>
                <Segmented options={DONEMLER} value={donem} onChange={setDonem} style={styles.segment} />
              </View>

              {rev ? (
                <Money value={rev.total} v="hero" />
              ) : (
                <Shimmer width={210} height={40} radius={10} />
              )}

              <View style={styles.profitRow}>
                <Txt v="small" tone="dim">
                  Sipariş kârı
                </Txt>
                {rev ? (
                  <>
                    <Money value={rev.profit} v="heading" tone={rev.profit < 0 ? "bad" : "good"} compact />
                    {rev.total > 0 ? (
                      <View style={[styles.deltaPill, { backgroundColor: rev.profit < 0 ? color.badSoft : color.goodSoft }]}>
                        <Txt v="label" tone={rev.profit < 0 ? "bad" : "good"} num>
                          {formatPercent(rev.profit / rev.total)}
                        </Txt>
                      </View>
                    ) : null}
                    <Txt v="small" tone="faint" num>
                      · {formatNumber(rev.count)} sipariş
                    </Txt>
                  </>
                ) : (
                  <Shimmer width={120} height={16} />
                )}
              </View>

              <Bars values={rev?.gunluk ?? []} height={64} emphasis={(i) => i >= donem - 7} style={styles.bars} />
              <View style={styles.rowBetween}>
                <Txt v="label" tone="faint">
                  {donem} GÜN ÖNCE
                </Txt>
                <Txt v="label" tone="faint">
                  SON 7 GÜN
                </Txt>
              </View>

              <View style={styles.chips}>
                {ORDER_PLATFORMS.map((plat) => (
                  <PlatformChip key={plat} platform={plat} rev={rev?.byPlat[plat].rev} n={rev?.byPlat[plat].n} />
                ))}
              </View>
            </Glass>
          </FadeInView>

          {/* STOK / ZARAR SAYILARI */}
          <FadeInView index={1}>
            <View style={styles.tiles}>
              <StatTile
                label="Ürünler"
                value={summary.totalProducts}
                tone="accent"
                onPress={() => router.push({ pathname: "/products", params: { filter: "all" } })}
              />
              <StatTile
                label="Stoksuz"
                value={summary.outOfStock}
                tone={summary.outOfStock > 0 ? "warn" : "default"}
                onPress={() => router.push({ pathname: "/products", params: { filter: "out-of-stock" } })}
              />
              <StatTile
                label="Zarar eden"
                value={summary.lossListings}
                tone={summary.lossListings > 0 ? "bad" : "default"}
                onPress={() => router.push({ pathname: "/products", params: { filter: "loss" } })}
              />
            </View>
          </FadeInView>

          {/* PLATFORM MARJI */}
          <Txt v="label" tone="faint" style={styles.section}>
            PLATFORM MARJI
          </Txt>
          {summary.platforms.map((p, i) => (
            <FadeInView key={p.platform} index={i + 2}>
              <PlatformCard p={p} />
            </FadeInView>
          ))}

          {summary.missingCost > 0 ? (
            <FadeInView index={5}>
              <Tint
                strong
                onPress={() => router.push({ pathname: "/products", params: { filter: "no-cost" } })}
                style={styles.note}
                accessibilityLabel="Maliyeti girilmemiş ürünler"
              >
                <View style={[styles.noteIcon, { backgroundColor: color.warnSoft }]}>
                  <SymbolView name="exclamationmark.triangle.fill" tintColor={color.warn} style={{ width: 18, height: 18 }} />
                </View>
                <Txt v="small" tone="dim" style={{ flex: 1 }}>
                  <Txt v="smallStrong" num>
                    {formatNumber(summary.missingCost)}
                  </Txt>{" "}
                  üründe maliyet girilmemiş — kâr hesabı dışı.
                </Txt>
                <SymbolView name="chevron.right" tintColor={color.textFaint} style={{ width: 14, height: 14 }} />
              </Tint>
            </FadeInView>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function PlatformChip({ platform, rev, n }: { platform: OrderPlatform; rev?: number; n?: number }) {
  return (
    <Tint strong radius={radius.pill} padded={false} style={styles.chip}>
      <View style={[styles.dot, { backgroundColor: ORDER_PLATFORM_COLOR[platform] }]} />
      <Txt v="smallStrong" numberOfLines={1} style={styles.chipLabel}>
        {ORDER_PLATFORM_SHORT_LABEL[platform]}
      </Txt>
      <Txt v="small" tone="dim" num numberOfLines={1}>
        {rev != null ? formatCompactCurrency(rev) : "—"}
      </Txt>
      {n != null && n > 0 ? (
        <Txt v="small" tone="faint" num>
          {formatNumber(n)}
        </Txt>
      ) : null}
    </Tint>
  );
}

function StatTile({
  label,
  value,
  tone,
  onPress,
}: {
  label: string;
  value: number;
  tone: TxtTone;
  onPress?: () => void;
}) {
  return (
    <Tint strong onPress={onPress} style={styles.tile} accessibilityLabel={`${label}: ${formatNumber(value)}`}>
      <View style={styles.tileHead}>
        <Txt v="small" tone="dim" numberOfLines={1} style={{ flex: 1 }}>
          {label}
        </Txt>
        <SymbolView name="arrow.up.right" tintColor={color.textFaint} style={styles.tileArrow} />
      </View>
      <Count value={value} v="stat" tone={tone} />
    </Tint>
  );
}

function PlatformCard({ p }: { p: PlatformSummary }) {
  const marka = PLATFORM_COLOR[p.platform];
  const marj = Number.isFinite(p.avgMargin) ? p.avgMargin : 0;
  const halka = marj < 0 ? color.bad : marj < 0.2 ? color.warn : marka;
  const zarar = p.lossCount > 0;
  return (
    <Tint strong padded={false} style={styles.platform}>
      <Ring value={marj} size={64} stroke={7} color={halka}>
        <Txt v="label" num>
          {formatPercent(marj, 0)}
        </Txt>
      </Ring>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.rowGap}>
          <View style={[styles.dot, { backgroundColor: marka }]} />
          <Txt v="heading" numberOfLines={1}>
            {PLATFORM_LABEL[p.platform]}
          </Txt>
        </View>
        <Txt v="small" tone="dim" num>
          Ortalama marj {formatPercent(marj)} · {formatNumber(p.listingCount)} listing
        </Txt>
        <View style={styles.rowGap}>
          <View style={[styles.deltaPill, { backgroundColor: zarar ? color.badSoft : color.tintStrong }]}>
            <Txt v="label" tone={zarar ? "bad" : "faint"} num>
              {formatNumber(p.lossCount)} zarar eden
            </Txt>
          </View>
        </View>
      </View>
      <CornerArrow
        onPress={() => router.push({ pathname: "/products", params: { filter: zarar ? "loss" : "all" } })}
      />
    </Tint>
  );
}

/** Panel yüklenirken kartların yerini tutan iskelet — boş ekran ya da tek çark yerine. */
function PanelIskeleti() {
  return (
    <>
      <ShimmerCard height={292} />
      <View style={styles.tiles}>
        <ShimmerCard height={92} delay={60} style={{ flex: 1 }} />
        <ShimmerCard height={92} delay={120} style={{ flex: 1 }} />
        <ShimmerCard height={92} delay={180} style={{ flex: 1 }} />
      </View>
      <ShimmerCard height={96} delay={240} />
      <ShimmerCard height={96} delay={300} />
      <ShimmerCard height={96} delay={360} />
    </>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.md },
  kicker: { letterSpacing: 1.2 },
  segment: { width: 172 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  rowGap: { flexDirection: "row", alignItems: "center", gap: space.sm },
  profitRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  deltaPill: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill },
  bars: { marginTop: space.xs },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: {
    flexGrow: 1,
    flexBasis: "46%",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.md,
    minHeight: 36,
  },
  chipLabel: { flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tiles: { flexDirection: "row", gap: space.sm },
  tile: { flex: 1, gap: 6, minHeight: 92, padding: space.md },
  tileHead: { flexDirection: "row", alignItems: "center", gap: 4 },
  tileArrow: { width: 13, height: 13 },
  section: { letterSpacing: 1.2, marginTop: space.sm, marginLeft: space.xs },
  platform: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    paddingRight: space.md,
  },
  note: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  noteIcon: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
});
