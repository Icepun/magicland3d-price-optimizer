import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  name: z.string().min(1, "Ad zorunlu"),
  brand: z.enum(["elegoo", "snapmaker", "bambu"]).default("elegoo"),
  model: z.string().nullable().optional(),
  type: z.enum(["moonraker", "bambu"]).default("moonraker"),
  host: z.string().min(1, "IP/host zorunlu"),
  port: z.coerce.number().int().min(1).max(65535).default(7125),
  accent: z.string().nullable().optional(),
  accessCode: z.string().nullable().optional(),
  serial: z.string().nullable().optional(),
});

export async function GET() {
  await ensureRuntimeSchema();
  const list = await prisma.printerConfig.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(list);
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const data = CreateSchema.parse(await req.json());
    const sortOrder = await prisma.printerConfig.count();
    const created = await prisma.printerConfig.create({ data: { ...data, sortOrder } });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
