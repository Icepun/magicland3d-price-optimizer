import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-error";
import { FilamentSemasi } from "@/lib/filament-semasi";


export async function GET() {
  try {
    const filaments = await prisma.filamentType.findMany({ orderBy: { name: "asc" } });
    return NextResponse.json(filaments);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const data = FilamentSemasi.parse(await req.json());
    // Yeni filament henüz hiçbir üründe yok → kâr önbelleğine dokunmaya gerek yok.
    const filament = await prisma.filamentType.create({ data });
    return NextResponse.json(filament, { status: 201 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
