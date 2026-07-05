import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getR2Config, getObjectBytes } from "@/lib/r2";
import { moonrakerUploadAndPrint } from "@/core/printers/moonraker";
import { bambuUploadAndPrint, getBambuStatus, getBambuAmsSlots, mapBambuState } from "@/core/printers/bambu";
import { readModelColors, is3mfSliced, readBambuPrintMeta } from "@/core/printers/model-colors";
import { tryAcquirePrintLock, releasePrintLock } from "@/core/printers/print-lock";

export const dynamic = "force-dynamic";

/**
 * Modeli yazıcıya yükle + baskıyı başlat. Yanıt = NDJSON akışı (satır satır ilerleme):
 *   {stage:"status"} · {stage:"upload",pct} · {stage:"start"} · {stage:"confirm"} · {stage:"done"} · {stage:"error",message}
 * Doğrulama hataları (dilimlenmemiş dosya, hatalı renk eşleştirme) akış başlamadan JSON 4xx döner.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // R2 dosyası için yazılan geçici dosya — TÜM çıkış yollarında (erken 4xx, hata, akış sonu)
  // silinmeli. Eski hali yalnız akış finally'sinde siliyordu → doğrulama 4xx'lerinde temp birikirdi.
  let tmpToClean: string | null = null;
  const bail = (resp: NextResponse) => {
    if (tmpToClean) { try { fs.unlinkSync(tmpToClean); } catch { /* temizlik kritik değil */ } tmpToClean = null; }
    return resp;
  };
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
    if (printer.type === "bambu" && (!printer.accessCode || !printer.serial)) {
      return NextResponse.json({ error: "Bambu access code / seri no eksik (Yönet)" }, { status: 400 });
    }

    // Dosya baytları + doğrulama yolu: R2'deyse buluttan çek (doğrulama fonksiyonları YOL beklediği
    // için geçici dosyaya yaz); değilse yerel diskten. buf belleğe alınır, geçici dosya akış bitince silinir.
    let buf: Buffer;
    let validatePath: string;
    if (mf.r2Key) {
      const cfg = await getR2Config();
      if (!cfg) {
        return NextResponse.json({ error: "Bulut depolama (R2) ayarlı değil — Ayarlar → Cloud Depolama'dan gir." }, { status: 400 });
      }
      try {
        buf = await getObjectBytes(mf.r2Key, cfg);
      } catch (e) {
        return NextResponse.json({ error: `Buluttan dosya çekilemedi: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
      }
      const safeExt = (mf.fileType || "gcode").replace(/[^a-z0-9]/gi, "") || "gcode";
      const tmp = path.join(os.tmpdir(), `mlprint-${crypto.randomUUID()}.${safeExt}`);
      await fs.promises.writeFile(tmp, buf);
      validatePath = tmp;
      tmpToClean = tmp;
    } else {
      if (!fs.existsSync(mf.storedPath)) {
        return NextResponse.json({ error: "Dosya bu cihazda yok (başka bilgisayarda yüklenmiş olabilir)" }, { status: 400 });
      }
      validatePath = mf.storedPath;
      buf = fs.readFileSync(mf.storedPath);
    }

    // ── ÖN DOĞRULAMA (akış öncesi 4xx) ──────────────────────────────────────────
    // 1) Dosya dilimlenmiş mi? (STL/OBJ/ham 3MF → baskı başlatma)
    if (printer.type === "bambu" && !is3mfSliced(validatePath)) {
      return bail(NextResponse.json(
        { error: "Bu dosya dilimlenmemiş (STL/OBJ veya ham 3MF). Bambu Studio/Orca ile dilimleyip .3mf (veya .gcode) yükleyin." },
        { status: 400 }
      ));
    }
    // 1b) Bambu ÇOK RENKLİ baskı: ham .gcode AMS eşleme tablosunu TAŞIMAZ → LAN modunda
    //     yazıcı "AMS mapping table alınamadı" ile reddeder (kriptik print_error, ör. 83902467).
    //     Bambu Studio'dan "dilimlenmiş plaka dosyası" (.3mf) gerekir. Net yönlendir.
    if (printer.type === "bambu") {
      const isRawGcode = /\.(gcode|gco|g)$/i.test(mf.originalName) && !/\.3mf$/i.test(mf.originalName);
      if (isRawGcode && readModelColors(validatePath).colors.length > 1) {
        return bail(NextResponse.json(
          {
            error:
              "Bambu çok renkli baskı için ham .gcode yetmiyor — AMS eşleme tablosunu taşımadığı için yazıcı reddediyor. Bambu Studio'da plakayı dilimle → sağ üstteki oka tıkla → \"Dilimlenmiş plaka dosyasını dışa aktar\" ile aldığın .3mf dosyasını yükle.",
          },
          { status: 400 }
        ));
      }
    }
    // 2) AMS renk eşleştirmesi tutarlı mı? (her renk dolu bir slota; eksik/boş slot → başlatma)
    if (printer.type === "bambu" && useAms && Array.isArray(amsMapping)) {
      const colors = readModelColors(validatePath).colors;
      if (colors.length) {
        for (const c of colors) {
          const slot = amsMapping[c.index];
          if (slot == null || slot < 0) {
            return bail(NextResponse.json({ error: "Renk eşleştirmesi eksik: her baskı rengi bir AMS slotuna atanmalı." }, { status: 400 }));
          }
        }
        // Boş slot seçilmiş mi? (slot okunabiliyorsa)
        try {
          const slots = await getBambuAmsSlots(printer.host, printer.accessCode!, printer.serial!);
          if (slots.length) {
            for (const c of colors) {
              const phys = slots.find((s) => s.slot === amsMapping[c.index]);
              if (phys && phys.empty) {
                return bail(NextResponse.json({ error: `AMS slot ${amsMapping[c.index] + 1} boş — dolu bir slot seçin.` }, { status: 400 }));
              }
            }
          }
        } catch { /* slot okunamazsa boş-kontrolünü atla */ }
      }
    }

    const isBambu = printer.type === "bambu";

    // YAZICI-BAŞINA KİLİT: aynı yazıcıya eşzamanlı ikinci başlatma (çift tık / telefon relay
    // komutu / ikinci pencere) ikisi de boşta-kontrolünü geçebilir → çift upload/start yarışı.
    // Kilit tüm akış boyunca (upload + start + doğrulama) tutulur, finally'de bırakılır.
    if (!tryAcquirePrintLock(printer.id)) {
      return bail(NextResponse.json({ error: "Bu yazıcıda şu an bir baskı başlatılıyor — bitmesini bekle." }, { status: 409 }));
    }

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
            // BambuStudio gibi: ams_mapping'i PROJE filament sayısına -1 ile DOLDUR (kullanılmayan
            // filamentler -1) + GERÇEK plate gcode yolunu gönder. Eksik uzunluk/yanlış plate → A1 reddeder.
            const { plateParam, filamentCount } = readBambuPrintMeta(validatePath);
            let bambuMapping = amsMapping;
            if (Array.isArray(bambuMapping) && filamentCount > bambuMapping.length) {
              bambuMapping = [...bambuMapping];
              while (bambuMapping.length < filamentCount) bambuMapping.push(-1);
            }
            const r = await bambuUploadAndPrint(printer.host, printer.accessCode!, printer.serial!, buf, mf.originalName, {
              amsMapping: bambuMapping, useAms, plateParam, prefs,
              onProgress: (pct) => send({ stage: "upload", pct }),
            });
            matchFilename = r.matchName; // yazıcının raporlayacağı subtask_name = eşleştirme anahtarı
          } else {
            send({ stage: "upload", pct: null }); // Moonraker: belirsiz (fetch byte takibi yok)
            // Snapmaker: kafa seçimi (amsMapping) + baskı tercihleri → gcode tool remap / makro aç-kapa.
            await moonrakerUploadAndPrint(printer.host, printer.port, buf, mf.originalName, { headMapping: amsMapping, prefs, brand: printer.brand });
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
                const hex = `0x${(s.printError >>> 0).toString(16).toUpperCase()}`;
                const hms = s.hmsCodes.length ? ` HMS: ${s.hmsCodes.join(", ")}.` : "";
                send({
                  stage: "error",
                  message: `Yazıcı baskıyı reddetti (hata ${hex}).${hms} Sık neden: eşlenen AMS slotu boş / yanlış filament tipi. Slotların dolu olduğunu + renk eşleşmesini kontrol et.`,
                });
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
          // Sıra ÖNEMLİ: önce temizlik + kilit, EN SON close. Eski halde guard'sız close(),
          // istemci akışı kapatmışsa fırlatıyor ve temp silme satırını atlıyordu (sızıntı).
          if (tmpToClean) { try { fs.unlinkSync(tmpToClean); } catch { /* geçici dosya temizliği kritik değil */ } tmpToClean = null; }
          releasePrintLock(printer.id);
          try { controller.close(); } catch { /* akış zaten kapalı (istemci ayrıldı) */ }
        }
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
    });
  } catch (error) {
    return bail(jsonError(error));
  }
}
