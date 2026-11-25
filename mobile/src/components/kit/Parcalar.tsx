import type { SymbolViewProps } from "expo-symbols";
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { IkonKutusu, Tint } from "@/components/kit/Glass";
import { Progress } from "@/components/kit/Progress";
import { Txt, type TxtTone } from "@/components/kit/Txt";
import { color, space } from "@/theme/tokens";

/**
 * MASAÜSTÜ PARÇALARI — onaylı telefon önizlemesindeki (25 Kas 2026) tekrar eden küçük düzenler.
 * Ekranlar aynı görünümü kendi başına yeniden çizmesin diye burada.
 */

/** KPI KUTUSU — masaüstündeki "Kutu": küçük ikon kutusu, etiket, büyük değer, isteğe bağlı alt satır. */
export function StatKutu({
  icon,
  label,
  children,
  alt,
  onPress,
  style,
  accessibilityLabel,
}: {
  icon: SymbolViewProps["name"];
  label: string;
  /** Değer (genellikle <Money>/<Count>/<Txt v="stat">). */
  children: ReactNode;
  alt?: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  return (
    <Tint strong onPress={onPress} style={[styles.kutu, style]} accessibilityLabel={accessibilityLabel ?? label}>
      <IkonKutusu icon={icon} size={26} />
      <Txt v="small" tone="faint" numberOfLines={1} style={{ marginTop: space.sm }}>
        {label}
      </Txt>
      {children}
      {alt ? (
        typeof alt === "string" ? (
          <Txt v="label" tone="faint" numberOfLines={1}>
            {alt}
          </Txt>
        ) : (
          alt
        )
      ) : null}
    </Tint>
  );
}

/** ETİKET — DEĞER SATIRI (kâr dökümü, ayrıntılar). `kalin` = toplam satırı (üstte ince çizgi). */
export function DegerSatiri({
  label,
  value,
  tone,
  kalin = false,
  ipucu,
}: {
  label: string;
  value: ReactNode;
  tone?: TxtTone;
  kalin?: boolean;
  /** Etiketin altında soluk açıklama (ör. "8 desi · 5–10 desi baremi"). */
  ipucu?: string;
}) {
  return (
    <View style={kalin ? styles.toplam : null}>
      <View style={styles.satir}>
        <Txt v={kalin ? "bodyStrong" : "small"} tone={kalin ? "default" : "dim"} style={{ flex: 1 }} numberOfLines={1}>
          {label}
        </Txt>
        {typeof value === "string" || typeof value === "number" ? (
          <Txt v={kalin ? "bodyStrong" : "smallStrong"} tone={tone} num>
            {value}
          </Txt>
        ) : (
          value
        )}
      </View>
      {ipucu ? (
        <Txt v="label" tone="faint" numberOfLines={1} style={{ marginTop: 2 }}>
          {ipucu}
        </Txt>
      ) : null}
    </View>
  );
}

/** RENKLİ SATIR + DOLAN ÇUBUK — platform payı / marjı (masaüstü Panel'deki gibi). */
export function CubukSatiri({
  renk,
  label,
  meta,
  sag,
  oran,
  rozet,
  alt,
}: {
  renk: string;
  label: string;
  /** Etiketin sağında soluk bilgi (ör. "147 sip."). */
  meta?: string;
  /** En sağdaki değer. */
  sag?: ReactNode;
  /** 0..1 */
  oran: number;
  /** Etiket ile değer arasında küçük rozet (ör. "3 zarar eden"). */
  rozet?: ReactNode;
  alt?: string;
}) {
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.satir}>
        <View style={[styles.nokta, { backgroundColor: renk }]} />
        <Txt v="smallStrong" style={{ flex: 1 }} numberOfLines={1}>
          {label}
        </Txt>
        {rozet}
        {meta ? (
          <Txt v="small" tone="faint" num>
            {meta}
          </Txt>
        ) : null}
        {typeof sag === "string" ? (
          <Txt v="smallStrong" num style={styles.sag}>
            {sag}
          </Txt>
        ) : (
          sag
        )}
      </View>
      <Progress value={oran} color={renk} height={6} />
      {alt ? (
        <Txt v="label" tone="faint" num>
          {alt}
        </Txt>
      ) : null}
    </View>
  );
}

/** Kart dışındaki küçük bölüm başlığı ("SON SİPARİŞLER"). */
export function BolumEtiketi({ children, sag, style }: { children: string; sag?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.etiket, style]}>
      <Txt v="label" tone="faint" style={{ flex: 1, letterSpacing: 0.8 }}>
        {children.toLocaleUpperCase("tr-TR")}
      </Txt>
      {sag}
    </View>
  );
}

/** Sakin bilgi notu (lavanta) — "108 üründe maliyet girilmemiş" gibi. */
export function NotSatiri({
  icon = "info.circle.fill",
  children,
  onPress,
  ton = "caution",
  sag,
}: {
  icon?: SymbolViewProps["name"];
  children: ReactNode;
  onPress?: () => void;
  ton?: "caution" | "bad" | "warn" | "good";
  sag?: ReactNode;
}) {
  const renk = ton === "bad" ? color.bad : ton === "warn" ? color.warn : ton === "good" ? color.good : color.caution;
  const zemin = ton === "bad" ? color.badSoft : ton === "warn" ? color.warnSoft : ton === "good" ? color.goodSoft : color.cautionSoft;
  return (
    <Tint onPress={onPress} padded={false} style={[styles.not, { backgroundColor: zemin, borderColor: renk + "40" }]}>
      <IkonKutusu icon={icon} size={30} tint={renk} />
      <View style={{ flex: 1 }}>{typeof children === "string" ? <Txt v="small">{children}</Txt> : children}</View>
      {sag}
    </Tint>
  );
}

const styles = StyleSheet.create({
  kutu: { flex: 1, padding: space.md, gap: 2, minHeight: 104 },
  satir: { flexDirection: "row", alignItems: "center", gap: space.sm },
  toplam: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.lineStrong, paddingTop: space.sm, marginTop: 2 },
  nokta: { width: 8, height: 8, borderRadius: 4 },
  sag: { minWidth: 72, textAlign: "right" },
  etiket: { flexDirection: "row", alignItems: "center", marginTop: space.sm, marginLeft: space.xs },
  not: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
});
