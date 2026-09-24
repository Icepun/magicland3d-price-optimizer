import { prisma } from "@/lib/prisma";
import {
  extractContentSignature,
  matchPrintedModel,
  type ModelFileCandidate,
} from "@/lib/print-file-signature";
import { familyMemberIds } from "@/core/printers/printer-family";

/**
 * Yazıcıda ŞU AN basılan işi (currentFilename) bir model kaydına eşler.
 *
 * İki tüketici: masaüstü kartının canlı 3B'si (`/api/printers/[id]/print-model`) ve telefona 3B
 * paketi taşıyan aktarıcı (`core/printers/viz-relay.ts`). Tek fonksiyon — telefon ile masaüstü
 * aynı baskıya farklı model eşlemesin.
 *
 * Eşleştirme isim tahmini DEĞİL: yükleme adına gömülü içerik imzası (MD5'in ilk 10 hanesi)
 * kayıttaki içerikle doğrulanır. İmza çelişiyorsa eşleştirme reddedilir — aynı adla yeniden
 * dilimlenmiş dosyalarda yanlış modelin gösterilmesini bu engeller.
 */

/** Eşleştirmeye giren alanlar — ÖNİZLEME GÖRSELİ YOK. Görsel (data URL) kayıt başına yüzlerce
 *  KB; yüzlerce satırla birlikte çekilince istek saniyeler sürüyordu. Görsel yalnız EŞLEŞEN
 *  kayıt için, ikinci ve minik bir sorguyla alınır. */
const CANDIDATE_SELECT = {
  id: true, originalName: true, contentMd5: true, sizeBytes: true, r2Key: true, storedPath: true,
} as const;

type Candidate = ModelFileCandidate & { sizeBytes: number };

export interface PrintModelInfo {
  id: string;
  contentMd5: string | null;
  /** Dosyanın dilimleyici önizlemesi kayıtlı mı (görselin kendisi taşınmaz). */
  thumbnailVar: boolean;
  sizeBytes: number;
}

export async function resolvePrintModel(printerId: string, filename: string): Promise<PrintModelInfo | null> {
  if (!filename.trim()) return null;

  // Uzak-HTTP libSQL'de her sorgu ~96ms ve SIRALI → sorgu sayısı kadar, çekilen satır da önemli.
  // İmza varsa (bu uygulamadan başlatılan her baskıda var) doğrudan içerikten daralt:
  // tüm liste taranmaz, tek satır döner.
  // AİLE: U1 Üst, U1 Alt için yüklenmiş dosyayı basıyor olabilir (aynı marka + model dosyaları
  // ortak — bkz. core/printers/printer-family). Arama kardeş yazıcıların dosyalarını da kapsar.
  const aile = familyMemberIds(
    await prisma.printerConfig.findMany({ select: { id: true, type: true, brand: true, model: true } }),
    printerId,
  );
  const sig = extractContentSignature(filename);
  const narrow: Candidate[] = sig
    ? await prisma.productModelFile.findMany({
        where: { printerConfigId: { in: aile }, contentMd5: { startsWith: sig } },
        select: CANDIDATE_SELECT,
        orderBy: { createdAt: "desc" }, // aynı dosya varyantlara kopyalanmışsa hep aynı satır dönsün
        take: 50,
      })
    : [];

  // İmza yok (eski dosya) ya da imzayı doğrulayan kayıt yok → ad eşleşmesi için liste taranır.
  let match = narrow.length ? matchPrintedModel(filename, narrow) : null;
  if (!match || (!match.hit && match.reason !== "ambiguous")) {
    const rows = await prisma.productModelFile.findMany({
      where: { printerConfigId: { in: aile } },
      select: CANDIDATE_SELECT,
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    match = matchPrintedModel(filename, rows);
  }

  const hit = match.hit;
  if (!hit) return null;

  /**
   * ÖNİZLEME GÖRSELİNİN KENDİSİ TAŞINMIYOR — yalnız var olup olmadığı.
   *
   * Ölçüldü (20 Ağu 2026): dört kartın bu uçtan çektiği toplam 374.523 bayt (en büyüğü
   * 285.111 B) ve bu, panel açık kaldıkça React Query önbelleğinde duruyordu. Görselin
   * kendisi zaten `/api/models/<id>/preview` ucundan bir yıllık `immutable` önbellekle
   * servis ediliyor — tarayıcı ikinci kez hiç istemiyor.
   *
   * ⚠️ `select: { thumbnail: true }` YETMEZ: o da 285 KB'ı Turso'dan çeker (ve her sorgu
   * tek mutex'te sıralı). Bu yüzden ham SQL ile yalnız boolean okunuyor.
   */
  const satir = await prisma.$queryRaw<{ var_mi: number }[]>`
    SELECT (thumbnail IS NOT NULL AND thumbnail != '') AS var_mi
    FROM ProductModelFile WHERE id = ${hit.id} LIMIT 1
  `;
  return {
    id: hit.id,
    contentMd5: hit.contentMd5,
    thumbnailVar: Number(satir?.[0]?.var_mi ?? 0) === 1,
    sizeBytes: hit.sizeBytes,
  };
}
