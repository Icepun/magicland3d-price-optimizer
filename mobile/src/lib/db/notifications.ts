import { query } from "@/lib/turso";

export type AlertType = "stock" | "filament" | "print";
export type Severity = "critical" | "warning";

export interface AppAlert {
  id: string;
  type: AlertType;
  severity: Severity;
  title: string;
  body: string;
  productId: string | null; // tıklanınca ürün detayına gitmek için
}

export interface NotificationsResult {
  alerts: AppAlert[];
  counts: { total: number; critical: number; warning: number };
}

/**
 * Bildirimler anlık hesaplanır (kalıcı tablo yok — masaüstü /api/notifications ile aynı kural):
 * - Stok ≤ 1  → kritik (0) / uyarı
 * - Filament ≤ reorderGrams → kritik (0) / uyarı
 */
export async function getNotifications(): Promise<NotificationsResult> {
  const alerts: AppAlert[] = [];

  const lowStock = await query<{ id: string; name: string; stock: number }>(
    `SELECT id, name, stock FROM Product
      WHERE isActive = 1 AND hidden = 0 AND stock <= 1
      ORDER BY stock ASC LIMIT 50`
  ).catch(() => []);
  for (const p of lowStock) {
    const crit = p.stock <= 0;
    alerts.push({
      id: `stock-${p.id}`,
      type: "stock",
      severity: crit ? "critical" : "warning",
      title: crit ? "Stok bitti" : "Stok kritik",
      body: `${p.name} — ${crit ? "0" : p.stock} adet`,
      productId: p.id,
    });
  }

  const lowSpool = await query<{
    id: string;
    name: string;
    remainingGrams: number;
    reorderGrams: number;
  }>(
    `SELECT id, name, remainingGrams, reorderGrams FROM FilamentSpool
      WHERE isActive = 1 AND remainingGrams <= reorderGrams
      ORDER BY remainingGrams ASC`
  ).catch(() => []);
  for (const s of lowSpool) {
    const crit = s.remainingGrams <= 0;
    alerts.push({
      id: `spool-${s.id}`,
      type: "filament",
      severity: crit ? "critical" : "warning",
      title: crit ? "Filament bitti" : "Filament azaldı",
      body: `${s.name} — ${Math.round(s.remainingGrams)}g kaldı`,
      productId: null,
    });
  }

  // Yazıcı baskı bildirimleri — masaüstü relay PrinterSnapshot'a yazar (bitti/hata).
  const printAlerts = await query<{ name: string; status: string; productName: string | null }>(
    `SELECT name, status, productName FROM PrinterSnapshot WHERE status IN ('finished', 'error')`
  ).catch(() => []);
  for (const pr of printAlerts) {
    const err = pr.status === "error";
    alerts.push({
      id: `print-${pr.name}`,
      type: "print",
      severity: err ? "critical" : "warning",
      title: err ? "Baskı hatası" : "Baskı tamamlandı",
      body: pr.productName ? `${pr.name} — ${pr.productName}` : pr.name,
      productId: null,
    });
  }

  alerts.sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1
  );
  const critical = alerts.filter((a) => a.severity === "critical").length;
  return {
    alerts,
    counts: { total: alerts.length, critical, warning: alerts.length - critical },
  };
}
