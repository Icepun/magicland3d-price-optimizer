import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { MotiView } from "moti";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getDashboardData } from "@/lib/db/dashboard";
import { getCargoRules, getCommissionRules, getExpenseRules, getSettingsMap } from "@/lib/db/rules";
import { computeProductProfit } from "@/lib/profit";
import { useManualRefresh } from "@/lib/use-refresh";
import { formatCurrency } from "@/lib/format";
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

interface ListItem {
  id: string;
  name: string;
  category: string;
  imageUrl: string | null;
  stock: number;
  madeToOrder: number;
  hasCost: boolean;
  anyLoss: boolean;
  platforms: { platform: Platform; netProfit: number | null }[];
  variantGroupId: string | null;
  variantGroupName: string | null;
  variantLabel: string | null;
}

type Row =
  | { kind: "product"; item: ListItem }
  | { kind: "member"; item: ListItem }
  | { kind: "group"; id: string; name: string; members: ListItem[] };

export default function ProductsScreen() {
  const params = useLocalSearchParams<{ filter?: string }>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleGroup = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    if (params.filter && FILTERS.some((f) => f.key === params.filter)) {
      setFilter(params.filter as FilterKey);
    }
  }, [params.filter]);

  const { data: products, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["dashboard-data"],
    queryFn: getDashboardData,
  });
  const { data: rules } = useQuery({
    queryKey: ["rules"],
    queryFn: async () => ({
      commission: await getCommissionRules(),
      cargo: await getCargoRules(),
      expense: await getExpenseRules(),
    }),
  });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  const { refreshing, onRefresh } = useManualRefresh(refetch);

  const items = useMemo<ListItem[]>(() => {
    if (!products || !rules || !settings) return [];
    return products.map((p) => {
      const profit = computeProductProfit(p, rules, settings);
      return {
        id: p.id,
        name: p.name,
        category: p.categoryName,
        imageUrl: p.imageUrl,
        stock: p.stock,
        madeToOrder: p.madeToOrder,
        hasCost: profit.hasCost,
        anyLoss: profit.platforms.some((pl) => pl.result.netProfit < 0),
        platforms: profit.platforms.map((pl) => ({
          platform: pl.platform,
          netProfit: profit.hasCost ? pl.result.netProfit : null,
        })),
        variantGroupId: p.variantGroupId,
        variantGroupName: p.variantGroupName ?? null,
        variantLabel: p.variantLabel,
      };
    });
  }, [products, rules, settings]);

  const filtered = useMemo(() => {
    let list = items;
    if (filter === "out-of-stock") list = list.filter((i) => i.stock <= 0 && !i.madeToOrder);
    else if (filter === "loss") list = list.filter((i) => i.anyLoss);
    else if (filter === "no-cost") list = list.filter((i) => !i.hasCost);
    const q = search.trim().toLowerCase();
    if (q)
      list = list.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q) ||
          (i.variantGroupName ?? "").toLowerCase().includes(q)
      );
    return list;
  }, [items, filter, search]);

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
      <View style={styles.header}>
        <Text style={styles.title}>Ürünler</Text>
        <Text style={styles.subtitle}>{products ? `${filtered.length} ürün` : "yükleniyor…"}</Text>
      </View>

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
            <Pressable key={f.key} onPress={() => setFilter(f.key)} style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && { color: "#fff", fontWeight: "700" }]}>{f.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
          <Text style={styles.dim}>Turso'dan çekiliyor…</Text>
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Bağlanılamadı</Text>
          <Text style={styles.dim}>{(error as Error)?.message}</Text>
        </View>
      ) : (
        <FlatList
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
            if (index >= 8) return content;
            return (
              <MotiView
                from={{ opacity: 0, translateY: 10 }}
                animate={{ opacity: 1, translateY: 0 }}
                transition={{ type: "timing", duration: 200, delay: index * 18 }}
              >
                {content}
              </MotiView>
            );
          }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ML.accent} />
          }
          ListEmptyComponent={
            <Text style={[styles.dim, { textAlign: "center", marginTop: 40 }]}>Sonuç yok</Text>
          }
          initialNumToRender={10}
          maxToRenderPerBatch={8}
          windowSize={7}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews
        />
      )}
    </SafeAreaView>
  );
}

function ProductCard({ item, member }: { item: ListItem; member?: boolean }) {
  const out = item.stock <= 0;
  return (
    <Pressable
      onPress={() => router.push(`/product/${item.id}`)}
      style={({ pressed }) => [styles.card, member && styles.memberCard, pressed && { backgroundColor: ML.cardElevated }]}
    >
      {item.imageUrl ? (
        <Image source={{ uri: thumbUrl(item.imageUrl, 160)! }} style={styles.thumb} contentFit="cover" transition={150} recyclingKey={item.id} />
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
          <View style={[styles.stockDot, { backgroundColor: out ? ML.red : ML.green }]} />
          <Text style={[styles.stockText, { color: out ? ML.red : ML.textDim }]}>
            {out ? "Bitti" : `${item.stock} adet`}
          </Text>
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
                {pl.netProfit == null ? "—" : formatCurrency(pl.netProfit)}
              </Text>
            </View>
          ))
        ) : (
          <Text style={styles.noCost}>maliyet yok</Text>
        )}
      </View>
    </Pressable>
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
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [styles.card, styles.groupCard, pressed && { backgroundColor: ML.cardElevated }]}
    >
      {img ? (
        <Image source={{ uri: thumbUrl(img, 160)! }} style={styles.thumb} contentFit="cover" transition={150} recyclingKey={row.id} />
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  title: { color: ML.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
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
  list: { paddingHorizontal: 20, paddingBottom: 24, gap: 10 },
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  dim: { color: ML.textDim, fontSize: 14 },
  errorTitle: { color: ML.red, fontSize: 18, fontWeight: "700" },
  groupCard: { backgroundColor: ML.cardElevated },
  groupBadge: { backgroundColor: ML.accentSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  groupBadgeText: { color: ML.accent, fontSize: 11, fontWeight: "700" },
  chevron: { color: ML.textFaint, fontSize: 24, paddingHorizontal: 2 },
  memberCard: { marginLeft: 22 },
});
