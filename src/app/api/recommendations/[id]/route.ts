import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const Schema = z.object({
  status: z.enum([
    "ready",
    "accepted",
    "ignored",
    "needs_cost",
    "no_better_price",
    "sent_to_trendyol",
  ]),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const data = Schema.parse(await req.json());
  const rec = await prisma.recommendation.update({ where: { id }, data });
  return NextResponse.json(rec);
}
