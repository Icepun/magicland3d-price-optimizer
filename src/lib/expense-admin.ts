import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { remotePrisma } from "@/lib/prisma";
import { parseDbDate, toDbDate } from "@/lib/sqlite-date";
import { KATEGORI_RENKLERI } from "./expense-admin-shared";

/**
 * Gider kategorileri ve tekrarlayan sabit giderler — ortak okuma/yazma yardımcıları.
 *
 * HAM SQL kullanılıyor: `ExpenseCategory` ve `RecurringExpense` şemaya bu sürümde eklendi,
 * üretilmiş Prisma istemcisi henüz tanımıyor (aynı yol `planner-insights` ucunda da var).
 *
 * ⚠️ Rota dosyaları yalnız istek işleyicisi dışa açabildiği için mantık BURADA duruyor
 * (Next 16; `tsc` bunu yakalamaz, yalnız `next build` görür).
 */

/* ─────────────────────────── Kategoriler ─────────────────────────── */

export { KATEGORI_RENKLERI } from "./expense-admin-shared";

export const CategoryInput = z.object({
  name: z.string().trim().min(1, "Kategori adı boş olamaz").max(60),
  color: z.string().trim().max(40).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export interface KategoriSatiri {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
}

export async function listCategories(): Promise<KategoriSatiri[]> {
  const rows = await remotePrisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id","name","color","sortOrder" FROM "ExpenseCategory"
      ORDER BY "sortOrder" ASC, "name" ASC`
  );
  return rows.map((r, i) => ({
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    // Renk girilmemişse sıraya göre sabit bir renk ver: aynı kategori her açılışta
    // AYNI rengi alsın, yoksa grafik her yenilemede renk değiştirir.
    color: r.color == null ? KATEGORI_RENKLERI[i % KATEGORI_RENKLERI.length] : String(r.color),
    sortOrder: Number(r.sortOrder ?? 0),
  }));
}

export async function createCategory(input: z.infer<typeof CategoryInput>) {
  const now = toDbDate(new Date());
  const id = randomUUID();
  await remotePrisma.$executeRawUnsafe(
    `INSERT OR IGNORE INTO "ExpenseCategory" ("id","name","color","sortOrder","createdAt","updatedAt")
     VALUES (?,?,?,?,?,?)`,
    id, input.name, input.color ?? null, input.sortOrder ?? 0, now, now
  );
  return listCategories();
}

export async function updateCategory(id: string, input: z.infer<typeof CategoryInput>) {
  await remotePrisma.$executeRawUnsafe(
    `UPDATE "ExpenseCategory" SET "name"=?, "color"=?, "sortOrder"=?, "updatedAt"=? WHERE "id"=?`,
    input.name, input.color ?? null, input.sortOrder ?? 0, toDbDate(new Date()), id
  );
  return listCategories();
}

export async function deleteCategory(id: string) {
  // Gider kayıtlarındaki kategori METNİ korunur: kategori silinince geçmiş harcamanın
  // nereye gittiği kaybolmasın.
  await remotePrisma.$executeRawUnsafe(`DELETE FROM "ExpenseCategory" WHERE "id"=?`, id);
  return listCategories();
}

/* ─────────────────────── Tekrarlayan giderler ─────────────────────── */

export const RecurringInput = z.object({
  name: z.string().trim().min(1, "Gider adı boş olamaz").max(120),
  category: z.string().trim().max(60).nullable().optional(),
  amount: z.number().finite().positive("Tutar sıfırdan büyük olmalı").max(21_474_836.47),
  dayOfMonth: z.number().int().min(1).max(31),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  isActive: z.boolean().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export interface TekrarSatiri {
  id: string;
  name: string;
  category: string | null;
  amount: number;
  dayOfMonth: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  note: string | null;
}

function tekrarSatiri(r: Record<string, unknown>): TekrarSatiri {
  const kurus = typeof r.amountKurus === "bigint" ? Number(r.amountKurus) : Number(r.amountKurus ?? 0);
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    category: r.category == null ? null : String(r.category),
    amount: kurus / 100,
    dayOfMonth: Number(r.dayOfMonth ?? 1),
    startsAt: parseDbDate(r.startsAt)?.toISOString() ?? null,
    endsAt: parseDbDate(r.endsAt)?.toISOString() ?? null,
    isActive: Number(r.isActive ?? 0) !== 0,
    note: r.note == null ? null : String(r.note),
  };
}

export async function listRecurring(): Promise<TekrarSatiri[]> {
  const rows = await remotePrisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id","name","category","amountKurus","dayOfMonth","startsAt","endsAt","isActive","note"
       FROM "RecurringExpense" ORDER BY "isActive" DESC, "name" ASC`
  );
  return rows.map(tekrarSatiri);
}

export async function createRecurring(input: z.infer<typeof RecurringInput>) {
  const now = toDbDate(new Date());
  await remotePrisma.$executeRawUnsafe(
    `INSERT INTO "RecurringExpense"
       ("id","name","category","amountKurus","dayOfMonth","startsAt","endsAt","isActive","note","createdAt","updatedAt")
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(),
    input.name,
    input.category ?? null,
    Math.round(input.amount * 100),
    input.dayOfMonth,
    toDbDate(input.startsAt),
    input.endsAt ? toDbDate(input.endsAt) : null,
    input.isActive === false ? 0 : 1,
    input.note ?? null,
    now,
    now
  );
  return listRecurring();
}

export async function updateRecurring(id: string, input: z.infer<typeof RecurringInput>) {
  await remotePrisma.$executeRawUnsafe(
    `UPDATE "RecurringExpense"
        SET "name"=?, "category"=?, "amountKurus"=?, "dayOfMonth"=?, "startsAt"=?, "endsAt"=?,
            "isActive"=?, "note"=?, "updatedAt"=?
      WHERE "id"=?`,
    input.name,
    input.category ?? null,
    Math.round(input.amount * 100),
    input.dayOfMonth,
    toDbDate(input.startsAt),
    input.endsAt ? toDbDate(input.endsAt) : null,
    input.isActive === false ? 0 : 1,
    input.note ?? null,
    toDbDate(new Date()),
    id
  );
  return listRecurring();
}

/**
 * Kuralı siler. Şimdiye kadar ÜRETİLMİŞ gider kayıtlarına DOKUNMAZ — onlar gerçekten
 * ödenmiş paradır; kural kaldırıldı diye geçmiş aylardaki kâr değişmemeli. Yalnız
 * bağları koparılır ki kayıtlar artık "otomatik" rozetiyle görünmesin.
 */
export async function deleteRecurring(id: string) {
  await remotePrisma.$executeRawUnsafe(
    `UPDATE "ActualExpense" SET "recurringId"=NULL, "periodKey"=NULL WHERE "recurringId"=?`,
    id
  );
  await remotePrisma.$executeRawUnsafe(`DELETE FROM "RecurringExpense" WHERE "id"=?`, id);
  return listRecurring();
}

export function expenseAdminValidationError(error: unknown) {
  if (!(error instanceof z.ZodError)) return null;
  return NextResponse.json(
    { error: error.issues[0]?.message ?? "Geçersiz bilgi" },
    { status: 400 }
  );
}
