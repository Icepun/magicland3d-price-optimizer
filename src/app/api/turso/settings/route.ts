import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  clearTursoSettings,
  getPublicTursoSettings,
  saveTursoSettings,
} from "@/services/turso-settings";
import { jsonError } from "@/lib/api-error";

export async function GET() {
  try {
    return NextResponse.json(await getPublicTursoSettings());
  } catch (error) {
    return jsonError(error);
  }
}

const SaveSchema = z.object({
  url: z.string().min(1, "Turso URL gerekli"),
  authToken: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = SaveSchema.parse(await req.json());
    await saveTursoSettings(body);
    return NextResponse.json(await getPublicTursoSettings());
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE() {
  try {
    await clearTursoSettings();
    return NextResponse.json(await getPublicTursoSettings());
  } catch (error) {
    return jsonError(error);
  }
}
