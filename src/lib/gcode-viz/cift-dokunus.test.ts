import { describe, expect, it } from "vitest";

import {
  CIFT_DOKUNUS_ARALIK_MS,
  CIFT_DOKUNUS_MESAFE_PX,
  DOKUNUS_EN_UZUN_MS,
  DOKUNUS_KIPIRDAMA_PX,
  ciftDokunusTakipcisi,
} from "./cift-dokunus";

/** Tek parmakla, kıpırdamadan dokunup kaldır. */
function dokun(c: ReturnType<typeof ciftDokunusTakipcisi>, x: number, y: number, t: number, sure = 80): boolean {
  c.indi(x, y, t);
  return c.kalkti(t + sure);
}

describe("telefondaki 3B: çift dokunuş (görünümü başa al)", () => {
  it("aynı yere iki hızlı dokunuş → sıfırla", () => {
    const c = ciftDokunusTakipcisi();
    expect(dokun(c, 100, 100, 0)).toBe(false);
    expect(dokun(c, 104, 98, 80 + 150)).toBe(true);
  });

  it("üçüncü dokunuş yeni bir çiftin İLKİ sayılır (art arda sıfırlamaz)", () => {
    const c = ciftDokunusTakipcisi();
    dokun(c, 100, 100, 0);
    expect(dokun(c, 100, 100, 200)).toBe(true);
    expect(dokun(c, 100, 100, 400)).toBe(false);
    expect(dokun(c, 100, 100, 600)).toBe(true);
  });

  it("modeli arka arkaya hızlıca iki kez ÇEVİRMEK sıfırlamaz (eski hatanın ta kendisi)", () => {
    const c = ciftDokunusTakipcisi();
    for (const bas of [0, 180]) {
      c.indi(100, 100, bas);
      c.oynadi(100 + DOKUNUS_KIPIRDAMA_PX + 30, 100);
      expect(c.kalkti(bas + 120)).toBe(false);
    }
  });

  it("çevirmenin hemen ardından tek dokunuş da sıfırlamaz", () => {
    const c = ciftDokunusTakipcisi();
    c.indi(100, 100, 0);
    c.oynadi(160, 100);
    c.kalkti(100);
    expect(dokun(c, 100, 100, 150)).toBe(false);
  });

  it("birkaç piksel titreme dokunuşu bozmaz", () => {
    const c = ciftDokunusTakipcisi();
    c.indi(100, 100, 0);
    c.oynadi(100 + DOKUNUS_KIPIRDAMA_PX - 2, 100);
    c.kalkti(80);
    expect(dokun(c, 100, 100, 200)).toBe(true);
  });

  it("aralık uzunsa iki ayrı dokunuştur", () => {
    const c = ciftDokunusTakipcisi();
    dokun(c, 100, 100, 0);
    expect(dokun(c, 100, 100, 80 + CIFT_DOKUNUS_ARALIK_MS + 1)).toBe(false);
  });

  it("uzun basış dokunuş değildir", () => {
    const c = ciftDokunusTakipcisi();
    dokun(c, 100, 100, 0, DOKUNUS_EN_UZUN_MS + 50);
    expect(dokun(c, 100, 100, 400)).toBe(false);
  });

  it("uzak iki noktaya dokunmak çift dokunuş değildir", () => {
    const c = ciftDokunusTakipcisi();
    dokun(c, 100, 100, 0);
    expect(dokun(c, 100 + CIFT_DOKUNUS_MESAFE_PX + 5, 100, 200)).toBe(false);
  });

  it("iki parmak (yakınlaştırma) dokunuş sayılmaz", () => {
    const c = ciftDokunusTakipcisi();
    dokun(c, 100, 100, 0);
    c.indi(100, 100, 150);
    c.ikinciParmak();
    expect(c.kalkti(220)).toBe(false);
    // Yakınlaştırmadan hemen sonraki tek dokunuş da yeni çiftin ilki.
    expect(dokun(c, 100, 100, 300)).toBe(false);
  });

  it("sistem hareketi devralırsa (pointercancel) yarım dokunuş unutulur", () => {
    const c = ciftDokunusTakipcisi();
    dokun(c, 100, 100, 0);
    c.indi(100, 100, 150);
    c.iptal();
    expect(dokun(c, 100, 100, 250)).toBe(false);
  });
});
