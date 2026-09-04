import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { Txt } from "@/components/kit/Txt";
import { PressableScale, type HapticStyle } from "@/components/ui/PressableScale";
import { color, radius } from "@/theme/tokens";

/**
 * YUVARLAK İKON DÜĞMESİ — başlıktaki zil/menü, kart köşesindeki ok (şablonun "↗" düğmesi).
 * `size` dış ölçü (dokunma hedefi ≥ 40), ikon ölçüsü orantılı. SymbolView'a ölçü STYLE ile verilir.
 */
export function IconButton({
  icon,
  onPress,
  size = 40,
  tint = color.text,
  badge,
  badgeColor = color.bad,
  accent = false,
  haptic = "hafif",
  style,
  accessibilityLabel,
}: {
  icon: SymbolViewProps["name"];
  onPress?: () => void;
  size?: number;
  tint?: string;
  /** Sağ üstte rozet sayısı; 0/undefined ise çizilmez. */
  badge?: number;
  badgeColor?: string;
  /** Mor dolgulu (birincil eylem). */
  accent?: boolean;
  haptic?: HapticStyle;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const ikon = Math.round(size * 0.48);
  return (
    <PressableScale
      onPress={onPress}
      disabled={!onPress}
      haptic={haptic}
      scaleTo={0.9}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.btn,
        { width: size, height: size, borderRadius: size / 2 },
        accent ? styles.accent : null,
        style,
      ]}
    >
      <SymbolView
        name={icon}
        tintColor={accent ? color.onAccent : tint}
        weight="semibold"
        style={{ width: ikon, height: ikon }}
      />
      {badge ? (
        <View style={[styles.badge, { backgroundColor: badgeColor }]}>
          <Txt v="label" tone="onAccent" num style={styles.badgeText}>
            {badge > 9 ? "9+" : badge}
          </Txt>
        </View>
      ) : null}
    </PressableScale>
  );
}

/** Kart köşesindeki küçük ok — "detaya git" işareti (şablon dili). */
export function CornerArrow({ onPress, style }: { onPress?: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <IconButton
      icon="arrow.up.right"
      size={32}
      tint={color.textDim}
      onPress={onPress}
      haptic="yok"
      style={[{ backgroundColor: color.tintStrong }, style]}
      accessibilityLabel="Detay"
    />
  );
}

const styles = StyleSheet.create({
  btn: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.tint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  accent: { backgroundColor: color.accent, borderColor: color.accentBright },
  badge: {
    position: "absolute",
    top: -3,
    right: -3,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: color.bg0,
  },
  badgeText: { fontSize: 10, lineHeight: 12 },
});
