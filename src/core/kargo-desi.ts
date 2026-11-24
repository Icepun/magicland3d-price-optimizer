/**
 * SİPARİŞİN GERÇEKTE ÇIKTIĞI KARGO DESİSİ — elle girilen (Shopify).
 *
 * Berke (24 Kas 2026): "8 desi hesaplanan bir kargoyu 4 desiyle çıkarsam bunu kargoyu çıktıktan
 * sonra editleyebilmeliyim; her Shopify siparişinde kargo desisi editlenebilir olmalı, telefondan da
 * görünmeli." Girilen desi varsa kargo bedeli ürün desilerinin toplamı yerine bununla hesaplanır
 * (çekirdek `OrderProfitInput.kargoDesi`). Masaüstü, telefon ve "Yeniden hesapla" AYNI kaydı okur.
 *
 * Kayıt: `OrderCargoDesi` tablosu, (platform, kanonik sipariş kimliği) başına TEK satır.
 */
import { siparisKimligi } from "./order-line-cost";

/** Elle kargo desisi girilebilen platformlar (pazaryerlerinde kargo faturadan gelir). */
export const KARGO_DESI_PLATFORMLARI: ReadonlySet<string> = new Set(["shopify"]);

export const KARGO_DESI_UST_SINIR = 1000;

/** Girilen değer geçerli bir desi mi (0 < desi ≤ 1000)? Değilse null. Virgül kabul edilir. */
export function kargoDesiOku(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0 || n > KARGO_DESI_UST_SINIR) return null;
  return Math.round(n * 100) / 100;
}

/** Haritada arama anahtarı — sipariş kimliği kanonik biçime çevrilir (Shopify: "sh-<no>"). */
export function kargoDesiAnahtari(platform: string, siparisId: string): string {
  return `${platform}|${siparisKimligi(platform, siparisId)}`;
}

/** Siparişin elle girilmiş kargo desisi (yoksa null). Harita düz nesneye dönmüşse de çökmez. */
export function kargoDesiBul(
  harita: ReadonlyMap<string, number> | null | undefined,
  platform: string,
  siparisId: string
): number | null {
  if (!KARGO_DESI_PLATFORMLARI.has(platform) || !(harita instanceof Map)) return null;
  return kargoDesiOku(harita.get(kargoDesiAnahtari(platform, siparisId)));
}
