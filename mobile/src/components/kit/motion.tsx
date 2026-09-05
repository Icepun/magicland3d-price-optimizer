import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { AccessibilityInfo, type StyleProp, type ViewStyle } from "react-native";
import Reanimated, { FadeInDown } from "react-native-reanimated";

import { motion } from "@/theme/tokens";

/**
 * HAREKET TEMELLERİ — "hareketi azalt" tercihi ve giriş animasyonu.
 *
 * Tercih TEK yerde tutulur: liste satırlarının her biri soruyor; her bileşen kendi aboneliğini
 * açsaydı uzun listelerde onlarca sistem aboneliği doğardı. Bir kez okunur, bir kez abone olunur.
 */
let reduceMotionValue = false;
let reduceMotionReady = false;
const reduceMotionListeners = new Set<() => void>();

function setReduceMotion(next: boolean) {
  if (next === reduceMotionValue) return;
  reduceMotionValue = next;
  for (const listener of reduceMotionListeners) listener();
}

function subscribeReduceMotion(listener: () => void): () => void {
  reduceMotionListeners.add(listener);
  if (!reduceMotionReady) {
    reduceMotionReady = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => {
        // Tercih okunamazsa animasyonlu varsayılanda kal.
      });
    AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
  }
  return () => {
    reduceMotionListeners.delete(listener);
  };
}

/**
 * Cihazın "hareketi azalt" tercihi. Açıkken süsleme animasyonları kapanır;
 * YÜKLEME göstergeleri kapanmaz — kullanıcının tek geri bildirimi onlar.
 */
export function useReduceMotion(): boolean {
  const getSnapshot = useCallback(() => reduceMotionValue, []);
  return useSyncExternalStore(subscribeReduceMotion, getSnapshot, getSnapshot);
}

/**
 * Giriş animasyonu — Reanimated `entering` (fade + aşağıdan kayma). FlashList geri dönüşümüyle
 * uyumlu: yalnız hücre OLUŞTURULURKEN oynar, geri dönüşümde tekrar tetiklenmez.
 */
export function FadeInView({
  index = 0,
  duration = motion.enter,
  baseDelay = 0,
  step = motion.stagger,
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
  const reduceMotion = useReduceMotion();
  return (
    <Reanimated.View
      // Tercih açıkken animasyon YOK ama ağacın şekli aynı kalır (kart yeniden kurulmasın).
      entering={reduceMotion ? undefined : FadeInDown.duration(duration).delay(baseDelay + Math.min(index, 10) * step)}
      style={style}
    >
      {children}
    </Reanimated.View>
  );
}
