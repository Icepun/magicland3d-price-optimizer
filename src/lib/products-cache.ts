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
