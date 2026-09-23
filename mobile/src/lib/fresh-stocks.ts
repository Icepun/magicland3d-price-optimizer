import type { QueryClient } from "@tanstack/react-query";

import { dbEpochMs } from "@core/sqlite-date";
import { invalidateProductSuperset } from "@/lib/db/dashboard";
import { enEskiStokOkumasi, stoklariYama } from "@/lib/stock-cache";
import { query } from "@/lib/turso";

/**
 * DEĞİŞEN STOKLARI ÇEK — masaüstündeki `refreshChangedStocks`'ın telefondaki karşılığı.
 *
 * Stok başka yerde de değişiyor: masaüstünde, siparişle, diğer telefonda. Telefonun önbelleği
 * bunları görmüyordu; uygulama açıkken liste ve varyant grubu eski stoğu gösteriyordu. Uygulamaya
 * ve ürün ekranlarına dönüşte TEK küçük sorgu atılır (kâr hesabı yok): son okumadan beri
 * güncellenen ürünlerin yalnız stoğu, sonra dört önbelleğe birden yama.
 */
const EN_SIK_MS = 5_000;
/**
 * Telefonla masaüstünün saati birebir aynı değil; `updatedAt`'i hangisi yazdıysa onun saatiyle
 * yazılı. Pay bol tutulur — aynı ürünü iki kez yamamak zararsız, bir değişikliği kaçırmak değil.
 */
const SAAT_PAYI_MS = 2 * 60_000;
const AZAMI = 1000;

let sonSorgu = 0;
let sonDeneme = 0;
let suren: Promise<number> | null = null;

export function refreshChangedStocks(qc: QueryClient): Promise<number> {
  if (suren) return suren;
  const simdi = Date.now();
  if (simdi - sonDeneme < EN_SIK_MS) return Promise.resolve(0);
  sonDeneme = simdi;
  // Başlangıç: önbellekteki EN ESKİ stok okuması (diskten geri yüklenmiş saatler öncesi veri
  // de olabilir). Önbellekte stoklu veri yoksa yamanacak bir şey de yok.
  const bas = sonSorgu || enEskiStokOkumasi(qc);
  if (!bas) return Promise.resolve(0);
  suren = (async () => {
    try {
      const rows = await query<{ id: string; stock: number }>(
        `SELECT id, stock FROM Product WHERE ${dbEpochMs("updatedAt")} >= ? LIMIT ${AZAMI}`,
        [Math.floor(bas - SAAT_PAYI_MS)]
      );
      sonSorgu = simdi;
      const items = (rows as unknown as { id: string; stock: number }[]).map((r) => ({
        id: String(r.id),
        stock: Number(r.stock),
      }));
      const n = stoklariYama(qc, items);
      // Değişiklik varsa 30 sn'lik ürün tamponu da boşalır: yoksa sonraki liste tazelemesi
      // tampondaki ESKİ stoğu getirip bu yamayı ezerdi (bkz. invalidateProductSuperset).
      if (n > 0) invalidateProductSuperset();
      return n;
    } catch {
      return 0; // bir kolaylık — ağ yoksa ekran eskisi gibi çalışır
    } finally {
      suren = null;
    }
  })();
  return suren;
}
