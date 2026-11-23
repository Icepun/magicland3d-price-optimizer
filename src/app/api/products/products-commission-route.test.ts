import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

/**
 * KOMİSYONU BİLİNMEYEN İLAN (Berke kararı, 23 Kas 2026): Trendyol/Hepsiburada ilanında ne ilanın
 * oranı ne de eşleşen kural varsa kâr YAZILMAZ — eskiden komisyon 0 sayılıp "Komisyon gir!"
 * uyarısının yanında yeşil, şişkin bir kâr çıkıyordu. Ürünün özet kârı başka bir ilandan gelir;
 * ilanı olup komisyonu bilinmeyen ürüne ürün fiyatıyla kâr UYDURULMAZ.
 */

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-products-commission-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let listProducts: typeof import("./route").GET;
let db: typeof import("@/lib/prisma").prisma;

interface Row {
  id: string;
  currentNetProfit: number | null;
  platforms: Array<{ platform: string; netProfit: number | null; profitMargin: number | null; commissionMissing: boolean }>;
}

async function seed(id: string, listings: Array<{ platform: string; commissionRate: number | null }>) {
  await db.product.create({
    data: {
      id,
      barcode: `bc-${id}`,
      sku: `sku-${id}`,
      name: id,
      categoryName: "Dekor",
      currentSalePrice: 400,
      source: listings[0]?.platform ?? "manual",
      cost: { create: { costMode: "manual", manualCost: 100, totalCost: 100 } },
      listings: {
        create: listings.map((l, i) => ({
          id: `l-${id}-${i}`,
          platform: l.platform,
          salePrice: 400,
          cargoCost: 0,
          commissionRate: l.commissionRate,
        })),
      },
    },
  });
}

async function read(ids: string[]) {
  const response = await listProducts(new NextRequest(`http://localhost/api/products?ids=${ids.join(",")}`));
  expect(response.status).toBe(200);
  return { rows: (await response.json()) as Row[], response };
}

beforeAll(async () => {
  ({ GET: listProducts } = await import("./route"));
  ({ prisma: db } = await import("@/lib/prisma"));
  const { ensureRuntimeSchema } = await import("@/lib/runtime-schema");
  await ensureRuntimeSchema();
  await seed("karisik", [
    { platform: "trendyol", commissionRate: null },
    { platform: "shopify", commissionRate: null },
  ]);
  await seed("yalniz-ty", [{ platform: "trendyol", commissionRate: null }]);
  await seed("bilinen", [{ platform: "trendyol", commissionRate: 0.2 }]);
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("komisyonu bilinmeyen ilan", () => {
  it("ilanın kârı ve marjı boş; uyarı işareti duruyor", async () => {
    const { rows } = await read(["karisik"]);
    const ty = rows[0]!.platforms.find((p) => p.platform === "trendyol")!;
    expect(ty.commissionMissing).toBe(true);
    expect(ty.netProfit).toBeNull();
    expect(ty.profitMargin).toBeNull();
  });

  it("ürünün özet kârı komisyonu bilinen ilandan (Shopify) gelir", async () => {
    const { rows } = await read(["karisik"]);
    const sh = rows[0]!.platforms.find((p) => p.platform === "shopify")!;
    expect(sh.netProfit).not.toBeNull();
    expect(rows[0]!.currentNetProfit).toBeCloseTo(sh.netProfit!, 6);
  });

  it("tek ilanı komisyonsuz olan üründe kâr UYDURULMAZ (bilinmiyor)", async () => {
    const { rows } = await read(["yalniz-ty"]);
    expect(rows[0]!.currentNetProfit).toBeNull();
  });

  it("oranı bilinen ilanın kârı her zamanki gibi hesaplanır", async () => {
    const { rows } = await read(["bilinen"]);
    const ty = rows[0]!.platforms[0]!;
    expect(ty.commissionMissing).toBe(false);
    expect(ty.netProfit).not.toBeNull();
    expect(rows[0]!.currentNetProfit).toBeCloseTo(ty.netProfit!, 6);
  });

  it("yanıt gövdenin hesaplandığı anı başlıkta taşır", async () => {
    const once = Date.now();
    const { response } = await read(["bilinen"]);
    const zaman = Number(response.headers.get("x-liste-zamani"));
    expect(zaman).toBeGreaterThanOrEqual(once - 1000);
    expect(response.headers.get("x-liste-bayat")).toBeNull();
  });
});
