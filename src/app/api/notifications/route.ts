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
export type AlertSeverity = "critical" | "warning" | "success";

export interface AppAlert {
  id: string;
  type: "stock" | "filament" | "printer" | "order";
  severity: AlertSeverity;
  title: string;
  body: string;
  href: string;
}

export async function GET() {
  const alerts: AppAlert[] = [];

  try {
    await ensureRuntimeSchema();

    const [lowStock, spools, printers, stored] = await Promise.all([
      prisma.product.findMany({
        where: { isActive: true, hidden: false, stock: { lte: 1 } },
        select: { id: true, name: true, stock: true },
        take: 50,
      }),
      prisma.filamentSpool.findMany({
        where: { isActive: true },
        select: { id: true, name: true, remainingGrams: true, reorderGrams: true },
      }),
      // Yazıcı durumları (relay yazar): hata = baskı durdu → acil; duraklatıldı = uyarı.
      prisma.printerSnapshot.findMany({
        select: { printerConfigId: true, name: true, status: true, statusMessage: true, online: true, productName: true },
      }).catch(() => []),
      // Kalıcı olay-anı bildirimleri (sipariş kaynaklı) — okunmamış olanlar.
      prisma.notification.findMany({
        where: { acknowledgedAt: null },
        orderBy: { createdAt: "desc" },
        take: 100,
      }).catch(() => []),
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

    for (const pr of printers) {
      const job = pr.productName ? ` — ${pr.productName}` : "";
      const reason = pr.statusMessage ? ` · ${pr.statusMessage}` : "";
      if (pr.status === "error") {
        // Kendi kendine durdu / hata → KIRMIZI + neden (varsa)
        alerts.push({
          id: `printer-${pr.printerConfigId}-error`,
          type: "printer",
          severity: "critical",
          title: "Baskı hatayla durdu",
          body: `${pr.name}${job}${reason}`,
          href: "/printers",
        });
      } else if (pr.status === "paused" && pr.online) {
        alerts.push({
          id: `printer-${pr.printerConfigId}-paused`,
          type: "printer",
          severity: "warning",
          title: "Baskı duraklatıldı",
          body: `${pr.name}${job}${reason}`,
          href: "/printers",
        });
      }
    }

    // Kalıcı olay-anı bildirimleri (sipariş + baskı-bitti). Severity KORUNUR (success/critical/warning),
    // tip bildirim tipinden türetilir (printer-* → "printer", diğeri → "order").
    for (const n of stored) {
      const sev: AlertSeverity =
        n.severity === "critical" ? "critical" : n.severity === "success" ? "success" : "warning";
      alerts.push({
        id: n.id,
        type: n.type?.startsWith("printer") ? "printer" : "order",
        severity: sev,
        title: n.title,
        body: n.body,
        href: n.href,
      });
    }
  } catch {
    /* tablo yoksa boş dön */
  }

  // Sıralama: kritik (kırmızı) → uyarı (sarı) → başarı (yeşil)
  const rank = (s: AlertSeverity) => (s === "critical" ? 0 : s === "warning" ? 1 : 2);
  alerts.sort((a, b) => rank(a.severity) - rank(b.severity));

  const critical = alerts.filter((a) => a.severity === "critical").length;
  const warning = alerts.filter((a) => a.severity === "warning").length;
  const success = alerts.filter((a) => a.severity === "success").length;
  return NextResponse.json({ alerts, counts: { total: alerts.length, critical, warning, success } });
}

/**
 * Bildirim(ler)i "okundu" işaretle — KALICI (sipariş) bildirimleri için cihazlar-arası.
 * Anlık hesaplanan (stok/filament/yazıcı) id'ler hiçbir satırla eşleşmez → zararsız no-op
 * (onlar istemcide localStorage ile gizlenir).
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    if (ids.length > 0) {
      await ensureRuntimeSchema();
      await prisma.notification.updateMany({
        where: { id: { in: ids } },
        data: { acknowledgedAt: new Date() },
      });
    }
  } catch {
    /* ignore */
  }
  return NextResponse.json({ ok: true });
}
