import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { MotiView } from "moti";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/form";
import { getNotifications, type AppAlert } from "@/lib/db/notifications";
import { ML, radius } from "@/theme/colors";

export default function NotificationsScreen() {
  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["notifications"],
    queryFn: getNotifications,
    refetchInterval: 60_000,
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Bildirimler" />
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} size="large" />
        </View>
      ) : (
        <FlatList
          data={data?.alerts ?? []}
          keyExtractor={(a) => a.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={ML.accent} />
          }
          renderItem={({ item, index }) => (
            <MotiView
              from={{ opacity: 0, translateY: 10 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={{ type: "timing", duration: 240, delay: Math.min(index, 10) * 22 }}
            >
              <AlertRow alert={item} />
            </MotiView>
          )}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyEmoji}>🎉</Text>
              <Text style={styles.dim}>Yeni bildirim yok</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function AlertRow({ alert }: { alert: AppAlert }) {
  const crit = alert.severity === "critical";
  const color = crit ? ML.red : ML.orange;
  const soft = crit ? ML.redSoft : ML.orangeSoft;
  const icon = alert.type === "stock" ? "shippingbox.fill" : "circle.dashed";
  return (
    <Pressable
      onPress={() => alert.productId && router.push(`/product/${alert.productId}`)}
      style={({ pressed }) => [styles.row, pressed && alert.productId ? { opacity: 0.7 } : null]}
    >
      <View style={[styles.iconWrap, { backgroundColor: soft }]}>
        <SymbolView name={icon} tintColor={color} style={{ width: 20, height: 20 }} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color }]}>{alert.title}</Text>
        <Text style={styles.body} numberOfLines={2}>
          {alert.body}
        </Text>
      </View>
      {alert.productId ? (
        <SymbolView name="chevron.right" tintColor={ML.textFaint} style={{ width: 14, height: 14 }} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingTop: 80 },
  dim: { color: ML.textDim, fontSize: 14 },
  emptyEmoji: { fontSize: 40 },
  list: { padding: 16, gap: 10, paddingBottom: 24 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 14,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 14, fontWeight: "700" },
  body: { color: ML.textDim, fontSize: 13, marginTop: 2 },
});
