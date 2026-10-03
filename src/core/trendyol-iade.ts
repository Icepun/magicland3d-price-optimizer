/**
 * TRENDYOL İADELERİ — masaüstü ve telefonun ORTAK kuralı (sync-core ile telefona kopyalanır).
 *
 * ⚠️ NEDEN VAR (ölçüldü 4 Eki 2026): Trendyol iade edilen siparişin paketini "Delivered"
 * bırakıyor; satır durumu da "Delivered" kalıyor. İade bilgisi YALNIZ iade talepleri ucunda
 * (`/claims`) duruyor. Uygulama o uca hiç bakmadığı için Haziran–Eylül arasında iade edilen 11
 * sipariş (₺4.899,88 ciro, ₺1.096,82 kâr) Raporlar'da ve Panel'de satış sayılıyordu.
 *
 * Talepteki `orderOutboundPackageId` siparişin ASIL gönderi paketidir — sipariş listesindeki
 * paket id'siyle (`ty-<id>`) aynıdır. `orderShipmentPackageId` ise iade kargosunun paketidir,
 * eşleştirmede KULLANILMAZ.
 *
 * Yalnız "Accepted" kalemler iade sayılır: "Created"/"WaitingInAction" henüz sonuçlanmamış,
 * "Cancelled"/"Rejected" ise iade olmamış taleplerdir.
 */

/** İade talebinin bu kuralın okuduğu kısmı — alanların hepsi savunmalı okunur. */
export interface TrendyolIadeTalebi {
  orderNumber?: string | number | null;
  /** İadesi istenen ASIL gönderi paketi. */
  orderOutboundPackageId?: string | number | null;
  items?:
    | {
        orderLine?: { id?: string | number | null } | null;
        claimItems?:
          | {
              id?: string | number | null;
              claimItemStatus?: { name?: string | null } | null;
            }[]
          | null;
      }[]
    | null;
}

export interface TrendyolTalepSayfasi {
  content?: TrendyolIadeTalebi[] | null;
  totalPages?: number | null;
}

/** Bir paketin kabul edilmiş iadesi. */
export interface TrendyolPaketIadesi {
  /** Parası iade edilen (kabul edilmiş) adet — her talep kalemi bir adettir. */
  kabulAdet: number;
  /** Kabul edilmiş kalemi olan sipariş satırı sayısı. */
  satirSayisi: number;
}

export type TrendyolIadeDurumu = "tam" | "kismi";

/** Sayfa boyu ve güvenlik tavanı — bozuk bir yanıt sonsuz döngüye sokmasın. */
export const TRENDYOL_TALEP_SAYFA_BOYU = 200;
export const TRENDYOL_TALEP_SAYFA_TAVANI = 20;

const KABUL = "accepted";

function paketAnahtari(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return /^[1-9]\d*$/.test(s) ? `ty-${s}` : null;
}

/**
 * Talepleri paket başına KABUL EDİLMİŞ iadeye indir. Anahtar sipariş kimliğiyle aynı biçimde:
 * `ty-<paket id>`.
 *
 * Aynı talep kalemi iki sayfada/pencerede gelirse bir kez sayılır (kimliği üzerinden).
 */
export function trendyolIadeleri(
  talepler: readonly TrendyolIadeTalebi[]
): Map<string, TrendyolPaketIadesi> {
  const gorulen = new Set<string>();
  const sonuc = new Map<string, { kabulAdet: number; satirlar: Set<string> }>();
  for (const talep of talepler) {
    const anahtar = paketAnahtari(talep?.orderOutboundPackageId);
    if (!anahtar) continue;
    for (const [satirSirasi, kalem] of (talep.items ?? []).entries()) {
      const satirKimligi = kalem?.orderLine?.id == null ? `sira-${satirSirasi}` : String(kalem.orderLine.id);
      for (const [kalemSirasi, ci] of (kalem?.claimItems ?? []).entries()) {
        if ((ci?.claimItemStatus?.name ?? "").trim().toLowerCase() !== KABUL) continue;
        const kalemKimligi =
          ci?.id == null ? `${anahtar}:${satirKimligi}:${kalemSirasi}` : String(ci.id);
        if (gorulen.has(kalemKimligi)) continue;
        gorulen.add(kalemKimligi);
        const paket = sonuc.get(anahtar) ?? { kabulAdet: 0, satirlar: new Set<string>() };
        paket.kabulAdet += 1;
        paket.satirlar.add(satirKimligi);
        sonuc.set(anahtar, paket);
      }
    }
  }
  return new Map(
    [...sonuc].map(([anahtar, p]) => [anahtar, { kabulAdet: p.kabulAdet, satirSayisi: p.satirlar.size }])
  );
}

/**
 * Paket TAMAMEN mi iade edildi, yoksa bir kısmı mı?
 *
 * BİLİNMEYEN ≠ İADE: paketin adedi bilinmiyorsa hiçbir iddia üretilmez — tahminle ciro silinmez.
 */
export function trendyolIadeDurumu(
  paketAdet: number,
  iade: TrendyolPaketIadesi | undefined
): TrendyolIadeDurumu | null {
  if (!iade || iade.kabulAdet <= 0) return null;
  if (!Number.isFinite(paketAdet) || paketAdet <= 0) return null;
  return iade.kabulAdet >= paketAdet ? "tam" : "kismi";
}

/**
 * Talepleri sayfa sayfa topla. `sayfaGetir` platforma özgü isteği yapar (masaüstü istemcisi /
 * telefonun fetch'i); sayfalama ve tavan kuralı burada tek yerde durur.
 */
export async function trendyolTalepleriniTopla(
  sayfaGetir: (sayfa: number, boyut: number) => Promise<TrendyolTalepSayfasi>
): Promise<TrendyolIadeTalebi[]> {
  const hepsi: TrendyolIadeTalebi[] = [];
  for (let sayfa = 0; sayfa < TRENDYOL_TALEP_SAYFA_TAVANI; sayfa++) {
    const yanit = await sayfaGetir(sayfa, TRENDYOL_TALEP_SAYFA_BOYU);
    const icerik = Array.isArray(yanit?.content) ? yanit.content : [];
    for (const talep of icerik) hepsi.push(talep);
    const toplamSayfa = Number(yanit?.totalPages);
    if (icerik.length < TRENDYOL_TALEP_SAYFA_BOYU) break;
    if (Number.isFinite(toplamSayfa) && sayfa + 1 >= toplamSayfa) break;
  }
  return hepsi;
}
