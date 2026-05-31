import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { MotiView } from "moti";
import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getProductDetail, getVariantGroup, type ProductDetail } from "@/lib/db/product-detail";
import { getPriceHistory, setProductStock, type PriceChange } from "@/lib/db/products";
import {
  getCommissionRules,
  getCargoRules,
  getExpenseRules,
  getSettingsMap,
} from "@/lib/db/rules";
import { computeProductProfit, type PlatformProfit } from "@/lib/profit";
import { computePriceLab } from "@/lib/price-lab";
import { formatCurrency, formatDate, formatPercent } from "@/lib/format";
import { ML, radius } from "@/theme/colors";

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();

  const { data: product, isLoading } = useQuery({
    queryKey: ["product", id],
    queryFn: () => getProductDetail(id),
  });

  const { data: rules } = useQuery({
    queryKey: ["rules"],
    queryFn: async () => ({
      commission: await getCommissionRules(),
      cargo: await getCargoRules(),
      expense: await getExpenseRules(),
    }),
  });

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettingsMap,
  });

  const { data: priceHistory } = useQuery({
    queryKey: ["price-history", id],
    queryFn: () => getPriceHistory(id),
  });

  const { data: variantGroup } = useQuery({
    queryKey: ["variant-group", product?.variantGroupId],
    queryFn: () => getVariantGroup(product!.variantGroupId!),
    enabled: !!product?.variantGroupId,
  });

  // Optimistic: UI anında değişir, DB yazımı arka planda; hata olursa geri al.
  const stockMutation = useMutation({
    mutationFn: (newStock: number) => setProductStock(id, newStock),
    onMutate: async (newStock: number) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await qc.cancelQueries({ queryKey: ["product", id] });
      const prev = qc.getQueryData<ProductDetail>(["product", id]);
      qc.setQueryData<ProductDetail>(["product", id], (o) => (o ? { ...o, stock: newStock } : o));
      qc.setQueryData<ProductDetail[]>(["dashboard-data"], (o) =>
        o ? o.map((p) => (p.id === id ? { ...p, stock: newStock } : p)) : o
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["product", id], ctx.prev);
    },
  });

  const profit =
    product && rules && settings
      ? computeProductProfit(product, rules, settings)
      : null;

  const priceLab = useMemo(
    () => (product && rules && settings ? computePriceLab(product, rules, settings) : null),
    [product, rules, settings]
  );

  if (isLoading || !product) {
    return (
      <SafeAreaView style={styles.safe}>
        <Header title="" />
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const stock = product.stock;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Header title={product.categoryName} />
      <ScrollView contentContainerStyle={styles.content}>
        {/* Ürün başlığı */}
        <View style={styles.titleRow}>
          {product.imageUrl ? (
            <Image source={{ uri: product.imageUrl }} style={styles.thumb} contentFit="cover" />
          ) : (
            <View style={[styles.thumb, styles.thumbEmpty]} />
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{product.name}</Text>
            <Text style={styles.sku}>{product.sku}</Text>
          </View>
        </View>

        {/* Varyant grubu */}
        {variantGroup && variantGroup.members.length > 1 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>VARYANT GRUBU · {variantGroup.name.toUpperCase()}</Text>
            {variantGroup.members.map((m) => {
              const isCurrent = m.id === product.id;
              return (
                <Pressable
                  key={m.id}
                  disabled={isCurrent}
                  onPress={() => router.push(`/product/${m.id}`)}
                  style={({ pressed }) => [
                    styles.variantRow,
                    pressed && !isCurrent && { opacity: 0.6 },
                  ]}
                >
                  {m.imageUrl ? (
                    <Image source={{ uri: m.imageUrl }} style={styles.variantThumb} contentFit="cover" />
                  ) : (
                    <View style={[styles.variantThumb, styles.thumbEmpty]} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.variantLabel} numberOfLines={1}>
                      {m.variantLabel || m.name}
                    </Text>
                    <Text style={styles.variantMeta}>
                      {m.stock} adet · {formatCurrency(m.currentSalePrice)}
                    </Text>
                  </View>
                  {isCurrent ? (
                    <View style={styles.curBadge}>
                      <Text style={styles.curBadgeText}>bu ürün</Text>
                    </View>
                  ) : (
                    <Text style={styles.variantChevron}>›</Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Stok editörü */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>STOK</Text>
          <View style={styles.stockRow}>
            <StockButton
              label="−"
              onPress={() => stockMutation.mutate(Math.max(0, stock - 1))}
              disabled={stock <= 0}
            />
            <View style={styles.stockValue}>
              <Text style={styles.stockNumber}>{stock}</Text>
              <Text style={styles.stockUnit}>adet</Text>
            </View>
            <StockButton label="+" onPress={() => stockMutation.mutate(stock + 1)} />
          </View>
        </View>

        {/* Maliyet özeti */}
        {profit?.hasCost ? (
          <View style={styles.section}>
            <View style={styles.cardHeadRow}>
              <Text style={styles.sectionLabel}>MALİYET</Text>
              <Pressable onPress={() => router.push(`/edit-cost/${product.id}`)} hitSlop={8}>
                <Text style={styles.editLink}>Düzenle</Text>
              </Pressable>
            </View>
            <Row label="Üretim" value={formatCurrency(profit.productionCost)} />
            <Row label="Paketleme" value={formatCurrency(profit.packagingCost)} />
            <View style={styles.divider} />
            <Row label="Toplam Maliyet" value={formatCurrency(profit.totalCost)} bold />
          </View>
        ) : (
          <Pressable
            onPress={() => router.push(`/edit-cost/${product.id}`)}
            style={({ pressed }) => [styles.addCostBtn, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.addCostText}>+ Maliyet Ekle</Text>
          </Pressable>
        )}

        {/* Platform kâr/zarar */}
        <Text style={[styles.sectionLabel, { marginTop: 8, marginLeft: 4 }]}>
          PLATFORM KÂR / ZARAR
        </Text>
        {profit && profit.platforms.length > 0 ? (
          profit.platforms.map((p, i) => <PlatformCard key={p.listingId} p={p} index={i} />)
        ) : (
          <View style={styles.section}>
            <Text style={styles.dim}>
              {profit?.hasCost
                ? "Bu ürünün platform listing'i yok."
                : "Maliyet girilmemiş — kâr hesaplanamıyor."}
            </Text>
          </View>
        )}

        {/* Fiyat Laboratuvarı */}
        {priceLab?.hasCost && (
          <>
            <Text style={[styles.sectionLabel, { marginTop: 8, marginLeft: 4 }]}>
              FİYAT LABORATUVARI
            </Text>
            {priceLab.targets.map((t) => {
              const accent = t.platform === "shopify" ? ML.shopify : ML.trendyol;
              return (
                <View key={t.platform} style={styles.section}>
                  <View style={styles.platformHead}>
                    <View style={[styles.dot, { backgroundColor: accent }]} />
                    <Text style={[styles.platformName, { color: accent }]}>
                      {t.platform === "shopify" ? "Shopify" : "Trendyol"}
                    </Text>
                    <Text style={styles.salePrice}>{formatPercent(t.currentMargin)}</Text>
                  </View>
                  <Text style={styles.plHint}>Hedef marj için satış fiyatı (KDV dahil)</Text>
                  <View style={styles.plGrid}>
                    {t.rows.map((r) => (
                      <View key={r.margin} style={styles.plCell}>
                        <Text style={styles.plMargin}>%{r.margin}</Text>
                        <Text style={styles.plPrice}>
                          {r.price == null ? "—" : formatCurrency(r.price)}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              );
            })}
            {priceLab.campaign && (
              <View style={styles.section}>
                <Text style={[styles.sectionLabel, { marginBottom: 8 }]}>
                  SHOPIFY KAMPANYA SİMÜLATÖRÜ
                </Text>
                <View style={styles.campHead}>
                  <Text style={[styles.campH, { flex: 1 }]}>İndirim</Text>
                  <Text style={[styles.campH, { width: 80, textAlign: "right" }]}>Fiyat</Text>
                  <Text style={[styles.campH, { width: 80, textAlign: "right" }]}>Net kâr</Text>
                  <Text style={[styles.campH, { width: 48, textAlign: "right" }]}>Marj</Text>
                </View>
                {priceLab.campaign.rows.map((r) => (
                  <View
                    key={r.discount}
                    style={[styles.campRow, r.profit < 0 && { backgroundColor: ML.redSoft }]}
                  >
                    <Text style={[styles.campVal, { flex: 1, fontWeight: "700" }]}>%{r.discount}</Text>
                    <Text style={[styles.campVal, { width: 80, textAlign: "right" }]}>
                      {formatCurrency(r.effectivePrice)}
                    </Text>
                    <Text
                      style={[
                        styles.campVal,
                        { width: 80, textAlign: "right", color: r.profit < 0 ? ML.red : ML.green },
                      ]}
                    >
                      {formatCurrency(r.profit)}
                    </Text>
                    <Text style={[styles.campVal, { width: 48, textAlign: "right" }]}>
                      {formatPercent(r.margin)}
                    </Text>
                  </View>
                ))}
                <Text style={styles.plHint}>Kırmızı satır = o indirimde zarara geçiyorsun</Text>
              </View>
            )}
          </>
        )}

        {/* Fiyat geçmişi */}
        {priceHistory && priceHistory.length > 0 && (
          <>
            <Text style={[styles.sectionLabel, { marginTop: 8, marginLeft: 4 }]}>
              FİYAT GEÇMİŞİ
            </Text>
            <View style={styles.section}>
              {priceHistory.map((h: PriceChange, i) => (
                <View key={h.id} style={[styles.histRow, i > 0 && styles.histBorder]}>
                  <View>
                    <Text style={styles.histPrice}>
                      {formatCurrency(h.oldPrice)} → {formatCurrency(h.newPrice)}
                    </Text>
                    <Text style={styles.histSource}>{h.changeSource}</Text>
                  </View>
                  <Text style={styles.histDate}>{formatDate(h.changedAt)}</Text>
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function PlatformCard({ p, index }: { p: PlatformProfit; index: number }) {
  const r = p.result;
  const loss = r.netProfit < 0;
  const accent = p.platform === "shopify" ? ML.shopify : ML.trendyol;
  return (
    <MotiView
      from={{ opacity: 0, translateY: 16 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: "timing", duration: 340, delay: 80 + index * 90 }}
      style={styles.section}
    >
      <View style={styles.platformHead}>
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <Text style={[styles.platformName, { color: accent }]}>
          {p.platform === "shopify" ? "Shopify" : "Trendyol"}
        </Text>
        <Text style={styles.salePrice}>{formatCurrency(p.salePrice)}</Text>
      </View>

      <View style={styles.kpiRow}>
        <View>
          <Text style={styles.kpiLabel}>NET KÂR</Text>
          <Text style={[styles.kpiValue, { color: loss ? ML.red : ML.green }]}>
            {formatCurrency(r.netProfit)}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.kpiLabel}>MARJ</Text>
          <Text style={styles.kpiValue}>{formatPercent(r.profitMargin)}</Text>
        </View>
      </View>

      <View style={styles.divider} />
      <BreakdownRow label={`KDV (%${r.vatRate})`} value={r.vatAmount} />
      <BreakdownRow label="Ürün + Paketleme" value={r.productCost + r.packagingCost} />
      <BreakdownRow label="Komisyon" value={r.commissionCost} />
      <BreakdownRow label="Kargo" value={r.cargoCost} />
      {r.appliedExpenseRules
        .filter((e) => e.amount !== 0)
        .map((e) => (
          <BreakdownRow key={e.id} label={e.name} value={e.amount} />
        ))}
    </MotiView>
  );
}

function BreakdownRow({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.breakRow}>
      <Text style={styles.breakLabel}>{label}</Text>
      <Text style={styles.breakValue}>−{formatCurrency(value)}</Text>
    </View>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.breakRow}>
      <Text style={[styles.breakLabel, bold && { color: ML.text, fontWeight: "700" }]}>
        {label}
      </Text>
      <Text style={[styles.breakValue, bold && { fontWeight: "800" }]}>{value}</Text>
    </View>
  );
}

function StockButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.stockBtn,
        pressed && { backgroundColor: ML.accent, transform: [{ scale: 0.94 }] },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text style={styles.stockBtnText}>{label}</Text>
    </Pressable>
  );
}

function Header({ title }: { title: string }) {
  return (
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
        <Text style={styles.backText}>‹</Text>
      </Pressable>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      <View style={{ width: 32 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    height: 48,
  },
  back: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  backText: { color: ML.text, fontSize: 34, marginTop: -4 },
  headerTitle: { flex: 1, color: ML.textDim, fontSize: 15, textAlign: "center" },
  content: { padding: 16, gap: 14, paddingBottom: 48 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  titleRow: { flexDirection: "row", gap: 14, alignItems: "center" },
  thumb: { width: 64, height: 64, borderRadius: radius.md, backgroundColor: ML.card },
  thumbEmpty: { borderWidth: 1, borderColor: ML.border },
  name: { color: ML.text, fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  sku: { color: ML.textFaint, fontSize: 13, marginTop: 4 },
  section: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 16,
    gap: 6,
  },
  sectionLabel: {
    color: ML.textFaint,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    marginBottom: 6,
  },
  stockRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stockBtn: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: ML.cardElevated,
    borderWidth: 1,
    borderColor: ML.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stockBtnText: { color: ML.text, fontSize: 28, fontWeight: "600" },
  stockValue: { alignItems: "center" },
  stockNumber: { color: ML.text, fontSize: 40, fontWeight: "800" },
  stockUnit: { color: ML.textFaint, fontSize: 13, marginTop: -2 },
  divider: { height: 1, backgroundColor: ML.border, marginVertical: 8 },
  platformHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  platformName: { fontSize: 16, fontWeight: "700", flex: 1 },
  salePrice: { color: ML.text, fontSize: 18, fontWeight: "800" },
  kpiRow: { flexDirection: "row", justifyContent: "space-between", marginVertical: 4 },
  kpiLabel: { color: ML.textFaint, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  kpiValue: { color: ML.text, fontSize: 22, fontWeight: "800", marginTop: 2 },
  breakRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  breakLabel: { color: ML.textDim, fontSize: 13 },
  breakValue: { color: ML.textDim, fontSize: 13, fontVariant: ["tabular-nums"] },
  dim: { color: ML.textDim, fontSize: 14 },
  cardHeadRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  editLink: { color: ML.accent, fontSize: 14, fontWeight: "700" },
  addCostBtn: {
    backgroundColor: ML.accentSoft,
    borderWidth: 1,
    borderColor: ML.accent,
    borderRadius: radius.lg,
    paddingVertical: 16,
    alignItems: "center",
  },
  addCostText: { color: ML.accent, fontSize: 16, fontWeight: "700" },
  histRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
  },
  histBorder: { borderTopWidth: 1, borderTopColor: ML.borderSoft },
  histPrice: { color: ML.text, fontSize: 14, fontWeight: "600" },
  histSource: { color: ML.textFaint, fontSize: 12, marginTop: 2 },
  histDate: { color: ML.textDim, fontSize: 12 },
  plHint: { color: ML.textFaint, fontSize: 11, marginTop: 4 },
  plGrid: { flexDirection: "row", gap: 8, marginTop: 8 },
  plCell: {
    flex: 1,
    backgroundColor: ML.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    paddingVertical: 8,
    alignItems: "center",
  },
  plMargin: { color: ML.textFaint, fontSize: 11, fontWeight: "700" },
  plPrice: { color: ML.text, fontSize: 13, fontWeight: "700", marginTop: 2, fontVariant: ["tabular-nums"] },
  campHead: { flexDirection: "row", alignItems: "center", paddingBottom: 4 },
  campH: { color: ML.textFaint, fontSize: 11, fontWeight: "700" },
  campRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 7,
    paddingHorizontal: 6,
    marginHorizontal: -6,
    borderRadius: radius.sm,
  },
  campVal: { color: ML.textDim, fontSize: 13, fontVariant: ["tabular-nums"] },
  variantRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
  },
  variantThumb: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: ML.cardElevated },
  variantLabel: { color: ML.text, fontSize: 14, fontWeight: "600" },
  variantMeta: { color: ML.textFaint, fontSize: 12, marginTop: 2 },
  curBadge: { backgroundColor: ML.accentSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  curBadgeText: { color: ML.accent, fontSize: 11, fontWeight: "700" },
  variantChevron: { color: ML.textFaint, fontSize: 22 },
});
