import { NextRequest, NextResponse } from "next/server";
import { testMoonraker } from "@/core/printers/moonraker";

export const dynamic = "force-dynamic";

/** Kaydetmeden önce Moonraker bağlantısını dene: /api/printers/test?host=192.168.1.18&port=7125 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const host = searchParams.get("host");
  const port = Number(searchParams.get("port") || 7125);
  if (!host) return NextResponse.json({ ok: false, error: "host gerekli" }, { status: 400 });
  const result = await testMoonraker(host, port);
  return NextResponse.json(result);
}
