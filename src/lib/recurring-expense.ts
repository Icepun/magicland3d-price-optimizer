/**
 * TEKRARLAYAN SABİT GİDER — hangi aylar için kayıt açılmalı? SAF mantık.
 *
 * Kullanıcı kararı (14 Ağu 2026): "her ay tekrar eden giderleri ekleyebilmeliyim, tarihi
 * gelince fix gider olarak eklenir direkt." Yani kayıt OTOMATİK açılır, onay beklenmez.
 *
 * ⚠️ BU KOD NET KÂRI DEĞİŞTİRİR: açılan her satır o ayın net kârından düşer. Bu yüzden iki
 * kural sert:
 *   1. GELECEK AY AÇILMAZ. Ödeme günü gelmeden gider yazmak, o ayın kârını olduğundan düşük
 *      gösterir. Yalnızca günü GELMİŞ dönemler üretilir.
 *   2. AYNI DÖNEM İKİ KEZ AÇILMAZ. Üretim her açılışta çalışıyor; koruma olmadan gider her
 *      açılışta bir kat daha artardı. Koruma iki katmanlı: burada `varOlanDonemler` ile,
 *      veritabanında kısmi UNIQUE indeksle.
 *
 * Tarihler Türkiye duvar saatine göre yorumlanır (ülke kalıcı UTC+3).
 */

const TR_OFFSET_MS = 3 * 60 * 60 * 1000;

export interface TekrarKurali {
  id: string;
  name: string;
  category: string | null;
  amountKurus: number;
  /** Ayın kaçında ödeniyor (1-31). */
  dayOfMonth: number;
  startsAtMs: number;
  endsAtMs: number | null;
  isActive: boolean;
  note: string | null;
}

export interface UretilecekGider {
  recurringId: string;
  /** "2026-08" */
  periodKey: string;
  name: string;
  category: string | null;
  amountKurus: number;
  /** Ödeme anı (UTC ms) — ayın ilgili günü, Türkiye saatiyle gün başı. */
  paidAtMs: number;
  note: string | null;
}

/** "2026-08" biçiminde dönem anahtarı (Türkiye takvimine göre). */
export function donemAnahtari(ms: number): string {
  const d = new Date(ms + TR_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Bir dönemin (yıl, ay) o ayın kaçıncı gününe denk geldiği — ay o günü taşımıyorsa son gün. */
export function ayinGunu(yil: number, ay: number, istenenGun: number): number {
  const sonGun = new Date(Date.UTC(yil, ay, 0)).getUTCDate(); // ay: 1-12
  return Math.min(Math.max(1, Math.floor(istenenGun)), sonGun);
}

/** Dönem + gün → gerçek ödeme anı (UTC ms). Türkiye gün başı (00:00 TR). */
export function odemeAni(periodKey: string, dayOfMonth: number): number {
  const [yilStr, ayStr] = periodKey.split("-");
  const yil = Number(yilStr);
  const ay = Number(ayStr);
  const gun = ayinGunu(yil, ay, dayOfMonth);
  return Date.UTC(yil, ay - 1, gun, 0, 0, 0) - TR_OFFSET_MS;
}

/** İki dönem arasındaki anahtarlar (dahil), eskiden yeniye. */
function donemAraligi(basMs: number, sonMs: number): string[] {
  const out: string[] = [];
  const bas = new Date(basMs + TR_OFFSET_MS);
  let yil = bas.getUTCFullYear();
  let ay = bas.getUTCMonth() + 1;
  const son = new Date(sonMs + TR_OFFSET_MS);
  const sonYil = son.getUTCFullYear();
  const sonAy = son.getUTCMonth() + 1;
  // 600 ay = 50 yıl: bozuk bir başlangıç tarihi sonsuz döngüye çevirmesin.
  for (let i = 0; i < 600; i++) {
    if (yil > sonYil || (yil === sonYil && ay > sonAy)) break;
    out.push(`${yil}-${String(ay).padStart(2, "0")}`);
    ay += 1;
    if (ay > 12) {
      ay = 1;
      yil += 1;
    }
  }
  return out;
}

/**
 * Bir kural için açılması gereken giderler.
 *
 * `varOlanDonemler`: bu kural için ZATEN kayıt açılmış dönemler.
 */
export function uretilecekler(
  kural: TekrarKurali,
  varOlanDonemler: Iterable<string>,
  nowMs: number
): UretilecekGider[] {
  if (!kural.isActive) return [];
  if (!Number.isFinite(kural.amountKurus) || kural.amountKurus <= 0) return [];
  if (!Number.isFinite(kural.startsAtMs)) return [];

  const varOlan = new Set(varOlanDonemler);
  const bitis = kural.endsAtMs != null ? Math.min(kural.endsAtMs, nowMs) : nowMs;
  if (bitis < kural.startsAtMs) return [];

  const out: UretilecekGider[] = [];
  for (const periodKey of donemAraligi(kural.startsAtMs, bitis)) {
    if (varOlan.has(periodKey)) continue;
    const paidAtMs = odemeAni(periodKey, kural.dayOfMonth);
    // GÜNÜ GELMEMİŞ dönem açılmaz: ayın 25'inde ödenen gideri ayın 3'ünde yazmak, o ayın
    // kârını olduğundan düşük gösterir.
    if (paidAtMs > nowMs) continue;
    // Kural başlamadan önceki güne denk gelen ilk dönem de atlanır (kural ayın ortasında
    // kurulduysa o ayın ödemesi zaten elle girilmiş olabilir).
    if (paidAtMs < kural.startsAtMs) continue;
    if (kural.endsAtMs != null && paidAtMs > kural.endsAtMs) continue;
    out.push({
      recurringId: kural.id,
      periodKey,
      name: kural.name,
      category: kural.category,
      amountKurus: Math.round(kural.amountKurus),
      paidAtMs,
      note: kural.note,
    });
  }
  return out;
}
