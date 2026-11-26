/**
 * SİPARİŞ LİSTESİ KURALLARI — telefonun Siparişler sekmesi (masaüstüyle aynı kovalar).
 *
 * `src/core` altında → `npm run sync-core` ile telefona kopyalanır. Burada yalnız saf kurallar
 * var: durum kovası ve süzgeç grubu, dönem başlangıcı, gün başlıkları ve özet toplamı.
 *
 * SAAT DİLİMİ: Türkiye 2016'dan beri sabit UTC+3 (yaz saati yok). Telefonun JS motorunda
 * (Hermes) `Intl` saat dilimi desteği sınırlı olduğu için gün sınırı sabit kaydırmayla
 * hesaplanır; masaüstünün `Europe/Istanbul` takvimiyle aynı günü verir.
 */
import {
  HEPSIBURADA_STATUS_KINDS, MANUAL_STATUS_KINDS, N11_STATUS_KINDS, SHOPIFY_STATUS_KINDS, TRENDYOL_STATUS_KINDS,
  type OrderStatusKind,
} from "./order-status-kind";

const TR_KAYMA_MS = 3 * 60 * 60_000;
const GUN_MS = 86_400_000;

/** Platform + ham durum → ortak kova (masaüstü sipariş uçlarıyla aynı tablo). */
export function durumKovasi(platform: string, status: string): OrderStatusKind {
  if (platform === "trendyol") return TRENDYOL_STATUS_KINDS[status]?.kind ?? "other";
  if (platform === "hepsiburada") return HEPSIBURADA_STATUS_KINDS[status]?.kind ?? "other";
  if (platform === "n11") return N11_STATUS_KINDS[status]?.kind ?? "other";
  if (platform === "manual") return MANUAL_STATUS_KINDS[status]?.kind ?? "other";
  if (platform === "shopify") return SHOPIFY_STATUS_KINDS[status] ?? "other";
  return "other";
}

/**
 * Süzgeç çipleri. "Açık" = henüz kargoya verilmemiş (yeni + hazırlanıyor) — kullanıcının "hangi
 * siparişlerle uğraşmam gerekiyor" sorusu; hazırlık listesiyle aynı küme (core/prep-list).
 */
export type DurumGrubu = "acik" | "kargoda" | "teslim" | "iptal" | "diger";

export function durumGrubu(kova: OrderStatusKind): DurumGrubu {
  switch (kova) {
    case "pending":
    case "processing":
      return "acik";
    case "shipped":
      return "kargoda";
    case "delivered":
      return "teslim";
    case "cancelled":
      return "iptal";
    default:
      return "diger";
  }
}

export const DURUM_GRUBU_ADI: Record<DurumGrubu, string> = {
  acik: "Açık",
  kargoda: "Kargoda",
  teslim: "Teslim",
  iptal: "İptal / İade",
  diger: "Diğer",
};

/* ── Takvim (Türkiye) ─────────────────────────────────────────────────────── */

/** Türkiye takviminde günün başlangıcı (epoch ms). */
export function gunBasi(ms: number): number {
  return Math.floor((ms + TR_KAYMA_MS) / GUN_MS) * GUN_MS - TR_KAYMA_MS;
}

export type Donem = "bugun" | "hafta" | "ay";

/**
 * Türkiye takviminde AYIN 1'inin başlangıcı (epoch ms). Türkiye yaz saati uygulamıyor (UTC+3
 * sabit) → `Europe/Istanbul` ay başıyla birebir.
 */
export function ayBasi(ms: number): number {
  const yerel = new Date(ms + TR_KAYMA_MS);
  return Date.UTC(yerel.getUTCFullYear(), yerel.getUTCMonth(), 1) - TR_KAYMA_MS;
}

/**
 * Dönemin başlangıcı. "Ay" = BU AY (Türkiye takvimi, ayın 1'i): masaüstünde Panel, Siparişler ve
 * Raporlar aynı dönemi (bu ay) gösterir — Berke'nin kararı, 23 Kas 2026. Telefon da aynı kesimi
 * kullanır ki iki uygulama aynı rakamı göstersin.
 */
export function donemBaslangici(donem: Donem, nowMs: number): number {
  if (donem === "bugun") return gunBasi(nowMs);
  if (donem === "hafta") return gunBasi(nowMs) - 6 * GUN_MS;
  return ayBasi(nowMs);
}

const AYLAR = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
const GUNLER = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

/** "Bugün" · "Dün" · "7 Kasım Cuma" (Türkiye takvimi). */
export function gunEtiketi(ms: number, nowMs: number): string {
  const gun = gunBasi(ms);
  const bugun = gunBasi(nowMs);
  if (gun === bugun) return "Bugün";
  if (gun === bugun - GUN_MS) return "Dün";
  const yerel = new Date(gun + TR_KAYMA_MS); // UTC alanları artık Türkiye takvimini taşır
  return `${yerel.getUTCDate()} ${AYLAR[yerel.getUTCMonth()]} ${GUNLER[yerel.getUTCDay()]}`;
}

export type ListeSatiri<T> =
  | { tur: "gun"; anahtar: string; etiket: string; adet: number }
  | { tur: "siparis"; siparis: T };

/** Yeniden eskiye sıralı listeye gün başlıkları ekle (tarihsizler en altta tek başlık). */
export function gunlereBol<T extends { date: number | null }>(siparisler: readonly T[], nowMs: number): ListeSatiri<T>[] {
  const out: ListeSatiri<T>[] = [];
  let baslik: { tur: "gun"; anahtar: string; etiket: string; adet: number } | null = null;
  for (const s of siparisler) {
    const anahtar = s.date != null && Number.isFinite(s.date) ? String(gunBasi(s.date)) : "tarihsiz";
    if (!baslik || baslik.anahtar !== anahtar) {
      baslik = {
        tur: "gun", anahtar, adet: 0,
        etiket: anahtar === "tarihsiz" ? "Tarihi bilinmeyen" : gunEtiketi(s.date as number, nowMs),
      };
      out.push(baslik);
    }
    baslik.adet++;
    out.push({ tur: "siparis", siparis: s });
  }
  return out;
}

/* ── Özet ─────────────────────────────────────────────────────────────────── */

export interface OzetGirdisi {
  platform: string;
  date: number | null;
  ciro: number;
  /** Kâr; maliyeti bilinmiyorsa null (BİLİNMEYEN ≠ SIFIR). */
  kar: number | null;
  /** Kâr yaklaşık (bazı kalemlerin maliyeti eksik). */
  karKismi: boolean;
  /** İptal / bilgisi eksik / durumu tanınmayan → toplamların dışında (masaüstüyle aynı kural). */
  haric: boolean;
  /**
   * Kargolanıp geri gelen (iade) siparişin zararı, pozitif TL. Sipariş HARİÇ olsa da kârdan DÜŞER —
   * ciroya ve adede girmez (masaüstü Siparişler özetiyle aynı, denetim 23 Kas 2026).
   */
  iadeZarari?: number | null;
}

export interface SiparisOzeti {
  adet: number;
  ciro: number;
  /** Maliyeti bilinen siparişlerin kâr toplamı. */
  kar: number;
  /** Kâr / ciro (yalnız maliyeti tam bilinenler üzerinden); hesaplanamıyorsa null. */
  marj: number | null;
  /** Maliyeti eksik ya da yaklaşık sipariş sayısı. */
  maliyetEksik: number;
  platformlar: { platform: string; adet: number; ciro: number }[];
  /** Kârdan düşülen iade (geri gelen kargo) zararı — sipariş sayısı ve toplam TL. */
  iadeAdet: number;
  iadeZarari: number;
}

export function siparisOzeti(
  girdiler: readonly OzetGirdisi[],
  baslangic: number,
  /**
   * tarihsizDahil: tarihi bilinmeyen sipariş de sayılır — masaüstü "bu ay" özeti yalnız tarihi
   * dönemden ÖNCE olanı eler, tarihsizi sayar. Gün/hafta görünümünde kapalı kalır.
   */
  secenek: { tarihsizDahil?: boolean } = {}
): SiparisOzeti {
  let adet = 0, ciro = 0, kar = 0, maliyetEksik = 0, iadeAdet = 0, iadeZarari = 0;
  let marjCiro = 0, marjKar = 0;
  const pl = new Map<string, { platform: string; adet: number; ciro: number }>();
  for (const g of girdiler) {
    const donemde = g.date == null ? secenek.tarihsizDahil === true : g.date >= baslangic;
    if (!donemde) continue;
    if (g.haric) {
      if (g.iadeZarari != null && g.iadeZarari > 0) {
        kar -= g.iadeZarari;
        marjKar -= g.iadeZarari;
        iadeAdet++;
        iadeZarari += g.iadeZarari;
      }
      continue;
    }
    adet++;
    ciro += g.ciro;
    const p = pl.get(g.platform) ?? { platform: g.platform, adet: 0, ciro: 0 };
    p.adet++;
    p.ciro += g.ciro;
    pl.set(g.platform, p);
    if (g.kar == null || g.karKismi) maliyetEksik++;
    if (g.kar != null) kar += g.kar;
    if (g.kar != null && !g.karKismi) {
      marjCiro += g.ciro;
      marjKar += g.kar;
    }
  }
  return {
    adet,
    ciro,
    kar,
    marj: marjCiro > 0 ? marjKar / marjCiro : null,
    maliyetEksik,
    platformlar: [...pl.values()].sort((a, b) => b.ciro - a.ciro),
    iadeAdet,
    iadeZarari,
  };
}
