import { normalizeMatchKey } from "./order-match";

/**
 * ELLE ÜRÜN BAĞI — katalogla eşleşmeyen bir sipariş satırını ürüne bağlar (Siparişler →
 * "Ürüne bağla").
 *
 * Neden: ürün Shopify'da yenilenince (yeni varyant kimlikleri) eski siparişler ESKİ adla ve eski
 * kimlikle kaldı; hiçbir anahtar tutmadığı için kâr "eksik" görünüyordu (Piston Kupası, 27 Eyl 2026).
 * Bağ SATIR ADI + PLATFORM ile tutulur: o adla gelen TÜM siparişler (geçmiş ve gelecek) seçilen
 * ürüne eşlenir ve kâr O ÜRÜNÜN maliyetiyle hesaplanır (Berke'nin kararı).
 *
 * Yalnız YEDEK: satır kendi anahtarıyla (barkod/stok kodu/platform kimliği/ad) bir ürüne
 * eşleşiyorsa bağa hiç bakılmaz — bağ doğru eşleşmeyi asla ezmez.
 *
 * Masaüstü sipariş listesi, ay yeniden hesabı ve telefon bu dosyayı kullanır.
 * Bu dosya telefona da kopyalanır (`npm run sync-core`).
 */

/** Veritabanındaki kayıt (OrderLineLink) — eşleştirmenin ihtiyaç duyduğu alanlar. */
export interface SatirBagiKaydi {
  platform: string;
  lineKey: string;
  productId: string;
}

/** "<platform>|<satır anahtarı>" → ürün kimliği. */
export type SatirBaglari = ReadonlyMap<string, string>;

/**
 * Bağın satır anahtarı: "n:<normalize(ad)>" — siparişe özel maliyette eşleşmeyen satırın
 * anahtarıyla AYNI biçim (bkz. core/order-line-cost `satirAnahtari`). Boş ad → boş anahtar.
 */
export function satirBagiAnahtari(ad: string | null | undefined): string {
  const k = normalizeMatchKey(ad);
  return k ? `n:${k}` : "";
}

function haritaAnahtari(platform: string, lineKey: string): string {
  return `${platform}|${lineKey}`;
}

/** Kayıtlardan arama haritası. Bozuk (boş alanlı) kayıt atlanır. */
export function satirBaglariHaritasi(kayitlar: Iterable<SatirBagiKaydi>): Map<string, string> {
  const harita = new Map<string, string>();
  for (const k of kayitlar) {
    const platform = typeof k.platform === "string" ? k.platform : "";
    const lineKey = typeof k.lineKey === "string" ? k.lineKey : "";
    const productId = typeof k.productId === "string" ? k.productId : "";
    if (!platform || !lineKey || !productId) continue;
    harita.set(haritaAnahtari(platform, lineKey), productId);
  }
  return harita;
}

/** Bu platformda bu adla gelen satır elle bir ürüne bağlı mı? Bağlıysa ürün kimliği. */
export function bagliUrunKimligi(
  baglar: SatirBaglari | null | undefined,
  platform: string,
  ad: string | null | undefined
): string | null {
  if (!baglar || baglar.size === 0 || platform === "manual") return null;
  const lineKey = satirBagiAnahtari(ad);
  if (!lineKey) return null;
  return baglar.get(haritaAnahtari(platform, lineKey)) ?? null;
}
