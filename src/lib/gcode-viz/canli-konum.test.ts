/**
 * CANLI KONUM — yazıcının bildirdiği konumun modeldeki şeride çevrilmesi.
 *
 * Kart ve izleyici nozulu bu hesapla gösteriyor: yanlış eşleme "nozul başka yerde basıyor"
 * görüntüsü demek. Ölçülen gerçekler (23 Eyl 2026): U1 dosya baytı + gerçek XY veriyor,
 * Bambu A1'in satır numarası hep 0 — orada yalnız katman değişimi çapa.
 */
import { describe, expect, it } from "vitest";
import { scanGcodeText } from "./parse-gcode";
import { yolZamaniKur, type VizPack } from "./viz-pack";
import {
  CanliTakipci, bayttanIlerleme, ilerlemedenZaman, ilerlemeninKatmani, katmanBasSegment,
  katmanSonSegment, xyIleDuzelt, zamandanIlerleme, type SegmentOkuyucu,
} from "./canli-konum";

/**
 * Her katmanda 10 mm kenarlı kare (4 segment), F600 = 10 mm/sn → her segment 1 sn.
 * Kareler sadeleştirmeye takılmasın diye köşeler gerçek köşe (düz değil).
 */
function kareBaski(katman: number): string {
  const s: string[] = ["M83", "G1 F600"];
  for (let l = 0; l < katman; l++) {
    const z = +(0.2 * (l + 1)).toFixed(2);
    s.push(";LAYER_CHANGE", `;Z:${z}`, ";TYPE:Outer wall", `G0 X0 Y0 Z${z} F600`);
    s.push("G1 X10 Y0 E0.5", "G1 X10 Y10 E0.5", "G1 X0 Y10 E0.5", "G1 X0 Y0 E0.5");
  }
  return s.join("\n") + "\n";
}

function paketOkuyucu(p: VizPack, yz: ReturnType<typeof yolZamaniKur>): SegmentOkuyucu {
  return (i, c) => {
    let yol = 0;
    let lo = 0, hi = yz.segBas.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (yz.segBas[m] <= i) { yol = m; lo = m + 1; } else hi = m - 1; }
    const k = i - yz.segBas[yol];
    const b = p.pathStart[yol] + k;
    c[0] = p.originX + p.points[b * 2] * p.scaleXY;
    c[1] = p.originY + p.points[b * 2 + 1] * p.scaleXY;
    c[2] = p.originX + p.points[(b + 1) * 2] * p.scaleXY;
    c[3] = p.originY + p.points[(b + 1) * 2 + 1] * p.scaleXY;
    let li = 0;
    for (let j = 0; j < p.layerZ.length; j++) if (p.layerPathStart[j] <= yol) li = j;
    c[4] = p.layerZ[li];
  };
}

describe("tarayıcının zaman çizelgesi", () => {
  const paket = scanGcodeText(kareBaski(3));
  const yz = yolZamaniKur(paket);

  it("her katman bir yol, her yol 4 segment", () => {
    expect(yz.segSay.length).toBe(3);
    expect(Array.from(yz.segSay)).toEqual([4, 4, 4]);
    expect(Array.from(yz.segBas)).toEqual([0, 4, 8]);
  });

  it("süre F hızından: 10 mm / (600 mm/dk) = 1 sn → yol 4 sn", () => {
    for (let i = 0; i < 3; i++) expect(yz.zamanSon[i] - yz.zamanBas[i]).toBeCloseTo(4, 3);
    // Katman arası seyahat de süreye girer: sonraki yol öncekinin bitişinden sonra başlar.
    expect(yz.zamanBas[1]).toBeGreaterThanOrEqual(yz.zamanSon[0]);
  });

  it("bayt aralıkları dosya sırasıyla artıyor", () => {
    for (let i = 0; i < 3; i++) expect(yz.baytSon[i]).toBeGreaterThan(yz.baytBas[i]);
    expect(yz.baytBas[1]).toBeGreaterThan(yz.baytSon[0]);
  });

  it("G4 beklemesi süreye eklenir", () => {
    const beklemeli = scanGcodeText(kareBaski(2).replace(";LAYER_CHANGE\n;Z:0.4", "G4 P5000\n;LAYER_CHANGE\n;Z:0.4"));
    const z2 = yolZamaniKur(beklemeli);
    expect(z2.zamanBas[1] - yz.zamanBas[1]).toBeCloseTo(5, 3);
  });
});

describe("eşlemeler", () => {
  const paket = scanGcodeText(kareBaski(3));
  const yz = yolZamaniKur(paket);

  it("süre ↔ ilerleme gidiş dönüşü", () => {
    for (const p of [0.5, 2, 3.75, 5, 9.2, 12]) {
      expect(zamandanIlerleme(yz, ilerlemedenZaman(yz, p))).toBeCloseTo(p, 4);
    }
  });

  it("bayt konumu yolun içinde orantılı, yollar arasında önceki yolun sonu", () => {
    expect(bayttanIlerleme(yz, yz.baytBas[1])).toBeCloseTo(4, 6);
    expect(bayttanIlerleme(yz, yz.baytSon[1])).toBeCloseTo(8, 6);
    const orta = (yz.baytSon[1] + yz.baytBas[2]) / 2; // katman arası seyahat
    if (orta < yz.baytBas[2]) expect(bayttanIlerleme(yz, orta)).toBeCloseTo(8, 6);
  });

  it("katman sınırları ve ilerlemenin katmanı", () => {
    expect(katmanBasSegment(yz, 1)).toBe(4);
    expect(katmanSonSegment(yz, 1)).toBe(8);
    expect(ilerlemeninKatmani(yz, 4)).toBe(0); // 4 → 3. segment bitti, hâlâ katman 0
    expect(ilerlemeninKatmani(yz, 4.5)).toBe(1);
    expect(ilerlemeninKatmani(yz, 12)).toBe(2);
  });

  it("gerçek XY geriye doğru en yakın şeride oturur (bayt konumu önde)", () => {
    const oku = paketOkuyucu(paket, yz);
    // Bayt konumu katman 1'in sonunu gösteriyor ama nozul gerçekte o katmanın 2. kenarının
    // ortasında (X=10, Y=5).
    const p = xyIleDuzelt(yz, oku, 8, 10, 5, 0.4);
    expect(p).toBeCloseTo(5.5, 2);
  });

  it("çok uzak XY (seyahat) bayt konumunu bozmaz", () => {
    const oku = paketOkuyucu(paket, yz);
    expect(xyIleDuzelt(yz, oku, 7, 80, 80, 0.4)).toBe(7);
  });
});

describe("canlı takipçi", () => {
  const paket = scanGcodeText(kareBaski(20));
  const yz = yolZamaniKur(paket);

  it("bayt ölçümleri arasında nozul ileri akar, ölçüme sıçramadan yaklaşır", () => {
    const tk = new CanliTakipci(yz);
    expect(tk.kullanilabilir).toBe(true);
    tk.olc({ dosyaKonumu: yz.baytBas[2], an: 1000 });
    const p0 = tk.ilerle(1000)!;
    expect(p0).toBeCloseTo(8, 1);
    let onceki = p0;
    for (let an = 1100; an <= 2900; an += 100) {
      const p = tk.ilerle(an)!;
      expect(p).toBeGreaterThanOrEqual(onceki - 1e-9); // geri gitmez
      onceki = p;
    }
    expect(onceki).toBeGreaterThan(p0); // gerçekten ilerledi
  });

  it("ardışık ölçümlerden hız oranını öğrenir", () => {
    const tk = new CanliTakipci(yz);
    // 2 sn'de 4 sn'lik baskı süresi ilerlemiş → oran 2'ye yaklaşmalı.
    tk.olc({ dosyaKonumu: yz.baytBas[1], an: 0 });
    tk.olc({ dosyaKonumu: yz.baytBas[2], an: 2000 });
    tk.olc({ dosyaKonumu: yz.baytBas[3], an: 4000 });
    expect(tk.hizOrani).toBeGreaterThan(1.3);
  });

  it("duraklatılmış baskıda nozul durur", () => {
    const tk = new CanliTakipci(yz);
    tk.olc({ dosyaKonumu: yz.baytBas[3], an: 0, duraklatildi: true });
    const a = tk.ilerle(0)!;
    const b = tk.ilerle(5000)!;
    expect(b).toBeCloseTo(a, 6);
  });

  it("konum değişmiyorsa (ısınma, tabla ölçümü) nozul yerinde bekler, baskı başlayınca akar", () => {
    const tk = new CanliTakipci(yz);
    // Ölçüldü (23 Eyl 2026): U1 ısınırken dosya konumu başlangıç kodunda duruyor, nozul park yerinde.
    tk.olc({ dosyaKonumu: 10, nozulX: 45, nozulY: 300, nozulZ: 90, an: 0 });
    tk.olc({ dosyaKonumu: 10, nozulX: 45, nozulY: 300, nozulZ: 90, an: 2000 });
    const a = tk.ilerle(2000)!;
    let p = a;
    for (let an = 2100; an <= 3900; an += 100) p = tk.ilerle(an)!;
    expect(p).toBeCloseTo(a, 6);
    // Baskı başladı: konum ilerledi → ölçümler arası tahmin yeniden yürür.
    tk.olc({ dosyaKonumu: yz.baytBas[2], an: 4000 });
    const b = tk.ilerle(4000)!;
    for (let an = 4100; an <= 5900; an += 100) p = tk.ilerle(an)!;
    expect(p).toBeGreaterThan(b);
  });

  it("yalnız katman bilinirken (Bambu) katmanın başına oturur, sonunu geçmez", () => {
    const tk = new CanliTakipci(yz);
    tk.olc({ katmanIdx: 5, an: 0 });
    expect(tk.ilerle(0)!).toBeCloseTo(katmanBasSegment(yz, 5), 3);
    // Çok uzun süre yeni ölçüm gelmese de katman 5'in sonunda bekler.
    let p = 0;
    for (let an = 100; an <= 60_000; an += 100) p = tk.ilerle(an)!;
    expect(p).toBeLessThanOrEqual(katmanSonSegment(yz, 5) + 1e-6);
    // Yeni katman gelince oraya geçer.
    tk.olc({ katmanIdx: 6, an: 60_000 });
    for (let an = 60_100; an <= 62_000; an += 100) p = tk.ilerle(an)!;
    expect(ilerlemeninKatmani(yz, p)).toBe(6);
  });

  it("eski paket (süre yok) takip edilmez — çağıran katman kilidine düşer", () => {
    const eski = { ...yz, zamanBas: new Float32Array(yz.zamanBas.length), zamanSon: new Float32Array(yz.zamanSon.length) };
    const tk = new CanliTakipci(eski);
    expect(tk.kullanilabilir).toBe(false);
    tk.olc({ katmanIdx: 3, an: 0 });
    expect(tk.ilerle(0)).toBeNull();
  });
});
