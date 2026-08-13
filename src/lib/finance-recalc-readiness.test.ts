/**
 * "Eski hesapla kayıtlı" siparişlerin YENİDEN HESAPLANABİLİRLİK dökümü.
 *
 * NEDEN: Raporlar "18 sipariş eski hesaplamayla kayıtlı" diyor, düğmeye basınca HİÇBİR ŞEY
 * değişmiyordu — o siparişlerin ürün geçmişi kayıtlı olmadığı için ASLA yeniden
 * hesaplanamıyorlar. Bu testler "düzeltilebilir" ile "asla düzeltilemez" ayrımının hem
 * TOPLAMDA hem AY BAŞINA doğru üretildiğini kilitler.
 *
 * Ham SQL (LEFT JOIN + dbEpochMs) GERÇEK libSQL üzerinde koşturulur: bu projede bir kez
 * dize içindeki geçersiz SQL tsc/eslint/derlemenin üçünden de kaçıp uygulamayı 205 saniye
 * açtırmamıştı.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FINANCE_CALCULATION_VERSION } from "@/core/finance-version";
import type { FinanceRecalcCandidate } from "./finance-recalc-readiness";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-readiness-"));
const dbFile = path.join(tempDir, "readiness.db").replace(/\\/g, "/");
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.TURSO_REPLICA_PATH;

// ⚠️ STATİK import KULLANMA: ESM'de importlar yukarıdaki process.env atamalarından ÖNCE
// çalışır ve prisma.ts DATABASE_URL'i göremeden kurulur (bütün dosya patlar).
let readReadiness: typeof import("./finance-recalc-readiness").readFinanceRecalcReadiness;
let summarizeRecalcReadiness: typeof import("./finance-recalc-readiness").summarizeRecalcReadiness;
let db: typeof import("@/lib/prisma").prisma;

const OLD_VERSION = FINANCE_CALCULATION_VERSION - 1;

function candidate(
  isoDate: string,
  calculationVersion: number,
  hasItemHistory: boolean
): FinanceRecalcCandidate {
  return { orderedAt: new Date(isoDate), calculationVersion, hasItemHistory };
}

/** Kayıtlı bir sipariş özeti (+ istenirse kalem geçmişi) oluşturur. */
async function seed(options: {
  id: string;
  orderedAt: string;
  calculationVersion: number;
  withItems: boolean;
  platform?: string;
}): Promise<void> {
  const platform = options.platform ?? "trendyol";
  await db.$executeRawUnsafe(
    `INSERT INTO "OrderFinanceSnapshot"
       ("id","platform","externalOrderId","orderNumber","orderedAt","revenueKurus","profitKurus",
        "profitPartial","statusKind","currency","calculationVersion","syncedAt")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    `finance:${platform}:${options.id}`,
    platform,
    options.id,
    options.id,
    options.orderedAt,
    10_000,
    2_000,
    0,
    "delivered",
    "TRY",
    options.calculationVersion,
    "2026-08-13T00:00:00.000+00:00"
  );
  if (!options.withItems) return;
  await db.$executeRawUnsafe(
    `INSERT INTO "OrderItemSnapshot"
       ("id","platform","externalOrderId","lineIndex","orderedAt","productId","productName",
        "quantity","unitPriceKurus","lineRevenueKurus","statusKind","currency","syncedAt")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    `item:${platform}:${options.id}:0`,
    platform,
    options.id,
    0,
    options.orderedAt,
    "p1",
    "Ürün",
    1,
    10_000,
    10_000,
    "delivered",
    "TRY",
    "2026-08-13T00:00:00.000+00:00"
  );
}

beforeAll(async () => {
  const { ensureRuntimeSchema } = await import("./runtime-schema");
  ({
    readFinanceRecalcReadiness: readReadiness,
    summarizeRecalcReadiness,
  } = await import("./finance-recalc-readiness"));
  ({ prisma: db } = await import("@/lib/prisma"));
  await ensureRuntimeSchema();
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* Windows'ta libSQL dosya tanıtıcısı açık kalabiliyor; testin sonucunu etkilemez */
  }
});

describe("summarizeRecalcReadiness (saf toplama)", () => {
  it("düzeltilebilir ile ASLA düzeltilemezi ayırır", () => {
    const summary = summarizeRecalcReadiness([
      candidate("2026-08-05T09:00:00.000Z", OLD_VERSION, true), // düzeltilebilir
      candidate("2026-08-06T09:00:00.000Z", OLD_VERSION, false), // asla
      candidate("2026-08-07T09:00:00.000Z", FINANCE_CALCULATION_VERSION, true), // güncel
    ]);

    expect(summary.totalOrders).toBe(3);
    expect(summary.outdatedOrders).toBe(2);
    expect(summary.recalculableOrders).toBe(1);
    expect(summary.blockedOrders).toBe(1);
    expect(summary.blockedReasons["no-item-history"]).toBe(1);
  });

  it("güncel ama kalem geçmişi olmayan sipariş engelli SAYILMAZ", () => {
    // Yeniden hesap gerekmiyorsa kalem geçmişinin olmaması bir sorun değildir; kullanıcıyı
    // düzeltemeyeceği bir şey için uyarmak gürültüdür.
    const summary = summarizeRecalcReadiness([
      candidate("2026-08-05T09:00:00.000Z", FINANCE_CALCULATION_VERSION, false),
    ]);
    expect(summary.outdatedOrders).toBe(0);
    expect(summary.blockedOrders).toBe(0);
    expect(summary.blockedReasons).toEqual({});
  });

  it("ay dökümü TOPLAMLA birebir tutar ve eskiden yeniye sıralanır", () => {
    const summary = summarizeRecalcReadiness([
      candidate("2026-06-10T09:00:00.000Z", OLD_VERSION, false),
      candidate("2026-08-01T09:00:00.000Z", OLD_VERSION, true),
      candidate("2026-07-15T09:00:00.000Z", OLD_VERSION, true),
      candidate("2026-07-16T09:00:00.000Z", FINANCE_CALCULATION_VERSION, true),
    ]);

    expect(summary.months.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(summary.months.reduce((sum, m) => sum + m.outdatedOrders, 0)).toBe(
      summary.outdatedOrders
    );
    expect(summary.months.reduce((sum, m) => sum + m.blockedOrders, 0)).toBe(
      summary.blockedOrders
    );
    expect(summary.months.find((m) => m.month === "2026-06")).toMatchObject({
      totalOrders: 1,
      outdatedOrders: 1,
      recalculableOrders: 0,
      blockedOrders: 1,
    });
  });

  /**
   * Ay sınırı Europe/Istanbul'a göredir (UTC+3): 31 Temmuz 22:00 UTC = 1 Ağustos 01:00 TR.
   * UTC'ye göre kovalanırsa sipariş yanlış aya düşer ve kullanıcı "bu ay" düğmesiyle onu
   * hiç yakalayamaz.
   */
  it("ay sınırını Europe/Istanbul'a göre kovalar", () => {
    const summary = summarizeRecalcReadiness([
      candidate("2026-07-31T22:00:00.000Z", OLD_VERSION, true),
    ]);
    expect(summary.months.map((m) => m.month)).toEqual(["2026-08"]);
  });
});

describe("readFinanceRecalcReadiness (gerçek libSQL)", () => {
  beforeAll(async () => {
    await seed({
      id: "rd-1",
      orderedAt: "2026-07-15T09:00:00.000+00:00",
      calculationVersion: OLD_VERSION,
      withItems: true,
    });
    await seed({
      id: "rd-2",
      orderedAt: "2026-07-16T09:00:00.000+00:00",
      calculationVersion: OLD_VERSION,
      withItems: false,
    });
    await seed({
      id: "rd-3",
      orderedAt: "2026-08-02T09:00:00.000+00:00",
      calculationVersion: FINANCE_CALCULATION_VERSION,
      withItems: true,
    });
    // Eski epoch-ms biçiminde yazılmış satır da OKUNMALI (karışık depolama tuzağı).
    await seed({
      id: "rd-4",
      orderedAt: String(new Date("2026-08-03T09:00:00.000Z").getTime()),
      calculationVersion: OLD_VERSION,
      withItems: false,
    });
    // Manuel siparişin finansı ManualOrder'da; buraya girmemeli.
    await seed({
      id: "rd-manual",
      orderedAt: "2026-08-04T09:00:00.000+00:00",
      calculationVersion: OLD_VERSION,
      withItems: false,
      platform: "manual",
    });
  }, 60_000);

  it("kalem geçmişi olan/olmayan ayrımını veritabanından doğru okur", async () => {
    const summary = await readReadiness();

    expect(summary.calculationVersion).toBe(FINANCE_CALCULATION_VERSION);
    expect(summary.totalOrders).toBe(4); // manuel sayılmaz
    expect(summary.outdatedOrders).toBe(3);
    expect(summary.recalculableOrders).toBe(1); // rd-1
    expect(summary.blockedOrders).toBe(2); // rd-2, rd-4
    expect(summary.blockedReasons["no-item-history"]).toBe(2);
  });

  it("epoch-ms tamsayı olarak yazılmış satırı da doğru aya koyar", async () => {
    const summary = await readReadiness();
    const august = summary.months.find((m) => m.month === "2026-08");
    expect(august).toBeDefined();
    expect(august!.totalOrders).toBe(2); // rd-3 + rd-4
    expect(august!.blockedOrders).toBe(1); // rd-4
  });

  it("`since` süzgeci depolama tipinden bağımsız çalışır", async () => {
    const summary = await readReadiness({ since: new Date("2026-08-01T00:00:00.000Z") });
    // Temmuz satırları düşer, epoch-ms yazılmış Ağustos satırı DÜŞMEZ.
    expect(summary.totalOrders).toBe(2);
    expect(summary.months.map((m) => m.month)).toEqual(["2026-08"]);
  });
});
