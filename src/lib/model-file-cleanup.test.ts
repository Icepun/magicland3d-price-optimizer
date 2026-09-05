/**
 * HANGİ DOSYA GERÇEKTEN SİLİNEBİLİR?
 *
 * Buradaki tek hata sınıfı VERİ KAYBI: aynı fiziksel dosya birden çok satırda paylaşılıyor
 * ("tüm varyantlara uygula" aynı r2Key'i her varyanta yazıyor; aynı dosya başka bir yazıcıya
 * da eklenmiş olabilir). Kalan satırlara bakmadan silen bir kod, hâlâ kullanılan baskı
 * dosyasını buharlaştırır. Testlerin ağırlığı bu yüzden "paylaşılana DOKUNMA" tarafında.
 */
import { describe, expect, it } from "vitest";
import { silinebilirDosyalar } from "./model-file-cleanup";

const satir = (o: Partial<Parameters<typeof silinebilirDosyalar>[0][number]>) => ({
  id: "x", r2Key: null, meshR2Key: null, storedPath: "", ...o,
});

describe("referans kalmadıysa silinir", () => {
  it("tek dosya", () => {
    const r = silinebilirDosyalar([satir({ r2Key: "models/a.gcode" })], []);
    expect(r.r2).toEqual(["models/a.gcode"]);
  });

  it("kaynak model (mesh) de silinir", () => {
    const r = silinebilirDosyalar([satir({ r2Key: "models/a", meshR2Key: "meshes/a" })], []);
    expect(r.r2.sort()).toEqual(["meshes/a", "models/a"]);
  });

  it("yerel dosya", () => {
    const r = silinebilirDosyalar([satir({ storedPath: "C:/models/a.gcode" })], []);
    expect(r.yerel).toEqual(["C:/models/a.gcode"]);
  });
});

describe("PAYLAŞILAN dosyaya DOKUNULMAZ", () => {
  it("kalan satır aynı r2Key'i kullanıyorsa silinmez", () => {
    const r = silinebilirDosyalar(
      [satir({ r2Key: "models/ortak" })],
      [{ r2Key: "models/ortak", meshR2Key: null, storedPath: "" }],
    );
    expect(r.r2).toEqual([]);
  });

  it("kalan satır aynı yerel yolu kullanıyorsa silinmez", () => {
    const r = silinebilirDosyalar(
      [satir({ storedPath: "C:/m/a.gcode" })],
      [{ r2Key: null, meshR2Key: null, storedPath: "C:/m/a.gcode" }],
    );
    expect(r.yerel).toEqual([]);
  });

  it("ÇAPRAZ KOLON: silinecek r2Key'e başka satır meshR2Key olarak referans veriyorsa silinmez", () => {
    const r = silinebilirDosyalar(
      [satir({ r2Key: "meshes/paylasilan" })],
      [{ r2Key: null, meshR2Key: "meshes/paylasilan", storedPath: "" }],
    );
    expect(r.r2).toEqual([]);
  });

  it("bir dosya paylaşılırken diğeri silinebilir", () => {
    const r = silinebilirDosyalar(
      [satir({ id: "1", r2Key: "models/ortak" }), satir({ id: "2", r2Key: "models/tek" })],
      [{ r2Key: "models/ortak", meshR2Key: null, storedPath: "" }],
    );
    expect(r.r2).toEqual(["models/tek"]);
  });
});

describe("boş storedPath tuzağı", () => {
  it("R2 satırlarının ortak \"\" değeri yerel silme listesine GİRMEZ", () => {
    // "" ile dosya silmeye kalkışmak anlamsız; deleteMany ile yapılsa yıkıcı olurdu.
    const r = silinebilirDosyalar(
      [satir({ r2Key: "models/a", storedPath: "" }), satir({ r2Key: "models/b", storedPath: "" })],
      [],
    );
    expect(r.yerel).toEqual([]);
    expect(r.r2.sort()).toEqual(["models/a", "models/b"]);
  });
});

describe("kenar durumlar", () => {
  it("aynı anahtar iki satırda → tek kez silinir", () => {
    const r = silinebilirDosyalar(
      [satir({ id: "1", r2Key: "models/a" }), satir({ id: "2", r2Key: "models/a" })],
      [],
    );
    expect(r.r2).toEqual(["models/a"]);
  });

  it("hiç satır yoksa boş sonuç", () => {
    expect(silinebilirDosyalar([], [])).toEqual({ r2: [], yerel: [] });
  });

  it("anahtarsız satır (ne r2 ne yerel) hiçbir şey üretmez", () => {
    expect(silinebilirDosyalar([satir({})], [])).toEqual({ r2: [], yerel: [] });
  });
});
