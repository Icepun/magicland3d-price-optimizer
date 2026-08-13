import { NextRequest, NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  CategoryInput,
  deleteCategory,
  expenseAdminValidationError,
  updateCategory,
} from "@/lib/expense-admin";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const input = CategoryInput.parse(await req.json());
    return NextResponse.json(await updateCategory(id, input));
  } catch (error) {
    const response = expenseAdminValidationError(error);
    if (response) return response;
    throw error;
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ensureRuntimeSchema();
  const { id } = await params;
  return NextResponse.json(await deleteCategory(id));
}
