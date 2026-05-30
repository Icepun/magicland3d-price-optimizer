import { Tabs } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";

import { ML } from "@/theme/colors";

function tabIcon(name: SymbolViewProps["name"]) {
  return ({ color }: { color: string }) => (
    <SymbolView name={name} tintColor={color} style={{ width: 26, height: 26 }} />
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ML.accent,
        tabBarInactiveTintColor: ML.textFaint,
        tabBarStyle: {
          backgroundColor: ML.card,
          borderTopColor: ML.border,
          borderTopWidth: 1,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Panel", tabBarIcon: tabIcon("chart.bar.fill") }} />
      <Tabs.Screen
        name="products"
        options={{ title: "Ürünler", tabBarIcon: tabIcon("shippingbox.fill") }}
      />
      <Tabs.Screen name="orders" options={{ title: "Siparişler", tabBarIcon: tabIcon("bag.fill") }} />
      <Tabs.Screen
        name="settings"
        options={{ title: "Ayarlar", tabBarIcon: tabIcon("gearshape.fill") }}
      />
    </Tabs>
  );
}
