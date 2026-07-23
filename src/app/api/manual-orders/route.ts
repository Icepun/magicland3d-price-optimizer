import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import {
  ManualOrderInputSchema,
  createManualOrder,
  manualOrderDetailResponse,
  manualOrderValidationMessage,
} from "@/lib/manual-orders";

export async function GET() {
  await ensureRuntimeSchema();
  const orders = await prisma.manualOrder.findMany({
    orderBy: [{ orderedAt: "desc" }, { createdAt: "desc" }],
  });
  return NextResponse.json(orders.map(manualOrderDetailResponse), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = ManualOrderInputSchema.parse(await req.json());
    const order = await createManualOrder(input);
    invalidateOrdersCache();
    return NextResponse.json(manualOrderDetailResponse(order), { status: 201 });
  } catch (error) {
    const message = manualOrderValidationMessage(error);
    if (message) {
      return NextResponse.json({ error: message }, { status: 400 });
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
