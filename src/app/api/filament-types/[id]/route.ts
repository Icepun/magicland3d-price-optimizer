import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import { z } from "zod";

const Schema = z.object({
  name: z.string().min(1).optional(),
  costPerGram: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const data = Schema.parse(await req.json());
    const filament = await prisma.filamentType.update({
      where: { id },
      data,
    });
    invalidateOrdersCache();
    return NextResponse.json(filament);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hata olustu";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await prisma.filamentType.delete({ where: { id } });
    invalidateOrdersCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hata olustu";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
