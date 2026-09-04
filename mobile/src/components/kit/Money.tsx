import { useEffect, useRef, useState } from "react";
import { View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";

import { useReduceMotion } from "@/components/fade-in";
import { Txt, type TxtTone, type TxtVariant } from "@/components/kit/Txt";
import { formatCurrency, formatNumber } from "@/lib/format";
import { motion } from "@/theme/tokens";

/**
 * Sayıyı 0'dan (veya bir önceki değerden) hedefe akıtır; "hareketi azalt" açıkken anında geçer.
 * `fade-in.tsx`'teki AnimatedNumber'ın hook hâli: iki ayrı Text'e (tam kısım + kuruş) bölmek için.
 */
export function useCountUp(value: number, durationMs: number = motion.number): number {
  const reduceMotion = useReduceMotion();
  const [display, setDisplay] = useState(0);
  const displayRef = useRef(0);

  useEffect(() => {
    const to = Number.isFinite(value) ? value : 0;
    const from = displayRef.current;
    if (from === to) return;
    if (reduceMotion || durationMs <= 0) {
      displayRef.current = to;
      const id = requestAnimationFrame(() => setDisplay(to));
      return () => cancelAnimationFrame(id);
    }
    const start = Date.now();
    let raf = 0;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / durationMs);
      const next = t < 1 ? from + (to - from) * ease(t) : to;
      displayRef.current = next;
      setDisplay(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs, reduceMotion]);

  return display;
}

/**
 * PARA — şablondaki "18,850 +812" dili: tam kısım büyük, kuruş ve para işareti küçük.
 * `formatCurrency` ne üretiyorsa (₺136.415,81) onu ayırır; biçim tek kaynakta kalır.
 */
export function Money({
  value,
  v = "stat",
  tone = "default",
  animate = true,
  compact = false,
  style,
  unitStyle,
}: {
  value: number;
  v?: TxtVariant;
  tone?: TxtTone;
  animate?: boolean;
  /** Kuruşu gizle (özet satırları). */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  unitStyle?: StyleProp<TextStyle>;
}) {
  const shown = useCountUp(value, animate ? motion.number : 0);
  const text = formatCurrency(shown);
  const virgul = text.lastIndexOf(",");
  const tam = virgul >= 0 ? text.slice(0, virgul) : text;
  const kurus = virgul >= 0 ? text.slice(virgul) : "";
  return (
    <View style={[{ flexDirection: "row", alignItems: "baseline" }, style]}>
      <Txt v={v} tone={tone} num numberOfLines={1}>
        {tam}
      </Txt>
      {!compact && kurus ? (
        <Txt v="statUnit" tone={tone === "default" ? "dim" : tone} num style={unitStyle}>
          {kurus}
        </Txt>
      ) : null}
    </View>
  );
}

/** ADET/SAYI — akan tam sayı (varsayılan biçim tr-TR binlik ayraçlı). */
export function Count({
  value,
  format,
  v = "stat",
  tone = "default",
  animate = true,
  style,
}: {
  value: number;
  format?: (n: number) => string;
  v?: TxtVariant;
  tone?: TxtTone;
  animate?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  const shown = useCountUp(value, animate ? motion.number : 0);
  return (
    <Txt v={v} tone={tone} num numberOfLines={1} style={style}>
      {format ? format(shown) : formatNumber(Math.round(shown))}
    </Txt>
  );
}
