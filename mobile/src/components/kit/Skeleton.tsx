import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useReduceMotion } from "@/components/kit/motion";
import { Tint } from "@/components/kit/Glass";
import { color, radius as R, space } from "@/theme/tokens";

/**
 * İSKELET — nabız yerine IŞIK SÜPÜRMESİ (shimmer): soldan sağa kayan açık bir bant.
 * Nabız "bir şey oluyor" derdi; süpürme "yükleniyor" der ve cam dille uyumludur.
 * "Hareketi azalt" açıkken bant durur, blok yarı saydam kalır (yükleme göstergesi kapanmaz).
 */
export function Shimmer({
  width = "100%",
  height = 14,
  radius = R.xs,
  delay = 0,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  delay?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReduceMotion();
  const [w, setW] = useState(0);
  const x = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion || w <= 0) return;
    x.set(0);
    x.set(
      withRepeat(
        withTiming(1, { duration: 1100 + delay, easing: Easing.inOut(Easing.quad) }),
        -1,
        false
      )
    );
    return () => cancelAnimation(x);
  }, [reduceMotion, w, delay, x]);

  const band = useAnimatedStyle(() => ({
    transform: [{ translateX: -w + x.get() * (w * 2) }],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    const nw = Math.round(e.nativeEvent.layout.width);
    if (nw !== w) setW(nw);
  };

  return (
    <View
      onLayout={onLayout}
      style={[{ width, height, borderRadius: radius, backgroundColor: color.skeleton }, styles.clip, style]}
    >
      {!reduceMotion && w > 0 ? (
        <Animated.View style={[StyleSheet.absoluteFill, { width: w }, band]}>
          <LinearGradient
            colors={["transparent", color.skeletonHigh, "transparent"]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

/** Kart iskeleti — gerçek kartın şeklinde (başlık satırı, rakam, alt bilgi). */
export function ShimmerCard({
  height = 96,
  delay = 0,
  style,
}: {
  height?: number;
  delay?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Tint style={[{ height, justifyContent: "center", gap: space.sm }, style]}>
      <Shimmer width="42%" height={11} delay={delay} />
      <Shimmer width="68%" height={18} delay={delay + 60} />
      <Shimmer width="28%" height={10} delay={delay + 120} />
    </Tint>
  );
}

/** Liste iskeleti — satırlar sırayla belirir. */
export function ShimmerList({ count = 6, height = 84 }: { count?: number; height?: number }) {
  return (
    <View style={{ gap: space.md }}>
      {Array.from({ length: count }, (_, i) => (
        <ShimmerCard key={i} height={height} delay={i * 70} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({ clip: { overflow: "hidden" } });
