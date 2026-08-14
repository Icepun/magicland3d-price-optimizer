/**
 * PARÇA İPTALİ — geri alınamaz bir işlem, testleri de ona göre.
 *
 * Her test, kullanıcının SAĞLAM parçasını kaybetmesine yol açabilecek somut bir tuzağı
 * kilitler. Tuzakların hepsi Klipper kaynağından ve canlı yazıcıdan ölçülerek bulundu.
 */
import { describe, expect, it } from "vitest";
import { gecerliNesneler, klipperParamKacisla } from "./moonraker";

describe("Klipper parametre kaçışlaması", () => {
  /**
   * ⚠️ EN TEHLİKELİ TUZAK: Klipper shlex kullanıyor ve '#' YORUM başlatıyor.
   * NAME=part#1 tırnaksız gönderilirse SESSİZCE "part"a kırpılır — hata çıkmaz, YANLIŞ
   * nesne iptal edilir (ya da hiçbiri) ve kullanıcı iptal ettiğini sanır.
   */
  it("KARE işareti tırnağa alınır (sessiz kırpılmayı önler)", () => {
    expect(klipperParamKacisla("part#1")).toBe('"part#1"');
  });

  it("NOKTALI VİRGÜL tırnağa alınır — o da yorum başlatıyor", () => {
    expect(klipperParamKacisla("a;b")).toBe('"a;b"');
  });

  it("BOŞLUK tırnağa alınır — yoksa ikinci kelime ayrı parametre sanılır", () => {
    expect(klipperParamKacisla("Max Shroud")).toBe('"Max Shroud"');
  });

  it("KESME İŞARETİ tırnağa alınır (OrcaSlicer #2027: Malformed command)", () => {
    expect(klipperParamKacisla("Max's Shroud")).toBe(`"Max's Shroud"`);
  });

  it("ÇİFT TIRNAK ve TERS BÖLÜ kaçırılır", () => {
    expect(klipperParamKacisla('a"b')).toBe('"a\\"b"');
    expect(klipperParamKacisla("a\\b")).toBe('"a\\\\b"');
  });

  it("EŞİTTİR tırnağa alınır — parametre sınırı sanılmasın", () => {
    expect(klipperParamKacisla("a=b")).toBe('"a=b"');
  });

  /** Gerçek adlar (canlı ölçüm) sade — gereksiz tırnak eklenmemeli. */
  it("SADE ad olduğu gibi geçer", () => {
    expect(klipperParamKacisla("UNDERBODY.STL_ID_0_COPY_0")).toBe("UNDERBODY.STL_ID_0_COPY_0");
  });

  /**
   * ⚠️ TÜRKÇE TUZAĞI: ad ASLA büyütülmez. toLocaleUpperCase("tr") "Çiçeği"yi "ÇİÇEĞİ" yapar,
   * Python'un upper() ise "ÇIÇEĞI" — eşleşme kaybolur ve komut yanlış/boş gider.
   * Bu test, ileride birinin "normalize edeyim" diye büyütme eklemesini engeller.
   */
  it("ad DEĞİŞTİRİLMEZ — büyütme, kırpma, boşluk temizleme YOK", () => {
    expect(klipperParamKacisla("Çiçeği")).toBe("Çiçeği");
    expect(klipperParamKacisla(" bosluklu ")).toBe('" bosluklu "');
  });
});

describe("nesne listesi ayıklama", () => {
  const tam = {
    name: "UNDERBODY.STL_ID_0_COPY_0",
    center: [186.394, 162.5],
    polygon: [[175.4, 57.3], [197.3, 57.3], [197.3, 267.7], [175.4, 267.7]],
  };

  it("tam nesne geçer", () => {
    expect(gecerliNesneler([tam])).toHaveLength(1);
    expect(gecerliNesneler([tam])[0].name).toBe(tam.name);
  });

  /**
   * ⚠️ Klipper, tanımsız bir adla EXCLUDE_OBJECT_START görürse nesneyi YALNIZ isimle listeye
   * ekliyor — poligonsuz. Böyle bir kayıt haritada çizilemez; elenmezse görünmez ama
   * "tıklanabilir" bir hayalet olarak kalır.
   */
  it("POLİGONSUZ nesne ELENİR", () => {
    expect(gecerliNesneler([{ name: "hayalet" }])).toHaveLength(0);
    expect(gecerliNesneler([{ name: "hayalet", polygon: [], center: [1, 2] }])).toHaveLength(0);
  });

  it("MERKEZSİZ nesne elenir", () => {
    expect(gecerliNesneler([{ ...tam, center: undefined }])).toHaveLength(0);
  });

  it("üç noktadan az poligon elenir (alan yok)", () => {
    expect(gecerliNesneler([{ ...tam, polygon: [[1, 1], [2, 2]] }])).toHaveLength(0);
  });

  it("bozuk girdi patlatmaz", () => {
    expect(gecerliNesneler(null)).toEqual([]);
    expect(gecerliNesneler(undefined)).toEqual([]);
    expect(gecerliNesneler([null, 5, "x", {}])).toEqual([]);
  });
});
