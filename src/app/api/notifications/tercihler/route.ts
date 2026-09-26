import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api-error";
import { masaustuKapaliOku, masaustuKapaliYaz } from "@/lib/bildirim-tercihleri";

/**
 * BU BİLGİSAYARIN bildirim tercihi (yerel dosya — bkz. lib/bildirim-tercihleri).
 *   GET → { kapali: ["stok", …] }
 *   PUT { kapali: [...] } → kaydeder, temizlenmiş listeyi döner
 */
export async function GET() {
  return NextResponse.json({ kapali: masaustuKapaliOku() }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  try {
    const govde = (await req.json().catch(() => null)) as { kapali?: unknown } | null;
    if (!govde || !Array.isArray(govde.kapali)) {
      return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 });
    }
    const kapali = masaustuKapaliYaz(govde.kapali.filter((x): x is string => typeof x === "string"));
    return NextResponse.json({ kapali }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
