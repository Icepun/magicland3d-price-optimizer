import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPrepItems,
  clearPrepDone,
  loadPrepDone,
  savePrepDone,
  type PrepSourceOrder,
} from "./hazirlik";

/**
 * "Bugün gönderilecekler" listesi. Kullanıcı bu listeye bakarak rafa gidiyor:
 * bir adet eksik ya da fazla görünmesi doğrudan yanlış paket demek.
 */

const siparis = (
  orderNumber: string,
  statusKind: PrepSourceOrder["statusKind"],
  items: PrepSourceOrder["items"]
): PrepSourceOrder => ({ orderNumber, statusKind, items });

const kalem = (
  name: string,
  quantity: number,
  extra: Partial<PrepSourceOrder["items"][number]> = {}
) => ({ name, quantity, image: null, ...extra });

describe("hazırlık listesi toplaması", () => {
  it("yalnız gönderilmeyi bekleyen siparişleri sayar", () => {
    const liste = buildPrepItems([
      siparis("A1", "pending", [kalem("Kalemlik", 1)]),
      siparis("A2", "processing", [kalem("Kalemlik", 2)]),
      siparis("A3", "shipped", [kalem("Kalemlik", 5)]),
      siparis("A4", "delivered", [kalem("Kalemlik", 5)]),
      siparis("A5", "cancelled", [kalem("Kalemlik", 5)]),
      siparis("A6", "other", [kalem("Kalemlik", 5)]),
    ]);
    expect(liste).toHaveLength(1);
    expect(liste[0].quantity).toBe(3);
    expect(liste[0].orderNumbers).toEqual(["A1", "A2"]);
  });

  it("aynı ürün farklı siparişlerde geçse tek satırda toplanır", () => {
    const liste = buildPrepItems([
      siparis("A1", "pending", [kalem("Vazo", 2, { productId: "p1" })]),
      siparis("A2", "pending", [kalem("Vazo (eski ad)", 3, { productId: "p1" })]),
    ]);
    expect(liste).toHaveLength(1);
    expect(liste[0].quantity).toBe(5);
    expect(liste[0].orderNumbers).toEqual(["A1", "A2"]);
  });

  it("ürün eşleşmemişse ada göre birleştirir", () => {
    const liste = buildPrepItems([
      siparis("A1", "pending", [kalem("Anahtarlık", 1)]),
      siparis("A2", "pending", [kalem("anahtarlık", 2)]),
    ]);
    expect(liste).toHaveLength(1);
    expect(liste[0].quantity).toBe(3);
  });

  it("farklı ürünleri karıştırmaz ve çok adetliyi üste alır", () => {
    const liste = buildPrepItems([
      siparis("A1", "pending", [kalem("Kalemlik", 1), kalem("Vazo", 4)]),
    ]);
    expect(liste.map((item) => item.name)).toEqual(["Vazo", "Kalemlik"]);
  });

  it("bozuk adet gelirse kalem yine listede 1 adet görünür", () => {
    const liste = buildPrepItems([
      siparis("A1", "pending", [kalem("Kalemlik", Number.NaN)]),
      siparis("A2", "pending", [kalem("Kalemlik", 0)]),
    ]);
    expect(liste[0].quantity).toBe(2);
  });

  it("adı boş kalemi düşürmez", () => {
    const liste = buildPrepItems([siparis("A1", "pending", [kalem("   ", 1)])]);
    expect(liste).toHaveLength(1);
    expect(liste[0].name).toBe("Adı olmayan ürün");
  });

  it("görsel ve uyarı işaretleri birleşen satıra taşınır", () => {
    const liste = buildPrepItems([
      siparis("A1", "pending", [kalem("Vazo", 1, { productId: "p1" })]),
      siparis("A2", "pending", [
        {
          name: "Vazo",
          quantity: 1,
          image: "https://ornek/vazo.png",
          productId: "p1",
          madeToOrder: true,
          costMissing: true,
        },
      ]),
    ]);
    expect(liste[0].image).toBe("https://ornek/vazo.png");
    expect(liste[0].madeToOrder).toBe(true);
    expect(liste[0].costMissing).toBe(true);
  });

  it("aynı sipariş numarasını iki kez yazmaz", () => {
    const liste = buildPrepItems([
      siparis("A1", "pending", [kalem("Vazo", 1, { productId: "p1" }), kalem("Vazo", 2, { productId: "p1" })]),
    ]);
    expect(liste[0].orderNumbers).toEqual(["A1"]);
    expect(liste[0].quantity).toBe(3);
  });

  it("hazırlanacak sipariş yoksa boş liste döner", () => {
    expect(buildPrepItems([])).toEqual([]);
    expect(buildPrepItems([siparis("A1", "shipped", [kalem("Vazo", 1)])])).toEqual([]);
  });
});

describe("işaretlerin cihazlar arası paylaşılması", () => {
  /**
   * İşaretler artık veritabanında (`/api/prep-done`): masaüstünde başlanan paketleme
   * telefonda bitirilebiliyor. Buradaki testler ağ hatasının paketlemeyi DURDURMADIĞINI
   * garanti eder — hata durumunda liste işaretsiz ama çalışır halde açılmalı.
   */
  let cagrilar: { url: string; init?: RequestInit }[] = [];

  const fetchYanit = (yanit: unknown, ok = true) => {
    cagrilar = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      cagrilar.push({ url, init });
      return Promise.resolve({ ok, json: () => Promise.resolve(yanit) } as Response);
    });
  };

  beforeEach(() => {
    cagrilar = [];
  });

  it("sunucudaki işaretleri okur", async () => {
    fetchYanit({ keys: ["id:p1", "ad:vazo"] });
    await expect(loadPrepDone()).resolves.toEqual(["id:p1", "ad:vazo"]);
  });

  it("beklenmeyen içerik süzülür", async () => {
    fetchYanit({ keys: ["id:p1", 42, null] });
    await expect(loadPrepDone()).resolves.toEqual(["id:p1"]);
  });

  it("sunucu hata dönerse liste işaretsiz açılır", async () => {
    fetchYanit({ error: "patladı" }, false);
    await expect(loadPrepDone()).resolves.toEqual([]);
  });

  it("ağ yoksa sayfa kırılmaz", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ağ yok")));
    await expect(loadPrepDone()).resolves.toEqual([]);
    await expect(savePrepDone("id:p1", true)).resolves.toBeUndefined();
    await expect(clearPrepDone()).resolves.toBeUndefined();
  });

  it("işaret ve işaret kaldırma aynı uca yazılır", async () => {
    fetchYanit({ ok: true });
    await savePrepDone("id:p1", true);
    await savePrepDone("id:p1", false);
    expect(cagrilar).toHaveLength(2);
    expect(cagrilar[0].url).toBe("/api/prep-done");
    expect(JSON.parse(String(cagrilar[0].init?.body))).toEqual({ key: "id:p1", done: true });
    expect(JSON.parse(String(cagrilar[1].init?.body))).toEqual({ key: "id:p1", done: false });
  });

  it("sıfırlama tek istekle yapılır", async () => {
    fetchYanit({ ok: true });
    await clearPrepDone();
    expect(cagrilar).toHaveLength(1);
    expect(cagrilar[0].init?.method).toBe("DELETE");
  });
});
