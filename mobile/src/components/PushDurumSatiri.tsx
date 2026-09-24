import { useSyncExternalStore } from "react";
import { Linking, StyleSheet, View } from "react-native";

import { Button, Tint, Txt } from "@/components/kit";
import { pushDurumu, pushDurumunaAbone, registerForPush } from "@/lib/push";
import { color, space } from "@/theme/tokens";

/**
 * BU TELEFONDA BİLDİRİMLER AÇIK MI — tek satır, gerekirse tek düğme.
 *
 * NEDEN: kayıt modülü durumu biliyordu (izin yok / bağlantı yok / hazır) ama hiçbir ekran
 * göstermiyordu. 23 Eyl 2026: Simay'ın telefonu hiç kaydolmamıştı ve bunu görebileceği bir yer
 * yoktu — bildirim gelmeyince sebep "uygulama bozuk" sanılıyor. İzin kapalıysa iPhone bir daha
 * sormaz; tek çıkış Ayarlar, o yüzden düğme doğrudan oraya götürür.
 */
export function PushDurumSatiri() {
  const durum = useSyncExternalStore(pushDurumunaAbone, pushDurumu);

  // Simülatör/web: gerçek telefon değil, gösterecek bir şey yok.
  if (durum.kod === "cihaz-degil") return null;

  if (durum.kod === "hazir") {
    return (
      <View style={styles.acik} accessibilityRole="text">
        <View style={[styles.nokta, { backgroundColor: color.good }]} />
        <Txt v="small" tone="dim">
          Bildirimler bu telefonda açık
        </Txt>
      </View>
    );
  }

  if (durum.kod === "bilinmiyor") {
    return (
      <View style={styles.acik}>
        <View style={[styles.nokta, { backgroundColor: color.textFaint }]} />
        <Txt v="small" tone="faint">
          {durum.mesaj}
        </Txt>
      </View>
    );
  }

  const ayarlar = durum.ayarlardanIzinGerek;
  return (
    <Tint strong style={styles.kart}>
      <View style={styles.baslik}>
        <View style={[styles.nokta, { backgroundColor: color.warn }]} />
        <Txt v="bodyStrong" style={{ flex: 1 }}>
          Bu telefona bildirim gelmiyor
        </Txt>
      </View>
      <Txt v="small" tone="dim">
        {durum.mesaj}
      </Txt>
      <Button
        label={ayarlar ? "Ayarları aç" : durum.kod === "izin-yok" ? "İzin ver" : "Tekrar dene"}
        icon={ayarlar ? "gearshape.fill" : "arrow.clockwise"}
        size="sm"
        variant="secondary"
        style={{ alignSelf: "flex-start" }}
        onPress={() => {
          if (ayarlar) void Linking.openSettings();
          else void registerForPush(true);
        }}
      />
    </Tint>
  );
}

const styles = StyleSheet.create({
  acik: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs, paddingBottom: space.sm },
  nokta: { width: 8, height: 8, borderRadius: 4 },
  kart: { gap: space.sm, marginBottom: space.md, borderColor: color.warn + "66" },
  baslik: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
