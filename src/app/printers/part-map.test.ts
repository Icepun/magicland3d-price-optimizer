/**
 * PARÇA HARİTASI — yanlış parçayı iptal ettirmemek için var.
 *
 * Tabladaki kopyaların adları birbirinin aynı olabiliyor; kullanıcı parçayı ancak YERİNDEN
 * ayırt edebilir. Buradaki her test, yanlış seçime yol açabilecek somut bir hatayı kilitler.
 *
 * Veriler CANLI: Neptune 4 Plus'ın 14 Ağu 2026'da bastığı üç kopya (57 noktalı poligonlar,
 * merkezler 138.606 / 162.5 / 186.394 — hepsi aynı satırda).
 */
import { describe, expect, it } from "vitest";
import {
  cizimSirasi, mmToOran, noktaIcinde, parcalariSirala, poligonAlani, poligonSvg,
  type PartPolygon,
} from "./part-map";

/** Dikdörtgen poligon üret (gerçek veriye yakın: X dar, Y uzun). */
function dikdortgen(cx: number, cy: number, w = 21.9, h = 210.4): [number, number][] {
  const hw = w / 2, hh = h / 2;
  return [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]];
}

/** Canlı ölçümün birebir karşılığı — üçü de aynı satırda, X'leri farklı. */
const GERCEK: PartPolygon[] = [
  { name: "UNDERBODY.STL_ID_0_COPY_0", center: [186.394, 162.5], polygon: dikdortgen(186.394, 162.5) },
  { name: "UNDERBODY.STL_ID_1_COPY_0", center: [162.5, 162.5], polygon: dikdortgen(162.5, 162.5) },
  { name: "UNDERBODY.STL_ID_2_COPY_0", center: [138.606, 162.5], polygon: dikdortgen(138.606, 162.5) },
];

describe("parça numaralandırma — İSİMDEN DEĞİL YERDEN", () => {
  it("aynı satırdaki kopyalar SOLDAN SAĞA numaralanır (isim sırası ÖNEMSİZ)", () => {
    const s = parcalariSirala(GERCEK);
    expect(s.map((p) => p.no)).toEqual([1, 2, 3]);
    // ID_2 en SOLDA → 1. parça. Ham isim sırasına güvenen bir kural burada ters düşerdi.
    expect(s.find((p) => p.no === 1)!.name).toBe("UNDERBODY.STL_ID_2_COPY_0");
    expect(s.find((p) => p.no === 3)!.name).toBe("UNDERBODY.STL_ID_0_COPY_0");
  });

  /**
   * TAM EŞİTLİK kullanan bir satır kuralı bugünkü veride ŞANS ESERİ çalışır: üç merkez de
   * tam 162.5. Yerleştirici mikro fark üretince (0,02 mm) sıralama karışır ve kullanıcı
   * yanlış parçayı seçer. Tolerans bunu kapatır.
   */
  it("Y'de MİKRO fark sıralamayı bozmaz (0,02 mm)", () => {
    const mikro: PartPolygon[] = [
      { name: "a", center: [186.394, 162.52], polygon: dikdortgen(186.394, 162.52) },
      { name: "b", center: [162.5, 162.5], polygon: dikdortgen(162.5, 162.5) },
      { name: "c", center: [138.606, 162.48], polygon: dikdortgen(138.606, 162.48) },
    ];
    const s = parcalariSirala(mikro);
    expect(s.map((p) => p.name)).toEqual(["c", "b", "a"]); // hâlâ soldan sağa
  });

  it("GERÇEKTEN ayrı satırlar ön→arka sıralanır", () => {
    const ikiSatir: PartPolygon[] = [
      { name: "arka-sol", center: [100, 200], polygon: dikdortgen(100, 200, 40, 40) },
      { name: "on-sag", center: [160, 60], polygon: dikdortgen(160, 60, 40, 40) },
      { name: "on-sol", center: [100, 60], polygon: dikdortgen(100, 60, 40, 40) },
    ];
    // Ön satır (Y=60) önce, kendi içinde sol→sağ; sonra arka satır.
    expect(parcalariSirala(ikiSatir).map((p) => p.name)).toEqual(["on-sol", "on-sag", "arka-sol"]);
  });

  it("boş liste boş döner", () => {
    expect(parcalariSirala([])).toEqual([]);
  });
});

describe("harita geometrisi", () => {
  it("çizim sırası: BÜYÜK parça altta, küçük üstte kalır (tıklanabilirlik)", () => {
    const karisik: PartPolygon[] = [
      { name: "kucuk", center: [100, 100], polygon: dikdortgen(100, 100, 10, 10) },
      { name: "buyuk", center: [150, 100], polygon: dikdortgen(150, 100, 80, 80) },
    ];
    const s = cizimSirasi(parcalariSirala(karisik));
    expect(s[0].name).toBe("buyuk");
    expect(s[s.length - 1].name).toBe("kucuk");
  });

  it("alan doğru hesaplanır", () => {
    expect(poligonAlani(dikdortgen(0, 0, 10, 20))).toBeCloseTo(200, 5);
  });

  it("nokta-içinde testi çalışır", () => {
    const p = dikdortgen(100, 100, 20, 20);
    expect(noktaIcinde(100, 100, p)).toBe(true);
    expect(noktaIcinde(130, 100, p)).toBe(false);
  });

  /**
   * YÖN ÖZ-DENETİMİ — haritanın en kritik güvenliği. Ekranda Y AŞAĞI, tablada ARKAYA büyür.
   * İşaret ters olursa harita aynalanır ve kullanıcı tam bir güvenle YANLIŞ parçayı iptal
   * eder; kopyalar birbirinin aynı olduğu için hatayı fark etmesi imkânsızdır.
   */
  it("Y TERS çevrilir — tablanın ARKASI ekranın ÜSTÜNDE", () => {
    const c = { minX: 0, maxX: 320, minY: 0, maxY: 320 };
    const on = mmToOran(160, 10, c);   // tablanın ÖNÜ
    const arka = mmToOran(160, 310, c); // tablanın ARKASI
    expect(arka.top).toBeLessThan(on.top);
    expect(arka.top).toBeCloseTo(0.031, 2);
    expect(on.top).toBeCloseTo(0.969, 2);
  });

  it("X ters çevrilmez — sol solda kalır", () => {
    const c = { minX: 0, maxX: 320, minY: 0, maxY: 320 };
    expect(mmToOran(10, 160, c).left).toBeLessThan(mmToOran(310, 160, c).left);
  });

  it("SVG noktaları 0-100 aralığında üretilir", () => {
    const c = { minX: 0, maxX: 320, minY: 0, maxY: 320 };
    const s = poligonSvg(dikdortgen(160, 160, 20, 20), c);
    const sayilar = s.split(/[ ,]/).map(Number);
    expect(sayilar.every((n) => n >= 0 && n <= 100)).toBe(true);
    expect(s.split(" ")).toHaveLength(4);
  });
});
