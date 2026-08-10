import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCacheDir = process.env.MLHUB_ROUTE_CACHE_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  if (originalCacheDir === undefined) {
    delete process.env.MLHUB_ROUTE_CACHE_DIR;
  } else {
    process.env.MLHUB_ROUTE_CACHE_DIR = originalCacheDir;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("route cache", () => {
  it("son başarılı yanıtı süreç yeniden başladıktan sonra diskten döndürür", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlhub-route-cache-"));
    tempDirs.push(dir);
    process.env.MLHUB_ROUTE_CACHE_DIR = dir;

    const firstModule = await import("./route-cache");
    const first = await firstModule.swr("products:test", 60_000, async () => ({
      products: 372,
    }));
    expect(first).toEqual({ products: 372 });
    expect(fs.readdirSync(dir)).toHaveLength(1);

    vi.resetModules();
    const secondModule = await import("./route-cache");
    let recomputed = false;
    const second = await secondModule.swr("products:test", 60_000, async () => {
      recomputed = true;
      return { products: 0 };
    });

    expect(second).toEqual({ products: 372 });
    expect(recomputed).toBe(false);
  });

  /**
   * REGRESYON: ön ekli temizlik yalnız BELLEKTEKİ anahtarları geziyordu. Bu oturumda hiç
   * okunmamış bir ekranın (ör. Ürünler'in "Gizli" sekmesi) disk kopyası hayatta kalıyor,
   * uygulama yeniden başlayınca ESKİ kuralla hesaplanmış kâr geri dönüyordu — komisyon/kargo
   * değişikliği "uygulanmamış" görünüyordu.
   */
  it("ön ekli temizlik, bu oturumda hiç okunmamış disk kopyalarını da siler", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlhub-route-cache-"));
    tempDirs.push(dir);
    process.env.MLHUB_ROUTE_CACHE_DIR = dir;

    // 1. oturum: iki ayrı ürün sekmesi + ilgisiz bir anahtar diske yazılır.
    const first = await import("./route-cache");
    await first.swr("products:aktif", 60_000, async () => ({ kar: 100 }));
    await first.swr("products:gizli", 60_000, async () => ({ kar: 200 }));
    await first.swr("settings:v1", 60_000, async () => ({ vatRate: "20" }));
    expect(fs.readdirSync(dir)).toHaveLength(3);

    // 2. oturum: kullanıcı YALNIZ "aktif" sekmesini açıyor; "gizli" belleğe hiç girmiyor.
    vi.resetModules();
    const second = await import("./route-cache");
    await second.swr("products:aktif", 60_000, async () => ({ kar: 100 }));

    // Komisyon kuralı değişti → products: ön eki düşürülür.
    second.bustCache("products:");

    // Her iki ürün kopyası da gitmeli; ilgisiz anahtar KORUNMALI (aşırı-geniş bust olmasın).
    expect(fs.readdirSync(dir)).toHaveLength(1);

    // 3. oturum: "gizli" sekmesi artık bayat gövdeyi diriltemez, taze hesaplar.
    vi.resetModules();
    const third = await import("./route-cache");
    let recomputed = false;
    const value = await third.swr("products:gizli", 60_000, async () => {
      recomputed = true;
      return { kar: 999 };
    });
    expect(recomputed).toBe(true);
    expect(value).toEqual({ kar: 999 });

    // Dokunulmayan anahtar hâlâ diskten geliyor.
    const settings = await third.swr("settings:v1", 60_000, async () => ({ vatRate: "BOZUK" }));
    expect(settings).toEqual({ vatRate: "20" });
  });
});
