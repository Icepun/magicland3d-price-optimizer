/**
 * SATIŞ HIZININ ORTAK KURALLARI — masaüstü (Üretim Planı, kuyruk, ürün detayı, Filament "ne kadar
 * yeter") ve telefon (Üretim ekranı) AYNI fonksiyonları kullanır (`npm run sync-core`).
 */

export const SATIS_PENCERESI_GUN = 90;
const GUN_MS = 86_400_000;

/**
 * Satışların SAYILACAĞI başlangıç: 90 günlük pencere başı ile kapsam başının (kanalların birlikte
 * kapsadığı dönemin) GEÇ olanı.
 *
 * NEDEN: bölen "ölçülen gün" = min(geçmiş, 90). Adet ise 90 günden sayılıyordu. Bir kanal 30 gün
 * önce başladıysa, eski kanalın 90 günlük satışı 30 güne bölünüyor, hız 3 kat şişiyordu
 * (denetim, 23 Kas 2026). Pay ve payda artık AYNI dönemi ölçer.
 */
export function satisSayimBasi(nowMs: number, kapsamBaslangicMs: number | null | undefined): number {
  const pencere = nowMs - SATIS_PENCERESI_GUN * GUN_MS;
  return kapsamBaslangicMs != null && Number.isFinite(kapsamBaslangicMs) ? Math.max(pencere, kapsamBaslangicMs) : pencere;
}

/**
 * Manuel siparişin kalem JSON'undan ÜRÜN BAŞINA adet. Bozuk JSON ya da katalog dışı (serbest)
 * kalem sayılmaz. Manuel satışlar sipariş kalemleri tablosuna yazılmadığı için satış hızı onları
 * hiç görmüyordu: yalnız elden satılan ürün "satmıyor" sayılıp plana girmiyordu.
 */
export function manuelKalemAdetleri(itemsJson: string | null | undefined): Array<{ productId: string; quantity: number }> {
  let ham: unknown;
  try {
    ham = JSON.parse(String(itemsJson ?? ""));
  } catch {
    return [];
  }
  const kalemler: unknown[] = Array.isArray(ham)
    ? ham
    : ham && typeof ham === "object" && Array.isArray((ham as { items?: unknown }).items)
      ? ((ham as { items: unknown[] }).items)
      : [];
  const out: Array<{ productId: string; quantity: number }> = [];
  for (const k of kalemler) {
    if (!k || typeof k !== "object") continue;
    const productId = (k as { productId?: unknown }).productId;
    const quantity = Number((k as { quantity?: unknown }).quantity);
    if (typeof productId === "string" && productId && Number.isFinite(quantity) && quantity > 0) {
      out.push({ productId, quantity: Math.floor(quantity) });
    }
  }
  return out;
}
