import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { SpoolInputSchema, buildSpoolFields } from "@/lib/filament-spool-input";
import { watchFilamentGroup } from "@/lib/filament-settings";
import { bustInventoryAlertCaches } from "@/lib/cache-busting";
import { batchWrite } from "@/lib/libsql-batch";
import { toDbDate } from "@/lib/sqlite-date";

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

    // TEK istekte yaz: uzak veritabanında her yazma ayrı tur, ve tüm sorgular tek kuyrukta sırayla
    // koşuyor — 20 makara ≈ 2 sn uygulamanın geri kalanını bekletiyordu (denetim, 23 Kas 2026).
    const simdi = toDbDate(new Date());
    const ifadeler = Array.from({ length: quantity }, () => ({
      sql: `INSERT INTO "FilamentSpool" ("id", "name", "material", "colorName", "colorHex", "brand", "totalGrams",
              "remainingGrams", "spoolCost", "vendorUrl", "colorKey", "openedAt", "isActive", "createdAt", "updatedAt")
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
      args: [
        `spl_${randomUUID().replace(/-/g, "")}`,
        fields.name, fields.material, fields.colorName, fields.colorHex, fields.brand, fields.totalGrams,
        fields.remainingGrams, fields.spoolCost, fields.vendorUrl, fields.colorKey, simdi, simdi,
      ] as unknown[],
    }));
    if (!(await batchWrite(ifadeler))) {
      await prisma.$transaction(
        Array.from({ length: quantity }, () => prisma.filamentSpool.create({ data: fields }))
      );
    }

    await watchFilamentGroup(groupKey, label);
    bustInventoryAlertCaches(); // yeni makaralar → "filament azaldı" uyarısı 90 sn bayat kalmasın

    return NextResponse.json({ count: quantity }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
