import type { QueryClient, QueryKey } from "@tanstack/react-query";

// ── Bayatlığı koruyan yama ─────────────────────────────────────────────────────────────────

/** Aynı uzunlukta ve her eleman aynı nesne → değişiklik yok. */
function ayniDizi(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Önbelleğe yama — "BAYAT" İŞARETİ KORUNUR, değişmeyen önbelleğe dokunulmaz.
 *
 * NEDEN (Ürünler denetimi, 23 Kas 2026): React Query'de `setQueryData` sorguyu taze işaretler
 * (`isInvalidated = false`). Ürün listesi `staleTime: Infinity` olduğu için tek tazelik işareti
 * budur. Bir sekmede toplu desi girilip liste geçersiz kılındıktan sonra gelen tek bir stok yaması
 * bu işareti TÜM sekmelerde siliyordu → diğer sekmeye geçince liste yeniden çekilmiyor, eski
 * "Desi eksik" satırları duruyordu. Burada önceden bayat olan sorgu yamadan sonra yine bayat
 * işaretlenir (yeniden çekim tetiklemeden); değişmeyen dizide `setQueryData` hiç çağrılmaz.
 */
export function yamalaBayatligiKoru<T>(qc: QueryClient, anahtar: QueryKey, yama: (eski: T) => T): void {
  for (const q of qc.getQueryCache().findAll({ queryKey: anahtar })) {
    const eski = q.state.data as T | undefined;
    if (eski === undefined) continue;
    const yeni = yama(eski);
    if (yeni === eski) continue;
    if (Array.isArray(eski) && Array.isArray(yeni) && ayniDizi(eski, yeni)) continue;
    const bayatti = q.state.isInvalidated;
    qc.setQueryData(q.queryKey, yeni);
    if (bayatti) void qc.invalidateQueries({ queryKey: q.queryKey, exact: true, refetchType: "none" });
  }
}

/** Ürün listesi önbelleklerinin (`["products", *]`) hepsine yama; dizi olmayanlar atlanır. */
export function urunListesiniYamala<T>(qc: QueryClient, yama: (eski: T[]) => T[]): void {
  yamalaBayatligiKoru<unknown>(qc, ["products"], (eski) => (Array.isArray(eski) ? yama(eski as T[]) : eski));
}

/**
 * İyimser güncellemeden ÖNCE süren liste çekimini durdurur (eski yanıt yamanın üstüne yazmasın).
 * Bir çekim durdurulduysa true döner: çağıran işlem bitince listeyi yeniden çekmeli — yoksa
 * "Yenile"nin sonucu sessizce kaybolur (denetim bulgusu).
 */
export async function listeCekiminiDurdur(qc: QueryClient): Promise<boolean> {
  const suruyordu = qc.isFetching({ queryKey: ["products"] }) > 0;
  await qc.cancelQueries({ queryKey: ["products"] });
  return suruyordu;
}

// ── Liste yanıtı: gövdenin hesaplandığı an ────────────────────────────────────────────────

/**
 * Liste anahtarı → sunucunun gövdeyi HESAPLADIĞI an. Sunucu açılışta diskteki eski bir gövdeyi
 * hemen verebiliyor; stok tazelemesi istemcinin yanıtı ALDIĞI andan değil bu andan devam etmeli,
 * yoksa aradaki (ör. telefonda yapılan) stok değişiklikleri hiç gelmez (denetim bulgusu).
 */
const listeZamanlari = new Map<string, number>();
/** Bayat gövde için otomatik yeniden çekim — anahtar başına en çok 5 dakikada bir. */
const sonOtomatikTazeleme = new Map<string, number>();

export function listeZamani(anahtar: QueryKey): number | undefined {
  return listeZamanlari.get(JSON.stringify(anahtar));
}

/**
 * Ürün listesini çeker; gövdenin hesaplandığı anı kaydeder. Sunucu bayat (diskten) bir gövde
 * verdiyse ve arkada tazeliyorsa listeyi ~20 sn sonra bir kez daha çeker.
 */
export async function urunListesiGetir<T>(
  qc: QueryClient,
  anahtar: QueryKey,
  url: string,
  signal?: AbortSignal,
): Promise<T> {
  const istekAni = Date.now();
  const res = await fetch(url, { signal });
  if (!res.ok) await yanitHatasiFirlat(res);
  const veri = (await res.json()) as T;
  const zaman = Number(res.headers.get("x-liste-zamani")) || istekAni;
  const k = JSON.stringify(anahtar);
  listeZamanlari.set(k, zaman);
  // Yeni gövde önceki yamaların yerine geçti: stok tazelemesi gövdenin anından yeniden başlar.
  stokTazeleme.sonMs = Math.min(stokTazeleme.sonMs || zaman, zaman);
  if (res.headers.get("x-liste-bayat") === "1") {
    const son = sonOtomatikTazeleme.get(k) ?? 0;
    if (Date.now() - son > 5 * 60_000) {
      sonOtomatikTazeleme.set(k, Date.now());
      setTimeout(() => void qc.invalidateQueries({ queryKey: anahtar, exact: true }), 20_000);
    }
  }
  return veri;
}

/** `fetchJson` ile aynı hata dili: sunucunun açıklaması varsa o, yoksa sade bir cümle. */
async function yanitHatasiFirlat(res: Response): Promise<never> {
  const payload: unknown = await res.json().catch(() => null);
  const detail =
    payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : null;
  throw new Error(detail || (res.status >= 500 ? "Sunucuda bir sorun oluştu, tekrar dene." : "İstek tamamlanamadı."));
}

/**
 * MİNİMUM DB OKUMA: yalnız verilen ürün(ler)i `/api/products?ids=` ile çek (TÜM listeyi değil),
 * dönen güncel kâr/fiyat satırlarını TÜM `["products", *]` cache'lerine yamala.
 *
 * Neden: bir ürünün maliyeti/listing'i (kâr-etkileyen) değişince 368 ürünü baştan çekmek
 * uygulamayı donduruyordu. Artık yalnız o ürün(ler) çekilir → liste anında güncel, donma yok.
 *
 * NE ZAMAN: SADECE kâr/fiyat hesabını değiştiren işlemler (maliyet, listing fiyat/komisyon/kargo,
 * varyanta-maliyet-uygula). Kâr-etkilemeyen değişiklikler (alias/stok/gizle/M2O) için GEREKMEZ —
 * onlar optimistic `setQueriesData` ile zaten anında güncellenir, ekstra okuma yapılmaz.
 */
export async function patchProductsInCache(
  qc: QueryClient,
  ids: Array<string | null | undefined>
): Promise<void> {
  const valid = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (valid.length === 0) return;
  try {
    const res = await fetch(`/api/products?ids=${valid.map(encodeURIComponent).join(",")}`);
    if (!res.ok) return;
    const fresh = (await res.json()) as Array<{ id: string }>;
    if (!Array.isArray(fresh) || fresh.length === 0) return;
    const byId = new Map(fresh.map((p) => [p.id, p]));
    urunListesiniYamala<{ id: string }>(qc, (old) => old.map((p) => byId.get(p.id) ?? p));
  } catch {
    /* sessiz: liste bir sonraki global tazelemede/"Yenile"de güncellenir */
  }
}

// ── Stok yaması ──────────────────────────────────────────────────────────────────────────────

type StokluUrun = { id: string; stock: number };
/** Ürün detayı önbelleği — varyant grubu üyelerinin stoğu BURADA da kopya durur. */
type StokluDetay = StokluUrun & { variantGroup?: { products?: StokluUrun[] } | null };

/**
 * Kullanıcının az önce değiştirdiği ve henüz sunucuya yazılmamış stoklar. Uzaktan gelen tazeleme
 * bunların üstüne yazmaz — yoksa "-1'e bastım, eski değere geri döndü" titremesi olurdu.
 * `useStockWriter` doldurur/boşaltır.
 */
const bekleyenStokYazimlari = new Set<string>();

export function markStockWritePending(id: string, bekliyor: boolean): void {
  if (bekliyor) bekleyenStokYazimlari.add(id);
  else bekleyenStokYazimlari.delete(id);
}

/**
 * Verilen stokları TÜM ürün önbelleklerine yamala: liste (`["products", *]`), ürün detayı
 * (`["product", id]`) ve detaylardaki varyant grubu kopyaları. Değişmeyen satırın nesnesi
 * korunur (gereksiz yeniden çizim yok).
 */
export function patchStocksInCache(
  qc: QueryClient,
  stoklar: StokluUrun[],
  secenek: { bekleyenleriAtla?: boolean } = {},
): void {
  const harita = new Map<string, number>();
  for (const s of stoklar) {
    if (secenek.bekleyenleriAtla && bekleyenStokYazimlari.has(s.id)) continue;
    harita.set(s.id, s.stock);
  }
  if (harita.size === 0) return;
  const yama = <T extends StokluUrun>(p: T): T => {
    const yeni = harita.get(p.id);
    return yeni === undefined || yeni === p.stock ? p : { ...p, stock: yeni };
  };
  urunListesiniYamala<StokluUrun>(qc, (old) => old.map(yama));
  yamalaBayatligiKoru<StokluDetay | undefined>(qc, ["product"], (old) => {
    if (!old || typeof old !== "object" || !("id" in old)) return old;
    let sonuc = yama(old);
    const uyeler = old.variantGroup?.products;
    if (uyeler?.some((p) => harita.has(p.id))) {
      sonuc = { ...sonuc, variantGroup: { ...old.variantGroup!, products: uyeler.map(yama) } };
    }
    return sonuc;
  });
}

/** Son hafif stok tazelemesinin sunucu zamanı — bir sonraki istek buradan devam eder. */
const stokTazeleme = { sonMs: 0, surenIstek: null as Promise<number> | null };

/**
 * Son okumadan beri (bu cihazda ya da TELEFONDA) değişen stokları çekip önbelleklere yamalar.
 * Tek küçük sorgu — kâr hesabı yok. `enErken`: listenin sunucudan alındığı an (ilk çağrıda
 * bundan sonrası sorulur). Dönen değer: yamalanan ürün sayısı.
 */
export function refreshChangedStocks(qc: QueryClient, enErken: number): Promise<number> {
  if (stokTazeleme.surenIstek) return stokTazeleme.surenIstek;
  const since = Math.max(stokTazeleme.sonMs, enErken) - 15_000; // saat/yazım gecikmesi payı
  const istek = (async () => {
    try {
      const res = await fetch(`/api/products/stock?since=${Math.floor(since)}`, { cache: "no-store" });
      if (!res.ok) return 0;
      const govde = (await res.json()) as { now?: number; items?: StokluUrun[] };
      if (typeof govde.now === "number") stokTazeleme.sonMs = govde.now;
      const items = Array.isArray(govde.items) ? govde.items : [];
      patchStocksInCache(qc, items, { bekleyenleriAtla: true });
      return items.length;
    } catch {
      return 0; // bir kolaylık — başarısızlığı ekranı bozmaz
    } finally {
      stokTazeleme.surenIstek = null;
    }
  })();
  stokTazeleme.surenIstek = istek;
  return istek;
}
