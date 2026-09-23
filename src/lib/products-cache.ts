import type { QueryClient } from "@tanstack/react-query";

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
    qc.setQueriesData<Array<{ id: string }>>({ queryKey: ["products"] }, (old) =>
      Array.isArray(old) ? old.map((p) => byId.get(p.id) ?? p) : old
    );
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
  qc.setQueriesData<StokluUrun[] | undefined>({ queryKey: ["products"] }, (old) =>
    Array.isArray(old) ? old.map(yama) : old
  );
  qc.setQueriesData<StokluDetay | undefined>({ queryKey: ["product"] }, (old) => {
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
