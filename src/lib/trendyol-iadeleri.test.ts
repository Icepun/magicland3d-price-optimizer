/**
 * Pencere dışına düşmüş Trendyol kayıtlarına iadeyi işleyen HAM SQL — GERÇEK libSQL'de koşar
 * (dize içindeki SQL tsc/eslint/build denetimlerinin hiçbirine görünmez).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDir = mkdtempSync(path.join(tmpdir(), "trendyol-iade-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const bust = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/cache-busting", () => ({
  bustFinanceCaches: () => {
    bust.calls += 1;
  },
}));

let db: typeof import("@/lib/prisma").prisma;
let isle: typeof import("./trendyol-iadeleri").trendyolIadeleriniGecmiseIsle;
let oku: typeof import("./trendyol-iadeleri").trendyolIadeleriniOku;

beforeAll(async () => {
  const { ensureRuntimeSchema } = await import("@/lib/runtime-schema");
  await ensureRuntimeSchema();
  ({ prisma: db } = await import("@/lib/prisma"));
  ({ trendyolIadeleriniGecmiseIsle: isle, trendyolIadeleriniOku: oku } = await import(
    "./trendyol-iadeleri"
  ));
});
afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

async function siparis(id: string, statusKind: string, adetler: number[]) {
  const now = new Date().toISOString();
  await db.$executeRawUnsafe(
    `INSERT INTO "OrderFinanceSnapshot"
       ("id","platform","externalOrderId","orderNumber","orderedAt","revenueKurus","profitKurus",
        "profitPartial","statusKind","currency","syncedAt","calculationVersion","profitSource")
     VALUES (?, 'trendyol', ?, ?, ?, 24999, 6999, 0, ?, 'TRY', ?, 4, 'calculated')`,
    `ofs:${id}`,
    id,
    `no-${id}`,
    now,
    statusKind,
    now
  );
  for (const [i, adet] of adetler.entries()) {
    await db.$executeRawUnsafe(
      `INSERT INTO "OrderItemSnapshot"
         ("id","platform","externalOrderId","lineIndex","orderedAt","productId","productName",
          "quantity","unitPriceKurus","lineRevenueKurus","statusKind","currency","syncedAt")
       VALUES (?, 'trendyol', ?, ?, ?, NULL, 'Kol Standı', ?, 24999, ?, ?, 'TRY', ?)`,
      `item:${id}:${i}`,
      id,
      i,
      now,
      adet,
      24999 * adet,
      statusKind,
      now
    );
  }
}

const durum = async (id: string) =>
  (
    await db.$queryRawUnsafe<Array<{ statusKind: string }>>(
      `SELECT "statusKind" FROM "OrderFinanceSnapshot" WHERE "externalOrderId" = ?`,
      id
    )
  )[0]?.statusKind;
const kalemDurumlari = async (id: string) =>
  (
    await db.$queryRawUnsafe<Array<{ statusKind: string }>>(
      `SELECT "statusKind" FROM "OrderItemSnapshot" WHERE "externalOrderId" = ? ORDER BY "lineIndex"`,
      id
    )
  ).map((r) => r.statusKind);

describe("trendyolIadeleriniGecmiseIsle — gerçek libSQL", () => {
  it("TAM iade edilen kayıt (özet + kalemler) iade olur; kısmi, kalemsiz ve zaten iptal olanlara dokunulmaz", async () => {
    await siparis("ty-1", "delivered", [2]); // 2 adet, 2 kabul → tam
    await siparis("ty-2", "active", [1, 1]); // telefonun eski sürümünün "aktif"i — 2 satır, 2 kabul → tam
    await siparis("ty-3", "delivered", [3]); // 3 adet, 1 kabul → kısmi
    await siparis("ty-4", "delivered", []); // kalemsiz → adet bilinmiyor, iddia yok
    await siparis("ty-5", "cancelled", [1]); // zaten iptal

    const duzeltilen = await isle(
      new Map([
        ["ty-1", { kabulAdet: 2, satirSayisi: 1 }],
        ["ty-2", { kabulAdet: 2, satirSayisi: 2 }],
        ["ty-3", { kabulAdet: 1, satirSayisi: 1 }],
        ["ty-4", { kabulAdet: 1, satirSayisi: 1 }],
        ["ty-5", { kabulAdet: 1, satirSayisi: 1 }],
        ["ty-yok", { kabulAdet: 1, satirSayisi: 1 }],
      ])
    );

    expect(duzeltilen).toBe(2);
    expect(await durum("ty-1")).toBe("cancelled");
    expect(await kalemDurumlari("ty-1")).toEqual(["cancelled"]);
    expect(await durum("ty-2")).toBe("cancelled");
    expect(await kalemDurumlari("ty-2")).toEqual(["cancelled", "cancelled"]);
    expect(await durum("ty-3")).toBe("delivered");
    expect(await durum("ty-4")).toBe("delivered");
    expect(bust.calls).toBe(1);

    // İkinci tur değişiklik bulmaz (önbellek boşuna düşürülmez).
    expect(await isle(new Map([["ty-1", { kabulAdet: 2, satirSayisi: 1 }]]))).toBe(0);
    expect(bust.calls).toBe(1);
  });

  it("talep ucu patlarsa boş döner, fırlatmaz", async () => {
    const sonuc = await oku({
      listClaims: async () => {
        throw new Error("HTTP 500");
      },
    });
    expect(sonuc.size).toBe(0);
  });
});
