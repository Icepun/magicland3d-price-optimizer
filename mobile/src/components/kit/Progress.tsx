import { useEffect } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { useReduceMotion } from "@/components/kit/motion";
import { color as C, motion, radius } from "@/theme/tokens";

/**
 * İLERLEME ÇUBUĞU — 0..1 doluluk, UI thread'de genişler. Hazırlık listesi, baskı ilerlemesi,
 * hedef doluluğu. Sıfır olmayan çok küçük değer için taban genişlik (görünsün).
 */
export function Progress({
  value,
  color = C.accent,
  track = C.tintStrong,
  height = 6,
  minPercent = 2,
  style,
}: {
  value: number;
  color?: string;
  track?: string;
  height?: number;
  minPercent?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReduceMotion();
  const raw = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const hedef = raw > 0 ? Math.max(minPercent, raw * 100) : 0;
  const w = useSharedValue(reduceMotion ? hedef : 0);

  useEffect(() => {
    w.set(reduceMotion ? hedef : withTiming(hedef, { duration: motion.bar, easing: Easing.out(Easing.cubic) }));
  }, [hedef, reduceMotion, w]);

  const fill = useAnimatedStyle(() => ({ width: `${w.get()}%` }));

  return (
    <View style={[styles.track, { height, borderRadius: height / 2, backgroundColor: track }, style]}>
      <Animated.View style={[styles.fill, { backgroundColor: color, borderRadius: height / 2 }, fill]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { overflow: "hidden", width: "100%" },
  fill: { height: "100%", borderRadius: radius.pill },
});
