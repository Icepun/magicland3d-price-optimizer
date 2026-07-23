import { NextResponse } from "next/server";
import { z } from "zod";
import { kurusToTl } from "./monthly-finance";

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

export function actualExpenseValidationError(error: unknown) {
  if (!(error instanceof z.ZodError)) return null;
  return NextResponse.json(
    { error: error.issues[0]?.message ?? "Geçersiz gider bilgisi" },
    { status: 400 }
  );
}
