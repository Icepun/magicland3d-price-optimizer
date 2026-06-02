import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getImagesDir } from "@/lib/storage";

export const dynamic = "force-dynamic";

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Ürüne elle görsel yükle. Dosya userData/images altına kaydedilir; ürünün imageUrl'i
 * "/api/images/<dosya>" olur ve imageManual=true işaretlenir → sync (Yenile) ezmez.
 * Eski elle-yüklenmiş görsel (varsa) silinir (yetim dosya bırakma).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Dosya gerekli" }, { status: 400 });

    const ext = EXT_BY_TYPE[file.type];
    if (!ext) return NextResponse.json({ error: "Desteklenmeyen görsel türü (png/jpg/webp/gif)" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "Görsel 8 MB'tan büyük olamaz" }, { status: 400 });

    const product = await prisma.product.findUnique({ where: { id }, select: { imageUrl: true } });
    if (!product) return NextResponse.json({ error: "Ürün bulunamadı" }, { status: 404 });

    const dir = getImagesDir();
    const filename = `${crypto.randomUUID()}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(path.join(dir, filename), buf);

    // Önceki elle-yüklenmiş görseli temizle (yalnızca bizim sunduğumuz yerel dosyalar).
    const prev = product.imageUrl;
    if (prev && prev.startsWith("/api/images/")) {
      const oldName = path.basename(prev);
      try {
        fs.unlinkSync(path.join(dir, oldName));
      } catch {
        /* yoksa boşver */
      }
    }

    const imageUrl = `/api/images/${filename}`;
    await prisma.product.update({ where: { id }, data: { imageUrl, imageManual: true } });
    return NextResponse.json({ imageUrl });
  } catch (error) {
    return jsonError(error);
  }
}
