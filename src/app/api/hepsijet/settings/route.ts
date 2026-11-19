import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hepsijetAcikAyarlar, hepsijetAyarlariniKaydet } from "@/services/hepsijet-settings";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const Schema = z.object({
  ortam: z.enum(["test", "prod"]),
  kullaniciAdi: z.string().trim().min(1, "Kullanıcı adı gerekli").max(120),
  sifre: z.string().max(200).optional(),
});

export async function GET() {
  try {
    return NextResponse.json(await hepsijetAcikAyarlar());
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    await hepsijetAyarlariniKaydet(Schema.parse(await req.json()));
    return NextResponse.json(await hepsijetAcikAyarlar());
  } catch (error) {
    return jsonError(error);
  }
}
