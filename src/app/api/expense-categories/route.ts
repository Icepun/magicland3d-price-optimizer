import { NextRequest, NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  CategoryInput,
  createCategory,
  expenseAdminValidationError,
  listCategories,
} from "@/lib/expense-admin";

/** Gider kategorileri — mantık @/lib/expense-admin içinde (rota yalnız işleyici barındırır). */
export async function GET() {
  await ensureRuntimeSchema();
  return NextResponse.json(await listCategories(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = CategoryInput.parse(await req.json());
    return NextResponse.json(await createCategory(input), { status: 201 });
  } catch (error) {
    const response = expenseAdminValidationError(error);
    if (response) return response;
    throw error;
  }
}
