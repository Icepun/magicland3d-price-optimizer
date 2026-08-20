import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import {
  extractContentSignature,
  matchPrintedModel,
  type ModelFileCandidate,
} from "@/lib/print-file-signature";

export const dynamic = "force-dynamic";

/** Eşleştirmeye giren alanlar — ÖNİZLEME GÖRSELİ YOK. Görsel (data URL) kayıt başına yüzlerce
 *  KB; yüzlerce satırla birlikte çekilince istek saniyeler sürüyordu. Görsel yalnız EŞLEŞEN
 *  kayıt için, ikinci ve minik bir sorguyla alınır. */
const CANDIDATE_SELECT = {
  id: true, originalName: true, contentMd5: true, sizeBytes: true, r2Key: true, storedPath: true,
} as const;

type Candidate = ModelFileCandidate & { sizeBytes: number };

/**
 * Yazıcıda ŞU AN basılan işi (currentFilename) bir model kaydına eşler → kartın "canlı dolan
 * model" görselleştirmesi, dosyayı YENİDEN yüklemeye gerek kalmadan var olan modeli kullanır.
 *
 * Eşleştirme isim tahmini DEĞİL: yükleme adına gömülü içerik imzası (MD5'in ilk 10 hanesi)
 * kayıttaki içerikle doğrulanır. İmza çelişiyorsa eşleştirme reddedilir — aynı adla yeniden
 * dilimlenmiş dosyalarda kartta yanlış modelin gösterilmesini bu engeller.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const filename = req.nextUrl.searchParams.get("filename") || "";
    if (!filename.trim()) return NextResponse.json({ model: null });

    // Uzak-HTTP libSQL'de her sorgu ~96ms ve SIRALI → sorgu sayısı kadar, çekilen satır da önemli.
    // İmza varsa (bu uygulamadan başlatılan her baskıda var) doğrudan içerikten daralt:
    // tüm liste taranmaz, tek satır döner.
    const sig = extractContentSignature(filename);
    const narrow: Candidate[] = sig
      ? await prisma.productModelFile.findMany({
          where: { printerConfigId: id, contentMd5: { startsWith: sig } },
          select: CANDIDATE_SELECT,
          orderBy: { createdAt: "desc" }, // aynı dosya varyantlara kopyalanmışsa hep aynı satır dönsün
          take: 50,
        })
      : [];

    // İmza yok (eski dosya) ya da imzayı doğrulayan kayıt yok → ad eşleşmesi için liste taranır.
    let match = narrow.length ? matchPrintedModel(filename, narrow) : null;
    if (!match || (!match.hit && match.reason !== "ambiguous")) {
      const rows = await prisma.productModelFile.findMany({
        where: { printerConfigId: id },
        select: CANDIDATE_SELECT,
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      match = matchPrintedModel(filename, rows);
    }

    const hit = match.hit;
    if (!hit) return NextResponse.json({ model: null });

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
    const thumbnailVar = Number(satir?.[0]?.var_mi ?? 0) === 1;
    return NextResponse.json({
      model: {
        id: hit.id,
        contentMd5: hit.contentMd5,
        thumbnailVar,
        sizeBytes: hit.sizeBytes,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
