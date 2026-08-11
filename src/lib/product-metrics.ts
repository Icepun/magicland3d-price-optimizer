/**
 * Ürün karar metrikleri — TÜRETME katmanı.
 *
 * BURADA KÂR HESABI YOKTUR. Motorun (`@/core/pricing-engine`) çıkardığı net kâr rakamı burada
 * yalnızca BÖLÜNÜR ya da iki fiyattaki sonucu KARŞILAŞTIRILIR. KDV/komisyon/kargo/yuvarlama
 * kuralları bu dosyanın konusu değildir — değiştirmek de yasaktır.
 */

/**
 * "Birim başına" oran (kâr/saat, kâr/gram).
 *
 * `qty`: Trendyol minimum sipariş adedi gibi durumlarda net kâr N adetlik SİPARİŞ üzerinden
 * hesaplanıyor. O yüzden payda da (süre/gramaj) aynı adetle çarpılmalı; yoksa oran N kat şişer.
 * Süre veya gramaj bilinmiyorsa `null` döner → arayüz "—" gösterir.
 */
export function perUnitRatio(
  netProfit: number | null | undefined,
  perUnitAmount: number | null | undefined,
  qty = 1
): number | null {
  if (netProfit == null || !Number.isFinite(netProfit)) return null;
  if (perUnitAmount == null || !Number.isFinite(perUnitAmount) || perUnitAmount <= 0) return null;
  const orderQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
  const denominator = perUnitAmount * orderQty;
  if (denominator <= 0) return null;
  return netProfit / denominator;
}

/** Mevcut fiyatın en fazla bu kadar üstündeki kırılım noktaları "hemen üstü" sayılır (%10). */
export const THRESHOLD_MAX_INCREASE_RATIO = 0.1;
/** Bu tutarın altındaki kazanç kullanıcıya gösterilmez — her ürüne rozet basmamak için. */
export const THRESHOLD_MIN_GAIN = 5;

export interface ThresholdOption {
  price: number;
  profit: number;
}

export interface ThresholdHint {
  /** Çıkılması önerilen fiyat (kuralın kırılım noktası). */
  targetPrice: number;
  /** Mevcut fiyattaki net kâr. */
  currentProfit: number;
  /** Önerilen fiyattaki net kâr. */
  targetProfit: number;
  /** targetProfit − currentProfit. */
  gain: number;
}

/**
 * Kural kırılım noktalarından (bkz. `@/core/price-target` collectRulePriceBreakpoints) yalnızca
 * mevcut fiyatın HEMEN ÜSTÜNDE kalanları seçer — tekrarları eler, küçükten büyüğe sıralar.
 * Böylece pahalı simülasyon tüm bantlar için değil, birkaç aday için çalışır.
 */
export function thresholdCandidatePrices(
  breakpoints: readonly number[],
  currentPrice: number,
  maxIncreaseRatio = THRESHOLD_MAX_INCREASE_RATIO
): number[] {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return [];
  const ceiling = currentPrice * (1 + maxIncreaseRatio);
  const unique = new Set<number>();
  for (const point of breakpoints) {
    if (!Number.isFinite(point)) continue;
    // Kuruş hassasiyetine yuvarla: 150 ve 150.0000001 aynı adaydır.
    const price = Math.round(point * 100) / 100;
    if (price > currentPrice && price <= ceiling) unique.add(price);
  }
  return [...unique].sort((a, b) => a - b);
}

/**
 * "Küçük zam, büyük kazanç" önerisini seçer.
 *
 * Sıradan bir zamda kârın ancak bir kısmı cebe kalır (KDV + komisyon keser). Bu yüzden yalnızca
 * kazancın zammın TAMAMINI aştığı adaylar gösterilir — bu ancak bir kural bandı (kargo/komisyon)
 * lehe döndüğünde olur. Ayrıca kazanç `minGain` altındaysa gösterilmez.
 * Eşit kazançta DAHA UCUZ hedef tercih edilir (müşteriyi en az zorlayan zam).
 */
export function chooseThresholdHint(
  currentPrice: number,
  currentProfit: number,
  options: readonly ThresholdOption[],
  { minGain = THRESHOLD_MIN_GAIN }: { minGain?: number } = {}
): ThresholdHint | null {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(currentProfit)) return null;

  let best: ThresholdHint | null = null;
  for (const option of options) {
    if (!Number.isFinite(option.price) || !Number.isFinite(option.profit)) continue;
    const priceIncrease = option.price - currentPrice;
    if (priceIncrease <= 0) continue;
    const gain = option.profit - currentProfit;
    if (gain < minGain) continue;
    if (gain <= priceIncrease) continue; // sıradan zam — anlatmaya değmez
    if (best && (gain < best.gain || (gain === best.gain && option.price >= best.targetPrice))) {
      continue;
    }
    best = {
      targetPrice: option.price,
      currentProfit,
      targetProfit: option.profit,
      gain,
    };
  }
  return best;
}
