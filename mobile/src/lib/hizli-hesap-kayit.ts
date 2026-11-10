import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import { BOS_FORM, gecerliPlatformMu, type HizliForm } from "@/lib/hizli-hesap";

/**
 * Hızlı hesap formu telefonda hatırlanır: bir sonraki ürün aynı filament, paketleme ve komisyonla
 * başlar. `expo-file-system` uygulamada zaten var (bkz. offline-cache.ts: yeni native paket OTA'yı
 * keser). Dosya TEMBEL açılır, web'de hiç açılmaz, her hata yutulur — form hatırlanmasa da ekran çalışır.
 */
const DOSYA_ADI = "mlhub-hizli-hesap.json";

export function formuOku(): HizliForm {
  if (Platform.OS === "web") return BOS_FORM;
  try {
    const dosya = new File(Paths.document, DOSYA_ADI);
    if (!dosya.exists) return BOS_FORM;
    const j = JSON.parse(dosya.textSync()) as Partial<HizliForm> | null;
    if (!j || typeof j !== "object") return BOS_FORM;
    const form = { ...BOS_FORM, ...j, komisyon: { ...BOS_FORM.komisyon, ...(j.komisyon ?? {}) } };
    return gecerliPlatformMu(form.platform) ? form : { ...form, platform: BOS_FORM.platform };
  } catch {
    return BOS_FORM;
  }
}

export function formuYaz(form: HizliForm): void {
  if (Platform.OS === "web") return;
  try {
    new File(Paths.document, DOSYA_ADI).write(JSON.stringify(form));
  } catch {
    // Disk dolu vb. — form bu sefer hatırlanmaz, hesap etkilenmez.
  }
}
