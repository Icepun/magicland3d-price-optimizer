import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";

/**
 * Giriş animasyonu — Reanimated `entering` (MotiView'un yerine).
 *
 * Neden: moti yalnız bu giriş animasyonu için kullanılıyordu ama framer-motion+popmotion
 * zincirini bundle'a çekiyordu (~300 modül / bundle'ın ~%15'i). Reanimated zaten native
 * binary'de → bu bileşen sıfır ek bağımlılıkla aynı görünümü verir (fade + aşağıdan kayma).
 * FlashList recycling ile de uyumlu: entering yalnız hücre OLUŞTURULURKEN oynar,
 * geri dönüşümde tekrar tetiklenmez.
 */
export function FadeInView({
  index = 0,
  duration = 240,
  baseDelay = 0,
  step = 22,
  style,
  children,
}: {
  /** Liste sırası — kademeli gecikme için (min(index,10) × step). */
  index?: number;
  duration?: number;
  baseDelay?: number;
  step?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <Animated.View
      entering={FadeInDown.duration(duration).delay(baseDelay + Math.min(index, 10) * step)}
      style={style}
    >
      {children}
    </Animated.View>
  );
}
