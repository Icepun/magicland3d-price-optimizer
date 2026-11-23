/**
 * Gider Ödemeleri + reklam bütçesi — onaylanan 6 madde (23 Kas 2026), GERÇEK SQLite üzerinde.
 *
 *   12 · silinen otomatik sabit gider bir sonraki açılışta geri gelmez (atla satırı, tek parça)
 *   13 · sabit gider kuralını silmek tek parça; yarım kalırsa hiçbir şey yazılmaz
 *   15 · reklam oranı bilinmiyorsa yeniden hesap ve ilk yakalama YAZMAZ
 *   16 · bütçe Düzelt/Kaldır dönem sınırlarını doğru kaydırır, `…Z` tarihli kaydı bulur, yeniden
 *        hesap YALNIZ aralıktaki siparişleri kapsar (ay İstanbul saatiyle)
 *   17 · gider KDV oranı uçtan uca (kayıt, liste, Panel toplamı)
 *
 * Her maddede EŞİTLİK: bugünkü veride (bütçe yok, KDV yok, atla yok) davranış/rakam eskisiyle aynı.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-gider-onay-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

/** Reklam oranı "bilinmiyor" / "az önce okunamadı" durumlarını elle açmak için. */
const h = vi.hoisted(() => ({ bilinmiyor: false, yakinHata: false }));
vi.mock("@/lib/ad-rate", async (importOriginal) => {
  const gercek = await importOriginal<typeof import("@/lib/ad-rate")>();
  return {
    ...gercek,
    adRateSnapshot: async () =>
      h.bilinmiyor ? { at: Date.now(), butceler: [], bugun: new Map(), bilinmiyor: true } : gercek.adRateSnapshot(),
    reklamOraniYakindaOkunamadi: (simdi?: number) => h.yakinHata || gercek.reklamOraniYakindaOkunamadi(simdi),
  };
});

type Prisma = typeof import("@/lib/prisma").prisma;
let db: Prisma;
let ensureRecurringExpenses: typeof import("./recurring-expense-run").ensureRecurringExpenses;
let admin: typeof import("./expense-admin");
let giderler: typeof import("./actual-expenses");
let giderRota: typeof import("../app/api/actual-expenses/route");
let giderIdRota: typeof import("../app/api/actual-expenses/[id]/route");
let butceRota: typeof import("../app/api/ad-budgets/route");
let butceIdRota: typeof import("../app/api/ad-budgets/[id]/route");
let reklam: typeof import("./ad-rate");
let ofs: typeof import("./order-finance-snapshots");
let uretilecekler: typeof import("./recurring-expense").uretilecekler;

const istek = (url: string, method = "GET", body?: unknown) =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as NextRequest;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Kolon ne biçimde yazılmış olursa olsun epoch-ms. */
async function ms(table: string, column: string, id: string): Promise<number | null> {
  const { dbEpochMs } = await import("./sqlite-date");
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${dbEpochMs(column)} AS v FROM "${table}" WHERE "id" = ?`,
    id
  );
  return rows[0]?.v == null ? null : Number(rows[0].v);
}

beforeAll(async () => {
  const { ensureRuntimeSchema } = await import("./runtime-schema");
  ({ prisma: db } = await import("@/lib/prisma"));
  await ensureRuntimeSchema();
  ({ ensureRecurringExpenses } = await import("./recurring-expense-run"));
  admin = await import("./expense-admin");
  giderler = await import("./actual-expenses");
  giderRota = await import("../app/api/actual-expenses/route");
  giderIdRota = await import("../app/api/actual-expenses/[id]/route");
  butceRota = await import("../app/api/ad-budgets/route");
  butceIdRota = await import("../app/api/ad-budgets/[id]/route");
  reklam = await import("./ad-rate");
  ofs = await import("./order-finance-snapshots");
  ({ uretilecekler } = await import("./recurring-expense"));
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  h.bilinmiyor = false;
  h.yakinHata = false;
});

/* ════════════════════════ 12 + 13 · Sabit giderler ════════════════════════ */

const SIMDI = Date.parse("2026-11-23T12:00:00+03:00");

async function kuralAc(ad: string, vatRate?: number | null): Promise<string> {
  const liste = await admin.createRecurring({
    name: ad,
    category: "Muhasebe",
    amount: 1_000,
    dayOfMonth: 5,
    startsAt: new Date("2026-08-01T00:00:00+03:00"),
    endsAt: null,
    isActive: true,
    note: null,
    ...(vatRate === undefined ? {} : { vatRate }),
  });
  return liste.find((r) => r.name === ad)!.id;
}

async function kuralKayitlari(recurringId: string) {
  return db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id","periodKey","vatRate","amountKurus" FROM "ActualExpense" WHERE "recurringId" = ? ORDER BY "periodKey"`,
    recurringId
  );
}

describe("12 · silinen otomatik sabit gider geri gelmez", () => {
  let kural = "";

  it("EŞİTLİK: atla satırı yokken üretim eskisiyle birebir aynı dönemleri açar", async () => {
    kural = await kuralAc("Muhasebe");
    expect(await ensureRecurringExpenses(SIMDI)).toBe(4);
    // Eski üretimin saf kuralı (atla tablosu yokken birebir bu dönemler açılıyordu).
    const beklenen = uretilecekler(
      {
        id: kural, name: "Muhasebe", category: "Muhasebe", amountKurus: 100_000, dayOfMonth: 5,
        startsAtMs: Date.parse("2026-08-01T00:00:00+03:00"), endsAtMs: null, isActive: true, note: null,
      },
      [],
      SIMDI
    ).map((g) => g.periodKey);
    const kayitlar = await kuralKayitlari(kural);
    expect(kayitlar.map((r) => r.periodKey)).toEqual(beklenen);
    expect(kayitlar.every((r) => r.vatRate == null)).toBe(true); // KDV'siz kural → KDV'siz kayıt
    expect(await ensureRecurringExpenses(SIMDI)).toBe(0); // ikinci tur hiçbir şey açmaz
  });

  it("otomatik kayıt silinince aynı işlemde atla satırı yazılır, üretim o ayı bir daha açmaz", async () => {
    const eylul = (await kuralKayitlari(kural)).find((r) => r.periodKey === "2026-09")!;
    const yanit = await giderIdRota.DELETE(istek("http://x/api/actual-expenses/1", "DELETE"), params(String(eylul.id)));
    expect(yanit.status).toBe(200);
    const atla = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "recurringId","periodKey" FROM "RecurringExpenseSkip"`
    );
    expect(atla).toEqual([{ recurringId: kural, periodKey: "2026-09" }]);

    expect(await ensureRecurringExpenses(SIMDI)).toBe(0); // eskiden Eylül burada geri geliyordu
    expect((await kuralKayitlari(kural)).map((r) => r.periodKey)).toEqual(["2026-08", "2026-10", "2026-11"]);
  });

  it("elle girilen gider silinince atla satırı YAZILMAZ", async () => {
    const yeni = await giderRota.POST(
      istek("http://x/api/actual-expenses", "POST", { name: "Kırtasiye", amount: 50, paidAt: "2026-11-10T09:00:00.000Z" })
    );
    const { id } = await yeni.json();
    await giderIdRota.DELETE(istek("http://x/api/actual-expenses/1", "DELETE"), params(id));
    const sayi = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*) AS n FROM "RecurringExpenseSkip"`);
    expect(Number(sayi[0].n)).toBe(1);
  });

  it("kuralın KDV oranı üretilen kayıtlara geçer", async () => {
    const kdvli = await kuralAc("Yazılım aboneliği", 20);
    await ensureRecurringExpenses(SIMDI);
    const kayitlar = await kuralKayitlari(kdvli);
    expect(kayitlar).toHaveLength(4);
    expect(kayitlar.every((r) => Number(r.vatRate) === 20)).toBe(true);
    expect((await admin.listRecurring()).find((r) => r.id === kdvli)?.vatRate).toBe(20);
  });
});

describe("13 · sabit gider kuralını silmek tek parça", () => {
  it("ilk ifade kuralı siler (işlem dışı bir yolda bile bağsız kayıt + duran kural kalmaz)", () => {
    const ifadeler = admin.kuralSilmeIfadeleri("k1");
    expect(ifadeler[0].sql).toMatch(/^DELETE FROM "RecurringExpense"/);
    expect(ifadeler.map((i) => i.sql).join("\n")).toContain(`DELETE FROM "RecurringExpenseSkip"`);
  });

  it("ikinci ifade düşerse HİÇBİR ŞEY yazılmaz (kural yerinde kalır)", async () => {
    const kural = await kuralAc("Kira");
    await ensureRecurringExpenses(SIMDI);
    await expect(
      giderler.tekParcaYaz([
        ...admin.kuralSilmeIfadeleri(kural).slice(0, 1),
        { sql: `UPDATE "BoyleBirTabloYok" SET "x" = 1`, args: [] },
      ])
    ).rejects.toThrow();
    expect((await admin.listRecurring()).some((r) => r.id === kural)).toBe(true);
    expect(await kuralKayitlari(kural)).toHaveLength(4);
  });

  it("kural silinince bağlar kopar, atla satırları gider, kayıtlar KALIR ve aylar yeniden açılmaz", async () => {
    const kural = (await admin.listRecurring()).find((r) => r.name === "Muhasebe")!.id;
    const once = await db.actualExpense.count();
    await admin.deleteRecurring(kural);
    expect((await admin.listRecurring()).some((r) => r.id === kural)).toBe(false);
    expect(await kuralKayitlari(kural)).toHaveLength(0);
    const atla = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*) AS n FROM "RecurringExpenseSkip" WHERE "recurringId" = ?`,
      kural
    );
    expect(Number(atla[0].n)).toBe(0);
    expect(await db.actualExpense.count()).toBe(once); // geçmiş ödemeler silinmez
    await ensureRecurringExpenses(SIMDI);
    expect(await db.actualExpense.count()).toBe(once); // çift sayım yok
  });
});

/* ════════════════════════ 17 · Gider KDV'si uçtan uca ════════════════════════ */

describe("17 · gider KDV oranı — kayıt, liste, Panel toplamı", () => {
  it("EŞİTLİK: oransız gider eskisi gibi; Panel toplamı tutarın tamamı (eski SUM ile aynı)", async () => {
    const ucGunOnce = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const yanit = await giderRota.POST(
      istek("http://x/api/actual-expenses", "POST", { name: "Kargo poşeti", amount: 240, paidAt: ucGunOnce })
    );
    expect(yanit.status).toBe(201);
    expect((await yanit.json()).vatRate).toBeNull();
    const from = new Date(Date.now() - 4 * 86_400_000).toISOString();
    const toplam = await giderRota.GET(istek(`http://x/api/actual-expenses?toplam=1&from=${encodeURIComponent(from)}`));
    const { dbEpochMs } = await import("./sqlite-date");
    const eskiSum = await db.$queryRawUnsafe<Array<{ t: number }>>(
      `SELECT COALESCE(SUM("amountKurus"),0) AS t FROM "ActualExpense"
        WHERE ${dbEpochMs("paidAt")} >= ? AND ${dbEpochMs("paidAt")} <= ?`,
      Date.parse(from),
      Date.now()
    );
    expect(await toplam.json()).toMatchObject({ toplam: Number(eskiSum[0].t) / 100, adet: 1 });
    expect(Number(eskiSum[0].t)).toBe(24_000);
  });

  it("%20 KDV'li gider: listede oranı görünür, Panel toplamına NET tutar girer", async () => {
    const yanit = await giderRota.POST(
      istek("http://x/api/actual-expenses", "POST", {
        name: "Yazıcı servisi", amount: 1_200, paidAt: "2030-01-06T09:00:00.000Z", vatRate: 20,
      })
    );
    const kayit = await yanit.json();
    expect(kayit.vatRate).toBe(20);
    const liste = await (await giderRota.GET(istek("http://x/api/actual-expenses"))).json();
    expect(liste.find((g: { id: string }) => g.id === kayit.id)).toMatchObject({ vatRate: 20, amount: 1_200 });
    // Gelecekteki gider "bugüne kadar" toplamına girmez → doğrudan ayırma kuralıyla doğrula.
    const satirlar = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "amountKurus","vatRate" FROM "ActualExpense" WHERE "paidAt" IS NOT NULL AND "name" IN ('Kargo poşeti','Yazıcı servisi')`
    );
    const { giderNetKurus } = await import("@/core/gider-kdv");
    expect(satirlar.reduce((t, r) => t + giderNetKurus(Number(r.amountKurus), r.vatRate), 0)).toBe(24_000 + 100_000);

    // Düzenle: oran kaldırılabilir.
    const duz = await giderIdRota.PATCH(istek("http://x/api/actual-expenses/1", "PATCH", { vatRate: null }), params(kayit.id));
    expect((await duz.json()).vatRate).toBeNull();
  });

  it("Panel toplamı (bugüne kadar): KDV'li gider net tutarla düşer", async () => {
    const dun = new Date(Date.now() - 86_400_000).toISOString();
    await giderRota.POST(istek("http://x/api/actual-expenses", "POST", { name: "Panel KDV", amount: 600, paidAt: dun, vatRate: 20 }));
    await giderRota.POST(istek("http://x/api/actual-expenses", "POST", { name: "Panel düz", amount: 300, paidAt: dun }));
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const toplam = await giderRota.GET(istek(`http://x/api/actual-expenses?toplam=1&from=${encodeURIComponent(from)}`));
    expect(await toplam.json()).toMatchObject({ toplam: 500 + 300, adet: 2 });
  });

  it("geçersiz oran reddedilir", async () => {
    const yanit = await giderRota.POST(
      istek("http://x/api/actual-expenses", "POST", { name: "Hatalı", amount: 10, paidAt: "2030-01-07T09:00:00.000Z", vatRate: 7 })
    );
    expect(yanit.status).toBe(400);
  });
});

/* ════════════════════════ 16 · Reklam bütçesi Düzelt / Kaldır ════════════════════════ */

describe("16 · reklam bütçesi dönemleri — tek parça, boşluksuz, biçimden bağımsız", () => {
  const AGU = "2026-08-01T00:00:00.000+03:00";
  const EYL = "2026-09-01T00:00:00.000+03:00";
  let a = "";
  let b = "";

  async function yeniDonem(platform: string, startsAt: string, dailyAmount = 100) {
    return butceRota.POST(istek("http://x/api/ad-budgets", "POST", { platform, dailyAmount, startsAt }));
  }

  it("yeni dönem öncekini başlangıçtan 1 ms önce kapatır; ikisi de etkin kalır", async () => {
    a = (await (await yeniDonem("trendyol", AGU)).json()).butce.id;
    const yanit = await yeniDonem("trendyol", EYL, 150);
    expect(yanit.status).toBe(200);
    b = (await yanit.json()).butce.id;
    expect(await ms("AdBudget", "validTo", a)).toBe(Date.parse(EYL) - 1);
    expect(await ms("AdBudget", "validTo", b)).toBeNull();
    const etkin = await db.adBudget.findMany({ where: { platform: "trendyol" } });
    expect(etkin.every((r) => r.isActive)).toBe(true);
  });

  it("çakışan başlangıç reddedilir", async () => {
    expect((await yeniDonem("trendyol", "2026-08-15T00:00:00.000+03:00")).status).toBe(409);
  });

  it("Düzelt başlangıcı İLERİ alırsa önceki dönemin bitişi de kayar (boşluk kalmaz)", async () => {
    const yeni = "2026-09-10T00:00:00.000+03:00";
    const yanit = await butceIdRota.PUT(istek("http://x/api/ad-budgets/b", "PUT", { startsAt: yeni }), params(b));
    expect(yanit.status).toBe(200);
    expect(await ms("AdBudget", "validFrom", b)).toBe(Date.parse(yeni));
    expect(await ms("AdBudget", "validTo", a)).toBe(Date.parse(yeni) - 1);
  });

  it("Düzelt başlangıcı GERİ alırsa önceki dönem kısalır; önceki dönemin başını geçemez", async () => {
    const geri = "2026-08-20T00:00:00.000+03:00";
    expect((await butceIdRota.PUT(istek("http://x/api/ad-budgets/b", "PUT", { startsAt: geri }), params(b))).status).toBe(200);
    expect(await ms("AdBudget", "validTo", a)).toBe(Date.parse(geri) - 1);
    const cokGeri = "2026-07-15T00:00:00.000+03:00";
    expect((await butceIdRota.PUT(istek("http://x/api/ad-budgets/b", "PUT", { startsAt: cokGeri }), params(b))).status).toBe(409);
  });

  it("Kaldır önceki dönemi bu kaydın bittiği yere kadar uzatır (açık kayıt → yeniden açılır)", async () => {
    expect((await butceIdRota.DELETE(istek("http://x/api/ad-budgets/b", "DELETE"), params(b))).status).toBe(200);
    expect(await db.adBudget.findUnique({ where: { id: b } })).toBeNull();
    expect(await ms("AdBudget", "validTo", a)).toBeNull();
  });

  it("telefonun `…Z` biçiminde yazdığı dönemi de bulur; kapalı kaydı silince önceki ona kadar uzar", async () => {
    await db.$executeRawUnsafe(
      `INSERT INTO "AdBudget" ("id","platform","dailyAmount","validFrom","validTo","isActive","createdAt") VALUES
         ('p-z','shopify',80,'2026-06-01T00:00:00.000Z','2026-06-30T23:59:59.999Z',1,'2026-06-01T00:00:00.000Z'),
         ('c-z','shopify',90,'2026-07-01T00:00:00.000Z','2026-07-31T23:59:59.999Z',1,'2026-07-01T00:00:00.000Z'),
         ('n-z','shopify',95,'2026-08-01T00:00:00.000Z',NULL,1,'2026-08-01T00:00:00.000Z')`
    );
    expect((await butceIdRota.DELETE(istek("http://x/api/ad-budgets/c", "DELETE"), params("c-z"))).status).toBe(200);
    // Eskiden metin eşitliği tutmuyordu → Haziran kapalı kalıyor, Temmuz reklamsız oluyordu.
    expect(await ms("AdBudget", "validTo", "p-z")).toBe(Date.parse("2026-07-31T23:59:59.999Z"));
    expect(await ms("AdBudget", "validTo", "n-z")).toBeNull(); // sonraki dönemle çakışma yok
    // Yerel test motoru (klasik SQLite) `…Z` metnini Prisma DateTime'a çeviremiyor — yalnız bu
    // testin satırları; sonraki testlerin reklam okuması bozulmasın diye temizlenir.
    await db.$executeRawUnsafe(`DELETE FROM "AdBudget" WHERE "platform" = 'shopify'`);
    delete (globalThis as Record<string, unknown>).__mlhub_adRateCache;
  });
});

/* ═══════════════ 16 · Yeniden hesap YALNIZ aralıktaki siparişler · ay İstanbul ═══════════════ */

async function siparisEkle(platform: string, id: string, orderedAt: string) {
  await db.orderFinanceSnapshot.create({
    data: {
      id: `ofs:${platform}:${id}`,
      platform,
      externalOrderId: id,
      orderNumber: id,
      orderedAt: new Date(orderedAt),
      revenueKurus: 10_000,
      profitKurus: 2_000,
      profitPartial: false,
      statusKind: "delivered",
      currency: "TRY",
      syncedAt: new Date(),
      calculationVersion: 1,
    },
  });
}

describe("16 · bütçe aralığı — ilgisiz siparişler yeniden yazılmaz", () => {
  beforeAll(async () => {
    await siparisEkle("trendyol", "eyl-1-tr", "2026-08-31T22:00:00.000Z"); // İstanbul: 1 Eylül 01:00
    await siparisEkle("shopify", "eyl-1-sh", "2026-08-31T22:00:00.000Z");
    await siparisEkle("trendyol", "eyl-10", "2026-09-10T10:00:00.000Z"); // aynı ay, bütçeden ÖNCE
    await siparisEkle("trendyol", "eyl-20", "2026-09-20T10:00:00.000Z");
  });

  it("aralık + platform süzülür, ay İstanbul saatiyle bulunur", async () => {
    const r = await reklam.reklamAraligindakiSiparisler({
      basMs: Date.parse("2026-09-01T00:00:00+03:00"),
      bitMs: Date.parse("2026-09-05T00:00:00+03:00"),
      platform: "trendyol",
    });
    expect(r.siparisler).toEqual([{ platform: "trendyol", externalOrderId: "eyl-1-tr" }]);
    expect(r.aylar).toEqual(["2026-09"]); // UTC ayı "2026-08" derdi
    const hepsi = await reklam.reklamAraligindakiSiparisler({
      basMs: Date.parse("2026-09-01T00:00:00+03:00"),
      bitMs: Date.parse("2026-09-05T00:00:00+03:00"),
      platform: "all",
    });
    expect(hepsi.siparisler.map((s) => s.externalOrderId).sort()).toEqual(["eyl-1-sh", "eyl-1-tr"]);
  });

  it("yeniden hesap ayın TAMAMINI değil, yalnız bütçe başlangıcından sonraki siparişi kapsar", async () => {
    let bitti = false;
    const sayi = await reklam.reklamEtkisiniYenidenHesapla(
      { basMs: Date.parse("2026-09-15T00:00:00+03:00"), bitMs: Date.parse("2026-09-30T23:59:59+03:00"), platform: "trendyol" },
      { onDone: () => (bitti = true) }
    );
    expect(sayi).toBe(1);
    await ofs.flushFinanceMonthRecalc();
    const durum = ofs.financeRecalcState()!;
    expect(durum.months).toEqual(["2026-09"]);
    expect(durum.result?.totalOrders).toBe(1); // eyl-10 (bütçeden önce) ve diğer platform dışarıda
    expect(bitti).toBe(true);
  });

  it("aralıkta sipariş yoksa tur açılmaz, önbellek yine düşer", async () => {
    let bitti = false;
    const sayi = await reklam.reklamEtkisiniYenidenHesapla(
      { basMs: Date.parse("2031-01-01T00:00:00Z"), bitMs: Date.parse("2031-02-01T00:00:00Z"), platform: "all" },
      { onDone: () => (bitti = true) }
    );
    expect(sayi).toBe(0);
    expect(bitti).toBe(true);
  });
});

/* ═══════════════ 15 · Bilinmeyen reklam oranıyla HİÇBİR kâr yazılmaz ═══════════════ */

describe("15 · reklam oranı bilinmiyorsa yeniden hesap ve ilk yakalama yazmaz", () => {
  it("yeniden hesap hata verir ve kayıtlı kâra dokunmaz", async () => {
    const once = await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId: "eyl-20" } });
    h.bilinmiyor = true;
    await expect(ofs.recalculateFinanceMonths(["2026-09"])).rejects.toThrow(/Reklam bütçesi okunamadı/);
    const sonra = await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId: "eyl-20" } });
    expect(sonra?.profitKurus).toBe(once?.profitKurus);
    expect(sonra?.syncedAt.getTime()).toBe(once?.syncedAt.getTime());
  });

  it("ilk yakalama: az önce okunamadıysa tur yazılmaz; okunabiliyorsa eskisi gibi yazılır", async () => {
    const siparis = {
      platform: "trendyol", id: "yeni-1", orderNumber: "Y1", date: "2026-11-20T10:00:00.000Z",
      total: 100, profit: 30, profitPartial: false, profitSource: "calculated" as const,
      estimatedCommission: 0, actualCommission: null, statusKind: "delivered", currency: "TRY",
    };
    h.yakinHata = true;
    const ertelenen = ofs.adRateDeferredSnapshotJobs();
    ofs.scheduleOrderFinanceSnapshots([siparis]);
    await ofs.flushOrderFinanceSnapshots();
    expect(ofs.adRateDeferredSnapshotJobs()).toBe(ertelenen + 1);
    expect(await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId: "yeni-1" } })).toBeNull();

    h.yakinHata = false; // EŞİTLİK: normal durumda davranış aynı
    ofs.scheduleOrderFinanceSnapshots([siparis]);
    await ofs.flushOrderFinanceSnapshots();
    expect((await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId: "yeni-1" } }))?.profitKurus).toBe(3_000);
  });
});
