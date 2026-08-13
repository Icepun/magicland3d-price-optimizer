/**
 * Trendyol sipariş çekimi için tarih pencereleri.
 *
 * ⚠️ BURADAKİ TEK KURAL: Trendyol'a giden `endDate - startDate` aralığı 2 HAFTAYI GEÇEMEZ.
 * Sert bir sınır — aşılınca sorgu reddedilmiyor, SESSİZCE kırpılıyor ve pencerenin sonundaki
 * (yani EN YENİ) siparişler hiç dönmüyor.
 *
 * Sahada yaşandı (13 Ağu 2026): dilimler tam 14 gündü, üstüne saat dilimi payı iki uçtan
 * ±3 saat eklendi ve açıklık 14 gün 6 saate çıktı. Sonuç: son ~3 saatte verilen siparişler
 * sipariş listesine HİÇ düşmedi. Bildirim tarayıcısı 2 günlük dar pencere kullandığı için
 * aynı siparişi görüyordu — "bildirim geldi ama listede yok" tablosu buradan doğdu.
 * Kaybolan sipariş: #11503693822, saat 23:19; o an listedeki en yeni sipariş 17:58'di.
 *
 * Bu yüzden dilim boyu pay ÇIKARILARAK hesaplanır ve `windowSpan` ile test edilir.
 */
import {
  TRENDYOL_MAX_WINDOW_MS,
  TRENDYOL_WINDOW_PAD_MS,
  padTrendyolWindow,
} from "@/core/trendyol-date";

export interface TrendyolWindow {
  /** Trendyol'a gönderilecek hâli (pay eklenmiş). */
  startDate: number;
  endDate: number;
}

/**
 * Payla birlikte sınırı aşmayan dilim boyu.
 * Pay iki uçtan eklendiği için açıklık = dilim + 2×pay olur; eşitlik tam sınıra oturur.
 */
export const TRENDYOL_CHUNK_MS = TRENDYOL_MAX_WINDOW_MS - 2 * TRENDYOL_WINDOW_PAD_MS;

/** Gönderilen pencerenin gerçek açıklığı — testin ölçtüğü şey. */
export function windowSpan(w: TrendyolWindow): number {
  return w.endDate - w.startDate;
}

/**
 * `now`'dan geriye `historyCutoff`'a kadar, sınırı aşmayan pencereler (yeniden eskiye).
 *
 * En yeni pencere HER ZAMAN `now` ile biter: sipariş listesinin tazeliği buna bağlı.
 */
export function buildTrendyolWindows(now: number, historyCutoff: number): TrendyolWindow[] {
  const windows: TrendyolWindow[] = [];
  for (let chunkEnd = now; chunkEnd > historyCutoff; chunkEnd -= TRENDYOL_CHUNK_MS) {
    const chunkStart = Math.max(historyCutoff, chunkEnd - TRENDYOL_CHUNK_MS);
    windows.push({
      // Trendyol sınırları duvar saati düzleminde yorumluyorsa gerçek UTC göndermek
      // pencereyi kaydırır; iki uçtan da açıyoruz. Fazla satırı rota kendi kırpmasıyla eliyor.
      startDate: padTrendyolWindow(chunkStart, "start"),
      endDate: padTrendyolWindow(chunkEnd, "end"),
    });
  }
  return windows;
}
