import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

/**
 * Hızlı aramanın (Ctrl+K) okuduğu HAFİF ürün listesi.
 *
 * Barkod ve stok kodu bu yanıtta yokken arama onları bulamıyor, her tuşta ayrı bir
 * sunucu araması açılıyordu (13 haneli barkod ~8 sn). Gizli/pasif ürünler de aranabilmeli:
 * satıştan kaldırılmış ürünün maliyetine bakmak da bir arama sebebi.
 */

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-products-lite-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let listProducts: typeof import("./route").GET;
let db: typeof import("@/lib/prisma").prisma;

interface LiteRow {
  id: string;
  name: string;
  barcode: string | null;
  sku: string | null;
  hidden: boolean;
  isActive: boolean;
  variantLabel: string | null;
  variantGroup: { id: string; name: string } | null;
  currentSalePrice: number;
}

async function readLite(query: string): Promise<LiteRow[]> {
  const response = await listProducts(
    new NextRequest(`http://localhost/api/products${query}`)
  );
  expect(response.status).toBe(200);
  return (await response.json()) as LiteRow[];
}

beforeAll(async () => {
  ({ GET: listProducts } = await import("./route"));
  ({ prisma: db } = await import("@/lib/prisma"));
  const { ensureRuntimeSchema } = await import("@/lib/runtime-schema");
  await ensureRuntimeSchema();

  const group = await db.variantGroup.create({ data: { name: "Kalemlik" } });
  await db.product.create({
    data: {
      barcode: "8681111111111",
      sku: "KLM-SARI",
      name: "Kalemlik Sarı",
      categoryName: "Ofis",
      currentSalePrice: 120,
      variantGroupId: group.id,
      variantLabel: "Sarı",
    },
  });
  await db.product.create({
    data: {
      barcode: "8682222222222",
      sku: "VZO-01",
      name: "Vazo",
      categoryName: "Dekor",
      currentSalePrice: 90,
      isActive: false,
    },
  });
  await db.product.create({
    data: {
      barcode: "8683333333333",
      sku: "ESK-01",
      name: "Eski Ürün",
      categoryName: "Dekor",
      currentSalePrice: 0,
      hidden: true,
    },
  });
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("hafif ürün listesi", () => {
  it("barkod ve stok kodunu döndürür (arama bunlarla eşleşiyor)", async () => {
    const rows = await readLite("?filter=all&lite=1");
    const kalemlik = rows.find((row) => row.sku === "KLM-SARI");
    expect(kalemlik?.barcode).toBe("8681111111111");
    expect(kalemlik?.sku).toBe("KLM-SARI");
  });

  it("varyant grubunu ve etiketini döndürür (satırlar ayırt edilebilsin)", async () => {
    const rows = await readLite("?filter=all&lite=1");
    const kalemlik = rows.find((row) => row.sku === "KLM-SARI");
    expect(kalemlik?.variantGroup?.name).toBe("Kalemlik");
    expect(kalemlik?.variantLabel).toBe("Sarı");
  });

  it("pasif ürün listede kalır ve pasif olarak işaretlenir", async () => {
    const rows = await readLite("?filter=all&lite=1");
    const vazo = rows.find((row) => row.sku === "VZO-01");
    expect(vazo?.isActive).toBe(false);
  });

  it("gizli ürün varsayılan listede yoktur", async () => {
    const rows = await readLite("?filter=all&lite=1");
    expect(rows.some((row) => row.sku === "ESK-01")).toBe(false);
  });

  it("istendiğinde gizli ürün de gelir ve gizli olarak işaretlenir", async () => {
    const rows = await readLite("?filter=all&lite=1&includeHidden=1");
    const eski = rows.find((row) => row.sku === "ESK-01");
    expect(eski?.hidden).toBe(true);
    // Gizliyi eklemek diğerlerini düşürmez.
    expect(rows.some((row) => row.sku === "KLM-SARI")).toBe(true);
  });

  it("yalnız-gizli görünümü hâlâ sadece gizlileri verir", async () => {
    const rows = await readLite("?filter=hidden&lite=1");
    expect(rows.map((row) => row.sku)).toEqual(["ESK-01"]);
  });
});
