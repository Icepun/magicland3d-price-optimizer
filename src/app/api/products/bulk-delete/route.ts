import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { z } from "zod";

const Schema = z.object({
  ids: z.array(z.string()).min(1, "En az bir ürün seç"),
});

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { ids } = Schema.parse(await req.json());
    // Silinenlerin varyantlarını üst seviyeye geri al (kaybolmasınlar)
    await prisma.product.updateMany({
      where: { parentProductId: { in: ids } },
      data: { parentProductId: null, variantLabel: null },
    });
    const result = await prisma.product.deleteMany({ where: { id: { in: ids } } });
    return NextResponse.json({ deleted: result.count });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Toplu silme başarısız" },
      { status: 400 }
    );
  }
}
