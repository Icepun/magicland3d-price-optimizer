import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

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
    const updated = await prisma.printerConfig.update({ where: { id }, data });
    return NextResponse.json(updated);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    // İlişkili ürün eşleştirmelerini de temizle
    await prisma.printFileProduct.deleteMany({ where: { printerConfigId: id } });
    await prisma.printerConfig.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
