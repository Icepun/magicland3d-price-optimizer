import { useQuery } from "@tanstack/react-query";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useDeferredValue, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { Chip, Pill } from "@/components/kit/Chip";
import {
  Count,
  EmptyState,
  ErrorState,
  FadeInView,
  Header,
  Screen,
  SearchInput,
  ShimmerList,
  Tint,
  Txt,
} from "@/components/kit";
import { getDashboardData } from "@/lib/db/dashboard";
import { getRules, getSettingsMap } from "@/lib/db/rules";
import { formatCurrency, formatNumber } from "@/lib/format";
import { thumbUrl } from "@/lib/image";
import { PLATFORM_COLOR, type Platform } from "@/lib/platforms";
import { computeProductProfitMemo } from "@/lib/profit";
import { useManualRefresh } from "@/lib/use-refresh";
import { color, radius, space } from "@/theme/tokens";

type FilterKey = "all" | "out-of-stock" | "loss" | "no-cost";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "Tümü" },
  { key: "out-of-stock", label: "Stoksuz" },
  { key: "loss", label: "Zarar eden" },
  { key: "no-cost", label: "Maliyetsiz" },
];

function isFilterKey(value: string | undefined): value is FilterKey {
  return FILTERS.some((filter) => filter.key === value);
}

/** Türkçe-duyarlı arama normalizasyonu (Hermes-güvenli: normalize() yok). */
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
  search: string;
}

type Row =
  | { kind: "product"; item: ListItem }
  | { kind: "member"; item: ListItem }
  | { kind: "group"; id: string; name: string; members: ListItem[] };

const RowGap = () => <View style={{ height: space.sm }} />;

/**
 * ÜRÜNLER — arama (Türkçe duyarsız, çok kelimeli), dört süzgeç, varyant grupları (açılır).
 * Veri katmanı öncekiyle aynı; satırlar blur'suz saydam yüzey (FlashList geri dönüşümü).
 */
export default function ProductsScreen() {
  const params = useLocalSearchParams<{ filter?: string }>();
  const [search, setSearch] = useState("");
  // Arama tuşa anında yazılır; süzgeç + liste farkı ertelenmiş değerle düşük öncelikte koşar.
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
      const tokens = q.split(/\s+/).filter(Boolean);
      list = list.filter((i) => tokens.every((t) => i.search.includes(t)));
    }
    return list;
  }, [items, filter, deferredSearch]);

  /** Süzgeç sayıları çiplerde: hangi süzgeçte kaç ürün var, açmadan görünsün. */
  const sayilar = useMemo(
    () => ({
      all: items.length,
      "out-of-stock": items.filter((i) => i.stock <= 0 && !i.madeToOrder).length,
      loss: items.filter((i) => i.anyLoss).length,
      "no-cost": items.filter((i) => !i.hasCost).length,
    }),
    [items]
  );

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
    <Screen
      scroll={false}
      padded={false}
      header={
        <Header
          title="Ürünler"
          updatedAt={dataUpdatedAt}
          subtitle={
            products ? (
              <Count value={filtered.length} v="small" tone="dim" format={(n) => `${formatNumber(Math.round(n))} ürün`} />
            ) : (
              "yükleniyor…"
            )
          }
        />
      }
    >
      <View style={styles.filterBar}>
        <SearchInput
          value={search}
          onChangeText={setSearch}
          placeholder="Ürün, kategori, SKU veya barkod ara"
          accessibilityLabel="Ürünlerde ara"
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          keyboardShouldPersistTaps="handled"
        >
          {FILTERS.map((f) => (
            <Chip
              key={f.key}
              label={f.label}
              count={sayilar[f.key]}
              selected={f.key === filter}
              onPress={() => router.setParams({ filter: f.key })}
            />
          ))}
        </ScrollView>
      </View>

      {isLoading ? (
        <View style={styles.list}>
          <ShimmerList count={7} height={80} />
        </View>
      ) : isError ? (
        <View style={styles.list}>
          <ErrorState title="Ürünler alınamadı" error={error} onRetry={() => void refetch()} />
        </View>
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(r) => (r.kind === "group" ? "g-" + r.id : (r.kind === "member" ? "m-" : "p-") + r.item.id)}
          contentContainerStyle={styles.list}
          keyboardDismissMode="on-drag"
          renderItem={({ item: row, index }) => {
            const content =
              row.kind === "group" ? (
                <GroupHeader row={row} open={expanded.has(row.id)} onToggle={() => toggleGroup(row.id)} />
              ) : (
                <ProductRow item={row.item} member={row.kind === "member"} />
              );
            // Giriş animasyonu yalnız ilk ekranda ve süzgeç/arama yokken (yazarken remount jank'i olmasın).
            if (index >= 8 || search.trim() !== "" || filter !== "all") return content;
            return (
              <FadeInView index={index} duration={200} step={18}>
                {content}
              </FadeInView>
            );
          }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.accentBright} />
          }
          ListEmptyComponent={
            <EmptyState
              icon="shippingbox"
              title="Sonuç yok"
              hint={search.trim() ? "Aramayı sadeleştirmeyi dene." : "Bu süzgeçte ürün yok."}
            />
          }
          getItemType={(r) => r.kind}
          ItemSeparatorComponent={RowGap}
        />
      )}
    </Screen>
  );
}

function Thumb({ uri, alt, id }: { uri: string | null; alt: string; id: string }) {
  if (uri) {
    return (
      <Image
        source={{ uri: thumbUrl(uri, 160)! }}
        alt={alt}
        style={styles.thumb}
        contentFit="cover"
        transition={150}
        recyclingKey={id}
      />
    );
  }
  return (
    <View style={[styles.thumb, styles.thumbEmpty]}>
      <SymbolView name="cube.box" tintColor={color.textFaint} style={{ width: 20, height: 20 }} />
    </View>
  );
}

function ProductRow({ item, member }: { item: ListItem; member?: boolean }) {
  const madeToOrder = Boolean(item.madeToOrder);
  const out = item.stock <= 0 && !madeToOrder;
  const stokRenk = out ? color.bad : madeToOrder ? color.accentBright : color.good;
  return (
    <Tint
      strong
      onPress={() => router.push(`/product/${item.id}`)}
      style={[styles.card, member ? styles.memberCard : null]}
      accessibilityLabel={item.name}
    >
      <Thumb uri={item.imageUrl} alt={item.name} id={item.id} />

      <View style={styles.body}>
        <Txt v="bodyStrong" numberOfLines={1}>
          {member ? item.variantLabel || item.name : item.name}
        </Txt>
        <View style={styles.metaRow}>
          <Txt v="small" tone="faint" numberOfLines={1} style={{ flexShrink: 1 }}>
            {item.category}
          </Txt>
          <View style={[styles.dot, { backgroundColor: stokRenk }]} />
          <Txt v="smallStrong" style={{ color: out ? color.bad : color.textDim }} num numberOfLines={1}>
            {madeToOrder ? "Siparişle üretilir" : out ? "Bitti" : `${item.stock} adet`}
          </Txt>
          {item.missingDesi ? (
            <Txt v="label" tone="warn" style={{ fontSize: 10, lineHeight: 12 }}>
              · Desi eksik
            </Txt>
          ) : null}
        </View>
      </View>

      <View style={styles.profitCol}>
        {item.hasCost ? (
          item.platforms.map((pl) => (
            <View key={pl.platform} style={styles.profitRow}>
              <View style={[styles.platDot, { backgroundColor: PLATFORM_COLOR[pl.platform] }]} />
              <Txt v="smallStrong" tone={(pl.netProfit ?? 0) < 0 ? "bad" : "good"} num>
                {pl.netProfit == null
                  ? "—"
                  : `${formatCurrency(pl.netProfit)}${pl.minOrderQty > 1 ? ` ×${pl.minOrderQty}` : ""}`}
              </Txt>
            </View>
          ))
        ) : (
          <Pill color={color.textFaint}>maliyet yok</Pill>
        )}
      </View>
    </Tint>
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
    <Tint strong onPress={onToggle} style={[styles.card, styles.groupCard]} accessibilityLabel={`${row.name} varyant grubu`}>
      <Thumb uri={img} alt={row.name} id={row.id} />
      <View style={styles.body}>
        <Txt v="bodyStrong" numberOfLines={1}>
          {row.name}
        </Txt>
        <View style={styles.metaRow}>
          <Pill>{row.members.length} varyant</Pill>
          <Txt v="smallStrong" tone="dim" num>
            {totalStock} adet
          </Txt>
        </View>
      </View>
      <SymbolView
        name="chevron.right"
        tintColor={color.textFaint}
        style={[styles.chevron, open ? { transform: [{ rotate: "90deg" }] } : null]}
      />
    </Tint>
  );
}

const styles = StyleSheet.create({
  filterBar: { paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm },
  chips: { gap: space.sm, paddingRight: space.lg },
  list: { paddingHorizontal: space.lg, paddingTop: space.xs, paddingBottom: space.xxl },
  card: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  groupCard: { borderColor: color.accent + "55" },
  memberCard: { marginLeft: space.xl },
  thumb: { width: 52, height: 52, borderRadius: radius.sm, backgroundColor: color.tint },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
  body: { flex: 1, gap: 3, minWidth: 0 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  profitCol: { alignItems: "flex-end", gap: 3, minWidth: 78 },
  profitRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  platDot: { width: 7, height: 7, borderRadius: 4 },
  chevron: { width: 14, height: 14 },
});
