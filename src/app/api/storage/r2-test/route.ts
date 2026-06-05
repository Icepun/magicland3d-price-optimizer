import { NextRequest, NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { getR2Config, headBucket, presignPutUrl } from "@/lib/r2";

export const dynamic = "force-dynamic";

/**
 * "Bağlantıyı test et": (1) sunucu tarafı — creds + bucket doğru mu (HeadBucket); (2) tarayıcının
 * CORS round-trip'ini yapabilmesi için minik bir imzalı PUT URL döndür. İstemci o URL'e birkaç
 * bayt PUT ederek CORS'un açık olduğunu doğrular (yoksa gerçek yüklemede patlardı).
 */
export async function POST(_req: NextRequest) {
  await ensureRuntimeSchema();
  const cfg = await getR2Config();
  if (!cfg) {
    return NextResponse.json(
      { ok: false, error: "R2 bilgileri eksik — Account ID, Bucket, Access Key ve Secret'ı doldur." },
      { status: 400 }
    );
  }
  try {
    await headBucket(cfg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: `Kimlik/bucket hatası: ${msg}` },
      { status: 400 }
    );
  }
  // Sabit anahtar → her testte üzerine yazılır, bucket'ı şişirmez.
  const corsTestUrl = await presignPutUrl("models/_cors-test.txt", cfg);
  return NextResponse.json({ ok: true, corsTestUrl });
}
