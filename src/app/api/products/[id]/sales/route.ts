import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { DAY_MS, EXCLUDED_STATUS, coverageStart, toInt } from "@/lib/planner-insights";
import { dbEpochMs, parseDbDate } from "@/lib/sqlite-date";
import { urunSatisOzeti } from "@/lib/urun-satis";
import { kapsamBaslangiclari } from "@/lib/satis-hizi-veri";
import { parseManualOrderItems } from "@/lib/manual-orders";

/**
 * Ürün detayı "Satış Geçmişi": son 6 ay platform başına adet + satış hızı + stok kaç gün yeter.
 * Hesap @/lib/urun-satis (saf). Okuma Üretim Planı'nın satış hızıyla AYNI yol: iptal hariç,
 * tarih `dbEpochMs` ile normalize, kapsam başlangıcı aynı sorguda (TEK gidiş-dönüş).
 */
const PENCERE_GUN = 200; // 6 ay + pay

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const now = Date.now();
    const pencereBasi = now - PENCERE_GUN * DAY_MS;
    const [rows, manuel, urun, kapsamlar] = await Promise.all([
      prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT "platform","orderedAt","quantity"
           FROM "OrderItemSnapshot"
          WHERE "productId" = ?
            AND "statusKind" <> ?
            AND ${dbEpochMs("orderedAt")} >= ?`,
        id,
        EXCLUDED_STATUS,
        pencereBasi
      ),
      // MANUEL SİPARİŞLER sipariş kalemleri tablosuna yazılmıyor → kartta "Manuel" hep 0 ve "stok kaç
      // gün yeter" olduğundan uzun çıkıyordu (denetim). Kalemler JSON'da: kimlikle ön süzme, sonra
      // ayrıştırıp yalnız BU ürünün kalemleri sayılır.
      prisma.$queryRawUnsafe<Array<{ orderedAt: unknown; itemsJson: string }>>(
        `SELECT "orderedAt","itemsJson"
           FROM "ManualOrder"
          WHERE "statusKind" <> ?
            AND ${dbEpochMs("orderedAt")} >= ?
            AND instr("itemsJson", ?) > 0`,
        EXCLUDED_STATUS,
        pencereBasi,
        id
      ),
      prisma.product.findUnique({ where: { id }, select: { stock: true, madeToOrder: true } }),
      kapsamBaslangiclari(),
    ]);
    if (!urun) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const kapsam = coverageStart(kapsamlar);
    const manuelSatirlar = manuel.flatMap((m) => {
      const adet = parseManualOrderItems(m.itemsJson)
        .items.filter((it) => it.productId === id)
        .reduce((t, it) => t + (Number(it.quantity) || 0), 0);
      return adet > 0
        ? [{ platform: "manual", orderedAt: parseDbDate(m.orderedAt)?.getTime() ?? NaN, quantity: adet }]
        : [];
    });
    const ozet = urunSatisOzeti(
      [
        ...rows.map((r) => ({
          platform: String(r.platform ?? "diger"),
          orderedAt: parseDbDate(r.orderedAt)?.getTime() ?? NaN,
          quantity: toInt(r.quantity),
        })),
        ...manuelSatirlar,
      ],
      kapsam,
      now,
      // Sipariş üzerine üretilen üründe stok tutulmuyor → "kaç gün yeter" anlamsız.
      urun.madeToOrder ? null : urun.stock
    );
    return NextResponse.json(ozet, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
