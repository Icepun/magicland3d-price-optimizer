import { describe, expect, it } from "vitest";
import { SHOPIFY_STATUS_KINDS, hbSonDurum, shopifyTeslimEdildi } from "./order-status-kind";

describe("Shopify teslim bilgisi (gönderim kaydından)", () => {
  it("panelde 'teslim edildi' işaretli gönderim → teslim", () => {
    expect(shopifyTeslimEdildi([{ status: "SUCCESS", displayStatus: "DELIVERED", deliveredAt: "2026-09-20T10:00:00Z" }])).toBe(true);
  });

  it("teslim tarihi tek başına yeter; mağazadan teslim de teslimdir", () => {
    expect(shopifyTeslimEdildi([{ status: "SUCCESS", displayStatus: null, deliveredAt: "2026-09-20T10:00:00Z" }])).toBe(true);
    expect(shopifyTeslimEdildi([{ status: "SUCCESS", displayStatus: "PICKED_UP" }])).toBe(true);
  });

  it("yoldaki / yalnız gönderilmiş sipariş teslim DEĞİL", () => {
    expect(shopifyTeslimEdildi([{ status: "SUCCESS", displayStatus: "IN_TRANSIT" }])).toBe(false);
    expect(shopifyTeslimEdildi([{ status: "SUCCESS", displayStatus: "FULFILLED" }])).toBe(false);
  });

  it("birden çok gönderimde HEPSİ teslim edilmiş olmalı; iptal edilen gönderim sayılmaz", () => {
    expect(
      shopifyTeslimEdildi([
        { status: "SUCCESS", displayStatus: "DELIVERED" },
        { status: "SUCCESS", displayStatus: "IN_TRANSIT" },
      ])
    ).toBe(false);
    expect(
      shopifyTeslimEdildi([
        { status: "CANCELLED", displayStatus: "CANCELED" },
        { status: "SUCCESS", displayStatus: "DELIVERED" },
      ])
    ).toBe(true);
  });

  it("gönderim yoksa ya da hepsi iptalse teslim değil", () => {
    expect(shopifyTeslimEdildi([])).toBe(false);
    expect(shopifyTeslimEdildi(null)).toBe(false);
    expect(shopifyTeslimEdildi([{ status: "CANCELLED", displayStatus: "DELIVERED" }])).toBe(false);
  });

  it("türetilen DELIVERED adı 'teslim' kovasına düşer", () => {
    expect(SHOPIFY_STATUS_KINDS.DELIVERED).toBe("delivered");
    expect(SHOPIFY_STATUS_KINDS.FULFILLED).toBe("shipped");
  });
});

describe("Hepsiburada: aynı sipariş birden çok listede", () => {
  it("ilerideki durum kazanır — teslim, kargoyu ezer", () => {
    expect(hbSonDurum("Shipped", "Delivered")).toBe("Delivered");
    expect(hbSonDurum("Packaged", "Shipped")).toBe("Shipped");
    expect(hbSonDurum("Open", "Delivered")).toBe("Delivered");
  });

  it("geri gidilmez", () => {
    expect(hbSonDurum("Delivered", "Shipped")).toBe("Delivered");
  });

  it("liste dışı durumlara (teslim edilemedi, iptal) dokunulmaz", () => {
    expect(hbSonDurum("Shipped", "UnDelivered")).toBe("Shipped");
    expect(hbSonDurum("Cancelled", "Delivered")).toBe("Cancelled");
  });
});
