/**
 * LİSTEDEN KALDIRILAN VİDEOLAR.
 *
 * Snapmaker U1'de video silinemediği için tek çare gizlemek — ve gizleme GERİ ALINABİLİR
 * olmak zorunda: yanlışlıkla kaldırılan video başka türlü bir daha görünmezdi.
 * Bu yüzden testlerin ağırlığı "geri alma çalışıyor mu" ve "bozuk kayıt listeyi
 * yutmuyor mu" üzerinde.
 */
import { describe, expect, it } from "vitest";
import { adiUygula, adlariCoz } from "./timelapse-hidden";

describe("kayıt çözümleme", () => {
  it("normal JSON dizisi", () => {
    expect(adlariCoz('["a.mp4","b.mp4"]')).toEqual(["a.mp4", "b.mp4"]);
  });

  it("boş/eksik değer → boş liste", () => {
    expect(adlariCoz(null)).toEqual([]);
    expect(adlariCoz(undefined)).toEqual([]);
    expect(adlariCoz("")).toEqual([]);
  });

  it("BOZUK kayıt galeriyi patlatmaz, boş liste döner", () => {
    expect(adlariCoz("{bu json değil")).toEqual([]);
    expect(adlariCoz('{"a":1}')).toEqual([]);
  });

  it("dizi içindeki çöp elenir, metinler kalır", () => {
    expect(adlariCoz('["a.mp4",null,3,{"x":1},"b.mp4",""]')).toEqual(["a.mp4", "b.mp4"]);
  });
});

describe("gizle / geri al", () => {
  it("ekler", () => {
    expect(adiUygula([], "a.mp4", true)).toEqual(["a.mp4"]);
  });

  it("aynı adı İKİ KEZ eklemez", () => {
    expect(adiUygula(["a.mp4"], "a.mp4", true)).toEqual(["a.mp4"]);
  });

  it("geri alma adı çıkarır — kullanıcı videoyu tekrar görebilmeli", () => {
    expect(adiUygula(["a.mp4", "b.mp4"], "a.mp4", false)).toEqual(["b.mp4"]);
  });

  it("listede olmayanı geri almak zararsız", () => {
    expect(adiUygula(["b.mp4"], "a.mp4", false)).toEqual(["b.mp4"]);
  });

  it("diğer videolara dokunmaz", () => {
    expect(adiUygula(["a.mp4", "b.mp4"], "c.mp4", true)).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
  });
});
