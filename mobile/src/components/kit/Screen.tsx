import type { ReactNode } from "react";
import { RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import { color, space } from "@/theme/tokens";

/**
 * EKRAN KABI — her ekran aynı iskelet: şeffaf zemin (Backdrop kökte), üstte güvenli alan,
 * altında başlık, sonra kaydırılabilir içerik. Yatay boşluk tek yerden (space.lg).
 *
 * Liste ekranları (FlashList) `scroll={false}` verip listeyi kendisi yerleştirir; kaydırma
 * konteyneri iç içe olmasın.
 */
export function Screen({
  children,
  header,
  scroll = true,
  padded = true,
  refreshing = false,
  onRefresh,
  edges = ["top"],
  contentStyle,
  style,
}: {
  children?: ReactNode;
  header?: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  edges?: Edge[];
  contentStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
}) {
  const icerik = [padded ? styles.padded : null, styles.content, contentStyle];
  return (
    <SafeAreaView style={[styles.safe, style]} edges={edges}>
      {header}
      {scroll ? (
        <ScrollView
          contentContainerStyle={icerik}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? (
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.accentBright} />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.fill, padded ? styles.padded : null]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "transparent" },
  fill: { flex: 1 },
  padded: { paddingHorizontal: space.lg },
  content: { paddingTop: space.sm, paddingBottom: space.xxl, gap: space.md },
});
