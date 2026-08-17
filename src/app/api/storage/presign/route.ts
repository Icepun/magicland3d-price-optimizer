import { NextRequest, NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { getR2Config, presignPutUrl, makeModelKey, makeMeshKey } from "@/lib/r2";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const ALLOWED = ["gcode", "gco", "g", "3mf"];
/** Kaynak model (görüntüleme) — baskıya gönderilmez, ayrı önekte saklanır. */
const ALLOWED_MESH = ["stl", "obj", "3mf"];

/**
 * Yükleme için imzalı R2 PUT URL'i üretir. R2 yapılandırılmamışsa { mode: "local" } döner →
 * istemci eski yerel-disk yükleme akışına düşer (geriye uyumlu). Dosya tarayıcıdan DOĞRUDAN
 * R2'ye yüklenir; bu route yalnız kısa bir imza üretir (main process'ten 100MB geçmez).
 */
export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const body = (await req.json().catch(() => ({}))) as { originalName?: string; kind?: string };
    const name = String(body.originalName || "").trim();
    if (!name) return NextResponse.json({ error: "Dosya adı gerekli" }, { status: 400 });

    const mesh = body.kind === "mesh";
    const ext = (name.split(".").pop() || "").toLowerCase();
    const izinli = mesh ? ALLOWED_MESH : ALLOWED;
    if (!izinli.includes(ext)) {
      return NextResponse.json(
        { error: mesh ? `Desteklenmeyen tür: .${ext} (stl / obj / 3mf)` : `Desteklenmeyen tür: .${ext} (gcode / 3mf)` },
        { status: 400 },
      );
    }

    const cfg = await getR2Config();
    // Kaynak model YALNIZ bulutta saklanır: yerel-disk yolu baskı dosyaları için var ve
    // görüntüleme dosyasını oraya koymak diğer cihazlarda erişilemez kılardı.
    if (!cfg) return NextResponse.json(mesh ? { mode: "none" } : { mode: "local" });

    const key = mesh ? makeMeshKey(name) : makeModelKey(name);
    const uploadUrl = await presignPutUrl(key, cfg);
    return NextResponse.json({ mode: "r2", key, uploadUrl });
  } catch (error) {
    return jsonError(error);
  }
}
