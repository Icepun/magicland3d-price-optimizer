import { NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { readCargoCoverage } from "@/lib/cargo-coverage";

/**
 * Kargo kapsamı — hesabın tamamı @/lib/cargo-coverage içinde (rota yalnız işleyici barındırır;
 * Next 16 rota dosyaları başka bir değer dışa açamaz).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureRuntimeSchema();
    return NextResponse.json(await readCargoCoverage(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}
