/**
 * Küçük gösterim (liste/grid kutucuğu) için optimize görsel URL'i — masaüstü src/lib/image.ts ile aynı.
 *
 * Neden: CDN'ler varsayılan TAM BOY görsel verir (1000px+). ~48px bir kutucuk için tam boyu
 * indirmek + decode etmek YAVAŞ (mobilde liste kasması).
 * - Shopify CDN: `width=` query parametresi.
 * - Trendyol CDN (cdn.dsmcdn.com): host'tan hemen sonra `mnresize/{w}/{h}/` yol öneki
 *   (curl ile doğrulandı: 189KB → 2.6KB, ~72x küçülme; desteklenmeyen URL'de CDN 200 orijinal döner).
 * Diğer URL'ler olduğu gibi döner.
 */
export function thumbUrl(url: string | null | undefined, px = 160): string | null {
  if (!url) return null;
  if (/(?:cdn|[\w.-]*\.cdn)\.shopify\.com/i.test(url)) {
    return `${url}${url.includes("?") ? "&" : "?"}width=${px}`;
  }
  const ty = url.match(/^(https?:\/\/cdn\.dsmcdn\.com)\/(?!mnresize\/)(.+)$/i);
  if (ty) {
    return `${ty[1]}/mnresize/${px}/${px}/${ty[2]}`;
  }
  return url;
}
