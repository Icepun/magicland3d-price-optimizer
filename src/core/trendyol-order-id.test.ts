import { describe, expect, it } from "vitest";
import { isPersistableOrderId, trendyolOrderId, trendyolPackageId } from "./trendyol-order-id";

/**
 * SAHADA YAŞANDI (23 Eyl 2026): Trendyol yeni siparişi ilk saniyelerde `id: 0` ile verdi.
 * Eski kimlik `ty-${o.id ?? …}` 0'ı gerçek sayıp "ty-0" üretti; gerçek id gelince sipariş
 * finans geçmişine İKİNCİ kez yazıldı ve Raporlar'da iki kez sayıldı.
 */
describe("Trendyol sipariş kimliği", () => {
  it("paket id'si 0 iken gerçek kimlik sayılmaz", () => {
    expect(trendyolPackageId(0)).toBeNull();
    expect(trendyolPackageId("0")).toBeNull();
    expect(trendyolPackageId(null)).toBeNull();
    expect(trendyolPackageId("")).toBeNull();
    expect(trendyolPackageId(4124054982)).toBe("4124054982");
  });

  it("id 0 olan iki sipariş AYNI anahtara düşmez", () => {
    const a = trendyolOrderId({ id: 0, orderNumber: 11563168410 }, 0);
    const b = trendyolOrderId({ id: 0, orderNumber: 11563168999 }, 1);
    expect(a).not.toBe(b);
    expect(a).not.toBe("ty-0");
  });

  it("gerçek paket id'si gelince kimlik paket id'si olur", () => {
    expect(trendyolOrderId({ id: 4124054982, orderNumber: 11563168410 }, 0)).toBe("ty-4124054982");
  });

  it("geçici kimlik kalıcı kayda YAZILMAZ, gerçek kimlik yazılır", () => {
    const gecici = trendyolOrderId({ id: 0, orderNumber: 11563168410 }, 0);
    expect(isPersistableOrderId("trendyol", gecici)).toBe(false);
    expect(isPersistableOrderId("trendyol", "ty-0")).toBe(false);
    expect(isPersistableOrderId("trendyol", "ty-4124054982")).toBe(true);
    // Diğer platformların kimliği zaten sabit.
    expect(isPersistableOrderId("hepsiburada", "hb-4473568688")).toBe(true);
    expect(isPersistableOrderId("shopify", "sh-7181352632575")).toBe(true);
  });

  it("numarası da olmayan satır yedek anahtarla yine tekil kalır", () => {
    expect(trendyolOrderId({}, 3)).not.toBe(trendyolOrderId({}, 4));
  });
});
