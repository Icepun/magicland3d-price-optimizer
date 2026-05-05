import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const settings = await prisma.appSetting.findMany();
  return NextResponse.json(
    Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, s.value]))
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json() as Record<string, string>;

  await Promise.all(
    Object.entries(body).map(([key, value]) =>
      prisma.appSetting.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) },
      })
    )
  );

  return NextResponse.json({ ok: true });
}
