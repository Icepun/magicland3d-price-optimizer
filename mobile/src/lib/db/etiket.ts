import type { EtiketIstekDurumu } from "@core/etiket-uygunluk";
import { execute, query } from "@/lib/turso";

/**
 * TELEFONDAN KARGO ETİKETİ — telefon tarafı. Telefon termal yazıcıya basamaz: isteği
 * `LabelPrintRequest`'e yazar, etiket yazıcısı bağlı masaüstü sahiplenip basar ve sonucu yazar
 * (masaüstü: `src/lib/etiket/telefon-istekleri.ts`). Tarihler epoch-ms.
 */
export interface EtiketIstegi {
  id: string;
  status: EtiketIstekDurumu;
  error: string | null;
  createdAtMs: number;
  printedBy: string | null;
}

function yeniId(): string {
  return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

/** Tablo yoksa masaüstü henüz v55 öncesi sürümde (tabloyu masaüstü kurar). */
function tabloYok(e: unknown): boolean {
  return /no such table/i.test(e instanceof Error ? e.message : String(e));
}

export async function etiketIstegiGonder(s: {
  platform: "trendyol" | "hepsiburada" | "shopify";
  orderNumber: string;
  labelKey: string;
  trackingNumber: string | null;
  packageNumber: string | null;
}): Promise<string> {
  const id = yeniId();
  try {
    await execute(
      `INSERT INTO LabelPrintRequest
         (id, platform, orderNumber, labelKey, trackingNumber, packageNumber, status, source, createdAtMs)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'mobile', ?)`,
      [id, s.platform, s.orderNumber, s.labelKey, s.trackingNumber, s.packageNumber, Date.now()]
    );
  } catch (e) {
    if (tabloYok(e)) throw new Error("Masaüstü uygulamasını güncelle — telefondan etiket için yeni sürüm gerekiyor.");
    throw e;
  }
  return id;
}

export async function etiketIstegiOku(id: string): Promise<EtiketIstegi | null> {
  const satirlar = await query<EtiketIstegi>(
    `SELECT id, status, error, createdAtMs, printedBy FROM LabelPrintRequest WHERE id = ?`,
    [id]
  );
  const r = satirlar[0];
  return r ? { ...r, createdAtMs: Number(r.createdAtMs) } : null;
}

/** Masaüstü henüz almadıysa vazgeç — sonradan kimse beklemiyorken basılmasın. */
export async function etiketIstegiIptal(id: string): Promise<void> {
  await execute(
    `UPDATE LabelPrintRequest SET status = 'cancelled', processedAtMs = ? WHERE id = ? AND status = 'pending'`,
    [Date.now(), id]
  );
}

/**
 * Basılan etiketler: anahtar (takip/teslimat no, yoksa paket no) → en son basılma anı (ms).
 * Masaüstünden ve telefondan basılanların ikisi de burada. Düz nesne döner (Map değil: sorgu
 * önbelleği JSON'a yazılırsa bozulmasın). Tablo yoksa boş.
 */
export async function basilanEtiketler(): Promise<Record<string, number>> {
  try {
    const satirlar = await query<{ labelKey: string; at: number }>(
      `SELECT labelKey, MAX(processedAtMs) AS at FROM LabelPrintRequest WHERE status = 'done' GROUP BY labelKey`
    );
    const sonuc: Record<string, number> = {};
    for (const r of satirlar) if (r.labelKey) sonuc[String(r.labelKey)] = Number(r.at) || 0;
    return sonuc;
  } catch (e) {
    if (tabloYok(e)) return {};
    throw e;
  }
}
