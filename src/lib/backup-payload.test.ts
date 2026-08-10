/**
 * Yedek gövdesi testleri.
 *
 * En kritik davranış: bulut depolama şifreleri yedeğe SIZMAMALI. Yedek dosyası
 * (e-posta/USB) elden ele geçebiliyor; içinde düz metin anahtar taşıması olmaz.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  inFlight: 0,
  maxInFlight: 0,
}));

function fakeClient() {
  return new Proxy(
    {},
    {
      get: (_target, model: string) => ({
        findMany: async () => {
          state.inFlight++;
          state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
          await new Promise((resolve) => setTimeout(resolve, 0));
          state.inFlight--;
          return state.tables[model] ?? [];
        },
      }),
    }
  );
}

vi.mock("./prisma", () => ({ prisma: fakeClient(), remotePrisma: fakeClient() }));
vi.mock("./runtime-schema", () => ({ ensureRuntimeSchema: async () => {} }));

beforeEach(() => {
  state.tables = {};
  state.inFlight = 0;
  state.maxInFlight = 0;
});

describe("yedek gövdesi", () => {
  it("bulut depolama şifrelerini yedeğe koymaz", async () => {
    state.tables.appSetting = [
      { key: "r2AccessKeyId", value: "AKIA-gizli" },
      { key: "r2SecretKey", value: "cok-gizli" },
      { key: "r2Bucket", value: "magicland" },
      { key: "vatRate", value: "20" },
    ];

    const { buildBackupPayload } = await import("./backup-payload");
    const payload = await buildBackupPayload();

    expect(payload.appSettings.map((s: { key: string }) => s.key)).toEqual(["r2Bucket", "vatRate"]);
    expect(JSON.stringify(payload)).not.toContain("cok-gizli");
    expect(JSON.stringify(payload)).not.toContain("AKIA-gizli");
    expect(payload.metadata.excludedSettingKeys).toEqual(["r2AccessKeyId", "r2SecretKey"]);
    expect(payload.metadata.secretSettingsExcluded).toBe(true);
  });

  it("gizli anahtar yoksa uyarı üretmez", async () => {
    state.tables.appSetting = [{ key: "vatRate", value: "20" }];

    const { buildBackupPayload } = await import("./backup-payload");
    const payload = await buildBackupPayload();

    expect(payload.metadata.excludedSettingKeys).toEqual([]);
    expect(payload.metadata.warnings).toEqual([]);
  });

  it("ad kalıbıyla gizli görünen yeni anahtarları da eler", async () => {
    const { isSecretSettingKey } = await import("./backup-payload");

    expect(isSecretSettingKey("r2SecretKey")).toBe(true);
    expect(isSecretSettingKey("r2AccessKeyId")).toBe(true);
    expect(isSecretSettingKey("shopifyStorefrontAccessToken")).toBe(true);
    expect(isSecretSettingKey("somePassword")).toBe(true);
    expect(isSecretSettingKey("r2Bucket")).toBe(false);
    expect(isSecretSettingKey("r2AccountId")).toBe(false);
    expect(isSecretSettingKey("vatRate")).toBe(false);
  });

  it("model dosyalarının yerel yollarını ve baytlarını dışarı vermez", async () => {
    state.tables.productModelFile = [
      { id: "a", r2Key: "models/x.gcode", storedPath: "C:/Users/Berke/gizli/yol.gcode" },
      { id: "b", r2Key: null, storedPath: "C:/Users/Berke/gizli/yerel.3mf" },
    ];

    const { buildBackupPayload } = await import("./backup-payload");
    const payload = await buildBackupPayload();

    expect(payload.productModelFiles.map((f) => f.storedPath)).toEqual(["", ""]);
    expect(payload.productModelFiles.map((f) => f.storageKind)).toEqual([
      "r2-reference",
      "local-metadata-only",
    ]);
    expect(payload.metadata.localModelFileMetadataCount).toBe(1);
    expect(payload.metadata.r2ModelReferenceCount).toBe(1);
  });

  it("sıralı modda tabloları tek tek okur (tek kilidi uzun süre tutmaz)", async () => {
    const { buildBackupPayload } = await import("./backup-payload");

    await buildBackupPayload({ sequential: true });
    expect(state.maxInFlight).toBe(1);

    state.maxInFlight = 0;
    await buildBackupPayload();
    expect(state.maxInFlight).toBeGreaterThan(1);
  });
});
