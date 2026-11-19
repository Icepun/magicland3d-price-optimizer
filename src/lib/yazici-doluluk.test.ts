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

/**
 * EŞİTLİK: uç artık örnekleri indirmek yerine veritabanında topluyor. Toplanmış sayımlardan
 * çıkan özet, eski yolun (örnek örnek) verdiğiyle BİREBİR aynı olmalı.
 */
describe("sayımdan özet = örnekten özet", () => {
  // Deterministik sözde-rastgele (test her koşuda aynı veriyi üretsin).
  function rastgele(tohum: number) {
    let s = tohum >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
  }
  const DURUMLAR = ["printing", "paused", "error", "idle", "finished", "offline", "tuhaf"];

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("rastgele veri #%i", async (tohum) => {
    const { dolulukOzetiSayimdan } = await import("./yazici-doluluk");
    const r = rastgele(tohum);
    const gun = [1, 7, 30][Math.floor(r() * 3)];
    const now = SIMDI + Math.floor(r() * DILIM_MS); // dilim sınırına hizalı OLMAYAN an
    const yazicilar = ["u1", "a1", "a2", "silinmis"];
    const idler = ["u1", "a1", "a2", "hic-ornegi-yok"]; // biri silinmiş, biri örneksiz
    const ornekler: { printerConfigId: string; bucketMs: number; status: string }[] = [];
    const adet = Math.floor(r() * 4000);
    const gorulen = new Set<string>();
    for (let i = 0; i < adet; i++) {
      const y = yazicilar[Math.floor(r() * yazicilar.length)];
      const bucketMs = dilimBasi(now) - Math.floor(r() * (gun + 2) * 288) * DILIM_MS; // pencere dışı da var
      const k = y + "|" + bucketMs;
      if (gorulen.has(k)) continue; // birincil anahtar: yazıcı × dilim tekil
      gorulen.add(k);
      ornekler.push({ printerConfigId: y, bucketMs, status: DURUMLAR[Math.floor(r() * DURUMLAR.length)] });
    }
    // Ucun sorgusunun AYNISI: alt sınır hizasız (now - gun gün), üst sınır dilim başı.
    const pencere = ornekler.filter((o) => o.bucketMs >= now - gun * 86_400_000 && o.bucketMs <= dilimBasi(now));
    const gruplar = new Map<string, { printerConfigId: string; status: string; adet: number; ilk: number }>();
    for (const o of pencere) {
      const k = o.printerConfigId + "|" + o.status;
      const g = gruplar.get(k) ?? { printerConfigId: o.printerConfigId, status: o.status, adet: 0, ilk: o.bucketMs };
      g.adet++;
      g.ilk = Math.min(g.ilk, o.bucketMs);
      gruplar.set(k, g);
    }
    expect(dolulukOzetiSayimdan([...gruplar.values()], idler, now, gun)).toEqual(dolulukOzeti(pencere, idler, now, gun));
  });

  it("hiç örnek yokken de aynı", async () => {
    const { dolulukOzetiSayimdan } = await import("./yazici-doluluk");
    expect(dolulukOzetiSayimdan([], ["u1"], SIMDI, 7)).toEqual(dolulukOzeti([], ["u1"], SIMDI, 7));
  });
});
