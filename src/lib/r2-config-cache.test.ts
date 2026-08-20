/**
 * R2 AYAR ÖNBELLEĞİ — "başlıyor… %0" ekranında beklenen sürenin büyük kısmı buydu.
 *
 * `getR2Config()` yükleme akışında en az DÖRT kez çağrılıyor (imzalı URL, doğrulama, dosyayı
 * okuma, yazıcıya gönderme) ve her seferi uzak Turso'ya bir tur atıyordu: en iyi ihtimalle
 * ~80 ms, veritabanı takılıyken saniyeler. Dosya daha yola çıkmadan ayar sorgusu bekleniyordu.
 *
 * İKİ KIRMIZI ÇİZGİ:
 *  1) BOŞ sonuç önbelleklenmemeli — kullanıcı R2'yi ilk kez kurduğunda bir dakika boyunca
 *     "bulut kapalı" görürdü.
 *  2) Ayarlar kaydedilince önbellek DÜŞMELİ — yeni anahtarlar anında geçerli olsun.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const R2 = readFileSync(join(process.cwd(), "src/lib/r2.ts"), "utf8");
const AYARLAR = readFileSync(join(process.cwd(), "src/app/api/settings/route.ts"), "utf8");

describe("R2 ayarı önbelleklendi", () => {
  it("dolu sonuç önbelleğe yazılıyor", () => {
    expect(R2).toContain("r2Onbellek = { at: Date.now(), cfg }");
  });

  it("önbellek okunuyor (TTL ile)", () => {
    expect(R2).toMatch(/if \(r2Onbellek && Date\.now\(\) - r2Onbellek\.at < R2_TTL_MS\) return r2Onbellek\.cfg;/);
  });

  it("BOŞ sonuç önbelleklenmiyor — ilk kurulum anında geçerli olsun", () => {
    /**
     * `return null` satırı önbelleğe yazmadan ÖNCE gelmeli. Yazsaydı, R2'yi yeni kuran
     * kullanıcı bir dakika boyunca yükleme yapamazdı.
     */
    const nullDonus = R2.indexOf("if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;");
    const yazma = R2.indexOf("r2Onbellek = { at: Date.now(), cfg }");
    expect(nullDonus).toBeGreaterThan(0);
    expect(yazma).toBeGreaterThan(nullDonus);
  });
});

describe("S3 istemcisi yeniden kullanılıyor", () => {
  it("aynı ayar için istemci yeniden kurulmuyor", () => {
    expect(R2).toContain("if (s3Onbellek && s3Onbellek.anahtar === anahtar) return s3Onbellek.istemci;");
  });

  it("anahtar ayarlardan türetiliyor — ayar değişince istemci de değişir", () => {
    expect(R2).toMatch(/const anahtar = `\$\{cfg\.accountId\}\|\$\{cfg\.bucket\}\|\$\{cfg\.accessKeyId\}`/);
  });
});

describe("ayar kaydedilince önbellek düşüyor", () => {
  it("settings rotası invalidateR2Config çağırıyor", () => {
    expect(AYARLAR).toContain("invalidateR2Config()");
  });

  it("invalidate hem ayarı hem istemciyi düşürüyor", () => {
    const govde = R2.slice(R2.indexOf("export function invalidateR2Config"), R2.indexOf("export async function getR2Config"));
    expect(govde).toContain("r2Onbellek = null");
    expect(govde).toContain("s3Onbellek = null");
  });
});
