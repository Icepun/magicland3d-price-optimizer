import { NextRequest, NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { getR2Config, presignPutUrl, makeModelKey } from "@/lib/r2";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const ALLOWED = ["gcode", "gco", "g", "3mf"];

/**
 * Yükleme için imzalı R2 PUT URL'i üretir. R2 yapılandırılmamışsa { mode: "local" } döner →
 * istemci eski yerel-disk yükleme akışına düşer (geriye uyumlu). Dosya tarayıcıdan DOĞRUDAN
 * R2'ye yüklenir; bu route yalnız kısa bir imza üretir (main process'ten 100MB geçmez).
 */
export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const body = (await req.json().catch(() => ({}))) as { originalName?: string };
    const name = String(body.originalName || "").trim();
    if (!name) return NextResponse.json({ error: "Dosya adı gerekli" }, { status: 400 });

    const ext = (name.split(".").pop() || "").toLowerCase();
    if (!ALLOWED.includes(ext)) {
      return NextResponse.json({ error: `Desteklenmeyen tür: .${ext} (gcode / 3mf)` }, { status: 400 });
    }

    const cfg = await getR2Config();
    if (!cfg) return NextResponse.json({ mode: "local" });

    const key = makeModelKey(name);
    const uploadUrl = await presignPutUrl(key, cfg);
    return NextResponse.json({ mode: "r2", key, uploadUrl });
  } catch (error) {
    return jsonError(error);
  }
}
