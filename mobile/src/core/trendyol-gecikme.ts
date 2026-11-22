import { trendyolKargolanmaAni, type TrendyolKargoPaketi } from "./siparis-kargo";

/**
 * TRENDYOL TERMİN GECİKME BEDELİ — geç kargolanan pakete kesilen ceza.
 *
 * Kural (Satıcı Bilgi Merkezi "Sipariş Gecikmesi" + panel "Sipariş Kayıtları" Ceza kolonuyla
 * doğrulandı, 23 Kas 2026): paket söz verilen günden sonraki İLK İŞ GÜNÜ bitene kadar kargoya
 * (taşıma durumuna) geçmezse, paketteki ürünlerin net satış bedeline göre barem tutarı kesilir.
 * Pazar iş günü sayılmaz, Cumartesi sayılır. Ölçülen vakalar:
 *   • söz Cuma → Pazartesi kargolandı → 100 TL kesildi (tolerans Cumartesiydi)
 *   • söz Cumartesi (TR) → Pazartesi kargolandı → kesilmedi (tolerans Pazartesi)
 *   • söz Çarşamba → Cuma → 180 TL · söz Salı → Perşembe → 50 TL · söz Perşembe → Cumartesi → 180 TL
 * Bedel faturası haftalık (Çarşamba), siparişe bağlanmadan ("Tazmin bedelidir") gelir: tolerans
 * günü bir önceki Pazartesi–Pazar haftasına düşen paketlerin toplamı.
 *
 * Bugün Kargoda (aynı gün kargo) siparişlerinde 1 Ocak 2027'ye kadar gecikme bedeli kesilmiyor.
 */

/** Barem: paketteki ürünlerin net satış bedeli → bedel (TL). Trendyol cezai şartları (27 Tem 2026). */
export const TY_GECIKME_BAREMI: readonly { ust: number; ceza: number }[] = [
  { ust: 199.99, ceza: 50 },
  { ust: 349.99, ceza: 100 },
  { ust: 599.99, ceza: 120 },
  { ust: 9999.99, ceza: 180 },
  { ust: Number.POSITIVE_INFINITY, ceza: 300 },
];

/** Bugün Kargoda muafiyetinin bittiği an (1 Ocak 2027 00:00, Türkiye). */
const BUGUN_KARGODA_MUAFIYET_BITIS = Date.UTC(2026, 11, 31, 21, 0, 0);
const GUN_MS = 86_400_000;
const TR_FARK_MS = 3 * 3_600_000;

export function tyGecikmeCezasiTutari(netSatis: number): number {
  const t = Number.isFinite(netSatis) ? Math.max(0, netSatis) : 0;
  return (TY_GECIKME_BAREMI.find((b) => t <= b.ust) ?? TY_GECIKME_BAREMI[TY_GECIKME_BAREMI.length - 1]).ceza;
}

export interface TyGecikme {
  /** Söz verilen kargoya verme günü (Türkiye, YYYY-AA-GG). */
  sonGun: string;
  /** Bedel kesilmeden kargolanabilecek son gün (söz gününden sonraki ilk iş günü). */
  tolerans: string;
  /** Kargoya geçtiği an (Trendyol damgası); kargolanmadıysa null. */
  kargolanma: number | null;
  /** Tolerans gününden sonra kargolandı ya da hâlâ kargolanmadı ve tolerans geçti. */
  gecikti: boolean;
  /** Hâlâ kargoya verilmedi. */
  kargolanmadi: boolean;
  /** Barem bedeli (TL) — muafsa ya da gecikmediyse 0. */
  ceza: number;
  /** Bugün Kargoda muafiyeti. */
  muaf: boolean;
}

export interface TyGecikmePaketi extends TrendyolKargoPaketi {
  totalPrice?: unknown;
  fastDeliveryType?: unknown;
  status?: unknown;
}

const gunMetni = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Bir günün (YYYY-AA-GG) ardından gelen ilk iş günü — Pazar atlanır. */
function sonrakiIsGunu(gun: string): string {
  let t = Date.parse(`${gun}T00:00:00Z`) + GUN_MS;
  if (new Date(t).getUTCDay() === 0) t += GUN_MS;
  return gunMetni(t);
}

/** İptal / tedarik edilemedi — gecikme değil, başka bir süreç. */
const KAPSAM_DISI = /Cancelled|UnSupplied/i;
/** Henüz kargoya verilmemiş paket durumları. */
const HENUZ_KARGODA_DEGIL = /^(Created|Awaiting|Picking|Invoiced|ReadyToShip|Repack|UnPacked)$/i;

/**
 * Paketin gecikme durumu. Söz tarihi yoksa ya da paket iptal/tedarik edilemediyse null.
 * `an`: şimdi (ms) — kargolanmamış paketin toleransı geçti mi diye.
 *
 * Damgalar: `agreedDeliveryDate` gerçek UTC (Türkiye için +3 saat); paket geçmişi Trendyol'un
 * sipariş tarihi gibi Türkiye duvar saatini taşıyor (gün sınırı gündüz kargolarda etkilemez).
 */
export function trendyolGecikmesi(paket: TyGecikmePaketi, an: number): TyGecikme | null {
  const soz = typeof paket.agreedDeliveryDate === "number" ? paket.agreedDeliveryDate : Number(paket.agreedDeliveryDate);
  if (!Number.isFinite(soz) || soz <= 0) return null;
  if (KAPSAM_DISI.test(String(paket.status ?? ""))) return null;
  const sonGun = gunMetni(soz + TR_FARK_MS);
  const tolerans = sonrakiIsGunu(sonGun);
  const kargolanma = trendyolKargolanmaAni(paket);
  const kargolanmadi = kargolanma == null;
  // Kargo kaydı olmayan ama yolda/teslim görünen paket: ne zaman kargolandığı bilinmiyor → yorum yok.
  if (kargolanmadi && !HENUZ_KARGODA_DEGIL.test(String(paket.status ?? ""))) return null;
  const gecikti = kargolanmadi ? gunMetni(an + TR_FARK_MS) > tolerans : gunMetni(kargolanma) > tolerans;
  const muaf = paket.fastDeliveryType === "SameDayShipping" && soz < BUGUN_KARGODA_MUAFIYET_BITIS;
  const tutar = Number(paket.totalPrice);
  return {
    sonGun,
    tolerans,
    kargolanma,
    gecikti,
    kargolanmadi,
    ceza: gecikti && !muaf ? tyGecikmeCezasiTutari(tutar) : 0,
    muaf,
  };
}

/** Haftalık "Termin Gecikme Bedeli" faturası. */
export interface TyGecikmeFaturasi {
  /** Fatura anı (ms). */
  tarih: number;
  tutar: number;
}

/** Saklanan faturalar: hangi tarihten beri bakıldığı + faturalar. */
export interface TyGecikmeFaturalari {
  /** Bu andan önceki haftalar için fatura bilgisi YOK (bilinmiyor ≠ kesilmedi). */
  bas: number;
  faturalar: TyGecikmeFaturasi[];
}

export type TyGecikmeDurumu = "zamaninda" | "muaf" | "tahmini" | "gercek" | "kesilmedi";

export interface TyGecikmeSonucu {
  /** Kâra giren bedel (TL). */
  ceza: number;
  durum: TyGecikmeDurumu;
}

/** Bir günün haftasının Pazartesisi (ms, UTC gece yarısı). */
function haftaPazartesi(gun: string): number {
  const t = Date.parse(`${gun}T00:00:00Z`);
  const g = new Date(t).getUTCDay(); // 0 Pazar
  return t - ((g + 6) % 7) * GUN_MS;
}

/** Fatura haftası pay: fatura Çarşamba kesiliyor; birkaç gün gecikebilir. */
const FATURA_BEKLEME_GUN = 16;

/**
 * Gecikmeleri haftalık faturalarla eşleştirir.
 *  • Haftanın faturası tahminle aynıysa → hepsi "gerçek".
 *  • Fatura var ama farklı: haftada tek gecikme varsa faturadaki tutar o siparişin; değilse tahmin kalır.
 *  • Fatura beklenen süre geçtiği hâlde gelmediyse → "kesilmedi" (bedel 0).
 *  • Henüz fatura zamanı gelmediyse ya da o haftanın faturaları bilinmiyorsa → "tahmini".
 */
export function gecikmeleriFaturalarlaEsle(
  gecikmeler: readonly { id: string; g: TyGecikme }[],
  faturalar: TyGecikmeFaturalari | null | undefined,
  an: number
): Map<string, TyGecikmeSonucu> {
  const sonuc = new Map<string, TyGecikmeSonucu>();
  const haftalar = new Map<number, { id: string; g: TyGecikme }[]>();
  for (const k of gecikmeler) {
    if (!k.g.gecikti) {
      sonuc.set(k.id, { ceza: 0, durum: "zamaninda" });
      continue;
    }
    if (k.g.muaf || k.g.ceza <= 0) {
      sonuc.set(k.id, { ceza: 0, durum: "muaf" });
      continue;
    }
    const h = haftaPazartesi(k.g.tolerans);
    const liste = haftalar.get(h) ?? [];
    liste.push(k);
    haftalar.set(h, liste);
  }
  const faturaToplami = (pazartesi: number) =>
    (faturalar?.faturalar ?? [])
      .filter((f) => {
        // Faturanın kapsadığı hafta: fatura gününün haftasından bir önceki hafta.
        const kapsadigi = haftaPazartesi(gunMetni(f.tarih + TR_FARK_MS)) - 7 * GUN_MS;
        return kapsadigi === pazartesi;
      })
      .reduce((t, f) => t + f.tutar, 0);
  for (const [pazartesi, liste] of haftalar) {
    const tahmin = liste.reduce((t, k) => t + k.g.ceza, 0);
    const bilinir = faturalar != null && pazartesi + 7 * GUN_MS >= faturalar.bas;
    const fatura = bilinir ? faturaToplami(pazartesi) : 0;
    const beklemeBitti = an > pazartesi + FATURA_BEKLEME_GUN * GUN_MS;
    for (const k of liste) {
      if (bilinir && fatura > 0) {
        if (Math.abs(fatura - tahmin) < 0.01) sonuc.set(k.id, { ceza: k.g.ceza, durum: "gercek" });
        else if (liste.length === 1) sonuc.set(k.id, { ceza: Math.round(fatura * 100) / 100, durum: "gercek" });
        else sonuc.set(k.id, { ceza: k.g.ceza, durum: "tahmini" });
      } else if (bilinir && beklemeBitti) {
        sonuc.set(k.id, { ceza: 0, durum: "kesilmedi" });
      } else {
        sonuc.set(k.id, { ceza: k.g.ceza, durum: "tahmini" });
      }
    }
  }
  return sonuc;
}

/** Saklanan metin (AppSetting `tyGecikmeFaturalari`) → nesne; bozuksa null. */
export function tyGecikmeFaturalariOku(metin: string | null | undefined): TyGecikmeFaturalari | null {
  if (!metin) return null;
  try {
    const v = JSON.parse(metin) as Partial<TyGecikmeFaturalari>;
    if (!v || typeof v.bas !== "number" || !Array.isArray(v.faturalar)) return null;
    return {
      bas: v.bas,
      faturalar: v.faturalar.filter(
        (f): f is TyGecikmeFaturasi => !!f && typeof f.tarih === "number" && typeof f.tutar === "number"
      ),
    };
  } catch {
    return null;
  }
}
