/**
 * İlerleme ve kalan süre — ÜÇ MARKA İÇİN TEK HESAP.
 *
 * Neden ortak: aynı hesap üç yerde ayrı ayrı yazılmıştı (panel API, relay/mobil snapshot,
 * Bambu dalı) ve üçü farklı sonuç veriyordu. Artık tek giriş noktası var; mobil de relay
 * üzerinden aynı sonucu görür.
 *
 * İLERLEME KAYNAĞI SIRALAMASI (canlı ölçümle doğrulandı, Snapmaker U1 · 12 Ağu):
 *   virtual_sdcard.progress = 0.1765  (dosyanın okunan BAYT oranı)
 *   display_status.progress = 0.24    (dilimleyicinin M73 P zaman tahmini)
 * Bayt oranı ZAMAN değil, konum ölçer: yavaş katmanlar (destek, ilk katmanlar, küçük detay)
 * az bayt/çok zaman, hızlı dolgu çok bayt/az zaman harcar. Kalan süreyi bayt oranından
 * çıkarmak U1'de saatlerce sapma üretiyordu. Bu yüzden M73 varsa O kullanılır, yoksa bayt.
 *
 * SÜRE: yazıcı kendi kalan süresini veriyorsa (Bambu `mc_remaining_time`) o esastır. Yoksa
 * ölçülen hız (geçen süre / ilerleme) ile dilimleyici tahmini harmanlanır: baskının başında
 * ölçüm gürültülüdür (ısınma/priming), sonunda ölçüm gerçeği söyler.
 *
 * BİLİNMEYEN ≠ SIFIR: hiçbir kaynak yoksa `remainingSec` null döner — çağıran "—" göstermeli.
 */

export type ProgressSource = "slicer" | "bytes" | "printer" | "none";

export interface ProgressPick {
  /** 0..1 arası, sınırlanmış. */
  progress: number;
  source: ProgressSource;
}

export interface ProgressInputs {
  /** Dilimleyicinin M73 P tahmini — Moonraker'da `display_status.progress` (0..1). */
  slicerProgress?: number | null;
  /** Dosya bayt oranı — Moonraker'da `virtual_sdcard.progress` (0..1). */
  byteProgress?: number | null;
  /** Yazıcının doğrudan bildirdiği yüzde — Bambu `mc_percent` (0..100). */
  printerPercent?: number | null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function usable(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * İlerlemeyi doğru kaynaktan seç.
 * Sıra: yazıcının kendi yüzdesi (Bambu) → M73/dilimleyici → bayt oranı.
 * Hiçbiri yoksa 0 ve `source:"none"` (çağıran "ilerleme bilinmiyor" ayrımını buradan yapar).
 */
export function pickProgress(inputs: ProgressInputs): ProgressPick {
  if (usable(inputs.printerPercent)) {
    return { progress: clamp01(inputs.printerPercent / 100), source: "printer" };
  }
  if (usable(inputs.slicerProgress)) {
    return { progress: clamp01(inputs.slicerProgress), source: "slicer" };
  }
  if (usable(inputs.byteProgress)) {
    return { progress: clamp01(inputs.byteProgress), source: "bytes" };
  }
  return { progress: 0, source: "none" };
}

export type EtaSource = "printer" | "measured" | "blend" | "slicer" | "unknown";

export interface EtaInput {
  /** 0..1 — tercihen pickProgress() çıktısı. */
  progress: number;
  /** Gerçekten geçen baskı süresi (Moonraker `print_stats.print_duration`). Bilinmiyorsa null. */
  elapsedSec?: number | null;
  /** Dilimleyicinin toplam süre tahmini (metadata `estimated_time` / gcode başlığı). */
  slicerEstimateSec?: number | null;
  /** Yazıcının KENDİ bildirdiği kalan süre (Bambu `mc_remaining_time`, saniyeye çevrilmiş). */
  printerRemainingSec?: number | null;
}

export interface EtaResult {
  /** Kalan saniye. Hiçbir kaynak yoksa null — SIFIR DEĞİL. */
  remainingSec: number | null;
  /** Tahmini toplam süre (saniye) — bilinmiyorsa null. */
  totalSec: number | null;
  /** Geçen süre (verilmediyse kalan + toplamdan türetilir) — bilinmiyorsa null. */
  elapsedSec: number | null;
  source: EtaSource;
}

/** Ölçümün anlamlı sayılacağı en düşük ilerleme (altında geçen süre/ilerleme oranı gürültü). */
const MEASURE_MIN_PROGRESS = 0.01;
/** Bu ilerlemenin altında dilimleyici tahmini esastır. */
const BLEND_START = 0.05;
/** Bu ilerlemeden sonra ÖLÇÜM esastır (dilimleyici tahmini tamamen bırakılır). */
const BLEND_END = 0.15;

/**
 * Kalan/toplam süreyi çöz. Kaynak önceliği:
 *   1. Yazıcının kendi kalan süresi (varsa tartışmasız doğru — Bambu).
 *   2. Ölçülen hız (ilerleme %15'i geçtiyse ya da dilimleyici tahmini yoksa).
 *   3. Ölçüm + dilimleyici harmanı (%5-15 arası, ani zıplamayı önler).
 *   4. Yalnız dilimleyici tahmini (baskının ilk anları).
 *   5. Hiçbiri → null.
 */
export function resolveEta(input: EtaInput): EtaResult {
  const progress = clamp01(Number.isFinite(input.progress) ? input.progress : 0);
  const elapsed = usable(input.elapsedSec) ? input.elapsedSec : null;
  const slicer = usable(input.slicerEstimateSec) ? input.slicerEstimateSec : null;
  const printerRemaining =
    typeof input.printerRemainingSec === "number" && Number.isFinite(input.printerRemainingSec)
      ? Math.max(0, input.printerRemainingSec)
      : null;

  // 1) Yazıcının kendi kalan süresi. 0 değeri yalnız baskı gerçekten bitmek üzereyken güvenilir;
  //    hazırlık aşamasında Bambu 0 raporlar ve bu "bitti" demek değildir → diğer kaynaklara düş.
  if (printerRemaining != null && (printerRemaining > 0 || progress >= 0.995)) {
    let total: number | null = null;
    if (elapsed != null) total = elapsed + printerRemaining;
    else if (progress > 0.001 && progress < 1) total = printerRemaining / (1 - progress);
    return {
      remainingSec: Math.round(printerRemaining),
      totalSec: total != null ? Math.round(total) : null,
      elapsedSec: elapsed ?? (total != null ? Math.round(total - printerRemaining) : null),
      source: "printer",
    };
  }

  const measuredTotal =
    elapsed != null && progress >= MEASURE_MIN_PROGRESS ? elapsed / progress : null;

  let total: number | null = null;
  let source: EtaSource = "unknown";
  if (measuredTotal != null && (progress >= BLEND_END || slicer == null)) {
    total = measuredTotal;
    source = "measured";
  } else if (measuredTotal != null && slicer != null && progress >= BLEND_START) {
    const w = (progress - BLEND_START) / (BLEND_END - BLEND_START); // %5→0 … %15→1
    total = slicer * (1 - w) + measuredTotal * w;
    source = "blend";
  } else if (slicer != null) {
    total = slicer;
    source = "slicer";
  }

  if (total == null) {
    return { remainingSec: null, totalSec: null, elapsedSec: elapsed, source: "unknown" };
  }
  const remaining = elapsed != null ? total - elapsed : total * (1 - progress);
  return {
    remainingSec: Math.max(0, Math.round(remaining)),
    totalSec: Math.round(total),
    elapsedSec: elapsed ?? Math.round(total - Math.max(0, remaining)),
    source,
  };
}
