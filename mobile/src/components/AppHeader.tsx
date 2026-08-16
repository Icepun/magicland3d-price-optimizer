import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { FreshnessStamp } from "@/components/FreshnessStamp";
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
  updatedAt,
}: {
  title: string;
  subtitle?: ReactNode;
  /**
   * Ekrandaki ana verinin çekilme anı (React Query `dataUpdatedAt`).
   * ÇEVRİMDIŞI ÖNBELLEK açıldığından beri ekranda BAYAT veri olabiliyor; damga bunu söyler.
   * Sessizce eski rakam göstermek, hiç göstermemekten daha tehlikeli.
   */
  updatedAt?: number;
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
        {/* Alt başlık ve tazelik damgası AYNI SATIRDA: damga kendi satırını alsaydı başlık üç
            satır olur, gövde aşağı kayar ve her sekme birden uzardı. */}
        <View style={styles.subRow}>
          {typeof subtitle === "string" ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )}
          {updatedAt ? (
            <>
              <Text style={styles.ayrac}>·</Text>
              <FreshnessStamp updatedAt={updatedAt} />
            </>
          ) : null}
        </View>
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
  /**
   * ⚠️ ÖLÇÜLER SEKMELERİN ESKİ BAŞLIĞIYLA AYNI (20 / 8 / 4).
   * Bir tur boyunca ölçek jetonlarına (space.lg = 16, space.md = 12) bağlıydı: başlık içeriden
   * başlıyor, altındaki listeyle hizası kayıyor ve gövde 8px aşağı itiliyordu. Jeton "daha
   * düzenli" diye var olan tasarımı değiştirmek için bahane değil.
   */
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  textCol: { flex: 1 },
  title: { ...type.title, color: ML.text },
  // 14 — type.small (13) değil: sekme alt başlıkları hep 14'tü.
  subtitle: { color: ML.textDim, fontSize: 14 },
  subRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  ayrac: { color: ML.textFaint, fontSize: 12 },
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
