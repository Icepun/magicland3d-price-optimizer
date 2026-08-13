import { describe, expect, it, vi } from "vitest";

/**
 * Baskı kuyruğu — Üretim Planı'nın "hangi yazıcıda, ne kadar sürer, filament yeter mi"
 * cevabı. Burada PARA YOKTUR: hiçbir maliyet/kâr rakamı üretilmez, yalnız adet, süre ve
 * gram taşınır. En kritik davranış: BİLİNMEYEN SÜREYİ UYDURMAMAK.
 */

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/route-cache", () => ({ swr: vi.fn(async (_k: string, _t: number, fn: () => unknown) => fn()) }));

const { buildPrintQueue, SNAPSHOT_STALE_MS } = await import("@/lib/print-queue");
type KuyrukGirdisi = Parameters<typeof buildPrintQueue>[0];

const SIMDI = Date.UTC(2026, 7, 11, 9, 0, 0);

function yazici(id: string, name = id) {
  return { id, name, brand: "elegoo", accent: null };
}

function urun(
  id: string,
  stock: number,
  printTimeHours: number | null = 1,
  filamentWeight: number | null = 100,
  /** Ürün başına hedef; testlerin çoğu sabit hedefi (5) varsayar. */
  target = 5
) {
  return { id, name: `Ürün ${id}`, imageUrl: null, stock, printTimeHours, filamentWeight, target };
}

function girdi(over: Partial<KuyrukGirdisi> = {}): KuyrukGirdisi {
  return {
    products: [],
    modelFiles: [],
    printers: [],
    snapshots: [],
    spoolRemainingGrams: 100_000,
    spoolCount: 3,
    targetStock: 5,
    nowMs: SIMDI,
    ...over,
  };
}

describe("ne basılmalı", () => {
  it("eksik adet hedef ile stok farkıdır", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 2), urun("b", 0)],
        printers: [yazici("p1")],
        modelFiles: [
          { productId: "a", printerConfigId: "p1" },
          { productId: "b", printerConfigId: "p1" },
        ],
      })
    );
    const isler = sonuc.printers[0].jobs;
    expect(isler.find((j) => j.productId === "a")!.quantity).toBe(3);
    expect(isler.find((j) => j.productId === "b")!.quantity).toBe(5);
    expect(sonuc.totals.prints).toBe(8);
  });

  it("hedefe ulaşmış ürün kuyruğa girmez", () => {
    const sonuc = buildPrintQueue(
      girdi({ products: [urun("a", 5), urun("b", 9)], printers: [yazici("p1")] })
    );
    expect(sonuc.totals.products).toBe(0);
    expect(sonuc.unassigned).toEqual([]);
  });
});

describe("dosyası olmayan iş gizlenmez", () => {
  it("hiçbir yazıcıda dosyası yoksa ayrı listede görünür", () => {
    const sonuc = buildPrintQueue(
      girdi({ products: [urun("a", 0)], printers: [yazici("p1")] })
    );
    expect(sonuc.printers[0].jobs).toEqual([]);
    expect(sonuc.unassigned.map((j) => j.productId)).toEqual(["a"]);
    // Sayılmaya devam eder: plan toplamı eksilmez.
    expect(sonuc.totals.products).toBe(1);
  });

  it("kapalı/silinmiş yazıcının dosyası basılabilir saymaz", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 0)],
        printers: [yazici("p1")],
        modelFiles: [{ productId: "a", printerConfigId: "silinmis" }],
      })
    );
    expect(sonuc.unassigned.map((j) => j.productId)).toEqual(["a"]);
  });

  it("ürüne bağlı olmayan özel baskı dosyaları kuyruğa karışmaz", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 0)],
        printers: [yazici("p1")],
        modelFiles: [
          { productId: "__custom__", printerConfigId: "p1" },
          { productId: "a", printerConfigId: "p1" },
        ],
      })
    );
    expect(sonuc.printers[0].jobs.map((j) => j.productId)).toEqual(["a"]);
  });
});

describe("süre uydurulmaz", () => {
  it("baskı süresi girilmemiş iş kuyrukta kalır ama toplam süreye katılmaz", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 4, 2), urun("b", 4, null)],
        printers: [yazici("p1")],
        modelFiles: [
          { productId: "a", printerConfigId: "p1" },
          { productId: "b", printerConfigId: "p1" },
        ],
      })
    );
    const p = sonuc.printers[0];
    expect(p.jobs).toHaveLength(2);
    expect(p.queueHours).toBe(2);
    expect(p.unknownTimeJobs).toBe(1);
    expect(p.jobs.find((j) => j.productId === "b")!.totalHours).toBeNull();
    // Bitiş saati eksik bilgiyle çıktı → arayüz bunu "en erken" diye söyleyebilsin.
    expect(p.finishIsPartial).toBe(true);
  });

  it("sıfır süre girilmiş sayılmaz", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 4, 0, 0)],
        printers: [yazici("p1")],
        modelFiles: [{ productId: "a", printerConfigId: "p1" }],
      })
    );
    expect(sonuc.printers[0].jobs[0].hoursPerUnit).toBeNull();
    expect(sonuc.printers[0].jobs[0].gramsPerUnit).toBeNull();
    expect(sonuc.printers[0].finishAt).toBeNull();
  });

  it("hiç süre bilinmiyorsa bitiş saati verilmez", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 4, null)],
        printers: [yazici("p1")],
        modelFiles: [{ productId: "a", printerConfigId: "p1" }],
      })
    );
    expect(sonuc.printers[0].finishAt).toBeNull();
    expect(sonuc.printers[0].finishIsPartial).toBe(false);
  });
});

describe("bitiş saati", () => {
  it("süren baskının kalanı kuyruğun üstüne eklenir", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 4, 2)],
        printers: [yazici("p1")],
        modelFiles: [{ productId: "a", printerConfigId: "p1" }],
        snapshots: [
          {
            printerConfigId: "p1",
            status: "printing",
            online: true,
            etaSec: 3600,
            productName: "Süren iş",
            updatedAtMs: SIMDI,
          },
        ],
      })
    );
    const p = sonuc.printers[0];
    expect(p.busy).toBe(true);
    expect(p.currentEtaSec).toBe(3600);
    // 1 saat kalan + 2 saat kuyruk = 3 saat sonra.
    expect(new Date(p.finishAt!).getTime()).toBe(SIMDI + 3 * 3_600_000);
  });

  it("durum bilgisi eskiyse kalan süre kullanılmaz", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 4, 2)],
        printers: [yazici("p1")],
        modelFiles: [{ productId: "a", printerConfigId: "p1" }],
        snapshots: [
          {
            printerConfigId: "p1",
            status: "printing",
            online: true,
            etaSec: 9999,
            productName: "Eski iş",
            updatedAtMs: SIMDI - SNAPSHOT_STALE_MS - 1000,
          },
        ],
      })
    );
    const p = sonuc.printers[0];
    expect(p.status).toBe("unknown");
    expect(p.online).toBe(false);
    expect(p.currentEtaSec).toBeNull();
    expect(new Date(p.finishAt!).getTime()).toBe(SIMDI + 2 * 3_600_000);
  });

  it("kalan süre, durumun alındığı andan bu yana geçen süre kadar azalır", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [],
        printers: [yazici("p1")],
        snapshots: [
          {
            printerConfigId: "p1",
            status: "printing",
            online: true,
            etaSec: 600,
            productName: null,
            updatedAtMs: SIMDI - 120_000,
          },
        ],
      })
    );
    expect(sonuc.printers[0].currentEtaSec).toBe(480);
  });

  it("duraklatılmış yazıcının kalan süresi işlemiyor sayılır", () => {
    const sonuc = buildPrintQueue(
      girdi({
        printers: [yazici("p1")],
        snapshots: [
          {
            printerConfigId: "p1",
            status: "paused",
            online: true,
            etaSec: 1200,
            productName: "Duran iş",
            updatedAtMs: SIMDI,
          },
        ],
      })
    );
    expect(sonuc.printers[0].busy).toBe(true);
    expect(sonuc.printers[0].currentEtaSec).toBeNull();
  });
});

describe("yazıcılara dağıtım", () => {
  it("iki yazıcıda da basılabilen işler yükü dengeler", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("uzun", 4, 5), urun("kisa", 4, 1)],
        printers: [yazici("p1"), yazici("p2")],
        modelFiles: [
          { productId: "uzun", printerConfigId: "p1" },
          { productId: "uzun", printerConfigId: "p2" },
          { productId: "kisa", printerConfigId: "p1" },
          { productId: "kisa", printerConfigId: "p2" },
        ],
      })
    );
    expect(sonuc.printers[0].jobs.map((j) => j.productId)).toEqual(["uzun"]);
    expect(sonuc.printers[1].jobs.map((j) => j.productId)).toEqual(["kisa"]);
  });

  it("meşgul yazıcı boştakinin önüne geçmez", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 4, 1)],
        printers: [yazici("p1"), yazici("p2")],
        modelFiles: [
          { productId: "a", printerConfigId: "p1" },
          { productId: "a", printerConfigId: "p2" },
        ],
        snapshots: [
          {
            printerConfigId: "p1",
            status: "printing",
            online: true,
            etaSec: 7200,
            productName: "Süren iş",
            updatedAtMs: SIMDI,
          },
        ],
      })
    );
    expect(sonuc.printers[0].jobs).toEqual([]);
    expect(sonuc.printers[1].jobs.map((j) => j.productId)).toEqual(["a"]);
  });

  it("tek yazıcıda basılabilen iş başka yazıcıya kaçmaz", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 4, 3)],
        printers: [yazici("p1"), yazici("p2")],
        modelFiles: [{ productId: "a", printerConfigId: "p2" }],
      })
    );
    expect(sonuc.printers[0].jobs).toEqual([]);
    expect(sonuc.printers[1].jobs.map((j) => j.productId)).toEqual(["a"]);
  });
});

describe("filament yeterliliği", () => {
  it("makaralarda kalan gram kuyruğun altındaysa yetmiyor der", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 0, 1, 200)], // 5 adet × 200 g = 1000 g
        printers: [yazici("p1")],
        modelFiles: [{ productId: "a", printerConfigId: "p1" }],
        spoolRemainingGrams: 800,
      })
    );
    expect(sonuc.filament.neededGrams).toBe(1000);
    expect(sonuc.filament.remainingGrams).toBe(800);
    expect(sonuc.filament.enough).toBe(false);
  });

  it("gramajı girilmemiş iş sayılır — 'yeter' cevabı eksik bilgiyle verilmiş olabilir", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 4, 1, null)],
        printers: [yazici("p1")],
        modelFiles: [{ productId: "a", printerConfigId: "p1" }],
        spoolRemainingGrams: 500,
      })
    );
    expect(sonuc.filament.neededGrams).toBe(0);
    expect(sonuc.filament.enough).toBe(true);
    expect(sonuc.filament.unknownGramJobs).toBe(1);
  });

  it("dosyası olmayan işlerin filamenti de plana dahildir", () => {
    const sonuc = buildPrintQueue(
      girdi({
        products: [urun("a", 4, 1, 300)],
        printers: [yazici("p1")],
        spoolRemainingGrams: 100,
      })
    );
    expect(sonuc.unassigned).toHaveLength(1);
    expect(sonuc.filament.neededGrams).toBe(300);
    expect(sonuc.filament.enough).toBe(false);
  });
});
