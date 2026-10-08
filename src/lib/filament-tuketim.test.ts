import { describe, expect, it } from "vitest";

import { filamentTuketimi } from "./filament-tuketim";

const GUN = 86_400_000;
const SIMDI = Date.parse("2026-10-09T15:00:00.000Z");
const k = (quantity: number, filamentWeight: number | null, ek: string | null = null, wasteRate: number | null = null) => ({
  quantity,
  filamentWeight,
  ekFilamentlerJson: ek,
  wasteRate,
});

describe("filament kaç gün yeter (satış hızından)", () => {
  it("reçete gramı × adet, fire dahil; 90 güne bölünür", () => {
    // 900 g + (100 g ×1,1 fire)×9 = 900 + 990 = 1890 g / 90 gün = 21 g/gün; stok 2100 g → 100 gün.
    const t = filamentTuketimi([k(9, 100), k(9, 100, null, 10)], 2100, SIMDI - 300 * GUN, SIMDI);
    expect(t.toplamGram).toBeCloseTo(1890, 6);
    expect(t.gunlukGram).toBeCloseTo(21, 6);
    expect(t.kacGun).toBeCloseTo(100, 6);
  });

  it("ek filamentler de sayılır", () => {
    const t = filamentTuketimi([k(1, 80, '[{"filamentTypeId":"silk","gram":20}]')], 1000, SIMDI - 300 * GUN, SIMDI);
    expect(t.toplamGram).toBe(100);
  });

  it("gramı girilmemiş ürün hesaba girmez ama sayısı söylenir", () => {
    const t = filamentTuketimi([k(3, null), k(1, 50)], 1000, SIMDI - 300 * GUN, SIMDI);
    expect(t.gramsizAdet).toBe(3);
    expect(t.toplamGram).toBe(50);
  });

  it("geçmiş kısaysa gün sayısı uydurulmaz", () => {
    const t = filamentTuketimi([k(5, 100)], 1000, SIMDI - 10 * GUN, SIMDI);
    expect(t.hazir).toBe(false);
    expect(t.kacGun).toBeNull();
  });
});
