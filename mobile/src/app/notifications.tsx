import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";

import { EmptyState, ErrorState, FadeInView, IconButton, Screen, ShimmerList, SubHeader, Tint, Txt } from "@/components/kit";
import { PressableScale } from "@/components/kit/PressableScale";
import { ackAllNotifications, ackNotification, getNotifications, type AppAlert, type NotificationsResult } from "@/lib/db/notifications";
import { formatNumber } from "@/lib/format";
import { color, radius, space } from "@/theme/tokens";

/**
 * BİLDİRİMLER — masaüstü ziliyle aynı tablo + anlık kurallar. Okundu işaretleme iyimser;
 * satıra dokununca ilgili ekrana gider (stok→ürün, filament→makaralar, baskı→yazıcılar).
 */
export default function NotificationsScreen() {
  const qc = useQueryClient();
  const { data, isLoading, refetch, isRefetching, error, isFetching } = useQuery({
    queryKey: ["notifications"],
    queryFn: getNotifications,
    refetchInterval: 60_000,
  });

  const ack = useMutation({
    mutationFn: (id: string) => ackNotification(id),
    onMutate: async (id) => {
      qc.setQueryData<NotificationsResult>(["notifications"], (old) => (old ? dropAlert(old, (a) => a.id === id) : old));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const ackAll = useMutation({
    mutationFn: ackAllNotifications,
    onMutate: async () => {
      qc.setQueryData<NotificationsResult>(["notifications"], (old) => (old ? dropAlert(old, (a) => a.persistent) : old));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const alerts = data?.alerts ?? [];
  const hasPersistent = alerts.some((a) => a.persistent);
  const kritik = data?.counts.critical ?? 0;

  return (
    <Screen
      scroll={false}
      padded={false}
      header={
        <SubHeader
          title="Bildirimler"
          subtitle={data ? (alerts.length ? `${formatNumber(alerts.length)} uyarı${kritik ? ` · ${kritik} kritik` : ""}` : "yeni bildirim yok") : undefined}
          right={
            hasPersistent ? (
              <IconButton icon="checkmark.circle" onPress={() => ackAll.mutate()} accessibilityLabel="Tümünü okundu işaretle" />
            ) : undefined
          }
        />
      }
    >
      {error && !data ? (
        <View style={styles.pad}>
          <ErrorState error={error} onRetry={() => void refetch()} retrying={isFetching} />
        </View>
      ) : isLoading ? (
        <View style={styles.pad}>
          <ShimmerList count={5} height={84} />
        </View>
      ) : (
        <FlatList
          data={alerts}
          // Aynı id iki kez gelebiliyor (kalıcı + anlık uyarı çakışması) → sıra eklenerek tekil.
          keyExtractor={(a, i) => `${a.id}:${i}`}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={color.accentBright} />}
          renderItem={({ item, index }) => (
            <FadeInView index={index}>
              <AlertRow alert={item} onAck={item.persistent ? () => ack.mutate(item.id) : null} />
            </FadeInView>
          )}
          ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
          ListEmptyComponent={<EmptyState icon="bell.slash" title="Yeni bildirim yok" hint="Stok, filament ve yazıcı uyarıları burada görünür." />}
        />
      )}
    </Screen>
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
  const renk = crit ? color.bad : ok ? color.good : color.warn;
  // Kalıcı bildirimlerde tür masaüstünden geliyor; başlık "Filament/makara" diyorsa makara ikonu.
  const filament = alert.type === "filament" || /filament|makara/i.test(alert.title);
  const icon: SymbolViewProps["name"] = filament
    ? "circle.grid.cross.fill"
    : alert.type === "print"
      ? "printer.fill"
      : alert.type === "stock" || alert.type === "order"
        ? "shippingbox.fill"
        : "circle.dashed";
  return (
    <Tint
      strong
      onPress={alert.route ? () => router.push(alert.route as never) : undefined}
      style={styles.row}
      accessibilityLabel={alert.title}
    >
      <View style={[styles.iconWrap, { backgroundColor: renk + "26" }]}>
        <SymbolView name={icon} tintColor={renk} style={{ width: 20, height: 20 }} />
      </View>
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Txt v="bodyStrong" style={{ color: renk }} numberOfLines={1}>
          {alert.title}
        </Txt>
        <Txt v="small" tone="dim" numberOfLines={2}>
          {alert.body}
        </Txt>
        {alert.createdAt ? (
          <Txt v="label" tone="faint">
            {fmtAgo(alert.createdAt)}
          </Txt>
        ) : null}
      </View>
      {onAck ? (
        <PressableScale onPress={onAck} hitSlop={10} haptic="hafif" style={styles.ackBtn} accessibilityRole="button" accessibilityLabel="Okundu işaretle">
          <SymbolView name="xmark" tintColor={color.textFaint} style={{ width: 12, height: 12 }} />
        </PressableScale>
      ) : alert.route ? (
        <SymbolView name="chevron.right" tintColor={color.textFaint} style={{ width: 14, height: 14 }} />
      ) : null}
    </Tint>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.lg },
  list: { paddingHorizontal: space.lg, paddingBottom: space.xxl },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  iconWrap: { width: 40, height: 40, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  ackBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    backgroundColor: color.tint,
  },
});
