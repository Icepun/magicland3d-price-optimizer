/**
 * Basit, süreç-içi stale-while-revalidate (SWR) önbelleği.
 *
 * NEDEN: Turso'ya uzak-HTTP modunda her ağır okuma (panel ~2sn) bir ağ gidiş-dönüşü. Kullanıcı
 * her açılışta/gezinmede bunu bekliyordu ("veri çekmek çok yavaş"). Bu önbellek:
 *   - TAZE (< ttl): anında döner (ağ yok).
 *   - BAYAT: bayatı ANINDA döner + arka planda sessizce tazeler → kullanıcı ASLA beklemez.
 *   - HİÇ YOK: hesaplar; aynı anahtara gelen eşzamanlı istekler TEK hesabı paylaşır (dedup).
 * Açılışta ısıtılırsa (instrumentation) kullanıcı uygulamayı açtığında panel zaten hazırdır.
 *
 * Sadece OKUMA (GET) sonuçları için. Bayatlık üst sınırı ttl kadar; kullanıcı bir şey değiştirince
 * bustCache() ile ilgili anahtarlar temizlenebilir (anında tazelik gerekiyorsa).
 */
type Entry = { at: number; data: unknown };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

function runAndStore<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const p = compute()
    .then((d) => {
      store.set(key, { at: Date.now(), data: d });
      return d;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p as Promise<unknown>);
  return p;
}

export async function swr<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);

  if (hit) {
    if (now - hit.at < ttlMs) return hit.data as T; // taze
    // Bayat → bayatı hemen dön; arka planda tazele (hata olursa bayat kalsın).
    if (!inflight.has(key)) {
      runAndStore(key, compute).catch(() => {
        /* tazeleme başarısız → mevcut bayat veri korunur */
      });
    }
    return hit.data as T;
  }

  // Hiç yok → hesapla (eşzamanlı istekler tek hesabı paylaşır).
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  return runAndStore(key, compute);
}

/** Verilen ön ekle başlayan tüm anahtarları temizle (argümansız: hepsi). Yazma sonrası tazelik için. */
export function bustCache(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}
