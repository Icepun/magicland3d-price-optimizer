import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { tlToKurus } from "@/lib/monthly-finance";
import {
  ActualExpenseInput,
  actualExpenseResponse,
  actualExpenseValidationError,
  optionalExpenseText,
} from "@/lib/actual-expenses";

const UpdateActualExpenseInput = ActualExpenseInput.partial().refine(
  (value) => Object.keys(value).length > 0,
  "Güncellenecek alan bulunamadı"
);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const data = UpdateActualExpenseInput.parse(await req.json());
    const expense = await prisma.actualExpense.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.category !== undefined
          ? { category: optionalExpenseText(data.category) }
          : {}),
        ...(data.amount !== undefined ? { amountKurus: tlToKurus(data.amount) } : {}),
        ...(data.paidAt !== undefined ? { paidAt: data.paidAt } : {}),
        ...(data.note !== undefined ? { note: optionalExpenseText(data.note) } : {}),
      },
    });
    return NextResponse.json(actualExpenseResponse(expense));
  } catch (error) {
    const response = actualExpenseValidationError(error);
    if (response) return response;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Gider kaydı bulunamadı" }, { status: 404 });
    }
    throw error;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();
  const { id } = await params;
  try {
    await prisma.actualExpense.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Gider kaydı bulunamadı" }, { status: 404 });
    }
    throw error;
  }
}
