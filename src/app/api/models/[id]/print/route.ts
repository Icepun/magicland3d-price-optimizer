import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getR2Config, getObjectBytesWithProgress, type R2Config } from "@/lib/r2";
import { moonrakerUploadAndPrint } from "@/core/printers/moonraker";
import { bambuUploadAndPrint, getBambuStatus, getBambuAmsSlots, mapBambuState } from "@/core/printers/bambu";
import { readModelColors, is3mfSliced, readBambuPrintMeta } from "@/core/printers/model-colors";
import { tryAcquirePrintLock, releasePrintLock } from "@/core/printers/print-lock";
import { invalidatePrintFileMatches } from "@/core/printers/status-cache";

export const dynamic = "force-dynamic";

/**
 * Modeli yazıcıya yükle + baskıyı başlat. Yanıt = NDJSON akışı (satır satır ilerleme):
 *   {stage:"download",pct} · {stage:"status"} · {stage:"upload",pct} · {stage:"start"} ·
 *   {stage:"confirm"} · {stage:"done"} · {stage:"error",message}
 *
 * R2 indirmesi + doğrulama AKIŞ İÇİNDE koşar: eskiden ikisi de yanıt üretilmeden önce yapılıyordu →
 * büyük bulut dosyasında kullanıcı ilerlemesiz ölü ekran görüyordu. Dosya metası (renkler/dilim/
 * plaka) kalıcıysa (colorsJson/sliced/plateJson) dosya HİÇ parse edilmez (senkron unzip donması yok);
 * değilse bir kez parse edilip saklanır.
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
    if (printer.type === "bambu" && (!printer.accessCode || !printer.serial)) {
      return NextResponse.json({ error: "Bambu access code / seri no eksik (Yönet)" }, { status: 400 });
    }

    // Hızlı ön kontroller (dosyasız) — akış öncesi net 4xx.
    let r2cfg: R2Config | null = null;
    if (mf.r2Key) {
      r2cfg = await getR2Config();
      if (!r2cfg) {
        return NextResponse.json({ error: "Bulut depolama (R2) ayarlı değil — Ayarlar → Cloud Depolama'dan gir." }, { status: 400 });
      }
    } else if (!fs.existsSync(mf.storedPath)) {
      return NextResponse.json({ error: "Dosya bu cihazda yok (başka bilgisayarda yüklenmiş olabilir)" }, { status: 400 });
    }

    const isBambu = printer.type === "bambu";

    // YAZICI-BAŞINA KİLİT: aynı yazıcıya eşzamanlı ikinci başlatma (çift tık / telefon relay
    // komutu / ikinci pencere) ikisi de boşta-kontrolünü geçebilir → çift upload/start yarışı.
    // Kilit tüm akış boyunca (indirme + doğrulama + upload + start) tutulur, finally'de bırakılır.
    if (!tryAcquirePrintLock(printer.id)) {
      return NextResponse.json({ error: "Bu yazıcıda şu an bir baskı başlatılıyor — bitmesini bekle." }, { status: 409 });
    }

    const enc = new TextEncoder();
    let tmpToClean: string | null = null;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: Record<string, unknown>) => {
          try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* akış kapandı */ }
        };
        let printerErrored = false;
        try {
          // ── 1) DOSYA — R2: gerçek % ile indir; yerel: async oku (sync okuma pencereyi donduruyordu)
          let buf: Buffer;
          if (mf.r2Key) {
            send({ stage: "download", pct: 0 });
            buf = await getObjectBytesWithProgress(mf.r2Key, r2cfg!, (pct) => send({ stage: "download", pct }));
          } else {
            buf = await fs.promises.readFile(mf.storedPath);
          }

          // Geçici parse yolu — SADECE kalıcı meta eksikse yazılır (varsa dosya hiç açılmaz).
          let parsePath: string | null = mf.r2Key ? null : mf.storedPath;
          const ensureParsePath = async (): Promise<string> => {
            if (parsePath) return parsePath;
            const safeExt = (mf.fileType || "gcode").replace(/[^a-z0-9]/gi, "") || "gcode";
            const tmp = path.join(os.tmpdir(), `mlprint-${crypto.randomUUID()}.${safeExt}`);
            await fs.promises.writeFile(tmp, buf);
            tmpToClean = tmp;
            parsePath = tmp;
            return tmp;
          };
          // İlk baskıda parse edilenler kalıcılaştırılır → sonraki baskılar dosyayı hiç açmaz.
          const persist: Record<string, unknown> = {};
          const getColors = async () => {
            if (mf.colorsJson) {
              try { return JSON.parse(mf.colorsJson) as ReturnType<typeof readModelColors>; } catch { /* dosyadan */ }
            }
            const info = readModelColors(await ensureParsePath());
            persist.colorsJson = JSON.stringify(info);
            return info;
          };

          send({ stage: "status" });

          // ── 2) DOĞRULAMA (Bambu)
          if (isBambu) {
            let sliced = mf.sliced;
            if (sliced == null) {
              sliced = is3mfSliced(await ensureParsePath());
              persist.sliced = sliced;
            }
            if (!sliced) {
              throw new Error("Bu dosya dilimlenmemiş (STL/OBJ veya ham 3MF). Bambu Studio/Orca ile dilimleyip .3mf (veya .gcode) yükleyin.");
            }
            // Ham .gcode AMS eşleme tablosunu TAŞIMAZ → çok renklide yazıcı reddeder (ör. 83902467).
            const isRawGcode = /\.(gcode|gco|g)$/i.test(mf.originalName) && !/\.3mf$/i.test(mf.originalName);
            if (isRawGcode && (await getColors()).colors.length > 1) {
              throw new Error(
                "Bambu çok renkli baskı için ham .gcode yetmiyor — AMS eşleme tablosunu taşımadığı için yazıcı reddediyor. Bambu Studio'da plakayı dilimle → sağ üstteki oka tıkla → \"Dilimlenmiş plaka dosyasını dışa aktar\" ile aldığın .3mf dosyasını yükle."
              );
            }
            // AMS renk eşleştirmesi tutarlı mı? (her renk dolu bir slota)
            if (useAms && Array.isArray(amsMapping)) {
              const colors = (await getColors()).colors;
              if (colors.length) {
                for (const c of colors) {
                  const slot = amsMapping[c.index];
                  if (slot == null || slot < 0) {
                    throw new Error("Renk eşleştirmesi eksik: her baskı rengi bir AMS slotuna atanmalı.");
                  }
                }
                try {
                  const slots = await getBambuAmsSlots(printer.host, printer.accessCode!, printer.serial!);
                  if (slots.length) {
                    for (const c of colors) {
                      const phys = slots.find((s) => s.slot === amsMapping[c.index]);
                      if (phys && phys.empty) {
                        throw new Error(`AMS slot ${amsMapping[c.index] + 1} boş — dolu bir slot seçin.`);
                      }
                    }
                  }
                } catch (e) {
                  if (e instanceof Error && /AMS slot/.test(e.message)) throw e;
                  /* slot okunamazsa boş-kontrolünü atla */
                }
              }
            }
          }

          send({ stage: "upload", pct: 0 });
          let matchFilename = mf.originalName.replace(/\.[^.]+$/, "");

          if (isBambu) {
            // BambuStudio gibi: ams_mapping'i PROJE filament sayısına -1 ile DOLDUR (kullanılmayan
            // filamentler -1) + GERÇEK plate gcode yolunu gönder. Eksik uzunluk/yanlış plate → A1 reddeder.
            let plate: { plateParam: string | null; filamentCount: number } | null = null;
            if (mf.plateJson) {
              try { plate = JSON.parse(mf.plateJson); } catch { /* dosyadan */ }
            }
            if (!plate) {
              plate = readBambuPrintMeta(await ensureParsePath());
              persist.plateJson = JSON.stringify(plate);
            }
            let bambuMapping = amsMapping;
            if (Array.isArray(bambuMapping) && plate.filamentCount > bambuMapping.length) {
              bambuMapping = [...bambuMapping];
              while (bambuMapping.length < plate.filamentCount) bambuMapping.push(-1);
            }
            const r = await bambuUploadAndPrint(printer.host, printer.accessCode!, printer.serial!, buf, mf.originalName, {
              amsMapping: bambuMapping, useAms, plateParam: plate.plateParam ?? undefined, prefs,
              onProgress: (pct) => send({ stage: "upload", pct }),
            });
            matchFilename = r.matchName; // yazıcının raporlayacağı subtask_name = eşleştirme anahtarı
          } else {
            send({ stage: "upload", pct: null }); // Moonraker: belirsiz (fetch byte takibi yok)
            // Snapmaker: kafa seçimi (amsMapping) + baskı tercihleri → gcode tool remap / makro aç-kapa.
            await moonrakerUploadAndPrint(printer.host, printer.port, buf, mf.originalName, { headMapping: amsMapping, prefs, brand: printer.brand });
          }

          // İlk baskıda parse edilen meta kalıcılaşsın (fire-and-forget; baskıyı yavaşlatmaz).
          if (Object.keys(persist).length) {
            void prisma.productModelFile.update({ where: { id: mf.id }, data: persist }).catch(() => {});
          }

          send({ stage: "start" });
          try {
            await prisma.printFileProduct.upsert({
              where: { printerConfigId_filename: { printerConfigId: printer.id, filename: matchFilename } },
              create: { printerConfigId: printer.id, filename: matchFilename, productId: mf.productId },
              update: { productId: mf.productId },
            });
            invalidatePrintFileMatches(); // panel yeni eşleşmeyi 30sn TTL beklemeden görsün
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
          // Sıra ÖNEMLİ: önce temizlik + kilit, EN SON close (guard'sız close fırlayıp temizliği atlıyordu).
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
    return jsonError(error);
  }
}
