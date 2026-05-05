import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGORITHM = "aes-256-gcm";
const KEY_FILE = ".trendyol-credentials.key";

function getKeyMaterial(): string {
  if (process.env.TRENDYOL_CREDENTIAL_KEY) {
    return process.env.TRENDYOL_CREDENTIAL_KEY;
  }

  const keyPath = path.join(process.cwd(), KEY_FILE);
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString("hex"), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  return fs.readFileSync(keyPath, "utf8").trim();
}

function getKey(): Buffer {
  return crypto.createHash("sha256").update(getKeyMaterial()).digest();
}

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string): string {
  const [ivRaw, authTagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !authTagRaw || !encryptedRaw) return "";

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivRaw, "base64url")
  );
  decipher.setAuthTag(Buffer.from(authTagRaw, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function tryDecryptSecret(value?: string | null): string | null {
  if (!value) return null;

  try {
    const decrypted = decryptSecret(value);
    return decrypted || null;
  } catch {
    return null;
  }
}

export function maskSecret(value?: string | null): string {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
}
