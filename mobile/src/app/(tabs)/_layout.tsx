import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { StyleSheet, View, type ColorValue } from "react-native";

import { ML } from "@/theme/colors";

/**
 * Sekme ikonu — seçiliyken SF Symbol'ün kendi "hiyerarşik" vurgusuyla dolgun görünür.
 * (Ayrı bir ölçek animasyonu EKLENMEDİ: sekme çubuğu yeniden bağlanırken ikonlar yeniden
 * monte oluyor ve animasyon her dokunuşta baştan oynayıp titrek duruyordu.)
 */
function tabIcon(name: SymbolViewProps["name"]) {
  return function TabIcon({ color, focused }: { color: ColorValue; focused: boolean }) {
    return (
      <SymbolView
        name={name}
        tintColor={color}
        style={{ width: 26, height: 26, opacity: focused ? 1 : 0.9 }}
      />
    );
  };
}

/**
 * CAM SEKME ÇUBUĞU (iOS 26 Liquid Glass).
 *
 * `isLiquidGlassAvailable()` FALSE dönerse (eski iOS) hiçbir şey kaybolmaz: altta zaten
 * katmanlı yarı saydam bir zemin var, cam yalnız onun ÜSTÜNE biner. Yani tek kod yolu her
 * sürümde çalışır — sürüm kontrolü ekranlara dağılmaz.
 */
function TabBarBackground() {
  if (!isLiquidGlassAvailable()) {
    return <View style={[StyleSheet.absoluteFill, styles.fallback]} />;
  }
  return (
    <GlassView style={StyleSheet.absoluteFill} glassEffectStyle="regular" tintColor={ML.bg + "CC"} />
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ML.accent,
        tabBarInactiveTintColor: ML.textFaint,
        /**
         * Zemin ayrı bir katman olduğu için çubuğun kendisi ŞEFFAF.
         *
         * ⚠️ `position: "absolute"` BİLEREK kullanılmadı: çubuğu üste bindirmek içeriği altına
         * kaydırır ve 25 ekranın hepsine alt boşluk eklemek gerekir — eklenmezse listelerin son
         * satırı çubuğun altında kalır. Cam, ekran zemini üzerinde de görünür; içeriğin altından
         * akması istenirse önce ekranların alt güvenli boşluğu tek yerden verilmeli (ayrı iş).
         */
        tabBarStyle: { backgroundColor: "transparent", borderTopWidth: 0 },
        tabBarBackground: () => <TabBarBackground />,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
      screenListeners={{
        // Sekme değişiminde hafif titreşim — hangi sekmeye geçtiğini parmak da doğrular.
        tabPress: () => {
          void Haptics.selectionAsync().catch(() => {});
        },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Panel", tabBarIcon: tabIcon("chart.bar.fill") }} />
      <Tabs.Screen
        name="products"
        options={{ title: "Ürünler", tabBarIcon: tabIcon("shippingbox.fill") }}
      />
      <Tabs.Screen name="orders" options={{ title: "Siparişler", tabBarIcon: tabIcon("bag.fill") }} />
      <Tabs.Screen
        name="reports"
        options={{ title: "Raporlar", tabBarIcon: tabIcon("chart.pie.fill") }}
      />
      <Tabs.Screen name="more" options={{ title: "Daha", tabBarIcon: tabIcon("ellipsis.circle.fill") }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  /** iOS 26 öncesi: cam yerine katmanlı yarı saydam zemin (her sürümde çalışır). */
  fallback: {
    backgroundColor: ML.card + "F2",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ML.border,
  },
});
