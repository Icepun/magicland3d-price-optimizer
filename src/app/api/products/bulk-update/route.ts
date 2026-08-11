import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { batchWrite } from "@/lib/libsql-batch";
import { bustProductViewCaches, bustProfitInputCaches } from "@/lib/cache-busting";
import { jsonError } from "@/lib/api-error";
import { z } from "zod";

/**
 * Seçili ürünlere TOPLU düzenleme — desi, kategori ve "sipariş üzerine üretilir" bayrağı.
 *
 * ⚠️ MALİYET ALANLARI BİLEREK YOK. Maliyet şablonu / hedef marjla fiyatlama bu uçtan
 * yapılamaz: kullanıcı maliyet-kâr rakamını değiştiren işlemleri ayrıca onaylamak istiyor.
 * Buraya maliyet alanı eklemeden önce ona sor.
 */

/** Kargo bareni en fazla bu desiye kadar anlamlı; üstü veri girişi hatasıdır. */
const MAX_DESI = 30;

/** SQLite değişken sınırına (999) dayanmasın diye kimlikler dilimlenir. */
const ID_CHUNK = 400;

const Schema = z
  .object({
    ids: z.array(z.string().min(1)).min(1, "En az bir ürün seç"),
    desi: z.number().positive().max(MAX_DESI).optional(),
    categoryName: z.string().trim().min(1).max(120).optional(),
    madeToOrder: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.desi !== undefined ||
      value.categoryName !== undefined ||
      value.madeToOrder !== undefined,
    { message: "Değiştirilecek bir alan seç" }
  );

type BulkUpdateInput = z.infer<typeof Schema>;

/** Yazılacak kolonlar → SQL parçası + değer. Sıra ikisinde de aynı olmak zorunda. */
function updateColumns(input: BulkUpdateInput): { sql: string[]; values: unknown[] } {
  const sql: string[] = [];
  const values: unknown[] = [];
  if (input.desi !== undefined) {
    sql.push(`"desi" = ?`);
    values.push(input.desi);
  }
  if (input.categoryName !== undefined) {
    sql.push(`"categoryName" = ?`);
    values.push(input.categoryName);
  }
  if (input.madeToOrder !== undefined) {
    sql.push(`"madeToOrder" = ?`);
    // SQLite'ta mantıksal değer 0/1 tamsayıdır.
    values.push(input.madeToOrder ? 1 : 0);
  }
  // updatedAt ham SQL'de kendiliğinden işlenmez; Prisma ile AYNI biçimde (epoch ms) yazılır,
  // yoksa Prisma bu satırların tarihini okurken çözemez.
  sql.push(`"updatedAt" = ?`);
  values.push(Date.now());
  return { sql, values };
}

/** Kimlikleri dilimlere böl — tek UPDATE bin kimlik taşıyamaz. */
export function chunkIds(ids: string[], size: number = ID_CHUNK): string[][] {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += size) {
    chunks.push(unique.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * Bu düzenleme kâr rakamını etkiler mi?
 * Desi kargoyu, kategori komisyon/paketleme kuralını seçer → ikisi de kâra girer.
 * "Sipariş üzerine üretilir" yalnız listeleri ve stok uyarısını etkiler.
 */
export function affectsProfitInputs(input: {
  desi?: number;
  categoryName?: string;
}): boolean {
  return input.desi !== undefined || input.categoryName !== undefined;
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = Schema.parse(await req.json());
    const chunks = chunkIds(input.ids);
    const { sql: setSql, values: setValues } = updateColumns(input);

    const statements = chunks.map((chunk) => ({
      sql: `UPDATE "Product" SET ${setSql.join(", ")} WHERE "id" IN (${chunk
        .map(() => "?")
        .join(",")})`,
      args: [...setValues, ...chunk],
    }));

    // Uzak-HTTP'de tek istek: her dilim ayrı gidersen her biri ~96ms ve tüm uygulama o süre
    // boyunca kuyrukta bekler. Uygun olmayan modda batchWrite false döner → sıralı yola düş.
    let updated = 0;
    if (!(await batchWrite(statements))) {
      const data: Record<string, unknown> = {};
      if (input.desi !== undefined) data.desi = input.desi;
      if (input.categoryName !== undefined) data.categoryName = input.categoryName;
      if (input.madeToOrder !== undefined) data.madeToOrder = input.madeToOrder;
      for (const chunk of chunks) {
        const result = await prisma.product.updateMany({
          where: { id: { in: chunk } },
          data,
        });
        updated += result.count;
      }
    } else {
      // Toplu yazımda etkilenen satır sayısı dönmüyor; kullanıcıya seçtiği adet bildirilir.
      updated = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    }

    if (affectsProfitInputs(input)) {
      bustProfitInputCaches();
    } else {
      bustProductViewCaches();
    }
    return NextResponse.json({ updated });
  } catch (error) {
    return jsonError(error, 400);
  }
}
