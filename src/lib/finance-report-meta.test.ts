/**
 * Raporlar yan bilgileri: Trendyol komisyon sayıları + veri kaynağı sağlığı.
 *
 * Korunan hatalar:
 *  1) Başlık "193 siparişte gerçek komisyon kullanılıyor" diyordu; 193 indirilen KAYIT sayısıydı,
 *     gerçekten uygulanan sipariş 101'di. Sayım artık uygulanmış siparişten üretilir.
 *  2) "Komisyonu netleşmiş ama kârı hâlâ tahminle kayıtlı" sipariş sayısı hiç bildirilmiyordu.
 *  3) Dize içindeki ham SQL üç denetimden de (tsc/eslint/build) kaçar → GERÇEK libSQL'de koşar.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseTrendyolCommissionStats,
  readFinanceSourceHealth,
  trendyolCommissionStatsSql,
} from "./finance-report-meta";

vi.mock("./orders-cache", () => ({
  getOrdersCache: () => globalThis.__ordersCacheStub ?? null,
}));

declare global {
  var __ordersCacheStub: { at: number; body: Record<string, unknown> } | null | undefined;
}

afterEach(() => {
  globalThis.__ordersCacheStub = null;
});

describe("Trendyol komisyon sayıları — GERÇEK libSQL", () => {
  it("uygulanan ve bekleyen siparişleri ayrı ayrı sayar", async () => {
    const { PrismaLibSQL } = await import("@prisma/adapter-libsql");
    const { PrismaClient } = await import("@/generated/prisma/client");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "komisyon-"));
    const db = new PrismaClient({
      adapter: new PrismaLibSQL({ url: `file:${path.join(dir, "t.db")}` }),
    });
    try {
      await db.$executeRawUnsafe(
        `CREATE TABLE "OrderFinanceSnapshot" (
          "id" TEXT NOT NULL PRIMARY KEY, "platform" TEXT NOT NULL,
          "externalOrderId" TEXT NOT NULL, "actualCommissionKurus" INTEGER)`
      );
      await db.$executeRawUnsafe(
        `CREATE TABLE "PlatformOrderFinancial" (
          "id" TEXT NOT NULL PRIMARY KEY, "platform" TEXT NOT NULL,
          "externalOrderId" TEXT NOT NULL)`
      );

      const snapshot = (id: string, platform: string, actual: number | null) =>
        db.$executeRawUnsafe(
          `INSERT INTO "OrderFinanceSnapshot" ("id","platform","externalOrderId","actualCommissionKurus")
           VALUES (?,?,?,?)`,
          id,
          platform,
          id,
          actual
        );
      const financial = (id: string, platform = "trendyol") =>
        db.$executeRawUnsafe(
          `INSERT INTO "PlatformOrderFinancial" ("id","platform","externalOrderId") VALUES (?,?,?)`,
          `f-${id}`,
          platform,
          id
        );

      await snapshot("t1", "trendyol", 1_500); // komisyon uygulanmış
      await snapshot("t2", "trendyol", null); // kayıt var, uygulanmamış
      await snapshot("t3", "trendyol", null); // hiç komisyon kaydı yok
      await snapshot("s1", "shopify", null); // başka platform sayılmaz
      await financial("t1");
      await financial("t2");
      await financial("yok"); // eşleşmeyen kayıt
      await financial("t3", "hepsiburada"); // başka platform

      const stats = parseTrendyolCommissionStats(
        await db.$queryRawUnsafe<Array<Record<string, unknown>>>(trendyolCommissionStatsSql())
      );

      expect(stats).toEqual({ records: 3, orders: 3, applied: 1, pending: 1 });
      // Uygulanan sayı, indirilen kayıt sayısından KÜÇÜK olabilir — başlığın yanlış olduğu yer.
      expect(stats.applied).toBeLessThan(stats.records);
    } finally {
      await db.$disconnect();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* geçici klasör işletim sistemine kalsın */
      }
    }
  }, 60_000);

  it("boş tabloda sıfır döner, hata vermez", () => {
    expect(parseTrendyolCommissionStats([])).toEqual({
      records: 0,
      orders: 0,
      applied: 0,
      pending: 0,
    });
  });

  it("sürücü BigInt döndürse de sayıya çevrilir", () => {
    // libSQL sürücüsü COUNT(*) sonucunu BigInt döndürebiliyor; ham sayı olarak yanıta
    // konursa JSON.stringify patlar.
    expect(
      parseTrendyolCommissionStats([
        {
          records: BigInt(193),
          orders: BigInt(224),
          applied: BigInt(101),
          pending: BigInt(89),
        },
      ])
    ).toEqual({ records: 193, orders: 224, applied: 101, pending: 89 });
  });
});

describe("veri kaynağı sağlığı", () => {
  const CEKIM = "2026-08-13T04:06:53.970Z";
  /** Çekimden bir dakika sonrası — damga TAZE. */
  const HEMEN = new Date("2026-08-13T04:07:53.970Z");

  it("hiç sipariş çekimi yoksa 'bilinmiyor' döner (tam sanılmaz)", () => {
    globalThis.__ordersCacheStub = null;
    expect(readFinanceSourceHealth(HEMEN)).toEqual({
      complete: null,
      missing: [],
      computedAt: null,
    });
  });

  it("alınamayan kaynakları adıyla bildirir", () => {
    globalThis.__ordersCacheStub = {
      at: 1_800_000_000_000,
      body: {
        dataComplete: false,
        computedAt: CEKIM,
        summary: { quality: { missingSources: ["Trendyol", "Manuel siparişler"] } },
      },
    };
    expect(readFinanceSourceHealth(HEMEN)).toEqual({
      complete: false,
      missing: ["Trendyol", "Manuel siparişler"],
      computedAt: CEKIM,
    });
  });

  it("her kaynak yanıt verdiyse tam işaretlenir", () => {
    globalThis.__ordersCacheStub = {
      at: 1_800_000_000_000,
      body: {
        dataComplete: true,
        computedAt: CEKIM,
        summary: { quality: { missingSources: [] } },
      },
    };
    expect(readFinanceSourceHealth(HEMEN).complete).toBe(true);
  });

  it("BAYAT damga 'her şey yolunda' DEMEZ (diskten yüklenen dünkü gövde tuzağı)", () => {
    // 🔴 DENETİMDE BULUNDU: sipariş önbelleği uygulama yeniden başlarken DİSKTEN yükleniyor
    // ve disk kopyası 3 güne kadar taze sayılıyor; üstelik diske yalnız TAM gövdeler yazılıyor.
    // "Uygulamayı aç, doğrudan Raporlar'a git" akışında dünkü gövde "tüm kaynaklar alındı"
    // diyordu — o an bir pazaryeri çökmüş olsa bile. Korumanın çalışmadığı senaryo tam buydu.
    globalThis.__ordersCacheStub = {
      at: 1_800_000_000_000,
      body: {
        dataComplete: true,
        computedAt: CEKIM,
        summary: { quality: { missingSources: [] } },
      },
    };
    const ucGunSonra = new Date(Date.parse(CEKIM) + 3 * 24 * 60 * 60_000);
    expect(readFinanceSourceHealth(ucGunSonra)).toEqual({
      complete: null,
      missing: [],
      computedAt: CEKIM,
    });
  });

  it("eski gövdede damga yoksa önbellek zamanı kullanılır", () => {
    const at = Date.UTC(2026, 7, 13, 4, 0, 0);
    globalThis.__ordersCacheStub = {
      at,
      body: { summary: { quality: { missingSources: ["Shopify"] } } },
    };
    const health = readFinanceSourceHealth(new Date(at + 60_000));
    expect(health.missing).toEqual(["Shopify"]);
    // dataComplete alanı yoksa eksik kaynak listesinden türetilir.
    expect(health.complete).toBe(false);
    expect(health.computedAt).toBe(new Date(at).toISOString());
  });

  it("bozuk gövde uygulamayı düşürmez", () => {
    globalThis.__ordersCacheStub = {
      at: 1_800_000_000_000,
      body: { summary: { quality: { missingSources: "Trendyol" } } },
    };
    expect(readFinanceSourceHealth(new Date(1_800_000_060_000)).missing).toEqual([]);
  });
});
