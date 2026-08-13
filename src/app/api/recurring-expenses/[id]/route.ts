import { NextRequest, NextResponse } from "next/server";
import { bustFinanceCaches } from "@/lib/cache-busting";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  RecurringInput,
  deleteRecurring,
  expenseAdminValidationError,
  updateRecurring,
} from "@/lib/expense-admin";
import { ensureRecurringExpenses } from "@/lib/recurring-expense-run";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const input = RecurringInput.parse(await req.json());
    const rows = await updateRecurring(id, input);
    await ensureRecurringExpenses();
    bustFinanceCaches();
    return NextResponse.json(rows);
  } catch (error) {
    const response = expenseAdminValidationError(error);
    if (response) return response;
    throw error;
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ensureRuntimeSchema();
  const { id } = await params;
  const rows = await deleteRecurring(id);
  bustFinanceCaches();
  return NextResponse.json(rows);
}
