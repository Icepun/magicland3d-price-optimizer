import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import { Pill } from "@/components/kit/Chip";
import {
  Button,
  Count,
  ErrorState,
  FadeInView,
  Glass,
  IconButton,
  Input,
  Money,
  Ring,
  Screen,
  Shimmer,
  ShimmerCard,
  SubHeader,
  Tint,
  Txt,
} from "@/components/kit";
import { getProductDetail, getVariantGroup, type ProductDetail } from "@/lib/db/product-detail";
import { adjustProductStock, getPriceHistory, setProductAlias, type PriceChange } from "@/lib/db/products";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { formatCurrency, formatDate, formatPercent } from "@/lib/format";
import { thumbUrl } from "@/lib/image";
import { PLATFORM_COLOR, PLATFORM_LABEL } from "@/lib/platforms";
import { computePriceLab } from "@/lib/price-lab";
import { computeProductProfit, type PlatformProfit } from "@/lib/profit";
import { color, radius, space } from "@/theme/tokens";

/**
 * ÜRÜN DETAYI — stok ±, maliyet, platform kâr/zarar (dökümüyle), Fiyat Laboratuvarı, kampanya
 * simülatörü, fiyat geçmişi, takma ad. Veri ve iyimser güncellemeler öncekiyle aynı.
 */
export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();

  const {
    data: product,
    error: productError,
    isLoading,
    isError: productFailed,
    isRefetching: productRefetching,
    refetch: refetchProduct,
  } = useQuery({ queryKey: ["product", id], queryFn: () => getProductDetail(id) });
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  const { data: priceHistory } = useQuery({ queryKey: ["price-history", id], queryFn: () => getPriceHistory(id) });
  const { data: variantGroup } = useQuery({
    queryKey: ["variant-group", product?.variantGroupId],
    queryFn: () => getVariantGroup(product!.variantGroupId!),
    enabled: !!product?.variantGroupId,
  });

  // İyimser stok: UI anında değişir, DB yazımı arkada; hata olursa geri al.
  const stockMutation = useMutation({
    mutationFn: (delta: number) => adjustProductStock(id, delta),
    onMutate: async (delta: number) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      await Promise.all([
        qc.cancelQueries({ queryKey: ["product", id] }),
        qc.cancelQueries({ queryKey: ["dashboard-data"] }),
      ]);
      const prevProduct = qc.getQueryData<ProductDetail>(["product", id]);
      const prevDashboard = qc.getQueryData<ProductDetail[]>(["dashboard-data"]);
      const optimisticStock = Math.max(0, (prevProduct?.stock ?? 0) + delta);
      qc.setQueryData<ProductDetail>(["product", id], (o) => (o ? { ...o, stock: optimisticStock } : o));
      qc.setQueryData<ProductDetail[]>(["dashboard-data"], (o) =>
        o ? o.map((p) => (p.id === id ? { ...p, stock: optimisticStock } : p)) : o
      );
      return { prevProduct, prevDashboard };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prevProduct) qc.setQueryData(["product", id], ctx.prevProduct);
      if (ctx?.prevDashboard) qc.setQueryData(["dashboard-data"], ctx.prevDashboard);
    },
    onSuccess: (stock) => {
      qc.setQueryData<ProductDetail>(["product", id], (o) => (o ? { ...o, stock } : o));
      qc.setQueryData<ProductDetail[]>(["dashboard-data"], (o) =>
        o ? o.map((p) => (p.id === id ? { ...p, stock } : p)) : o
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["product", id] });
      qc.invalidateQueries({ queryKey: ["dashboard-data"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  // Takma ad — iyimser düzenleme.
  const [aliasOpen, setAliasOpen] = useState(false);
  const [aliasDraft, setAliasDraft] = useState("");
  const aliasMutation = useMutation({
    mutationFn: (a: string) => setProductAlias(id, a),
    onMutate: async (a: string) => {
      const v = a.trim() || null;
      await qc.cancelQueries({ queryKey: ["product", id] });
      const prev = qc.getQueryData<ProductDetail>(["product", id]);
      qc.setQueryData<ProductDetail>(["product", id], (o) => (o ? { ...o, alias: v } : o));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["product", id], ctx.prev);
    },
  });

  const profit = product && rules && settings ? computeProductProfit(product, rules, settings) : null;
  const priceLab = useMemo(
    () => (product && rules && settings ? computePriceLab(product, rules, settings) : null),
    [product, rules, settings]
  );

  if (isLoading) {
    return (
      <Screen header={<SubHeader title="Ürün" />}>
        <View style={styles.titleRow}>
          <Shimmer width={72} height={72} radius={radius.md} />
          <View style={{ flex: 1, gap: space.sm }}>
            <Shimmer width="80%" height={20} delay={60} />
            <Shimmer width="45%" height={12} delay={110} />
          </View>
        </View>
        <ShimmerCard height={120} delay={180} />
        <ShimmerCard height={110} delay={260} />
        <ShimmerCard height={180} delay={340} />
      </Screen>
    );
  }

  if (productFailed || !product) {
    return (
      <Screen header={<SubHeader title="Ürün" />}>
        <ErrorState
          title="Ürün yüklenemedi"
          error={productError ?? new Error("Ürün bulunamadı.")}
          onRetry={() => void refetchProduct()}
          retrying={productRefetching}
        />
      </Screen>
    );
  }

  const stock = product.stock;
  const kaydetAlias = () => {
    aliasMutation.mutate(aliasDraft);
    setAliasOpen(false);
  };

  return (
    <Screen header={<SubHeader title="Ürün" subtitle={product.categoryName} />}>
      {/* Başlık */}
      <FadeInView index={0}>
        <View style={styles.titleRow}>
          {product.imageUrl ? (
            <Image source={{ uri: thumbUrl(product.imageUrl, 200)! }} alt={product.name} style={styles.thumb} contentFit="cover" />
          ) : (
            <View style={[styles.thumb, styles.thumbEmpty]}>
              <SymbolView name="cube.box" tintColor={color.textFaint} style={{ width: 26, height: 26 }} />
            </View>
          )}
          <View style={{ flex: 1, gap: 3 }}>
            <Txt v="heading" numberOfLines={3}>
              {product.name}
            </Txt>
            <Txt v="small" tone="faint" numberOfLines={1}>
              {product.sku}
            </Txt>
            <Pressable
              onPress={() => {
                setAliasDraft(product.alias ?? "");
                setAliasOpen(true);
              }}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Takma adı düzenle"
            >
              <Txt v="smallStrong" tone="accent" numberOfLines={1}>
                {product.alias ? `✎ "${product.alias}"` : "✎ takma ad ekle"}
              </Txt>
            </Pressable>
          </View>
        </View>
      </FadeInView>

      {/* Varyant grubu */}
      {variantGroup && variantGroup.members.length > 1 ? (
        <FadeInView index={1}>
          <Tint strong padded={false} style={styles.section}>
            <Txt v="label" tone="faint" style={styles.kicker}>
              VARYANT GRUBU · {variantGroup.name.toLocaleUpperCase("tr-TR")}
            </Txt>
            {variantGroup.members.map((m) => {
              const isCurrent = m.id === product.id;
              return (
                <Pressable
                  key={m.id}
                  disabled={isCurrent}
                  onPress={() => router.push(`/product/${m.id}`)}
                  style={({ pressed }) => [styles.variantRow, pressed && !isCurrent ? { opacity: 0.6 } : null]}
                  accessibilityRole="button"
                >
                  {m.imageUrl ? (
                    <Image source={{ uri: thumbUrl(m.imageUrl, 120)! }} alt={m.variantLabel || m.name} style={styles.variantThumb} contentFit="cover" recyclingKey={m.id} />
                  ) : (
                    <View style={[styles.variantThumb, styles.thumbEmpty]} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Txt v="bodyStrong" numberOfLines={1}>
                      {m.variantLabel || m.name}
                    </Txt>
                    <Txt v="small" tone="faint" num>
                      {m.stock} adet · {formatCurrency(m.currentSalePrice)}
                    </Txt>
                  </View>
                  {isCurrent ? (
                    <Pill>bu ürün</Pill>
                  ) : (
                    <SymbolView name="chevron.right" tintColor={color.textFaint} style={{ width: 14, height: 14 }} />
                  )}
                </Pressable>
              );
            })}
          </Tint>
        </FadeInView>
      ) : null}

      {/* Stok */}
      <FadeInView index={2}>
        <Glass>
          <View style={styles.rowBetween}>
            <Txt v="label" tone="faint" style={styles.kicker}>
              STOK
            </Txt>
            {product.madeToOrder ? <Pill color={color.manual}>Siparişle üretilir</Pill> : null}
          </View>
          <View style={styles.stockRow}>
            <IconButton
              icon="minus"
              size={56}
              onPress={() => stockMutation.mutate(-1)}
              accessibilityLabel="Stoğu bir azalt"
              style={stock <= 0 ? { opacity: 0.4 } : null}
            />
            <View style={{ alignItems: "center" }}>
              <Count value={stock} v="hero" tone={stock <= 0 && !product.madeToOrder ? "bad" : "default"} />
              <Txt v="small" tone="faint">
                adet
              </Txt>
            </View>
            <IconButton icon="plus" size={56} accent onPress={() => stockMutation.mutate(1)} accessibilityLabel="Stoğu bir artır" />
          </View>
        </Glass>
      </FadeInView>

      {/* Maliyet */}
      <FadeInView index={3}>
        {profit?.hasCost ? (
          <Tint strong style={styles.section}>
            <View style={styles.rowBetween}>
              <Txt v="label" tone="faint" style={styles.kicker}>
                MALİYET
              </Txt>
              <Button label="Düzenle" icon="pencil" size="sm" variant="secondary" onPress={() => router.push(`/edit-cost/${product.id}`)} />
            </View>
            <Satir label="Üretim" value={formatCurrency(profit.productionCost)} />
            <Satir label="Paketleme" value={formatCurrency(profit.packagingCost)} />
            <View style={styles.divider} />
            <Satir label="Toplam maliyet" value={formatCurrency(profit.totalCost)} bold />
          </Tint>
        ) : (
          <Button label="Maliyet ekle" icon="plus" onPress={() => router.push(`/edit-cost/${product.id}`)} />
        )}
      </FadeInView>

      {/* Platform kâr / zarar */}
      <Txt v="label" tone="faint" style={styles.sectionTitle}>
        PLATFORM KÂR / ZARAR
      </Txt>
      {profit?.hasCost && profit.platforms.length > 0 ? (
        profit.platforms.map((p, i) => (
          <FadeInView key={p.listingId} index={i + 4}>
            <PlatformCard p={p} />
          </FadeInView>
        ))
      ) : (
        <Tint style={styles.section}>
          <Txt v="body" tone="dim">
            {profit?.hasCost ? "Bu ürünün platform listing'i yok." : "Maliyet girilmemiş — kâr hesaplanamıyor."}
          </Txt>
        </Tint>
      )}

      {/* Fiyat laboratuvarı */}
      {priceLab?.hasCost ? (
        <>
          <Txt v="label" tone="faint" style={styles.sectionTitle}>
            FİYAT LABORATUVARI
          </Txt>
          {priceLab.targets.map((t) => {
            const marka = PLATFORM_COLOR[t.platform];
            return (
              <Tint key={t.platform} strong style={styles.section}>
                <View style={styles.platformHead}>
                  <View style={[styles.dot, { backgroundColor: marka }]} />
                  <Txt v="heading" style={{ color: marka, flex: 1 }}>
                    {PLATFORM_LABEL[t.platform]}
                  </Txt>
                  <Txt v="bodyStrong" num>
                    {formatPercent(t.currentMargin)}
                  </Txt>
                </View>
                <Txt v="small" tone="faint">
                  Hedef marj için satış fiyatı (KDV dahil)
                </Txt>
                <View style={styles.plGrid}>
                  {t.rows.map((r) => (
                    <View key={r.margin} style={styles.plCell}>
                      <Txt v="label" tone="faint" num>
                        %{r.margin}
                      </Txt>
                      <Txt v="smallStrong" num>
                        {r.price == null ? "—" : formatCurrency(r.price)}
                      </Txt>
                    </View>
                  ))}
                </View>
              </Tint>
            );
          })}
          {priceLab.campaign ? (
            <Tint strong style={styles.section}>
              <Txt v="label" tone="faint" style={styles.kicker}>
                SHOPIFY KAMPANYA SİMÜLATÖRÜ
              </Txt>
              <View style={styles.campHead}>
                <Txt v="label" tone="faint" style={{ flex: 1 }}>
                  İndirim
                </Txt>
                <Txt v="label" tone="faint" style={styles.campCol}>
                  Fiyat
                </Txt>
                <Txt v="label" tone="faint" style={styles.campCol}>
                  Net kâr
                </Txt>
                <Txt v="label" tone="faint" style={styles.campColS}>
                  Marj
                </Txt>
              </View>
              {priceLab.campaign.rows.map((r) => (
                <View key={r.discount} style={[styles.campRow, r.profit < 0 ? { backgroundColor: color.badSoft } : null]}>
                  <Txt v="smallStrong" num style={{ flex: 1 }}>
                    %{r.discount}
                  </Txt>
                  <Txt v="small" tone="dim" num style={styles.campCol}>
                    {formatCurrency(r.effectivePrice)}
                  </Txt>
                  <Txt v="smallStrong" tone={r.profit < 0 ? "bad" : "good"} num style={styles.campCol}>
                    {formatCurrency(r.profit)}
                  </Txt>
                  <Txt v="small" tone="dim" num style={styles.campColS}>
                    {formatPercent(r.margin)}
                  </Txt>
                </View>
              ))}
              <Txt v="small" tone="faint">
                Kırmızı satır = o indirimde zarara geçiyorsun
              </Txt>
            </Tint>
          ) : null}
        </>
      ) : null}

      {/* Fiyat geçmişi */}
      {priceHistory && priceHistory.length > 0 ? (
        <>
          <Txt v="label" tone="faint" style={styles.sectionTitle}>
            FİYAT GEÇMİŞİ
          </Txt>
          <Tint strong padded={false} style={styles.section}>
            {priceHistory.map((h: PriceChange, i) => (
              <View key={h.id} style={[styles.histRow, i > 0 ? styles.histBorder : null]}>
                <View style={{ flex: 1 }}>
                  <Txt v="bodyStrong" num>
                    {formatCurrency(h.oldPrice)} → {formatCurrency(h.newPrice)}
                  </Txt>
                  <Txt v="small" tone="faint">
                    {h.changeSource}
                  </Txt>
                </View>
                <Txt v="small" tone="dim" num>
                  {formatDate(h.changedAt)}
                </Txt>
              </View>
            ))}
          </Tint>
        </>
      ) : null}

      {/* Takma ad */}
      <Modal visible={aliasOpen} transparent animationType="fade" onRequestClose={() => setAliasOpen(false)}>
        <Pressable style={styles.aliasBackdrop} onPress={() => setAliasOpen(false)}>
          <Pressable onPress={() => {}} style={{ width: "100%" }}>
            <Glass strong>
              <Txt v="heading">Takma ad</Txt>
              <Txt v="small" tone="dim" style={{ marginBottom: space.md }}>
                Liste ve aramada görünen kısa ad.
              </Txt>
              <Input
                value={aliasDraft}
                onChangeText={setAliasDraft}
                placeholder="örn. Kırmızı Kedi Figürü"
                autoFocus
                returnKeyType="done"
                onSubmitEditing={kaydetAlias}
              />
              <View style={styles.aliasBtns}>
                <Button label="İptal" variant="ghost" size="sm" onPress={() => setAliasOpen(false)} />
                <Button label="Kaydet" size="sm" onPress={kaydetAlias} />
              </View>
            </Glass>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

function PlatformCard({ p }: { p: PlatformProfit }) {
  const r = p.result;
  const loss = r.netProfit < 0;
  const marka = PLATFORM_COLOR[p.platform];
  const marj = Number.isFinite(r.profitMargin) ? r.profitMargin : 0;
  return (
    <Glass style={styles.section}>
      <View style={styles.platformHead}>
        <View style={[styles.dot, { backgroundColor: marka }]} />
        <Txt v="heading" style={{ color: marka, flex: 1 }} numberOfLines={1}>
          {PLATFORM_LABEL[p.platform]}
        </Txt>
        {p.minOrderQty > 1 ? <Pill color={color.warn}>×{p.minOrderQty} sipariş</Pill> : null}
        <Money value={p.salePrice} v="heading" />
      </View>

      <View style={styles.kpiRow}>
        <View style={{ flex: 1 }}>
          <Txt v="label" tone="faint" style={styles.kicker}>
            NET KÂR
          </Txt>
          <Money value={r.netProfit} v="title" tone={loss ? "bad" : "good"} />
        </View>
        <View style={{ alignItems: "center", gap: 2 }}>
          <Ring value={marj} size={64} stroke={7} color={loss ? color.bad : marj < 0.2 ? color.warn : color.good}>
            <Txt v="label" num>
              {formatPercent(marj, 0)}
            </Txt>
          </Ring>
          <Txt v="label" tone="faint">
            MARJ
          </Txt>
        </View>
      </View>

      {p.commissionMissing ? (
        <View style={styles.warnBox}>
          <SymbolView name="exclamationmark.triangle.fill" tintColor={color.bad} style={{ width: 16, height: 16 }} />
          <Txt v="small" tone="bad" style={{ flex: 1 }}>
            {PLATFORM_LABEL[p.platform]} komisyonu girilmemiş — kâr olduğundan yüksek görünüyor.
          </Txt>
        </View>
      ) : null}

      <View style={styles.divider} />
      <Dokum label={`KDV (%${r.vatRate})`} value={r.vatAmount} />
      <Dokum label="Ürün + paketleme" value={r.productCost + r.packagingCost} />
      <Dokum label="Komisyon" value={r.commissionCost} />
      <Dokum label="Kargo" value={r.cargoCost} />
      {r.appliedExpenseRules
        .filter((e) => e.amount !== 0)
        .map((e) => (
          <Dokum key={e.id} label={e.name} value={e.amount} />
        ))}
      {r.inputVatCredit > 0 ? <Dokum label="KDV iadesi" value={r.inputVatCredit} positive /> : null}
    </Glass>
  );
}

function Dokum({ label, value, positive }: { label: string; value: number; positive?: boolean }) {
  return (
    <View style={styles.breakRow}>
      <Txt v="small" tone="dim">
        {label}
      </Txt>
      <Txt v={positive ? "smallStrong" : "small"} tone={positive ? "good" : "dim"} num>
        {positive ? "+" : "−"}
        {formatCurrency(value)}
      </Txt>
    </View>
  );
}

function Satir({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.breakRow}>
      <Txt v={bold ? "bodyStrong" : "small"} tone={bold ? "default" : "dim"}>
        {label}
      </Txt>
      <Txt v={bold ? "bodyStrong" : "small"} tone={bold ? "default" : "dim"} num>
        {value}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: "row", gap: space.md, alignItems: "center" },
  thumb: { width: 72, height: 72, borderRadius: radius.md, backgroundColor: color.tintStrong },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
  section: { gap: 6, padding: space.lg },
  sectionTitle: { letterSpacing: 1.2, marginTop: space.sm, marginLeft: space.xs },
  kicker: { letterSpacing: 1 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  stockRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.lineStrong, marginVertical: space.sm },
  platformHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  kpiRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.xs },
  warnBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: color.badSoft,
    borderRadius: radius.sm,
    padding: space.sm,
    marginTop: space.xs,
  },
  breakRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  plGrid: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  plCell: {
    flex: 1,
    backgroundColor: color.tint,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    paddingVertical: space.sm,
    alignItems: "center",
    gap: 2,
  },
  campHead: { flexDirection: "row", alignItems: "center", paddingBottom: 4, marginTop: space.xs },
  campCol: { width: 84, textAlign: "right" },
  campColS: { width: 52, textAlign: "right" },
  campRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 7,
    paddingHorizontal: 6,
    marginHorizontal: -6,
    borderRadius: radius.xs,
  },
  histRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: space.sm, gap: space.sm },
  histBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  variantRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm },
  variantThumb: { width: 40, height: 40, borderRadius: radius.xs, backgroundColor: color.tintStrong },
  aliasBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: space.xl },
  aliasBtns: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm, marginTop: space.lg },
});
