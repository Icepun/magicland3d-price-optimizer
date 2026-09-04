import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { PressableScale, type HapticStyle } from "@/components/ui/PressableScale";
import { blur, color, radius, space } from "@/theme/tokens";

/**
 * CAM YÜZEY — şablonun (Ledgerix) kart dili.
 *
 * Katmanlar: BlurView (arkadaki zemin ışığını bulanıklaştırır) → renk perdesi (okunurluk için
 * koyulaştırır) → üst kenarda 1 px ışık çizgisi (camın "kenarı") → içerik. Kenarlık ince ve açık.
 *
 * ⚠️ LİSTE SATIRINDA KULLANMA. BlurView her örnekte bir UIVisualEffectView açar; 200 satırlık
 * FlashList'te hem kaydırmayı yavaşlatır hem geri dönüşümde titrer. Satırlar için `Tint`.
 */
export function Glass({
  children,
  style,
  strong = false,
  intensity = blur.card,
  radius: r = radius.lg,
  padded = true,
  onPress,
  haptic,
  accessibilityLabel,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Daha koyu perde — üstünde küçük metin olan kartlar (okunurluk). */
  strong?: boolean;
  intensity?: number;
  radius?: number;
  padded?: boolean;
  onPress?: () => void;
  haptic?: HapticStyle;
  accessibilityLabel?: string;
}) {
  const body = (
    <View style={[styles.wrap, { borderRadius: r }, style]}>
      <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} />
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: strong ? color.glassStrong : color.glass },
        ]}
      />
      <View style={styles.edge} />
      <View style={padded ? styles.padded : null}>{children}</View>
    </View>
  );
  if (!onPress) return body;
  return (
    <PressableScale
      onPress={onPress}
      haptic={haptic}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {body}
    </PressableScale>
  );
}

/**
 * SAYDAM YÜZEY — blur'suz. Liste satırları, çipler, küçük kutular.
 * Zemin gradyanı arkadan hafifçe geçer; cam hissi korunur ama maliyeti sıfır.
 */
export function Tint({
  children,
  style,
  strong = false,
  radius: r = radius.md,
  padded = true,
  onPress,
  haptic,
  accessibilityLabel,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  strong?: boolean;
  radius?: number;
  padded?: boolean;
  onPress?: () => void;
  haptic?: HapticStyle;
  accessibilityLabel?: string;
}) {
  const body = (
    <View
      style={[
        styles.tint,
        { borderRadius: r, backgroundColor: strong ? color.tintStrong : color.tint },
        padded ? styles.padded : null,
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <PressableScale
      onPress={onPress}
      haptic={haptic}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {body}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  edge: {
    position: "absolute",
    top: 0,
    left: space.lg,
    right: space.lg,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  tint: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  padded: { padding: space.lg },
});
