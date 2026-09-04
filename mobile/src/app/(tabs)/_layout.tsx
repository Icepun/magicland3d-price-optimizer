import { Tabs } from "expo-router";

import { TabBar } from "@/components/kit/TabBar";

/**
 * SEKME ÇUBUĞU kit/TabBar'da: cam zemin, yayla kayan mor kapsül, SF Symbol + yeni yazı tipi.
 * Dört sekme: Panel · Ürünler · Siparişler · Atölye. "Daha" ve Raporlar rota olarak durur
 * (href: null → çubukta görünmez); Raporlar/Bildirimler/Kurallar başlıktaki menüden açılır.
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
      <Tabs.Screen name="products" options={{ title: "Ürünler" }} />
      <Tabs.Screen name="orders" options={{ title: "Siparişler" }} />
      <Tabs.Screen name="atolye" options={{ title: "Atölye" }} />
      <Tabs.Screen name="reports" options={{ href: null }} />
      <Tabs.Screen name="more" options={{ href: null }} />
    </Tabs>
  );
}
