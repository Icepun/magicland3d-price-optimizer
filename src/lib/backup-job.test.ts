/**
 * Günlük yedek işi testleri: dosya adı/klasör seçimi, 30 dosya sınırı ve
 * geliştirme ortamında sessiz kapalı kalma.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ settings: new Map<string, string>() }));

vi.mock("./prisma", () => ({
  prisma: {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = state.settings.get(where.key);
        return value === undefined ? null : { key: where.key, value };
      },
      upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
        state.settings.set(where.key, update.value);
        return { key: where.key, value: update.value };
      },
    },
  },
}));

vi.mock("./backup-payload", () => ({
  buildBackupPayload: async () => ({ version: 3, products: [{ id: "p1" }] }),
}));

const envKeys = ["MLHUB_BACKUP_DIR", "MLHUB_ROUTE_CACHE_DIR", "MLHUB_ORDERS_CACHE_FILE"] as const;
const originalEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

beforeEach(() => {
  for (const key of envKeys) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  state.settings.clear();
});

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

function tempBackupDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlhub-backup-"));
  tempDirs.push(dir);
  process.env.MLHUB_BACKUP_DIR = dir;
  return dir;
}

describe("günlük yedek", () => {
  it("yedeği tarih-saat adıyla yazar ve son yedek zamanını kaydeder", async () => {
    const dir = tempBackupDir();
    const { runBackupNow, getLastBackupAt } = await import("./backup-job");

    const file = await runBackupNow();

    expect(file.name).toMatch(/^yedek-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(file.size).toBeGreaterThan(0);
    const written = JSON.parse(fs.readFileSync(path.join(dir, file.name), "utf8"));
    expect(written.products).toEqual([{ id: "p1" }]);
    // Yarım kalmış geçici dosya bırakmaz.
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
    expect(state.settings.get("lastBackupAt")).toBe(file.at);
    expect(await getLastBackupAt()).toBeTruthy();
  });

  it("yalnız son 30 yedeği tutar", async () => {
    const dir = tempBackupDir();
    for (let i = 1; i <= 34; i++) {
      fs.writeFileSync(path.join(dir, `yedek-2026-01-${String(i).padStart(2, "0")}-0300.json`), "{}");
    }

    const { runBackupNow, listBackups } = await import("./backup-job");
    await runBackupNow();

    const files = listBackups();
    expect(files).toHaveLength(30);
    // En eskiler silinir, yeniler durur.
    expect(files.some((f) => f.name === "yedek-2026-01-01-0300.json")).toBe(false);
    expect(files.some((f) => f.name === "yedek-2026-01-05-0300.json")).toBe(false);
    expect(files.some((f) => f.name === "yedek-2026-01-34-0300.json")).toBe(true);
  });

  it("kullanıcı verisi klasörünü ayar dosyası yollarından türetir", async () => {
    process.env.MLHUB_ROUTE_CACHE_DIR = path.join(os.tmpdir(), "mlhub-userdata", "route-cache");
    const { backupDir, isBackupEnabled } = await import("./backup-job");

    expect(backupDir()).toBe(path.join(os.tmpdir(), "mlhub-userdata", "backups"));
    expect(isBackupEnabled()).toBe(true);
  });

  it("klasör bilinmiyorsa sessizce kapalı kalır", async () => {
    const { isBackupEnabled, listBackups, startBackupJob, runBackupNow } = await import(
      "./backup-job"
    );

    expect(isBackupEnabled()).toBe(false);
    expect(listBackups()).toEqual([]);
    expect(() => startBackupJob()).not.toThrow();
    await expect(runBackupNow()).rejects.toThrow();
  });
});
