/**
 * Depo hademesi — emniyet freni ve yalnız bulut veritabanında çalışma (denetim, 23 Kas 2026).
 * Yerel veritabanıyla açılan uygulama, orada kaydı olmayan HER baskı dosyasını "sahipsiz" sanıp
 * silebilirdi; artık hiç çalışmaz. Çok sayıda sahipsiz görünürse de hiçbirini silmez.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  referanslar: [] as Array<{ r2Key: string | null; meshR2Key: string | null }>,
  nesneler: {} as Record<string, Array<{ key: string; lastModified: Date }>>,
  silinen: [] as string[],
  listelendi: 0,
  gunluk: [] as string[],
}));

vi.mock("./prisma", () => ({
  remotePrisma: { productModelFile: { findMany: vi.fn(async () => h.referanslar) } },
}));
vi.mock("./r2", () => ({
  getR2Config: vi.fn(async () => ({ bucket: "b" })),
  listModelObjects: vi.fn(async (_cfg: unknown, prefix: string) => {
    h.listelendi++;
    return h.nesneler[prefix] ?? [];
  }),
  deleteObject: vi.fn(async (key: string) => { h.silinen.push(key); }),
}));
vi.mock("./server-perf-log", () => ({ perfYaz: vi.fn((m: string) => { h.gunluk.push(m); }) }));

const ESKI = new Date(Date.now() - 3 * 86_400_000);
const TAZE = new Date(Date.now() - 60_000);
const nesne = (key: string, lastModified = ESKI) => ({ key, lastModified });

async function calistir() {
  vi.resetModules(); // hademe oturum başına bir kez koşar — her test temiz modülle
  const { runStorageJanitor } = await import("./storage-janitor");
  await runStorageJanitor();
}

beforeEach(() => {
  h.referanslar = [];
  h.nesneler = {};
  h.silinen = [];
  h.listelendi = 0;
  h.gunluk = [];
  vi.stubEnv("TURSO_DATABASE_URL", "libsql://ornek.turso.io");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("depo hademesi", () => {
  it("bulut veritabanına bağlı değilse buluta HİÇ dokunmaz", async () => {
    vi.stubEnv("TURSO_DATABASE_URL", "");
    h.nesneler["models/"] = [nesne("models/a")];
    await calistir();
    expect(h.listelendi).toBe(0);
    expect(h.silinen).toEqual([]);
  });

  it("birkaç eski sahipsiz nesneyi siler; kayıtlı ve taze olanlara dokunmaz", async () => {
    h.referanslar = Array.from({ length: 97 }, (_, i) => ({ r2Key: `models/k${i}`, meshR2Key: null }));
    h.nesneler["models/"] = [
      ...h.referanslar.map((r) => nesne(r.r2Key!)),
      nesne("models/yetim1"),
      nesne("models/yetim2"),
      nesne("models/taze", TAZE),
    ];
    await calistir();
    expect(h.silinen.sort()).toEqual(["models/yetim1", "models/yetim2"]);
  });

  it("çok sayıda sahipsiz görünürse HİÇBİRİNİ silmez, günlüğe yazar", async () => {
    h.referanslar = [{ r2Key: "models/tek", meshR2Key: null }];
    h.nesneler["models/"] = [nesne("models/tek"), ...Array.from({ length: 30 }, (_, i) => nesne(`models/x${i}`))];
    await calistir();
    expect(h.silinen).toEqual([]);
    expect(h.gunluk.some((g) => g.includes("durdu"))).toBe(true);
  });

  it("oran freni: küçük kütüphanede yarısı sahipsiz görünürse durur", async () => {
    h.referanslar = Array.from({ length: 6 }, (_, i) => ({ r2Key: `models/k${i}`, meshR2Key: null }));
    h.nesneler["models/"] = [...h.referanslar.map((r) => nesne(r.r2Key!)), ...Array.from({ length: 6 }, (_, i) => nesne(`models/y${i}`))];
    await calistir();
    expect(h.silinen).toEqual([]);
  });
});
