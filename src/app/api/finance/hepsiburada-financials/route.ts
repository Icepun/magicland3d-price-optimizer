import { NextRequest, NextResponse } from "next/server";
import { bustActualCommissionCaches, bustProfitInputCaches } from "@/lib/cache-busting";
import { syncHepsiburadaFinancials } from "@/lib/hepsiburada-finance";

// Aynı anda tek tur: arka plan zamanlayıcısı ile elle tetikleme çakışırsa ikisi de aynı turu bekler.
let activeSync: Promise<Awaited<ReturnType<typeof syncHepsiburadaFinancials>>> | null = null;

export async function POST(req: NextRequest) {
  try {
    const requested = Number(req.nextUrl.searchParams.get("days") ?? 35);
    const days = Number.isFinite(requested) ? Math.max(1, Math.min(120, Math.trunc(requested))) : 35;

    if (!activeSync) {
      activeSync = syncHepsiburadaFinancials(days).finally(() => {
        activeSync = null;
      });
    }
    const result = await activeSync;
    // Yeni gerçek kayıt yazıldıysa sipariş ve rapor önbellekleri düşer; yazılmadıysa dokunulmaz.
    if (result.storedOrders > 0) bustActualCommissionCaches();
    // İlan bilgisi (kargoya verme süresi / KDV) değiştiyse Ürünler ve Panel yeniden hesaplansın.
    if (result.updatedListings > 0) bustProfitInputCaches();

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hepsiburada kesinti kayıtları alınamadı.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
