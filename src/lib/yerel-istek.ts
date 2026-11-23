/**
 * YEREL İSTEK KORUMASI — uygulamanın sunucusu yalnız bu bilgisayardan ve kendi sayfalarından
 * gelen isteklere açık (denetim, 23 Kas 2026).
 *
 * Eskiden hiçbir denetim yoktu: kullanıcının tarayıcısında açık başka bir site, ön kontrol
 * gerektirmeyen bir istekle ayarları (Turso adresi, Shopify mağaza adresi, R2 kovası) değiştirebilir
 * ya da yedek geri yükleyebilirdi; DNS yeniden bağlama ile yanıtlar okunabilirdi.
 *
 * Kural:
 *  - Host yalnız localhost / 127.0.0.1 / ::1 (port serbest) — DNS yeniden bağlamayı keser.
 *  - Origin varsa o da yerel olmalı (uygulamanın kendi sayfası).
 *  - Origin yoksa tarayıcının "başka siteden" damgası (Sec-Fetch-Site: cross-site) reddedilir.
 *    Uygulamanın kendi süreç içi istekleri (Node fetch) bu başlıkları göndermez → izinli.
 */
const YEREL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function makineAdi(hostBasligi: string): string {
  const h = hostBasligi.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

export function yerelIstekMi(basliklar: {
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
}): boolean {
  if (!basliklar.host || !YEREL.has(makineAdi(basliklar.host))) return false;
  const origin = basliklar.origin?.trim();
  if (origin) {
    if (origin === "null") return false;
    try {
      return YEREL.has(new URL(origin).hostname.toLowerCase()) || YEREL.has(`[${new URL(origin).hostname}]`);
    } catch {
      return false;
    }
  }
  return basliklar.secFetchSite !== "cross-site";
}
