/**
 * Küçük gösterim (liste/kart kutucuğu) için optimize görsel URL'i.
 *
 * Neden: Shopify CDN varsayılan olarak TAM BOY görsel verir (1000px+). 40x40 bir kutucuk için
 * tam boyu indirmek + decode etmek yavaş ve gereksiz bant genişliği. Shopify CDN `width=` query
 * parametresiyle küçük varyant üretir → çok daha hızlı yüklenir + decode olur + tarayıcı yine
 * uzun süre cache'ler. Yerel `/api/images/<uuid>` görselleri zaten 1 yıl `immutable` cache'li
 * (her render'da yeniden çekilmez) → onlara dokunmuyoruz, olduğu gibi döner.
 */
export function thumbUrl(url: string | null | undefined, px = 100): string | null {
  if (!url) return null;
  if (/(?:cdn|[\w.-]*\.cdn)\.shopify\.com/i.test(url)) {
    return `${url}${url.includes("?") ? "&" : "?"}width=${px}`;
  }
  // Trendyol CDN: host'tan hemen sonra `mnresize/{w}/{h}/` yol öneki (mobil src/lib/image.ts ile
  // aynı; curl ile doğrulandı: 189KB → 2.6KB, ~72x küçülme).
  const ty = url.match(/^(https?:\/\/cdn\.dsmcdn\.com)\/(?!mnresize\/)(.+)$/i);
  if (ty) {
    return `${ty[1]}/mnresize/${px}/${px}/${ty[2]}`;
  }
  return url;
}
