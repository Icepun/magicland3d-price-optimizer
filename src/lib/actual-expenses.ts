import { NextResponse } from "next/server";
import { z } from "zod";
import { kurusToTl } from "./monthly-finance";
import { parseDbDate } from "./sqlite-date";

export const ActualExpenseInput = z.object({
  name: z.string().trim().min(1, "Gider adı boş olamaz").max(120),
  category: z.string().trim().max(60).nullable().optional(),
  amount: z
    .number()
    .finite()
    .positive("Tutar sıfırdan büyük olmalı")
    .max(21_474_836.47, "Tutar desteklenen sınırı aşıyor"),
  paidAt: z.coerce.date(),
  note: z.string().trim().max(500).nullable().optional(),
});

export function optionalExpenseText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function actualExpenseResponse(expense: {
  id: string;
  name: string;
  category: string | null;
  amountKurus: number;
  paidAt: Date;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const { amountKurus, ...rest } = expense;
  return { ...rest, amount: kurusToTl(amountKurus) };
}

/**
 * Ham SQL satırını arayüzün beklediği gövdeye çevirir.
 *
 * `recurringId` dolu olan satır TEKRARLAYAN KURALDAN otomatik açılmıştır; arayüz bunu
 * rozetle gösteriyor ki kullanıcı "bunu ben mi girdim" diye tereddüt etmesin.
 */
export function expenseRowResponse(row: Record<string, unknown>) {
  const kurus = typeof row.amountKurus === "bigint" ? Number(row.amountKurus) : Number(row.amountKurus ?? 0);
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    category: row.category == null ? null : String(row.category),
    amount: kurusToTl(kurus),
    paidAt: parseDbDate(row.paidAt)?.toISOString() ?? null,
    note: row.note == null ? null : String(row.note),
    recurringId: row.recurringId == null ? null : String(row.recurringId),
    createdAt: parseDbDate(row.createdAt)?.toISOString() ?? null,
    updatedAt: parseDbDate(row.updatedAt)?.toISOString() ?? null,
  };
}

export function actualExpenseValidationError(error: unknown) {
  if (!(error instanceof z.ZodError)) return null;
  return NextResponse.json(
    { error: error.issues[0]?.message ?? "Geçersiz gider bilgisi" },
    { status: 400 }
  );
}
