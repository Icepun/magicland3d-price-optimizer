import { NextRequest, NextResponse } from "next/server";
import { kargoMahalleleri } from "@/lib/kargo/hepsijet-gonder";
import { kargoHataYaniti } from "@/lib/kargo/api-yanit";

export const dynamic = "force-dynamic";

/** Seçilen il/ilçenin HepsiJet mahalle listesi. */
export async function GET(req: NextRequest) {
  const il = req.nextUrl.searchParams.get("il")?.trim() ?? "";
  const ilce = req.nextUrl.searchParams.get("ilce")?.trim() ?? "";
  if (!il || !ilce) return NextResponse.json({ mahalleler: [] });
  try {
    return NextResponse.json({ mahalleler: await kargoMahalleleri(il, ilce) });
  } catch (error) {
    return kargoHataYaniti(error);
  }
}
