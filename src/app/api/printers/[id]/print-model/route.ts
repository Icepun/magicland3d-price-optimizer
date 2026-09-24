import { NextRequest, NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { resolvePrintModel } from "@/lib/print-model-resolve";

export const dynamic = "force-dynamic";

/**
 * Yazıcıda ŞU AN basılan işi (currentFilename) bir model kaydına eşler → kartın "canlı dolan
 * model" görselleştirmesi, dosyayı YENİDEN yüklemeye gerek kalmadan var olan modeli kullanır.
 *
 * Eşleştirme mantığı `@/lib/print-model-resolve`te — telefona 3B taşıyan aktarıcı da aynısını
 * kullanır (iki uç aynı baskıya farklı model eşlemesin).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const filename = req.nextUrl.searchParams.get("filename") || "";
    return NextResponse.json({ model: await resolvePrintModel(id, filename) });
  } catch (error) {
    return jsonError(error);
  }
}
