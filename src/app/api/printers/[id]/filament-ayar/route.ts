import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerFilamentAyarla } from "@/core/printers/moonraker";
import { bambuFilamentAyarla } from "@/core/printers/bambu";
import { bumpBambuStatus, bumpMoonrakerStatus } from "@/core/printers/status-cache";

export const dynamic = "force-dynamic";

const Schema = z.object({
  /** Yuva / kafa (0 tabanlı, yazıcı panelindeki numaralamayla aynı). */
  slot: z.number().int().min(0).max(31),
  /** "#RRGGBB". */
  renk: z.string().regex(/^#?[0-9a-fA-F]{6}$/).nullish(),
  tip: z.string().max(20).nullish(),
});

/**
 * TAKILI FİLAMENTİN RENGİ / TÜRÜ — yazıcının kendi ekranındaki "filament düzenle"nin uygulamadaki
 * karşılığı. U1: kafa başına (print_task_config), Bambu: AMS makarası (ams_filament_setting).
 * Etiketli makaralar ve baskı sürerken değişiklik reddedilir; sonuç yazıcıdan geri okunarak doğrulanır.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const { slot, renk, tip } = Schema.parse(await req.json());
    const cfg = await prisma.printerConfig.findUnique({
      where: { id },
      select: { host: true, port: true, type: true, brand: true, accessCode: true, serial: true },
    });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    try {
      if (cfg.type === "bambu") {
        if (!cfg.accessCode || !cfg.serial) {
          return NextResponse.json({ error: "Bambu erişim kodu veya seri no eksik (Yönet)." }, { status: 400 });
        }
        await bambuFilamentAyarla(cfg.host, cfg.accessCode, cfg.serial, slot, { renk, tip });
        bumpBambuStatus(cfg.host, cfg.serial);
      } else if ((cfg.brand ?? "").toLowerCase() === "snapmaker") {
        await moonrakerFilamentAyarla(cfg.host, cfg.port ?? 7125, slot, { renk, tip });
        bumpMoonrakerStatus(cfg.host, cfg.port ?? 7125);
      } else {
        return NextResponse.json({ error: "Bu yazıcıda filament rengi uygulamadan ayarlanamıyor." }, { status: 400 });
      }
    } catch (e) {
      // Kullanıcıya dönük, tek satırlık sebepler (etiketli makara, baskı sürüyor, doğrulanamadı…).
      return NextResponse.json({ error: e instanceof Error ? e.message : "Filament bilgisi kaydedilemedi." }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
