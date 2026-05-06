import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const Schema = z.object({
  name: z.string().min(1),
  costPerGram: z.number().min(0),
  isActive: z.boolean().default(true),
});

export async function GET() {
  const filaments = await prisma.filamentType.findMany({
    orderBy: { name: "asc" },
  });
  return NextResponse.json(filaments);
}

export async function POST(req: NextRequest) {
  try {
    const data = Schema.parse(await req.json());
    const filament = await prisma.filamentType.create({ data });
    return NextResponse.json(filament, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hata olustu";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
