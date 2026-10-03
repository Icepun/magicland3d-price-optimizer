import { prisma } from "@/lib/prisma";
import { bustFinanceCaches } from "@/lib/cache-busting";
import {
  trendyolIadeDurumu,
  trendyolIadeleri,
  trendyolTalepleriniTopla,
  type TrendyolPaketIadesi,
  type TrendyolTalepSayfasi,
} from "@/core/trendyol-iade";

/**
 * TRENDYOL İADE TALEPLERİ — paket durumu iadeyi GÖSTERMEDİĞİ için ayrıca okunur (kural ve ölçüm:
 * `core/trendyol-iade.ts`).
 *
 * Geriye 150 gün: iade teslimden haftalar sonra gelebiliyor ve 60 günlük sipariş penceresinden
 * çıkmış siparişin kaydı da düzeltilmeli. Tek istek (~20 talep) — yine de her yenilemede
 * sorulmasın diye 10 dakika hatırlanır.
 */
const IADE_GERIYE_GUN = 150;
const IADE_TAZE_MS = 10 * 60_000;
let onbellek: { at: number; iadeler: Map<string, TrendyolPaketIadesi> } | null = null;

/** Talep ucunu açan istemcinin bu modülün kullandığı kısmı. */
export interface TrendyolTalepIstemcisi {
  listClaims(params: {
    startDate: number;
    endDate: number;
    page?: number;
    size?: number;
  }): Promise<TrendyolTalepSayfasi>;
}

/**
 * Kabul edilmiş iadeler (paket → adet). Hata FIRLATMAZ: uç alınamazsa siparişler etkilenmez,
 * yalnız bu turda iade işlenmez (eldeki son sonuç varsa o kullanılır).
 */
export async function trendyolIadeleriniOku(
  client: TrendyolTalepIstemcisi
): Promise<Map<string, TrendyolPaketIadesi>> {
  if (onbellek && Date.now() - onbellek.at < IADE_TAZE_MS) return onbellek.iadeler;
  try {
    const endDate = Date.now();
    const startDate = endDate - IADE_GERIYE_GUN * 86_400_000;
    const talepler = await trendyolTalepleriniTopla((page, size) =>
      client.listClaims({ startDate, endDate, page, size })
    );
    const iadeler = trendyolIadeleri(talepler);
    onbellek = { at: Date.now(), iadeler };
    return iadeler;
  } catch (error) {
    console.error(
      "[trendyol-iade] iade talepleri alınamadı:",
      error instanceof Error ? error.message : error
    );
    return onbellek?.iadeler ?? new Map();
  }
}

/** Testler için: hatırlanan talepleri unut. */
export function trendyolIadeOnbelleginiSifirla(): void {
  onbellek = null;
}

/**
 * KALICI GEÇMİŞE (Raporlar) TRENDYOL İADESİNİ İŞLE.
 *
 * Canlı listedeki siparişler normal yazım yolunda zaten "iade" olarak yazılıyor. Burada kalan iki
 * delik kapatılır:
 *  1. Sipariş penceresinin DIŞINA düşmüş siparişler: iade çoğu zaman teslimden 1-3 hafta sonra
 *     geliyor; sipariş o sırada 60 günlük pencereden çıkmış olabilir ve bir daha yazılmaz.
 *  2. Telefonun eski sürümü iadeyi bilmediği için kaydı yeniden satışa çevirebiliyor.
 *
 * Yalnız TAM iade işlenir; kısmi iadede ciroya dokunulmaz (canlı listeyle aynı kural). Paket
 * adedi kalem geçmişinden okunur — kalemi kayıtlı olmayan siparişte iddia üretilmez.
 *
 * Döndürdüğü sayı düzeltilen sipariş adedidir. Hata FIRLATMAZ: siparişleri getirmeyi bozamaz.
 */
export async function trendyolIadeleriniGecmiseIsle(
  iadeler: ReadonlyMap<string, TrendyolPaketIadesi>
): Promise<number> {
  const kimlikler = [...iadeler.keys()];
  if (kimlikler.length === 0) return 0;
  try {
    const yer = kimlikler.map(() => "?").join(",");
    const acik = await prisma.$queryRawUnsafe<Array<{ externalOrderId: string }>>(
      `SELECT "externalOrderId" FROM "OrderFinanceSnapshot"
        WHERE "platform" = 'trendyol' AND "statusKind" <> 'cancelled'
          AND "externalOrderId" IN (${yer})`,
      ...kimlikler
    );
    if (acik.length === 0) return 0;

    const adetler = await prisma.$queryRawUnsafe<Array<{ externalOrderId: string; adet: unknown }>>(
      `SELECT "externalOrderId", SUM("quantity") AS "adet" FROM "OrderItemSnapshot"
        WHERE "platform" = 'trendyol'
          AND "externalOrderId" IN (${acik.map(() => "?").join(",")})
        GROUP BY "externalOrderId"`,
      ...acik.map((r) => r.externalOrderId)
    );
    const adetHaritasi = new Map(adetler.map((r) => [String(r.externalOrderId), Number(r.adet)]));
    const tam = acik
      .map((r) => String(r.externalOrderId))
      .filter((id) => trendyolIadeDurumu(adetHaritasi.get(id) ?? 0, iadeler.get(id)) === "tam");
    if (tam.length === 0) return 0;

    const tamYer = tam.map(() => "?").join(",");
    await prisma.$executeRawUnsafe(
      `UPDATE "OrderFinanceSnapshot" SET "statusKind" = 'cancelled'
        WHERE "platform" = 'trendyol' AND "statusKind" <> 'cancelled'
          AND "externalOrderId" IN (${tamYer})`,
      ...tam
    );
    // Ürün bazlı satış listeleri de iadeyi satış saymasın.
    await prisma.$executeRawUnsafe(
      `UPDATE "OrderItemSnapshot" SET "statusKind" = 'cancelled'
        WHERE "platform" = 'trendyol' AND "statusKind" <> 'cancelled'
          AND "externalOrderId" IN (${tamYer})`,
      ...tam
    );
    bustFinanceCaches();
    return tam.length;
  } catch (error) {
    console.error(
      "[trendyol-iade] geçmiş güncellenemedi:",
      error instanceof Error ? error.message : error
    );
    return 0;
  }
}
