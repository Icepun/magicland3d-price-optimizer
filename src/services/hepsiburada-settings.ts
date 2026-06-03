import fs from "node:fs/promises";
import path from "node:path";
import { encryptSecret, maskSecret, tryDecryptSecret } from "@/lib/crypto";
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

async function readStoredSettings(): Promise<StoredHepsiburadaSettings> {
  try {
    const raw = await fs.readFile(getSettingsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStoredSettings(settings: StoredHepsiburadaSettings) {
  const filePath = getSettingsFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
