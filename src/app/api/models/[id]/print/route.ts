import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerUploadAndPrint } from "@/core/printers/moonraker";

/** Modeli yazıcıya yükle + baskıyı başlat (dosyanın bağlı olduğu yazıcı). */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params; // modelFileId
    const mf = await prisma.productModelFile.findUnique({ where: { id } });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });

    const printer = await prisma.printerConfig.findUnique({ where: { id: mf.printerConfigId } });
    if (!printer) return NextResponse.json({ error: "Bağlı yazıcı bulunamadı" }, { status: 404 });
    if (printer.type !== "moonraker") {
      return NextResponse.json({ error: "Bambu'da uygulamadan baskı başlatma henüz desteklenmiyor" }, { status: 400 });
    }
    if (!fs.existsSync(mf.storedPath)) {
      return NextResponse.json({ error: "Dosya bu cihazda yok (başka bir bilgisayarda yüklenmiş olabilir)" }, { status: 400 });
    }

    const buf = fs.readFileSync(mf.storedPath);
    await moonrakerUploadAndPrint(printer.host, printer.port, buf, mf.originalName);

    // Canlı panelde doğru ürün görünsün diye baskı→ürün eşleştirmesini de kaydet
    try {
      await prisma.printFileProduct.upsert({
        where: { printerConfigId_filename: { printerConfigId: printer.id, filename: mf.originalName } },
        create: { printerConfigId: printer.id, filename: mf.originalName, productId: mf.productId },
        update: { productId: mf.productId },
      });
    } catch { /* eşleştirme kaydı kritik değil */ }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
