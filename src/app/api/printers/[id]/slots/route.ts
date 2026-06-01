import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { fetchMoonrakerSlots } from "@/core/printers/moonraker";
import { getBambuAmsSlots } from "@/core/printers/bambu";

export const dynamic = "force-dynamic";

/** Yazıcının yüklü renkli slotları (Bambu AMS / Snapmaker CFS) — baskı öncesi gösterim. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    if (cfg.type === "bambu") {
      if (!cfg.accessCode || !cfg.serial) {
        return NextResponse.json({ type: "bambu", slots: [], error: "Access code / seri no eksik" });
      }
      const slots = await getBambuAmsSlots(cfg.host, cfg.accessCode, cfg.serial);
      return NextResponse.json({ type: "bambu", slots });
    }

    // Moonraker — Snapmaker CFS (best-effort) veya Elegoo (tek renk → boş)
    const slots = await fetchMoonrakerSlots(cfg.host, cfg.port);
    return NextResponse.json({ type: "moonraker", slots });
  } catch (error) {
    return jsonError(error);
  }
}
