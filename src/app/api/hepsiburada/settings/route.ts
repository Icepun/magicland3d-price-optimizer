import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getPublicHepsiburadaSettings, saveHepsiburadaSettings } from "@/services/hepsiburada-settings";
import { jsonError } from "@/lib/api-error";

const Schema = z.object({
  merchantId: z.string().min(1, "merchantId zorunlu"),
  username: z.string().optional(),
  password: z.string().optional(),
});

const emptySettings = { merchantId: "", hasUsername: false, hasPassword: false, usernameMasked: "", passwordMasked: "" };

export async function GET() {
  try {
    return NextResponse.json(await getPublicHepsiburadaSettings());
  } catch (error) {
    console.error("Could not load Hepsiburada settings", error);
    return NextResponse.json(emptySettings);
  }
}

export async function POST(req: NextRequest) {
  try {
    const data = Schema.parse(await req.json());
    await saveHepsiburadaSettings(data);
    return NextResponse.json(await getPublicHepsiburadaSettings());
  } catch (error) {
    return jsonError(error);
  }
}
