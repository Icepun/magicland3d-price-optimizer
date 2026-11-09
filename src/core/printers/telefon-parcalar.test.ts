/**
 * TELEFONDAN PARÇA İPTALİ — masaüstü parça listesini anlık görüntüye yazar, telefon okur.
 *
 * Kilitlenenler:
 *   • Numaralar masaüstü seçicisiyle AYNI kuralla (ön→arka, sol→sağ) verilir.
 *   • Yalnız kutu yazılır (satır baskı boyunca sık yazılıyor), değerler yuvarlanır.
 *   • Tek parçalı işte liste boş (iptal anlamsız → telefonda kart görünmez).
 *   • Telefon okuyucusu bozuk kaydı atlar; eski masaüstü alanı hiç yazmasa da boş liste döner.
 */
import { describe, expect, it } from "vitest";

import { telefonParcalari } from "./telefon-parcalar";
import { BOS_DETAY, yaziciDetayOku } from "../printer-detail";

const kare = (name: string, x: number, y: number, r = 10) => ({
  name,
  center: [x, y] as [number, number],
  polygon: [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]] as [number, number][],
});

describe("anlık görüntüye yazılan parça listesi", () => {
  it("ön sıra soldan sağa, sonra arka sıra; kutular yuvarlanır", () => {
    const p = telefonParcalari([
      kare("ARKA_SAG", 200, 200),
      kare("ON_SAG", 200, 50.04),
      kare("ON_SOL", 50.123, 50),
      kare("ARKA_SOL", 50, 200),
    ]);
    expect(p.map((x) => [x.no, x.ad])).toEqual([
      [1, "ON_SOL"], [2, "ON_SAG"], [3, "ARKA_SOL"], [4, "ARKA_SAG"],
    ]);
    expect(p[0].kutu).toEqual([40.1, 40, 60.1, 60]);
  });

  it("tek parçalı işte liste boş", () => {
    expect(telefonParcalari([kare("TEK", 100, 100)])).toEqual([]);
    expect(telefonParcalari([])).toEqual([]);
  });
});

describe("telefonun okuması", () => {
  it("yazılan liste aynen geri okunur", () => {
    const parcalar = telefonParcalari([kare("A", 50, 50), kare("B", 150, 50)]);
    const json = JSON.stringify({ ...BOS_DETAY, parcalar, iptalParcalar: ["B"] });
    const d = yaziciDetayOku(json)!;
    expect(d.parcalar).toEqual(parcalar);
    expect(d.iptalParcalar).toEqual(["B"]);
  });

  it("bozuk kayıt atlanır; alan hiç yoksa (eski masaüstü) boş liste", () => {
    const json = JSON.stringify({
      ...BOS_DETAY,
      parcalar: [
        { ad: "IYI", no: 1, kutu: [0, 0, 10, 10] },
        { ad: "", no: 2, kutu: [0, 0, 1, 1] },
        { ad: "KUTUSUZ", no: 3 },
        { ad: "NAN", no: 4, kutu: [0, 0, "x", 1] },
        null,
      ],
      iptalParcalar: ["IYI", 5, ""],
    });
    const d = yaziciDetayOku(json)!;
    expect(d.parcalar.map((p) => p.ad)).toEqual(["IYI"]);
    expect(d.iptalParcalar).toEqual(["IYI"]);

    const eski = { ...BOS_DETAY } as Record<string, unknown>;
    delete eski.parcalar;
    delete eski.iptalParcalar;
    const e = yaziciDetayOku(JSON.stringify(eski))!;
    expect(e.parcalar).toEqual([]);
    expect(e.iptalParcalar).toEqual([]);
  });
});
