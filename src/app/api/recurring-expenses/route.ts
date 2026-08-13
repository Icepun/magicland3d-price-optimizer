import { NextRequest, NextResponse } from "next/server";
import { bustFinanceCaches } from "@/lib/cache-busting";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  RecurringInput,
  createRecurring,
  expenseAdminValidationError,
  listRecurring,
} from "@/lib/expense-admin";
import { ensureRecurringExpenses } from "@/lib/recurring-expense-run";

/** Tekrarlayan sabit giderler — mantık @/lib/expense-admin içinde. */
export async function GET() {
  await ensureRuntimeSchema();
  return NextResponse.json(await listRecurring(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = RecurringInput.parse(await req.json());
    const rows = await createRecurring(input);
    // Yeni kural geçmiş ayları da kapsıyor olabilir → kayıtlar hemen açılsın ve aylık
    // net kâr önbelleği tazelensin (gider kâra giriyor).
    await ensureRecurringExpenses();
    bustFinanceCaches();
    return NextResponse.json(rows, { status: 201 });
  } catch (error) {
    const response = expenseAdminValidationError(error);
    if (response) return response;
    throw error;
  }
}
