// ⚠️ Ağırlıklar TEK TEK alt paketten: paketin kökü 14 dosyanın hepsini require ediyor ve
// export'ta kullanılmayan 10 font (~0,9 MB) her OTA paketine biniyordu. Alt yol yalnız o dosyayı taşır.
import { PlusJakartaSans_500Medium } from "@expo-google-fonts/plus-jakarta-sans/500Medium";
import { PlusJakartaSans_600SemiBold } from "@expo-google-fonts/plus-jakarta-sans/600SemiBold";
import { PlusJakartaSans_700Bold } from "@expo-google-fonts/plus-jakarta-sans/700Bold";
import { PlusJakartaSans_800ExtraBold } from "@expo-google-fonts/plus-jakarta-sans/800ExtraBold";
import { useFonts } from "expo-font";
import { useQueryClient } from "@tanstack/react-query";
// Tema sağlayıcı expo-router'dan: SDK 56'da React Navigation paketin içine gömülü,
// `@react-navigation/native` ayrı bir modül olarak ÇÖZÜLMEZ.
import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { AppQueryProvider } from "@/lib/query";
import { Backdrop } from "@/components/kit/Backdrop";
import { UpdateGate } from "@/components/UpdateGate";
import { getDashboardData } from "@/lib/db/dashboard";
import { syncFinanceFromCache } from "@/lib/finance-sync";
import { startPushRegistration } from "@/lib/push";
import { color } from "@/theme/tokens";

/**
 * NAVİGASYON TEMASI — zemin ŞEFFAF.
 *
 * expo-router varsayılan olarak React Navigation'ın AÇIK temasını kullanıyor; sekme gezgini
 * her sahneyi, yığın gezgini her kartı bu temanın zemin rengiyle (kirli beyaz) boyuyor. Ekranlar
 * opak zeminini bıraktığı anda altından o beyaz çıktı. Zemin artık kökte tek katman
 * (kit/Backdrop); gezginler onu örtmesin diye tema zemini şeffaf, kalan renkler bizim paletten.
 */
const NAV_THEME = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: "transparent",
    card: color.glassStrong,
    text: color.text,
    border: color.line,
    primary: color.accent,
    notification: color.bad,
  },
} as const;

// Splash'i BİZ kapatana kadar açık tut (expo otomatik gizleyip boş ekran flaşı yaratmasın) + yumuşak fade.
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ duration: 300, fade: true });

/**
 * Açılış ekranı DÜRÜST (masaüstü v0.19.70 ile aynı mantık): sabit timer yerine panel verisi
 * (["dashboard-data"] sorgusu) GERÇEKTEN gelince kapanır. Hızlı açılışta erken kapanır (bekletmez),
 * yavaş açılışta veri gelene kadar durur (iskelet/boş flaş yok). MIN 400ms (logo flaş etmesin) +
 * MAX 6sn fail-safe (asılı kalmaz). Prefetch aynı queryKey'i ısıttığı için Panel veriyi anında bulur.
 *
 * FONT da beklenir: yazı tipi yüklenmeden ilk kare sistem fontuyla çizilip sonra Jakarta'ya
 * atlıyordu (metin genişlikleri değişince düzen zıplar). Font yüklenemezse (çok nadir) 6 sn
 * fail-safe yine kapatır; uygulama sistem fontuyla açılır, asla asılı kalmaz.
 */
function SplashGate({ fontsReady }: { fontsReady: boolean }) {
  const qc = useQueryClient();
  const [dataReady, setDataReady] = useState(false);
  const [zamanAsimi, setZamanAsimi] = useState(false);
  const [basladi] = useState(() => Date.now());

  useEffect(() => {
    let iptal = false;
    qc
      .prefetchQuery({ queryKey: ["dashboard-data"], queryFn: getDashboardData })
      .catch(() => {
        // Veri gelmese de açılırız: Panel kendi hata durumunu gösterir.
      })
      .then(() => {
        if (!iptal) setDataReady(true);
      });
    const failSafe = setTimeout(() => {
      if (!iptal) setZamanAsimi(true);
    }, 6000);
    return () => {
      iptal = true;
      clearTimeout(failSafe);
    };
  }, [qc]);

  useEffect(() => {
    if (!((dataReady && fontsReady) || zamanAsimi)) return;
    const bekle = Math.max(0, 400 - (Date.now() - basladi));
    const t = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, bekle);
    return () => clearTimeout(t);
  }, [dataReady, fontsReady, zamanAsimi, basladi]);

  return null;
}

/**
 * FİNANS GEÇMİŞİ BEKÇİSİ — Raporlar ekranından bağımsız.
 *
 * Geçmişi yazan tek tetikleyici o ekranın açılmasıydı; Raporlar sekme çubuğundan çıkacağı için
 * (kullanıcı ona nadiren, masa başında bakıyor) geçmiş sessizce eksik kalırdı. Buradaki bekçi
 * ÖNBELLEKTEKİ veriyle çalışır — kendi başına ağ isteği açmaz, açılışı yavaşlatmaz.
 */
function FinanceSyncGate() {
  const qc = useQueryClient();
  useEffect(() => {
    // İlk deneme açılıştan biraz sonra: Panel'in verisi önbelleğe insin.
    const ilk = setTimeout(() => void syncFinanceFromCache(qc), 8000);
    const periyot = setInterval(() => void syncFinanceFromCache(qc), 10 * 60_000);
    // Uygulama öne geldiğinde de dene (arka planda geçen sürede yeni sipariş gelmiş olabilir).
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") void syncFinanceFromCache(qc);
    });
    return () => {
      clearTimeout(ilk);
      clearInterval(periyot);
      sub.remove();
    };
  }, [qc]);
  return null;
}

export default function RootLayout() {
  // Push kaydı: açılışta bir kez DEĞİL — uygulama her öne geldiğinde de denenir. İlk açılışta ağ
  // yoksa veya izin sonradan verilirse tek deneme sessizce kayboluyordu, bildirim hiç gelmiyordu.
  useEffect(() => startPushRegistration(), []);

  /**
   * Yazı tipi: Plus Jakarta Sans (Türkçe karakter + ₺ + sabit genişlikli rakam tam; fontTools ile
   * doğrulandı). Dosyalar JS paketinde gelir → OTA ile güncellenebilir, parmak izine girmez.
   * Hata olursa (fontError) sistem fontuyla devam edilir — uygulama asla font yüzünden açılmaz olmaz.
   */
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });
  const fontsReady = fontsLoaded || fontError != null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.bg0 }}>
      <AppQueryProvider>
        <StatusBar style="light" />
        <SplashGate fontsReady={fontsReady} />
        <FinanceSyncGate />
        {/* ZEMİN kökte bir kez çizilir; ekranlar kendi arka planını ŞEFFAF bırakır (kit/Backdrop). */}
        <View style={{ flex: 1 }}>
          <Backdrop />
          <ThemeProvider value={NAV_THEME}>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: "transparent" },
                animation: "slide_from_right",
              }}
            />
          </ThemeProvider>
        </View>
        <UpdateGate />
      </AppQueryProvider>
    </GestureHandlerRootView>
  );
}
