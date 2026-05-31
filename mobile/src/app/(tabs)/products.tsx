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
  hasCost: boolean;
  anyLoss: boolean;
  platforms: { platform: "shopify" | "trendyol"; netProfit: number | null }[];
}

export default function ProductsScreen() {
  const params = useLocalSearchParams<{ filter?: string }>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");

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
        hasCost: profit.hasCost,
        anyLoss: profit.platforms.some((pl) => pl.result.netProfit < 0),
        platforms: profit.platforms.map((pl) => ({
          platform: pl.platform,
          netProfit: profit.hasCost ? pl.result.netProfit : null,
        })),
      };
    });
  }, [products, rules, settings]);

  const filtered = useMemo(() => {
    let list = items;
    if (filter === "out-of-stock") list = list.filter((i) => i.stock <= 0);
    else if (filter === "loss") list = list.filter((i) => i.anyLoss);
    else if (filter === "no-cost") list = list.filter((i) => !i.hasCost);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((i) => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));
    return list;
  }, [items, filter, search]);

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
          data={filtered}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.list}
          renderItem={({ item, index }) => (
            <MotiView
              from={{ opacity: 0, translateY: 12 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={{ type: "timing", duration: 260, delay: Math.min(index, 10) * 24 }}
            >
              <ProductCard item={item} />
            </MotiView>
          )}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ML.accent} />
          }
          ListEmptyComponent={
            <Text style={[styles.dim, { textAlign: "center", marginTop: 40 }]}>Sonuç yok</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

function ProductCard({ item }: { item: ListItem }) {
  const out = item.stock <= 0;
  return (
    <Pressable
      onPress={() => router.push(`/product/${item.id}`)}
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: ML.cardElevated }]}
    >
      {item.imageUrl ? (
        <Image source={{ uri: item.imageUrl }} style={styles.thumb} contentFit="cover" transition={150} />
      ) : (
        <View style={[styles.thumb, styles.thumbEmpty]}>
          <Text style={styles.thumbEmptyText}>—</Text>
        </View>
      )}

      <View style={styles.cardBody}>
        <Text style={styles.name} numberOfLines={1}>
          {item.name}
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
                  { backgroundColor: pl.platform === "shopify" ? ML.shopify : ML.trendyol },
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
});
