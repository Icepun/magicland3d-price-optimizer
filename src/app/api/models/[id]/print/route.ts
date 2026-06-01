import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerUploadAndPrint } from "@/core/printers/moonraker";
import { bambuUploadAndPrint } from "@/core/printers/bambu";

/**
 * Modeli yazıcıya yükle + baskıyı başlat.
 *  - Moonraker (Elegoo/Snapmaker): dosyayı yükle + başlat (renk gcode'da gömülü).
 *  - Bambu: SD'ye FTP yükle + project_file/gcode_file MQTT; body'de amsMapping/useAms (çok renkli).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params; // modelFileId
    const body = await req.json().catch(() => ({}));
    const amsMapping: number[] | undefined = Array.isArray(body?.amsMapping)
      ? body.amsMapping.map((n: unknown) => Number(n))
      : undefined;
    const useAms: boolean | undefined = typeof body?.useAms === "boolean" ? body.useAms : undefined;

    const mf = await prisma.productModelFile.findUnique({ where: { id } });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });

    const printer = await prisma.printerConfig.findUnique({ where: { id: mf.printerConfigId } });
    if (!printer) return NextResponse.json({ error: "Bağlı yazıcı bulunamadı" }, { status: 404 });
    if (!fs.existsSync(mf.storedPath)) {
      return NextResponse.json({ error: "Dosya bu cihazda yok (başka bilgisayarda yüklenmiş olabilir)" }, { status: 400 });
    }
    const buf = fs.readFileSync(mf.storedPath);

    // Canlı panelde doğru ürün görünsün diye eşleştirme adı (Bambu subtask = uzantısız ad)
    let matchFilename = mf.originalName;

    if (printer.type === "bambu") {
      if (!printer.accessCode || !printer.serial) {
        return NextResponse.json({ error: "Bambu access code / seri no eksik (Yönet)" }, { status: 400 });
      }
      await bambuUploadAndPrint(printer.host, printer.accessCode, printer.serial, buf, mf.originalName, { amsMapping, useAms });
      matchFilename = mf.originalName.replace(/\.[^.]+$/, "");
    } else {
      await moonrakerUploadAndPrint(printer.host, printer.port, buf, mf.originalName);
    }

    try {
      await prisma.printFileProduct.upsert({
        where: { printerConfigId_filename: { printerConfigId: printer.id, filename: matchFilename } },
        create: { printerConfigId: printer.id, filename: matchFilename, productId: mf.productId },
        update: { productId: mf.productId },
      });
    } catch { /* eşleştirme kaydı kritik değil */ }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
