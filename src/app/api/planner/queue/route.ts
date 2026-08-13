import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/api-error";
import { swr } from "@/lib/route-cache";
import { computeQueue, parseTarget } from "@/lib/print-queue";
import { parseHedefModu, parseKapsamGun } from "@/core/planner-target";

export const dynamic = "force-dynamic";

/**
 * Baskı kuyruğu ucu. Türetmenin tamamı @/lib/print-queue içinde — bu dosya YALNIZ istek
 * işleyicisi barındırır (Next 16 rota dosyaları başka bir değer dışa açamaz).
 */
export async function GET(req: NextRequest) {
  try {
    const params = new URL(req.url).searchParams;
    const target = parseTarget(params.get("target"));
    const mod = parseHedefModu(params.get("mod"));
    const kapsamGun = parseKapsamGun(params.get("kapsam"));
    // Kısa ömürlü önbellek: ekran açık kalırken tekrar tekrar aynı sorguları yaptırmasın.
    // ⚠️ Anahtar hedef kuralının TAMAMINI taşımalı: mod/kapsam anahtara girmezse mod
    // değiştirildiğinde eski kuralla hesaplanmış kuyruk servis edilir ve ekran yalan söyler.
    const data = await swr(
      `planner-queue:v2:${target ?? "auto"}:${mod}:${kapsamGun}`,
      20_000,
      () => computeQueue(target, { mod, kapsamGun })
    );
    return NextResponse.json(data);
  } catch (error) {
    return jsonError(error);
  }
}
