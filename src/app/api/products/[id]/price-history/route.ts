import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();

  const { id } = await params;
  const url = new URL(req.url);
  const days = Number(url.searchParams.get("days") ?? 90);
  const limit = Number(url.searchParams.get("limit") ?? 200);

  const since = new Date();
  since.setDate(since.getDate() - days);

  const history = await prisma.priceHistory.findMany({
    where: {
      productId: id,
      changedAt: { gte: since },
    },
    orderBy: { changedAt: "asc" },
    take: limit,
  });

  return NextResponse.json(history);
}
