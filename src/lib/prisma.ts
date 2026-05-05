import { PrismaClient } from "@/generated/prisma/client";
import path from "node:path";

const databaseUrl = process.env.DATABASE_URL ?? "";

// Resolve relative DATABASE_URL to absolute path so Prisma can always find the file.
// In production, electron/main.js sets an absolute path before Next.js starts.
if (
  databaseUrl === "file:./dev.db" ||
  databaseUrl === "file:dev.db" ||
  databaseUrl.startsWith("file:./dev.db") ||
  databaseUrl.startsWith("file:dev.db")
) {
  const dbPath = path.join(process.cwd(), "prisma", "dev.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

// Always cache globally so the same DB connection is reused across all requests
globalForPrisma.prisma = prisma;
