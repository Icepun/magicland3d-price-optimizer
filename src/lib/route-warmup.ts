/**
 * AÇILIŞTA ÖNBELLEK ISITMA — ağır sayfaların sunucu önbelleği kullanıcı açmadan dolsun.
 *
 * NEDEN: bu uçların yanıtları diskteki SWR önbelleğinde yaşıyor, o yüzden normal kullanımda
 * anında açılıyorlar. Ama önbellek BOŞKEN (ilk kurulum, sürüm güncellemesinden sonra önbellek
 * anahtarı değiştiğinde) ilk ziyaret uzun sürüyor: 9 Eki 2026 ölçümünde Raporlar 4,1 sn, Panel
 * 4,0 sn, Ürünler 2,6 sn. Uygulama açıldıktan kısa süre sonra bunlar SIRAYLA (aynı anda değil —
 * veritabanını boğmasın) bir kez çağrılır.
 *
 * Arka plan işleriyle aynı anahtara bağlı (MLHUB_DISABLE_BACKGROUND_TASKS): test/denetim
 * süreçlerinde çalışmaz.
 */
export const ISITILACAK_UCLAR = [
  "/api/dashboard",
  "/api/finance/monthly?months=12",
  "/api/finance/monthly?section=profitability",
  "/api/products?filter=active",
] as const;

const BASLAMA_GECIKMESI_MS = 45_000; // açılışın kendi işleri (relay, sipariş izleyici) önce
const ARA_MS = 1_500;
const ZAMAN_ASIMI_MS = 90_000;

const g = globalThis as unknown as { __MLHUB_ISITMA_BASLADI__?: boolean };

export function startRouteWarmup(): void {
  const port = process.env.MLHUB_PORT;
  if (!port || g.__MLHUB_ISITMA_BASLADI__) return;
  g.__MLHUB_ISITMA_BASLADI__ = true;
  const zamanlayici = setTimeout(() => {
    void (async () => {
      for (const yol of ISITILACAK_UCLAR) {
        const bas = Date.now();
        try {
          const yanit = await fetch(`http://127.0.0.1:${port}${yol}`, {
            signal: AbortSignal.timeout(ZAMAN_ASIMI_MS),
            headers: { "x-mlhub-isitma": "1" },
          });
          await yanit.arrayBuffer(); // gövde okunmadan bağlantı serbest kalmaz
          console.info(`[isitma] ${yol} ${yanit.status} · ${Date.now() - bas} ms`);
        } catch (error) {
          console.warn(`[isitma] ${yol} atlandı:`, error instanceof Error ? error.message : error);
        }
        await new Promise((r) => setTimeout(r, ARA_MS));
      }
    })();
  }, BASLAMA_GECIKMESI_MS);
  zamanlayici.unref?.();
}
