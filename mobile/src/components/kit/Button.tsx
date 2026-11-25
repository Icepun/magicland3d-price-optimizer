import { LinearGradient } from "expo-linear-gradient";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { ActivityIndicator, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { Txt } from "@/components/kit/Txt";
import { PressableScale } from "@/components/kit/PressableScale";
import { color, gradient, space } from "@/theme/tokens";

type Variant = "primary" | "secondary" | "danger" | "ghost";

/**
 * DÜĞME — dört ton: primary (logodaki mor→mavi geçiş + hafif parıltı, masaüstüyle aynı),
 * secondary (soluk yüzey), danger (gül ton), ghost (yalnız metin). Küçük boy çip gibi satır içi, büyük boy formun sonundaki tam genişlik.
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
      style={[styles.base, styles[variant], size === "sm" ? styles.sm : styles.lg, (disabled || loading) && variant === "primary" ? styles.sonuk : null, style]}
    >
      {variant === "primary" ? (
        <LinearGradient
          colors={gradient.brand}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={[StyleSheet.absoluteFill, { borderRadius: size === "sm" ? 12 : 14 }]}
        />
      ) : null}
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
    borderWidth: StyleSheet.hairlineWidth,
  },
  lg: { minHeight: 52, paddingHorizontal: space.xl, borderRadius: 14 },
  sm: { minHeight: 36, paddingHorizontal: space.md, borderRadius: 12 },
  primary: {
    backgroundColor: color.accent,
    borderColor: "rgba(255,255,255,0.16)",
    shadowColor: color.accent,
    shadowOpacity: 0.55,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
  },
  sonuk: { opacity: 0.55 },
  secondary: { backgroundColor: color.tint, borderColor: color.lineStrong },
  danger: { backgroundColor: "rgba(251, 113, 133, 0.1)", borderColor: "rgba(251, 113, 133, 0.3)" },
  ghost: { backgroundColor: "transparent", borderColor: "transparent" },
  iconLg: { width: 18, height: 18 },
  iconSm: { width: 14, height: 14 },
});
