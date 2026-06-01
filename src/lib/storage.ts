import fs from "node:fs";
import path from "node:path";

/**
 * Kullanıcı veri klasörü (Electron userData). electron/main.js settings dosyalarını
 * userData altına yönlendirir; dirname'inden userData'yı türetiriz. Dev'de (electron
 * dışı) DATABASE_URL ya da cwd'ye düşer.
 */
export function getUserDataDir(): string {
  const settingsFile =
    process.env.TURSO_SETTINGS_FILE ||
    process.env.SHOPIFY_SETTINGS_FILE ||
    process.env.TRENDYOL_SETTINGS_FILE ||
    process.env.HEPSIBURADA_SETTINGS_FILE;
  if (settingsFile) return path.dirname(settingsFile);
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl?.startsWith("file:")) return path.dirname(dbUrl.slice("file:".length));
  return process.cwd();
}

/** Baskı modeli dosyalarının saklandığı klasör (yoksa oluşturur). */
export function getModelsDir(): string {
  const dir = path.join(getUserDataDir(), "models");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
