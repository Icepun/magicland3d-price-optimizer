import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Paketleme "hazırlandı" işaretleri — MASAÜSTÜ VE TELEFON ORTAK.
 *
 * Eskiden bu işaretler tarayıcının oturum deposundaydı: masaüstünde işaretlediğin ürün
 * telefonda işaretsiz görünüyordu ve sayfayı kapatınca kayboluyordu. Artık tek kaynak
 * `PrepDone` tablosu (şema v46); satırın anahtarı ortak çekirdeğin ürettiği `key`.
 */
export async function GET() {
  await ensureRuntimeSchema();
  const rows = await prisma.prepDone.findMany({ select: { key: true } });
  return NextResponse.json(
    { keys: rows.map((r) => r.key) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  await ensureRuntimeSchema();
  const body = (await req.json()) as { key?: unknown; done?: unknown };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) return NextResponse.json({ error: "key gerekli" }, { status: 400 });

  if (body.done === false) {
    await prisma.prepDone.deleteMany({ where: { key } });
  } else {
    await prisma.prepDone.upsert({
      where: { key },
      create: { key },
      update: { doneAt: new Date() },
    });
  }
  return NextResponse.json({ ok: true });
}

/** Paketleme bitti → listeyi sıfırla. */
export async function DELETE() {
  await ensureRuntimeSchema();
  await prisma.prepDone.deleteMany({});
  return NextResponse.json({ ok: true });
}
