/**
 * RAPORLAR (yeni sayfa) — seçilen ayın görünüm mantığı. SAF: React yok, `rapor-gorunum.test.ts`.
 *
 * Rakamların tamamı sunucunun aylık özetinden (`/api/finance/monthly`) ve kâr dökümünden gelir;
 * burada yalnız seçme, kıyaslama ve oranlama yapılır — yeni bir kâr formülü kurulmaz.
 */
import {
  kiyasKaynagi,
  monthProgress,
  monthProjection,
  statDelta,
  type FinanceBucket,
  type KarDokumuYaniti,
  type MonthProgress,
  type PlatformBucket,
  type PreviousToDate,
  type StatDelta,
} from "./reports-view";

/** Ayda gösterilecek bir şey var mı (sipariş ya da gider). */
export function ayDolu(m: Pick<FinanceBucket, "orderCount" | "expenses" | "revenue">): boolean {
  return m.orderCount > 0 || m.expenses !== 0 || m.revenue !== 0;
}

/** Seçilebilir aylar: ilk dolu aydan bugüne (aradaki boş aylar da — sessizce atlanmasın). */
export function secilebilirAylar<T extends FinanceBucket>(months: readonly T[]): T[] {
  const ilk = months.findIndex(ayDolu);
  return ilk < 0 ? [] : months.slice(ilk);
}

export interface Kiyas {
  /** Kıyaslanan dönemin adı ("1–23 Ekim" / "Ekim"). */
  etiket: string | null;
  ciro: StatDelta | null;
  netKar: StatDelta | null;
  siparisKari: StatDelta | null;
  gider: StatDelta | null;
  siparis: StatDelta | null;
}

export interface AyOzeti {
  ay: FinanceBucket;
  ilerleme: MonthProgress | null;
  /** Kâr marjı (sipariş kârı / ciro); ciro yoksa null. */
  marj: number | null;
  /** Ortalama sepet; sipariş yoksa null. */
  ortalamaSepet: number | null;
  kiyas: Kiyas;
  /** Süren ayın ay sonu tahminleri (ilk haftada ve bitmiş ayda null). */
  tahmin: { ciro: number | null; netKar: number | null; siparis: number | null };
}

const AY_ADLARI = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

/** "2026-10" → "Ekim 2026". */
export function ayAdi(month: string, yilli = true): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const ad = AY_ADLARI[Number(m[2]) - 1] ?? month;
  return yilli ? `${ad} ${m[1]}` : ad;
}

/**
 * Seçilen ayın özeti ve önceki ayla kıyası. Süren ay geçen ayın AYNI GÜNÜNE kadarki kısmıyla
 * kıyaslanır (adil kıyas); bitmiş ay geçen ayın tamamıyla.
 */
export function ayOzeti(
  months: readonly FinanceBucket[],
  month: string,
  previousToDate: PreviousToDate | null | undefined,
  nowMs: number,
  timeZone: string
): AyOzeti | null {
  const i = months.findIndex((m) => m.month === month);
  if (i < 0) return null;
  const ay = months[i];
  const onceki = i > 0 ? months[i - 1] : undefined;
  const ilerleme = monthProgress(month, nowMs, timeZone);
  const { kaynak, kismi } = kiyasKaynagi(onceki, previousToDate, ilerleme?.ongoing ?? false);
  const oncekiDolu = onceki != null && ayDolu(onceki);
  const k = oncekiDolu ? kaynak : undefined;
  const oncekiSiparisKari =
    k == null ? null : "orderProfit" in k ? k.orderProfit : Number((k.netProfit + k.expenses).toFixed(2));
  let etiket: string | null = null;
  if (oncekiDolu && onceki) {
    if (kismi && previousToDate) {
      const gun = new Date(previousToDate.until).toLocaleString("tr-TR", { timeZone, day: "numeric" });
      etiket = `1–${gun} ${ayAdi(onceki.month, false)}`;
    } else {
      etiket = ayAdi(onceki.month, false);
    }
  }
  return {
    ay,
    ilerleme,
    marj: ay.revenue > 0 ? ay.orderProfit / ay.revenue : null,
    ortalamaSepet: ay.orderCount > 0 ? ay.revenue / ay.orderCount : null,
    kiyas: {
      etiket,
      ciro: k ? statDelta(ay.revenue, k.revenue) : null,
      netKar: k ? statDelta(ay.netProfit, k.netProfit) : null,
      siparisKari: k ? statDelta(ay.orderProfit, oncekiSiparisKari) : null,
      gider: k ? statDelta(ay.expenses, k.expenses) : null,
      siparis: k ? statDelta(ay.orderCount, k.orderCount) : null,
    },
    tahmin: {
      ciro: monthProjection(ay.revenue, ilerleme),
      netKar: monthProjection(ay.netProfit, ilerleme),
      siparis: monthProjection(ay.orderCount, ilerleme),
    },
  };
}

/* ── Kâr nereye gitti ─────────────────────────────────────────────────────────────────── */

export type SelaleTuru = "baslangic" | "kesinti" | "notr" | "ara" | "sonuc";

export interface SelaleSatiri {
  key: string;
  label: string;
  /** Kesintilerde pozitif tutar (düşülen), başlangıç/ara/sonuçta değerin kendisi. */
  amount: number;
  tur: SelaleTuru;
  /** Ciroya oranı (0–1); ciro yoksa null. */
  oran: number | null;
}

export interface Selale {
  satirlar: SelaleSatiri[];
  /** Döküm ile aylık özet farklı anlarda okundu (arada sipariş geldi) → döküm yenilenmeli. */
  eskimis: boolean;
}

/**
 * Ciro → kesintiler → sipariş kârı → iade zararı → giderler → net kâr.
 * Sipariş kârı dökümden (kayıtlı kârların toplamı), iade/gider/net aylık özetten gelir.
 */
export function selaleSatirlari(dokum: KarDokumuYaniti, ay: FinanceBucket): Selale {
  const ciro = dokum.revenue;
  const oran = (v: number) => (ciro > 0 ? v / ciro : null);
  const satirlar: SelaleSatiri[] = [{ key: "ciro", label: "Ciro", amount: ciro, tur: "baslangic", oran: ciro > 0 ? 1 : null }];
  if (dokum.unknownCostRevenue > 0.009) {
    satirlar.push({
      key: "bilinmeyen",
      label: "Maliyeti girilmemiş satışlar",
      amount: dokum.unknownCostRevenue,
      tur: "notr",
      oran: oran(dokum.unknownCostRevenue),
    });
  }
  for (const l of dokum.lines) {
    satirlar.push({ key: l.key, label: l.label, amount: l.amount, tur: "kesinti", oran: oran(l.amount) });
  }
  satirlar.push({
    key: "siparisKari",
    label: "Sipariş kârı",
    amount: dokum.orderProfitBeforeReturns,
    tur: "ara",
    oran: oran(dokum.orderProfitBeforeReturns),
  });
  const iade = ay.returnLoss ?? 0;
  if (iade > 0.009) satirlar.push({ key: "iade", label: "İade zararı", amount: iade, tur: "kesinti", oran: oran(iade) });
  if (ay.expenses > 0.009) satirlar.push({ key: "gider", label: "Giderler", amount: ay.expenses, tur: "kesinti", oran: oran(ay.expenses) });
  satirlar.push({ key: "net", label: "Net kâr", amount: ay.netProfit, tur: "sonuc", oran: oran(ay.netProfit) });
  const beklenen = ay.orderProfit + iade;
  return { satirlar, eskimis: Math.abs(dokum.orderProfitBeforeReturns - beklenen) > 1 || Math.abs(dokum.revenue - ay.revenue) > 1 };
}

/* ── Platformlar ──────────────────────────────────────────────────────────────────────── */

export type PlatformAnahtari = "trendyol" | "hepsiburada" | "n11" | "shopify" | "manual";

export const PLATFORM_ADLARI: Record<PlatformAnahtari, string> = {
  trendyol: "Trendyol",
  hepsiburada: "Hepsiburada",
  n11: "n11",
  shopify: "Shopify",
  manual: "Elle",
};

export interface PlatformSatiri {
  platform: PlatformAnahtari;
  ad: string;
  ciro: number;
  kar: number;
  siparis: number;
  /** Cirodaki payı (0–1). */
  pay: number;
  marj: number | null;
  ortalamaSepet: number | null;
}

function platformKovasi(v: unknown): PlatformBucket | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const sayi = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return { revenue: sayi(o.revenue), orderProfit: sayi(o.orderProfit), orderCount: sayi(o.orderCount) };
}

/** Ayın platform kırılımı — cirosu olmayan platform listelenmez, ciroya göre sıralı. */
export function platformSatirlari(ay: FinanceBucket): PlatformSatiri[] {
  const toplam = ay.revenue;
  return (Object.keys(PLATFORM_ADLARI) as PlatformAnahtari[])
    .map((platform) => {
      const k = platformKovasi(ay.byPlatform?.[platform]);
      if (!k || (k.orderCount === 0 && k.revenue === 0 && k.orderProfit === 0)) return null;
      return {
        platform,
        ad: PLATFORM_ADLARI[platform],
        ciro: k.revenue,
        kar: k.orderProfit,
        siparis: k.orderCount,
        pay: toplam > 0 ? k.revenue / toplam : 0,
        marj: k.revenue > 0 ? k.orderProfit / k.revenue : null,
        ortalamaSepet: k.orderCount > 0 ? k.revenue / k.orderCount : null,
      };
    })
    .filter((s): s is PlatformSatiri => s != null)
    .sort((a, b) => b.ciro - a.ciro);
}

/* ── Giderler ─────────────────────────────────────────────────────────────────────────── */

/** Kategori rengi seçilmemişse sıradan — marka paletinden (turuncu YOK). */
export const GIDER_PALETI = ["#7A7EFF", "#4F8CFF", "#9B5CFF", "#38BDF8", "#C9D2F2", "#22C55E", "#E879F9", "#64748B"];

/**
 * Kategorinin kayıtlı rengi. Tema grafik renkleri (`var(--chart-N)`) marka paletine çevrilir:
 * temadaki 3. ve 5. grafik rengi turuncu/kırmızı tonunda.
 */
export function giderRengi(kayitli: string | null | undefined): string | null {
  if (!kayitli) return null;
  const m = /^var\(--chart-(\d+)\)$/.exec(kayitli.trim());
  if (m) return GIDER_PALETI[(Number(m[1]) - 1 + GIDER_PALETI.length) % GIDER_PALETI.length];
  return kayitli;
}

export interface GiderSatiri {
  kategori: string;
  tutar: number;
  adet: number;
  pay: number;
  renk: string;
}

export function giderSatirlari(
  ay: FinanceBucket,
  renkler: readonly { name: string; color: string | null }[] = []
): GiderSatiri[] {
  const liste = ay.expensesByCategory ?? [];
  const toplam = liste.reduce((t, g) => t + g.amount, 0);
  const renk = new Map(renkler.map((r) => [r.name, r.color]));
  return liste.map((g, i) => ({
    kategori: g.category,
    tutar: g.amount,
    adet: g.count,
    pay: toplam > 0 ? g.amount / toplam : 0,
    renk: giderRengi(renk.get(g.category)) ?? GIDER_PALETI[i % GIDER_PALETI.length],
  }));
}

/* ── Trend ────────────────────────────────────────────────────────────────────────────── */

export interface TrendNoktasi {
  anahtar: string;
  etiket: string;
  ciro: number;
  netKar: number;
  siparisKari: number;
  /** Süren dönem (ay/hafta bitmedi) — çubuk kesikli çizilir. */
  suruyor: boolean;
}

export function aylikTrend(
  months: readonly FinanceBucket[],
  nowMs: number,
  timeZone: string
): TrendNoktasi[] {
  return secilebilirAylar(months).map((m) => ({
    anahtar: m.month,
    etiket: ayAdi(m.month, false).slice(0, 3),
    ciro: m.revenue,
    netKar: m.netProfit,
    siparisKari: m.orderProfit,
    suruyor: monthProgress(m.month, nowMs, timeZone)?.ongoing ?? false,
  }));
}
