import { PrismaClient } from "@/generated/prisma/client";
import path from "node:path";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === "file:./dev.db" || databaseUrl === "file:dev.db") {
  const dbPath = path.join(process.cwd(), "prisma", "dev.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
