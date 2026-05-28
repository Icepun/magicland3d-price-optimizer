import fs from "node:fs/promises";
import path from "node:path";

/**
 * Turso (libSQL) bulut DB bağlantı ayarları.
 *
 * userData/turso-settings.json içinde tutulur (her makineye aynı URL+token girilir).
 * electron/main.js bu dosyayı startup'ta okuyup TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
 * env'e koyar; prisma.ts da bu env'lere bakarak Turso'ya bağlanır.
 *
 * Düz JSON: dosya zaten kullanıcının korumalı userData klasöründe ve electron
 * (plain JS) startup'ta okuması gerekiyor. Repoya/koda girmez.
 */
export interface TursoSettings {
  url: string;
  authToken: string;
}

interface StoredTursoSettings {
  url?: string;
  authToken?: string;
}

function getSettingsFilePath() {
  return (
    process.env.TURSO_SETTINGS_FILE ||
    path.join(process.cwd(), "data", "turso-settings.json")
  );
}

async function readStored(): Promise<StoredTursoSettings> {
  try {
    const raw = await fs.readFile(getSettingsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function mask(value?: string | null): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export async function getPublicTursoSettings() {
  const s = await readStored();
  return {
    url: s.url ?? "",
    hasAuthToken: Boolean(s.authToken),
    authTokenMasked: mask(s.authToken),
    // Şu an aktif olan mod (env'e bakar — restart sonrası geçerli olur)
    activeMode: process.env.TURSO_DATABASE_URL ? "turso" : "local",
  };
}

export async function saveTursoSettings(input: { url: string; authToken?: string }) {
  const current = await readStored();
  const next: StoredTursoSettings = {
    ...current,
    url: input.url.trim(),
  };
  if (input.authToken?.trim()) {
    next.authToken = input.authToken.trim();
  }
  const filePath = getSettingsFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearTursoSettings() {
  const filePath = getSettingsFilePath();
  await fs.writeFile(filePath, "{}\n", { encoding: "utf8", mode: 0o600 });
}
