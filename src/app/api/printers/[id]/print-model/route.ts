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

    // Önizleme görseli SADECE eşleşen kayıt için.
    const preview = await prisma.productModelFile.findUnique({
      where: { id: hit.id },
      select: { thumbnail: true },
    });
    return NextResponse.json({
      model: {
        id: hit.id,
        contentMd5: hit.contentMd5,
        thumbnail: preview?.thumbnail ?? null,
        sizeBytes: hit.sizeBytes,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
