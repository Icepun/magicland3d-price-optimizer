/**
 * Trendyol sipariş kimliği — masaüstü ve mobil AYNI kuralı kullanır (sync-core ile paylaşılır).
 *
 * Kimlik PAKET id'sidir, sipariş numarası değil: bölünmüş bir siparişin (kısmi iptal, ayrı
 * paketler) iki paketi iki ayrı kayıttır.
 *
 * ⚠️ Trendyol yeni siparişi ilk saniyelerde paket id'si 0 ile verebiliyor (ölçüldü 23 Eyl 2026:
 * #11563168410, verildikten 14 sn sonra `id: 0`). Eski kimlik `ty-${o.id ?? …}` idi; `??` 0'ı
 * GERÇEK kimlik sayıyordu → "ty-0". Sonuçları:
 *   - Aynı anda paket id'si 0 olan iki sipariş aynı anahtara düşüyor, ikincisi listeden siliniyordu.
 *   - Finans geçmişine "ty-0" diye bir satır yazılıyor, gerçek id gelince ikinci satır açılıyordu:
 *     sipariş Raporlar'da İKİ KEZ sayılıyordu (779,99 TL fazla ciro, 273,39 TL fazla kâr).
 *
 * Paket id'si henüz yoksa GEÇİCİ kimlik verilir. Geçici kimlikli sipariş listede görünür ama kalıcı
 * kayda YAZILMAZ (`isPersistableOrderId`); gerçek id birkaç saniye içinde gelince yazılır.
 */

/** Geçerli bir Trendyol paket id'si mi? (pozitif tam sayı; 0, boş, metin → null) */
export function trendyolPackageId(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return /^[1-9]\d*$/.test(s) ? s : null;
}

/** Geçici kimliklerin ön eki — kalıcı kayda yazılmazlar. */
const GECICI_ONEK = "ty-gecici-";

/**
 * Siparişin uygulama içi kimliği. Paket id'si yoksa sipariş numarasıyla (o da yoksa `yedek` ile)
 * geçici kimlik üretilir — iki sipariş asla aynı anahtara düşmez.
 */
export function trendyolOrderId(
  o: { id?: unknown; orderNumber?: unknown },
  yedek: string | number,
): string {
  const paket = trendyolPackageId(o.id);
  if (paket) return `ty-${paket}`;
  const no = o.orderNumber == null ? "" : String(o.orderNumber).trim();
  return `${GECICI_ONEK}${no || `satir-${yedek}`}`;
}

/** Paket id'si "yokmuş" gibi davranan değerler — eski kodun ürettiği bozuk kimliklerin gövdesi. */
const BOS_PAKET = new Set(["", "0", "null", "undefined", "NaN"]);

/**
 * Bu sipariş kimliği kalıcı kayda (finans ve satış geçmişi) yazılabilir mi?
 *
 * Yalnız BİLİNEN bozuk Trendyol kimlikleri reddedilir (geçici kimlik, "ty-0", "ty-" …). Kural
 * bilerek dar: beklenmedik ama geçerli bir biçim sessizce elenip ciro kaybolmasın.
 * Diğer platformların kimliği zaten sabit.
 */
export function isPersistableOrderId(platform: string, externalOrderId: string): boolean {
  if (platform !== "trendyol") return true;
  if (externalOrderId.startsWith(GECICI_ONEK)) return false;
  const govde = externalOrderId.startsWith("ty-") ? externalOrderId.slice(3) : externalOrderId;
  return !BOS_PAKET.has(govde.trim());
}
