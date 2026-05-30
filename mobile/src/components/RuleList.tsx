import { router, type Href } from "expo-router";
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

import { ScreenHeader } from "@/components/form";
import { ML, radius } from "@/theme/colors";

export interface RuleListItem {
  id: string;
  name: string;
  subtitle: string;
  badge?: string;
  isActive: boolean;
}

export function RuleList({
  title,
  note,
  addHref,
  editHrefBase,
  items,
  isLoading,
  onToggle,
}: {
  title: string;
  note: string;
  addHref: Href;
  editHrefBase: string;
  items: RuleListItem[] | undefined;
  isLoading: boolean;
  onToggle: (id: string, active: boolean) => void;
}) {
  return (
    <SafeAreaView style={s.safe} edges={["top"]}>
      <ScreenHeader title={title} onAdd={() => router.push(addHref)} />
      {isLoading ? (
        <View style={s.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.note}>{note}</Text>
          {(items ?? []).map((r) => (
            <Pressable
              key={r.id}
              onPress={() => router.push(`${editHrefBase}/${r.id}` as Href)}
              style={({ pressed }) => [s.card, pressed && { backgroundColor: ML.cardElevated }]}
            >
              <View style={{ flex: 1 }}>
                <View style={s.top}>
                  {r.badge ? (
                    <View style={s.badge}>
                      <Text style={s.badgeText}>{r.badge}</Text>
                    </View>
                  ) : null}
                  <Text style={s.name} numberOfLines={1}>
                    {r.name}
                  </Text>
                </View>
                <Text style={s.subtitle} numberOfLines={1}>
                  {r.subtitle}
                </Text>
              </View>
              <Switch
                value={r.isActive}
                onValueChange={(v) => onToggle(r.id, v)}
                trackColor={{ true: ML.accent, false: ML.border }}
                thumbColor="#fff"
              />
            </Pressable>
          ))}
          {(items ?? []).length === 0 && (
            <Text style={[s.note, { textAlign: "center", marginTop: 40 }]}>
              Henüz kural yok. + Ekle ile oluştur.
            </Text>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
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
  top: { flexDirection: "row", alignItems: "center", gap: 8 },
  badge: { backgroundColor: ML.accentSoft, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { color: ML.accent, fontSize: 11, fontWeight: "700" },
  name: { color: ML.text, fontSize: 16, fontWeight: "600", flex: 1 },
  subtitle: { color: ML.textDim, fontSize: 13, marginTop: 6 },
});
