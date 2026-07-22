import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  getAllExpenseRules,
  setExpenseRuleActive,
  type ExpenseRuleFull,
} from "@/lib/db/rule-crud";
import { ML, radius } from "@/theme/colors";

const TYPE_LABEL: Record<string, string> = {
  fixed: "Sabit (TL)",
  percentage: "Yüzdesel (%)",
  per_order: "Sipariş Başına (TL)",
};

function platformLabel(p: string | null): string {
  if (!p) return "Tümü";
  if (p === "shopify") return "Shopify";
  if (p === "trendyol") return "Trendyol";
  if (p === "hepsiburada") return "Hepsiburada";
  return p;
}

function valueLabel(r: ExpenseRuleFull): string {
  if (r.type === "percentage") return `%${(r.value * 100).toFixed(2)}`;
  return `₺${r.value.toFixed(2)}`;
}

export default function ExpenseRulesScreen() {
  const qc = useQueryClient();
  const { data: rules, isLoading } = useQuery({
    queryKey: ["expense-rules-all"],
    queryFn: getAllExpenseRules,
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      setExpenseRuleActive(id, active),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expense-rules-all"] });
      qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Ek Gider Kuralları</Text>
        <Pressable onPress={() => router.push("/rules/expense-edit/new")} hitSlop={12}>
          <Text style={styles.add}>+ Ekle</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.note}>
            Komisyon ve kargo dışındaki giderler (KDV, platform bedeli, kampanya vb.).
          </Text>
          {(rules ?? []).map((r) => (
            <Pressable
              key={r.id}
              onPress={() => router.push(`/rules/expense-edit/${r.id}`)}
              style={({ pressed }) => [styles.card, pressed && { backgroundColor: ML.cardElevated }]}
            >
              <View style={{ flex: 1 }}>
                <View style={styles.cardTop}>
                  <View style={styles.platformBadge}>
                    <Text style={styles.platformText}>{platformLabel(r.platform)}</Text>
                  </View>
                  <Text style={styles.ruleName} numberOfLines={1}>
                    {r.name}
                  </Text>
                </View>
                <Text style={styles.ruleMeta}>
                  {TYPE_LABEL[r.type]} · {valueLabel(r)}
                </Text>
              </View>
              <Switch
                value={!!r.isActive}
                onValueChange={(v) => toggle.mutate({ id: r.id, active: v })}
                trackColor={{ true: ML.accent, false: ML.border }}
                thumbColor="#fff"
              />
            </Pressable>
          ))}
          {(rules ?? []).length === 0 && (
            <Text style={[styles.note, { textAlign: "center", marginTop: 40 }]}>
              Henüz kural yok. + Ekle ile oluştur.
            </Text>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, height: 48 },
  back: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  backText: { color: ML.text, fontSize: 34, marginTop: -4 },
  headerTitle: { flex: 1, color: ML.text, fontSize: 17, fontWeight: "700", textAlign: "center" },
  add: { color: ML.accent, fontSize: 16, fontWeight: "700" },
  content: { padding: 16, gap: 10 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  note: { color: ML.textFaint, fontSize: 13, paddingHorizontal: 4, marginBottom: 4 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 16,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  platformBadge: {
    backgroundColor: ML.accentSoft,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  platformText: { color: ML.accent, fontSize: 11, fontWeight: "700" },
  ruleName: { color: ML.text, fontSize: 16, fontWeight: "600", flex: 1 },
  ruleMeta: { color: ML.textDim, fontSize: 13, marginTop: 6 },
});
