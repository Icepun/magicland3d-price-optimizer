import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import {
  anlikDurumAnahtari, yazmaKarari, yazmaIfadeleri, KALP_ATISI_MS, TAM_YAZMA_MS,
  type AnlikDurum, type YazmaKalemi,
} from "./anlik-durum-yazma";

const durum = (ek: Partial<AnlikDurum> = {}): AnlikDurum => ({
  name: "U1 Üst", brand: "snapmaker", status: "printing", online: true, statusMessage: null,
  productName: "Vazo", productImage: "data:image/png;base64,AAAA", progress: 0.42, nozzle: 215, bed: 60,
  currentFilename: "vazo.gcode", etaSec: 3600, detail: '{"live":{"x":1,"y":2,"z":3}}', ...ek,
});

describe("içerik parmak izi", () => {
  it("saniyelik kalan süre ve küsuratlı ilerleme yeni yazma doğurmaz", () => {
    const a = anlikDurumAnahtari(durum({ etaSec: 3600, progress: 0.421 }));
    expect(anlikDurumAnahtari(durum({ etaSec: 3609, progress: 0.424 }))).toBe(a);
    expect(anlikDurumAnahtari(durum({ etaSec: 3660 }))).not.toBe(a);
    expect(anlikDurumAnahtari(durum({ progress: 0.43 }))).not.toBe(a);
  });

  it("nozulun canlı konumu değişince içerik değişmiş sayılır (telefondaki 3B bunu izliyor)", () => {
    expect(anlikDurumAnahtari(durum({ detail: '{"live":{"x":9,"y":2,"z":3}}' }))).not.toBe(anlikDurumAnahtari(durum()));
  });

  it("görsel parmak izine girmez — değişimi ayrıca izlenir", () => {
    expect(anlikDurumAnahtari(durum({ productImage: "başka" }))).toBe(anlikDurumAnahtari(durum()));
  });
});

describe("bu tur ne yazılacak", () => {
  const T0 = 1_800_000_000_000;
  const k = anlikDurumAnahtari(durum());

  it("oturumun ilk yazması TAM satırdır (satır hiç olmayabilir)", () => {
    expect(yazmaKarari({ yazilanAnahtar: undefined, anahtar: k, sonYazma: undefined, sonTam: undefined, simdi: T0 })).toBe("tam");
  });

  it("içerik aynı ve damga tazeyse yazma yok", () => {
    expect(yazmaKarari({ yazilanAnahtar: k, anahtar: k, sonYazma: T0, sonTam: T0, simdi: T0 + KALP_ATISI_MS - 1 })).toBe("yok");
  });

  it("içerik aynı ama damga eskidiyse yalnız kalp atışı", () => {
    expect(yazmaKarari({ yazilanAnahtar: k, anahtar: k, sonYazma: T0, sonTam: T0, simdi: T0 + KALP_ATISI_MS })).toBe("kalp");
  });

  it("içerik değiştiyse kısmi güncelleme — damga taze olsa da HEMEN", () => {
    expect(yazmaKarari({ yazilanAnahtar: k, anahtar: k + "x", sonYazma: T0, sonTam: T0, simdi: T0 + 10_000 })).toBe("kismi");
  });

  it("onarım aralığı dolduysa sıradaki yazma TAM olur — ama yazacak bir şey yokken zorlanmaz", () => {
    const g = { yazilanAnahtar: k, sonTam: T0 };
    expect(yazmaKarari({ ...g, anahtar: k + "x", sonYazma: T0 + TAM_YAZMA_MS - 5_000, simdi: T0 + TAM_YAZMA_MS })).toBe("tam");
    expect(yazmaKarari({ ...g, anahtar: k, sonYazma: T0 + TAM_YAZMA_MS - 60_000, simdi: T0 + TAM_YAZMA_MS })).toBe("tam");
    expect(yazmaKarari({ ...g, anahtar: k, sonYazma: T0 + TAM_YAZMA_MS - 5_000, simdi: T0 + TAM_YAZMA_MS })).toBe("yok");
  });
});

/**
 * EŞİTLİK: yeni yol (tek istekte tam / kısmi / kalp ifadeleri) hangi sırayla çalışırsa çalışsın,
 * satır "en son durumun tamamı"na eşit olmalı — eskiden her yazma satırın tamamını gönderiyordu.
 */
describe("veritabanında eski yöntemle aynı satır", () => {
  const klasor = mkdtempSync(path.join(tmpdir(), "magicland-anlik-test-"));
  let sayac = 0;
  let db: Client;
  // Canlı veritabanındaki kolon sırası (pragma table_info, 19 Kas 2026).
  const TANIM = `CREATE TABLE "PrinterSnapshot" (
    "printerConfigId" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "brand" TEXT NOT NULL, "status" TEXT NOT NULL,
    "online" BOOLEAN NOT NULL DEFAULT false, "productName" TEXT, "productImage" TEXT, "progress" REAL NOT NULL DEFAULT 0,
    "nozzle" INTEGER NOT NULL DEFAULT 0, "bed" INTEGER NOT NULL DEFAULT 0, "currentFilename" TEXT, "etaSec" INTEGER,
    "updatedAt" DATETIME NOT NULL, "statusMessage" TEXT, "detail" TEXT)`;

  beforeEach(async () => {
    db = createClient({ url: `file:${path.join(klasor, `anlik-${++sayac}.db`).replace(/\\/g, "/")}` });
    await db.execute(TANIM);
  });
  afterAll(() => {
    try { db?.close(); } catch { /* zaten kapalı */ }
    try { rmSync(klasor, { recursive: true, force: true }); } catch { /* Windows dosyayı geç bırakabilir */ }
  });

  const yaz = async (kalemler: YazmaKalemi[], damga: string) => {
    await db.batch(yazmaIfadeleri(kalemler, damga) as never, "write");
  };
  const satir = async (id: string) =>
    (await db.execute({ sql: `SELECT * FROM "PrinterSnapshot" WHERE "printerConfigId" = ?`, args: [id] })).rows[0];
  const beklenen = (id: string, d: AnlikDurum, damga: string) => ({
    printerConfigId: id, name: d.name, brand: d.brand, status: d.status, online: d.online ? 1 : 0,
    productName: d.productName, productImage: d.productImage, progress: d.progress, nozzle: d.nozzle, bed: d.bed,
    currentFilename: d.currentFilename, etaSec: d.etaSec, updatedAt: damga, statusMessage: d.statusMessage, detail: d.detail,
  });

  it("tam yazma satırı oluşturur; ikinci tam yazma günceller (çift satır olmaz)", async () => {
    await yaz([{ printerConfigId: "a", durum: durum(), tur: "tam", gorselDegisti: true }], "t1");
    const yeni = durum({ status: "paused", statusMessage: "Filament bitti", progress: 0.5 });
    await yaz([{ printerConfigId: "a", durum: yeni, tur: "tam", gorselDegisti: false }], "t2");
    expect({ ...(await satir("a")) }).toEqual(beklenen("a", yeni, "t2"));
    expect(Number((await db.execute(`SELECT COUNT(*) n FROM "PrinterSnapshot"`)).rows[0].n)).toBe(1);
  });

  it("kısmi güncelleme görseli göndermez ama satırdaki görsel yerinde kalır", async () => {
    const ilk = durum();
    await yaz([{ printerConfigId: "a", durum: ilk, tur: "tam", gorselDegisti: true }], "t1");
    const sonra = durum({ progress: 0.61, detail: '{"live":{"x":50,"y":60,"z":7}}', etaSec: 1200 });
    const ifadeler = yazmaIfadeleri([{ printerConfigId: "a", durum: sonra, tur: "kismi", gorselDegisti: false }], "t2");
    expect(ifadeler).toHaveLength(1);
    expect(ifadeler[0].sql).not.toContain("productImage");
    expect(JSON.stringify(ifadeler[0].args)).not.toContain("data:image");
    await db.batch(ifadeler as never, "write");
    expect({ ...(await satir("a")) }).toEqual(beklenen("a", sonra, "t2"));
  });

  it("görsel değiştiyse kısmi güncelleme onu da yazar; null'a dönerse siler", async () => {
    await yaz([{ printerConfigId: "a", durum: durum(), tur: "tam", gorselDegisti: true }], "t1");
    const yeniGorsel = durum({ productImage: "https://cdn.ornek/yeni.png" });
    await yaz([{ printerConfigId: "a", durum: yeniGorsel, tur: "kismi", gorselDegisti: true }], "t2");
    expect((await satir("a")).productImage).toBe("https://cdn.ornek/yeni.png");
    await yaz([{ printerConfigId: "a", durum: durum({ productImage: null }), tur: "kismi", gorselDegisti: true }], "t3");
    expect((await satir("a")).productImage).toBeNull();
  });

  it("kalp atışı yalnız damgayı tazeler, birden çok yazıcı TEK ifadede", async () => {
    const a = durum(), b = durum({ name: "A1", brand: "bambu", status: "idle", online: true, productImage: null, detail: null });
    await yaz([
      { printerConfigId: "a", durum: a, tur: "tam", gorselDegisti: true },
      { printerConfigId: "b", durum: b, tur: "tam", gorselDegisti: true },
    ], "t1");
    const ifadeler = yazmaIfadeleri([
      { printerConfigId: "a", durum: durum({ status: "DEĞİŞMEMELİ" }), tur: "kalp", gorselDegisti: false },
      { printerConfigId: "b", durum: b, tur: "kalp", gorselDegisti: false },
    ], "t2");
    expect(ifadeler).toHaveLength(1);
    await db.batch(ifadeler as never, "write");
    expect({ ...(await satir("a")) }).toEqual(beklenen("a", a, "t2"));
    expect({ ...(await satir("b")) }).toEqual(beklenen("b", b, "t2"));
  });

  it("karışık bir tur: her yazıcı için sonuç, satırın tamamını yazmakla AYNI", async () => {
    const ad = ["a", "b", "c", "d", "e"];
    const son = new Map<string, AnlikDurum>();
    // Tur 1: beşi de ilk kez yazılıyor.
    const ilk = ad.map((id, i) => durum({ name: `Yazıcı ${i}`, progress: i / 10, productImage: i % 2 ? `data:image/png;base64,${"B".repeat(2000 + i)}` : null }));
    await yaz(ad.map((id, i) => ({ printerConfigId: id, durum: ilk[i], tur: "tam" as const, gorselDegisti: true })), "t1");
    ad.forEach((id, i) => son.set(id, ilk[i]));
    // Tur 2: a ilerledi (kısmi), b görsel değişti (kısmi+görsel), c yalnız damga, d hiç yazılmıyor, e çevrimdışı (tam).
    const a2 = { ...ilk[0], progress: 0.9, detail: '{"live":{"x":7}}' };
    const b2 = { ...ilk[1], productImage: "data:image/png;base64,YENI", currentFilename: "baska.gcode" };
    const e2 = durum({ name: "Yazıcı 4", status: "offline", online: false, productName: null, productImage: null, progress: 0, nozzle: 0, bed: 0, currentFilename: null, etaSec: null, detail: null });
    await yaz([
      { printerConfigId: "a", durum: a2, tur: "kismi", gorselDegisti: false },
      { printerConfigId: "b", durum: b2, tur: "kismi", gorselDegisti: true },
      { printerConfigId: "c", durum: ilk[2], tur: "kalp", gorselDegisti: false },
      { printerConfigId: "e", durum: e2, tur: "tam", gorselDegisti: true },
    ], "t2");
    son.set("a", a2); son.set("b", b2); son.set("e", e2);
    const damga: Record<string, string> = { a: "t2", b: "t2", c: "t2", d: "t1", e: "t2" };
    for (const id of ad) expect({ ...(await satir(id)) }, id).toEqual(beklenen(id, son.get(id)!, damga[id]));
  });

  it("satır dışarıdan silinmişse kısmi güncelleme sessizce geçer, sonraki TAM yazma geri getirir", async () => {
    await yaz([{ printerConfigId: "a", durum: durum(), tur: "tam", gorselDegisti: true }], "t1");
    await db.execute(`DELETE FROM "PrinterSnapshot"`);
    await yaz([{ printerConfigId: "a", durum: durum({ progress: 0.7 }), tur: "kismi", gorselDegisti: false }], "t2");
    expect(await satir("a")).toBeUndefined();
    const d = durum({ progress: 0.8 });
    await yaz([{ printerConfigId: "a", durum: d, tur: "tam", gorselDegisti: true }], "t3");
    expect({ ...(await satir("a")) }).toEqual(beklenen("a", d, "t3"));
  });

  it("yazacak bir şey yoksa ifade üretilmez", () => {
    expect(yazmaIfadeleri([], "t")).toEqual([]);
  });
});
