import { describe, expect, it, vi } from "vitest";

/**
 * Satış hızı türetmesi — Üretim Planı'nın sırasını ve "satmayan ürün" süzgecini bu besliyor.
 *
 * BURADA PARA YOK: hiçbir tutar, oran veya yuvarlama sınanmaz. Sınanan tek şey adet/tarih
 * sayımının dürüstlüğü ve en önemlisi: GEÇMİŞ AZKEN RAKAM UYDURMAMASI.
 */

vi.mock("@/lib/prisma", () => ({ prisma: { $queryRawUnsafe: vi.fn(async () => []) } }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));

const {
  coverageStart,
  deriveSalesInsights,
  DEAD_STOCK_DAYS,
  MIN_HISTORY_DAYS,
  SALES_WINDOW_DAYS,
} = await import("./route");

const GUN = 86_400_000;
const SIMDI = Date.UTC(2026, 7, 11, 12, 0, 0);

function gunOnce(gun: number): number {
  return SIMDI - gun * GUN;
}

function satir(
  productId: string,
  gunOncesi: number,
  quantity = 1,
  statusKind = "delivered"
) {
  return { productId, orderedAt: gunOnce(gunOncesi), quantity, statusKind };
}

describe("yetersiz geçmişte rakam uydurulmaz", () => {
  it("hiç satış yokken hız da ölü stok da hazır sayılmaz", () => {
    const sonuc = deriveSalesInsights([], null, SIMDI);
    expect(sonuc.historyDays).toBe(0);
    expect(sonuc.ready).toBe(false);
    expect(sonuc.deadStockReady).toBe(false);
    expect(sonuc.items).toEqual([]);
  });

  it("geçmiş eşiğin altındayken kaç gün sonra anlamlı olacağını söyler", () => {
    const sonuc = deriveSalesInsights([satir("a", 3)], gunOnce(5), SIMDI);
    expect(sonuc.historyDays).toBe(5);
    expect(sonuc.ready).toBe(false);
    expect(sonuc.readyInDays).toBe(MIN_HISTORY_DAYS - 5);
    expect(sonuc.deadStockInDays).toBe(DEAD_STOCK_DAYS - 5);
  });

  it("eşik dolunca hız açılır, ölü stok hâlâ 90 günü bekler", () => {
    const sonuc = deriveSalesInsights([satir("a", 3)], gunOnce(MIN_HISTORY_DAYS), SIMDI);
    expect(sonuc.ready).toBe(true);
    expect(sonuc.readyInDays).toBe(0);
    expect(sonuc.deadStockReady).toBe(false);
  });

  it("90 günlük geçmiş birikince ölü stok ölçülebilir olur", () => {
    const sonuc = deriveSalesInsights([satir("a", 3)], gunOnce(DEAD_STOCK_DAYS), SIMDI);
    expect(sonuc.deadStockReady).toBe(true);
    expect(sonuc.deadStockInDays).toBe(0);
  });
});

describe("geçmişin güvenilir başlangıcı", () => {
  it("kısa geçmişli satış kanalı belirler — uzun olan yanıltmasın", () => {
    // Bir kanalda 200 gün, diğerinde 30 gün geçmiş varsa 200 gün demek, kısa geçmişli
    // kanalın ürünlerine haksız yere "satmıyor" damgası vurmak olurdu.
    expect(coverageStart([gunOnce(200), gunOnce(30)])).toBe(gunOnce(30));
  });

  it("hiç kayıt yoksa geçmiş yok sayılır", () => {
    expect(coverageStart([])).toBeNull();
    expect(coverageStart([0])).toBeNull();
  });

  it("ölü stok süzgeci kısa geçmişli kanal yüzünden kilitli kalır", () => {
    const baslangic = coverageStart([gunOnce(300), gunOnce(20)]);
    const sonuc = deriveSalesInsights([satir("a", 2)], baslangic, SIMDI);
    expect(sonuc.historyDays).toBe(20);
    expect(sonuc.deadStockReady).toBe(false);
  });
});

describe("adet sayımı", () => {
  it("aynı ürünün satırlarını toplar, 30 günlük sayacı ayrı tutar", () => {
    const sonuc = deriveSalesInsights(
      [satir("a", 2, 3), satir("a", 10, 2), satir("a", 60, 5)],
      gunOnce(DEAD_STOCK_DAYS),
      SIMDI
    );
    const urun = sonuc.items.find((i) => i.productId === "a")!;
    expect(urun.soldInWindow).toBe(10);
    expect(urun.soldRecent).toBe(5);
    expect(urun.daysSinceLastSale).toBe(2);
  });

  it("iptal edilen satır satışa sayılmaz", () => {
    const sonuc = deriveSalesInsights(
      [satir("a", 2, 4, "cancelled"), satir("a", 3, 1)],
      gunOnce(DEAD_STOCK_DAYS),
      SIMDI
    );
    expect(sonuc.items.find((i) => i.productId === "a")!.soldInWindow).toBe(1);
  });

  it("pencereden eski satır sayıma girmez", () => {
    const sonuc = deriveSalesInsights(
      [satir("a", SALES_WINDOW_DAYS + 5, 9), satir("a", 1, 1)],
      gunOnce(200),
      SIMDI
    );
    expect(sonuc.items.find((i) => i.productId === "a")!.soldInWindow).toBe(1);
  });

  it("ürün eşleşmemiş satır ve sıfır adet yok sayılır", () => {
    const sonuc = deriveSalesInsights(
      [
        { productId: null, orderedAt: gunOnce(1), quantity: 4, statusKind: "delivered" },
        satir("a", 1, 0),
      ],
      gunOnce(DEAD_STOCK_DAYS),
      SIMDI
    );
    expect(sonuc.items).toEqual([]);
  });
});

describe("kaç günde bir satıyor", () => {
  it("payda ölçülen gündür — kısa geçmiş 90 güne bölünmez", () => {
    // 30 günlük geçmişte 10 adet satan ürün "3 günde bir" satar; 90'a bölseydik "9 günde bir"
    // diyip yanlış biçimde yavaş gösterirdik.
    const sonuc = deriveSalesInsights(
      [satir("a", 5, 10)],
      gunOnce(30),
      SIMDI
    );
    expect(sonuc.items[0].daysPerSale).toBeCloseTo(3, 6);
  });

  it("geçmiş pencereden uzunsa payda pencerede sabitlenir", () => {
    const sonuc = deriveSalesInsights([satir("a", 5, 9)], gunOnce(400), SIMDI);
    expect(sonuc.items[0].daysPerSale).toBeCloseTo(SALES_WINDOW_DAYS / 9, 6);
  });
});

describe("sıralama ve ölü stok işareti", () => {
  it("çok satan başta döner", () => {
    const sonuc = deriveSalesInsights(
      [satir("yavas", 4, 1), satir("hizli", 4, 7)],
      gunOnce(DEAD_STOCK_DAYS),
      SIMDI
    );
    expect(sonuc.items.map((i) => i.productId)).toEqual(["hizli", "yavas"]);
  });

  it("pencere içinde satan ürün ölü stok sayılmaz", () => {
    const sonuc = deriveSalesInsights([satir("a", 89, 1)], gunOnce(DEAD_STOCK_DAYS), SIMDI);
    expect(sonuc.items[0].deadStock).toBe(false);
  });
});
