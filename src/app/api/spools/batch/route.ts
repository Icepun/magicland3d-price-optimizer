import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { SpoolInputSchema, buildSpoolFields } from "@/lib/filament-spool-input";
import { watchFilamentGroup } from "@/lib/filament-settings";

/**
 * TOPLU makara ekleme — "3 × Yeşil PLA (Polyture, 1 kg)" tek istekte.
 *
 * Envanterde makaralar tek tek satır olarak durur (biri açılınca diğerleri kapalı kalsın diye);
 * kullanıcı ise adet girer. Bu uç o boşluğu kapatır.
 *
 * `quantity` üst sınırı 20: veritabanı UZAK HTTP üzerinden konuşuyor, tek transaction içinde
 * onlarca ardışık yazma uzun kilit ve zaman aşımı riski demek. Sınır aşılırsa istek reddedilir
 * (sessizce kırpılmaz — kullanıcı 50 yazıp 20 makara almış olmaz).
 */
const BatchSchema = SpoolInputSchema.extend({
  quantity: z.coerce.number().int().min(1).max(20).default(1),
});

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = BatchSchema.parse(await req.json());
    const { quantity, ...spoolInput } = input;
    const { fields, groupKey, label } = buildSpoolFields(spoolInput);

    const created = await prisma.$transaction(
      Array.from({ length: quantity }, () => prisma.filamentSpool.create({ data: fields }))
    );

    await watchFilamentGroup(groupKey, label);

    return NextResponse.json({ count: created.length, spools: created }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
