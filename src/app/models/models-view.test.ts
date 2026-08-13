/**
 * Yazıcılar arası filament karşılaştırması.
 *
 * Berke'nin isteği: "diğer makinelerle kıyaslama yapıp en az filament tüketen makinede
 * basmamı sağlayabilir". Buradaki en sinsi hata, YARIM ölçülmüş bir makineyi "en az
 * harcayan" ilan etmek olurdu — toplamı doğal olarak küçük çıkar ve kullanıcı yanlış
 * makineye yönlendirilir. Testler bunu kilitliyor.
 */
import { describe, expect, it } from "vitest";
import {
  foldTr, gramajByPrinter, gramajCompareText, missingFiles, missingGramajFiles,
  searchProduct, sortProducts,
} from "./models-view";

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

describe("arama", () => {
  const urun = {
    name: "Ahtapot Figürlü Şarap Tutacağı",
    files: [
      { id: "a", label: null, originalName: "Ahtapot Şarap 20s10dk.gcode" },
      { id: "b", label: "Gövde", originalName: "body.gcode" },
    ],
  };

  it("Türkçe büyük I/İ doğru katlanır", () => {
    // `toLowerCase()` "İ" için "i̇" üretir ve eşleşme kaçar; tr-TR şart.
    expect(foldTr("İSTASYON")).toBe(foldTr("istasyon"));
    expect(foldTr("IRMAK")).toBe(foldTr("ırmak"));
  });

  it("diakritiksiz yazılan arama da bulur", () => {
    expect(searchProduct(urun, "sarap").matches).toBe(true);
    expect(searchProduct(urun, "figurlu").matches).toBe(true);
  });

  it("PARÇA adından eşleşir ve hangi parça olduğunu söyler (asıl eksik)", () => {
    const hit = searchProduct(urun, "20s10");
    expect(hit.matches).toBe(true);
    expect(hit.nameMatched).toBe(false);
    expect(hit.matchedFileIds).toEqual(["a"]);
  });

  it("parça ETİKETİNDEN de eşleşir", () => {
    expect(searchProduct(urun, "gövde").matchedFileIds).toEqual(["b"]);
  });

  it("boş sorgu her ürünü geçirir", () => {
    const hit = searchProduct(urun, "   ");
    expect(hit.matches).toBe(true);
    expect(hit.matchedFileIds).toEqual([]);
  });

  it("eşleşmeyen sorgu ürünü eler", () => {
    expect(searchProduct(urun, "bisiklet").matches).toBe(false);
  });
});

describe("sıralama", () => {
  const list = [
    { name: "Bardak", files: [{ id: "1" }], totalBytes: 900 },
    { name: "Ahtapot", files: [{ id: "2" }, { id: "3" }], totalBytes: 100 },
    { name: "Çanta", files: [{ id: "4" }], totalBytes: 500 },
  ];

  it("ada göre Türkçe sıralar (Ç, A'dan sonra B'den sonra)", () => {
    expect(sortProducts(list, "name").map((p) => p.name)).toEqual(["Ahtapot", "Bardak", "Çanta"]);
  });

  it("parça sayısına göre", () => {
    expect(sortProducts(list, "parts")[0].name).toBe("Ahtapot");
  });

  it("boyuta göre — temizlik bunun için", () => {
    expect(sortProducts(list, "size").map((p) => p.name)).toEqual(["Bardak", "Çanta", "Ahtapot"]);
  });

  it("girdi dizisini DEĞİŞTİRMEZ", () => {
    const kopya = [...list];
    sortProducts(list, "size");
    expect(list).toEqual(kopya);
  });
});

describe("eksik dosya filtresi", () => {
  const urun = { files: [{ printerConfigId: "snap" }, { printerConfigId: "bambu" }] };
  const hepsi = ["snap", "bambu", "nep"];

  it("SEÇİLEN yazıcıya göre süzer", () => {
    expect(missingFiles(urun, hepsi, "nep")).toBe(true);
    expect(missingFiles(urun, hepsi, "snap")).toBe(false);
  });

  it("yazıcı seçilmezse herhangi birinde eksik olması yeter (eski davranış)", () => {
    expect(missingFiles(urun, hepsi)).toBe(true);
    expect(missingFiles(urun, ["snap", "bambu"])).toBe(false);
  });
});
