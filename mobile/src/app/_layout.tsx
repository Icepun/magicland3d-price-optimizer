import { useQueryClient } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { AppQueryProvider } from "@/lib/query";
import { UpdateGate } from "@/components/UpdateGate";
import { getDashboardData } from "@/lib/db/dashboard";
import { registerForPush } from "@/lib/push";
import { ML } from "@/theme/colors";

// Splash'i BİZ kapatana kadar açık tut (expo otomatik gizleyip boş ekran flaşı yaratmasın) + yumuşak fade.
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ duration: 300, fade: true });

/**
 * Açılış ekranı DÜRÜST (masaüstü v0.19.70 ile aynı mantık): sabit timer yerine panel verisi
 * (["dashboard-data"] sorgusu) GERÇEKTEN gelince kapanır. Hızlı açılışta erken kapanır (bekletmez),
 * yavaş açılışta veri gelene kadar durur (iskelet/boş flaş yok). MIN 400ms (logo flaş etmesin) +
 * MAX 6sn fail-safe (asılı kalmaz). Prefetch aynı queryKey'i ısıttığı için Panel veriyi anında bulur.
 */
function SplashGate() {
  const qc = useQueryClient();
  useEffect(() => {
    const start = Date.now();
    let hidden = false;
    const hide = async () => {
      if (hidden) return;
      hidden = true;
      const wait = 400 - (Date.now() - start);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await SplashScreen.hideAsync().catch(() => {});
    };
    qc
      .prefetchQuery({ queryKey: ["dashboard-data"], queryFn: getDashboardData })
      .then(hide)
      .catch(hide);
    const failSafe = setTimeout(hide, 6000);
    return () => clearTimeout(failSafe);
  }, [qc]);
  return null;
}

export default function RootLayout() {
  // Push token'ı kaydet (baskı bitti bildirimleri için) — bir kez, açılışta. Defensive (hata → sessiz).
  useEffect(() => {
    void registerForPush();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: ML.bg }}>
      <AppQueryProvider>
        <StatusBar style="light" />
        <SplashGate />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: ML.bg },
            animation: "slide_from_right",
          }}
        />
        <UpdateGate />
      </AppQueryProvider>
    </GestureHandlerRootView>
  );
}
