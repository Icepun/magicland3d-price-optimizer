/**
 * Turso'ya giden HER HTTP isteğine ZAMAN AŞIMI koyar — uygulamanın kilitlenmesinin kök çözümü.
 *
 * ÖLÇÜLEN KİLİT (14 Ağu 2026): uygulamada TÜM veritabanı rotaları 12sn+ yanıtsız kalırken
 * (printers, products, spools, printable-models) AYRI bir süreçten aynı sorgu 340ms sürüyordu.
 * Turso, ağ ve makine sağlıklıydı. Yeniden başlatmak yalnız ~15-20 saniye işe yarıyordu.
 *
 * SEBEP: @libsql/client HTTP istemcisi istekleri 20'lik bir eşzamanlılık havuzundan geçiriyor
 * (@libsql/core config.js: `concurrency = Math.max(0, concurrency || 20)` → `promiseLimit(20)`)
 * ve isteğin KENDİSİNDE zaman aşımı yok. Ağ bir kez takılınca (WiFi geçişi, uyku, NAT'ın
 * boştaki soketi düşürmesi) o istek iznini BIRAKMIYOR. Yirmi takılma birikince havuz dolar ve
 * uygulamadaki her sorgu sonsuza kadar kuyrukta bekler. Yeniden başlatma sayacı sıfırladığı
 * için kısa süre düzeliyor, izinler yeniden tükenince kilit geri geliyordu.
 *
 * Laboratuvarda yeniden üretildi: 20 istek takılıyken 21. sorgu zaman aşımı YOKken 15sn'de
 * dönmedi, VARken 2042ms'de çalıştı.
 *
 * ÇÖZÜM: kalıcı kilidi geçici hataya çevir. Takılan istek iptal edilir, izin havuza geri döner,
 * uygulama yaşamaya devam eder. Süre ölçülen en yavaş meşru sorgunun (~3,5sn) çok üstünde
 * seçildi; meşru işi kesmez, yalnız gerçekten ölmüş isteği toplar.
 */

/** Zaman aşımı süresi (ms). En az 5sn; env ile ayarlanabilir. */
export function dbFetchTimeoutMs(): number {
  return Math.max(5_000, Number(process.env.MLHUB_DB_FETCH_TIMEOUT_MS) || 20_000);
}

type FetchLike = (input: unknown, init?: { signal?: AbortSignal }) => Promise<unknown>;

/**
 * Verilen fetch'i zaman aşımıyla sarar. `temel` verilmezse global fetch kullanılır
 * (test bunu kendi sahte fetch'iyle çağırır).
 */
export function withDbFetchTimeout(temel?: FetchLike, timeoutMs?: number): FetchLike {
  const alt: FetchLike =
    temel ?? ((input, init) => (fetch as unknown as FetchLike)(input, init));
  const sure = timeoutMs ?? dbFetchTimeoutMs();

  return (input, init) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), sure);
    // Çağıranın kendi iptal sinyali varsa onu da dinle — yoksa iptal yutulurdu.
    const disSinyal = init?.signal;
    if (disSinyal) {
      if (disSinyal.aborted) ctrl.abort();
      else disSinyal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    return alt(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  };
}
