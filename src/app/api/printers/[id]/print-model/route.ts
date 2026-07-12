import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** Yol/uzantı + içerik-hash ekini (-a1b2c3d4e5) at, küçült — yazıcının bildirdiği dosya adını
 *  model kaydının orijinal adıyla TOLERANSLI eşlemek için (eski adlar eksiz, yeniler ekli).
 *  Ek, çift uzantıda uzantıların ÖNÜNE girer (a.gcode-<md5>.3mf) → uzantı-öncesi de temizlenir. */
function norm(s: string): string {
  let x = s.replace(/^.*[/\\]/, "").toLowerCase().trim();
  // Uzantı(lar)dan hemen önceki (veya sondaki) içerik-hash ekini at.
  x = x.replace(/-[0-9a-f]{10}(?=(\.(gcode|gco|g|3mf))*$)/i, "");
  // Ardışık bilinen uzantıları at (.gcode.3mf gibi çift uzantı dahil).
  x = x.replace(/(\.(gcode|gco|g|3mf))+$/i, "");
  return x.trim();
}

/**
 * Yazıcıda ŞU AN basılan işi (currentFilename) bir model kaydına eşler → kartın "canlı dolan
 * model" görselleştirmesi, dosyayı YENİDEN yüklemeye gerek kalmadan var olan modeli kullanır.
 * İsim tahmini değil: hash eki + uzantı normalize edilip orijinal adla birebir kıyaslanır.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const filename = req.nextUrl.searchParams.get("filename") || "";
    if (!filename.trim()) return NextResponse.json({ model: null });
    const target = norm(filename);
    if (!target) return NextResponse.json({ model: null });

    const rows = await prisma.productModelFile.findMany({
      where: { printerConfigId: id },
      select: { id: true, originalName: true, contentMd5: true, thumbnail: true, sizeBytes: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const hit = rows.find((r) => norm(r.originalName) === target) ?? null;
    return NextResponse.json({
      model: hit
        ? { id: hit.id, contentMd5: hit.contentMd5, thumbnail: hit.thumbnail, sizeBytes: hit.sizeBytes }
        : null,
    });
  } catch (error) {
    return jsonError(error);
  }
}
