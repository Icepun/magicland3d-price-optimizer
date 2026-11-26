import path from "node:path";
import { ayarDosyasiOku, ayarDosyasiYaz } from "@/lib/ayar-dosyasi";
import { encryptSecret, maskSecret, tryDecryptSecret } from "@/lib/crypto";
import { ortaklaOku, ortagaYaz, type KimlikTanimi } from "@/lib/ortak-kimlik-deposu";
import type { TrendyolCredentials, TrendyolEnvironment } from "./trendyol-client";

interface StoredTrendyolSettings {
  sellerId?: string;
  integrationReferenceCode?: string;
  apiKey?: string;
  apiSecret?: string;
  environment?: TrendyolEnvironment;
  integratorName?: string;
}

const DEFAULT_PUBLIC_SETTINGS = {
  sellerId: "",
  hasIntegrationReferenceCode: false,
  integrationReferenceCodeMasked: "",
  environment: "prod" as TrendyolEnvironment,
  integratorName: "SelfIntegration",
  hasApiKey: false,
  hasApiSecret: false,
  apiKeyMasked: "",
  apiSecretMasked: "",
};

function getSettingsFilePath() {
  return (
    process.env.TRENDYOL_SETTINGS_FILE ||
    path.join(/* turbopackIgnore: true */ process.cwd(), "data", "trendyol-settings.json")
  );
}

/** Bütün cihazlarda ortak kopya (bkz. lib/ortak-kimlik-deposu). */
export const TRENDYOL_KIMLIK: KimlikTanimi = {
  ad: "trendyol",
  dosyaYolu: getSettingsFilePath,
  gizli: ["apiKey", "apiSecret", "integrationReferenceCode"],
  acik: ["sellerId", "environment", "integratorName"],
};

async function readStoredSettings(): Promise<StoredTrendyolSettings> {
  // Yalnız dosya yoksa boş; bozuksa yedek, o da yoksa HATA (anahtarlar boş dosyanın üstüne yazılmasın).
  // Ortak kayıt varsa o geçerli (başka bilgisayarda girilen bilgi burada da çalışsın).
  return ortaklaOku(TRENDYOL_KIMLIK, await ayarDosyasiOku<StoredTrendyolSettings>(getSettingsFilePath()));
}

async function writeStoredSettings(settings: StoredTrendyolSettings) {
  // Geçici dosya + yeniden adlandırma: yazarken çökme yarım dosya bırakmaz; önceki iyi kopya yedekte.
  await ayarDosyasiYaz(getSettingsFilePath(), settings);
  await ortagaYaz(TRENDYOL_KIMLIK, settings);
}

function decryptRequired(value: string | undefined, label: string) {
  const decrypted = tryDecryptSecret(value);
  if (!decrypted) {
    throw new Error(`${label} okunamadi. Lutfen Trendyol API bilgilerini yeniden kaydedin.`);
  }
  return decrypted;
}

export async function getTrendyolCredentials(): Promise<TrendyolCredentials> {
  const settings = await readStoredSettings();
  const sellerId = settings.sellerId?.trim() ?? "";
  const apiKey = decryptRequired(settings.apiKey, "API Key");
  const apiSecret = decryptRequired(settings.apiSecret, "API Secret");
  const environment = settings.environment ?? "prod";
  const integratorName = settings.integratorName?.trim() || "SelfIntegration";

  if (!sellerId || !apiKey || !apiSecret) {
    throw new Error("Trendyol API bilgileri eksik");
  }

  return { sellerId, apiKey, apiSecret, environment, integratorName };
}

export async function getPublicTrendyolSettings() {
  const settings = await readStoredSettings();
  const apiKey = tryDecryptSecret(settings.apiKey);
  const apiSecret = tryDecryptSecret(settings.apiSecret);
  const integrationReferenceCode = tryDecryptSecret(settings.integrationReferenceCode);

  return {
    ...DEFAULT_PUBLIC_SETTINGS,
    sellerId: settings.sellerId ?? "",
    hasIntegrationReferenceCode: Boolean(integrationReferenceCode),
    integrationReferenceCodeMasked: maskSecret(integrationReferenceCode),
    environment: settings.environment ?? "prod",
    integratorName: settings.integratorName ?? "SelfIntegration",
    hasApiKey: Boolean(apiKey),
    hasApiSecret: Boolean(apiSecret),
    apiKeyMasked: maskSecret(apiKey),
    apiSecretMasked: maskSecret(apiSecret),
  };
}

export async function saveTrendyolSettings(input: {
  sellerId: string;
  integrationReferenceCode?: string;
  apiKey?: string;
  apiSecret?: string;
  environment: TrendyolEnvironment;
  integratorName: string;
}) {
  const current = await readStoredSettings();
  const next: StoredTrendyolSettings = {
    ...current,
    sellerId: input.sellerId.trim(),
    environment: input.environment,
    integratorName: input.integratorName.trim() || "SelfIntegration",
  };

  if (input.integrationReferenceCode?.trim()) {
    next.integrationReferenceCode = encryptSecret(input.integrationReferenceCode.trim());
  }
  if (input.apiKey?.trim()) {
    next.apiKey = encryptSecret(input.apiKey.trim());
  }
  if (input.apiSecret?.trim()) {
    next.apiSecret = encryptSecret(input.apiSecret.trim());
  }

  await writeStoredSettings(next);
}
