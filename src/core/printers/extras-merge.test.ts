/**
 * BİLİNMEYEN ≠ YOK.
 *
 * Sahada ölçülen senaryo: Snapmaker U1, 600. katmanda duraklatma kurulu hâlde basarken yoğun bir
 * anda `/printer/objects/query` zaman aşımına uğradı. Boş sonuç 15 saniye önbelleğe yazıldığı için
 * kart "600. katmanda duracak" rozetini gösterMEdi, dört filament çipi tek çipe düştü ve
 * kontrol düğmeleri yok olup geri geldi — kullanıcı duraklatmanın silindiğini sanıp ikinci kez kurdu.
 */
import { describe, expect, it } from "vitest";
import { mergeMoonrakerExtras } from "./extras-merge";
import { emptyMoonrakerExtras, type MoonrakerExtras } from "./moonraker";

function good(): MoonrakerExtras {
  return {
    ...emptyMoonrakerExtras(),
    read: true,
    caps: {
      lightKind: "led", lightTargets: ["caselight"], pauseAtLayer: true,
      filamentChange: true, defectDetection: true, speed: true, discovered: true,
    },
    light: { supported: true, readable: true, on: true },
    slots: [
      { slot: 0, color: "#e23b3b", type: "PLA", empty: false },
      { slot: 1, color: "#2b6cf0", type: "PETG", empty: false },
    ],
    activeSlots: [0],
    pauseAtLayer: 600,
    defectWatch: { supported: true, enabled: true, spaghetti: true, cleanBed: true },
  };
}

describe("kaçan yan-bilgi sorgusu bilinen değerleri silmez", () => {
  it("sorgu düşerse kurulu duraklatma, slotlar ve ışık DURUR", () => {
    const merged = mergeMoonrakerExtras(good(), emptyMoonrakerExtras());
    expect(merged.pauseAtLayer).toBe(600);
    expect(merged.slots).toHaveLength(2);
    expect(merged.light.readable).toBe(true);
    expect(merged.defectWatch.enabled).toBe(true);
  });

  it("keşif düşerse kontrol düğmeleri kaybolmaz (son bilinen yetenekler korunur)", () => {
    const merged = mergeMoonrakerExtras(good(), emptyMoonrakerExtras());
    expect(merged.caps.pauseAtLayer).toBe(true);
    expect(merged.caps.filamentChange).toBe(true);
    expect(merged.caps.lightKind).toBe("led");
  });

  it("başarılı okuma her zaman kazanır — eski değer yapışıp kalmaz", () => {
    const next = { ...good(), pauseAtLayer: null, slots: [] };
    const merged = mergeMoonrakerExtras(good(), next);
    expect(merged.pauseAtLayer).toBeNull();
    expect(merged.slots).toHaveLength(0);
  });

  it("okuma düşse de YENİ keşif başarılıysa yetenekler tazelenir", () => {
    const stale = { ...emptyMoonrakerExtras(), read: false, caps: { ...good().caps, filamentChange: false } };
    const merged = mergeMoonrakerExtras(good(), stale);
    expect(merged.pauseAtLayer).toBe(600);      // değerler son bilinen
    expect(merged.caps.filamentChange).toBe(false); // yetenek tazelendi
  });

  it("elde hiç gerçek okuma yoksa uydurma yapılmaz", () => {
    const merged = mergeMoonrakerExtras(undefined, emptyMoonrakerExtras());
    expect(merged.pauseAtLayer).toBeNull();
    expect(merged.caps.discovered).toBe(false);
  });
});
