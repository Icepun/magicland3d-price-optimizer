/**
 * Telefonun Siparişler sekmesinin kuralları — masaüstüyle AYNI sonuçlar.
 *   • Durum kovası ve süzgeç grubu ("Açık" = yeni + hazırlanıyor).
 *   • Türkiye takvimi: gün sınırı UTC+3; gün başlıkları masaüstünün Intl/Europe/Istanbul
 *     hesabıyla birebir.
 *   • Özet: iptal/eksik/tanınmayan ciroya girmez; marj yalnız maliyeti tam bilinenlerden;
 *     bilinmeyen kâr sıfır sayılmaz.
 */
import { describe, expect, it } from "vitest";

import {
  donemBaslangici, durumGrubu, durumKovasi, gunBasi, gunEtiketi, gunlereBol, siparisOzeti,
  type OzetGirdisi,
} from "./siparis-listesi";
import { gunlereBol as masaustuGunlereBol } from "@/app/orders/gun-basliklari";

const TR = (iso: string) => Date.parse(`${iso}+03:00`);

describe("durum", () => {
  it("platform durumları ortak kovaya ve süzgeç grubuna iner", () => {
    expect(durumGrubu(durumKovasi("trendyol", "Created"))).toBe("acik");
    expect(durumGrubu(durumKovasi("trendyol", "Picking"))).toBe("acik");
    expect(durumGrubu(durumKovasi("trendyol", "UnPacked"))).toBe("acik"); // bölünen paket iptal DEĞİL
    expect(durumGrubu(durumKovasi("trendyol", "Shipped"))).toBe("kargoda");
    expect(durumGrubu(durumKovasi("hepsiburada", "InTransit"))).toBe("kargoda");
    expect(durumGrubu(durumKovasi("hepsiburada", "Delivered"))).toBe("teslim");
    expect(durumGrubu(durumKovasi("shopify", "UNFULFILLED"))).toBe("acik");
    expect(durumGrubu(durumKovasi("shopify", "REFUNDED"))).toBe("iptal");
    expect(durumGrubu(durumKovasi("manual", "processing"))).toBe("acik");
    expect(durumGrubu(durumKovasi("trendyol", "BilinmeyenDurum"))).toBe("diger");
  });
});

describe("Türkiye takvimi", () => {
  it("gece yarısını Türkiye saatine göre keser", () => {
    expect(gunBasi(TR("2026-11-09T00:30:00"))).toBe(TR("2026-11-09T00:00:00"));
    expect(gunBasi(TR("2026-11-08T23:59:00"))).toBe(TR("2026-11-08T00:00:00"));
  });

  it("Bugün / Dün / tarih + gün adı", () => {
    const simdi = TR("2026-11-09T10:00:00"); // Pazartesi
    expect(gunEtiketi(TR("2026-11-09T00:05:00"), simdi)).toBe("Bugün");
    expect(gunEtiketi(TR("2026-11-08T23:55:00"), simdi)).toBe("Dün");
    expect(gunEtiketi(TR("2026-11-07T12:00:00"), simdi)).toBe("7 Kasım Cumartesi");
    expect(gunEtiketi(TR("2026-10-29T01:00:00"), simdi)).toBe("29 Ekim Perşembe");
  });

  it("gün başlıkları masaüstüyle birebir aynı", () => {
    const simdi = TR("2026-11-09T10:00:00");
    const tarihler = [
      "2026-11-09T09:00:00", "2026-11-09T00:01:00", "2026-11-08T23:59:00", "2026-11-08T03:00:00",
      "2026-11-02T21:30:00", "2026-10-15T00:00:30", "2026-10-01T23:00:00",
    ].map(TR);
    const telefon = gunlereBol(tarihler.map((d) => ({ date: d })), simdi)
      .filter((r) => r.tur === "gun").map((r) => (r.tur === "gun" ? `${r.etiket}|${r.adet}` : ""));
    const masaustu = masaustuGunlereBol(tarihler.map((d) => ({ date: new Date(d).toISOString() })), simdi)
      .filter((r) => r.tur === "gun").map((r) => (r.tur === "gun" ? `${r.etiket}|${r.adet}` : ""));
    expect(telefon).toEqual(masaustu);
  });

  it("tarihsiz siparişler tek başlık altında", () => {
    const r = gunlereBol([{ date: TR("2026-11-09T09:00:00") }, { date: null }, { date: null }], TR("2026-11-09T10:00:00"));
    expect(r.filter((x) => x.tur === "gun").map((x) => (x.tur === "gun" ? [x.etiket, x.adet] : null))).toEqual([
      ["Bugün", 1], ["Tarihi bilinmeyen", 2],
    ]);
  });

  it("dönem başlangıcı: bugün, son 7 gün (bugün dahil), 30 gün = verilen kesim", () => {
    const simdi = TR("2026-11-09T10:00:00");
    expect(donemBaslangici("bugun", simdi, 0)).toBe(TR("2026-11-09T00:00:00"));
    expect(donemBaslangici("hafta", simdi, 0)).toBe(TR("2026-11-03T00:00:00"));
    expect(donemBaslangici("ay", simdi, 12345)).toBe(12345);
  });
});

describe("özet", () => {
  const g = (o: Partial<OzetGirdisi>): OzetGirdisi => ({
    platform: "trendyol", date: 1000, ciro: 100, kar: 20, karKismi: false, haric: false, ...o,
  });

  it("hariç tutulan, dönem öncesi ve tarihsiz sipariş toplamlara girmez", () => {
    const o = siparisOzeti([
      g({}),
      g({ haric: true, ciro: 999 }),
      g({ date: 10, ciro: 999 }),
      g({ date: null, ciro: 999 }),
    ], 500);
    expect(o).toMatchObject({ adet: 1, ciro: 100, kar: 20 });
  });

  it("bilinmeyen kâr sıfır sayılmaz: marj yalnız maliyeti tam bilinenlerden, eksikler sayılır", () => {
    const o = siparisOzeti([
      g({ ciro: 100, kar: 25 }),
      g({ ciro: 300, kar: null }),
      g({ ciro: 100, kar: 10, karKismi: true }),
    ], 0);
    expect(o.adet).toBe(3);
    expect(o.ciro).toBe(500);
    expect(o.kar).toBe(35); // bilinen kârlar (yaklaşık dahil)
    expect(o.marj).toBeCloseTo(0.25); // yalnız tam bilinen: 25 / 100
    expect(o.maliyetEksik).toBe(2);
  });

  it("hiç maliyeti bilinen sipariş yoksa marj hesaplanmaz", () => {
    expect(siparisOzeti([g({ kar: null })], 0).marj).toBeNull();
    expect(siparisOzeti([], 0)).toMatchObject({ adet: 0, ciro: 0, marj: null, platformlar: [] });
  });

  it("platform dağılımı ciroya göre büyükten küçüğe", () => {
    const o = siparisOzeti([
      g({ platform: "shopify", ciro: 50 }),
      g({ platform: "trendyol", ciro: 300 }),
      g({ platform: "trendyol", ciro: 100 }),
      g({ platform: "hepsiburada", ciro: 120 }),
    ], 0);
    expect(o.platformlar).toEqual([
      { platform: "trendyol", adet: 2, ciro: 400 },
      { platform: "hepsiburada", adet: 1, ciro: 120 },
      { platform: "shopify", adet: 1, ciro: 50 },
    ]);
  });
});
