import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { z } from "zod";

const CreateSchema = z.object({
  name: z.string().min(1, "Grup adı zorunlu"),
  // İsteğe bağlı: oluştururken üyeleri de bağla
  members: z
    .array(
      z.object({
        productId: z.string().min(1),
        variantLabel: z.string().nullable().optional(),
      })
    )
    .optional(),
});

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { name, members } = CreateSchema.parse(await req.json());

    const group = await prisma.variantGroup.create({ data: { name: name.trim() } });

    if (members && members.length > 0) {
      for (const m of members) {
        await prisma.product.update({
          where: { id: m.productId },
          data: { variantGroupId: group.id, variantLabel: m.variantLabel?.trim() || null },
        });
      }
    }

    return NextResponse.json(group, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Grup oluşturulamadı" },
      { status: 400 }
    );
  }
}
