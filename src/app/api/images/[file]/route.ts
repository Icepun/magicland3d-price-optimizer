import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getImagesDir } from "@/lib/storage";

export const dynamic = "force-dynamic";

const CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Kullanıcının yüklediği ürün görselini sun. Yalnızca images klasöründeki dosyalar
 * (path-traversal'a karşı basename + klasör-içi doğrulaması). Yerel dosya → bu cihazda
 * yoksa 404 (görsel başka bilgisayarda yüklenmiş olabilir).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const safe = path.basename(file); // ".." vb. ele
  const ext = (safe.split(".").pop() || "").toLowerCase();
  if (!CONTENT_TYPE[ext]) return NextResponse.json({ error: "Desteklenmeyen tür" }, { status: 400 });

  const dir = getImagesDir();
  const full = path.join(dir, safe);
  // Çözümlenen yol gerçekten images klasörünün içinde mi?
  if (!full.startsWith(dir) || !fs.existsSync(full)) {
    return NextResponse.json({ error: "Görsel bulunamadı" }, { status: 404 });
  }

  const buf = fs.readFileSync(full);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": CONTENT_TYPE[ext],
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
