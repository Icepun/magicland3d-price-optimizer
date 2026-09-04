import { Text, type TextProps } from "react-native";

import { color, tabular, type as typo } from "@/theme/tokens";

export type TxtVariant = keyof typeof typo;
export type TxtTone = "default" | "dim" | "faint" | "accent" | "good" | "bad" | "warn" | "info" | "onAccent";

const TONE: Record<TxtTone, string> = {
  default: color.text,
  dim: color.textDim,
  faint: color.textFaint,
  accent: color.accentBright,
  good: color.good,
  bad: color.bad,
  warn: color.warn,
  info: color.info,
  onAccent: color.onAccent,
};

/**
 * METİN — tek yazı tipi, tek punto ölçeği.
 *
 * Eski ekranlarda her Text kendi fontSize/fontWeight/color üçlüsünü yazıyordu (18 farklı punto).
 * Burada varyant (`v`) ölçekten, ton (`tone`) paletten gelir; `num` sabit genişlikli rakam açar
 * (para/adet/yüzde gösteren HER metin). Ağırlık aile adında olduğu için fontWeight verilmez.
 */
export function Txt({
  v = "body",
  tone = "default",
  num = false,
  center = false,
  style,
  ...rest
}: TextProps & {
  v?: TxtVariant;
  tone?: TxtTone;
  /** Sabit genişlikli rakamlar — akan sayı kartı titretmesin. */
  num?: boolean;
  center?: boolean;
}) {
  return (
    <Text
      {...rest}
      style={[
        typo[v],
        { color: TONE[tone] },
        num ? tabular : null,
        center ? { textAlign: "center" } : null,
        style,
      ]}
    />
  );
}
