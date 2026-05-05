import fs from "node:fs/promises";
import path from "node:path";
import { encryptSecret, maskSecret, tryDecryptSecret } from "@/lib/crypto";
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

async function readStoredSettings(): Promise<StoredTrendyolSettings> {
  try {
    const raw = await fs.readFile(getSettingsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    return {};
  }
}

async function writeStoredSettings(settings: StoredTrendyolSettings) {
  const filePath = getSettingsFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
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
