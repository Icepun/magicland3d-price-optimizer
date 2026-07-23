import { NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { getManualOrderOptions } from "@/lib/manual-orders";

export async function GET() {
  await ensureRuntimeSchema();
  return NextResponse.json(await getManualOrderOptions(), {
    headers: { "Cache-Control": "no-store" },
  });
}
