import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { SEALED_TOLERANCE_GRAMS, nearestColor, slugifyTr, spoolGroupKey } from "@/core/filament-groups";
import { watchFilamentGroup } from "@/lib/filament-settings";

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  material: z.string().optional(),
  colorName: z.string().nullable().optional(),
  colorHex: z.string().optional(),
  colorKey: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  totalGrams: z.coerce.number().positive().optional(),
  remainingGrams: z.coerce.number().min(0).optional(),
  spoolCost: z.coerce.number().min(0).nullable().optional(),
  reorderGrams: z.coerce.number().min(0).optional(),
  vendorUrl: z.string().nullable().optional(),
  /** null → makarayı KAPALI işaretle; tarih → açık. Genelde istemci göndermez, aşağıdaki ağ türetir. */
  openedAt: z.coerce.date().nullable().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const input = UpdateSchema.parse(await req.json());
    const data: Record<string, unknown> = { ...input };

    const current = await prisma.filamentSpool.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Makara bulunamadı" }, { status: 404 });

    // Renk adı değişirse gruplama anahtarı da onunla birlikte yazılmalı — yoksa makara eski
    // grupta asılı kalır ve kullanıcı rengi düzeltmesine rağmen kart değişmez.
    if (input.colorName !== undefined && input.colorKey === undefined) {
      const nextName = (input.colorName ?? "").trim();
      data.colorKey = nextName
        ? slugifyTr(nextName)
        : nearestColor(input.colorHex ?? current.colorHex).key;
    } else if (input.colorKey !== undefined) {
      data.colorKey = slugifyTr(input.colorKey ?? "") || null;
    }

    // KAPALI/AÇIK GÜVENLİK AĞI — istemci openedAt göndermese bile durum gramla tutarlı kalsın.
    // Hem masaüstündeki hem telefondaki "Dolu" butonu yalnız remainingGrams yazıyor; bu ağ olmadan
    // bir kez tüketilen makara sonsuza dek "açık" görünür ve kapalı sayısı kalıcı olarak eksik çıkar.
    if (input.openedAt === undefined && input.remainingGrams !== undefined) {
      const total = input.totalGrams ?? current.totalGrams;
      data.openedAt =
        input.remainingGrams >= total - SEALED_TOLERANCE_GRAMS
          ? null // dolu → kapalı say
          : current.openedAt ?? new Date(); // eksilmiş → açık (zaten açıksa tarihi koru)
    }

    const updated = await prisma.filamentSpool.update({ where: { id }, data });

    // Grup değiştiyse yeni grubu da izlemeye al (uyarı üretimi grubu kaybetmesin).
    await watchFilamentGroup(spoolGroupKey(updated), `${updated.colorName ?? ""} ${updated.material}`.trim());

    return NextResponse.json(updated);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    await prisma.filamentSpool.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
