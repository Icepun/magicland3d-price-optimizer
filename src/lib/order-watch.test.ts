/**
 * Hızlı bildirim taraması — bildirim ADAYLARININ doğru doğduğunu sabitler.
 *
 * Bu tarama kâr hesabından tamamen ayrıdır; burada yalnız "hangi olay bildirilir, hangisi
 * bildirilmez" kuralları doğrulanır (yanlış ürüne bildirim atmamak dahil).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {}, remotePrisma: {} }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/push-notify", () => ({ pushToAllDevices: vi.fn(async () => {}) }));

import {
  buildInventoryNotifications,
  inventoryNotificationIds,
  matchScanOrders,
  type ScanOrder,
  type ScanProduct,
  INVENTORY_TYPES,
} from "./order-watch";
import { buildNewOrderNotification } from "./order-notify";

const urun = (over: Partial<ScanProduct> & { id: string; name: string }): ScanProduct => ({
  stock: 5,
  madeToOrder: false,
  barcodes: [],
  externalIds: [],
  skus: [],
  ...over,
});

const siparis = (over: Partial<ScanOrder> & { id: string }): ScanOrder => ({
  platform: "trendyol",
  orderNumber: "1001",
  orderedAtMs: null,
  actionable: true,
  lines: [],
  ...over,
});

describe("matchScanOrders + yeni sipariş bildirimi", () => {
  const bildir = (orders: ScanOrder[], products: ScanProduct[]) =>
    matchScanOrders(orders, products).map((o) => buildNewOrderNotification(o));

  it("stoğu biten ürüne gelen aktif sipariş ACİL bildirim olur", () => {
    const rows = bildir(
      [siparis({ id: "ty-1", lines: [{ name: "Ejderha", quantity: 2, barcodes: ["BRK-1"], externalIds: [], skus: [] }] })],
      [urun({ id: "p1", name: "Ejderha", stock: 0, barcodes: ["BRK-1"] })]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("order-new:trendyol:1001");
    expect(rows[0].severity).toBe("critical");
    expect(rows[0].body).toContain("Trendyol #1001");
    expect(rows[0].body).toContain("×2");
    expect(rows[0].body).toContain("stokta yok");
  });

  it("sipariş üzerine üretilen ürün 'üretilecek' uyarısı olur (stok bakılmaz)", () => {
    const rows = bildir(
      [siparis({ id: "ty-2", lines: [{ name: "Lamba", quantity: 1, barcodes: ["BRK-2"], externalIds: [], skus: [] }] })],
      [urun({ id: "p2", name: "Lamba", stock: 0, madeToOrder: true, barcodes: ["BRK-2"] })]
    );
    expect(rows[0].severity).toBe("warning");
    expect(rows[0].title).toContain("üretilecek");
  });

  /** ESKİDEN bu sipariş için HİÇ bildirim yoktu — kullanıcı "siparişte bildirim gelmiyor" dedi. */
  it("stoğu olan ürüne gelen sipariş de bildirilir, kalan stokla", () => {
    const rows = bildir(
      [siparis({ id: "ty-4", lines: [{ name: "Ejderha", quantity: 1, barcodes: ["BRK-1"], externalIds: [], skus: [] }] })],
      [urun({ id: "p1", name: "Ejderha", stock: 7, barcodes: ["BRK-1"] })]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("success");
    expect(rows[0].body).toContain("stokta 7 adet");
  });

  it("aksiyon beklemeyen (kapanmış) sipariş aday bile olmaz", () => {
    const rows = bildir(
      [siparis({ id: "ty-3", actionable: false, lines: [{ name: "Ejderha", quantity: 1, barcodes: ["BRK-1"], externalIds: [], skus: [] }] })],
      [urun({ id: "p1", name: "Ejderha", stock: 0, barcodes: ["BRK-1"] })]
    );
    expect(rows).toEqual([]);
  });

  it("aynı barkod iki ürüne düşerse eşleştirmez (yanlış ürünün stoğunu söylemez)", () => {
    const [o] = matchScanOrders(
      [siparis({ id: "ty-5", lines: [{ name: "Ejderha", quantity: 1, barcodes: ["ORTAK"], externalIds: [], skus: [] }] })],
      [urun({ id: "p1", name: "Ejderha", stock: 0, barcodes: ["ORTAK"] }), urun({ id: "p2", name: "Kartal", stock: 0, barcodes: ["ORTAK"] })]
    );
    expect(o.lines[0].product).toBeNull();
    expect(buildNewOrderNotification(o).body).toContain("ürün eşleşmedi");
  });

  it("boşluk ve harf düzeni farkına takılmaz", () => {
    const [o] = matchScanOrders(
      [siparis({ id: "ty-6", lines: [{ name: "x", quantity: 1, barcodes: [" brk-9 "], externalIds: [], skus: [] }] })],
      [urun({ id: "p9", name: "Işık", stock: 0, barcodes: ["BRK-9"] })]
    );
    expect(o.lines[0].product?.id).toBe("p9");
  });

  it("Shopify satırını son çare olarak ürün adından eşleştirir; numarada çift diyez yok", () => {
    const rows = bildir(
      [siparis({ platform: "shopify", id: "sh-1", orderNumber: "#2001", lines: [{ name: "Gece Lambası", quantity: 1, barcodes: [], externalIds: [], skus: [] }] })],
      [urun({ id: "p3", name: "Gece Lambası", stock: 0 })]
    );
    expect(rows[0].body).toContain("Shopify #2001");
    expect(rows[0].body).not.toContain("##");
    expect(rows[0].id).toBe("order-new:shopify:2001");
  });

  it("aynı ürün siparişte iki satırda geçse de tek satırda toplanır", () => {
    const rows = bildir(
      [
        siparis({
          id: "ty-7",
          lines: [
            { name: "Ejderha", quantity: 1, barcodes: ["BRK-1"], externalIds: [], skus: [] },
            { name: "Ejderha", quantity: 1, barcodes: ["BRK-1"], externalIds: [], skus: [] },
          ],
        }),
      ],
      [urun({ id: "p1", name: "Ejderha", stock: 5, barcodes: ["BRK-1"] })]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain("Ejderha ×2");
  });
});

describe("buildInventoryNotifications", () => {
  const envanter = {
    lowStock: [
      { id: "p1", name: "Ejderha", stock: 0 },
      { id: "p2", name: "Kartal", stock: 1 },
    ],
    siteOutOfStock: [{ productId: "p3", name: "Lamba" }],
    // Filament uyarıları ZİLLE AYNI çekirdekten (buildFilamentAlerts) hazır gelir — burada
    // eşik yeniden hesaplanmaz. Kimlik düzeni `filament-<grup>`; eski `spool-<makara>` DEĞİL.
    filament: [
      {
        id: "filament-pla__siyah",
        severity: "critical" as const,
        title: "Filament bitti",
        body: "Siyah PLA — hiç makara kalmadı",
        href: "/spools?g=pla__siyah",
      },
      {
        id: "filament-pla__beyaz",
        severity: "warning" as const,
        title: "Filament azaldı",
        body: "Beyaz PLA — 1 kapalı makara kaldı",
        href: "/spools?g=pla__beyaz",
      },
    ],
    readTypes: INVENTORY_TYPES,
  };

  it("biten stok ve biten filamenti acil, azalanları uyarı olarak işaretler", () => {
    const rows = buildInventoryNotifications(envanter);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId["stock-p1"].severity).toBe("critical");
    expect(byId["stock-p2"].severity).toBe("warning");
    expect(byId["site-stock-p3"].severity).toBe("warning");
    expect(byId["filament-pla__siyah"].severity).toBe("critical");
    expect(byId["filament-pla__beyaz"].severity).toBe("warning");
    // Terk edilmiş gram modelinin kimlikleri ARTIK ÜRETİLMEZ.
    expect(rows.some((r) => r.id.startsWith("spool-"))).toBe(false);
  });

  it("kimlikler zildeki anlık uyarı kimlikleriyle aynı kalıbı kullanır", () => {
    expect(inventoryNotificationIds(envanter)).toEqual([
      "stock-p1",
      "stock-p2",
      "site-stock-p3",
      "filament-pla__siyah",
      "filament-pla__beyaz",
    ]);
  });

  /** Kimlik düzeni değiştiği için sahadaki eski `spool-…` satırları ancak bu tip temizlik
   *  listesinde kalırsa silinebilir; çıkarılsaydı zilde çelişkili bir uyarı asılı kalırdı. */
  it("eski gram modelinin tipi temizlik listesinde kalır", () => {
    expect(INVENTORY_TYPES).toContain("spool");
    expect(INVENTORY_TYPES).toContain("filament");
  });

  it("eşik altında hiçbir şey yoksa bildirim üretmez", () => {
    expect(
      buildInventoryNotifications({
        lowStock: [],
        siteOutOfStock: [],
        filament: [],
        readTypes: INVENTORY_TYPES,
      })
    ).toEqual([]);
  });
});

/**
 * 19 Kas 2026 — tarama her 90 sn'de, aksiyon bekleyen tek sipariş bile varsa ürün eşleştirme
 * sorgusunu (4.600 satır) atıyordu; siparişlerin neredeyse hepsi çoktan bildirilmişti.
 * Buradaki testler iki yönü de kilitler: bildirilmiş siparişte sorgu ATILMAZ, yeni siparişte
 * bildirim KAÇMAZ.
 */
describe("yeni sipariş yokken ürün sorgusu atılmaz", () => {
  const SIMDI = Date.parse("2026-11-19T12:00:00Z");
  const siparis = (no: string, over: Partial<ScanOrder> = {}): ScanOrder => ({
    platform: "trendyol",
    id: no,
    orderNumber: no,
    orderedAtMs: SIMDI - 3_600_000,
    actionable: true,
    lines: [{ name: "Vazo", quantity: 1, barcodes: ["869"], externalIds: [], skus: [] }],
    ...over,
  });

  it("hepsi veritabanında kayıtlıysa yeni yok; ikinci turda veritabanına HİÇ sorulmaz", async () => {
    const { bildirilmemisSiparisVarMi, bilinenSiparisleriSifirla } = await import("./order-watch");
    bilinenSiparisleriSifirla();
    const sor = vi.fn(async (idler: string[]) => idler); // hepsi zaten yazılmış
    const orders = [siparis("100"), siparis("101")];
    expect(await bildirilmemisSiparisVarMi(orders, SIMDI, sor)).toBe(false);
    expect(sor).toHaveBeenCalledTimes(1);
    expect(await bildirilmemisSiparisVarMi(orders, SIMDI + 90_000, sor)).toBe(false);
    expect(await bildirilmemisSiparisVarMi(orders, SIMDI + 180_000, sor)).toBe(false);
    expect(sor, "bilinen siparişler için tekrar sorgu yok").toHaveBeenCalledTimes(1);
  });

  it("yeni sipariş gelince fark edilir; bildirim yazıldıktan sonra yine sessizleşir", async () => {
    const { bildirilmemisSiparisVarMi, bilinenSiparisleriSifirla } = await import("./order-watch");
    bilinenSiparisleriSifirla();
    const yazilmis = new Set(["order-new:trendyol:100"]);
    const sor = vi.fn(async (idler: string[]) => idler.filter((id) => yazilmis.has(id)));
    expect(await bildirilmemisSiparisVarMi([siparis("100")], SIMDI, sor)).toBe(false);

    const yeniyle = [siparis("100"), siparis("200")];
    expect(await bildirilmemisSiparisVarMi(yeniyle, SIMDI, sor)).toBe(true);
    expect(sor).toHaveBeenLastCalledWith(["order-new:trendyol:200"]); // yalnız bilinmeyen sorulur
    // Bildirim henüz yazılmadıysa (ör. yazma düştü) bir sonraki tur YENİDEN dener.
    expect(await bildirilmemisSiparisVarMi(yeniyle, SIMDI, sor)).toBe(true);
    yazilmis.add("order-new:trendyol:200"); // notifyNewOrders yazdı
    expect(await bildirilmemisSiparisVarMi(yeniyle, SIMDI, sor)).toBe(false);
    const cagri = sor.mock.calls.length;
    expect(await bildirilmemisSiparisVarMi(yeniyle, SIMDI, sor)).toBe(false);
    expect(sor.mock.calls.length).toBe(cagri);
  });

  it("aday olmayan siparişler (kapanmış, eski, numarasız, kalemsiz) için sorgu atılmaz", async () => {
    const { bildirilmemisSiparisVarMi, bilinenSiparisleriSifirla } = await import("./order-watch");
    bilinenSiparisleriSifirla();
    const sor = vi.fn(async () => [] as string[]);
    const orders = [
      siparis("1", { actionable: false }),
      siparis("2", { orderedAtMs: SIMDI - 3 * 86_400_000 }),
      siparis("—"),
      siparis("4", { lines: [] }),
    ];
    expect(await bildirilmemisSiparisVarMi(orders, SIMDI, sor)).toBe(false);
    expect(sor).not.toHaveBeenCalled();
  });

  it("aday süzgeci bildirimi yazan fonksiyonunkiyle AYNI", async () => {
    const { bildirimAdayiMi, yeniSiparisAdayKimlikleri, newOrderNotificationId } = await import("./order-notify");
    const hepsi = [
      siparis("10"),
      siparis("#11", { platform: "shopify" }),
      siparis("12", { actionable: false }),
      siparis("13", { orderedAtMs: null }), // tarihi bilinmeyen aday SAYILIR
      siparis("14", { orderedAtMs: SIMDI - 2 * 86_400_000 - 1 }),
      siparis("10"), // çift
    ];
    const beklenen = [...new Set(hepsi.filter((o) => bildirimAdayiMi(o, SIMDI)).map((o) => newOrderNotificationId(o)))];
    expect(yeniSiparisAdayKimlikleri(hepsi, SIMDI)).toEqual(beklenen);
    expect(beklenen).toEqual(["order-new:trendyol:10", "order-new:shopify:11", "order-new:trendyol:13"]);
  });
});

describe("envanter bildirimleri yalnız değişince eşitlenir", () => {
  it("içerik aynıyken beklenir, değişince ya da 10 dakikada bir eşitlenir", async () => {
    const { envanterEsitlenmeliMi } = await import("./order-watch");
    const T = 1_800_000_000_000;
    expect(envanterEsitlenmeliMi({ iz: "", at: 0 }, "a", T), "ilk tur").toBe(true);
    expect(envanterEsitlenmeliMi({ iz: "a", at: T }, "a", T + 90_000)).toBe(false);
    expect(envanterEsitlenmeliMi({ iz: "a", at: T }, "b", T + 90_000), "stok eşiği geçildi").toBe(true);
    expect(envanterEsitlenmeliMi({ iz: "a", at: T }, "a", T + 10 * 60_000), "başka cihazın değişikliği için").toBe(true);
  });
});
