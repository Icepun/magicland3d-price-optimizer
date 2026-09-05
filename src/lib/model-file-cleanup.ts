/**
 * MODEL DOSYASI SİLME — tek güvenli yol.
 *
 * Aynı fiziksel dosya BİRDEN ÇOK satırda paylaşılabiliyor: "tüm varyantlara uygula" aynı
 * `r2Key`'i her varyanta yazıyor, aynı dosya başka bir yazıcıya da eklenmiş olabilir. Bu
 * yüzden satırları silmek yeterli değil — nesneyi silmeden önce GERİYE KALAN satırların
 * hâlâ referans verip vermediğine bakmak zorunludur. Bakılmazsa hâlâ kullanılan bir baskı
 * dosyası buharlaşır.
 *
 * İkinci tuzak: R2'ye yüklenen satırlarda `storedPath` boş dizgi ("") — ortak değer. Onunla
 * dosya silmeye kalkışmak anlamsız (ve `deleteMany` ile yapılırsa yıkıcı), o yüzden boş yol
 * her zaman elenir.
 */
import fs from "node:fs";
import { prisma } from "./prisma";
import { getR2Config, deleteObject } from "./r2";

export interface ModelSatiri {
  id: string;
  r2Key: string | null;
  meshR2Key?: string | null;
  storedPath: string;
}

type Referans = Pick<ModelSatiri, "r2Key" | "meshR2Key" | "storedPath">;

/**
 * Silinen satırların dosyalarından hangileri GERÇEKTEN silinebilir?
 * `kalan` = veritabanında duran diğer satırlar. Onlardan biri referans veriyorsa dosya kalır.
 */
export function silinebilirDosyalar(
  silinen: readonly ModelSatiri[],
  kalan: readonly Referans[],
): { r2: string[]; yerel: string[] } {
  const kalanR2 = new Set<string>();
  const kalanYerel = new Set<string>();
  for (const k of kalan) {
    if (k.r2Key) kalanR2.add(k.r2Key);
    if (k.meshR2Key) kalanR2.add(k.meshR2Key);
    if (k.storedPath) kalanYerel.add(k.storedPath);
  }
  const r2 = new Set<string>();
  const yerel = new Set<string>();
  for (const s of silinen) {
    if (s.r2Key && !kalanR2.has(s.r2Key)) r2.add(s.r2Key);
    if (s.meshR2Key && !kalanR2.has(s.meshR2Key)) r2.add(s.meshR2Key);
    if (s.storedPath && !kalanYerel.has(s.storedPath)) yerel.add(s.storedPath);
  }
  return { r2: [...r2], yerel: [...yerel] };
}

/**
 * Satırları sil, ardından artık kimsenin kullanmadığı dosyaları temizle.
 * R2 silme başarısız olursa hata verilmez — depo hademesi 24 saat sonra süpürür.
 */
export async function modelSatirlariniSil(
  satirlar: readonly ModelSatiri[],
): Promise<{ satir: number; dosya: number }> {
  if (satirlar.length === 0) return { satir: 0, dosya: 0 };

  const idler = satirlar.map((r) => r.id);
  // Tek deleteMany — dosya başına ayrı yazma yüzlerce dosyada dakikalar sürüyordu.
  await prisma.productModelFile.deleteMany({ where: { id: { in: idler } } });

  const anahtarlar = [
    ...new Set(satirlar.flatMap((r) => [r.r2Key, r.meshR2Key]).filter((k): k is string => !!k)),
  ];
  const yollar = [...new Set(satirlar.map((r) => r.storedPath).filter((p) => !!p))];

  const kalan = anahtarlar.length || yollar.length
    ? await prisma.productModelFile.findMany({
        where: {
          OR: [
            ...(anahtarlar.length ? [{ r2Key: { in: anahtarlar } }, { meshR2Key: { in: anahtarlar } }] : []),
            ...(yollar.length ? [{ storedPath: { in: yollar } }] : []),
          ],
        },
        select: { r2Key: true, meshR2Key: true, storedPath: true },
      })
    : [];

  const { r2, yerel } = silinebilirDosyalar(satirlar, kalan);

  if (r2.length) {
    const cfg = await getR2Config();
    if (cfg) {
      // Sınırlı paralel (5) — yüzlerce nesneyi tek tek beklemeden, R2'yi de boğmadan.
      let i = 0;
      await Promise.all(
        Array.from({ length: Math.min(5, r2.length) }, async () => {
          while (i < r2.length) {
            const key = r2[i++];
            await deleteObject(key, cfg).catch(() => { /* hademe süpürür */ });
          }
        })
      );
    }
  }
  for (const p of yerel) {
    try { fs.unlinkSync(p); } catch { /* yoksa boşver */ }
  }

  return { satir: satirlar.length, dosya: r2.length + yerel.length };
}

/** Bir yazıcıya ait tüm model dosyalarını sil. */
export async function yaziciModelDosyalariniSil(printerConfigId: string) {
  const satirlar = await prisma.productModelFile.findMany({
    where: { printerConfigId },
    select: { id: true, r2Key: true, meshR2Key: true, storedPath: true },
  });
  return modelSatirlariniSil(satirlar);
}
