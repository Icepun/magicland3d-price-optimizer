import { useQuery } from "@tanstack/react-query";
import { router, type Href } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getSettingsMap } from "@/lib/db/rules";
import { ML, radius } from "@/theme/colors";

const NAV: { label: string; href: Href; ready: boolean }[] = [
  { label: "Komisyon Kuralları", href: "/rules/commission", ready: true },
  { label: "Kargo Kuralları", href: "/rules/cargo", ready: true },
  { label: "Ek Gider Kuralları", href: "/rules/expense", ready: true },
];

export default function SettingsScreen() {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });

  const rows: { label: string; value: string }[] = [
    { label: "KDV oranı", value: `%${settings?.vatRate ?? "—"}` },
    { label: "Shopify komisyon", value: `%${settings?.shopifyCommissionRate ?? "3.2"}` },
    { label: "İndirim payı", value: `%${settings?.discountBuffer ?? "0"}` },
    { label: "Elektrik / saat", value: `₺${settings?.costElectricityPerHour ?? "0"}` },
    { label: "İşçilik / saat", value: `₺${settings?.costLaborPerHour ?? "0"}` },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Ayarlar</Text>
        <Text style={styles.subtitle}>Masaüstüyle aynı veritabanı</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <View style={[styles.row, styles.statusRow]}>
            <View style={[styles.dot, { backgroundColor: ML.green }]} />
            <Text style={styles.statusText}>Turso bağlı</Text>
          </View>
        </View>

        <Text style={styles.sectionLabel}>KURALLAR</Text>
        <View style={styles.card}>
          {NAV.map((n, i) => (
            <Pressable
              key={n.label}
              onPress={() => n.ready && router.push(n.href)}
              style={({ pressed }) => [
                styles.row,
                i < NAV.length - 1 && styles.rowBorder,
                pressed && n.ready && { opacity: 0.6 },
              ]}
            >
              <Text style={[styles.rowLabel, !n.ready && { color: ML.textFaint }]}>{n.label}</Text>
              <Text style={[styles.rowValue, { color: n.ready ? ML.accent : ML.textFaint }]}>
                {n.ready ? "›" : "yakında"}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.paramHead}>
          <Text style={styles.sectionLabel}>HESAP PARAMETRELERİ</Text>
          <Pressable onPress={() => router.push("/settings-edit")} hitSlop={8}>
            <Text style={styles.editLink}>Düzenle</Text>
          </Pressable>
        </View>
        <View style={styles.card}>
          {rows.map((r, i) => (
            <View key={r.label} style={[styles.row, i < rows.length - 1 && styles.rowBorder]}>
              <Text style={styles.rowLabel}>{r.label}</Text>
              <Text style={styles.rowValue}>{r.value}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  title: { color: ML.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: ML.textDim, fontSize: 14, marginTop: 2 },
  content: { padding: 16, gap: 8, paddingBottom: 24 },
  card: {
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: ML.borderSoft },
  rowLabel: { color: ML.textDim, fontSize: 15 },
  rowValue: { color: ML.text, fontSize: 15, fontWeight: "700" },
  statusRow: { gap: 10 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  statusText: { color: ML.text, fontSize: 15, fontWeight: "600" },
  sectionLabel: {
    color: ML.textFaint,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    marginTop: 12,
    marginLeft: 4,
    marginBottom: 2,
  },
  paramHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingRight: 4,
  },
  editLink: { color: ML.accent, fontSize: 14, fontWeight: "700" },
  note: { color: ML.textFaint, fontSize: 12, textAlign: "center", marginTop: 16, paddingHorizontal: 20 },
});
