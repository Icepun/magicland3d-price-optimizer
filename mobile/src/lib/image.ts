/**
 * Küçük gösterim (liste/grid kutucuğu) için optimize görsel URL'i — masaüstü src/lib/image.ts ile aynı.
 *
 * Neden: Shopify CDN varsayılan TAM BOY görsel verir (1000px+). ~48px bir kutucuk için tam boyu
 * indirmek + decode etmek YAVAŞ (mobilde liste kasması). Shopify CDN `width=` query parametresiyle
 * küçük varyant ister → çok daha hızlı iner + decode olur. Shopify dışı URL'ler olduğu gibi döner.
 */
export function thumbUrl(url: string | null | undefined, px = 160): string | null {
  if (!url) return null;
  if (/(?:cdn|[\w.-]*\.cdn)\.shopify\.com/i.test(url)) {
    return `${url}${url.includes("?") ? "&" : "?"}width=${px}`;
  }
  return url;
}
