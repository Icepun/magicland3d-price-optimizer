import { describe, expect, it } from "vitest";

import { urunSatisOzeti } from "./urun-satis";

const GUN = 86_400_000;
// 9 Ekim 2026 18:00 İstanbul.
const SIMDI = Date.parse("2026-10-09T15:00:00.000Z");
const s = (gunOnce: number, adet = 1, platform = "trendyol") => ({ platform, orderedAt: SIMDI - gunOnce * GUN, quantity: adet });

describe("ürün satış geçmişi", () => {
  it("son 6 ay platform başına adet, eskiden yeniye", () => {
    const o = urunSatisOzeti([s(2), s(3, 2, "shopify"), s(40)], SIMDI - 200 * GUN, SIMDI, 5);
    expect(o.aylar.map((a) => a.ay)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(o.aylar[5]).toMatchObject({ etiket: "Eki", toplam: 3, adet: { trendyol: 1, shopify: 2 } });
    expect(o.aylar[3].toplam).toBe(1); // 40 gün önce → 30 Ağustos
  });

  it("hız ve stok günü 90 günlük pencereden", () => {
    // 90 günde 9 adet → 10 günde bir; stok 5 → 50 gün yeter.
    const satirlar = Array.from({ length: 9 }, (_, i) => s(i * 10 + 1));
    const o = urunSatisOzeti(satirlar, SIMDI - 300 * GUN, SIMDI, 5);
    expect(o.son90Adet).toBe(9);
    expect(o.kacGundeBir).toBeCloseTo(10, 5);
    expect(o.stokGunu).toBeCloseTo(50, 5);
  });

  it("geçmiş kısaysa hız UYDURULMAZ", () => {
    const o = urunSatisOzeti([s(1), s(2)], SIMDI - 10 * GUN, SIMDI, 5);
    expect(o.hazir).toBe(false);
    expect(o.kacGundeBir).toBeNull();
    expect(o.stokGunu).toBeNull();
  });

  it("geçmiş 90 günden kısaysa ölçülen gün kadar bölünür", () => {
    // 45 günlük geçmişte 9 adet → 5 günde bir.
    const o = urunSatisOzeti(Array.from({ length: 9 }, (_, i) => s(i * 5 + 1)), SIMDI - 45 * GUN, SIMDI, 10);
    expect(o.olculenGun).toBe(45);
    expect(o.kacGundeBir).toBeCloseTo(5, 5);
    expect(o.stokGunu).toBeCloseTo(50, 5);
  });

  it("satış yoksa ya da stok tutulmuyorsa stok günü yok", () => {
    expect(urunSatisOzeti([], SIMDI - 300 * GUN, SIMDI, 5).stokGunu).toBeNull();
    expect(urunSatisOzeti([s(1)], SIMDI - 300 * GUN, SIMDI, null).stokGunu).toBeNull();
  });
});
