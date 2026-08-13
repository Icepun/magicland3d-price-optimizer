/**
 * Gider Ödemeleri görünüm mantığı — dönem bölme, kategori dağılımı, ay gruplama.
 *
 * BURADA PARA HESABI DEĞİL, PARA SAYIMI var: hiçbir oran/vergi/kâr türetilmez. Kilitlenen
 * davranışlar: dönemler Türkiye takvimine göre bölünür, tarihi okunamayan satır uydurulmaz,
 * önceki dönem boşken "arttı" denmez.
 */
import { describe, expect, it } from "vitest";
import {
  KATEGORISIZ,
  araliktakiler,
  aylaraGore,
  donemOzeti,
  kategoriDagilimi,
  periyotAraligi,
  type GiderSatiri,
} from "./expense-view";

/** Türkiye duvar saatiyle verilen anı UTC ms'e çevirir. */
const TR = (iso: string) => Date.parse(`${iso}+03:00`);

const gider = (over: Partial<GiderSatiri> & { amount: number; paidAt: string | null }): GiderSatiri => ({
  id: Math.random().toString(36).slice(2),
  name: "Gider",
  category: null,
  note: null,
  recurringId: null,
  ...over,
});

// Cuma, 14 Ağustos 2026, 12:00 TR
const SIMDI = TR("2026-08-14T12:00:00");

describe("periyot aralıkları — Türkiye takvimi", () => {
  it("hafta PAZARTESİ başlar", () => {
    // 14 Ağu 2026 Cuma → o haftanın pazartesisi 10 Ağustos.
    const a = periyotAraligi("hafta", SIMDI);
    expect(a.basMs).toBe(TR("2026-08-10T00:00:00"));
    expect(a.oncekiBasMs).toBe(TR("2026-08-03T00:00:00"));
  });

  it("pazar günü haftayı İLERİ kaydırmaz", () => {
    // Naif `getUTCDay()` hesabı pazarı 0 sayıp haftayı bir gün kaydırırdı.
    const pazar = TR("2026-08-16T12:00:00");
    expect(periyotAraligi("hafta", pazar).basMs).toBe(TR("2026-08-10T00:00:00"));
  });

  it("ay, ayın 1'inde başlar", () => {
    const a = periyotAraligi("ay", SIMDI);
    expect(a.basMs).toBe(TR("2026-08-01T00:00:00"));
    expect(a.oncekiBasMs).toBe(TR("2026-07-01T00:00:00"));
    expect(a.oncekiSonMs).toBe(a.basMs - 1);
  });

  it("3 ay ve 6 ay, içinde bulunulan ay DAHİL geriye sayar", () => {
    expect(periyotAraligi("3ay", SIMDI).basMs).toBe(TR("2026-06-01T00:00:00"));
    expect(periyotAraligi("6ay", SIMDI).basMs).toBe(TR("2026-03-01T00:00:00"));
  });

  it("yıl, 1 Ocak'ta başlar", () => {
    const a = periyotAraligi("yil", SIMDI);
    expect(a.basMs).toBe(TR("2026-01-01T00:00:00"));
    expect(a.oncekiBasMs).toBe(TR("2025-01-01T00:00:00"));
  });

  it("yıl başında geriye giden aralık bir önceki yıla taşar", () => {
    const ocak = TR("2026-01-10T12:00:00");
    expect(periyotAraligi("3ay", ocak).basMs).toBe(TR("2025-11-01T00:00:00"));
  });

  it("gece yarısından hemen sonra gün kaymaz", () => {
    // UTC'de hâlâ önceki gün; Türkiye takvimine göre yeni gün.
    const geceyarisi = TR("2026-08-01T00:30:00");
    expect(periyotAraligi("ay", geceyarisi).basMs).toBe(TR("2026-08-01T00:00:00"));
  });
});

describe("aralık süzme", () => {
  const giderler = [
    gider({ amount: 100, paidAt: new Date(TR("2026-08-05T10:00:00")).toISOString() }),
    gider({ amount: 200, paidAt: new Date(TR("2026-07-05T10:00:00")).toISOString() }),
    gider({ amount: 300, paidAt: null }),
    gider({ amount: 400, paidAt: "bozuk-tarih" }),
  ];

  it("yalnız aralıktakiler döner", () => {
    const a = periyotAraligi("ay", SIMDI);
    expect(araliktakiler(giderler, a.basMs, a.sonMs).map((g) => g.amount)).toEqual([100]);
  });

  it("tarihi okunamayan satır UYDURULMAZ, dışarıda kalır", () => {
    const hepsi = araliktakiler(giderler, 0, SIMDI);
    expect(hepsi.map((g) => g.amount).sort()).toEqual([100, 200]);
  });
});

describe("kategori dağılımı", () => {
  const renk = (_k: string, i: number) => `renk-${i}`;

  it("büyükten küçüğe sıralar ve yüzde verir", () => {
    const d = kategoriDagilimi(
      [
        gider({ amount: 300, category: "Reklam", paidAt: null }),
        gider({ amount: 100, category: "Muhasebe", paidAt: null }),
        gider({ amount: 100, category: "Muhasebe", paidAt: null }),
      ],
      renk
    );
    expect(d.map((x) => x.kategori)).toEqual(["Reklam", "Muhasebe"]);
    expect(d[0].toplam).toBe(300);
    expect(d[0].yuzde).toBe(60);
    expect(d[1].adet).toBe(2);
  });

  it("kategorisi boş olanlar tek başlıkta toplanır", () => {
    const d = kategoriDagilimi(
      [
        gider({ amount: 50, category: null, paidAt: null }),
        gider({ amount: 50, category: "   ", paidAt: null }),
      ],
      renk
    );
    expect(d).toHaveLength(1);
    expect(d[0].kategori).toBe(KATEGORISIZ);
    expect(d[0].toplam).toBe(100);
  });

  it("boş listede bölme hatası olmaz", () => {
    expect(kategoriDagilimi([], renk)).toEqual([]);
  });

  it("aynı kategori HER ZAMAN aynı rengi alır", () => {
    // Renk sıraya değil kategoriye bağlanabilsin diye `renkOf` kategoriyi de alır.
    const sabitRenk = (k: string) => (k === "Reklam" ? "mor" : "gri");
    const d = kategoriDagilimi([gider({ amount: 1, category: "Reklam", paidAt: null })], sabitRenk);
    expect(d[0].renk).toBe("mor");
  });
});

describe("dönem özeti", () => {
  const aralik = periyotAraligi("ay", SIMDI);
  const iso = (ms: number) => new Date(ms).toISOString();

  it("bu dönem ve önceki dönem ayrı sayılır", () => {
    const o = donemOzeti(
      [
        gider({ amount: 120, paidAt: iso(TR("2026-08-05T10:00:00")) }),
        gider({ amount: 80, paidAt: iso(TR("2026-07-20T10:00:00")) }),
      ],
      aralik
    );
    expect(o.toplam).toBe(120);
    expect(o.adet).toBe(1);
    expect(o.oncekiToplam).toBe(80);
    expect(o.degisimYuzde).toBeCloseTo(50, 5);
  });

  it("önceki dönem BOŞKEN oran uydurulmaz", () => {
    // Sıfırdan artışa yüzde vermek matematiksel olarak tanımsız; "%100 arttı" demek yanlış.
    const o = donemOzeti([gider({ amount: 120, paidAt: iso(TR("2026-08-05T10:00:00")) })], aralik);
    expect(o.oncekiToplam).toBe(0);
    expect(o.degisimYuzde).toBeNull();
  });

  it("düşüş negatif çıkar", () => {
    const o = donemOzeti(
      [
        gider({ amount: 50, paidAt: iso(TR("2026-08-05T10:00:00")) }),
        gider({ amount: 100, paidAt: iso(TR("2026-07-05T10:00:00")) }),
      ],
      aralik
    );
    expect(o.degisimYuzde).toBeCloseTo(-50, 5);
  });
});

describe("ay gruplama", () => {
  it("yeniden eskiye gruplar ve ay toplamını verir", () => {
    const g = aylaraGore([
      gider({ amount: 100, paidAt: new Date(TR("2026-07-05T10:00:00")).toISOString() }),
      gider({ amount: 200, paidAt: new Date(TR("2026-08-05T10:00:00")).toISOString() }),
      gider({ amount: 300, paidAt: new Date(TR("2026-08-20T10:00:00")).toISOString() }),
    ]);
    expect(g.map((x) => x.key)).toEqual(["2026-08", "2026-07"]);
    expect(g[0].label).toBe("Ağustos 2026");
    expect(g[0].toplam).toBe(500);
    expect(g[1].toplam).toBe(100);
  });

  it("ay içinde en yeni ödeme üstte", () => {
    const g = aylaraGore([
      gider({ amount: 1, name: "eski", paidAt: new Date(TR("2026-08-01T10:00:00")).toISOString() }),
      gider({ amount: 2, name: "yeni", paidAt: new Date(TR("2026-08-20T10:00:00")).toISOString() }),
    ]);
    expect(g[0].giderler.map((x) => x.name)).toEqual(["yeni", "eski"]);
  });

  it("tarihsiz kayıt hiçbir aya sokulmaz", () => {
    expect(aylaraGore([gider({ amount: 5, paidAt: null })])).toEqual([]);
  });
});
