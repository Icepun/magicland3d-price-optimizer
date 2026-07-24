import { NextRequest, NextResponse } from "next/server";
import { remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { tlToKurus } from "@/lib/monthly-finance";
import {
  ActualExpenseInput,
  actualExpenseResponse,
  actualExpenseValidationError,
  optionalExpenseText,
} from "@/lib/actual-expenses";

export async function GET() {
  await ensureRuntimeSchema();
  const expenses = await remotePrisma.actualExpense.findMany({
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
  });
  return NextResponse.json(expenses.map(actualExpenseResponse), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const data = ActualExpenseInput.parse(await req.json());
    const expense = await remotePrisma.actualExpense.create({
      data: {
        name: data.name,
        category: optionalExpenseText(data.category),
        amountKurus: tlToKurus(data.amount),
        paidAt: data.paidAt,
        note: optionalExpenseText(data.note),
      },
    });
    return NextResponse.json(actualExpenseResponse(expense), { status: 201 });
  } catch (error) {
    const response = actualExpenseValidationError(error);
    if (response) return response;
    throw error;
  }
}
