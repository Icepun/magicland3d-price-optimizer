import fs from "node:fs/promises";
import path from "node:path";
import { encryptSecret, maskSecret, tryDecryptSecret } from "@/lib/crypto";
import type { HepsiburadaCredentials } from "./hepsiburada-client";

interface StoredHepsiburadaSettings {
  merchantId?: string;
  username?: string; // şifreli
  password?: string; // şifreli
}

const DEFAULT_PUBLIC_SETTINGS = {
  merchantId: "",
  hasUsername: false,
  hasPassword: false,
  usernameMasked: "",
  passwordMasked: "",
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

function decryptRequired(value: string | undefined, label: string) {
  const decrypted = tryDecryptSecret(value);
  if (!decrypted) {
    throw new Error(`${label} okunamadı. Lütfen Hepsiburada API bilgilerini yeniden kaydedin.`);
  }
  return decrypted;
}

export async function getHepsiburadaCredentials(): Promise<HepsiburadaCredentials> {
  const settings = await readStoredSettings();
  const merchantId = settings.merchantId?.trim() ?? "";
  const username = decryptRequired(settings.username, "Kullanıcı adı");
  const password = decryptRequired(settings.password, "Şifre");
  if (!merchantId || !username || !password) {
    throw new Error("Hepsiburada API bilgileri eksik");
  }
  return { merchantId, username, password };
}

export async function getPublicHepsiburadaSettings() {
  const settings = await readStoredSettings();
  const username = tryDecryptSecret(settings.username);
  const password = tryDecryptSecret(settings.password);
  return {
    ...DEFAULT_PUBLIC_SETTINGS,
    merchantId: settings.merchantId ?? "",
    hasUsername: Boolean(username),
    hasPassword: Boolean(password),
    usernameMasked: maskSecret(username),
    passwordMasked: maskSecret(password),
  };
}

export async function saveHepsiburadaSettings(input: { merchantId: string; username?: string; password?: string }) {
  const current = await readStoredSettings();
  const next: StoredHepsiburadaSettings = { ...current, merchantId: input.merchantId.trim() };
  if (input.username?.trim()) next.username = encryptSecret(input.username.trim());
  if (input.password?.trim()) next.password = encryptSecret(input.password.trim());
  await writeStoredSettings(next);
}
