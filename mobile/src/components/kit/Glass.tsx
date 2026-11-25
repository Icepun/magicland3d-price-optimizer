import { LinearGradient } from "expo-linear-gradient";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { PressableScale, type HapticStyle } from "@/components/kit/PressableScale";
import { Txt } from "@/components/kit/Txt";
import { color, gradient, radius, space } from "@/theme/tokens";

/**
 * KART — masaüstünün kart dili (`RaporKart`): düz koyu yüzey (#131720), ince açık kenarlık, üst
 * kenarda 1 px ışık çizgisi ve altta yumuşak gölge. Adı tarihsel ("Glass"): eskiden bulanık
 * camdı; düz kart hem masaüstüyle aynı görünüyor hem de bulanıklık maliyeti yok.
 *
 * Gölge dış kapta, köşe kırpması iç kapta — ikisi aynı View'da olursa iOS gölgeyi kesiyor.
 */
export function Glass({
  children,
  style,
  strong = false,
  radius: r = radius.lg,
  padded = true,
  onPress,
  haptic,
  accessibilityLabel,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Biraz daha açık yüzey — kart içinde öne çıkan kart. */
  strong?: boolean;
  /** Eski çağıranlar için duruyor (bulanıklık yok). */
  intensity?: number;
  radius?: number;
  padded?: boolean;
  onPress?: () => void;
  haptic?: HapticStyle;
  accessibilityLabel?: string;
}) {
  /**
   * Çağıranın stili İKİYE bölünür: yerleşim anahtarları (flex, genişlik, kenar boşluğu) dış
   * kaba, kalanı (flexDirection, gap, hizalama, iç boşluk, kenarlık rengi) İÇ içerik kabına.
   * Aksi hâlde `style={{ flexDirection: "row" }}` dış kaba gidiyor ve çocuklar yine alt alta
   * diziliyordu (sipariş detayındaki halka kartın altına düşmüştü).
   */
  const dis = yerlesim(style);
  const ic = icerik(style);
  const body = (
    <View style={[styles.golge, { borderRadius: r }, onPress ? null : dis]}>
      <View
        style={[
          styles.kart,
          { borderRadius: r, backgroundColor: strong ? "#161B25" : color.card },
          padded ? styles.padded : null,
          ic,
        ]}
      >
        <View pointerEvents="none" style={[styles.edge, { left: r, right: r }]} />
        {children}
      </View>
    </View>
  );
  if (!onPress) return body;
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
 * SATIR YÜZEYİ — liste satırları, kutular, çipler. `strong` = kart (masaüstündeki satır kartı),
 * değilse kartın içindeki soluk iç yüzey. Gölgesiz (yüzlerce satırda ucuz kalsın).
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
    { borderRadius: r, backgroundColor: strong ? color.card : color.tint },
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

/**
 * İKON KUTUSU — masaüstündeki mor→mavi geçişli kare. `dolu` = başlıktaki büyük, parlak hâli
 * (beyaz ikon); değilse bölüm başlığındaki soluk hâli (lavanta ikon).
 */
export function IkonKutusu({
  icon,
  size = 32,
  dolu = false,
  tint,
  style,
}: {
  icon: SymbolViewProps["name"];
  size?: number;
  dolu?: boolean;
  /** Geçiş yerine düz renk (ör. uyarı kutusu). */
  tint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const r = Math.round(size * (dolu ? 0.36 : 0.28));
  const ikon = Math.round(size * (dolu ? 0.46 : 0.5));
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: r },
        dolu ? styles.parlak : null,
        style,
      ]}
    >
      {tint ? (
        <View style={[StyleSheet.absoluteFill, { borderRadius: r, backgroundColor: tint + "26" }]} />
      ) : (
        <LinearGradient
          colors={dolu ? gradient.brand : gradient.soft}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFill, { borderRadius: r }]}
        />
      )}
      <View style={[StyleSheet.absoluteFill, styles.ikonOrta, { borderRadius: r }, dolu || tint ? null : styles.ikonKenar]}>
        <SymbolView
          name={icon}
          tintColor={dolu ? color.onAccent : tint ?? color.lavender}
          weight="semibold"
          style={{ width: ikon, height: ikon }}
        />
      </View>
    </View>
  );
}

/**
 * BÖLÜM KARTI — masaüstünün `RaporKart`ı: üstte ikon kutusu + başlık + kısa açıklama, sağda
 * isteğe bağlı eylem; altında içerik. Eski "BÜYÜK HARF etiket + kart" düzeninin yerine.
 */
export function Bolum({
  title,
  desc,
  icon,
  right,
  children,
  style,
  padded = true,
  onPress,
  accessibilityLabel,
}: {
  title: string;
  desc?: ReactNode;
  icon?: SymbolViewProps["name"];
  right?: ReactNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** İçerik iç boşluğu (liste gibi kenara dayanan içerik için false). */
  padded?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Glass padded={false} style={style} onPress={onPress} accessibilityLabel={accessibilityLabel ?? title}>
      <View style={styles.bolumBas}>
        {icon ? <IkonKutusu icon={icon} /> : null}
        <View style={styles.bolumBaslik}>
          <Txt v="bodyStrong" numberOfLines={1}>
            {title}
          </Txt>
          {desc ? (
            typeof desc === "string" ? (
              <Txt v="small" tone="faint" numberOfLines={1}>
                {desc}
              </Txt>
            ) : (
              desc
            )
          ) : null}
        </View>
        {right}
      </View>
      {children != null ? <View style={padded ? styles.bolumIcerik : styles.bolumIcerikDuz}>{children}</View> : null}
    </Glass>
  );
}

const styles = StyleSheet.create({
  golge: {
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 12 },
  },
  kart: {
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  edge: {
    position: "absolute",
    top: 0,
    height: 1,
    backgroundColor: color.edge,
  },
  tint: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  padded: { padding: space.lg },
  parlak: {
    shadowColor: color.accent,
    shadowOpacity: 0.55,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
  },
  ikonOrta: { alignItems: "center", justifyContent: "center" },
  ikonKenar: { borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)" },
  bolumBas: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingTop: space.lg },
  bolumBaslik: { flex: 1, minWidth: 0, gap: 1 },
  bolumIcerik: { padding: space.lg, paddingTop: space.md },
  bolumIcerikDuz: { paddingTop: space.md },
});
