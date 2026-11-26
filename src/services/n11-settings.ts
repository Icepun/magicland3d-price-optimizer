import path from "node:path";
import { ayarDosyasiOku, ayarDosyasiYaz } from "@/lib/ayar-dosyasi";
import { encryptSecret, maskSecret, tryDecryptSecret } from "@/lib/crypto";
import type { N11Kimligi } from "./n11-client";

/**
 * n11 API bilgileri — diğer pazaryerleriyle aynı düzen: bu bilgisayarda, kullanıcı klasöründe
 * (`N11_SETTINGS_FILE`, Electron ayarlar), API şifresi AES ile şifreli. API anahtarı da şifreli
 * tutulur (ikisi birlikte mağazaya tam erişim verir).
 */
interface KayitliN11Ayarlari {
  appKey?: string; // şifreli
  appSecret?: string; // şifreli
}

function dosyaYolu() {
  return (
    process.env.N11_SETTINGS_FILE ||
    path.join(/* turbopackIgnore: true */ process.cwd(), "data", "n11-settings.json")
  );
}

async function oku(): Promise<KayitliN11Ayarlari> {
  // Yalnız dosya yoksa boş; bozuksa yedek, o da yoksa HATA (anahtarlar boş dosyanın üstüne yazılmasın).
  return ayarDosyasiOku<KayitliN11Ayarlari>(dosyaYolu());
}

export interface N11AcikAyarlar {
  anahtarVar: boolean;
  anahtarMaskeli: string;
  sifreVar: boolean;
}

export async function n11AcikAyarlar(): Promise<N11AcikAyarlar> {
  const a = await oku();
  const anahtar = tryDecryptSecret(a.appKey) ?? "";
  return { anahtarVar: Boolean(anahtar), anahtarMaskeli: maskSecret(anahtar), sifreVar: Boolean(tryDecryptSecret(a.appSecret)) };
}

/** Kayıtlı kimlik; eksikse kullanıcıya gösterilebilir hata. */
export async function n11Kimligi(): Promise<N11Kimligi> {
  const a = await oku();
  const appKey = tryDecryptSecret(a.appKey)?.trim() ?? "";
  const appSecret = tryDecryptSecret(a.appSecret)?.trim() ?? "";
  if (!appKey || !appSecret) throw new Error("n11 API anahtarı ve şifresi girilmedi.");
  return { appKey, appSecret };
}

/** Boş bırakılan alan mevcut değeri korur (kart şifreyi geri göstermez). */
export async function n11AyarlariniKaydet(girdi: { appKey?: string; appSecret?: string }): Promise<void> {
  const a = await oku();
  const anahtar = girdi.appKey?.trim();
  const sifre = girdi.appSecret?.trim();
  const yeni: KayitliN11Ayarlari = {
    appKey: anahtar ? encryptSecret(anahtar) : a.appKey,
    appSecret: sifre ? encryptSecret(sifre) : a.appSecret,
  };
  await ayarDosyasiYaz(dosyaYolu(), yeni);
}
