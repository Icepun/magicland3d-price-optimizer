import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import { useReduceMotion } from "@/components/kit/motion";

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

  /**
   * ⚠️ BASILI DURUMU KENDİMİZ TUTUYORUZ — `style={({ pressed }) => …}` KULLANILAMAZ.
   *
   * Reanimated'in animated bileşeni FONKSİYON STİLİNİ ÇÖZEMİYOR ve stilin TAMAMINI sessizce
   * düşürüyor. Bir tur bu bileşen fonksiyon stili veriyordu; sonuç: uygulamadaki HER dokunulabilir
   * yüzey (kartlar, liste satırları, çipler, düğmeler, zil) stilsiz kaldı — arka planlar,
   * kenarlıklar ve ölçüler kayboldu. Ekranda "her şey bozuk" görünmesinin sebebi buydu ve
   * derleme/lint/test hiçbiri yakalayamaz.
   *
   * Basılı durumu `useState` ile tutup DÜZ DİZİ stil veriyoruz. Ek render yalnız dokunma anında.
   */
  const [pressed, setPressed] = useState(false);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={(e) => {
        setPressed(true);
        if (!disabled && !reduceMotion) scale.set(withSpring(scaleTo, SPRING));
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        setPressed(false);
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
      style={[
        typeof style === "function" ? style({ pressed }) : style,
        animatedStyle,
        // Hareket azaltılmışsa ölçek yok → geri bildirim saydamlıkla verilir.
        reduceMotion && pressed ? { opacity: 0.7 } : null,
        disabled ? { opacity: 0.5 } : null,
      ]}
    >
      {children}
    </AnimatedPressable>
  );
}
