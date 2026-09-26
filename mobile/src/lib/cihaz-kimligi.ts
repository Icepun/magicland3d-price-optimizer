import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

/**
 * TELEFONUN KALICI KİMLİĞİ — push token'ı değişse de aynı kalır.
 *
 * Bildirim tercihi (hangi türler kapalı, telefonun adı) push kaydına bağlı. Expo token'ı
 * nadiren yeniler; kimlik olmasa yeni token "yeni telefon" sayılır ve kullanıcının seçimi
 * kaybolurdu. Kayıt sırasında aynı kimlikli eski satırın tercihi yeni satıra taşınır.
 *
 * `expo-file-system` uygulamada zaten var (bkz. offline-cache.ts notu: yeni native paket OTA'yı
 * keser). Dosya TEMBEL açılır ve her hata yutulur: kimlik yoksa kayıt eski yoldan yapılır.
 */

let bellekte: string | null = null;

function yeniKimlik(): string {
  const parca = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `c-${Date.now().toString(36)}-${parca()}${parca()}`;
}

/** Kimliği oku; yoksa üret ve kaydet. Web'de ya da disk hatasında null. */
export function cihazKimligi(): string | null {
  if (bellekte) return bellekte;
  if (Platform.OS === "web") return null;
  try {
    const dosya = new File(Paths.document, "mlhub-cihaz.json");
    if (dosya.exists) {
      const ham = JSON.parse(dosya.textSync()) as { id?: unknown };
      if (typeof ham?.id === "string" && ham.id.length >= 8) {
        bellekte = ham.id;
        return bellekte;
      }
    }
    const id = yeniKimlik();
    dosya.write(JSON.stringify({ id }));
    bellekte = id;
    return id;
  } catch {
    return null;
  }
}
