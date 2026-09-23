import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { familyMemberIds } from "@/core/printers/printer-family";
import { mevcutOzelBaskiOzeti } from "@/lib/custom-print-existing";

export const dynamic = "force-dynamic";

/**
 * Bu dosya (ad + boyut) bu yazıcının AİLESİNDE zaten yüklü mü?
 *
 * Neden: ikinci U1'de basmak için aynı dosya tekrar tekrar yükleniyordu (canlı veride 22 kopya,
 * 834 MB). Yükleme ekranı dosyayı göndermeden ÖNCE buraya sorar; varsa "zaten var, onu kullan"
 * der — hem bekleme hem bulut alanı boşa gitmez.
 */
export async function GET(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const sp = req.nextUrl.searchParams;
    const printerId = sp.get("printerId") || "";
    const name = sp.get("name") || "";
    const size = Number(sp.get("size"));
    if (!printerId || !name || !Number.isFinite(size) || size <= 0) {
      return NextResponse.json({ existing: null });
    }
    const aile = familyMemberIds(
      await prisma.printerConfig.findMany({ select: { id: true, type: true, brand: true, model: true } }),
      printerId,
    );
    return NextResponse.json({ existing: await mevcutOzelBaskiOzeti(aile, name, size) });
  } catch (error) {
    return jsonError(error);
  }
}
