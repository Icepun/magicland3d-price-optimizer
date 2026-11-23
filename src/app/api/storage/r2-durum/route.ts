import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-error";

/** R2 gizli anahtarları kayıtlı mı? Değerleri DEĞİL, yalnız var/yok bilgisini döner. */
export async function GET() {
  try {
    const satirlar = await prisma.appSetting.findMany({
      where: { key: { in: ["r2AccessKeyId", "r2SecretKey"] } },
      select: { key: true, value: true },
    });
    const var_ = (k: string) => satirlar.some((r) => r.key === k && !!r.value?.trim());
    return NextResponse.json({ erisimAnahtariKayitli: var_("r2AccessKeyId"), gizliAnahtarKayitli: var_("r2SecretKey") });
  } catch (error) {
    return jsonError(error);
  }
}
