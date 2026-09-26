import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { Alert, Linking, StyleSheet, View } from "react-native";

import { TELEFON_BILDIRIM_TURLERI, type BildirimTuru } from "@/core/bildirim-turleri";
import { Button, Chip, FadeInView, Tint, Txt } from "@/components/kit";
import {
  pushDurumu,
  pushDurumunaAbone,
  registerForPush,
  telefonTercihiOku,
  telefonTercihiYaz,
  type TelefonTercihi,
} from "@/lib/push";
import { color, space } from "@/theme/tokens";

const TERCIH_ANAHTARI = ["push-tercih"] as const;
const TUR_RENK: Record<BildirimTuru, string> = {
  siparis: color.good,
  "baski-bitti": color.info,
  "baski-sorun": color.warn,
  stok: color.bad,
  filament: color.accentBright,
};

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
      <View style={styles.hazir}>
        <View style={styles.acik} accessibilityRole="text">
          <View style={[styles.nokta, { backgroundColor: color.good }]} />
          <Txt v="small" tone="dim">
            Bildirimler bu telefonda açık
          </Txt>
        </View>
        <TercihCipleri />
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

/**
 * Bu telefona hangi bildirimler gelsin — dokununca açılır/kapanır. Kapatılan tür push olarak
 * gelmez ve listede görünmez (masaüstü Ayarlar'dan da değiştirilebilir). Masaüstü eski
 * sürümse tercih kaydedilemez; çipler hiç çizilmez.
 */
function TercihCipleri() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: TERCIH_ANAHTARI, queryFn: telefonTercihiOku, staleTime: 60_000 });
  const yaz = useMutation({
    mutationFn: (kapali: BildirimTuru[]) => telefonTercihiYaz(kapali),
    onMutate: async (kapali) => {
      await qc.cancelQueries({ queryKey: TERCIH_ANAHTARI });
      const onceki = qc.getQueryData<TelefonTercihi>(TERCIH_ANAHTARI);
      qc.setQueryData<TelefonTercihi>(TERCIH_ANAHTARI, { destek: true, kapali });
      return { onceki };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.onceki) qc.setQueryData(TERCIH_ANAHTARI, ctx.onceki);
      Alert.alert("Kaydedilemedi", e instanceof Error ? e.message : "Bağlantını kontrol et.");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: TERCIH_ANAHTARI });
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  if (!data?.destek) return null;
  const kapali = data.kapali;
  return (
    <FadeInView index={0}>
      <View style={styles.cipler}>
        {TELEFON_BILDIRIM_TURLERI.map((t) => {
          const acik = !kapali.includes(t.anahtar);
          return (
            <Chip
              key={t.anahtar}
              label={t.ad}
              selected={acik}
              dot={acik ? TUR_RENK[t.anahtar] : color.textFaint}
              onPress={() =>
                yaz.mutate(acik ? [...kapali, t.anahtar] : kapali.filter((x) => x !== t.anahtar))
              }
            />
          );
        })}
      </View>
    </FadeInView>
  );
}

const styles = StyleSheet.create({
  hazir: { gap: space.xs, paddingBottom: space.sm },
  cipler: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingHorizontal: space.xs },
  acik: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs, paddingBottom: space.sm },
  nokta: { width: 8, height: 8, borderRadius: 4 },
  kart: { gap: space.sm, marginBottom: space.md, borderColor: color.warn + "66" },
  baslik: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
