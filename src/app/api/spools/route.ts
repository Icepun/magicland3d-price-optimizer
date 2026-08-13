import { NextRequest, NextResponse } from "next/server";
import { bustInventoryAlertCaches } from "@/lib/cache-busting";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { SpoolInputSchema, buildSpoolFields } from "@/lib/filament-spool-input";
import { watchFilamentGroup } from "@/lib/filament-settings";

/**
 * Stoktaki makaralar.
 *
 * Buradan eskiden bir de "makaranın gerçek gram maliyeti maliyet tablosundan sapıyor mu"
 * karşılaştırması dönüyordu; onunla birlikte `FilamentType` okuması da kalktı. Gerekçe:
 * arayüzde artık gösterilmiyor ve 34 makaranın hiçbirinde alış bedeli girili değil, yani
 * sonuç her zaman boştu. Uzak veritabanında her sorgu sıraya girdiği için bu, sayfa
 * açılışından silinen gerçek bir bekleme. Ürün maliyeti/kâr hesabına dokunmaz — o değerler
 * `FilamentType.costPerGram` üzerinden hesaplanmaya devam eder.
 */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    const spools = await prisma.filamentSpool.findMany({
      where: { isActive: true },
      orderBy: [{ remainingGrams: "asc" }, { name: "asc" }],
    });
    return NextResponse.json(spools);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = SpoolInputSchema.parse(await req.json());
    const { fields, groupKey, label } = buildSpoolFields(input);
    const spool = await prisma.filamentSpool.create({ data: fields });
    // Grubu kalıcı izlemeye al → son makara silinse bile "bitti" uyarısı çıkabilsin.
    await watchFilamentGroup(groupKey, label);
    // Uyarı taraması hem makarayı hem izleme kaydını okur; bu yüzden ikisi de yazıldıktan
    // SONRA düşülür — arada düşülse tarama eski hâli yeniden önbelleğe alabilirdi.
    bustInventoryAlertCaches(); // yeni makara → "filament azaldı" taraması tazelensin
    return NextResponse.json(spool, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
