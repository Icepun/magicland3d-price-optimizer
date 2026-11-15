/**
 * MİKRO İHRACAT — Trendyol yurt dışı siparişleri (masaüstü + telefon ortak).
 *
 * Trendyol her siparişte `micro` (boolean) ve `orderCountryCode` gönderiyor (ölçüldü 15 Kas 2026:
 * 166 paketin hepsinde alan var; 6 mikro sipariş — 5 SA, 1 AZ). Teslimat adresi yine TR görünür
 * (paket Trendyol'un yurt içi deposuna gider); müşterinin ülkesi `orderCountryCode`. Fiyatlar TL.
 * `etgbNo` kargoya verildikten sonra dolar.
 *
 * Mikro ihracat satışı KDV'den istisnadır → kâr hesabında satıştan KDV ayrılmaz
 * (`OrderProfitInput.saleVatExempt`). Berke'nin onayıyla, 15 Kas 2026.
 */

export interface MikroIhracat {
  /** Müşterinin ülkesi (ISO-3166 iki harf, büyük); Trendyol vermediyse null. */
  ulke: string | null;
}

/** Ham Trendyol siparişinden mikro ihracat bilgisi; yurt içi siparişte null. */
export function trendyolMikroIhracat(siparis: object | null | undefined): MikroIhracat | null {
  const o = siparis as { micro?: unknown; orderCountryCode?: unknown } | null | undefined;
  if (!o || o.micro !== true) return null;
  const kod = typeof o.orderCountryCode === "string" ? o.orderCountryCode.trim().toUpperCase() : "";
  return { ulke: /^[A-Z]{2}$/.test(kod) ? kod : null };
}

/** Trendyol'un mikro ihracat ülkeleri + yakın pazarlar. Listede yoksa kod gösterilir. */
const ULKE_ADLARI: Record<string, string> = {
  SA: "Suudi Arabistan",
  AE: "BAE",
  QA: "Katar",
  KW: "Kuveyt",
  OM: "Umman",
  BH: "Bahreyn",
  AZ: "Azerbaycan",
  SK: "Slovakya",
  RO: "Romanya",
  CZ: "Çekya",
  BG: "Bulgaristan",
  GR: "Yunanistan",
  HU: "Macaristan",
  PL: "Polonya",
  DE: "Almanya",
  GE: "Gürcistan",
  IQ: "Irak",
  JO: "Ürdün",
  CY: "Kıbrıs",
};

export function ulkeAdi(kod: string | null | undefined): string | null {
  if (!kod) return null;
  return ULKE_ADLARI[kod.toUpperCase()] ?? kod.toUpperCase();
}
