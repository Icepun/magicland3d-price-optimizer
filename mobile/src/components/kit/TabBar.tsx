import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
// Yalnız TİP: expo-router SDK 56'da React Navigation'ı kendi içinde taşıyor; tip bu derin yoldan gelir.
import type { BottomTabBarProps } from "expo-router/build/react-navigation/bottom-tabs/types";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";

import { useReduceMotion } from "@/components/fade-in";
import { Txt } from "@/components/kit/Txt";
import { blur, color, font, motion, radius } from "@/theme/tokens";

/** Rota adı → SF Symbol. Sekme başlıkları (tabs)/_layout'ta. */
const ICON: Record<string, SymbolViewProps["name"]> = {
  index: "square.grid.2x2.fill",
  orders: "bag.fill",
  products: "shippingbox.fill",
  atolye: "wrench.and.screwdriver.fill",
};

const BAR_H = 58;
const PILL_W = 64;
const PILL_H = 34;

/**
 * SEKME ÇUBUĞU — cam zemin (iOS 26'da Liquid Glass, altında blur), seçili sekmenin altında yayla
 * kayan mor kapsül, SF Symbol + Plus Jakarta etiket, dokununca hafif titreşim.
 *
 * Çubuk YÜZEN değil, alta yaslı: yüzen çubuk içeriğin altına girer ve 25 ekranın hepsine alt boşluk
 * ister. Zemin gradyanı çubuğun arkasından geçtiği için cam yine cam gibi okunur.
 */
export function TabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const reduceMotion = useReduceMotion();
  const [width, setWidth] = useState(0);
  // `href: null` verilen rotalar (Raporlar, Daha) state'te durur ama çubukta çizilmez.
  // expo-router `href`i seçeneklerden SİLİP yerine `tabBarItemStyle: { display: "none" }` koyuyor
  // (layouts/TabsClient.js) — gizliliği o işaretten okuyoruz.
  const gorunur = state.routes.filter((r) => {
    const st = StyleSheet.flatten(descriptors[r.key]?.options.tabBarItemStyle) as { display?: string } | undefined;
    return st?.display !== "none";
  });
  const n = Math.max(1, gorunur.length);
  const itemW = width / n;
  // Aktif rota gizli bir rotaysa (Raporlar/Daha açıkken) -1: kapsül solar, hiçbir sekme seçili değil.
  const aktifIdx = gorunur.findIndex((r) => r.key === state.routes[state.index]?.key);
  const x = useSharedValue(0);
  const gorunurluk = useSharedValue(1);

  useEffect(() => {
    if (itemW <= 0) return;
    if (aktifIdx < 0) {
      gorunurluk.set(reduceMotion ? 0 : withTiming(0, { duration: 160 }));
      return;
    }
    const hedef = aktifIdx * itemW + (itemW - PILL_W) / 2;
    x.set(reduceMotion ? hedef : withSpring(hedef, motion.spring));
    gorunurluk.set(reduceMotion ? 1 : withTiming(1, { duration: 160 }));
  }, [aktifIdx, itemW, reduceMotion, x, gorunurluk]);

  const pillStyle = useAnimatedStyle(() => ({
    opacity: gorunurluk.get(),
    transform: [{ translateX: x.get() }],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w !== width) setWidth(w);
  };

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom, height: BAR_H + insets.bottom }]}>
      <Zemin />
      <View style={styles.items} onLayout={onLayout}>
        {width > 0 ? <Animated.View style={[styles.pill, pillStyle]} /> : null}
        {gorunur.map((route) => {
          const { options } = descriptors[route.key];
          const label = typeof options.title === "string" ? options.title : route.name;
          const secili = state.routes[state.index]?.key === route.key;
          return (
            <Pressable
              key={route.key}
              style={styles.item}
              accessibilityRole="tab"
              accessibilityState={{ selected: secili }}
              accessibilityLabel={label}
              onPress={() => {
                const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (!secili && !event.defaultPrevented) {
                  void Haptics.selectionAsync().catch(() => {});
                  navigation.navigate(route.name);
                }
              }}
            >
              <SymbolView
                name={ICON[route.name] ?? "circle.fill"}
                tintColor={secili ? color.accentBright : color.textFaint}
                weight={secili ? "semibold" : "regular"}
                style={styles.icon}
              />
              <Txt
                v="label"
                style={[styles.label, { color: secili ? color.text : color.textFaint, fontFamily: font.semibold }]}
                numberOfLines={1}
              >
                {label}
              </Txt>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Zemin() {
  if (isLiquidGlassAvailable()) {
    return <GlassView style={StyleSheet.absoluteFill} glassEffectStyle="regular" tintColor={color.bg0 + "B3"} />;
  }
  return (
    <View style={StyleSheet.absoluteFill}>
      <BlurView intensity={blur.bar} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color.glassStrong }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    overflow: "hidden",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineStrong,
  },
  items: { flexDirection: "row", height: BAR_H, alignItems: "center" },
  pill: {
    position: "absolute",
    top: (BAR_H - PILL_H) / 2 - 6,
    left: 0,
    width: PILL_W,
    height: PILL_H,
    borderRadius: radius.pill,
    backgroundColor: color.accentSoft,
  },
  item: { flex: 1, alignItems: "center", justifyContent: "center", gap: 3, minHeight: BAR_H },
  icon: { width: 24, height: 24 },
  label: { fontSize: 11, lineHeight: 13 },
});
