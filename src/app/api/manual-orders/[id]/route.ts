import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import {
  ManualOrderInputSchema,
  manualOrderDetailResponse,
  manualOrderValidationMessage,
  updateManualOrder,
} from "@/lib/manual-orders";

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2025"
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();
  const { id } = await params;
  const order = await prisma.manualOrder.findUnique({ where: { id } });
  if (!order) {
    return NextResponse.json(
      { error: "Manuel sipariş bulunamadı." },
      { status: 404 }
    );
  }
  return NextResponse.json(manualOrderDetailResponse(order), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const input = ManualOrderInputSchema.parse(await req.json());
    const order = await updateManualOrder(id, input);
    invalidateOrdersCache();
    return NextResponse.json(manualOrderDetailResponse(order));
  } catch (error) {
    const message = manualOrderValidationMessage(error);
    if (message) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    if (isNotFound(error)) {
      return NextResponse.json(
        { error: "Manuel sipariş bulunamadı." },
        { status: 404 }
      );
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Bu manuel sipariş numarası zaten kullanılıyor." },
        { status: 409 }
      );
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
    await prisma.manualOrder.delete({ where: { id } });
    invalidateOrdersCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json(
        { error: "Manuel sipariş bulunamadı." },
        { status: 404 }
      );
    }
    throw error;
  }
}
