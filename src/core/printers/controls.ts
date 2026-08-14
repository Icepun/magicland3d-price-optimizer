/**
 * Yazıcı kontrol komutlarının KURALLARI — saf doğrulama, ağ yok.
 *
 * Kurallar SUNUCUDA zorlanır. Arayüz düğmeyi gizlese bile telefon, eski sürüm ya da doğrudan
 * istek aynı uç noktaya gelebilir; sınırın tek geçerli yeri burasıdır.
 *
 * Hız: yazıcı çalışırken tek adımda büyük sıçrama baskıyı bozar (titreşim, kayan katman,
 * ekstrüzyon yetişmemesi). Bu yüzden serbest sayı girişi yok — sabit kademeler ve tek adımda
 * en fazla bir kademe.
 */

/** İzin verilen en düşük / en yüksek hız yüzdesi. */
export const SPEED_MIN_PCT = 50;
export const SPEED_MAX_PCT = 200;
/** Tek komutta izin verilen en büyük değişim (yüzde puanı). */
export const SPEED_MAX_STEP_PCT = 25;
/**
 * Kullanıcıya sunulan kademeler — serbest sayı girişi YOK.
 *
 * BEŞ kademe: kullanıcı kararı (14 Ağu 2026). Eskiden %175 ve %200 de vardı; hiçbir baskıda
 * kullanılmıyordu ve merdiveni uzatıp "hızlı/çok hızlı" ayrımını bulanıklaştırıyordu.
 * Yazıcı yine de dışarıdan bu değerlere çekilebilir — o durumda arayüz ham yüzdeyi gösterir.
 */
export const SPEED_PRESETS_PCT: readonly number[] = [50, 75, 100, 125, 150];

/**
 * Kademelerin ORTAK ADLARI — üç marka aynı dili konuşsun diye.
 *
 * Bambu kendi profil setini kullanıyor (yazıcıya giden komut 1-4 seviye, yüzde değil) ama
 * ekranda aynı adlar görünür: profilin yüzdesi en yakın kademeye eşlenir.
 */
export const SPEED_STEP_LABELS: Readonly<Record<number, string>> = {
  50: "Çok yavaş",
  75: "Yavaş",
  100: "Normal",
  125: "Hızlı",
  150: "Çok hızlı",
};

/**
 * Bir yüzdeye en yakın kademenin adı. Kademeye OTURMAYAN değerde null döner —
 * çağıran ham yüzdeyi yazar ("%137"), uydurma bir ad koymaz.
 */
export function speedStepLabel(pct: number): string | null {
  return SPEED_STEP_LABELS[Math.round(pct)] ?? null;
}

/**
 * Bambu profilinin yüzdesini en yakın kademe adına çevirir (yalnız GÖSTERİM).
 * Bambu'nun %124'ü "Hızlı", %166'sı "Çok hızlı" olur; ara değerde en yakını seçilir.
 */
export function nearestSpeedStepLabel(pct: number): string {
  let best = SPEED_PRESETS_PCT[0];
  for (const step of SPEED_PRESETS_PCT) {
    if (Math.abs(step - pct) < Math.abs(best - pct)) best = step;
  }
  return SPEED_STEP_LABELS[best] ?? `%${Math.round(pct)}`;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Hız değişikliğini doğrula.
 * @param next     istenen yüzde
 * @param current  yazıcının o anki yüzdesi (bilinmiyorsa null — o zaman adım sınırı uygulanmaz)
 */
export function validateSpeedChange(next: unknown, current: number | null): Validated<number> {
  const n = typeof next === "number" ? next : Number(next);
  if (!Number.isFinite(n)) return { ok: false, error: "Hız değeri okunamadı." };
  const pct = Math.round(n);
  if (!SPEED_PRESETS_PCT.includes(pct)) {
    return { ok: false, error: "Hız yalnız hazır kademelerden seçilebilir." };
  }
  if (pct < SPEED_MIN_PCT || pct > SPEED_MAX_PCT) {
    return { ok: false, error: `Hız %${SPEED_MIN_PCT} ile %${SPEED_MAX_PCT} arasında olmalı.` };
  }
  if (current != null && Number.isFinite(current)) {
    const cur = Math.round(current);
    if (Math.abs(pct - cur) > SPEED_MAX_STEP_PCT) {
      return {
        ok: false,
        error: `Hızı tek seferde en fazla %${SPEED_MAX_STEP_PCT} değiştirebilirsin. Şu an %${cur}.`,
      };
    }
  }
  return { ok: true, value: pct };
}

/**
 * "Şu katmanda duraklat" değerini doğrula.
 * Geçilmiş bir katman seçilirse komut sessizce hiçbir şey yapmaz — bunu baştan reddediyoruz.
 */
export function validatePauseLayer(
  layer: unknown,
  currentLayer: number | null,
  totalLayer: number | null,
): Validated<number> {
  const n = typeof layer === "number" ? layer : Number(layer);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: "Katman numarası tam sayı olmalı." };
  }
  if (n < 1) return { ok: false, error: "Katman numarası 1'den küçük olamaz." };
  if (currentLayer != null && n <= currentLayer) {
    return { ok: false, error: `Bu katman geçildi. ${currentLayer + 1} ve sonrasını seçebilirsin.` };
  }
  if (totalLayer != null && totalLayer > 0 && n > totalLayer) {
    return { ok: false, error: `Bu baskı ${totalLayer} katman. Daha büyük bir katman seçilemez.` };
  }
  return { ok: true, value: n };
}

/** Bir yazıcının hangi kontrolleri desteklediği — arayüz düğmeleri buna göre çizilir. */
export interface PrinterControlCaps {
  /** Duraklat / devam / iptal. */
  pauseResume: boolean;
  /** M220 hız çarpanı (okuma + yazma). */
  speed: boolean;
  /** Işık aç/kapa. */
  light: boolean;
  /** Işığın AÇIK mı KAPALI mı olduğu okunabiliyor mu (bazı modellerde yalnız "değiştir" var). */
  lightReadable: boolean;
  /** Belirli katmanda duraklatma (Klipper SET_PAUSE_AT_LAYER). */
  pauseAtLayer: boolean;
  /** Filament değişimi (M600 — baskıyı duraklatır). */
  filamentChange: boolean;
  /** Spagetti / kirli tabla gözetimi (Snapmaker U1 defect_detection). */
  defectDetection: boolean;
}

export const NO_CONTROL_CAPS: PrinterControlCaps = {
  pauseResume: false, speed: false, light: false, lightReadable: false,
  pauseAtLayer: false, filamentChange: false, defectDetection: false,
};

/** Desteklenmeyen komut için TEK ve NET kullanıcı mesajı — sessizce yutulmaz. */
export function unsupportedMessage(printerName: string, what: string): string {
  return `${printerName} bu özelliği desteklemiyor: ${what}`;
}
