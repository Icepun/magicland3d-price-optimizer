/**
 * KARIŞIK TARİH BİÇİMİNİ ÜRETEN KAYNAKLARIN KAPISI.
 *
 * NEDEN VAR: açılış göçü (v41) tarih kolonlarını tek kanonik biçime çekiyor. Ama biçimi
 * ÜRETEN yollar açık kaldığı sürece onarımın kazancı DAKİKALAR içinde eriyor — ve fast-path
 * TAM EŞİTLİK aradığı için bir sonraki onarım ancak şema sürümü artınca koşuyor.
 *
 * İki üretici vardı:
 *  • `CURRENT_TIMESTAMP` ile yazan senkron rotaları → "2026-08-13 07:00:00" (boşluklu)
 *  • `createdAt` kolonunu hiç yazmayan Notification INSERT'leri → SQLite DEFAULT devreye
 *    giriyor, aynı boşluklu biçim yazılıyor.
 *
 * Metin sıralamasında boşluk (0x20) 'T'den (0x54) küçük olduğu için bu satırlar ISO biçimli
 * satırların ALTINA düşer: zil listesi 100 satırla sınırlı olduğundan yazıcı bildirimi
 * kullanıcıya HİÇ görünmeyebiliyordu.
 *
 * Bu test kaynak metnini tarar: `tsc` de `eslint` de dize içindeki SQL'i göremez.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
/** Telefon aynı veritabanına yazıyor: aynı kural onun için de geçerli. */
const MOBILE_ROOT = path.resolve(__dirname, "../../mobile/src");

function tsDosyalari(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      out.push(...tsDosyalari(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue; // testler kendi verisini kurar
    out.push(full);
  }
  return out;
}

const KAYNAKLAR = tsDosyalari(ROOT);
const MOBIL_KAYNAKLAR = fs.existsSync(MOBILE_ROOT) ? tsDosyalari(MOBILE_ROOT) : [];
const REPO = path.resolve(ROOT, "..");

describe("tarih yazan yollar kanonik biçim kullanır", () => {
  it("istek yolundaki hiçbir SQL CURRENT_TIMESTAMP ile tarih yazmaz (DDL varsayılanı hariç)", () => {
    const suclular: string[] = [];
    for (const file of KAYNAKLAR) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        // Açıklama metinleri (neden böyle yapıldığını anlatan yorumlar) sayılmaz.
        const kod = line.replace(/\/\/.*$/, "");
        if (/^\s*(\*|\/\*)/.test(line)) return;
        if (!kod.includes("CURRENT_TIMESTAMP")) return;
        // Tablo TANIMINDAKİ varsayılan serbest: satırı yazan yol açıkça damga verdiğinde
        // varsayılan zaten devreye girmez, girdiğinde de göç onu onarır.
        if (/DEFAULT\s+CURRENT_TIMESTAMP/.test(kod)) return;
        suclular.push(`${path.relative(ROOT, file)}:${index + 1}`);
      });
    }
    expect(suclular).toEqual([]);
  });

  /**
   * `DEFAULT CURRENT_TIMESTAMP` taşıyan tablolara yazan her INSERT tarih kolonunu AÇIKÇA
   * vermelidir; vermezse SQLite varsayılanı devreye girer ve boşluklu biçim geri gelir.
   *
   * ⚠️ TELEFON DE TARANIR: masaüstündeki aynı hata kapatılmışken mobil kopya (PushToken)
   * açık kalmıştı ve yalnız `src/` tarandığı için test sonsuza dek yeşil kalıyordu.
   */
  it("Notification ve PushToken INSERT'leri createdAt kolonunu AÇIKÇA yazar", () => {
    const suclular: string[] = [];
    for (const file of [...KAYNAKLAR, ...MOBIL_KAYNAKLAR]) {
      const text = fs.readFileSync(file, "utf8");
      const regex = /INSERT[^`'"]*INTO\s+"?(Notification|PushToken)"?\s*\(([^)]*)\)/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        if (!match[2].includes("createdAt")) {
          suclular.push(`${path.relative(REPO, file)} → ${match[0].slice(0, 80)}`);
        }
      }
    }
    expect(suclular).toEqual([]);
  });

  /**
   * ÜÇÜNCÜ ÜRETİCİ: ham SQL'e `Date.now()` bağlamak.
   *
   * ÖLÇÜLDÜ: CSV içe aktarma `const now = Date.now()` değerini `Product.createdAt`,
   * `Product.updatedAt` ve `ProductCost.updatedAt` kolonlarına bağlıyordu. Uzak Turso'da
   * Prisma aynı kolona ISO METİN yazdığı için kolon karışık biçime düşüyor, SQLite'ta
   * TAMSAYI her zaman METİN'den küçük sayıldığı için yeni içe aktarılan ürünlerin TAMAMI
   * "en son güncellenen" sıralamasının EN DİBİNE düşüyordu. Doğrusu `toDbDate(new Date())`.
   *
   * Yukarıdaki iki tarama bunu göremiyordu: ne `CURRENT_TIMESTAMP` geçiyor ne de kolon
   * eksik — değerin KENDİSİ yanlış biçimdeydi.
   */
  it("ham SQL tarih kolonuna Date.now() bağlanmaz (toDbDate kullanılır)", () => {
    const damgaDegiskeni = /const\s+\w*(now|Now|simdi|damga)\w*\s*=\s*Date\.now\(\)/;
    const tarihliSql =
      /(INSERT\s+INTO|UPDATE)\s+["`']?\w+[\s\S]{0,400}?(createdAt|updatedAt|syncedAt|orderedAt|paidAt)/i;
    const suclular: string[] = [];
    for (const file of [...KAYNAKLAR, ...MOBIL_KAYNAKLAR]) {
      const text = fs.readFileSync(file, "utf8");
      if (!damgaDegiskeni.test(text)) continue;
      if (!tarihliSql.test(text)) continue;
      suclular.push(path.relative(REPO, file));
    }
    expect(suclular).toEqual([]);
  });
});
