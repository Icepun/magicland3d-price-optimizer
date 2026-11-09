import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerFilamentBosalt } from "@/core/printers/moonraker";
import { tryAcquirePrintLock, releasePrintLock } from "@/core/printers/print-lock";
import { bumpMoonrakerStatus } from "@/core/printers/status-cache";

export const dynamic = "force-dynamic";

const Schema = z.object({
  /** Boşaltılacak kafalar (0 tabanlı). */
  kafalar: z.array(z.number().int().min(0).max(3)).min(1).max(4),
});

/**
 * FİLAMENT BOŞALT (Snapmaker U1) — yazıcı ekranındaki "Filament boşalt"ın bilgisayardan hâli.
 *
 * Yanıt NDJSON akışı (her kafa birkaç dakika sürebiliyor, arayüz ilerlemeyi canlı gösterir):
 *   {asama:"isiniyor",kafa,sicaklik,hedef} · {asama:"cekiliyor",kafa} · {asama:"bitti",kafa} ·
 *   {asama:"tamam"} · {asama:"hata",mesaj}
 * Pencere kapansa da işlem yazıcıda sürer ve sonunda ısıtıcılar kapatılır. Aynı yazıcıda o sırada
 * baskı başlatılamasın diye baskı kilidi tutulur.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const { kafalar } = Schema.parse(await req.json());
    const cfg = await prisma.printerConfig.findUnique({
      where: { id },
      select: { id: true, host: true, port: true, type: true, brand: true },
    });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });
    if ((cfg.brand ?? "").toLowerCase() !== "snapmaker") {
      return NextResponse.json({ error: "Bu yazıcıda filament boşaltma uygulamadan yapılamıyor." }, { status: 400 });
    }
    if (!tryAcquirePrintLock(cfg.id)) {
      return NextResponse.json({ error: "Bu yazıcıda şu an başka bir işlem sürüyor — bitmesini bekle." }, { status: 409 });
    }

    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: Record<string, unknown>) => {
          try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* istemci ayrıldı — işlem sürer */ }
        };
        try {
          await moonrakerFilamentBosalt(cfg.host, cfg.port ?? 7125, kafalar, (o) => send(o));
          send({ asama: "tamam" });
        } catch (e) {
          send({ asama: "hata", mesaj: e instanceof Error ? e.message : "Filament boşaltılamadı." });
        } finally {
          releasePrintLock(cfg.id);
          bumpMoonrakerStatus(cfg.host, cfg.port ?? 7125);
          try { controller.close(); } catch { /* zaten kapalı */ }
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
