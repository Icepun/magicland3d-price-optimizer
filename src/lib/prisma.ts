import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import path from "node:path";

/**
 * Veritabanı bağlantısı:
 *  - TURSO_DATABASE_URL set ise → Turso bulut DB (libSQL adapter, çok cihaz senkron)
 *  - değilse                    → local SQLite (klasik motor + DATABASE_URL, ESKİ kanıtlı yol)
 *
 * Adapter SADECE Turso modunda devreye girer; local kullananlar için davranış
 * hiç değişmez (regresyon riski yok). Turso bilgileri electron/main.js tarafından
 * userData/turso-settings.json'dan okunup env'e konur.
 */
const tursoUrl = process.env.TURSO_DATABASE_URL?.trim();
const tursoToken = process.env.TURSO_AUTH_TOKEN?.trim();

// Local mod: relative DATABASE_URL'i mutlak yola çevir (eski mantık)
if (!tursoUrl) {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (
    databaseUrl === "file:./dev.db" ||
    databaseUrl === "file:dev.db" ||
    databaseUrl.startsWith("file:./dev.db") ||
    databaseUrl.startsWith("file:dev.db")
  ) {
    const dbPath = path.join(process.cwd(), "prisma", "dev.db").replace(/\\/g, "/");
    process.env.DATABASE_URL = `file:${dbPath}`;
  }
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrisma(): PrismaClient {
  const log = process.env.NODE_ENV === "development" ? ["error", "warn"] as const : ["error"] as const;

  if (tursoUrl) {
    // Bulut DB — libSQL adapter
    const adapter = new PrismaLibSQL({ url: tursoUrl, authToken: tursoToken || undefined });
    return new PrismaClient({ adapter, log: [...log] });
  }

  // Local SQLite — klasik motor (DATABASE_URL üzerinden), adapter YOK
  return new PrismaClient({ log: [...log] });
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

// Aynı bağlantı tüm isteklerde yeniden kullanılsın
globalForPrisma.prisma = prisma;
