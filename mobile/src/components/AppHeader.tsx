import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { PressableScale } from "@/components/ui/PressableScale";
import { getNotifications } from "@/lib/db/notifications";
import { ML, radius, space, type } from "@/theme/colors";

/**
 * SEKME BAŞLIĞI — beş sekmede AYNI hizada, AYNI yükseklikte.
 *
 * NEDEN: her sekme başlığını kendi yazmıştı; başlıklar sekme değiştikçe birkaç piksel
 * zıplıyor, zil yalnız Panel'de duruyordu. Bildirim sayısı en çok Siparişler/Atölye'deyken
 * lazım oluyor (stok bitti, yazıcı hata verdi) — ama kullanıcı bunu görmek için Panel'e
 * dönmek zorundaydı. Artık zil ve rozet HER sekmede.
 */
export function AppHeader({
  title,
  subtitle,
  right,
  bell = true,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Sağdaki ekrana özel düğmeler (zilin SOLUNDA durur). */
  right?: ReactNode;
  /** Zili gizlemek için (kendi bildirim ekranında anlamsız). */
  bell?: boolean;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.textCol}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {typeof subtitle === "string" ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
      </View>
      {right}
      {bell ? <NotificationBell /> : null}
    </View>
  );
}

/**
 * Zil + okunmamış rozeti. Sayı masaüstü ziliyle AYNI kaynaktan (Notification tablosu +
 * anlık stok/filament/yazıcı kuralları) geliyor; kritik varsa kırmızı, yoksa turuncu.
 */
export function NotificationBell() {
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: getNotifications,
    refetchInterval: 60_000,
  });
  const toplam = data?.counts.total ?? 0;
  const kritik = (data?.counts.critical ?? 0) > 0;

  return (
    <PressableScale
      onPress={() => router.push("/notifications" as never)}
      hitSlop={12}
      style={styles.bell}
      accessibilityRole="button"
      accessibilityLabel={toplam > 0 ? `Bildirimler, ${toplam} uyarı` : "Bildirimler"}
    >
      <SymbolView name="bell.fill" size={22} tintColor={toplam > 0 ? ML.text : ML.textDim} />
      {toplam > 0 ? (
        <View style={[styles.badge, { backgroundColor: kritik ? ML.red : ML.orange }]}>
          <Text style={styles.badgeText}>{toplam > 9 ? "9+" : toplam}</Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    minHeight: 56, // sekme değişince başlık zıplamasın
  },
  textCol: { flex: 1 },
  title: { ...type.title, color: ML.text },
  subtitle: { ...type.small, color: ML.textDim, marginTop: 2 },
  bell: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  badge: {
    position: "absolute",
    top: 2,
    right: 2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: ML.bg, // zilin üstünde net dursun
  },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "800" },
});
