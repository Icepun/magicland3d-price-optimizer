import * as Haptics from "expo-haptics";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import { useReduceMotion } from "@/components/fade-in";

const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable);

/** Basış hissi — yay sertliği tek yerde ki tüm uygulama AYNI ritimde tepki versin. */
const SPRING = { damping: 15, stiffness: 320, mass: 0.5 } as const;

export type HapticStyle = "hafif" | "orta" | "yok";

/**
 * Dokununca hafifçe küçülen + titreşen basılabilir yüzey.
 *
 * NEDEN: uygulamadaki 20'den fazla dokunma hedefi yalnız saydamlık değiştiriyordu ("opacity")
 * — bu, dokunuşun kaydedilip kaydedilmediğini belli etmiyor ve uygulamayı ucuz gösteriyordu.
 * Tek bileşen tüm uygulamanın hissini değiştirir; bu yüzden kart, buton, çip ve liste satırı
 * hepsi buradan geçer.
 *
 * ERİŞİLEBİLİRLİK: "Hareketi azalt" açıkken ölçek animasyonu kapanır (yalnız hafif saydamlık
 * kalır) ama TİTREŞİM kapanmaz — dokunsal geri bildirim hareket değildir ve görme/dikkat
 * güçlüğü olan kullanıcı için asıl faydalı olan odur. Kullanıcı isterse titreşimi Ayarlar'dan
 * ayrıca kapatabilir (`haptic="yok"` ile çağrılır).
 */
export function PressableScale({
  children,
  style,
  haptic = "hafif",
  scaleTo = 0.97,
  disabled,
  onPress,
  ...rest
}: Omit<PressableProps, "style"> & {
  /**
   * Hem düz stil hem `({ pressed }) => …` fonksiyon stili kabul edilir.
   * Mevcut ekranların çoğu fonksiyon stiliyle "basılıyken saydamlık" yapıyordu; bileşen bunu
   * desteklemeseydi 16 dosyayı elle yeniden yazmak gerekirdi (ve o dönüşümde JSX bozulmuştu).
   */
  style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
  /** Titreşim şiddeti — yıkıcı/önemli aksiyonlarda "orta". */
  haptic?: HapticStyle;
  scaleTo?: number;
  children?: React.ReactNode;
}) {
  const reduceMotion = useReduceMotion();
  // ⚠️ `.get()/.set()` KULLANILIR, `.value` DEĞİL: React Compiler `.value` atamasını
  // "değiştirilemez değeri değiştirme" hatası sayıyor (mobil lint adımını düşürür).
  // Reanimated 4 bu erişimciler için tasarlandı; davranış aynı.
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={(e) => {
        if (!disabled && !reduceMotion) scale.set(withSpring(scaleTo, SPRING));
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.set(withSpring(1, SPRING));
        rest.onPressOut?.(e);
      }}
      onPress={(e) => {
        if (!disabled && haptic !== "yok") {
          // Titreşim BEKLENMEZ: hata verirse (simülatör/izin) aksiyon yine çalışsın.
          void Haptics.impactAsync(
            haptic === "orta" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light
          ).catch(() => {});
        }
        onPress?.(e);
      }}
      style={({ pressed }) => [
        typeof style === "function" ? style({ pressed }) : style,
        animatedStyle,
        // Hareket azaltılmışsa ölçek yok → geri bildirim saydamlıkla verilir.
        reduceMotion && pressed && { opacity: 0.7 },
        disabled && { opacity: 0.5 },
      ]}
    >
      {children}
    </AnimatedPressable>
  );
}
