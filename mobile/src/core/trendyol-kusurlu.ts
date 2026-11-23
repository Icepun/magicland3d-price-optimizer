import { haftalikFaturalarlaEsle, type TyFaturaDurumu, type TyGecikmeFaturalari } from "./trendyol-gecikme";
import { talepKalemiKabulMu, trendyolPaketAnahtari, type TrendyolIadeTalebi } from "./trendyol-iade";

/**
 * TRENDYOL KUSURLU ÜRÜN BEDELİ — satıcının kusurlu / yanlış / eksik ürün gönderdiği için KABUL
 * edilen iadede kesilen ceza (Trendyol cezai şartları, 27 Tem 2026).
 *
 * Ölçüldü (23 Kas 2026): 200 günde 4 "Kusurlu Ürün Faturası" (120, 180, 120, 180 TL) kesilmiş ve her
 * biri "Kusurlu ürün gönderildi" sebebiyle kabul edilmiş TEK bir iadeyle birebir:
 *   • tutar = iade edilen ürünün fiyatının baremi (499,99 → 120 · 999,99 / 849,99 → 180)
 *   • fatura = iadenin kabul edildiği Pazartesi–Pazar haftasından sonraki Çarşamba
 *     (kabul 29 Tem → 5 Ağu · 7 Ağu → 12 Ağu · 17 Ağu → 26 Ağu · 17 Eyl → 23 Eyl)
 * Fatura siparişe bağlanmadan ("Tazmin bedelidir", KDV'siz) gelir — gecikme bedeliyle aynı düzen.
 * Müşteri kaynaklı sebepler ("Beğenmedim", "Yanlış sipariş verdim", "Vazgeçtim"…) kesilmedi.
 */

/** Barem: ihlale konu ürünlerin net satış bedeli → bedel (TL). */
export const TY_KUSURLU_BAREMI: readonly { ust: number; ceza: number }[] = [
  { ust: 199.99, ceza: 50 },
  { ust: 349.99, ceza: 100 },
  { ust: 599.99, ceza: 120 },
  { ust: 999.99, ceza: 180 },
  { ust: 2999.99, ceza: 300 },
  { ust: 9999.99, ceza: 600 },
  { ust: Number.POSITIVE_INFINITY, ceza: 1200 },
];

export function tyKusurluCezasiTutari(netSatis: number): number {
  const t = Number.isFinite(netSatis) ? Math.max(0, netSatis) : 0;
  return (TY_KUSURLU_BAREMI.find((b) => t <= b.ust) ?? TY_KUSURLU_BAREMI[TY_KUSURLU_BAREMI.length - 1]).ceza;
}

/**
 * Satıcı kusuru sayılan iade sebepleri. "Kusurlu ürün gönderildi" faturayla doğrulandı; yanlış / eksik
 * gönderim aynı cezai şartta. Kesin olmayanlar fatura gelmezse "kesilmedi"ye düşer (bedel 0).
 * "Yanlış sipariş verdim" müşterinin hatası — "yanlış ürün" kalıbına UYMAZ.
 */
const SATICI_KUSURU = /kusurlu|defolu|yanlış ürün|eksik ürün|eksik parça/;

export function saticiKusuruMu(sebep: string | null | undefined): boolean {
  return SATICI_KUSURU.test((sebep ?? "").toLocaleLowerCase("tr"));
}

/** Bir paketin satıcı kusurlu iadesi. */
export interface TyKusurluIade {
  /** İade sebebi (Trendyol'un yazdığı). */
  sebep: string;
  /** Kusurlu iade edilen ürünlerin net satış bedeli (TL). */
  netSatis: number;
  /** Kusurlu iade edilen adet. */
  adet: number;
  /** İadenin kabul edildiği gün (Türkiye, YYYY-AA-GG) — bedel bu günün haftasının faturasına girer. */
  gun: string;
  /** Barem bedeli (TL). */
  ceza: number;
}

export interface TyKusurluSonucu {
  /** Kâra giren bedel (TL). */
  ceza: number;
  durum: TyFaturaDurumu;
}

const TR_FARK_MS = 3 * 3_600_000;

function anMs(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Talepleri paket başına satıcı kusurlu iadeye indir (anahtar `ty-<paket id>`). Yalnız KABUL edilmiş
 * kalemler; aynı kalem iki sayfada gelirse bir kez sayılır.
 */
export function trendyolKusurluIadeleri(talepler: readonly TrendyolIadeTalebi[]): Map<string, TyKusurluIade> {
  const gorulen = new Set<string>();
  const ara = new Map<string, { sebep: string; netSatis: number; adet: number; an: number }>();
  for (const talep of talepler) {
    const anahtar = trendyolPaketAnahtari(talep?.orderOutboundPackageId);
    const an = anMs(talep?.lastModifiedDate) ?? anMs(talep?.claimDate);
    if (!anahtar || an == null) continue;
    for (const [satirSirasi, kalem] of (talep.items ?? []).entries()) {
      const fiyat = Number(kalem?.orderLine?.price);
      for (const [kalemSirasi, ci] of (kalem?.claimItems ?? []).entries()) {
        if (!talepKalemiKabulMu(ci?.claimItemStatus)) continue;
        const sebep = (ci?.trendyolClaimItemReason?.name || ci?.customerClaimItemReason?.name || "").trim();
        if (!saticiKusuruMu(sebep)) continue;
        const kimlik = ci?.id == null ? `${anahtar}:${satirSirasi}:${kalemSirasi}` : String(ci.id);
        if (gorulen.has(kimlik)) continue;
        gorulen.add(kimlik);
        const p = ara.get(anahtar) ?? { sebep, netSatis: 0, adet: 0, an };
        p.netSatis += Number.isFinite(fiyat) && fiyat > 0 ? fiyat : 0;
        p.adet += 1;
        p.an = Math.max(p.an, an);
        ara.set(anahtar, p);
      }
    }
  }
  return new Map(
    [...ara].map(([anahtar, p]) => {
      const netSatis = Math.round(p.netSatis * 100) / 100;
      return [
        anahtar,
        {
          sebep: p.sebep,
          netSatis,
          adet: p.adet,
          gun: new Date(p.an + TR_FARK_MS).toISOString().slice(0, 10),
          ceza: tyKusurluCezasiTutari(netSatis),
        },
      ];
    })
  );
}

/** Siparişin kârından düşülen Trendyol cezası: gecikme bedeli + kusurlu ürün bedeli (TL, kuruşa yuvarlı). */
export function tyCezaToplami(gecikme: number | null | undefined, kusurlu: number | null | undefined): number {
  const t = (Number.isFinite(gecikme) ? Number(gecikme) : 0) + (Number.isFinite(kusurlu) ? Number(kusurlu) : 0);
  return Math.round(t * 100) / 100;
}

/** Kusurlu iadeleri haftalık "Kusurlu Ürün Faturası" kayıtlarıyla eşleştirir (gecikmeyle aynı kural). */
export function kusurluIadeleriFaturalarlaEsle(
  iadeler: ReadonlyMap<string, TyKusurluIade>,
  faturalar: TyGecikmeFaturalari | null | undefined,
  an: number
): Map<string, TyKusurluSonucu> {
  return haftalikFaturalarlaEsle(
    [...iadeler].map(([id, k]) => ({ id, gun: k.gun, ceza: k.ceza })),
    faturalar,
    an
  );
}
