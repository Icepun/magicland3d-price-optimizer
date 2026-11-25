import { Tabs } from "expo-router";

import { TabBar } from "@/components/kit/TabBar";

/**
 * SEKME ÇUBUĞU kit/TabBar'da: yüzen koyu çubuk, yayla kayan mor→mavi kapsül, SF Symbol.
 * Beş sekme (onaylı önizleme, 25 Kas 2026): Panel · Siparişler · Ürünler · Atölye · Raporlar.
 * Bildirimler / Kurallar / Hızlı hesap başlıktaki menüden açılır.
 */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{
        headerShown: false,
        // Sahne zemini ŞEFFAF: zemin kökte tek katman (kit/Backdrop), gezgin onu örtmemeli.
        sceneStyle: { backgroundColor: "transparent" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Panel" }} />
      <Tabs.Screen name="orders" options={{ title: "Siparişler" }} />
      <Tabs.Screen name="products" options={{ title: "Ürünler" }} />
      <Tabs.Screen name="atolye" options={{ title: "Atölye" }} />
      <Tabs.Screen name="reports" options={{ title: "Raporlar" }} />
    </Tabs>
  );
}
