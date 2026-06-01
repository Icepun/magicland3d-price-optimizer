import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerUploadAndPrint } from "@/core/printers/moonraker";
import { bambuUploadAndPrint, getBambuStatus, getBambuAmsSlots, mapBambuState } from "@/core/printers/bambu";
import { readModelColors, is3mfSliced } from "@/core/printers/model-colors";

export const dynamic = "force-dynamic";

/**
 * Modeli yazıcıya yükle + baskıyı başlat. Yanıt = NDJSON akışı (satır satır ilerleme):
 *   {stage:"status"} · {stage:"upload",pct} · {stage:"start"} · {stage:"confirm"} · {stage:"done"} · {stage:"error",message}
 * Doğrulama hataları (dilimlenmemiş dosya, hatalı renk eşleştirme) akış başlamadan JSON 4xx döner.
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
    const prefsRaw = body?.prefs && typeof body.prefs === "object" ? body.prefs : {};
    const prefs = { timelapse: !!prefsRaw.timelapse, bedLeveling: !!prefsRaw.bedLeveling, flowCali: !!prefsRaw.flowCali };

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

    // ── ÖN DOĞRULAMA (akış öncesi 4xx) ──────────────────────────────────────────
    // 1) Dosya dilimlenmiş mi? (STL/OBJ/ham 3MF → baskı başlatma)
    if (printer.type === "bambu" && !is3mfSliced(mf.storedPath)) {
      return NextResponse.json(
        { error: "Bu dosya dilimlenmemiş (STL/OBJ veya ham 3MF). Bambu Studio/Orca ile dilimleyip .3mf (veya .gcode) yükleyin." },
        { status: 400 }
      );
    }
    // 2) AMS renk eşleştirmesi tutarlı mı? (her renk dolu bir slota; eksik/boş slot → başlatma)
    if (printer.type === "bambu" && useAms && Array.isArray(amsMapping)) {
      const colors = readModelColors(mf.storedPath).colors;
      if (colors.length) {
        for (const c of colors) {
          const slot = amsMapping[c.index];
          if (slot == null || slot < 0) {
            return NextResponse.json({ error: "Renk eşleştirmesi eksik: her baskı rengi bir AMS slotuna atanmalı." }, { status: 400 });
          }
        }
        // Boş slot seçilmiş mi? (slot okunabiliyorsa)
        try {
          const slots = await getBambuAmsSlots(printer.host, printer.accessCode!, printer.serial!);
          if (slots.length) {
            for (const c of colors) {
              const phys = slots.find((s) => s.slot === amsMapping[c.index]);
              if (phys && phys.empty) {
                return NextResponse.json({ error: `AMS slot ${amsMapping[c.index] + 1} boş — dolu bir slot seçin.` }, { status: 400 });
              }
            }
          }
        } catch { /* slot okunamazsa boş-kontrolünü atla */ }
      }
    }

    const buf = fs.readFileSync(mf.storedPath);
    const isBambu = printer.type === "bambu";

    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: Record<string, unknown>) => {
          try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* akış kapandı */ }
        };
        let printerErrored = false;
        try {
          send({ stage: "status" }); // adaptör önce yazıcı durumunu (IDLE) kontrol eder
          send({ stage: "upload", pct: 0 });
          let matchFilename = mf.originalName.replace(/\.[^.]+$/, "");

          if (isBambu) {
            const r = await bambuUploadAndPrint(printer.host, printer.accessCode!, printer.serial!, buf, mf.originalName, {
              amsMapping, useAms, prefs,
              onProgress: (pct) => send({ stage: "upload", pct }),
            });
            matchFilename = r.matchName; // yazıcının raporlayacağı subtask_name = eşleştirme anahtarı
          } else {
            send({ stage: "upload", pct: null }); // Moonraker: belirsiz (fetch byte takibi yok)
            // Snapmaker: kafa seçimi (amsMapping) + baskı tercihleri → gcode tool remap / makro aç-kapa.
            await moonrakerUploadAndPrint(printer.host, printer.port, buf, mf.originalName, { headMapping: amsMapping, prefs });
          }

          send({ stage: "start" });
          try {
            await prisma.printFileProduct.upsert({
              where: { printerConfigId_filename: { printerConfigId: printer.id, filename: matchFilename } },
              create: { printerConfigId: printer.id, filename: matchFilename, productId: mf.productId },
              update: { productId: mf.productId },
            });
          } catch { /* eşleştirme kaydı kritik değil */ }

          // İZLE: yazıcı gerçekten baskıya geçti mi? (Bambu — komut kabul/ret doğrulaması)
          if (isBambu) {
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 1600));
              const s = await getBambuStatus(printer.host, printer.accessCode!, printer.serial!);
              if (s.printError && s.printError !== 0) {
                send({ stage: "error", message: `Yazıcı baskıyı reddetti (hata ${s.printError}). Renk eşleştirme / dosya / HMS kodunu kontrol edin.` });
                printerErrored = true; break;
              }
              const ms = mapBambuState(s.gcodeState);
              if (ms === "printing") break; // PREPARE/RUNNING/SLICING → başladı
              if (ms === "error") {
                send({ stage: "error", message: "Yazıcı baskıyı reddetti (FAILED). HMS kodunu kontrol edin." });
                printerErrored = true; break;
              }
              send({ stage: "confirm" }); // hâlâ hazırlanıyor → akışı canlı tut
            }
          }

          if (!printerErrored) send({ stage: "done" });
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
