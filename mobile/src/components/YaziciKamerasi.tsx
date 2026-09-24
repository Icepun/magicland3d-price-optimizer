import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useFocusEffect } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Txt } from "@/components/kit";
import { KAMERA_KARE_BAYAT_MS, KAMERA_YENILEME_MS, kareCanliMi } from "@core/printer-camera";
import { kameraBirak, kameraDurumu, kameraIste, relayYetenekleri } from "@/lib/db/printers";
import { color, radius, space } from "@/theme/tokens";

/** Masaüstü bu sürede sahiplenmezse "yanıt vermiyor" denir (döngü 3 sn + kamera uyanışı ~2 sn). */
const SAHIPSIZ_UYARI_MS = 15_000;
/** Satır bu sıklıkla okunur — yeni kare ~1,5-2,5 sn'de bir geliyor. */
const OKUMA_MS = 1500;
/** Tam ekranda en fazla yakınlaştırma (kare ~1280 px; daha fazlası yalnız bulanıklaştırır). */
const ENCOK_YAKINLIK = 4;

function yasMetni(ms: number): string {
  const sn = Math.max(0, Math.round(ms / 1000));
  return sn < 60 ? `${sn} sn önce` : `${Math.floor(sn / 60)} dk önce`;
}

/**
 * YAZICI KAMERASI — telefon yazıcıya ulaşamadığı için görüntüyü LAN'daki masaüstü taşır
 * (sözleşme `@core/printer-camera`, gönderen `src/core/printers/camera-relay.ts`).
 *
 * Kamera YALNIZ bu görünüm ekranda ve uygulama öndeyken istenir: ekrandan çıkınca ya da
 * uygulama arka plana düşünce istek bırakılır, masaüstü birkaç saniyede kamerayı kapatır
 * (yazıcıya gereksiz yük binmesin — masaüstü kamera modüllerinin ana kuralı).
 *
 * Kare değişince eski görüntü, yenisi inene dek ekranda kalır: `expo-image` aynı
 * `recyclingKey`'le kaynak değişiminde içeriği boşaltmıyor → titreme yok.
 */
export function YaziciKamerasi({ yaziciId, yaziciAdi }: { yaziciId: string; yaziciAdi: string }) {
  const [odakta, setOdakta] = useState(false);
  const [onde, setOnde] = useState(AppState.currentState === "active");
  // Bu izleme oturumunun başladığı an — "yanıt vermiyor" süresi ve eski karenin ayıklanması için.
  const [acilis, setAcilis] = useState(() => Date.now());
  const [simdi, setSimdi] = useState(() => Date.now());
  const [tamEkran, setTamEkran] = useState(false);
  const calisiyor = odakta && onde;

  useFocusEffect(
    useCallback(() => {
      setOdakta(true);
      setAcilis(Date.now());
      return () => setOdakta(false);
    }, [])
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (d) => {
      const aktif = d === "active";
      setOnde(aktif);
      if (aktif) setAcilis(Date.now());
    });
    return () => sub.remove();
  }, []);

  // İstek: çalışırken hemen yeni istek, sonra süre dolmadan tazele; durunca hemen bırak.
  useEffect(() => {
    if (!calisiyor) return;
    void kameraIste(yaziciId, true).catch(() => {});
    const t = setInterval(() => void kameraIste(yaziciId, false).catch(() => {}), KAMERA_YENILEME_MS);
    return () => {
      clearInterval(t);
      void kameraBirak(yaziciId).catch(() => {});
    };
  }, [calisiyor, yaziciId]);

  useEffect(() => {
    if (!calisiyor) return;
    const t = setInterval(() => setSimdi(Date.now()), 1000);
    return () => clearInterval(t);
  }, [calisiyor]);

  const { data: durum, error: okumaHatasi } = useQuery({
    queryKey: ["printer-camera", yaziciId],
    queryFn: () => kameraDurumu(yaziciId),
    enabled: calisiyor,
    refetchInterval: calisiyor ? OKUMA_MS : false,
    gcTime: 0,
  });
  const { data: yetenekler } = useQuery({
    queryKey: ["relay-caps"],
    queryFn: relayYetenekleri,
    staleTime: 5 * 60_000,
  });

  const tekrarDene = () => {
    setAcilis(Date.now());
    void kameraIste(yaziciId, true).catch(() => {});
  };

  // Başka bir telefon zaten izliyorsa süren oturumun taze karesi de kabul (açılıştan biraz eski).
  const kare =
    durum?.frameUrl && durum.frameAtMs != null && durum.frameAtMs >= acilis - KAMERA_KARE_BAYAT_MS
      ? durum.frameUrl
      : null;
  const canli = kareCanliMi(durum?.frameAtMs, simdi);
  const hata = !kare && simdi - acilis > 2000 ? durum?.error ?? null : null;
  const tabloYok = /no such table/i.test(okumaHatasi instanceof Error ? okumaHatasi.message : "");
  const uzunBekleme = !kare && !hata && !durum?.owner && simdi - acilis > SAHIPSIZ_UYARI_MS;
  const eskiMasaustu = tabloYok || (uzunBekleme && !!yetenekler && !yetenekler.includes("camera"));

  let ortaMesaj: { ikon: "video.slash.fill" | "desktopcomputer" | null; metin: string } | null = null;
  if (!kare) {
    if (hata) ortaMesaj = { ikon: "video.slash.fill", metin: hata };
    else if (eskiMasaustu)
      ortaMesaj = { ikon: "desktopcomputer", metin: "Kamera için masaüstü uygulamasını güncelle (v0.19.232 ya da yenisi)." };
    else if (uzunBekleme)
      ortaMesaj = { ikon: "desktopcomputer", metin: "Masaüstü yanıt vermiyor — uygulama açık ve yazıcıyla aynı ağda mı?" };
  }

  const goruntu = kare ? (
    <Image
      source={{ uri: kare }}
      style={StyleSheet.absoluteFill}
      contentFit="contain"
      transition={0}
      cachePolicy="none"
      recyclingKey={yaziciId}
      accessibilityLabel={`${yaziciAdi} kamera görüntüsü`}
    />
  ) : null;

  const rozet = kare ? (
    <View style={styles.rozet}>
      <View style={[styles.nokta, { backgroundColor: canli ? color.bad : color.warn }]} />
      <Txt v="label" style={{ color: color.text }} num>
        {canli ? "CANLI" : `DONMUŞ · ${yasMetni(simdi - (durum?.frameAtMs ?? simdi))}`}
      </Txt>
    </View>
  ) : null;

  return (
    <>
      <Pressable
        style={styles.kutu}
        onPress={kare ? () => setTamEkran(true) : undefined}
        accessibilityRole={kare ? "button" : undefined}
        accessibilityLabel={kare ? `${yaziciAdi} kamerası, tam ekran açar` : `${yaziciAdi} kamerası`}
      >
        {goruntu}
        {!kare ? (
          <View style={styles.orta}>
            {ortaMesaj ? (
              <>
                {ortaMesaj.ikon ? (
                  <SymbolView name={ortaMesaj.ikon} tintColor={color.textDim} style={{ width: 28, height: 28 }} />
                ) : null}
                <Txt v="small" tone="dim" style={styles.ortaMetin}>
                  {ortaMesaj.metin}
                </Txt>
                {hata || uzunBekleme ? (
                  <Button label="Tekrar dene" icon="arrow.clockwise" size="sm" variant="secondary" onPress={tekrarDene} />
                ) : null}
              </>
            ) : (
              <>
                <ActivityIndicator color={color.textDim} />
                <Txt v="small" tone="dim" style={styles.ortaMetin}>
                  Kamera açılıyor — masaüstü görüntüyü getiriyor…
                </Txt>
              </>
            )}
          </View>
        ) : null}
        {rozet}
        {kare ? (
          <View style={styles.buyut}>
            <SymbolView name="arrow.up.left.and.arrow.down.right" tintColor={color.text} style={{ width: 14, height: 14 }} />
          </View>
        ) : null}
      </Pressable>

      <Modal
        visible={tamEkran}
        animationType="fade"
        presentationStyle="fullScreen"
        onRequestClose={() => setTamEkran(false)}
      >
        {tamEkran ? (
          <TamEkranKamera kare={kare} yaziciAdi={yaziciAdi} rozet={rozet} onKapat={() => setTamEkran(false)} />
        ) : null}
      </Modal>
    </>
  );
}

/**
 * TAM EKRAN — uygulama dikey kilitli (app.json) ve yön kilidini açacak yerel modül derlemede
 * yok; 16:9 görüntü dik telefonda ekranın üçte birini kaplıyordu. Görüntü varsayılan olarak
 * 90° döndürülüp tüm ekrana yayılır (telefon yan tutulur); düğmeyle dik görünüme dönülür.
 * İki parmakla yakınlaştır, yakınken sürükle, çift dokunuşla yakınlaş/sıfırla — nozülü ya da
 * tabladaki sorunu ayrıntılı görebilmek için.
 */
function TamEkranKamera({
  kare,
  yaziciAdi,
  rozet,
  onKapat,
}: {
  kare: string | null;
  yaziciAdi: string;
  rozet: ReactNode;
  onKapat: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width: G, height: Y } = useWindowDimensions();
  const [yatay, setYatay] = useState(true);

  const olcek = useSharedValue(1);
  const baslangicOlcek = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const baslangicX = useSharedValue(0);
  const baslangicY = useSharedValue(0);

  const sifirla = () => {
    olcek.value = withTiming(1);
    x.value = withTiming(0);
    y.value = withTiming(0);
  };

  const kistir = Gesture.Pinch()
    .onStart(() => {
      baslangicOlcek.value = olcek.value;
    })
    .onUpdate((e) => {
      olcek.value = Math.min(ENCOK_YAKINLIK, Math.max(1, baslangicOlcek.value * e.scale));
    })
    .onEnd(() => {
      if (olcek.value <= 1.02) {
        olcek.value = withTiming(1);
        x.value = withTiming(0);
        y.value = withTiming(0);
      }
    });
  const surukle = Gesture.Pan()
    .onStart(() => {
      baslangicX.value = x.value;
      baslangicY.value = y.value;
    })
    .onUpdate((e) => {
      if (olcek.value <= 1) return;
      x.value = baslangicX.value + e.translationX;
      y.value = baslangicY.value + e.translationY;
    });
  const ciftDokunus = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const yakin = olcek.value > 1.02;
      olcek.value = withTiming(yakin ? 1 : 2.5);
      x.value = withTiming(0);
      y.value = withTiming(0);
    });
  const hareket = Gesture.Simultaneous(kistir, surukle, ciftDokunus);
  const yakinlikStili = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: olcek.value }],
  }));

  // Döndürülmüş kutu: genişlik = ekran yüksekliği, yükseklik = ekran genişliği, merkezde 90°.
  const kutu = yatay
    ? { width: Y, height: G, left: (G - Y) / 2, top: (Y - G) / 2, transform: [{ rotate: "90deg" }] }
    : { width: G, height: Y, left: 0, top: 0 };

  return (
    <GestureHandlerRootView style={styles.tamEkran}>
      <GestureDetector gesture={hareket}>
        <Animated.View style={[styles.tamAlan, yakinlikStili]}>
          {kare ? (
            <Image
              source={{ uri: kare }}
              style={[styles.tamGorsel, kutu]}
              contentFit="contain"
              transition={0}
              cachePolicy="none"
              recyclingKey="tam-ekran"
              accessibilityLabel={`${yaziciAdi} kamera görüntüsü, tam ekran`}
            />
          ) : null}
        </Animated.View>
      </GestureDetector>
      <View style={[styles.tamUst, { top: insets.top + space.sm }]} pointerEvents="box-none">
        {rozet}
        <View style={styles.tamDugmeler}>
          <Pressable
            onPress={() => {
              sifirla();
              setYatay((v) => !v);
            }}
            style={styles.kapat}
            accessibilityRole="button"
            accessibilityLabel={yatay ? "Dik görünüme dön" : "Yatay görünüme döndür"}
            hitSlop={8}
          >
            <SymbolView name="rotate.right" tintColor={color.text} style={{ width: 18, height: 18 }} />
          </Pressable>
          <Pressable
            onPress={onKapat}
            style={styles.kapat}
            accessibilityRole="button"
            accessibilityLabel="Tam ekranı kapat"
            hitSlop={8}
          >
            <SymbolView name="xmark" tintColor={color.text} style={{ width: 16, height: 16 }} />
          </Pressable>
        </View>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  kutu: {
    width: "100%",
    aspectRatio: 16 / 9,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  orta: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    padding: space.lg,
  },
  ortaMetin: { textAlign: "center" },
  rozet: {
    position: "absolute",
    left: space.sm,
    top: space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  nokta: { width: 7, height: 7, borderRadius: 4 },
  buyut: {
    position: "absolute",
    right: space.sm,
    bottom: space.sm,
    padding: 7,
    borderRadius: radius.pill,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  tamEkran: { flex: 1, backgroundColor: "#000" },
  tamAlan: { flex: 1, overflow: "hidden" },
  tamGorsel: { position: "absolute" },
  tamDugmeler: { marginLeft: "auto", flexDirection: "row", gap: space.sm },
  tamUst: {
    position: "absolute",
    left: space.md,
    right: space.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  kapat: {
    padding: 10,
    borderRadius: radius.pill,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
});
