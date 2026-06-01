import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerControl, moonrakerStart } from "@/core/printers/moonraker";
import { bambuControl } from "@/core/printers/bambu";

const Schema = z.object({
  action: z.enum(["pause", "resume", "cancel", "start"]),
  filename: z.string().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const { action, filename } = Schema.parse(await req.json());

    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    if (cfg.type === "bambu") {
      if (!cfg.accessCode || !cfg.serial) {
        return NextResponse.json({ error: "Access code + seri no eksik" }, { status: 400 });
      }
      if (action === "start") {
        return NextResponse.json({ error: "Bambu'da uygulamadan baskı başlatma henüz desteklenmiyor" }, { status: 400 });
      }
      bambuControl(cfg.host, cfg.accessCode, cfg.serial, action);
      return NextResponse.json({ ok: true });
    }

    if (cfg.type !== "moonraker") {
      return NextResponse.json({ error: "Bu yazıcı tipi için kontrol desteklenmiyor" }, { status: 400 });
    }

    if (action === "start") {
      if (!filename) return NextResponse.json({ error: "Dosya seçilmedi" }, { status: 400 });
      await moonrakerStart(cfg.host, cfg.port, filename);
    } else {
      await moonrakerControl(cfg.host, cfg.port, action);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
