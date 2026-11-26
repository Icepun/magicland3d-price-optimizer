import path from "node:path";
import { ayarDosyasiOku, ayarDosyasiYaz } from "@/lib/ayar-dosyasi";
import { encryptSecret, maskSecret, tryDecryptSecret } from "@/lib/crypto";
import { ortaklaOku, ortagaYaz, type KimlikTanimi } from "@/lib/ortak-kimlik-deposu";
import type { HepsiburadaCredentials, HbEnvironment } from "./hepsiburada-client";

interface StoredHepsiburadaSettings {
  merchantId?: string;
  secretKey?: string; // şifreli
  developerUsername?: string; // düz (entegratör adı; gizli değil → User-Agent)
  environment?: HbEnvironment;
  // Eski alanlar (geriye dönük): username(şifreli)=eski "entegrasyon kullanıcı adı", password(şifreli)=eski şifre
  username?: string;
  password?: string;
}

const DEFAULT_PUBLIC_SETTINGS = {
  merchantId: "",
  developerUsername: "",
  environment: "test" as HbEnvironment,
  hasSecretKey: false,
  secretKeyMasked: "",
};

function getSettingsFilePath() {
  return (
    process.env.HEPSIBURADA_SETTINGS_FILE ||
    path.join(/* turbopackIgnore: true */ process.cwd(), "data", "hepsiburada-settings.json")
  );
}

/** Bütün cihazlarda ortak kopya (bkz. lib/ortak-kimlik-deposu). Eski şifreli alanlar da taşınır. */
export const HEPSIBURADA_KIMLIK: KimlikTanimi = {
  ad: "hepsiburada",
  dosyaYolu: getSettingsFilePath,
  gizli: ["secretKey", "username", "password"],
  acik: ["merchantId", "developerUsername", "environment"],
};

async function readStoredSettings(): Promise<StoredHepsiburadaSettings> {
  // Yalnız dosya yoksa boş; bozuksa yedek, o da yoksa HATA (anahtarlar boş dosyanın üstüne yazılmasın).
  // Ortak kayıt varsa o geçerli (başka bilgisayarda girilen bilgi burada da çalışsın).
  return ortaklaOku(HEPSIBURADA_KIMLIK, await ayarDosyasiOku<StoredHepsiburadaSettings>(getSettingsFilePath()));
}

async function writeStoredSettings(settings: StoredHepsiburadaSettings) {
  // Geçici dosya + yeniden adlandırma: yazarken çökme yarım dosya bırakmaz; önceki iyi kopya yedekte.
  await ayarDosyasiYaz(getSettingsFilePath(), settings);
  await ortagaYaz(HEPSIBURADA_KIMLIK, settings);
}

/** secret key: yeni alan → yoksa eski `password`. developerUsername: yeni düz alan → yoksa eski şifreli `username`. */
function resolveSecretKey(s: StoredHepsiburadaSettings): string {
  return tryDecryptSecret(s.secretKey) || tryDecryptSecret(s.password) || "";
}
function resolveDeveloperUsername(s: StoredHepsiburadaSettings): string {
  return (s.developerUsername?.trim() || tryDecryptSecret(s.username) || "").trim();
}

export async function getHepsiburadaCredentials(): Promise<HepsiburadaCredentials> {
  const settings = await readStoredSettings();
  const merchantId = settings.merchantId?.trim() ?? "";
  const secretKey = resolveSecretKey(settings);
  const developerUsername = resolveDeveloperUsername(settings);
  const environment: HbEnvironment = settings.environment === "prod" ? "prod" : "test";
  if (!merchantId || !secretKey || !developerUsername) {
    throw new Error("Hepsiburada API bilgileri eksik (merchantId / gizli anahtar / geliştirici kullanıcı adı).");
  }
  return { merchantId, secretKey, developerUsername, environment };
}

export async function getPublicHepsiburadaSettings() {
  const settings = await readStoredSettings();
  const secretKey = resolveSecretKey(settings);
  return {
    ...DEFAULT_PUBLIC_SETTINGS,
    merchantId: settings.merchantId ?? "",
    developerUsername: resolveDeveloperUsername(settings),
    environment: (settings.environment === "prod" ? "prod" : "test") as HbEnvironment,
    hasSecretKey: Boolean(secretKey),
    secretKeyMasked: maskSecret(secretKey),
  };
}

export async function saveHepsiburadaSettings(input: {
  merchantId: string;
  secretKey?: string;
  developerUsername?: string;
  environment?: HbEnvironment;
}) {
  const current = await readStoredSettings();
  const next: StoredHepsiburadaSettings = { ...current, merchantId: input.merchantId.trim() };
  if (input.secretKey?.trim()) next.secretKey = encryptSecret(input.secretKey.trim());
  if (typeof input.developerUsername === "string") next.developerUsername = input.developerUsername.trim();
  if (input.environment === "test" || input.environment === "prod") next.environment = input.environment;
  // Eski şifreli alanları temizle (artık secretKey/developerUsername kullanılıyor).
  delete next.username;
  delete next.password;
  await writeStoredSettings(next);
}
