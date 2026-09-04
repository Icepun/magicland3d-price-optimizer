import { useEffect, useState } from "react";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Rect } from "react-native-svg";

import { useReduceMotion } from "@/components/fade-in";
import { color as C, motion } from "@/theme/tokens";

/**
 * İNCE ÇUBUK GRAFİĞİ — şablonun imza grafiği (ses dalgası gibi dizilmiş ince dikey çubuklar).
 *
 * Genişliği kendi ölçer (onLayout) ve çubuk kalınlığını sayıya göre paylaştırır; 7 günde kalın,
 * 60 günde ince. Vurgu (`emphasis`) verilen çubuklar mor, kalanı soluk. Girişte tek bir
 * scaleY ile "yerden biter" — çubuk başına animasyon YOK (60 çubuk × prop = boşa iş).
 */
export function Bars({
  values,
  height = 56,
  gap = 3,
  maxBarWidth = 22,
  emphasis,
  barColor = C.accent,
  dimColor = C.tintStrong,
  animate = true,
  style,
}: {
  values: number[];
  height?: number;
  gap?: number;
  maxBarWidth?: number;
  /** Bu çubuk vurgulu mu? (ör. seçili dönem, bugün) */
  emphasis?: (index: number, value: number) => boolean;
  barColor?: string;
  dimColor?: string;
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [width, setWidth] = useState(0);
  const reduceMotion = useReduceMotion();
  const grow = useSharedValue(animate && !reduceMotion ? 0.12 : 1);

  useEffect(() => {
    if (!animate || reduceMotion) {
      grow.set(1);
      return;
    }
    grow.set(withTiming(1, { duration: motion.bar, easing: Easing.out(Easing.cubic) }));
  }, [animate, reduceMotion, grow, values]);

  const growStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: grow.get() }],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w !== width) setWidth(w);
  };

  const n = values.length;
  const max = Math.max(1e-9, ...values.map((v) => (Number.isFinite(v) ? v : 0)));
  // Az çubukta aralık açılır (7 gün → geniş çubuklar), çokta ince kalır (60 gün → dalga).
  const g = n <= 14 ? Math.max(gap, 8) : gap;
  const bw = n > 0 && width > 0 ? Math.min(maxBarWidth, Math.max(2, (width - g * (n - 1)) / n)) : 0;
  // Çubuklar sağa dayanır: en yeni gün sağda, boşluk (varsa) solda kalır.
  const totalW = n * bw + Math.max(0, n - 1) * g;
  const offsetX = Math.max(0, width - totalW);

  return (
    <View onLayout={onLayout} style={[{ height, width: "100%" }, style]}>
      {width > 0 && n > 0 ? (
        <Animated.View style={[{ height, transformOrigin: "bottom" }, growStyle]}>
          <Svg width={width} height={height}>
            {values.map((raw, i) => {
              const v = Number.isFinite(raw) && raw > 0 ? raw : 0;
              const h = v > 0 ? Math.max(3, (v / max) * height) : 2;
              const x = offsetX + i * (bw + g);
              const vurgu = emphasis ? emphasis(i, v) : false;
              return (
                <Rect
                  key={i}
                  x={x}
                  y={height - h}
                  width={bw}
                  height={h}
                  rx={bw / 2}
                  fill={vurgu ? barColor : dimColor}
                />
              );
            })}
          </Svg>
        </Animated.View>
      ) : null}
    </View>
  );
}
