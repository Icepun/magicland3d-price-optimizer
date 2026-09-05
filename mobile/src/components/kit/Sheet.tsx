import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { BlurView } from "expo-blur";
import { forwardRef, useCallback, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { blur, color, radius, space } from "@/theme/tokens";

/**
 * ALTTAN AÇILAN SAYFA — filtreler, eylem menüleri, kısa formlar.
 *
 * @gorhom/bottom-sheet saf JS (Reanimated + gesture-handler) → OTA ile gelir. Yüzey cam:
 * arkadaki ekran bulanık görünür; el tutamacı ve köşe yarıçapı şablonla aynı dilde.
 * Yükseklik içeriğe göre (dynamic sizing); uzun içerikte `snapPoints` ver.
 */
export const Sheet = forwardRef<
  BottomSheetModal,
  {
    children: ReactNode;
    snapPoints?: (string | number)[];
    onDismiss?: () => void;
  }
>(function Sheet({ children, snapPoints, onDismiss }, ref) {
  const insets = useSafeAreaInsets();
  const renderBackdrop = useCallback(
    (p: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.55} pressBehavior="close" />
    ),
    []
  );
  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={snapPoints}
      enableDynamicSizing={!snapPoints}
      onDismiss={onDismiss}
      backdropComponent={renderBackdrop}
      backgroundComponent={SheetBackground}
      handleIndicatorStyle={styles.handle}
    >
      <BottomSheetView style={[styles.content, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
        {children}
      </BottomSheetView>
    </BottomSheetModal>
  );
});

function SheetBackground() {
  return (
    <View style={styles.bg}>
      <BlurView intensity={blur.sheet} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color.glassStrong }]} />
    </View>
  );
}

/**
 * KULLANIM: `const ref = useRef<BottomSheetModal>(null)` → `ref.current?.present()` / `.dismiss()`.
 * ⚠️ Bunu saran bir `useSheet()` yardımcısı YAZILMADI: React Compiler, ref taşıyan nesnenin
 * render'da okunmasını "ref erişimi" sayıp lint'i düşürüyor (Header'da yaşandı).
 */

const styles = StyleSheet.create({
  bg: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  handle: { backgroundColor: color.lineStrong, width: 40, height: 5 },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm },
});
