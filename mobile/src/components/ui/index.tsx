import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";

import { Skeleton, SkeletonCard } from "@/components/fade-in";
import { PressableScale } from "@/components/ui/PressableScale";
import { ML, elevation, radius, space, tabular, type } from "@/theme/colors";

/**
 * ORTAK ARAYÜZ KİTİ — tek tasarım dili.
 *
 * NEDEN: aynı kart tanımı (zemin + kenarlık + köşe + iç boşluk) 15 ayrı ekran dosyasına
 * kopyalanmıştı; dördü birbirinden az da olsa farklıydı. Bir tasarım kararını değiştirmek
 * 15 dosya gezmek demekti ve pratikte ekranlar birbirinden uzaklaşıyordu. Bundan sonra
 * yeni/dokunulan her ekran bu kitten besleniyor.
 */

/** Standart yüzey. `onPress` verilirse dokunma geri bildirimi (yay + titreşim) otomatik gelir. */
export function Card({
  children,
  style,
  onPress,
  accent,
  padded = true,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  /** Sol kenarda ince renk şeridi (platform/durum rengi) — kartın kimliğini bir bakışta verir. */
  accent?: string;
  padded?: boolean;
}) {
  const body = (
    <View
      style={[
        styles.card,
        padded && { padding: space.lg },
        accent ? { borderLeftWidth: 3, borderLeftColor: accent } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <PressableScale onPress={onPress} accessibilityRole="button">
      {body}
    </PressableScale>
  );
}

/** Bölüm başlığı — listeler arasında görsel nefes. */
export function SectionLabel({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.sectionLabel, style]}>{children}</Text>;
}

/** Küçük yuvarlak etiket (platform, durum, sayı). */
export function Pill({
  children,
  color = ML.accent,
  style,
}: {
  children: React.ReactNode;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.pill, { backgroundColor: color + "22" }, style]}>
      <Text style={[styles.pillText, { color }]} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

/** Seçilebilir filtre çipi — seçiliyken dolu, değilken çerçeveli. */
export function Chip({
  label,
  selected,
  onPress,
  count,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  count?: number;
}) {
  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.94}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[styles.chip, selected && styles.chipOn]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>
        {label}
        {count != null ? ` ${count}` : ""}
      </Text>
    </PressableScale>
  );
}

/** Özet kutusu (Panel/rapor başlıkları). Rakam sabit genişlikte — akarken zıplamaz. */
export function StatTile({
  label,
  value,
  hint,
  color = ML.text,
  style,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.stat, style]}>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.statValue, tabular, { color }]} numberOfLines={1}>
        {value}
      </Text>
      {hint ? (
        <Text style={styles.statHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * BOŞ DURUM — hata durumundan AYRI (bkz. ConnectionError).
 * Metnin yanında bir eylem sunar: boş ekran kullanıcıyı çıkmaza sokmasın.
 */
export function EmptyState({
  icon = "tray",
  title,
  hint,
  actionLabel,
  onAction,
}: {
  icon?: SymbolViewProps["name"];
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.empty}>
      <SymbolView name={icon} size={44} tintColor={ML.textFaint} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
      {actionLabel && onAction ? (
        <PressableScale onPress={onAction} style={styles.emptyBtn} accessibilityRole="button">
          <Text style={styles.emptyBtnText}>{actionLabel}</Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: ML.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    ...elevation.card,
  },
  sectionLabel: {
    ...type.label,
    color: ML.textFaint,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: space.sm,
  },
  pill: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: 999 },
  pillText: { ...type.label },
  chip: {
    minHeight: 36, // tek elle dokunma hedefi
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ML.border,
    backgroundColor: "transparent",
  },
  chipOn: { backgroundColor: ML.accentSoft, borderColor: ML.accent },
  chipText: { ...type.small, color: ML.textDim },
  chipTextOn: { color: ML.text, fontWeight: "700" },
  stat: { gap: 2, flex: 1 },
  statLabel: { ...type.label, color: ML.textFaint },
  statValue: { ...type.stat },
  statHint: { ...type.small, color: ML.textFaint },
  empty: { alignItems: "center", justifyContent: "center", paddingVertical: 48, gap: space.sm },
  emptyTitle: { ...type.heading, color: ML.text, marginTop: space.sm },
  emptyHint: { ...type.small, color: ML.textDim, textAlign: "center", paddingHorizontal: space.xl },
  emptyBtn: {
    marginTop: space.md,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: space.xl,
    borderRadius: radius.sm,
    backgroundColor: ML.accentSoft,
    borderWidth: 1,
    borderColor: ML.accent + "66",
  },
  emptyBtnText: { ...type.body, color: ML.text, fontWeight: "700" },
});

/**
 * LİSTE YÜKLENİYOR — tam sayfa dönen çark yerine içeriğin İSKELETİ.
 *
 * NEDEN: 13 ekran boş bir çarkla açılıyordu. Çark "bir şey oluyor" der ama NE geleceğini
 * söylemez; iskelet sayfanın şeklini önceden gösterir, bu yüzden bekleme daha kısa hissedilir
 * ve içerik gelince sayfa zıplamaz. Kademeli gecikme, satırların sırayla belirmesini sağlar.
 */
export function SkeletonList({ count = 6, height = 84 }: { count?: number; height?: number }) {
  return (
    <View style={{ padding: space.lg, gap: space.md }}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} height={height} delay={i * 70} />
      ))}
    </View>
  );
}

/** FORM YÜKLENİYOR — etiket + alan çiftleri. Düzenleme ekranlarının şekli listeden farklı. */
export function SkeletonForm({ rows = 5 }: { rows?: number }) {
  return (
    <View style={{ padding: space.lg, gap: space.xl }}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ gap: space.sm }}>
          <Skeleton width="35%" height={11} delay={i * 70} />
          <Skeleton width="100%" height={44} radius={radius.sm} delay={i * 70 + 60} />
        </View>
      ))}
    </View>
  );
}
