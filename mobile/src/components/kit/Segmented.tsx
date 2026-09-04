import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";

import { useReduceMotion } from "@/components/kit/motion";
import { Txt } from "@/components/kit/Txt";
import { color, motion, radius, space } from "@/theme/tokens";

/**
 * SEGMENTLİ SEÇİCİ — "7g · 30g · 60g", "Hafta · Ay". Seçili kapsül yayla kayar.
 *
 * Eski Chip dizisinde seçim anında dolgu atlıyordu; burada tek bir gösterge, ölçülen genişlikle
 * hedefe kayar. Seçenekler eşit genişlikte (metinler kısa; uzun etiketler için Chip kullan).
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  style,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReduceMotion();
  const [width, setWidth] = useState(0);
  const n = Math.max(1, options.length);
  const segW = width > 0 ? (width - PAD * 2) / n : 0;
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const x = useSharedValue(0);

  useEffect(() => {
    const hedef = idx * segW;
    x.set(reduceMotion ? withTiming(hedef, { duration: 0 }) : withSpring(hedef, motion.spring));
  }, [idx, segW, reduceMotion, x]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w !== width) setWidth(w);
  };

  return (
    <View style={[styles.track, style]} onLayout={onLayout} accessibilityRole="tablist">
      {segW > 0 ? (
        <Animated.View style={[styles.indicator, { width: segW }, indicatorStyle]} />
      ) : null}
      {options.map((o) => {
        const secili = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            style={styles.seg}
            accessibilityRole="tab"
            accessibilityState={{ selected: secili }}
            onPress={() => {
              if (secili) return;
              void Haptics.selectionAsync().catch(() => {});
              onChange(o.value);
            }}
          >
            <Txt v="smallStrong" tone={secili ? "default" : "dim"} num numberOfLines={1}>
              {o.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

const PAD = 3;

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    padding: PAD,
    borderRadius: radius.pill,
    backgroundColor: color.tint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  indicator: {
    position: "absolute",
    top: PAD,
    bottom: PAD,
    left: PAD,
    borderRadius: radius.pill,
    backgroundColor: color.accentSoft,
    borderWidth: 1,
    borderColor: color.accent,
  },
  seg: {
    flex: 1,
    minHeight: 34,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
});
