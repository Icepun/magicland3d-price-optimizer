import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { SpoolInputSchema, buildSpoolFields } from "@/lib/filament-spool-input";
import { watchFilamentGroup } from "@/lib/filament-settings";

export async function GET() {
  try {
    await ensureRuntimeSchema();
    const spools = await prisma.filamentSpool.findMany({
      where: { isActive: true },
      orderBy: [{ remainingGrams: "asc" }, { name: "asc" }],
    });
    return NextResponse.json(spools);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = SpoolInputSchema.parse(await req.json());
    const { fields, groupKey, label } = buildSpoolFields(input);
    const spool = await prisma.filamentSpool.create({ data: fields });
    // Grubu kalıcı izlemeye al → son makara silinse bile "bitti" uyarısı çıkabilsin.
    await watchFilamentGroup(groupKey, label);
    return NextResponse.json(spool, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
