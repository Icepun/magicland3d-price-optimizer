import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { n11AcikAyarlar, n11AyarlariniKaydet } from "@/services/n11-settings";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const Schema = z.object({
  appKey: z.string().trim().max(200).optional(),
  appSecret: z.string().trim().max(200).optional(),
});

/** n11 API bilgileri — kart yalnız "girildi mi" bilgisini görür, değerler geri dönmez. */
export async function GET() {
  try {
    return NextResponse.json(await n11AcikAyarlar());
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    await n11AyarlariniKaydet(Schema.parse(await req.json()));
    return NextResponse.json(await n11AcikAyarlar());
  } catch (error) {
    return jsonError(error);
  }
}
