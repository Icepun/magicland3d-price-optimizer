import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { MotiView } from "moti";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getNotifications } from "@/lib/db/notifications";
import { ML, radius } from "@/theme/colors";

interface Item {
  icon: SymbolViewProps["name"];
  title: string;
  subtitle: string;
  href: string;
  tint: string;
  badge?: number;
}

export default function MoreScreen() {
  const { data: notif } = useQuery({
    queryKey: ["notifications"],
    queryFn: getNotifications,
    refetchInterval: 60_000,
  });

  const items: Item[] = [
    {
      icon: "bell.fill",
      title: "Bildirimler",
      subtitle: "Stok & filament uyarıları",
      href: "/notifications",
      tint: ML.accent,
      badge: notif?.counts.total || undefined,
    },
    {
      icon: "circle.dashed",
      title: "Filament Makaralar",
      subtitle: "Makara stok takibi, gram düş",
      href: "/spools",
      tint: ML.green,
    },
    {
      icon: "printer.fill",
      title: "Yazıcılar",
      subtitle: "Canlı baskı durumu",
      href: "/printers",
      tint: ML.orange,
    },
    {
      icon: "list.bullet.clipboard.fill",
      title: "Üretim Planlayıcı",
      subtitle: "Baskı kuyruğu & filament tahmini",
      href: "/planner",
      tint: ML.shopify,
    },
    {
      icon: "gearshape.fill",
      title: "Ayarlar",
      subtitle: "KDV, komisyon, kargo, gider",
      href: "/settings",
      tint: ML.textDim,
    },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Daha</Text>
        <Text style={styles.subtitle}>Araçlar ve ayarlar</Text>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {items.map((it, i) => (
          <MotiView
            key={it.href}
            from={{ opacity: 0, translateY: 10 }}
            animate={{ opacity: 1, translateY: 0 }}
            transition={{ type: "timing", duration: 240, delay: i * 30 }}
          >
            <Pressable
              onPress={() => router.push(it.href as never)}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: ML.cardElevated }]}
            >
              <View style={[styles.iconWrap, { backgroundColor: it.tint + "22" }]}>
                <SymbolView name={it.icon} tintColor={it.tint} style={{ width: 22, height: 22 }} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{it.title}</Text>
                <Text style={styles.rowSub}>{it.subtitle}</Text>
              </View>
              {it.badge ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{it.badge > 9 ? "9+" : it.badge}</Text>
                </View>
              ) : null}
              <SymbolView name="chevron.right" tintColor={ML.textFaint} style={{ width: 14, height: 14 }} />
            </Pressable>
          </MotiView>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  title: { color: ML.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: ML.textDim, fontSize: 14, marginTop: 2 },
  list: { padding: 16, gap: 10 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 14,
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { color: ML.text, fontSize: 15, fontWeight: "700" },
  rowSub: { color: ML.textDim, fontSize: 13, marginTop: 2 },
  badge: {
    backgroundColor: ML.red,
    borderRadius: 999,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "800" },
});
