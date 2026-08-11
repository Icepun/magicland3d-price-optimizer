import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Reanimated, { FadeInDown } from "react-native-reanimated";

import { formatNumber } from "@/lib/format";
import { ML, motion } from "@/theme/colors";

/**
 * Mobil hareket takımı: giriş animasyonu, akan sayı, dolan bar ve iskelet yükleme.
 *
 * Neden hepsi tek dosyada: masaüstündeki AnimatedNumber + skeleton + stagger üçlüsünün
 * telefondaki karşılığı; aynı süre/eğri değerlerini paylaşmaları için bir arada duruyorlar.
 *
 * Neden çekirdek React Native `Animated` (Reanimated değil): bar ve iskelet animasyonları
 * ekstra derleyici eklentisine ihtiyaç duymadan her yerde aynı çalışsın. Giriş animasyonu
 * ise Reanimated `entering` ile kalıyor — FlashList geri dönüşümüyle uyumlu olan tek yol.
 */

/**
 * "Hareketi azalt" tercihi TEK yerde tutulur.
 *
 * Neden tekil depo: bu değeri listedeki her satır soruyor. Her bileşen kendi aboneliğini
 * açsaydı uzun listelerde onlarca sistem sorgusu/aboneliği doğardı. Burada bir kez okunur,
 * bir kez abone olunur; bileşenler yalnız değişimi dinler.
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
 * Cihazın "hareketi azalt" tercihi. Açıkken tüm süsleme animasyonları kapanır;
 * YÜKLEME göstergeleri kapanmaz — kullanıcının tek geri bildirimi onlar.
 */
export function useReduceMotion(): boolean {
  const getSnapshot = useCallback(() => reduceMotionValue, []);
  return useSyncExternalStore(subscribeReduceMotion, getSnapshot, getSnapshot);
}

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
      entering={
        reduceMotion
          ? undefined
          : FadeInDown.duration(duration).delay(baseDelay + Math.min(index, 10) * step)
      }
      style={style}
    >
      {children}
    </Reanimated.View>
  );
}

/**
 * Sayıyı yumuşakça akıtır: ilk gösterimde 0'dan değere, sonra her değişimde eski→yeni.
 * Masaüstündeki AnimatedNumber'ın birebir karşılığı — veri arka planda tazelenince
 * rakamlar zıplamaz, akar. "Hareketi azalt" açıkken anında son değere geçer.
 */
export function AnimatedNumber({
  value,
  format,
  durationMs = motion.number,
  style,
  numberOfLines,
}: {
  value: number;
  /** Gösterim biçimi — ör. (n) => formatCurrency(n). Verilmezse tam sayı olarak yazılır. */
  format?: (n: number) => string;
  durationMs?: number;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const reduceMotion = useReduceMotion();
  const [display, setDisplay] = useState(0);
  // Akış SIRASINDA değer değişirse ekrandaki sayıdan devam et (hedeften değil) — yoksa zıplar.
  const displayRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const to = Number.isFinite(value) ? value : 0;
    const from = displayRef.current;
    if (from === to) return;

    if (reduceMotion || durationMs <= 0) {
      displayRef.current = to;
      // Bir sonraki kareye ertele — efekt içinde doğrudan setState zincirleme render açar.
      const id = requestAnimationFrame(() => setDisplay(to));
      return () => cancelAnimationFrame(id);
    }

    const start = Date.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / durationMs);
      const next = t < 1 ? from + (to - from) * ease(t) : to;
      displayRef.current = next;
      setDisplay(next);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs, reduceMotion]);

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {format ? format(display) : formatNumber(display)}
    </Text>
  );
}

/**
 * Yüzdesi 0'dan hedefe dolan bar. Masaüstündeki grafiklerde barlar dolar; telefonda
 * aniden yerine oturuyordu — bu bileşen ikisini aynı hisse getirir.
 */
export function AnimatedBar({
  percent,
  color = ML.accent,
  height = 8,
  trackColor = ML.cardElevated,
  minPercent = 0,
  delay = 0,
  durationMs = motion.bar,
  align = "left",
  style,
}: {
  percent: number;
  color?: string;
  height?: number;
  trackColor?: string;
  /** Sıfır olmayan ama çok küçük değerler görünsün diye taban genişlik. */
  minPercent?: number;
  delay?: number;
  durationMs?: number;
  /** Sağdan sola dolan barlar (negatif tarafı) için. */
  align?: "left" | "right";
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReduceMotion();
  // useState(lazy) — Animated.Value bileşen ömrü boyunca TEK örnek kalsın (ref'e gerek yok).
  const [progress] = useState(() => new Animated.Value(0));

  const raw = Number.isFinite(percent) ? percent : 0;
  const target = Math.max(0, Math.min(100, raw <= 0 ? 0 : Math.max(minPercent, raw)));

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(target);
      return;
    }
    const anim = Animated.timing(progress, {
      toValue: target,
      duration: durationMs,
      delay,
      easing: Easing.out(Easing.cubic),
      // Genişlik native sürücüde animasyonlanamaz — bar sayısı azdır, JS tarafı yeter.
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [target, reduceMotion, durationMs, delay, progress]);

  const width = progress.interpolate({
    inputRange: [0, 100],
    outputRange: ["0%", "100%"],
  });

  return (
    <View style={[{ height, borderRadius: height / 2, backgroundColor: trackColor }, styles.clip, style]}>
      <Animated.View
        style={{
          width,
          height: "100%",
          borderRadius: height / 2,
          backgroundColor: color,
          marginLeft: align === "right" ? "auto" : 0,
        }}
      />
    </View>
  );
}

/**
 * İskelet blok — tam sayfa dönen çarkın yerine içeriğin şeklini gösterir.
 * Nabız animasyonu opaklıkla çalışır (native sürücü), "hareketi azalt" açıkken sabit durur.
 */
export function Skeleton({
  width,
  height = 14,
  radius = 8,
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
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(0.5);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 620,
          delay,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 620,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion, delay]);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: ML.skeleton, opacity },
        style,
      ]}
    />
  );
}

/** Kart görünümlü iskelet — liste/panel yüklenirken gerçek kartın yerini tutar. */
export function SkeletonCard({
  height = 84,
  delay = 0,
  style,
}: {
  height?: number;
  delay?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.skeletonCard, { height }, style]}>
      <Skeleton width="45%" height={12} delay={delay} />
      <Skeleton width="72%" height={16} delay={delay + 80} />
      <Skeleton width="30%" height={10} delay={delay + 160} />
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  skeletonCard: {
    backgroundColor: ML.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 14,
    gap: 10,
    justifyContent: "center",
  },
});
