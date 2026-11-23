import { prisma } from "@/lib/prisma";
import { batchWrite } from "@/lib/libsql-batch";

/**
 * MODEL DOSYASI ÖNİZLEME GÖRSELİ — tek okuma/yazma kapısı.
 *
 * Görsel (dilimleyicinin gömdüğü data URL, toplam ~24 MB) `ProductModelFileThumb` tablosunda,
 * `ProductModelFile`'da DEĞİL (v63). Sebep, 23 Kas 2026 ölçümü: görsel model dosyası satırını
 * büyütünce SQLite satırın yalnız küçük bir kısmını ana sayfada tutuyor, renkler / içerik imzası
 * gibi kolonlar taşma sayfalarına düşüyordu. Sunucu soğukken "Baskı Başlat" listesi 52,9 sn
 * sürüp zaman aşımına uğruyordu (aynı sorgu ısınınca 0,3 sn). Görsel görsele komşu kalınca
 * model dosyası satırları küçük kalır ve her sorgu soğukken de hızlıdır.
 *
 * Kurallar:
 * - "Görsel var mı" yalnız `fileId` okur → birincil anahtar dizininden gelir, görselin kendisine
 *   dokunmaz. Görseli yalnız gösterecek uç (`/api/models/<id>/preview`) okur.
 * - Eski `ProductModelFile.thumbnail` kolonu eski sürüm cihazlar için duruyor. Oraya düşen görseli
 *   `gorselleriTasi()` açılış bakımında buraya taşır ve kolonu boşaltır.
 */

const TABLO = `"ProductModelFileThumb"`;
/** SQLite değişken sınırının çok altında; uzun IN listeleri dilimlenir. */
const DILIM = 400;

/** Yalnız saklamaya değer görsel: boş/geçersiz değer yazılmaz. */
function gecerli(thumbnail: string | null | undefined): thumbnail is string {
  return typeof thumbnail === "string" && thumbnail.length > 0;
}

/** Görseli kaydeder (varsa üstüne yazar). Boş değer hiçbir şey yapmaz. */
export async function gorselKaydet(fileId: string, thumbnail: string | null | undefined): Promise<void> {
  if (!fileId || !gecerli(thumbnail)) return;
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TABLO} ("fileId", "thumbnail") VALUES (?, ?)
       ON CONFLICT ("fileId") DO UPDATE SET "thumbnail" = excluded."thumbnail"`,
    fileId,
    thumbnail,
  );
}

/** Görselin kendisi — yalnız gösteren uç kullanır. Yoksa null. */
export async function gorselOku(fileId: string): Promise<string | null> {
  if (!fileId) return null;
  const satir = await prisma.$queryRawUnsafe<Array<{ thumbnail: string | null }>>(
    `SELECT "thumbnail" FROM ${TABLO} WHERE "fileId" = ? LIMIT 1`,
    fileId,
  );
  if (gecerli(satir[0]?.thumbnail)) return satir[0]!.thumbnail;
  // Taşıma henüz koşmadıysa (güncellemeden sonraki ilk dakika) ya da eski sürüm bir cihaz yeni
  // yazdıysa görsel hâlâ eski kolonda olabilir. Tek satır okunur; liste sorgularında YAPILMAZ.
  const eski = await prisma.$queryRawUnsafe<Array<{ thumbnail: string | null }>>(
    `SELECT "thumbnail" FROM "ProductModelFile" WHERE "id" = ? AND typeof("thumbnail") = 'text' LIMIT 1`,
    fileId,
  );
  return gecerli(eski[0]?.thumbnail) ? eski[0]!.thumbnail : null;
}

/** Bu dosyanın görseli var mı (görseli okumadan). */
export async function gorselVarMi(fileId: string): Promise<boolean> {
  return (await gorselliKimlikler([fileId])).has(fileId);
}

/**
 * Verilen dosyalardan görseli OLANLARIN kimlikleri. `fileIds` verilmezse tablodaki tüm kimlikler.
 * Yalnız `fileId` okunur (PK dizini) — görsel baytı taşınmaz.
 */
export async function gorselliKimlikler(fileIds?: readonly string[]): Promise<Set<string>> {
  if (!fileIds) {
    const hepsi = await prisma.$queryRawUnsafe<Array<{ fileId: string }>>(`SELECT "fileId" FROM ${TABLO}`);
    return new Set(hepsi.map((r) => r.fileId));
  }
  const tekil = [...new Set(fileIds.filter(Boolean))];
  const sonuc = new Set<string>();
  for (let i = 0; i < tekil.length; i += DILIM) {
    const dilim = tekil.slice(i, i + DILIM);
    const satirlar = await prisma.$queryRawUnsafe<Array<{ fileId: string }>>(
      `SELECT "fileId" FROM ${TABLO} WHERE "fileId" IN (${dilim.map(() => "?").join(",")})`,
      ...dilim,
    );
    for (const r of satirlar) sonuc.add(r.fileId);
  }
  return sonuc;
}

/** Silinen dosyaların görselleri (çağıran unutursa açılış bakımı da temizler). */
export async function gorselleriSil(fileIds: readonly string[]): Promise<void> {
  const tekil = [...new Set(fileIds.filter(Boolean))];
  for (let i = 0; i < tekil.length; i += DILIM) {
    const dilim = tekil.slice(i, i + DILIM);
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${TABLO} WHERE "fileId" IN (${dilim.map(() => "?").join(",")})`,
      ...dilim,
    );
  }
}

/**
 * Eski kolondan yeni tabloya taşıma + yetim temizliği — TEK işlem (ya hepsi ya hiçbiri).
 * Eski kolonda değer varsa o daha YENİDİR (eski sürüm bir cihaz yazmıştır) → üstüne yazar.
 * `typeof()` görselin içeriğini OKUMAZ; taşınacak satır yoksa yalnız bu hafif sayım koşar.
 */
export const TASIMA_IFADELERI: readonly string[] = [
  `INSERT INTO ${TABLO} ("fileId", "thumbnail")
     SELECT "id", "thumbnail" FROM "ProductModelFile"
      WHERE typeof("thumbnail") = 'text' AND length("thumbnail") > 0
     ON CONFLICT ("fileId") DO UPDATE SET "thumbnail" = excluded."thumbnail"`,
  `UPDATE "ProductModelFile" SET "thumbnail" = NULL WHERE typeof("thumbnail") = 'text'`,
  `DELETE FROM ${TABLO} WHERE "fileId" NOT IN (SELECT "id" FROM "ProductModelFile")`,
];

export type TasimaSonucu = { tasinan: number; yontem: "yok" | "toplu" | "islem" };

export async function gorselleriTasi(): Promise<TasimaSonucu> {
  const sayim = await prisma.$queryRawUnsafe<Array<{ n: number | bigint }>>(
    `SELECT COUNT(*) AS n FROM "ProductModelFile" WHERE typeof("thumbnail") = 'text'`,
  );
  const tasinacak = Number(sayim[0]?.n ?? 0);
  if (tasinacak === 0) {
    // Yine de yetimleri temizle — ucuz (yalnız kimlikler karşılaştırılır).
    await prisma.$executeRawUnsafe(TASIMA_IFADELERI[2]!);
    return { tasinan: 0, yontem: "yok" };
  }
  // Uzak veritabanında tek istek (onlarca MB sunucuda taşınır, ağdan geçmez; 6 sn'lik okuma
  // tavanına takılmaz). Yerel/gömülü modda Prisma işlemi.
  if (await batchWrite(TASIMA_IFADELERI.map((sql) => ({ sql })))) return { tasinan: tasinacak, yontem: "toplu" };
  await prisma.$transaction(TASIMA_IFADELERI.map((sql) => prisma.$executeRawUnsafe(sql)));
  return { tasinan: tasinacak, yontem: "islem" };
}
