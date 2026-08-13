/**
 * Ürün bazlı SATIŞ HIZI türetmesi (Üretim Planı için) — SAF mantık.
 *
 * NEDEN AYRI DOSYA: Next 16 rota dosyaları YALNIZ istek işleyicilerini dışa açabilir. Sabitler,
 * tipler ve yardımcı fonksiyonlar route.ts'ten dışa açılırsa `next build` tip denetiminde
 * patlar — ve bunu `tsc --noEmit` YAKALAMAZ (yalnız üretim derlemesi görür).
 *
 * BURADA KÂR/MALİYET HESABI YOKTUR. Yalnız `OrderItemSnapshot` satırlarındaki ADET ve TARİH
 * sayılır; hiçbir tutar okunmaz, hiçbir oran/yuvarlama uygulanmaz. Amaç tek soru: "bu ürün
 * kaç günde bir satıyor ve en son ne zaman sattı?"
 *
 * ⚠️ Tablo YENİ. Geçmiş birikmeden hesaplanan "hız" yanıltıcıdır (bir haftalık veriyle "ayda 4
 * satıyor" demek uydurmadır). Bu yüzden yanıt, elde KAÇ GÜNLÜK geçmiş olduğunu da döner ve
 * arayüz yeterli geçmiş yokken rakam yerine "yeterli satış geçmişi yok" der.
 */

export const DAY_MS = 86_400_000;

/** Satış sayımının bakacağı pencere. */
export const SALES_WINDOW_DAYS = 90;
/** "Son N günde kaç adet" rozeti bu pencereyi kullanır. */
export const RECENT_WINDOW_DAYS = 30;
/** "Satmıyor" demek için bakmak İSTEDİĞİMİZ süre. Geçmiş yetmezse ölçülebilene düşürülür. */
export const DEAD_STOCK_DAYS = 90;
/** Hız rakamlarının gösterilebilmesi için gereken en az geçmiş. */
export const MIN_HISTORY_DAYS = 21;

/** Ham satır — tarih milisaniye tamsayısı olarak saklanır (bkz. order-finance-snapshots.ts). */
export interface SalesSnapshotRow {
  productId: string | null;
  orderedAt: number;
  quantity: number;
  statusKind: string;
}

export interface ProductSalesInsight {
  productId: string;
  /** Son 30 gündeki toplam adet. */
  soldRecent: number;
  /** Son 90 gündeki toplam adet. */
  soldInWindow: number;
  /** En son satış tarihi (ISO). */
  lastSaleAt: string | null;
  /** Son satışın üstünden geçen tam gün. */
  daysSinceLastSale: number | null;
  /** Ortalama kaç günde bir adet satıyor — ölçülen gün ÷ adet. Satış yoksa null. */
  daysPerSale: number | null;
  /** Ölçüm penceresinde hiç satmadı mı (bu satırda satış varsa false). */
  deadStock: boolean;
}

export interface PlannerInsightsPayload {
  windowDays: number;
  recentDays: number;
  /**
   * "Bu kadar gündür satmadı" derken kullanılan GERÇEK süre.
   *
   * İstenen 90 gün ama elde o kadar geçmiş yoksa ölçülebilene düşer. Arayüz bu sayıyı
   * doğrudan yazar ("21 gündür satmadı") — 90 yazıp 21 günlük veriye dayanmak yalan olurdu.
   */
  deadStockDays: number;
  minHistoryDays: number;
  /** Elde biriken satış geçmişi (tam gün). */
  historyDays: number;
  /** Hız hesabında kullanılan gün sayısı — günlük satış bu bölenle çıkar. */
  measuredDays: number;
  /** Hız rakamları gösterilebilir mi? */
  ready: boolean;
  /** Hazır değilse kaç gün sonra anlamlı olacak. */
  readyInDays: number;
  /** "N gündür satmadı" ölçülebilir mi? */
  deadStockReady: boolean;
  deadStockInDays: number;
  items: ProductSalesInsight[];
}

/** İptal edilen satır satışa sayılmaz. */
export const EXCLUDED_STATUS = "cancelled";

/** Ham sorgu tamsayıları sürücüye göre BigInt gelebilir — hesaba girmeden sadeleştir. */
export function toInt(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function fullDaysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / DAY_MS));
}

/**
 * Satırlardan ürün başına satış hızını türetir.
 *
 * `coverageStartMs`: geçmişin GÜVENİLİR biçimde başladığı an (bkz. `coverageStart`).
 * Pencere içinde satırı olmayan ürün burada YER ALMAZ; arayüz "listede yok = pencerede hiç
 * satmadı" diye okur (aksi hâlde binlerce sıfırlı satır taşınırdı).
 */
export function deriveSalesInsights(
  rows: SalesSnapshotRow[],
  coverageStartMs: number | null,
  nowMs: number
): PlannerInsightsPayload {
  const historyDays = coverageStartMs == null ? 0 : fullDaysBetween(coverageStartMs, nowMs);
  const recentSince = nowMs - RECENT_WINDOW_DAYS * DAY_MS;
  const windowSince = nowMs - SALES_WINDOW_DAYS * DAY_MS;

  const acc = new Map<
    string,
    { soldRecent: number; soldInWindow: number; lastSaleMs: number }
  >();

  for (const row of rows) {
    const productId = row.productId;
    if (!productId) continue;
    // İptal edilen sipariş satışa sayılmaz — sayılırsa iptal yağmuru yiyen ürün "çok satıyor"
    // görünür ve boşuna basılır.
    if (row.statusKind === EXCLUDED_STATUS) continue;
    const orderedAt = toInt(row.orderedAt);
    if (!Number.isFinite(orderedAt) || orderedAt < windowSince) continue;
    const quantity = toInt(row.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const current = acc.get(productId) ?? { soldRecent: 0, soldInWindow: 0, lastSaleMs: 0 };
    current.soldInWindow += quantity;
    if (orderedAt >= recentSince) current.soldRecent += quantity;
    if (orderedAt > current.lastSaleMs) current.lastSaleMs = orderedAt;
    acc.set(productId, current);
  }

  // Ölçülen gün: geçmişimiz penceresinden kısaysa KISA olanı kullan — yoksa 10 günlük veriyi
  // 90 güne bölüp "neredeyse hiç satmıyor" gibi yanlış bir hız çıkardık demektir.
  const measuredDays = Math.max(1, Math.min(historyDays, SALES_WINDOW_DAYS));

  /**
   * "Satmıyor" eşiği ÖLÇEBİLDİĞİMİZ kadar.
   *
   * Eskiden sabit 90 gündü ve 90 günlük geçmiş birikene kadar süzgeç KAPALI kalıyordu.
   * Ölçüldü (13 Ağu 2026): elde 21 günlük geçmiş vardı, yani süzgeç ~69 gün daha kapalı
   * kalacaktı — tam da en gerekli olduğu dönemde. Oysa "21 gündür hiç satmadı" da
   * söylenebilir bir gerçek; yeter ki 90 diye yazılmasın.
   */
  const deadStockDays = Math.max(1, Math.min(DEAD_STOCK_DAYS, measuredDays));

  const items: ProductSalesInsight[] = [];
  for (const [productId, value] of acc) {
    const daysSinceLastSale =
      value.lastSaleMs > 0 ? fullDaysBetween(value.lastSaleMs, nowMs) : null;
    items.push({
      productId,
      soldRecent: value.soldRecent,
      soldInWindow: value.soldInWindow,
      lastSaleAt: value.lastSaleMs > 0 ? new Date(value.lastSaleMs).toISOString() : null,
      daysSinceLastSale,
      daysPerSale: value.soldInWindow > 0 ? measuredDays / value.soldInWindow : null,
      deadStock: daysSinceLastSale == null || daysSinceLastSale >= deadStockDays,
    });
  }
  // Hızlı satan başta: arayüz sırayı yeniden kurmak zorunda kalmasın.
  items.sort((a, b) => b.soldInWindow - a.soldInWindow);

  return {
    windowDays: SALES_WINDOW_DAYS,
    recentDays: RECENT_WINDOW_DAYS,
    deadStockDays,
    minHistoryDays: MIN_HISTORY_DAYS,
    historyDays,
    measuredDays,
    ready: historyDays >= MIN_HISTORY_DAYS,
    readyInDays: Math.max(0, MIN_HISTORY_DAYS - historyDays),
    // Süzgeç, hız rakamlarıyla AYNI eşiğe bağlı: 21 gün "ayda 3 satıyor" demeye yetiyorsa
    // "21 gündür hiç satmadı" demeye de yeter.
    deadStockReady: historyDays >= MIN_HISTORY_DAYS,
    deadStockInDays: Math.max(0, MIN_HISTORY_DAYS - historyDays),
    items,
  };
}

/**
 * Geçmişin GÜVENİLİR başlangıcı.
 *
 * En eski satırı almak yanıltıcı olurdu: bir satış kanalının 200 günlük geçmişi varken
 * diğerinin yalnız 30 günü olabilir. O zaman "200 günlük geçmişimiz var" deyip kısa geçmişli
 * kanalın ürünlerine haksız yere "satmıyor" damgası vururduk. Bu yüzden kanalların EN GENÇ
 * başlangıcı esas alınır — hepsinin birlikte kapsadığı dönem.
 */
export function coverageStart(oldestPerChannel: number[]): number | null {
  const valid = oldestPerChannel.filter((value) => Number.isFinite(value) && value > 0);
  if (valid.length === 0) return null;
  return Math.max(...valid);
}
