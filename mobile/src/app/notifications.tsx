import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { FadeInView } from "@/components/fade-in";
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
import {
  ackAllNotifications,
  ackNotification,
  getNotifications,
  type AppAlert,
  type NotificationsResult,
} from "@/lib/db/notifications";
import { ML, radius } from "@/theme/colors";

export default function NotificationsScreen() {
  const qc = useQueryClient();
  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["notifications"],
    queryFn: getNotifications,
    refetchInterval: 60_000,
  });

  // Okundu işaretle — optimistic: satır anında düşer; masaüstü zili de aynı tabloyu okuduğundan
  // iki cihazda birden kaybolur. Anlık uyarılar (stok/filament/canlı yazıcı) ack'lenmez.
  const ack = useMutation({
    mutationFn: (id: string) => ackNotification(id),
    onMutate: async (id) => {
      qc.setQueryData<NotificationsResult>(["notifications"], (old) =>
        old ? dropAlert(old, (a) => a.id === id) : old
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const ackAll = useMutation({
    mutationFn: ackAllNotifications,
    onMutate: async () => {
      qc.setQueryData<NotificationsResult>(["notifications"], (old) =>
        old ? dropAlert(old, (a) => a.persistent) : old
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const hasPersistent = (data?.alerts ?? []).some((a) => a.persistent);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Bildirimler" />
      {hasPersistent ? (
        <Pressable
          onPress={() => ackAll.mutate()}
          style={({ pressed }) => [styles.ackAll, pressed && { opacity: 0.6 }]}
        >
          <SymbolView name="checkmark.circle" tintColor={ML.accent} style={{ width: 15, height: 15 }} />
          <Text style={styles.ackAllText}>Tümünü okundu işaretle</Text>
        </Pressable>
      ) : null}
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
            <FadeInView index={index}>
              <AlertRow alert={item} onAck={item.persistent ? () => ack.mutate(item.id) : null} />
            </FadeInView>
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

function dropAlert(old: NotificationsResult, drop: (a: AppAlert) => boolean): NotificationsResult {
  const alerts = old.alerts.filter((a) => !drop(a));
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const success = alerts.filter((a) => a.severity === "success").length;
  return { alerts, counts: { total: alerts.length, critical, warning: alerts.length - critical - success } };
}

function fmtAgo(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1) return "az önce";
  if (m < 60) return `${m} dk önce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa önce`;
  return `${Math.floor(h / 24)} gün önce`;
}

function AlertRow({ alert, onAck }: { alert: AppAlert; onAck: (() => void) | null }) {
  const crit = alert.severity === "critical";
  const ok = alert.severity === "success";
  const color = crit ? ML.red : ok ? ML.green : ML.orange; // başarı (baskı bitti) → YEŞİL
  const soft = crit ? ML.redSoft : ok ? ML.greenSoft : ML.orangeSoft;
  const icon =
    alert.type === "stock" || alert.type === "order"
      ? "shippingbox.fill"
      : alert.type === "print"
        ? "printer.fill"
        : "circle.dashed";
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
        {alert.createdAt ? <Text style={styles.time}>{fmtAgo(alert.createdAt)}</Text> : null}
      </View>
      {onAck ? (
        <Pressable
          onPress={onAck}
          hitSlop={10}
          style={({ pressed }) => [styles.ackBtn, pressed && { backgroundColor: ML.cardElevated }]}
        >
          <SymbolView name="xmark" tintColor={ML.textFaint} style={{ width: 13, height: 13 }} />
        </Pressable>
      ) : alert.productId ? (
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
  ackAll: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-end",
    marginRight: 16,
    marginBottom: 2,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ML.border,
    backgroundColor: ML.card,
  },
  ackAllText: { color: ML.accent, fontSize: 12.5, fontWeight: "700" },
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
  time: { color: ML.textFaint, fontSize: 11, marginTop: 3 },
  ackBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: ML.border,
  },
});
