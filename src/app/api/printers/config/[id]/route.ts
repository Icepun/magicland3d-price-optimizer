import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { dropBambuConns } from "@/core/printers/bambu";

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  brand: z.enum(["elegoo", "snapmaker", "bambu"]).optional(),
  model: z.string().nullable().optional(),
  type: z.enum(["moonraker", "bambu"]).optional(),
  host: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  accent: z.string().nullable().optional(),
  accessCode: z.string().nullable().optional(),
  serial: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const data = UpdateSchema.parse(await req.json());
    const before = await prisma.printerConfig.findUnique({ where: { id } });
    const updated = await prisma.printerConfig.update({ where: { id }, data });
    // Bambu MQTT bağlantısını tazele: access code/host/serial değişikliği eski bağlantıda
    // GEÇERSİZDİ (uygulama yeniden başlatılana dek bayat şifreyle reconnect); disable'da da
    // zombie reconnect kalmasın. Eski VE yeni kimlikler düşürülür; sonraki sorgu taze kurar.
    if (before?.serial) dropBambuConns(before.host, before.serial);
    if (updated.type === "bambu" && updated.serial && (data.enabled === false || before?.host !== updated.host || before?.serial !== updated.serial || before?.accessCode !== updated.accessCode)) {
      dropBambuConns(updated.host, updated.serial);
    }
    return NextResponse.json(updated);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    // İlişkili ürün eşleştirmelerini de temizle
    await prisma.printFileProduct.deleteMany({ where: { printerConfigId: id } });
    await prisma.printerConfig.delete({ where: { id } });
    // Silinen Bambu'nun MQTT bağlantısı zombie reconnect yapmasın.
    if (cfg?.type === "bambu" && cfg.serial) dropBambuConns(cfg.host, cfg.serial);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
