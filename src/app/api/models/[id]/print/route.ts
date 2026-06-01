import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerUploadAndPrint } from "@/core/printers/moonraker";
import { bambuUploadAndPrint } from "@/core/printers/bambu";

export const dynamic = "force-dynamic";

/**
 * Modeli yazıcıya yükle + baskıyı başlat. Yanıt = NDJSON akışı (satır satır ilerleme):
 *   {stage:"upload", pct:0..100|null} · {stage:"start"} · {stage:"done"} · {stage:"error", message}
 * Doğrulama hataları akış başlamadan normal JSON 4xx döner.
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
    if (printer.type === "bambu" && (!printer.accessCode || !printer.serial)) {
      return NextResponse.json({ error: "Bambu access code / seri no eksik (Yönet)" }, { status: 400 });
    }
    const buf = fs.readFileSync(mf.storedPath);

    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: Record<string, unknown>) => {
          try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* akış kapandı */ }
        };
        try {
          send({ stage: "upload", pct: 0 });
          let matchFilename = mf.originalName;

          if (printer.type === "bambu") {
            await bambuUploadAndPrint(printer.host, printer.accessCode!, printer.serial!, buf, mf.originalName, {
              amsMapping, useAms,
              onProgress: (pct) => send({ stage: "upload", pct }),
            });
            matchFilename = mf.originalName.replace(/\.[^.]+$/, ""); // Bambu subtask = uzantısız ad
          } else {
            send({ stage: "upload", pct: null }); // Moonraker: belirsiz (fetch byte takibi yok)
            await moonrakerUploadAndPrint(printer.host, printer.port, buf, mf.originalName);
          }

          send({ stage: "start" });
          try {
            await prisma.printFileProduct.upsert({
              where: { printerConfigId_filename: { printerConfigId: printer.id, filename: matchFilename } },
              create: { printerConfigId: printer.id, filename: matchFilename, productId: mf.productId },
              update: { productId: mf.productId },
            });
          } catch { /* eşleştirme kaydı kritik değil */ }

          send({ stage: "done" });
        } catch (e) {
          send({ stage: "error", message: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
    });
  } catch (error) {
    return jsonError(error);
  }
}
