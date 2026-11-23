/**
 * Entegrasyonlar + Ayarlar denetimi (23 Kas 2026) — güvenlik ve veri koruma bekçi testleri.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  appSetting: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));
const batchWrite = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/libsql-batch", () => ({ batchWrite }));
vi.mock("@/lib/cache-busting", () => ({ bustProfitInputCaches: vi.fn(), bustInventoryAlertCaches: vi.fn() }));
vi.mock("@/lib/route-cache", () => ({ bustCache: vi.fn(), swr: (_k: string, _t: number, f: () => Promise<unknown>) => f() }));
vi.mock("@/lib/r2", () => ({ invalidateR2Config: vi.fn() }));

const { yerelIstekMi } = await import("./yerel-istek");
const { ayarDosyasiOku, ayarDosyasiYaz, AyarDosyasiOkunamadi } = await import("./ayar-dosyasi");
const { baglantiDurumu } = await import("./baglanti-ozeti");
const ayarlar = await import("@/app/api/settings/route");

const istek = (govde: unknown) => ({ json: async () => govde }) as never;
const klasor = mkdtempSync(path.join(tmpdir(), "ayar-dosyasi-test-"));
afterAll(() => rmSync(klasor, { recursive: true, force: true }));

beforeEach(() => {
  vi.clearAllMocks();
  batchWrite.mockResolvedValue(true);
});

describe("yerel istek koruması", () => {
  it("uygulamanın kendi sayfası ve süreç içi istekler geçer", () => {
    expect(yerelIstekMi({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", secFetchSite: "same-origin" })).toBe(true);
    expect(yerelIstekMi({ host: "127.0.0.1:3000", origin: null, secFetchSite: null })).toBe(true);
    expect(yerelIstekMi({ host: "localhost:3123", origin: "http://localhost:3123", secFetchSite: "same-origin" })).toBe(true);
    expect(yerelIstekMi({ host: "127.0.0.1:3000", origin: "http://localhost:3123", secFetchSite: "cross-site" })).toBe(true);
  });

  it("başka site ve DNS yeniden bağlama reddedilir", () => {
    expect(yerelIstekMi({ host: "127.0.0.1:3000", origin: "https://kotu.example", secFetchSite: "cross-site" })).toBe(false);
    expect(yerelIstekMi({ host: "127.0.0.1:3000", origin: null, secFetchSite: "cross-site" })).toBe(false);
    expect(yerelIstekMi({ host: "kotu.example:3000", origin: null, secFetchSite: null })).toBe(false);
    expect(yerelIstekMi({ host: "127.0.0.1:3000", origin: "null", secFetchSite: "cross-site" })).toBe(false);
  });
});

describe("ayar dosyası", () => {
  it("dosya yoksa boş; bozuksa yedekten; ikisi de bozuksa HATA (anahtarlar ezilmesin)", async () => {
    const yol = path.join(klasor, "trendyol.json");
    expect(await ayarDosyasiOku(yol)).toEqual({});
    await ayarDosyasiYaz(yol, { apiKey: "eski" });
    await ayarDosyasiYaz(yol, { apiKey: "yeni" });
    expect(JSON.parse(readFileSync(`${yol}.yedek`, "utf8"))).toEqual({ apiKey: "eski" });
    writeFileSync(yol, "{yarım");
    expect(await ayarDosyasiOku(yol)).toEqual({ apiKey: "eski" });
    writeFileSync(`${yol}.yedek`, "{bozuk");
    await expect(ayarDosyasiOku(yol)).rejects.toBeInstanceOf(AyarDosyasiOkunamadi);
  });
});

describe("/api/settings", () => {
  it("gizli anahtarlar yanıta girmez", async () => {
    db.appSetting.findMany.mockResolvedValue([
      { key: "vatRate", value: "20" },
      { key: "r2SecretKey", value: "GIZLI" },
      { key: "r2AccessKeyId", value: "ERISIM" },
    ]);
    const veri = await (await ayarlar.GET()).json();
    expect(veri).toEqual({ vatRate: "20" });
  });

  it("boş gönderilen gizli değer kayıtlı anahtarı silmez", async () => {
    db.appSetting.findMany.mockResolvedValue([]);
    await ayarlar.POST(istek({ r2Bucket: "kova", r2SecretKey: "" }));
    const ifadeler = batchWrite.mock.calls[0][0] as Array<{ args: unknown[] }>;
    expect(ifadeler.map((i) => i.args[0])).toEqual(["r2Bucket"]);
  });

  it("boş KDV reddedilir; virgüllü maliyet sayı olarak yazılır", async () => {
    expect((await ayarlar.POST(istek({ vatRate: "" }))).status).toBe(400);
    db.appSetting.findMany.mockResolvedValue([]);
    await ayarlar.POST(istek({ costLaborPerHour: "4,6" }));
    expect((batchWrite.mock.calls[0][0] as Array<{ args: unknown[] }>)[0].args).toEqual(["costLaborPerHour", "4.6"]);
  });
});

describe("bağlantı özeti", () => {
  it("kurulmamış sipariş bağlantısı kırmızı hata değil", () => {
    const d = baglantiDurumu({ bagli: true, siparis: { ok: false, needsAdminToken: true }, sonEsitlemeIso: new Date().toISOString(), nowMs: Date.now() });
    expect(d.ton).not.toBe("hata");
    expect(d.siparisMetni).toBe("Sipariş bağlantısı kurulmadı");
  });
});
