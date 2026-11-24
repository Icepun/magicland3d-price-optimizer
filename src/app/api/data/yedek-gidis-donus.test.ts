/**
 * YEDEK GİDİŞ-DÖNÜŞ — her modelin her kolonu dışa → içe BİREBİR aynı kalmalı.
 *
 * NEDEN (23 Kas 2026 denetimi, madde 19-20): yedek, şemaya sonradan eklenen 4 tabloyu ve onlarca
 * kolonu hiç taşımıyordu; geri yükleme de eski yedekte bulunmayan alanları `?? null` /
 * `?? varsayılan` ile eziyordu. Bu dosya kolon listesini ELLE YAZMAZ: alanları ve tiplerini
 * `prisma/schema.prisma`'dan okur, her alana tipine göre ayırt edici bir değer üretir. Yani şemaya
 * yeni bir kolon eklenip yedekte ya da geri yüklemede unutulursa test KENDİLİĞİNDEN kırılır.
 * Bilinçli dışlananlar `src/lib/backup-payload.ts`'teki gerekçeli istisna listelerindedir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { calculateManualOrder, type ManualOrderCalculationInput } from "@/core/manual-order";
import { canonicalDateSql, dbDateStorage } from "@/core/sqlite-date";
import { tlToKurus } from "@/lib/monthly-finance";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-yedek-gidis-donus-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

type Row = Record<string, unknown>;
type Delegate = {
  create(args: { data: Row }): Promise<Row>;
  update(args: { where: Row; data: Row }): Promise<Row>;
  findMany(): Promise<Row[]>;
};
type YedekModulu = typeof import("@/lib/backup-payload");

let importBackup: typeof import("./import/route").POST;
let exportBackup: typeof import("./export/route").GET;
let db: typeof import("@/lib/prisma").prisma;
// Yedek modülü prisma'yı içe aktarır → geçici DATABASE_URL'den ÖNCE yüklenmemeli (dinamik).
let yedek: YedekModulu;

beforeAll(async () => {
  ({ POST: importBackup } = await import("./import/route"));
  ({ GET: exportBackup } = await import("./export/route"));
  ({ prisma: db } = await import("@/lib/prisma"));
  yedek = await import("@/lib/backup-payload");
  // Şemayı kur (ilk istek de kurardı; tohumlama ondan önce yapılıyor).
  await (await import("@/lib/runtime-schema")).ensureRuntimeSchema();
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Şemayı oku (alan adı + tipi) ─────────────────────────────────────────────

type Tip = "String" | "Int" | "Float" | "Boolean" | "DateTime";
interface Alan {
  ad: string;
  tip: Tip;
  varsayilanTrue: boolean;
}
const SKALER = new Set<string>(["String", "Int", "Float", "Boolean", "DateTime"]);
const KOK = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

function semaModelleri(): Map<string, Alan[]> {
  const metin = readFileSync(path.join(KOK, "prisma", "schema.prisma"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const modeller = new Map<string, Alan[]>();
  for (const eslesme of metin.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const alanlar: Alan[] = [];
    for (const satir of eslesme[2].split("\n")) {
      const s = satir.trim();
      if (!s || s.startsWith("@@")) continue;
      const m = /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(s);
      if (!m || m[3] || !SKALER.has(m[2])) continue;
      alanlar.push({ ad: m[1], tip: m[2] as Tip, varsayilanTrue: /@default\(true\)/.test(m[5]) });
    }
    modeller.set(eslesme[1], alanlar);
  }
  return modeller;
}
const SEMA = semaModelleri();
const alanlari = (model: string): Alan[] => {
  const alanlar = SEMA.get(model);
  if (!alanlar) throw new Error(`schema.prisma'da model yok: ${model}`);
  return alanlar;
};

// ── Ayırt edici değer üretimi ────────────────────────────────────────────────

const URUN = "urun-1";
const YAZICI = "yazici-1";
const MAKARA = "makara-1";
const GRUP = "grup-1";
const FILAMENT = "filament-1";
const SABIT = "sabit-gider-1";

/** Geçerli bir manuel sipariş (yedek, hesap kaydını yeniden hesaplayıp doğruluyor). */
function manuelSiparis(): Row {
  const draft: ManualOrderCalculationInput = {
    saleTotal: 600,
    vatRate: 20,
    mode: "freeform",
    items: [
      {
        id: "manuel-kalem-1",
        productId: null,
        name: "Özel baskı",
        imageUrl: null,
        quantity: 1,
        costKnown: true,
        productionCost: 0,
        packagingCost: 0,
        filamentCost: 0,
        packagingComponents: null,
        manualUnitCost: 120,
        manualCostHasVatInvoice: true,
      },
    ],
    includeProductCost: true,
    includePackaging: false,
    commission: { amount: 0, hasVatInvoice: false },
    cargo: { amount: 30, hasVatInvoice: false },
    expenseRules: [],
    customExpenses: [],
  };
  const breakdown = calculateManualOrder(draft);
  return {
    mode: "freeform",
    statusKind: "processing",
    currency: "TRY",
    revenueKurus: tlToKurus(breakdown.grossRevenue),
    netRevenueKurus: tlToKurus(breakdown.netRevenue),
    totalCostKurus: tlToKurus(breakdown.totalCost),
    inputVatCreditKurus: tlToKurus(breakdown.inputVatCredit),
    profitKurus: breakdown.netProfit == null ? null : tlToKurus(breakdown.netProfit),
    profitPartial: breakdown.profitPartial,
    itemsJson: JSON.stringify({ version: 1, items: draft.items }),
    breakdownJson: JSON.stringify({ version: 1, draft, breakdown }),
    calculationVersion: 1,
  };
}

/**
 * Anahtar ve kısıt taşıyan alanlar. Anahtarlar (kimlik, doğal anahtar, yabancı kimlik) iki turda da
 * AYNI kalır; kısıtlı alanlar (enum, aralık) yalnız yedeğe girecek turda (tur 0) geçerli değer alır.
 */
function ozel(model: string, tur: number): Row {
  const ilk = tur === 0;
  switch (model) {
    case "Product":
      return { id: URUN, barcode: "barkod-1", ...(ilk ? { variantGroupId: GRUP } : {}) };
    case "VariantGroup":
      return { id: GRUP };
    case "ProductCost":
      return { productId: URUN, ...(ilk ? { filamentTypeId: FILAMENT } : {}) };
    case "Listing":
      return { productId: URUN, platform: "trendyol" };
    case "FilamentType":
      return { id: FILAMENT };
    case "FilamentSpool":
      return { id: MAKARA };
    case "FilamentUsage":
      return { spoolId: MAKARA, productId: URUN };
    case "AppSetting":
      return { key: "yedekTestAyari" };
    case "ExpenseRule":
      return ilk ? { type: "percentage" } : {};
    case "RecurringExpense":
      return { id: SABIT, ...(ilk ? { dayOfMonth: 15 } : {}) };
    case "ActualExpense":
      return { recurringId: SABIT, periodKey: "2026-03" };
    case "RecurringExpenseSkip":
      return { recurringId: SABIT, periodKey: "2026-02" };
    case "OrderFinanceSnapshot":
      return { platform: "trendyol", externalOrderId: "ty-1", ...(ilk ? { profitSource: "platform" } : {}) };
    case "PlatformOrderFinancial":
      return { platform: "trendyol", externalOrderId: "ty-1" };
    case "OrderItemSnapshot":
      return { platform: "trendyol", externalOrderId: "ty-1", lineIndex: 0, productId: URUN };
    case "OrderLineCost":
      return { platform: "trendyol", externalOrderId: "ty-1", lineKey: `p:${URUN}` };
    case "OrderLineLink":
      return { platform: "trendyol", lineKey: "n:test kalemi", productId: URUN };
    case "OrderCargoDesi":
      return { platform: "shopify", externalOrderId: "sh-1" };
    case "CargoShipment":
      return { platform: "shopify", externalOrderId: "sh-1", barcode: "CPR100000000009" };
    case "PriceHistory":
      return { productId: URUN };
    case "PrinterConfig":
      return { id: YAZICI };
    case "PrintFileProduct":
      return { printerConfigId: YAZICI, filename: "model.gcode", productId: URUN };
    case "ProductModelFile":
      return { productId: URUN, printerConfigId: YAZICI };
    case "ManualOrder":
      return { orderNumber: "M-YEDEK-1", ...(ilk ? manuelSiparis() : {}) };
    default:
      return {};
  }
}

/** Alanın tipine göre, alana ve tura özgü değer (kolon kayması / eski değer kalması fark edilsin). */
function deger(model: string, alan: Alan, sira: number, tur: number): unknown {
  if (alan.ad === "id") return `${model.toLowerCase()}-1`;
  switch (alan.tip) {
    case "String":
      return `${alan.ad}-${tur}`;
    case "Int":
      return 100 + sira + tur * 1000;
    case "Float":
      return 10.25 + sira + tur * 1000;
    case "Boolean":
      return tur === 0 ? !alan.varsayilanTrue : alan.varsayilanTrue;
    case "DateTime":
      return new Date(Date.UTC(2026, 0, 1 + sira, 5, 6, 7, 89) + tur * 86_400_000);
  }
}

function satirUret(model: string, tur: number): Row {
  const satir: Row = {};
  alanlari(model).forEach((alan, sira) => {
    satir[alan.ad] = deger(model, alan, sira, tur);
  });
  return { ...satir, ...ozel(model, tur) };
}

const delege = (model: string): Delegate =>
  (db as unknown as Record<string, Delegate>)[model.charAt(0).toLowerCase() + model.slice(1)];

/** Satırın kimlik kolonları (güncelleme turunda değişmezler). */
function anahtarKolonlari(model: string): string[] {
  if (model === "AppSetting") return ["key"];
  if (model === "RecurringExpenseSkip") return ["recurringId", "periodKey"];
  return ["id"];
}

/** Satırı kimliğiyle bul (AppSetting anahtarla, RecurringExpenseSkip bileşik anahtarla). */
function anahtar(model: string, satir: Row): Row {
  if (model === "AppSetting") return { key: satir.key };
  if (model === "RecurringExpenseSkip") {
    return { recurringId_periodKey: { recurringId: satir.recurringId, periodKey: satir.periodKey } };
  }
  return { id: satir.id };
}
function ayniSatir(model: string, a: Row, b: Row): boolean {
  if (model === "AppSetting") return a.key === b.key;
  if (model === "RecurringExpenseSkip") {
    return a.recurringId === b.recurringId && a.periodKey === b.periodKey;
  }
  return a.id === b.id;
}

function normal(tip: Tip, value: unknown): unknown {
  if (value == null) return null;
  if (tip === "DateTime") return new Date(value as string | number | Date).getTime();
  if (tip === "Boolean") return Boolean(value);
  return value;
}

/** Yedeklenen modeller, yabancı kimlik sırasına göre (ebeveyn önce). */
function sirali(): string[] {
  const once = ["VariantGroup", "Product", "FilamentType", "FilamentSpool", "PrinterConfig", "RecurringExpense"];
  const hepsi = Object.keys(yedek.BACKUP_TABLES);
  return [...once, ...hepsi.filter((m) => !once.includes(m))];
}

const GORSEL_0 = "data:image/png;base64,AAAA";
const GORSEL_1 = "data:image/png;base64,BBBB";
const tohum = new Map<string, Row>();

async function tohumla() {
  for (const model of sirali()) {
    const satir = satirUret(model, 0);
    await delege(model).create({ data: satir });
    tohum.set(model, satir);
  }
  await db.productModelFileThumb.create({
    data: { fileId: tohum.get("ProductModelFile")!.id as string, thumbnail: GORSEL_0 },
  });
}

/** Veritabanındaki her yedeklenen satır tohumla (tur 0) kolon kolon aynı mı? */
async function veritabaniTohumlaAyniOlmali(atla: (model: string) => readonly string[] = () => []) {
  for (const model of sirali()) {
    const beklenen = tohum.get(model)!;
    const satirlar = await delege(model).findMany();
    const gercek = satirlar.find((s) => ayniSatir(model, s, beklenen));
    expect(gercek, `${model} satırı geri yüklenmedi`).toBeDefined();
    const tipler = new Map(alanlari(model).map((a) => [a.ad, a.tip]));
    for (const kolon of yedek.backupColumns(model as keyof YedekModulu["BACKUP_TABLES"])) {
      if (atla(model).includes(kolon)) continue;
      const tip = tipler.get(kolon)!;
      expect(normal(tip, gercek![kolon]), `${model}.${kolon}`).toEqual(normal(tip, beklenen[kolon]));
    }
  }
}

/** Geri yüklenen her tarih kolonu bu motorun KANONİK biçiminde mi (karışık biçim = kayıp satır)? */
async function tarihBicimiKanonikOlmali() {
  const storage = dbDateStorage();
  for (const model of Object.keys(yedek.BACKUP_TABLES)) {
    for (const alan of alanlari(model).filter((a) => a.tip === "DateTime")) {
      const sonuc = await db.$queryRawUnsafe<Array<{ n: number | bigint }>>(
        `SELECT COUNT(*) AS n FROM "${model}" WHERE "${alan.ad}" IS NOT NULL AND NOT (${canonicalDateSql(alan.ad, storage)})`
      );
      expect(Number(sonuc[0].n), `${model}.${alan.ad} kanonik olmayan biçimde yazıldı`).toBe(0);
    }
  }
}

async function postBackup(payload: unknown, query = "") {
  const request = new Request(`http://localhost/api/data/import${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }) as NextRequest;
  return importBackup(request);
}

async function semaSurumu(): Promise<number> {
  const satir = await db.appSetting.findUnique({ where: { key: "schemaVersion" } });
  return Number(satir?.value);
}

// ── Kapsam: her model ya yedekte ya da gerekçeli istisna listesinde ─────────

describe("yedek kapsamı Prisma şemasından", () => {
  it("her Prisma modeli ya yedekte ya da gerekçeli istisna listesinde (ikisinde birden değil)", () => {
    const modeller = Object.values(Prisma.ModelName) as string[];
    const yedekte = new Set(Object.keys(yedek.BACKUP_TABLES));
    const disarida = yedek.BACKUP_EXCLUDED_MODELS as Record<string, string>;
    const eksik = modeller.filter((m) => !yedekte.has(m) && !(m in disarida));
    const ikisinde = modeller.filter((m) => yedekte.has(m) && m in disarida);
    expect(eksik, "Yeni model: BACKUP_TABLES'a ekle ya da gerekçesiyle BACKUP_EXCLUDED_MODELS'e yaz").toEqual([]);
    expect(ikisinde).toEqual([]);
    // Listelerde artık var olmayan model kalmasın.
    expect([...yedekte, ...Object.keys(disarida)].filter((m) => !modeller.includes(m))).toEqual([]);
    for (const [model, gerekce] of Object.entries(disarida)) {
      expect(gerekce.trim().length, `${model} için gerekçe`).toBeGreaterThan(10);
    }
  });

  it("dışlanan kolonlar gerçek kolon ve gerekçeli", () => {
    for (const [model, kolonlar] of Object.entries(yedek.BACKUP_EXCLUDED_FIELDS)) {
      for (const [kolon, gerekce] of Object.entries(kolonlar ?? {})) {
        expect(yedek.modelColumns(model as Prisma.ModelName)).toContain(kolon);
        expect(gerekce.trim().length).toBeGreaterThan(10);
      }
    }
  });

  it("şema okuyucusu Prisma'nın alan listesiyle birebir aynı (testin kendisi doğru mu)", () => {
    for (const model of Object.values(Prisma.ModelName)) {
      expect(alanlari(model).map((a) => a.ad).sort(), model).toEqual(
        [...yedek.modelColumns(model)].sort()
      );
    }
  });

  it("ham SQL ile okunan tabloların tarih listesi şemadaki tarih alanlarıyla aynı", () => {
    for (const [model, kolonlar] of Object.entries(yedek.RAW_DATE_COLUMNS)) {
      expect([...kolonlar].sort(), model).toEqual(
        alanlari(model).filter((a) => a.tip === "DateTime").map((a) => a.ad).sort()
      );
    }
  });
});

// ── Gidiş-dönüş ──────────────────────────────────────────────────────────────

let alinanYedek: Row;

describe("gidiş-dönüş: dışa → içe birebir", () => {
  it("her modelin her kolonu yedeğe girer ve BOŞ veritabanına aynen geri yüklenir", async () => {
    await tohumla();

    const response = await exportBackup();
    expect(response.status).toBe(200);
    alinanYedek = (await response.json()) as Row;
    expect(alinanYedek.version).toBe(yedek.BACKUP_FORMAT_VERSION);
    expect(alinanYedek.schemaVersion).toBe(await semaSurumu());

    // 1) Dışa aktarım: her kolon gövdede, değeri aynı, tarihler ISO metin.
    for (const [model, anahtarAdi] of Object.entries(yedek.BACKUP_TABLES)) {
      const dizi = alinanYedek[anahtarAdi] as Row[] | undefined;
      expect(Array.isArray(dizi), `yedekte "${anahtarAdi}" dizisi yok`).toBe(true);
      const beklenen = tohum.get(model)!;
      const satir = dizi!.find((s) => ayniSatir(model, s, beklenen));
      expect(satir, `${model} satırı yedekte yok`).toBeDefined();
      const tipler = new Map(alanlari(model).map((a) => [a.ad, a.tip]));
      for (const kolon of yedek.backupColumns(model as keyof YedekModulu["BACKUP_TABLES"])) {
        expect(kolon in satir!, `${model}.${kolon} yedekte YOK`).toBe(true);
        const tip = tipler.get(kolon)!;
        if (tip === "DateTime" && satir![kolon] != null) {
          expect(String(satir![kolon]), `${model}.${kolon} ISO metin değil`).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
          );
        }
        expect(normal(tip, satir![kolon]), `${model}.${kolon}`).toEqual(normal(tip, beklenen[kolon]));
      }
    }
    const modelDosyasi = (alinanYedek.productModelFiles as Row[])[0];
    expect(modelDosyasi.thumbnail).toBe(GORSEL_0);
    expect(modelDosyasi.storedPath).toBe("");

    // 2) Veritabanını boşalt (iç durum ayarlarına dokunmadan) ve geri yükle.
    for (const model of [...sirali()].reverse()) {
      if (model === "AppSetting") {
        await db.$executeRawUnsafe(`DELETE FROM "AppSetting" WHERE "key" = 'yedekTestAyari'`);
      } else {
        await db.$executeRawUnsafe(`DELETE FROM "${model}"`);
      }
    }
    await db.$executeRawUnsafe(`DELETE FROM "ProductModelFileThumb"`);

    const yukleme = await postBackup(alinanYedek);
    expect(yukleme.status).toBe(200);
    const sonuc = await yukleme.json();
    expect(sonuc.warnings).toEqual([]);
    expect(sonuc.stats.skipped).toBe(0);
    for (const anahtarAdi of Object.values(yedek.BACKUP_TABLES)) {
      expect(sonuc.stats[anahtarAdi], `${anahtarAdi} sayacı`).toBeGreaterThanOrEqual(1);
    }

    // 3) Geri yüklenen her kolon tohumla aynı; tarih biçimi kanonik; görsel kendi tablosunda.
    await veritabaniTohumlaAyniOlmali();
    await tarihBicimiKanonikOlmali();
    expect(
      (await db.productModelFileThumb.findUnique({ where: { fileId: modelDosyasi.id as string } }))
        ?.thumbnail
    ).toBe(GORSEL_0);
  });

  it("dolu veritabanında güncelleme yolu da her kolonu yedekteki değere getirir", async () => {
    expect(alinanYedek, "önceki test yedeği üretmeli").toBeDefined();
    // Her satırı başka değerlere çek (anahtarlar aynı kalır).
    for (const model of sirali()) {
      const veri = satirUret(model, 1);
      for (const kolon of anahtarKolonlari(model)) delete veri[kolon];
      await delege(model).update({ where: anahtar(model, tohum.get(model)!), data: veri });
    }
    await db.productModelFileThumb.update({
      where: { fileId: tohum.get("ProductModelFile")!.id as string },
      data: { thumbnail: GORSEL_1 },
    });

    const yukleme = await postBackup(alinanYedek);
    expect(yukleme.status).toBe(200);
    expect((await yukleme.json()).warnings).toEqual([]);

    await veritabaniTohumlaAyniOlmali();
    await tarihBicimiKanonikOlmali();
    expect(
      (await db.productModelFileThumb.findUnique({
        where: { fileId: tohum.get("ProductModelFile")!.id as string },
      }))?.thumbnail
    ).toBe(GORSEL_0);
  });
});

// ── Eski / yabancı yedek mevcut değeri ezmez ────────────────────────────────

/** Eski (biçim 3) bir yedeğin taşıdığı en az alanlar — gerisi YOK. */
const ESKI_ZORUNLU: Record<string, readonly string[]> = {
  VariantGroup: ["id", "name"],
  Product: ["id", "barcode", "currentSalePrice"],
  ProductCost: ["id", "productId"],
  Listing: ["id", "productId", "platform", "salePrice"],
  FilamentType: ["id", "name", "costPerGram"],
  FilamentSpool: ["id", "name"],
  FilamentUsage: ["id", "spoolId", "grams"],
  CommissionRule: ["id", "name", "commissionRate"],
  CargoRule: ["id", "name", "cargoCost"],
  ExpenseRule: ["id", "name", "type", "value"],
  ActualExpense: ["id", "name", "amountKurus", "paidAt"],
  OrderFinanceSnapshot: ["id", "platform", "externalOrderId", "orderNumber", "orderedAt", "revenueKurus", "statusKind"],
  PlatformOrderFinancial: ["id", "platform", "externalOrderId", "orderNumber", "grossRevenueKurus", "commissionKurus", "sellerRevenueKurus"],
  OrderItemSnapshot: ["id", "platform", "externalOrderId", "lineIndex", "orderedAt", "productName", "quantity", "unitPriceKurus", "lineRevenueKurus", "statusKind"],
  OrderLineCost: ["id", "platform", "externalOrderId", "lineKey", "costJson"],
  OrderLineLink: ["id", "platform", "lineKey", "productId"],
  PriceHistory: ["id", "productId", "oldPrice", "newPrice", "changeSource", "changedAt"],
  PrinterConfig: ["id", "name", "brand", "host"],
  PrintFileProduct: ["id", "printerConfigId", "filename", "productId"],
  ProductModelFile: ["id", "productId", "printerConfigId", "originalName", "fileType", "r2Key"],
};

describe("eski ya da yabancı yedek mevcut değerleri ezmez", () => {
  it("yedekte OLMAYAN alan korunur (ek filament, hesap sürümü, gerçek komisyon, kalan gram, kategori…)", async () => {
    const govde: Row = { version: 3 };
    for (const [model, alanlar] of Object.entries(ESKI_ZORUNLU)) {
      const kaynak = tohum.get(model)!;
      const satir = Object.fromEntries(alanlar.map((a) => [a, kaynak[a]]));
      govde[yedek.BACKUP_TABLES[model as keyof YedekModulu["BACKUP_TABLES"]]] = [satir];
    }

    const yukleme = await postBackup(govde);
    expect(yukleme.status).toBe(200);
    const sonuc = await yukleme.json();
    expect(sonuc.warnings[0]).toBe(yedek.YEDEK_ESKI_UYARISI);

    // Denetimde ölçülen somut örnekler.
    const maliyet = await db.productCost.findFirstOrThrow({ where: { productId: URUN } });
    expect(maliyet.ekFilamentlerJson).toBe(tohum.get("ProductCost")!.ekFilamentlerJson);
    const siparis = await db.orderFinanceSnapshot.findFirstOrThrow({ where: { externalOrderId: "ty-1" } });
    expect(siparis.calculationVersion).toBe(tohum.get("OrderFinanceSnapshot")!.calculationVersion);
    expect(siparis.profitSource).toBe("platform");
    expect(siparis.actualCommissionKurus).toBe(tohum.get("OrderFinanceSnapshot")!.actualCommissionKurus);
    expect(siparis.outputVatKurus).toBe(tohum.get("OrderFinanceSnapshot")!.outputVatKurus);
    const makara = await db.filamentSpool.findUniqueOrThrow({ where: { id: MAKARA } });
    expect(makara.remainingGrams).toBe(tohum.get("FilamentSpool")!.remainingGrams);
    expect(makara.openedAt?.getTime()).toBe((tohum.get("FilamentSpool")!.openedAt as Date).getTime());
    const urun = await db.product.findUniqueOrThrow({ where: { id: URUN } });
    expect(urun.categoryName).toBe(tohum.get("Product")!.categoryName);
    expect(urun.name).toBe(tohum.get("Product")!.name);

    // Genel kural: güncelleme damgası dışında HER kolon önceki değerinde.
    const damga: Record<string, readonly string[]> = {
      OrderFinanceSnapshot: ["syncedAt"],
      PlatformOrderFinancial: ["syncedAt"],
    };
    await veritabaniTohumlaAyniOlmali((model) => ["updatedAt", ...(damga[model] ?? [])]);
    // Görsel yedekte yoktu → kendi tablosundaki görsel yerinde.
    expect(
      (await db.productModelFileThumb.findUnique({
        where: { fileId: tohum.get("ProductModelFile")!.id as string },
      }))?.thumbnail
    ).toBe(GORSEL_0);
  });

  it("güncel biçimde alan açıkça null ise null yazılır", async () => {
    const siparisKaynak = tohum.get("OrderFinanceSnapshot")!;
    const maliyetKaynak = tohum.get("ProductCost")!;
    const yukleme = await postBackup({
      version: yedek.BACKUP_FORMAT_VERSION,
      schemaVersion: await semaSurumu(),
      orderFinanceSnapshots: [
        {
          ...Object.fromEntries(ESKI_ZORUNLU.OrderFinanceSnapshot.map((a) => [a, siparisKaynak[a]])),
          actualCommissionKurus: null,
        },
      ],
      productCosts: [{ id: maliyetKaynak.id, productId: URUN, ekFilamentlerJson: null }],
    });
    expect(yukleme.status).toBe(200);
    expect((await yukleme.json()).warnings).toEqual([]);

    const siparis = await db.orderFinanceSnapshot.findFirstOrThrow({ where: { externalOrderId: "ty-1" } });
    expect(siparis.actualCommissionKurus).toBeNull();
    // Yedekte olmayan komşu alan yine korunur.
    expect(siparis.outputVatKurus).toBe(siparisKaynak.outputVatKurus);
    const maliyet = await db.productCost.findFirstOrThrow({ where: { productId: URUN } });
    expect(maliyet.ekFilamentlerJson).toBeNull();
    expect(maliyet.filamentWeight).toBe(maliyetKaynak.filamentWeight);
  });
});

// ── Sürüm denetimi ───────────────────────────────────────────────────────────

describe("yedeğin sürümü", () => {
  it("karar kuralı", () => {
    const { backupVersionVerdict: karar, BACKUP_FORMAT_VERSION: B } = yedek;
    expect(karar({ version: B, schemaVersion: 64 }, 64)).toBe("uyumlu");
    expect(karar({ version: B, schemaVersion: 60 }, 64)).toBe("uyumlu");
    expect(karar({ version: 3 }, 64)).toBe("eski");
    expect(karar({}, 64)).toBe("eski");
    expect(karar({ version: B + 1 }, 64)).toBe("yeni");
    expect(karar({ version: B, schemaVersion: 65 }, 64)).toBe("yeni");
    // Damga okunamadıysa şema karşılaştırması atlanır (geri yükleme bloklanmaz).
    expect(karar({ version: B, schemaVersion: 65 }, null)).toBe("uyumlu");
    // Eski biçimde şema damgası ayar listesinde taşınıyordu.
    expect(karar({ version: 3, appSettings: [{ key: "schemaVersion", value: "70" }] }, 64)).toBe("yeni");
  });

  it("daha yeni biçim sürümünü kısa Türkçe hatayla reddeder ve hiçbir şey yazmaz", async () => {
    for (const query of ["", "?stream=1"]) {
      const yukleme = await postBackup(
        {
          version: yedek.BACKUP_FORMAT_VERSION + 1,
          products: [{ id: "yeni-surum-urunu", barcode: "yeni-surum", currentSalePrice: 1 }],
        },
        query
      );
      expect(yukleme.status).toBe(400);
      expect((await yukleme.json()).error).toBe(yedek.YEDEK_DAHA_YENI_HATASI);
    }
    expect(await db.product.findUnique({ where: { barcode: "yeni-surum" } })).toBeNull();
  });

  it("bu veritabanından daha yeni şemalı yedeği reddeder (eski biçimin ayar damgası dahil)", async () => {
    const simdiki = await semaSurumu();
    expect(Number.isInteger(simdiki) && simdiki > 0).toBe(true);
    const yeniSema = await postBackup({ version: yedek.BACKUP_FORMAT_VERSION, schemaVersion: simdiki + 1 });
    expect(yeniSema.status).toBe(400);
    expect((await yeniSema.json()).error).toBe(yedek.YEDEK_DAHA_YENI_HATASI);

    const eskiBicim = await postBackup({
      version: 3,
      appSettings: [{ key: "schemaVersion", value: String(simdiki + 5) }],
    });
    expect(eskiBicim.status).toBe(400);
  });

  it("uyumlu yedek uyarısız, eski yedek tek satır uyarıyla alınır", async () => {
    const uyumlu = await postBackup({ version: yedek.BACKUP_FORMAT_VERSION, schemaVersion: await semaSurumu() });
    expect(uyumlu.status).toBe(200);
    expect((await uyumlu.json()).warnings).toEqual([]);

    const eski = await postBackup({ version: 2 });
    expect(eski.status).toBe(200);
    expect((await eski.json()).warnings).toEqual([yedek.YEDEK_ESKI_UYARISI]);
  });
});

// ── Ayarlar ve gizli değerler ────────────────────────────────────────────────

describe("iç durum ve gizli değerler", () => {
  it("iç durum anahtarları (kargo göçü bayrağı dahil) geri yüklenmez", async () => {
    const IC = ["gocKargoPlatformTamam", "schemaVersion", "orderNotifyBaseline", "schemaMigrationLock"];
    const oku = async () =>
      Object.fromEntries(
        (await db.appSetting.findMany({ where: { key: { in: IC } } })).map((s) => [s.key, s.value])
      );
    const once = await oku();

    const yukleme = await postBackup({
      version: yedek.BACKUP_FORMAT_VERSION,
      schemaVersion: await semaSurumu(),
      appSettings: [...IC.map((key) => ({ key, value: "yedekten" })), { key: "normalAyar", value: "x" }],
    });
    expect(yukleme.status).toBe(200);
    expect((await yukleme.json()).stats.appSettings).toBe(1);
    expect(await oku()).toEqual(once);
    expect((await db.appSetting.findUnique({ where: { key: "normalAyar" } }))?.value).toBe("x");
  });

  it("gizli ayarlar ve dışlanan tablolar yedeğe girmez", async () => {
    await db.appSetting.create({ data: { key: "r2SecretKey", value: "cok-gizli-deger" } });
    await db.pushToken.create({ data: { token: "ExponentPushToken[gizli-cihaz]", platform: "ios" } });

    const govde = await (await exportBackup()).text();
    expect(govde).not.toContain("cok-gizli-deger");
    expect(govde).not.toContain("gizli-cihaz");
    const json = JSON.parse(govde) as Row;
    const tabloAnahtarlari = new Set<string>(Object.values(yedek.BACKUP_TABLES));
    const fazla = Object.keys(json).filter(
      (k) => Array.isArray(json[k]) && !tabloAnahtarlari.has(k)
    );
    expect(fazla).toEqual([]);
  });
});
