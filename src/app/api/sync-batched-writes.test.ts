/**
 * SENKRON ROTALARINDA DÖNGÜ İÇİNDE YAZMA OLMAMALI — yavaşlığın en büyük tek sebebi.
 *
 * Uzak-HTTP libSQL'de her sorgu ~96 ms ve TÜM sorgular süreç genelinde SIRALI. Döngü içinde
 * `$executeRawUnsafe` çağırmak, değişen satır sayısıyla doğru orantılı bir bekleme üretiyor:
 * 100 fiyat değişimi ≈ 10 saniye, üstelik o sırada uygulamanın geri kalanı da bekliyor.
 * Kullanıcı bunu "yenileme çok uzun sürüyor / genel takılma" olarak yaşadı (17 Ağu 2026).
 *
 * Aynı ders `addNew` yollarında zaten alınmıştı (yorumda "258 kayıt ≈ 25 sn" yazıyor) ama
 * fiyat yenileme yolları atlanmıştı. Bu test o ayrımın tekrar oluşmasını engeller.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROTALAR = [
  "src/app/api/trendyol/sync-products/route.ts",
  "src/app/api/hepsiburada/sync-products/route.ts",
  "src/app/api/shopify/sync-products/route.ts",
];

interface Bulgu {
  satir: number;
  baslik: string;
  metin: string;
}

/**
 * Bir `for` bloğunun İÇİNDE `await prisma.$execute...` var mı?
 *
 * Döngü başlığı da döndürülür: batch reddedilince (embedded replica) devreye giren
 * `for (const w of writes)` kurtarma döngüsü meşrudur ve ayıklanabilmeli.
 */
function donguIcindeYazma(kaynak: string): Bulgu[] {
  const satirlar = kaynak.split("\n");
  const bulgular: Bulgu[] = [];
  let derinlik = 0;
  let donguDerinlik = -1;
  let donguBaslik = "";

  for (let i = 0; i < satirlar.length; i++) {
    const s = satirlar[i];
    if (/^\s*for \(/.test(s) && donguDerinlik < 0) {
      donguDerinlik = derinlik;
      donguBaslik = s.trim();
    }
    if (donguDerinlik >= 0 && /await prisma\.\$execute/.test(s)) {
      bulgular.push({ satir: i + 1, baslik: donguBaslik, metin: s.trim().slice(0, 70) });
    }
    derinlik += (s.match(/\{/g) ?? []).length - (s.match(/\}/g) ?? []).length;
    if (donguDerinlik >= 0 && derinlik <= donguDerinlik) donguDerinlik = -1;
  }
  return bulgular;
}

describe("senkron rotaları toplu yazıyor", () => {
  for (const yol of ROTALAR) {
    const kaynak = readFileSync(join(process.cwd(), yol), "utf8");

    it(`${yol} — döngü içinde tek tek UPDATE yok`, () => {
      const gercek = donguIcindeYazma(kaynak).filter((b) => !b.baslik.includes("of writes"));
      expect(
        gercek.map((b) => `satır ${b.satir}: ${b.metin}`),
        "döngü içinde tek tek yazma var; toplu yazmaya (batchWrite) çevrilmeli",
      ).toEqual([]);
    });

    it(`${yol} — batchWrite kullanıyor`, () => {
      expect(kaynak).toContain("batchWrite");
    });
  }
});

describe("dedektör gerçekten çalışıyor", () => {
  it("döngü içindeki yazmayı YAKALAR", () => {
    const kotu = [
      "for (const row of rows) {",
      "  await prisma.$executeRawUnsafe(SQL, row.id);",
      "}",
    ].join("\n");
    expect(donguIcindeYazma(kotu)).toHaveLength(1);
  });

  it("döngü DIŞINDAKİ yazmayı yakalamaz", () => {
    const iyi = ["for (const row of rows) {", "  writes.push(row);", "}", "await prisma.$executeRawUnsafe(SQL);"].join("\n");
    expect(donguIcindeYazma(iyi)).toHaveLength(0);
  });

  it("kurtarma döngüsünü ayırt eder", () => {
    const kurtarma = ["for (const w of writes) {", "  await prisma.$executeRawUnsafe(w.sql);", "}"].join("\n");
    const hepsi = donguIcindeYazma(kurtarma);
    expect(hepsi).toHaveLength(1);
    expect(hepsi.filter((b) => !b.baslik.includes("of writes"))).toHaveLength(0);
  });
});
