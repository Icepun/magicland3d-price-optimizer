import type { QueryClient } from "@tanstack/react-query";

/**
 * STOĞU TÜM ÖNBELLEKLERE YAMA — saf (ağ yok; kökteki testler doğrudan içe aktarır).
 *
 * Telefonda stok DÖRT ayrı önbellekte duruyor: ürün listesi (`dashboard-data`, Ürünler sekmesi
 * ve Üretim planı), eşleştirme listesi (`match-products`, sipariş kârı), ürün detayı
 * (`product`) ve varyant grubu (`variant-group`, detaydaki "Varyant grubu" bölümü).
 *
 * ⚠️ SAHADA YAŞANDI (23 Eyl 2026): stok değişince yalnız ilk ikisi ve detay güncelleniyordu;
 * varyant grubu listesi ESKİ stoğu göstermeye devam ediyordu (varsayılan tazelik 5 dk). Varyant
 * üründe stok düşüp geri gelince grup listesi eski değerde takılı kalıyordu. Tek fonksiyonun
 * hepsini birden yamaması, bir önbelleğin unutulmasını imkânsız kılar.
 */
export interface StokDegisimi {
  id: string;
  stock: number;
}

type Stoklu = { id: string; stock: number };

export function stoklariYama(qc: QueryClient, items: readonly StokDegisimi[]): number {
  if (items.length === 0) return 0;
  const harita = new Map(items.map((i) => [i.id, i.stock]));
  const yama = <T extends Stoklu>(p: T): T => {
    const yeni = harita.get(p.id);
    return yeni === undefined || yeni === p.stock ? p : { ...p, stock: yeni };
  };
  for (const kok of ["dashboard-data", "match-products"]) {
    qc.setQueriesData<Stoklu[] | undefined>({ queryKey: [kok] }, (old) =>
      Array.isArray(old) ? old.map(yama) : old
    );
  }
  qc.setQueriesData<Stoklu | null | undefined>({ queryKey: ["product"] }, (old) =>
    old && typeof old === "object" && "id" in old ? yama(old) : old
  );
  qc.setQueriesData<{ members: Stoklu[] } | null | undefined>({ queryKey: ["variant-group"] }, (old) =>
    old && Array.isArray(old.members) && old.members.some((m) => harita.has(m.id))
      ? { ...old, members: old.members.map(yama) }
      : old
  );
  return items.length;
}

/** Önbellekteki stoklu verinin EN ESKİ alınma anı — "bundan sonra ne değişti" sorusunun başı. */
export function enEskiStokOkumasi(qc: QueryClient): number {
  const kokler = new Set(["dashboard-data", "match-products", "product", "variant-group"]);
  let enEski = 0;
  for (const q of qc.getQueryCache().getAll()) {
    const kok = q.queryKey[0];
    if (typeof kok !== "string" || !kokler.has(kok) || q.state.data == null) continue;
    const t = q.state.dataUpdatedAt;
    if (t > 0 && (enEski === 0 || t < enEski)) enEski = t;
  }
  return enEski;
}
