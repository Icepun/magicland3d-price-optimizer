/**
 * KAYNAK MODEL DEPOLAMASI — veri kaybına giden yolların kalıcı koruması.
 *
 * İki ölümcül tuzak var ve ikisi de sessiz:
 *  1) `storage-janitor` R2'de referanssız nesneleri SİLİYOR. Mesh dosyaları baskı dosyalarıyla
 *     aynı önekte tutulsaydı, farklı bir kolondan referans verildikleri için sahipsiz sanılıp
 *     silinirlerdi — hata da vermeden.
 *  2) Aynı mesh birden çok varyant satırında paylaşılabiliyor; değiştirirken/silerken referans
 *     saymadan `deleteObject` çağırmak diğer varyantların modelini yok eder.
 *
 * Bu dosya birinciyi anahtar biçiminden, ikinciyi kaynak düzeyinden kilitler.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isValidMeshKey, makeMeshKey } from "../r2";

const OKU = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("kaynak model anahtarı", () => {
  it("baskı dosyalarından AYRI önekte üretilir", () => {
    const k = makeMeshKey("Zombi_Eli.stl");
    expect(k.startsWith("meshes/")).toBe(true);
    expect(k.startsWith("models/")).toBe(false);
  });

  it("uzantıyı korur", () => {
    expect(makeMeshKey("a.stl").endsWith(".stl")).toBe(true);
    expect(makeMeshKey("a.3mf").endsWith(".3mf")).toBe(true);
    expect(makeMeshKey("a.OBJ").endsWith(".obj")).toBe(true);
  });

  it("kendi ürettiğini geçerli sayar", () => {
    expect(isValidMeshKey(makeMeshKey("x.stl"))).toBe(true);
  });

  it("BASKI dosyası anahtarını KABUL ETMEZ", () => {
    // Karışırsa süpürücü yanlış öneki yanlış kolonla tarar → veri silinir.
    expect(isValidMeshKey("models/11111111-2222-3333-4444-555555555555.gcode")).toBe(false);
  });

  it("uydurma/yol geçişli anahtarı reddeder", () => {
    expect(isValidMeshKey("meshes/../models/x.stl")).toBe(false);
    expect(isValidMeshKey("meshes/elle-yazilmis.stl")).toBe(false);
    expect(isValidMeshKey("")).toBe(false);
  });
});

describe("süpürücü iki öneki AYRI kolonlarla tarıyor", () => {
  const kaynak = OKU("src/lib/storage-janitor.ts");

  it("mesh öneki kendi kolonuyla eşleşiyor", () => {
    expect(kaynak).toMatch(/supur\("meshes\/",\s*new Set\(rows\.map\(\(r\) => r\.meshR2Key\)/);
  });

  it("baskı öneki kendi kolonuyla eşleşiyor", () => {
    expect(kaynak).toMatch(/supur\("models\/",\s*new Set\(rows\.map\(\(r\) => r\.r2Key\)/);
  });

  it("her iki kolon da sorgudan çekiliyor", () => {
    expect(kaynak).toContain("meshR2Key: true");
    expect(kaynak).toContain("r2Key: true");
  });
});

describe("silmeden önce referans sayılıyor", () => {
  it("mesh ucu paylaşılan dosyayı silmiyor", () => {
    const kaynak = OKU("src/app/api/models/[id]/mesh/route.ts");
    expect(kaynak).toContain("silKullanilmiyorsa");
    // Sayım gerçekten yapılıyor mu?
    expect(kaynak).toMatch(/count\(\{ where: \{ meshR2Key: key \} \}\)/);
    // Koşulsuz silme kalmamalı.
    expect(kaynak).not.toMatch(/deleteObject\(mevcut\.meshR2Key/);
  });

  it("parça silme yolu mesh'i de temizliyor ve orada da sayıyor", () => {
    const kaynak = OKU("src/app/api/models/[id]/route.ts");
    expect(kaynak).toContain("meshR2Key");
    expect(kaynak).toMatch(/count\(\{ where: \{ meshR2Key: mf\.meshR2Key \} \}\)/);
  });
});

describe("yükleme izinleri", () => {
  const kaynak = OKU("src/app/api/storage/presign/route.ts");

  it("mesh ve baskı uzantıları AYRI listelerde", () => {
    expect(kaynak).toContain('ALLOWED_MESH = ["stl", "obj", "3mf"]');
    // Baskı listesine .stl sızmamalı — yoksa stl baskı dosyası olarak kabul edilir.
    expect(kaynak).toMatch(/const ALLOWED = \["gcode", "gco", "g", "3mf"\]/);
  });

  it("mesh isteği ayrı anahtar üreticisine gidiyor", () => {
    expect(kaynak).toContain("makeMeshKey");
    expect(kaynak).toMatch(/mesh \? makeMeshKey\(name\) : makeModelKey\(name\)/);
  });
});
