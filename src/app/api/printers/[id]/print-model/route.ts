import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const TR: Record<string, string> = { "ç": "c", "Ç": "c", "ğ": "g", "Ğ": "g", "ı": "i", "İ": "i", "ö": "o", "Ö": "o", "ş": "s", "Ş": "s", "ü": "u", "Ü": "u" };

/** Yazıcının bildirdiği dosya adını model kaydının orijinal adıyla TOLERANSLI eşle. Kritik:
 *  Bambu, adı safeRemoteName ile ASCII'ye çevirip boşluk/tireyi _ yapıyor (Standı — Siyah →
 *  Standi_Siyah) → eski norm (yalnız küçültme) "standı"≠"standi" yüzünden Bambu'yu HİÇ eşleyemiyordu
 *  (3D görünmüyordu). Çözüm: iki tarafı da Türkçe→ASCII çevir + harf/rakam DIŞINDA her şeyi (boşluk/
 *  _/tire/uzantı-öncesi) sil. Önce yol/hash-eki/uzantı/plate atılır (yapısal), sonra sadeleştirilir. */
function norm(s: string): string {
  let x = s.replace(/^.*[/\\]/, "");                              // yol
  x = x.replace(/-[0-9a-f]{10}(?=(\.(gcode|gco|g|3mf))*$)/i, ""); // içerik-hash eki
  x = x.replace(/(\.(gcode|gco|g|3mf))+$/i, "");                  // uzantı(lar) (.gcode.3mf dahil)
  x = x.replace(/_plate_\d+$/i, "");                             // dilimleyici plate eki
  x = x.replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR[c] ?? c);           // Türkçe → ASCII (Bambu gibi)
  return x.toLowerCase().replace(/[^a-z0-9]+/g, "");             // harf/rakam dışı her şeyi sil
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
