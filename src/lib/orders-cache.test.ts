import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ayniPencereGunuMu,
  computeOrdersShared,
  getOrdersCache,
  getOrdersCacheGeneration,
  invalidateOrdersCache,
  setOrdersCache,
} from "./orders-cache";

describe("orders cache generation", () => {
  beforeEach(() => {
    invalidateOrdersCache();
  });

  it("invalidation sonrası eski background hesabının cache'i geri doldurmasını engeller", () => {
    const staleGeneration = getOrdersCacheGeneration();

    invalidateOrdersCache();

    expect(setOrdersCache({ source: "stale" }, staleGeneration)).toBe(false);
    expect(getOrdersCache()).toBeNull();
  });

  it("güncel nesilde tamamlanan hesabı cache'e yazar", () => {
    const currentGeneration = getOrdersCacheGeneration();
    const body = { source: "fresh" };

    expect(setOrdersCache(body, currentGeneration)).toBe(true);
    expect(getOrdersCache()?.body).toBe(body);
  });

  it("aynı gövdeyi ikinci kez yayınlamak güncelleme zamanını ileri kaydırmaz", async () => {
    const body = { source: "fresh" };
    setOrdersCache(body, getOrdersCacheGeneration());
    const firstAt = getOrdersCache()?.at;

    await new Promise((resolve) => setTimeout(resolve, 5));
    setOrdersCache(body, getOrdersCacheGeneration());

    expect(getOrdersCache()?.at).toBe(firstAt);
  });

  it("gövdede hesaplama zamanı yoksa ekleyip var olanı korur", () => {
    const stamped = { source: "fresh", computedAt: "2026-01-01T00:00:00.000Z" };
    setOrdersCache(stamped, getOrdersCacheGeneration());
    expect(getOrdersCache()?.body.computedAt).toBe("2026-01-01T00:00:00.000Z");

    invalidateOrdersCache();
    const bare: Record<string, unknown> = { source: "fresh" };
    setOrdersCache(bare, getOrdersCacheGeneration());
    expect(typeof getOrdersCache()?.body.computedAt).toBe("string");
  });
});

describe("orders paylaşılan hesap", () => {
  beforeEach(() => {
    invalidateOrdersCache();
  });

  it("aynı anda gelen istekler tek hesabı paylaşır", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { source: "shared", calls };
    };

    const [first, second] = await Promise.all([
      computeOrdersShared(compute),
      computeOrdersShared(compute),
    ]);

    expect(calls).toBe(1);
    expect(first).toBe(second);
    expect(getOrdersCache()?.body).toBe(first);
  });

  it("hesap sürerken kural değişirse eski sonucu yayınlamaz, yeniden hesaplar", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      const round = calls;
      await new Promise((resolve) => setTimeout(resolve, 5));
      // İlk hesap sürerken kullanıcı bir fiyatlama kuralını değiştirdi.
      if (round === 1) invalidateOrdersCache();
      return { source: "orders", round };
    };

    const body = await computeOrdersShared(compute);

    expect(calls).toBe(2);
    expect(body.round).toBe(2);
    expect(getOrdersCache()?.body).toBe(body);
  });

  it("kural değişimi hesabın ortasına denk gelirse eski sonuç önbelleğe yazılmaz", async () => {
    const compute = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      invalidateOrdersCache();
      return { source: "orders", round: "eski" };
    };

    // Her denemede nesil eskidiği için sonuç yayınlanmaz; önbellek boş kalır.
    await computeOrdersShared(compute);

    expect(getOrdersCache()).toBeNull();
  });

  it("hesap hata verirse bekleyen kayıt temizlenir ve sonraki istek yeniden dener", async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("pazaryeri yanıt vermedi");
    };

    await expect(computeOrdersShared(failing)).rejects.toThrow();
    await expect(computeOrdersShared(failing)).rejects.toThrow();

    expect(calls).toBe(2);
  });
});

describe("orders disk kopyası tazeliği", () => {
  const files: string[] = [];

  function writeDiskCache(ageMs: number, format = 2): string {
    const file = path.join(
      os.tmpdir(),
      `mlhub-orders-cache-${Date.now()}-${files.length}.json`
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        format,
        at: Date.now() - ageMs,
        body: { orders: [], computedAt: new Date(Date.now() - ageMs).toISOString() },
      }),
      "utf8"
    );
    files.push(file);
    return file;
  }

  afterEach(() => {
    delete process.env.MLHUB_ORDERS_CACHE_FILE;
    for (const file of files.splice(0)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // geçici dosya; silinememesi testi ilgilendirmez
      }
    }
    vi.resetModules();
  });

  it("üç günden eski disk kopyasını kullanmaz", async () => {
    process.env.MLHUB_ORDERS_CACHE_FILE = writeDiskCache(4 * 24 * 60 * 60_000);
    vi.resetModules();

    const mod = await import("./orders-cache");

    expect(mod.getOrdersCache()).toBeNull();
  });

  /** En sık senaryo: akşam kapat, sabah aç. Kalıcı önbelleğin varlık sebebi bu — soğumamalı. */
  it("bir gece boyunca kapalı kaldıktan sonra disk kopyası hâlâ kullanılır", async () => {
    process.env.MLHUB_ORDERS_CACHE_FILE = writeDiskCache(14 * 60 * 60_000);
    vi.resetModules();

    const mod = await import("./orders-cache");

    expect(mod.getOrdersCache()).not.toBeNull();
  });

  it("taze disk kopyasını hesaplama zamanıyla birlikte kullanır", async () => {
    const ageMs = 3 * 60_000;
    process.env.MLHUB_ORDERS_CACHE_FILE = writeDiskCache(ageMs);
    vi.resetModules();

    const mod = await import("./orders-cache");
    const entry = mod.getOrdersCache();

    expect(entry).not.toBeNull();
    expect(typeof entry?.body.computedAt).toBe("string");
    // Diskten okumak damgayı tazelemez: kayıt hâlâ dakikalar öncesine ait.
    expect(Date.now() - new Date(String(entry?.body.computedAt)).getTime()).toBeGreaterThan(
      60_000
    );
  });

  it("eski biçimdeki disk kopyasını yok sayar", async () => {
    process.env.MLHUB_ORDERS_CACHE_FILE = writeDiskCache(60_000, 1);
    vi.resetModules();

    const mod = await import("./orders-cache");

    expect(mod.getOrdersCache()).toBeNull();
  });
});

/**
 * GÜN DEĞİŞİNCE ÖNBELLEK KULLANILMAZ — 30 günlük pencere UTC gün başına bağlı.
 *
 * 24 Eyl 2026: gece 01:21'de hesaplanan özet sabah 07:19'da hâlâ veriliyordu; pencere
 * 03:00'te (UTC gece yarısı) kaymış olmasına rağmen 30 günün dışına düşen 4 sipariş
 * (2.519,97 ₺) ciroda kalmıştı. Telefon taze hesapladığı için iki cihaz farklı ciro gösterdi.
 */
describe("önbellek pencere günü", () => {
  const TR_0121 = Date.parse("2026-09-23T22:21:25Z"); // TR 24 Eyl 01:21
  const TR_0719 = Date.parse("2026-09-24T04:19:15Z"); // TR 24 Eyl 07:19

  it("aynı UTC günü içindeki hesap geçerli", () => {
    expect(ayniPencereGunuMu(TR_0719 - 3_600_000, TR_0719)).toBe(true);
  });

  it("Türkiye'de aynı takvim günü olsa bile UTC günü değiştiyse GEÇERSİZ (sahadaki durum)", () => {
    expect(ayniPencereGunuMu(TR_0121, TR_0719)).toBe(false);
  });

  it("sınır: UTC gece yarısından bir an önce ve sonra farklı pencere", () => {
    const geceYarisi = Date.parse("2026-09-24T00:00:00Z");
    expect(ayniPencereGunuMu(geceYarisi - 1, geceYarisi)).toBe(false);
    expect(ayniPencereGunuMu(geceYarisi, geceYarisi + 1)).toBe(true);
  });

  it("sipariş ucu önbelleği yalnız aynı pencere günündeyse anında veriyor", () => {
    const rota = fs.readFileSync(path.join(process.cwd(), "src/app/api/orders/route.ts"), "utf8");
    expect(rota).toContain("if (!fresh && cached && ayniPencereGunuMu(cached.at)) {");
    // Taze hesap düşerse eldeki (eski) sonuca geri dönülür — boş ekran yerine.
    expect(rota).toContain("if (!fresh && cached) return NextResponse.json(cached.body);");
  });
});
