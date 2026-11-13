import { describe, expect, it } from "vitest";
import {
  bekleyenEtiket,
  etiketAnahtari,
  etiketBasilabilir,
  etiketIstegi,
  type EtiketSiparisi,
} from "./etiket-uygunluk";

const s = (o: Partial<EtiketSiparisi>): EtiketSiparisi => ({
  platform: "trendyol",
  id: "1",
  orderNumber: "11823247503",
  trackingNumber: "7330039048986936",
  statusKind: "pending",
  ...o,
});

describe("etiket uygunluğu", () => {
  it("takip numaralı yeni Trendyol siparişi uygun ve bekleyen", () => {
    expect(etiketBasilabilir(s({}))).toBe(true);
    expect(bekleyenEtiket(s({}))).toBe(true);
  });

  it("kargodaki sipariş yeniden basılabilir ama 'bekleyen' sayılmaz", () => {
    expect(etiketBasilabilir(s({ statusKind: "shipped" }))).toBe(true);
    expect(bekleyenEtiket(s({ statusKind: "shipped" }))).toBe(false);
  });

  it("iptal, teslim, takipsiz ve diğer platformlar uygun değil", () => {
    expect(etiketBasilabilir(s({ statusKind: "cancelled" }))).toBe(false);
    expect(etiketBasilabilir(s({ statusKind: "delivered" }))).toBe(false);
    expect(etiketBasilabilir(s({ trackingNumber: null }))).toBe(false);
    expect(etiketBasilabilir(s({ trackingNumber: "  " }))).toBe(false);
    expect(etiketBasilabilir(s({ platform: "shopify" }))).toBe(false);
  });

  it("Hepsiburada: yalnız PAKETLENMİŞ sipariş (paket no) uygun; anahtar teslimat no", () => {
    const hb = s({ platform: "hepsiburada", statusKind: "processing", trackingNumber: "62755431389885", packageNumber: "5543138988" });
    expect(etiketBasilabilir(hb)).toBe(true);
    expect(bekleyenEtiket(hb)).toBe(true);
    expect(etiketAnahtari(hb)).toBe("62755431389885");
    expect(etiketIstegi(hb)).toEqual({
      url: "/api/hepsiburada/etiket",
      govde: { paketNo: "5543138988", takipNo: "62755431389885" },
    });
    // Paketlenmemiş (paket no yok) → etiket yok.
    expect(etiketBasilabilir(s({ platform: "hepsiburada", packageNumber: null, trackingNumber: null }))).toBe(false);
  });

  it("Trendyol isteği takip numarasıyla gider", () => {
    expect(etiketIstegi(s({}))).toEqual({ url: "/api/trendyol/etiket", govde: { takipNo: "7330039048986936" } });
  });
});
