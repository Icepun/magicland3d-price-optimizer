import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import type { ReactNode } from "react";
import { Alert, FlatList, RefreshControl, StyleSheet, View } from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";

import { EmptyState, ErrorState, FadeInView, IconButton, Screen, ShimmerList, SubHeader, Tint, Txt } from "@/components/kit";
import { PressableScale } from "@/components/kit/PressableScale";
import { PushDurumSatiri } from "@/components/PushDurumSatiri";
import { bildirimleriKapat, getNotifications, type AppAlert, type NotificationsResult } from "@/lib/db/notifications";
import { formatNumber } from "@/lib/format";
import { color, radius, space } from "@/theme/tokens";

/**
 * BİLDİRİMLER — masaüstü ziliyle aynı tablo + anlık kurallar. Satıra dokununca ilgili ekrana
 * gider (stok→ürün, filament→makaralar, baskı→yazıcılar).
 *
 * KAPATMA: her uyarı sola kaydırılarak ya da ✕ ile kapanır, başlıkta "Tümünü temizle" var.
 * Kalıcılar veritabanında okundu (masaüstüyle ortak); anlık uyarılar (stok, filament, yazıcı)
 * metniyle gizlenir ve durum değişince geri gelir — eskiden bunlar hiç kapatılamıyordu ve zil
 * hep doluydu. İşlem iyimser: satır hemen düşer, hata olursa liste yeniden çekilir.
 */
export default function NotificationsScreen() {
  const qc = useQueryClient();
  const { data, isLoading, refetch, isRefetching, error, isFetching } = useQuery({
    queryKey: ["notifications"],
    queryFn: getNotifications,
    refetchInterval: 60_000,
  });

  const kapat = useMutation({
    mutationFn: (kapatilacak: AppAlert[]) => bildirimleriKapat(kapatilacak, data?.anlikKimlikler ?? []),
    onMutate: async (kapatilacak) => {
      await qc.cancelQueries({ queryKey: ["notifications"] });
      const idler = new Set(kapatilacak.map((a) => a.id));
      qc.setQueryData<NotificationsResult>(["notifications"], (old) => (old ? dropAlert(old, (a) => idler.has(a.id)) : old));
    },
    onError: () => Alert.alert("Kapatılamadı", "Bağlantı sorunu — bildirimler geri getirildi."),
    onSettled: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const alerts = data?.alerts ?? [];
  const kritik = data?.counts.critical ?? 0;

  const tumunuTemizle = () =>
    Alert.alert("Tümünü temizle", `${alerts.length} bildirim kapatılsın mı? Durumu değişen uyarılar yeniden görünür.`, [
      { text: "Vazgeç", style: "cancel" },
      { text: "Temizle", style: "destructive", onPress: () => kapat.mutate(alerts) },
    ]);

  return (
    <Screen
      scroll={false}
      padded={false}
      header={
        <SubHeader
          title="Bildirimler"
          subtitle={data ? (alerts.length ? `${formatNumber(alerts.length)} uyarı${kritik ? ` · ${kritik} kritik` : ""}` : "yeni bildirim yok") : undefined}
          right={
            alerts.length > 0 ? (
              <IconButton icon="trash" onPress={tumunuTemizle} accessibilityLabel="Tümünü temizle" />
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
          <PushDurumSatiri />
          <ShimmerList count={5} height={84} />
        </View>
      ) : (
        <FlatList
          data={alerts}
          // Aynı id iki kez gelebiliyor (kalıcı + anlık uyarı çakışması) → sıra eklenerek tekil.
          keyExtractor={(a, i) => `${a.id}:${i}`}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={color.accentBright} />}
          // Bu telefonda bildirim açık mı — gelmiyorsa sebebi ve tek dokunuşluk çözüm burada.
          ListHeaderComponent={<PushDurumSatiri />}
          renderItem={({ item, index }) => (
            <FadeInView index={index}>
              <SilinirSatir onSil={() => kapat.mutate([item])}>
                <AlertRow alert={item} onAck={() => kapat.mutate([item])} />
              </SilinirSatir>
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
  return { ...old, alerts, counts: { total: alerts.length, critical, warning: alerts.length - critical - success } };
}

/** Sola kaydırınca kırmızı "Sil" belirir; eşiği geçip bırakınca bildirim kapanır. */
function SilinirSatir({ onSil, children }: { onSil: () => void; children: ReactNode }) {
  return (
    <ReanimatedSwipeable
      friction={1.6}
      rightThreshold={72}
      overshootRight={false}
      onSwipeableOpen={onSil}
      renderRightActions={() => (
        <View style={styles.silAlan} accessibilityElementsHidden>
          <SymbolView name="trash.fill" tintColor={color.onAccent} style={{ width: 18, height: 18 }} />
          <Txt v="label" style={{ color: color.onAccent }}>
            Sil
          </Txt>
        </View>
      )}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

function fmtAgo(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1) return "az önce";
  if (m < 60) return `${m} dk önce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa önce`;
  return `${Math.floor(h / 24)} gün önce`;
}

function AlertRow({ alert, onAck }: { alert: AppAlert; onAck: () => void }) {
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
      <PressableScale onPress={onAck} hitSlop={10} haptic="hafif" style={styles.ackBtn} accessibilityRole="button" accessibilityLabel="Bildirimi kapat">
        <SymbolView name="xmark" tintColor={color.textFaint} style={{ width: 12, height: 12 }} />
      </PressableScale>
    </Tint>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.lg },
  silAlan: {
    width: 88,
    marginLeft: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.bad,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
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
