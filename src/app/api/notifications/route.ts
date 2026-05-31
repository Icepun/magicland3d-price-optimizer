import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Bildirim altyapısı — şu an aksiyon gerektiren uyarıları hesaplar (kalıcı tablo yok;
 * istemci localStorage ile "okundu" tutar). Mobil de bu endpoint'i okuyabilir.
 * Yazıcılar bağlanınca "baskı bitti/başarısız" buraya eklenecek.
 *
 * Kaynaklar (ucuz DB okuması): düşük/biten stok + düşük/biten filament makara.
 */
export type AlertSeverity = "critical" | "warning";

export interface AppAlert {
  id: string;
  type: "stock" | "filament";
  severity: AlertSeverity;
  title: string;
  body: string;
  href: string;
}

export async function GET() {
  const alerts: AppAlert[] = [];

  try {
    await ensureRuntimeSchema();

    const [lowStock, spools] = await Promise.all([
      prisma.product.findMany({
        where: { isActive: true, hidden: false, stock: { lte: 1 } },
        select: { id: true, name: true, stock: true },
        take: 50,
      }),
      prisma.filamentSpool.findMany({
        where: { isActive: true },
        select: { id: true, name: true, remainingGrams: true, reorderGrams: true },
      }),
    ]);

    for (const p of lowStock) {
      const empty = p.stock <= 0;
      alerts.push({
        id: `stock-${p.id}`,
        type: "stock",
        severity: empty ? "critical" : "warning",
        title: empty ? "Stok bitti" : "Stok kritik",
        body: `${p.name} — ${p.stock} adet`,
        href: `/products/${p.id}`,
      });
    }

    for (const s of spools.filter((x) => x.remainingGrams <= x.reorderGrams)) {
      const empty = s.remainingGrams <= 0;
      alerts.push({
        id: `spool-${s.id}`,
        type: "filament",
        severity: empty ? "critical" : "warning",
        title: empty ? "Filament bitti" : "Filament azaldı",
        body: `${s.name} — ${Math.round(s.remainingGrams)} g kaldı`,
        href: "/spools",
      });
    }
  } catch {
    /* tablo yoksa boş dön */
  }

  // Kritikler üstte
  alerts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));

  const critical = alerts.filter((a) => a.severity === "critical").length;
  return NextResponse.json({ alerts, counts: { total: alerts.length, critical, warning: alerts.length - critical } });
}
