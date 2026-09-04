import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { FlashList } from "@shopify/flash-list";
import { useDeferredValue, useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/components/AppHeader";
import { PressableScale } from "@/components/ui/PressableScale";
import { getDashboardData } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { computeProductProfitMemo } from "@/lib/profit";
import { useManualRefresh } from "@/lib/use-refresh";
import { formatCurrency, formatNumber, friendlyError } from "@/lib/format";
import { AnimatedNumber, FadeInView, Skeleton } from "@/components/fade-in";
import { ML, radius } from "@/theme/colors";
import type { Platform } from "@/lib/platforms";
import { thumbUrl } from "@/lib/image";

type FilterKey = "all" | "out-of-stock" | "loss" | "no-cost";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "Tümü" },
  { key: "out-of-stock", label: "Stokta Biten" },
  { key: "loss", label: "Zarar Eden" },
  { key: "no-cost", label: "Maliyetsiz" },
];

function isFilterKey(value: string | undefined): value is FilterKey {
  return FILTERS.some((filter) => filter.key === value);
}

/**
 * Türkçe-duyarlı arama normalizasyonu: şapka/aksan katlama + küçük harf.
 * "Şık"→"sik", "İSTANBUL"→"istanbul", "Ğücé"→"guce" → sorgu ve veri aynı düzleme iner,
 * böylece kullanıcı Türkçe karakter yazsa da yazmasa da eşleşir. (Hermes-güvenli: normalize() yok.)
 */
function foldTr(s: string): string {
  return s
    .replace(/[İIı]/g, "i")
    .replace(/[Şş]/g, "s")
    .replace(/[Çç]/g, "c")
    .replace(/[Ğğ]/g, "g")
    .replace(/[Öö]/g, "o")
    .replace(/[Üü]/g, "u")
    .toLowerCase();
}

interface ListItem {
  id: string;
  name: string;
  category: string;
  imageUrl: string | null;
  stock: number;
  madeToOrder: number;
  hasCost: boolean;
  missingDesi: boolean;
  anyLoss: boolean;
  platforms: { platform: Platform; netProfit: number | null; minOrderQty: number }[];
  variantGroupId: string | null;
  variantGroupName: string | null;
  variantLabel: string | null;
  /** Önceden normalize edilmiş arama metni (ad+takma ad+sku+barkod+kategori+varyant). */
  search: string;
}

type Row =
  | { kind: "product"; item: ListItem }
  | { kind: "member"; item: ListItem }
  | { kind: "group"; id: string; name: string; members: ListItem[] };

const RowGap = () => <View style={{ height: 10 }} />;

export default function ProductsScreen() {
  const params = useLocalSearchParams<{ filter?: string }>();
  const [search, setSearch] = useState("");
  // Arama TUŞA ANINDA yazılır; filtre + liste diff'i ertelenmiş değerle düşük öncelikte koşar
  // (React 19 useDeferredValue) → hızlı yazarken input takılmaz.
  const deferredSearch = useDeferredValue(search);
  const filter: FilterKey = isFilterKey(params.filter) ? params.filter : "all";
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleGroup = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const { data: products, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["dashboard-data"],
    queryFn: getDashboardData,
  });
  // Tek batch round-trip (getRules) — eski hali 3 ardışık Turso çağrısıydı.
  const { data: rules } = useQuery({ queryKey: ["rules"], queryFn: getRules });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  const { refreshing, onRefresh } = useManualRefresh(refetch);

  const items = useMemo<ListItem[]>(() => {
    if (!products || !rules || !settings) return [];
    return products.map((p) => {
      const profit = computeProductProfitMemo(p, rules, settings);
      return {
        id: p.id,
        name: p.name,
        category: p.categoryName,
        imageUrl: p.imageUrl,
        stock: p.stock,
        madeToOrder: p.madeToOrder,
        hasCost: profit.hasCost,
        missingDesi: p.desi == null || p.desi <= 0,
        anyLoss: profit.platforms.some((pl) => pl.result.netProfit < 0),
        platforms: profit.platforms.map((pl) => ({
          platform: pl.platform,
          netProfit: profit.hasCost ? pl.result.netProfit : null,
          minOrderQty: pl.minOrderQty,
        })),
        variantGroupId: p.variantGroupId,
        variantGroupName: p.variantGroupName ?? null,
        variantLabel: p.variantLabel,
        search: foldTr(
          [p.name, p.alias, p.sku, p.barcode, p.categoryName, p.variantLabel, p.variantGroupName]
            .filter(Boolean)
            .join(" ")
        ),
      };
    });
  }, [products, rules, settings]);

  const filtered = useMemo(() => {
    let list = items;
    if (filter === "out-of-stock") list = list.filter((i) => i.stock <= 0 && !i.madeToOrder);
    else if (filter === "loss") list = list.filter((i) => i.anyLoss);
    else if (filter === "no-cost") list = list.filter((i) => !i.hasCost);
    const q = foldTr(deferredSearch.trim());
    if (q) {
      // Çok-kelimeli, sırasız: her kelime herhangi bir alanda (ad/takma ad/sku/barkod/kategori/varyant) geçmeli.
      const tokens = q.split(/\s+/).filter(Boolean);
      list = list.filter((i) => tokens.every((t) => i.search.includes(t)));
    }
    return list;
  }, [items, filter, deferredSearch]);

  // Varyant kardeşlerini tek "grup" satırına topla (tıklayınca açılır) — masaüstündeki gibi.
  const rows = useMemo<Row[]>(() => {
    const groups = new Map<string, ListItem[]>();
    const order: string[] = [];
    const byId = new Map<string, ListItem>();
    for (const it of filtered) {
      if (it.variantGroupId) {
        if (!groups.has(it.variantGroupId)) {
          groups.set(it.variantGroupId, []);
          order.push("g:" + it.variantGroupId);
        }
        groups.get(it.variantGroupId)!.push(it);
      } else {
        order.push("p:" + it.id);
        byId.set(it.id, it);
      }
    }
    const out: Row[] = [];
    for (const o of order) {
      if (o.startsWith("g:")) {
        const gid = o.slice(2);
        const members = groups.get(gid)!;
        if (members.length === 1) out.push({ kind: "product", item: members[0] });
        else {
          out.push({ kind: "group", id: gid, name: members[0].variantGroupName || "Varyant grubu", members });
          if (expanded.has(gid)) for (const m of members) out.push({ kind: "member", item: m });
        }
      } else {
        out.push({ kind: "product", item: byId.get(o.slice(2))! });
      }
    }
    return out;
  }, [filtered, expanded]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader
        title="Ürünler"
        updatedAt={dataUpdatedAt}
        subtitle={
          products ? (
            <AnimatedNumber
              value={filtered.length}
              format={(n) => `${formatNumber(Math.round(n))} ürün`}
              style={styles.subtitle}
            />
          ) : (
            "yükleniyor…"
          )
        }
      />

      <View style={styles.searchWrap}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Ürün veya kategori ara…"
          placeholderTextColor={ML.textFaint}
          style={styles.search}
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chipRow}
      >
        {FILTERS.map((f) => {
          const on = f.key === filter;
          return (
            <PressableScale
              key={f.key}
              onPress={() => router.setParams({ filter: f.key })}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && { color: "#fff", fontWeight: "700" }]}>{f.label}</Text>
            </PressableScale>
          );
        })}
      </ScrollView>

      {isLoading ? (
        <ProductListSkeleton />
      ) : isError ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Ürünler alınamadı</Text>
          <Text style={styles.dim}>{friendlyError(error)}</Text>
          <PressableScale onPress={() => refetch()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Tekrar dene</Text>
          </PressableScale>
        </View>
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(r) =>
            r.kind === "group" ? "g-" + r.id : (r.kind === "member" ? "m-" : "p-") + r.item.id
          }
          contentContainerStyle={styles.list}
          renderItem={({ item: row, index }) => {
            const content =
              row.kind === "group" ? (
                <GroupHeader row={row} open={expanded.has(row.id)} onToggle={() => toggleGroup(row.id)} />
              ) : (
                <ProductCard item={row.item} member={row.kind === "member"} />
              );
            // Giriş animasyonu yalnızca ilk ekrandaki öğelerde — derin kaydırmada her
            // satırda Reanimated mount animasyonu çalışıp kasmaya yol açmasın.
            // Arama/filtre AKTİFKEN hiç animasyon yok: her tuşta değişen sonuç kümesi üst
            // satırları remount edip animasyonu yeniden oynatıyordu (yazma jank'i).
            if (index >= 8 || search.trim() !== "" || filter !== "all") return content;
            return (
              <FadeInView index={index} duration={200} step={18}>
                {content}
              </FadeInView>
            );
          }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ML.accent} />
          }
          ListEmptyComponent={
            <Text style={[styles.dim, { textAlign: "center", marginTop: 40 }]}>Sonuç yok</Text>
          }
          getItemType={(r) => r.kind}
          ItemSeparatorComponent={RowGap}
        />
      )}
    </SafeAreaView>
  );
}

/**
 * Liste yüklenirken gerçek satırların yerini tutan iskelet.
 * (Tam sayfa dönen çark, listenin ne kadar süreceği hakkında hiçbir şey söylemiyordu.)
 */
function ProductListSkeleton() {
  return (
    <View style={styles.skeletonList}>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <View key={i} style={styles.skeletonRow}>
          <Skeleton width={52} height={52} radius={14} delay={i * 70} />
          <View style={styles.skeletonBody}>
            <Skeleton width="70%" height={14} delay={i * 70 + 40} />
            <Skeleton width="40%" height={11} delay={i * 70 + 90} />
          </View>
          <Skeleton width={62} height={14} delay={i * 70 + 130} />
        </View>
      ))}
    </View>
  );
}

function ProductCard({ item, member }: { item: ListItem; member?: boolean }) {
  const madeToOrder = Boolean(item.madeToOrder);
  const out = item.stock <= 0 && !madeToOrder;
  return (
    <PressableScale
      onPress={() => router.push(`/product/${item.id}`)}
      style={({ pressed }) => [styles.card, member && styles.memberCard, pressed && { backgroundColor: ML.cardElevated }]}
    >
      {item.imageUrl ? (
        <Image
          source={{ uri: thumbUrl(item.imageUrl, 160)! }}
          alt={item.name}
          style={styles.thumb}
          contentFit="cover"
          transition={150}
          recyclingKey={item.id}
        />
      ) : (
        <View style={[styles.thumb, styles.thumbEmpty]}>
          <Text style={styles.thumbEmptyText}>—</Text>
        </View>
      )}

      <View style={styles.cardBody}>
        <Text style={styles.name} numberOfLines={1}>
          {member ? item.variantLabel || item.name : item.name}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.category} numberOfLines={1}>
            {item.category}
          </Text>
          <View
            style={[
              styles.stockDot,
              { backgroundColor: out ? ML.red : madeToOrder ? ML.accent : ML.green },
            ]}
          />
          <Text style={[styles.stockText, { color: out ? ML.red : ML.textDim }]}>
            {madeToOrder ? "Siparişle üretilir" : out ? "Bitti" : `${item.stock} adet`}
          </Text>
          {item.missingDesi ? (
            <Text style={{ color: ML.orange, fontSize: 10 }}> · Desi eksik</Text>
          ) : null}
        </View>
      </View>

      <View style={styles.profitCol}>
        {item.hasCost ? (
          item.platforms.map((pl) => (
            <View key={pl.platform} style={styles.profitRow}>
              <View
                style={[
                  styles.platDot,
                  { backgroundColor: ML[pl.platform] },
                ]}
              />
              <Text
                style={[
                  styles.profitText,
                  { color: (pl.netProfit ?? 0) < 0 ? ML.red : ML.green },
                ]}
              >
                {pl.netProfit == null
                  ? "—"
                  : `${formatCurrency(pl.netProfit)}${pl.minOrderQty > 1 ? ` ×${pl.minOrderQty}` : ""}`}
              </Text>
            </View>
          ))
        ) : (
          <Text style={styles.noCost}>maliyet yok</Text>
        )}
      </View>
    </PressableScale>
  );
}

function GroupHeader({
  row,
  open,
  onToggle,
}: {
  row: { id: string; name: string; members: ListItem[] };
  open: boolean;
  onToggle: () => void;
}) {
  const totalStock = row.members.reduce((s, m) => s + m.stock, 0);
  const img = row.members.find((m) => m.imageUrl)?.imageUrl ?? null;
  return (
    <PressableScale
      onPress={onToggle}
      style={({ pressed }) => [styles.card, styles.groupCard, pressed && { backgroundColor: ML.cardElevated }]}
    >
      {img ? (
        <Image
          source={{ uri: thumbUrl(img, 160)! }}
          alt={row.name}
          style={styles.thumb}
          contentFit="cover"
          transition={150}
          recyclingKey={row.id}
        />
      ) : (
        <View style={[styles.thumb, styles.thumbEmpty]}>
          <Text style={styles.thumbEmptyText}>—</Text>
        </View>
      )}
      <View style={styles.cardBody}>
        <Text style={styles.name} numberOfLines={1}>
          {row.name}
        </Text>
        <View style={styles.metaRow}>
          <View style={styles.groupBadge}>
            <Text style={styles.groupBadgeText}>{row.members.length} varyant</Text>
          </View>
          <Text style={styles.stockText}>{totalStock} adet</Text>
        </View>
      </View>
      <Text style={[styles.chevron, open && { transform: [{ rotate: "90deg" }] }]}>›</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "transparent" }, // zemin kökte (kit/Backdrop)
  subtitle: { color: ML.textDim, fontSize: 14, marginTop: 2 },
  searchWrap: { paddingHorizontal: 20, paddingVertical: 10 },
  search: {
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    color: ML.text,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
  },
  chipScroll: { height: 44, flexGrow: 0, marginBottom: 12 },
  chipRow: { gap: 8, paddingHorizontal: 20, alignItems: "center" },
  chip: {
    height: 36,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: ML.card,
    borderWidth: 1,
    borderColor: ML.border,
  },
  chipOn: { backgroundColor: ML.accent, borderColor: ML.accent },
  chipText: { color: ML.textDim, fontSize: 13 },
  list: { paddingHorizontal: 20, paddingBottom: 24 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 12,
    gap: 12,
  },
  thumb: { width: 52, height: 52, borderRadius: radius.md, backgroundColor: ML.cardElevated },
  thumbEmpty: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: ML.border },
  thumbEmptyText: { color: ML.textFaint, fontSize: 20 },
  cardBody: { flex: 1, gap: 4 },
  name: { color: ML.text, fontSize: 15, fontWeight: "600" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  category: { color: ML.textFaint, fontSize: 12, flexShrink: 1 },
  stockDot: { width: 6, height: 6, borderRadius: 3 },
  stockText: { fontSize: 12, fontWeight: "600" },
  profitCol: { alignItems: "flex-end", gap: 4, minWidth: 78 },
  profitRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  platDot: { width: 7, height: 7, borderRadius: 4 },
  profitText: { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  noCost: { color: ML.textFaint, fontSize: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  dim: { color: ML.textDim, fontSize: 14, textAlign: "center" },
  errorTitle: { color: ML.red, fontSize: 18, fontWeight: "700" },
  retryBtn: {
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ML.accent + "77",
  },
  retryText: { color: ML.accent, fontSize: 14, fontWeight: "700" },
  skeletonList: { paddingHorizontal: 20, gap: 10 },
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
  groupCard: { backgroundColor: ML.cardElevated },
  groupBadge: { backgroundColor: ML.accentSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  groupBadgeText: { color: ML.accent, fontSize: 11, fontWeight: "700" },
  chevron: { color: ML.textFaint, fontSize: 24, paddingHorizontal: 2 },
  memberCard: { marginLeft: 22 },
});
