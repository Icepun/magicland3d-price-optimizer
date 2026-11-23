import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import { jsonError } from "@/lib/api-error";
import { FilamentSemasi } from "@/lib/filament-semasi";

const Schema = FilamentSemasi.partial();
const bulunamadi = () => NextResponse.json({ error: "Filament bulunamadı — silinmiş olabilir" }, { status: 404 });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const data = Schema.parse(await req.json());
    const onceki = await prisma.filamentType.findUnique({ where: { id }, select: { costPerGram: true } });
    if (!onceki) return bulunamadi();
    const filament = await prisma.filamentType.update({ where: { id }, data });
    // Yalnız FİYAT değişince kâr önbellekleri düşer — ad/durum değişikliği kârı etkilemez.
    if (data.costPerGram != null && data.costPerGram !== onceki.costPerGram) bustProfitInputCaches();
    return NextResponse.json(filament);
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const varMi = await prisma.filamentType.findUnique({ where: { id }, select: { id: true } });
    if (!varMi) return bulunamadi();
    await prisma.filamentType.delete({ where: { id } });
    bustProfitInputCaches();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, 400);
  }
}
