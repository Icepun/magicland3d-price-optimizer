/**
 * Yazıcılar arası filament karşılaştırması.
 *
 * Berke'nin isteği: "diğer makinelerle kıyaslama yapıp en az filament tüketen makinede
 * basmamı sağlayabilir". Buradaki en sinsi hata, YARIM ölçülmüş bir makineyi "en az
 * harcayan" ilan etmek olurdu — toplamı doğal olarak küçük çıkar ve kullanıcı yanlış
 * makineye yönlendirilir. Testler bunu kilitliyor.
 */
import { describe, expect, it } from "vitest";
import { gramajByPrinter, gramajCompareText, missingGramajFiles } from "./models-view";

const P = { snap: "snapmaker", bambu: "bambu", nep: "neptune" };

describe("yazıcı başına filament", () => {
  it("her yazıcının parçalarını toplar ve en azı işaretler", () => {
    const rows = gramajByPrinter(
      [
        { printerConfigId: P.snap, gramaj: 50 },
        { printerConfigId: P.snap, gramaj: 34 },
        { printerConfigId: P.bambu, gramaj: 61 },
      ],
      [P.snap, P.bambu]
    );

    expect(rows.find((r) => r.printerConfigId === P.snap)?.grams).toBe(84);
    expect(rows.find((r) => r.printerConfigId === P.bambu)?.grams).toBe(61);
    expect(rows.find((r) => r.printerConfigId === P.bambu)?.lowest).toBe(true);
    expect(rows.find((r) => r.printerConfigId === P.snap)?.lowest).toBe(false);
  });

  it("YARIM ölçülmüş yazıcı 'en az' seçilemez — asıl tuzak", () => {
    // Snapmaker'ın iki parçasından biri okunmamış: toplamı 50 görünür ama gerçek değeri
    // daha yüksek. Bambu tam okunmuş 61 gr. Yarım veriye bakıp Snapmaker'ı seçmek yanlış.
    const rows = gramajByPrinter(
      [
        { printerConfigId: P.snap, gramaj: 50 },
        { printerConfigId: P.snap, gramaj: null },
        { printerConfigId: P.bambu, gramaj: 61 },
      ],
      [P.snap, P.bambu]
    );

    expect(rows.find((r) => r.printerConfigId === P.snap)?.lowest).toBe(false);
    // Tam okunmuş TEK aday kaldı → kıyas kurulamaz, hiçbiri işaretlenmez.
    expect(rows.every((r) => !r.lowest)).toBe(true);
    expect(gramajCompareText(rows)).toBeNull();
  });

  it("hiç okunmamış yazıcı SIFIR değil BİLİNMİYOR", () => {
    const rows = gramajByPrinter(
      [{ printerConfigId: P.snap, gramaj: null }, { printerConfigId: P.bambu, gramaj: 61 }],
      [P.snap, P.bambu]
    );

    expect(rows.find((r) => r.printerConfigId === P.snap)?.grams).toBeNull();
    expect(rows.find((r) => r.printerConfigId === P.snap)?.known).toBe(0);
  });

  it("dosyası olmayan yazıcı listeye hiç girmez", () => {
    const rows = gramajByPrinter([{ printerConfigId: P.snap, gramaj: 10 }], [P.snap, P.nep]);
    expect(rows.map((r) => r.printerConfigId)).toEqual([P.snap]);
  });

  it("tek aday varken kıyas kurulmaz", () => {
    const rows = gramajByPrinter([{ printerConfigId: P.snap, gramaj: 40 }], [P.snap]);
    expect(rows[0].lowest).toBe(false);
    expect(gramajCompareText(rows)).toBeNull();
  });

  it("eşit tüketimde ikisi de işaretlenir ve metin bunu söyler", () => {
    const rows = gramajByPrinter(
      [{ printerConfigId: P.snap, gramaj: 61 }, { printerConfigId: P.bambu, gramaj: 61 }],
      [P.snap, P.bambu]
    );
    expect(rows.every((r) => r.lowest)).toBe(true);
    expect(gramajCompareText(rows)).toMatch(/aynı miktarda/);
  });

  it("tasarruf metni farkı ve yüzdeyi doğru verir", () => {
    const rows = gramajByPrinter(
      [{ printerConfigId: P.snap, gramaj: 84 }, { printerConfigId: P.bambu, gramaj: 61 }],
      [P.snap, P.bambu]
    );
    // 84 − 61 = 23 gr, 84'ün %27'si.
    expect(gramajCompareText(rows)).toBe("En az harcayan makine 23 gr (%27) tasarruf ediyor.");
  });

  it("okunmamış parçaları listeler", () => {
    const eksik = missingGramajFiles([
      { id: "a", gramaj: 10 },
      { id: "b", gramaj: null },
      { id: "c", gramaj: null },
    ]);
    expect(eksik.map((f) => f.id)).toEqual(["b", "c"]);
  });
});
