import { batch, execute } from "@/lib/turso";

export type AlertType = "stock" | "filament" | "print" | "order";
export type Severity = "critical" | "warning" | "success";

export interface AppAlert {
  id: string;
  type: AlertType;
  severity: Severity;
  title: string;
  body: string;
  productId: string | null; // tıklanınca ürün detayına gitmek için
  /** Kalıcı Notification tablosundan mı (ack'lenebilir) yoksa anlık hesaplanan mı? */
  persistent: boolean;
  /** Kalıcı bildirimin oluşturulma zamanı (epoch ms) — anlık uyarılarda null. */
  createdAt: number | null;
}

export interface NotificationsResult {
  alerts: AppAlert[];
  counts: { total: number; critical: number; warning: number };
}

/** SQLite'ın iki tarih biçimini de güvenle çöz: Prisma ISO ("...T...+00:00"/Z) ve raw
 *  CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC ama T'siz — yerel sanılırsa 3 saat kayar). */
function parseDbDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? s.replace(" ", "T") + "Z" : s;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Bildirimler = KALICI tablo + anlık hesaplananlar (masaüstü /api/notifications ile aynı model):
 * - Kalıcı `Notification` (relay + orders route yazar: baskı bitti/hata, stoğu bitene sipariş,
 *   sipariş-üzerine üretim) → acknowledgedAt IS NULL olanlar; "okundu" iki cihazda da düşer.
 * - Anlık: stok ≤ 1, filament ≤ reorderGrams, yazıcı ERROR/PAUSED canlı durumu (kayan snapshot).
 *   NOT: "finished" artık canlı üretilmez — kalıcı printer-done kaydı taşır (eski davranış uyarıyı
 *   bir sonraki baskıya kadar kapatılamaz şekilde tekrarlıyordu).
 * Tamamı TEK round-trip (batch 4 sorgu).
 */
export async function getNotifications(): Promise<NotificationsResult> {
  const [persistentRes, stockRes, spoolRes, printRes] = await batch([
    {
      sql: `SELECT id, type, severity, title, body, href, createdAt
              FROM Notification
             WHERE acknowledgedAt IS NULL
             ORDER BY createdAt DESC LIMIT 50`,
    },
    {
      sql: `SELECT id, name, stock FROM Product
             WHERE isActive = 1 AND hidden = 0 AND madeToOrder = 0 AND stock <= 1
             ORDER BY stock ASC LIMIT 50`,
    },
    {
      sql: `SELECT id, name, remainingGrams, reorderGrams FROM FilamentSpool
             WHERE isActive = 1 AND remainingGrams <= reorderGrams
             ORDER BY remainingGrams ASC`,
    },
    {
      sql: `SELECT printerConfigId, name, status, statusMessage, productName
              FROM PrinterSnapshot WHERE status IN ('error', 'paused')`,
    },
  ]).catch(
    () =>
      [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }] as {
        rows: Record<string, unknown>[];
      }[]
  );

  const alerts: AppAlert[] = [];

  // 1) Kalıcı bildirimler (okunana dek görünür; masaüstü zil + mobil aynı kaynağı okur).
  for (const raw of persistentRes.rows as unknown as {
    id: string;
    type: string;
    severity: string;
    title: string;
    body: string;
    href: string | null;
    createdAt: string | null;
  }[]) {
    const sev: Severity =
      raw.severity === "critical" || raw.severity === "warning" || raw.severity === "success"
        ? raw.severity
        : "warning";
    alerts.push({
      id: raw.id,
      type: raw.type.startsWith("printer") ? "print" : "order",
      severity: sev,
      title: raw.title,
      body: raw.body,
      productId: raw.href?.match(/^\/products\/(.+)$/)?.[1] ?? null,
      persistent: true,
      createdAt: parseDbDate(raw.createdAt),
    });
  }

  // 2) Anlık: düşük stok
  for (const p of stockRes.rows as unknown as { id: string; name: string; stock: number }[]) {
    const crit = p.stock <= 0;
    alerts.push({
      id: `stock-${p.id}`,
      type: "stock",
      severity: crit ? "critical" : "warning",
      title: crit ? "Stok bitti" : "Stok kritik",
      body: `${p.name} — ${crit ? "0" : p.stock} adet`,
      productId: p.id,
      persistent: false,
      createdAt: null,
    });
  }

  // 3) Anlık: filament
  for (const s of spoolRes.rows as unknown as {
    id: string;
    name: string;
    remainingGrams: number;
    reorderGrams: number;
  }[]) {
    const crit = s.remainingGrams <= 0;
    alerts.push({
      id: `spool-${s.id}`,
      type: "filament",
      severity: crit ? "critical" : "warning",
      title: crit ? "Filament bitti" : "Filament azaldı",
      body: `${s.name} — ${Math.round(s.remainingGrams)}g kaldı`,
      productId: null,
      persistent: false,
      createdAt: null,
    });
  }

  // 4) Anlık: yazıcı CANLI sorun durumu (error/paused) — id yazıcı config id'siyle (ad çakışmaz).
  for (const pr of printRes.rows as unknown as {
    printerConfigId: string;
    name: string;
    status: string;
    statusMessage: string | null;
    productName: string | null;
  }[]) {
    const err = pr.status === "error";
    const detail = pr.productName ?? pr.statusMessage;
    alerts.push({
      id: `print-${pr.printerConfigId}`,
      type: "print",
      severity: err ? "critical" : "warning",
      title: err ? "Baskı hatası" : "Baskı duraklatıldı",
      body: detail ? `${pr.name} — ${detail}` : pr.name,
      productId: null,
      persistent: false,
      createdAt: null,
    });
  }

  alerts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const success = alerts.filter((a) => a.severity === "success").length;
  return {
    alerts,
    counts: { total: alerts.length, critical, warning: alerts.length - critical - success },
  };
}

/** Kalıcı bildirimi "okundu" işaretle — masaüstü ziliyle AYNI tablo, iki cihazda birden düşer. */
export async function ackNotification(id: string): Promise<void> {
  await execute(`UPDATE Notification SET acknowledgedAt = ? WHERE id = ?`, [
    new Date().toISOString(),
    id,
  ]);
}

/** Tüm bekleyen kalıcı bildirimleri okundu işaretle. */
export async function ackAllNotifications(): Promise<void> {
  await execute(`UPDATE Notification SET acknowledgedAt = ? WHERE acknowledgedAt IS NULL`, [
    new Date().toISOString(),
  ]);
}
