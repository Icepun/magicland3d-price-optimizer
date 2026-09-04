import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { Txt } from "@/components/kit/Txt";
import { PressableScale } from "@/components/kit/PressableScale";
import { color, radius, space } from "@/theme/tokens";

/** SÜZGEÇ ÇİPİ — seçiliyken mor ton + mor kenarlık; sayı varsa yanında soluk. */
export function Chip({
  label,
  count,
  selected = false,
  onPress,
  dot,
  style,
}: {
  label: string;
  count?: number;
  selected?: boolean;
  onPress?: () => void;
  /** Solda renkli nokta (platform rengi). */
  dot?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.94}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[styles.chip, selected ? styles.on : null, style]}
    >
      {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
      <Txt v="smallStrong" tone={selected ? "default" : "dim"} numberOfLines={1}>
        {label}
      </Txt>
      {count != null ? (
        <Txt v="small" tone={selected ? "accent" : "faint"} num>
          {count}
        </Txt>
      ) : null}
    </PressableScale>
  );
}

/** Küçük durum rozeti — "Yeni", "Kargoda", "Sipariş üzerine". */
export function Pill({
  children,
  color: renk = color.accentBright,
  style,
}: {
  children: React.ReactNode;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.pill, { backgroundColor: renk + "26" }, style]}>
      <Txt v="label" style={{ color: renk }} numberOfLines={1}>
        {children}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.tint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  on: { backgroundColor: color.accentSoft, borderColor: color.accent, borderWidth: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pill: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, alignSelf: "flex-start" },
});
