import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PREP_DONE_KEY,
  buildPrepItems,
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

describe("işaretlerin oturum boyunca saklanması", () => {
  beforeEach(() => {
    const kayit = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => kayit.get(key) ?? null,
      setItem: (key: string, value: string) => void kayit.set(key, value),
      removeItem: (key: string) => void kayit.delete(key),
    });
  });

  it("işaretlenenler yazılıp geri okunur", () => {
    savePrepDone(["id:p1", "ad:vazo"]);
    expect(loadPrepDone()).toEqual(["id:p1", "ad:vazo"]);
  });

  it("hiç kayıt yoksa boş liste döner", () => {
    expect(loadPrepDone()).toEqual([]);
  });

  it("bozuk kayıt sayfayı kırmaz", () => {
    sessionStorage.setItem(PREP_DONE_KEY, "{bozuk");
    expect(loadPrepDone()).toEqual([]);
  });

  it("beklenmeyen içerik süzülür", () => {
    sessionStorage.setItem(PREP_DONE_KEY, JSON.stringify(["id:p1", 42, null]));
    expect(loadPrepDone()).toEqual(["id:p1"]);
  });
});
