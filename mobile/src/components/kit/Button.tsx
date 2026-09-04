import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { ActivityIndicator, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { Txt } from "@/components/kit/Txt";
import { PressableScale } from "@/components/ui/PressableScale";
import { color, radius, space } from "@/theme/tokens";

type Variant = "primary" | "secondary" | "danger" | "ghost";

/**
 * DÜĞME — dört ton: primary (mor dolgu), secondary (saydam yüzey), danger (kırmızı ton),
 * ghost (yalnız metin). Küçük boy çip gibi satır içi, büyük boy formun sonundaki tam genişlik.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  size = "lg",
  icon,
  loading = false,
  disabled = false,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  size?: "sm" | "lg";
  icon?: SymbolViewProps["name"];
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const metin = variant === "primary" ? color.onAccent : variant === "danger" ? color.bad : color.text;
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled || loading}
      haptic={variant === "danger" ? "orta" : "hafif"}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.base, styles[variant], size === "sm" ? styles.sm : styles.lg, style]}
    >
      {loading ? (
        <ActivityIndicator color={metin} />
      ) : (
        <>
          {icon ? (
            <SymbolView name={icon} tintColor={metin} weight="semibold" style={size === "sm" ? styles.iconSm : styles.iconLg} />
          ) : null}
          <Txt v={size === "sm" ? "smallStrong" : "bodyStrong"} style={{ color: metin }} numberOfLines={1}>
            {label}
          </Txt>
        </>
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  lg: { minHeight: 52, paddingHorizontal: space.xl },
  sm: { minHeight: 36, paddingHorizontal: space.md },
  primary: { backgroundColor: color.accent, borderColor: color.accentBright },
  secondary: { backgroundColor: color.tintStrong, borderColor: color.lineStrong },
  danger: { backgroundColor: color.badSoft, borderColor: color.bad + "66" },
  ghost: { backgroundColor: "transparent", borderColor: "transparent" },
  iconLg: { width: 18, height: 18 },
  iconSm: { width: 14, height: 14 },
});
