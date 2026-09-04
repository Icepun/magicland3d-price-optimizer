import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { PressableScale, type HapticStyle } from "@/components/kit/PressableScale";
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
  /**
   * Çağıranın stili İKİYE bölünür: yerleşim anahtarları (flex, genişlik, kenar boşluğu) dış
   * kaba, kalanı (flexDirection, gap, hizalama, iç boşluk) İÇ içerik kabına. Aksi hâlde
   * `style={{ flexDirection: "row" }}` dış kaba gidiyor ve çocuklar yine alt alta diziliyordu
   * (sipariş detayındaki halka kartın altına düşmüştü).
   */
  const dis = yerlesim(style);
  const ic = icerik(style);
  const body = (
    <View style={[styles.wrap, { borderRadius: r }, onPress ? null : dis]}>
      <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} />
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: strong ? color.glassStrong : color.glass },
        ]}
      />
      <View style={styles.edge} />
      <View style={[padded ? styles.padded : null, ic]}>{children}</View>
    </View>
  );
  if (!onPress) return body;
  // Cam gövde blur için kendi View'ında kalmalı; yerleşim sarmalayıcıya.
  return (
    <PressableScale
      onPress={onPress}
      haptic={haptic}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={dis}
    >
      {body}
    </PressableScale>
  );
}

const YERLESIM = [
  "flex", "flexGrow", "flexShrink", "flexBasis", "width", "minWidth", "maxWidth", "alignSelf",
  "margin", "marginTop", "marginBottom", "marginLeft", "marginRight", "marginHorizontal", "marginVertical",
] as const;

/** Çağıranın stilinden yalnız yerleşim anahtarlarını süzer (dış kap için). */
function yerlesim(style: StyleProp<ViewStyle>): ViewStyle {
  const duz = (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of YERLESIM) if (duz[k] !== undefined) out[k] = duz[k];
  return out as ViewStyle;
}

/** Yerleşim anahtarları DIŞINDA kalanlar (iç içerik kabı için). */
function icerik(style: StyleProp<ViewStyle>): ViewStyle {
  const duz = (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(duz)) if (!(YERLESIM as readonly string[]).includes(k)) out[k] = duz[k];
  return out as ViewStyle;
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
  const stil = [
    styles.tint,
    { borderRadius: r, backgroundColor: strong ? color.tintStrong : color.tint },
    padded ? styles.padded : null,
    style,
  ];
  if (!onPress) return <View style={stil}>{children}</View>;
  // ⚠️ Stiller DOĞRUDAN basılabilir yüzeye: ayrı bir sarmalayıcı, çağıranın verdiği flex/genişliği
  // almadığı için üçlü kutular satırda büzüşüyordu (Panel'de yaşandı).
  return (
    <PressableScale
      onPress={onPress}
      haptic={haptic}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={stil}
    >
      {children}
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
