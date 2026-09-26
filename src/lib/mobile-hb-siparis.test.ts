import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HEPSIBURADA_STATUS_KINDS } from "@/core/order-status-kind";

/**
 * TELEFONUN HEPSİBURADA SİPARİŞ OKUMASI — masaüstüyle AYNI davranış.
 *
 * Telefon kopyası masaüstünün üç düzeltmesinden geri kalmıştı (27 Eyl 2026):
 *  1. iptal/iade listeleri hiç okunmuyordu → teslimden sonra iade edilen sipariş telefonun
 *     cirosunda ve yazdığı finans geçmişinde "satıldı" kalıyordu,
 *  2. özet listelerde teslim/kargo damgası sipariş tarihi sayılıyordu → finans geçmişine yanlış
 *     `orderedAt` (ay kayması),
 *  3. açık siparişler tek sayfa okunuyordu.
 * Bu dosya telefonun GERÇEK `getHepsiburadaOrders` fonksiyonunu çalıştırır; yalnız ağ katmanı
 * (`fetchT`) sahte. Masaüstü karşılıkları: `app/api/orders/orders-route.test.ts`.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

type Satir = Record<string, unknown>;
type TalepYaniti = Satir[] | { status: number };

const h = vi.hoisted(() => ({
  acikSayfalar: [] as Satir[][],
  paketler: {} as Record<string, Satir[]>,
  /** Yol şablonu (mağaza kimliği `{mid}`) → kayıtlar ya da hata durumu. Yoksa 404. */
  talepler: {} as Record<string, TalepYaniti>,
  detaylar: {} as Record<string, Satir>,
  istekler: [] as string[],
}));

vi.mock("@/lib/api/http", () => ({
  fetchT: async (url: string) => {
    h.istekler.push(url);
    const u = new URL(url);
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const yol = u.pathname.replace("/merchantid/m-1", "/merchantid/{mid}");
    const yanit = (status: number, body: unknown = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      text: async () => JSON.stringify(body),
    });
    const detay = /^\/orders\/merchantid\/\{mid\}\/ordernumber\/(.+)$/.exec(yol);
    if (detay) {
      const d = h.detaylar[decodeURIComponent(detay[1])];
      return d ? yanit(200, d) : yanit(404);
    }
    if (yol === "/orders/merchantid/{mid}") return yanit(200, { items: h.acikSayfalar[offset / 100] ?? [] });
    const paket = /^\/packages\/merchantid\/\{mid\}(?:\/(shipped|delivered|undelivered))?$/.exec(yol);
    if (paket) return yanit(200, { items: offset === 0 ? h.paketler[paket[1] ?? ""] ?? [] : [] });
    const t = h.talepler[yol];
    if (!t) return yanit(404);
    if ("status" in t) return yanit(t.status);
    return yanit(200, { items: offset === 0 ? t : [] });
  },
}));

/**
 * Telefon modülü `@/…` takma adlarını TELEFONUN kökünden çözer; kök `tsc` onları çözemez. Yol bu
 * yüzden değişkende: `tsc` dosyayı programa katmaz, vitest çalışma anında yükler (`@/lib/api/http`
 * yukarıda sahte, `@core` iki tarafta aynı klasör). Modülün kendi tipleri telefon `tsc`'sinde denetlenir.
 */
const TELEFON_HB_MODULU = "../../mobile/src/lib/api/hepsiburada";
interface TelefonSiparisi {
  id: string;
  status: string;
  date: number | null;
  total: number;
  dataIncomplete?: boolean;
}

async function telefonSiparisleri(): Promise<TelefonSiparisi[]> {
  const m = (await import(/* @vite-ignore */ TELEFON_HB_MODULU)) as {
    getHepsiburadaOrders: (gun: number) => Promise<TelefonSiparisi[]>;
  };
  return m.getHepsiburadaOrders(30);
}

/** Masaüstünün iptal kovası — telefonun `isCancelledOrder`'ı aynı adları kullanır (aşağıda doğrulanıyor). */
const iptalMi = (status: string) => HEPSIBURADA_STATUS_KINDS[status]?.kind === "cancelled";

const gunOnce = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const kalem = (fiyat: number) => ({ quantity: 1, unitPrice: fiyat, productName: "Ürün", merchantSku: "SKU" });

beforeEach(() => {
  // Detay önbelleği modül düzeyinde: her test temiz bir modülle başlasın.
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_HEPSIBURADA_MERCHANT_ID", "m-1");
  vi.stubEnv("EXPO_PUBLIC_HEPSIBURADA_SECRET_KEY", "s-1");
  vi.stubEnv("EXPO_PUBLIC_HEPSIBURADA_DEV_USERNAME", "dev");
  vi.stubEnv("EXPO_PUBLIC_HEPSIBURADA_ENV", "live");
  h.acikSayfalar = [];
  h.paketler = {};
  h.talepler = {};
  h.detaylar = {};
  h.istekler = [];
});

describe("açık siparişler", () => {
  it("tek sayfayla sınırlı kalmaz, sayfalanarak çekilir", async () => {
    const li = (i: number) => ({ orderNumber: `HB-${i}`, status: "Open", orderDate: gunOnce(1), ...kalem(10) });
    h.acikSayfalar = [
      Array.from({ length: 100 }, (_, i) => li(i)),
      Array.from({ length: 30 }, (_, i) => li(100 + i)),
    ];

    const siparisler = await telefonSiparisleri();

    expect(siparisler).toHaveLength(130);
    expect(siparisler.reduce((t, o) => t + o.total, 0)).toBe(1300);
  });
});

describe("sipariş tarihi", () => {
  it("teslim tarihi, siparişin VERİLİŞ tarihi olarak yazılmaz", async () => {
    const verilis = gunOnce(3);
    const teslim = gunOnce(1);
    h.paketler = { delivered: [{ OrderNumber: "T1", orderDate: verilis, DeliveredDate: teslim }] };
    // Detay yanıtında tarih YOK: telefonda hata tam bu durumda görünüyordu (özetin tarihi kalıyor).
    h.detaylar = { T1: { items: [kalem(100)] } };

    const [o] = await telefonSiparisleri();

    // `finance-sync` bu alanı `orderedAt` olarak yazar — ay buna göre belirlenir.
    expect(o.date).toBe(Date.parse(verilis));
    expect(o.date).not.toBe(Date.parse(teslim));
  });

  it("kargo listesinde de oluşturulma tarihi kargo tarihinin önünde", async () => {
    const olusturma = gunOnce(4);
    h.paketler = { shipped: [{ OrderNumber: "K1", ShippedDate: gunOnce(1), CreatedDate: olusturma }] };
    h.detaylar = { K1: { items: [kalem(50)] } };

    const [o] = await telefonSiparisleri();

    expect(o.date).toBe(Date.parse(olusturma));
  });
});

describe("iptal / iade listeleri", () => {
  it("iade listesinde çıkan teslim sipariş iptal kovasına düşer (ciroya girmez)", async () => {
    h.paketler = { delivered: [{ OrderNumber: "R1", DeliveredDate: gunOnce(1) }] };
    h.detaylar = { R1: { orderDate: gunOnce(2), items: [kalem(120)] } };
    h.talepler = { "/packages/merchantid/{mid}/returned": [{ OrderNumber: "R1", status: "Returned" }] };

    const [o] = await telefonSiparisleri();

    expect(o.status).toBe("Returned");
    expect(iptalMi(o.status)).toBe(true);
    // Tutar olduğu gibi kalır; ciroya girip girmemesine durum karar verir.
    expect(o.total).toBe(120);
  });

  it("iade listesi siparişin kendi durumunu doğrulamıyorsa ciroya DOKUNULMAZ", async () => {
    h.paketler = { delivered: [{ OrderNumber: "K1", DeliveredDate: gunOnce(1) }] };
    h.detaylar = { K1: { orderDate: gunOnce(2), items: [kalem(90)] } };
    h.talepler = { "/packages/merchantid/{mid}/cancelled": [{ OrderNumber: "K1" }] };

    const [o] = await telefonSiparisleri();

    expect(o.status).toBe("Delivered");
    expect(iptalMi(o.status)).toBe(false);
  });

  it("yalnız iptal listesindeki sipariş iptal olarak eklenir (ikinci aday yoldan)", async () => {
    h.talepler = { "/orders/merchantid/{mid}/cancelled": [{ OrderNumber: "C1", orderDate: gunOnce(2) }] };
    h.detaylar = { C1: { orderDate: gunOnce(2), items: [kalem(70)] } };

    const siparisler = await telefonSiparisleri();

    expect(siparisler).toHaveLength(1);
    expect(siparisler[0]).toMatchObject({ id: "hb-C1", status: "Cancelled", total: 70 });
    expect(iptalMi(siparisler[0].status)).toBe(true);
  });

  it("iptal/iade ucu yoksa sipariş akışı etkilenmez ve yok olan yol aynı çekimde tekrar denenmez", async () => {
    h.paketler = { delivered: [{ OrderNumber: "N1", DeliveredDate: gunOnce(1) }] };
    h.detaylar = { N1: { orderDate: gunOnce(2), items: [kalem(60)] } };

    const siparisler = await telefonSiparisleri();

    expect(siparisler).toHaveLength(1);
    expect(siparisler[0]).toMatchObject({ status: "Delivered", total: 60 });
    const talepIstekleri = h.istekler.filter((u) => /\/(cancelled|returned)\b|\/claims\//.test(u));
    expect(talepIstekleri).toHaveLength(4); // 2 tür × 2 aday, birer kez
  });

  it("iptal/iade ucu sunucu hatası verirse siparişler yine gelir", async () => {
    h.paketler = { delivered: [{ OrderNumber: "N2", DeliveredDate: gunOnce(1) }] };
    h.detaylar = { N2: { orderDate: gunOnce(2), items: [kalem(40)] } };
    h.talepler = {
      "/packages/merchantid/{mid}/cancelled": { status: 500 },
      "/packages/merchantid/{mid}/returned": { status: 429 },
    };

    const siparisler = await telefonSiparisleri();

    expect(siparisler).toHaveLength(1);
    expect(siparisler[0]).toMatchObject({ status: "Delivered", total: 40 });
  });
});

describe("detayı alınamayan sipariş", () => {
  /**
   * Telefon bu siparişi ₺0 ciroyla finans geçmişine yazıyor ve masaüstünün doğru kaydını
   * EZİYORDU. Artık tutarı "bilinmiyor" işaretli gelir; özet ve finans senkronu atlar
   * (bkz. mobile-ciro-disi-siparis.test.ts).
   */
  it("listede kalır ama tutarı BİLİNMİYOR olarak işaretlenir", async () => {
    h.paketler = {
      delivered: [
        { OrderNumber: "D1", orderDate: gunOnce(2) },
        { OrderNumber: "D2", orderDate: gunOnce(2) },
      ],
    };
    // Yalnız D1'in detayı gelir; D2'ninki 404.
    h.detaylar = { D1: { orderDate: gunOnce(2), items: [kalem(100)] } };

    const siparisler = await telefonSiparisleri();
    const bul = (id: string) => siparisler.find((o) => o.id === id);

    expect(bul("hb-D1")).toMatchObject({ total: 100, dataIncomplete: false });
    expect(bul("hb-D2")).toMatchObject({ total: 0, dataIncomplete: true, status: "Delivered" });
  });
});

describe("bağlantılar", () => {
  it("telefon listeleri masaüstüyle ORTAK çekirdekten topluyor; kendi kopyası kalmadı", () => {
    const kaynak = oku("mobile/src/lib/api/hepsiburada.ts");
    expect(kaynak).toContain('from "@core/hb-siparis"');
    expect(kaynak).toContain("hbSiparisleriTopla(");
    // Teslim/kargo damgasını okuyan bir satır kalmadı (tarih kuralı çekirdekte).
    expect(kaynak).not.toMatch(/\.(DeliveredDate|ShippedDate|UndeliveredDate)\b/);
    expect(oku("mobile/src/core/hb-siparis.ts")).toBe(oku("src/core/hb-siparis.ts"));
  });

  it("telefonun iptal kovası masaüstünün HB iptal durumlarının hepsini tanıyor", () => {
    const kaynak = oku("mobile/src/lib/api/orders.ts");
    const satir = /hepsiburada: new Set\(\[([^\]]*)\]\)/.exec(kaynak);
    expect(satir).not.toBeNull();
    const telefon = new Set([...satir![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    const masaustu = Object.entries(HEPSIBURADA_STATUS_KINDS)
      .filter(([, v]) => v.kind === "cancelled")
      .map(([k]) => k);
    expect([...telefon].sort()).toEqual(masaustu.sort());
  });
});
