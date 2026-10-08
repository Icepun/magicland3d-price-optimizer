import { describe, expect, it } from "vitest";

import { DILIM_MS, dilimBasi, dolulukOzeti, durumSinifi } from "./yazici-doluluk";

const SIMDI = dilimBasi(Date.parse("2026-10-09T15:00:00.000Z"));
const o = (id: string, dilimOnce: number, status: string) => ({ printerConfigId: id, bucketMs: SIMDI - dilimOnce * DILIM_MS, status });

describe("yazıcı doluluğu", () => {
  it("durumlar dört sınıfa ayrılır", () => {
    expect(["printing", "paused", "error", "offline", "idle", "finished"].map(durumSinifi)).toEqual([
      "basiyor", "sorun", "sorun", "cevrimdisi", "bosta", "bosta",
    ]);
  });

  it("basma oranı BİLİNEN dilimlere göre; boşluk 'bilinmiyor'", () => {
    // 10 dilimlik ölçüm (ilk örnek 9 dilim önce): 6 basıyor, 2 boşta, 2 hiç yazılmamış.
    const ornekler = [0, 1, 2, 3, 4, 5].map((i) => o("u1", i, "printing")).concat([o("u1", 8, "idle"), o("u1", 9, "idle")]);
    const d = dolulukOzeti(ornekler, ["u1", "a1"], SIMDI, 7);
    expect(d.pencereDilim).toBe(10);
    expect(d.yazicilar[0]).toMatchObject({ basiyor: 6, bosta: 2, bilinmiyor: 2 });
    expect(d.yazicilar[0].basmaOrani).toBeCloseTo(0.75, 10);
    // Hiç örneği olmayan yazıcı: oran yok, hepsi bilinmiyor.
    expect(d.yazicilar[1]).toMatchObject({ basiyor: 0, bilinmiyor: 10, basmaOrani: null });
  });

  it("pencere dışındaki örnekler sayılmaz", () => {
    const d = dolulukOzeti([o("u1", 0, "printing"), o("u1", 8 * 288, "printing")], ["u1"], SIMDI, 7);
    expect(d.yazicilar[0].basiyor).toBe(1);
  });
});
