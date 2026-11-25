import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
// Yalnız TİP: expo-router SDK 56'da React Navigation'ı kendi içinde taşıyor; tip bu derin yoldan gelir.
import type { BottomTabBarProps } from "expo-router/build/react-navigation/bottom-tabs/types";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";

import { useReduceMotion } from "@/components/kit/motion";
import { Txt } from "@/components/kit/Txt";
import { color, font, gradient, motion, radius } from "@/theme/tokens";

/** Rota adı → SF Symbol. Sekme başlıkları (tabs)/_layout'ta. */
const ICON: Record<string, SymbolViewProps["name"]> = {
  index: "square.grid.2x2.fill",
  orders: "list.clipboard.fill",
  products: "shippingbox.fill",
  atolye: "printer.fill",
  reports: "chart.bar.fill",
};

/** Yüzen çubuğun iç yüksekliği ve kenar boşluğu (çubuk içeriğin ALTINA girmez, yer kaplar). */
const BAR_H = 64;
const KENAR = 12;
const PILL_W = 50;
const PILL_H = 32;

/**
 * SEKME ÇUBUĞU — masaüstü kartı renginde YÜZEN çubuk (kenarlardan boşluklu, yuvarlak köşe, gölge);
 * seçili sekmenin ikonunun arkasında yayla kayan mor→mavi kapsül, dokununca hafif titreşim.
 *
 * Görünüşte yüzer ama yer KAPLAR: dış kap şeffaf ve kendi yüksekliği kadar alan ayırır, iç çubuk
 * bu alanın içinde durur → içerik çubuğun altına girmez, 25 ekrana alt boşluk eklemek gerekmez.
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
  // Ana ekran çizgisi olan cihazlarda çubuk çizginin biraz üstünde durur.
  const alt = Math.max(KENAR - 4, insets.bottom - 12);

  return (
    <View style={{ height: BAR_H + alt + 8, paddingTop: 8 }}>
      <View style={[styles.bar, { bottom: alt }]}>
      <View style={styles.items} onLayout={onLayout}>
        {width > 0 ? (
          <Animated.View style={[styles.pill, pillStyle]}>
            <LinearGradient
              colors={gradient.pill}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[StyleSheet.absoluteFill, { borderRadius: radius.pill }]}
            />
          </Animated.View>
        ) : null}
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
                tintColor={secili ? color.onAccent : color.textFaint}
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
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: KENAR,
    right: KENAR,
    height: BAR_H,
    borderRadius: 24,
    backgroundColor: color.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    shadowColor: "#000",
    shadowOpacity: 0.6,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
  },
  items: { flexDirection: "row", height: BAR_H, alignItems: "center" },
  pill: {
    position: "absolute",
    top: 7,
    left: 0,
    width: PILL_W,
    height: PILL_H,
    borderRadius: radius.pill,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.16)",
    shadowColor: color.accent,
    shadowOpacity: 0.6,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  item: { flex: 1, alignItems: "center", justifyContent: "flex-start", paddingTop: 11, gap: 6, minHeight: BAR_H },
  icon: { width: 22, height: 22 },
  label: { fontSize: 10, lineHeight: 12 },
});
