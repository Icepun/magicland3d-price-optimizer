import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { ML } from "@/theme/colors";
import { friendlyError } from "@/lib/format";

/**
 * "Bağlantı yok — tekrar dene" — ekranların ORTAK dürüst hata durumu.
 *
 * NEDEN VAR: yedi ekranın hata dalı hiç yoktu. Ağ koptuğunda sorgu boş dönüyor, ekran da bunu
 * "veri yok" sanıp `Henüz makara yok`, `Üretim gerekmiyor`, `0 uyarı`, `₺0` gibi şeyler
 * gösteriyordu. Kullanıcı bunları GERÇEK sanıyordu — atölyede "filamentim var mı" diye bakıp
 * "yok" cevabı almak, hiç cevap almamaktan kötüdür. Boş durum ile hata durumu artık ayrı.
 */
export function ConnectionError({
  error,
  onRetry,
  retrying = false,
}: {
  error: unknown;
  onRetry: () => void;
  /** Yeniden deneme sürüyor mu (buton kilitlenir + çark döner). */
  retrying?: boolean;
}) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.icon}>⚠️</Text>
      <Text style={styles.title}>Bağlantı kurulamadı</Text>
      <Text style={styles.detail} numberOfLines={3}>
        {friendlyError(error)}
      </Text>
      <Pressable
        onPress={onRetry}
        disabled={retrying}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          retrying && styles.buttonDisabled,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Tekrar dene"
      >
        {retrying ? (
          <ActivityIndicator color={ML.text} size="small" />
        ) : (
          <Text style={styles.buttonText}>Tekrar dene</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center", paddingVertical: 48, paddingHorizontal: 24, gap: 8 },
  icon: { fontSize: 32 },
  title: { color: ML.text, fontSize: 16, fontWeight: "700" },
  detail: { color: ML.textDim, fontSize: 13, textAlign: "center", lineHeight: 18 },
  button: {
    marginTop: 12,
    minWidth: 140,
    minHeight: 44, // tek elle / eldivenli dokunma hedefi
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: ML.card,
    borderWidth: 1,
    borderColor: ML.red + "55",
  },
  buttonPressed: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: ML.text, fontSize: 15, fontWeight: "700" },
});
