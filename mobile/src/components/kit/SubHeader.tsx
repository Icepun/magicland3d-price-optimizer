import { router } from "expo-router";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { IconButton } from "@/components/kit/IconButton";
import { Txt } from "@/components/kit/Txt";
import { space } from "@/theme/tokens";

/**
 * ALT EKRAN BAŞLIĞI — yuvarlak geri düğmesi solda, yanında sola hizalı başlık + alt satır, sağda
 * isteğe bağlı eylem (masaüstündeki alt sayfa başlığı). Tüm alt ekranlar aynı çubuğu kullanır.
 */
export function SubHeader({
  title,
  subtitle,
  right,
  onBack,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onBack?: () => void;
}) {
  return (
    <View style={styles.bar}>
      <IconButton
        icon="chevron.left"
        onPress={onBack ?? (() => router.back())}
        accessibilityLabel="Geri"
        haptic="yok"
      />
      <View style={styles.center}>
        <Txt v="heading" numberOfLines={1}>
          {title}
        </Txt>
        {subtitle ? (
          <Txt v="small" tone="faint" numberOfLines={1}>
            {subtitle}
          </Txt>
        ) : null}
      </View>
      <View style={styles.right}>{right ?? null}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.md,
    minHeight: 60,
  },
  center: { flex: 1, minWidth: 0, gap: 1 },
  right: { alignItems: "flex-end" },
});
