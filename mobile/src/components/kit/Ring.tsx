import { useEffect, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { Easing, useAnimatedProps, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";

import { useReduceMotion } from "@/components/fade-in";
import { color as C, motion } from "@/theme/tokens";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * HALKA GÖSTERGE — marj, stok doluluğu, baskı ilerlemesi.
 * Tek animasyonlu özellik (strokeDashoffset) → UI iş parçacığında, JS'e uğramadan dolar.
 * Ortasına ne verilirse (yüzde metni, ikon) o çizilir.
 */
export function Ring({
  value,
  size = 72,
  stroke = 8,
  color = C.accent,
  track = C.tintStrong,
  animate = true,
  children,
  style,
}: {
  /** 0–1 arası doluluk. */
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  animate?: boolean;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReduceMotion();
  const hedef = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const progress = useSharedValue(animate && !reduceMotion ? 0 : hedef);

  useEffect(() => {
    if (!animate || reduceMotion) {
      progress.set(hedef);
      return;
    }
    progress.set(withTiming(hedef, { duration: motion.bar, easing: Easing.out(Easing.cubic) }));
  }, [hedef, animate, reduceMotion, progress]);

  const r = (size - stroke) / 2;
  const cevre = 2 * Math.PI * r;
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: cevre * (1 - progress.get()),
  }));

  return (
    <View style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} style={styles.rotate}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${cevre} ${cevre}`}
          animatedProps={animatedProps}
        />
      </Svg>
      <View style={styles.center} pointerEvents="none">
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // -90°: doluluk tepeden başlasın.
  rotate: { transform: [{ rotate: "-90deg" }] },
  center: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
});
