import { toplamFilamentGrami } from "@/core/filament-karisimi";
import { DAY_MS, MIN_HISTORY_DAYS, SALES_WINDOW_DAYS } from "./planner-insights";

/**
 * FİLAMENT KAÇ GÜN YETER — satış hızından (9 Eki 2026 denetimi).
 *
 * Renk bazında hesap BUGÜNKÜ veriyle yapılamıyor: makaraların açılma tarihi tutulmuyor ve
 * tüketim kaydı yalnız elle girilince oluşuyor. Güvenilir olan: son 90 günde satılan ürünlerin
 * reçete gramajı (ana + ek filamentler, fire dahil) × adet → günlük tüketim; elde kalan toplam
 * gram ÷ günlük tüketim → kaç gün. Satış geçmişi kısaysa uydurulmaz (null).
 */
export interface SatilanKalem {
  quantity: number;
  filamentWeight: number | null;
  ekFilamentlerJson: string | null;
  wasteRate: number | null;
}

export interface FilamentTuketimi {
  /** Son 90 günde (ya da ölçülebilen sürede) satışlara giden gram. */
  toplamGram: number;
  olculenGun: number;
  gunlukGram: number;
  /** Elde kalan gram (kapalı makaralar + açıkların kalanı). */
  stokGram: number;
  /** Bu hızla kaç gün yeter; geçmiş kısa ya da tüketim yoksa null. */
  kacGun: number | null;
  hazir: boolean;
  /** Reçetesinde gram olmayan satılan adet — hesap bunlar kadar eksik. */
  gramsizAdet: number;
}

export function filamentTuketimi(
  kalemler: readonly SatilanKalem[],
  stokGram: number,
  kapsamBaslangicMs: number | null,
  nowMs: number
): FilamentTuketimi {
  let toplamGram = 0;
  let gramsizAdet = 0;
  for (const k of kalemler) {
    if (k.quantity <= 0) continue;
    const gram = toplamFilamentGrami(k);
    if (gram <= 0) {
      gramsizAdet += k.quantity;
      continue;
    }
    toplamGram += gram * (1 + Math.max(0, k.wasteRate ?? 0) / 100) * k.quantity;
  }
  const gecmisGun = kapsamBaslangicMs == null ? 0 : Math.max(0, Math.floor((nowMs - kapsamBaslangicMs) / DAY_MS));
  const olculenGun = Math.max(1, Math.min(gecmisGun, SALES_WINDOW_DAYS));
  const hazir = gecmisGun >= MIN_HISTORY_DAYS;
  const gunlukGram = toplamGram / olculenGun;
  return {
    toplamGram,
    olculenGun,
    gunlukGram,
    stokGram,
    kacGun: hazir && gunlukGram > 0 ? stokGram / gunlukGram : null,
    hazir,
    gramsizAdet,
  };
}
