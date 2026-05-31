import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { z } from "zod";

const UpdateSchema = z.object({
  name: z.string().min(1, "Grup adı zorunlu"),
});

/** Grubu yeniden adlandır. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const { name } = UpdateSchema.parse(await req.json());
    const group = await prisma.variantGroup.update({
      where: { id },
      data: { name: name.trim() },
    });
    return NextResponse.json(group);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Grup güncellenemedi" },
      { status: 400 }
    );
  }
}

/** Grubu dağıt — tüm üyelerin bağını kaldır, sonra grubu sil. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    await prisma.product.updateMany({
      where: { variantGroupId: id },
      data: { variantGroupId: null, variantLabel: null },
    });
    await prisma.variantGroup.delete({ where: { id } }).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Grup dağıtılamadı" },
      { status: 400 }
    );
  }
}
