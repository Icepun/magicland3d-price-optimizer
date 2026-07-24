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
});
