import { normalizeMatchKey } from "./order-match";
import type { OrderProfitProduct } from "./order-profit";
import { computePackagingCost, parsePackagingSettings } from "./packaging";
import { resolveProductCost, type ResolvedCost } from "./product-cost";
import {
  ekFilamentleriOku,
  ekFilamentleriYaz,
  type EkFilament,
  type FilamentFiyatlari,
} from "./filament-karisimi";

/**
 * SİPARİŞE ÖZEL MALİYET — ürünler sayfasına eklenmemiş (ya da maliyeti girilmemiş) bir ürünün
 * YALNIZ O SİPARİŞTEKİ maliyeti (Berke'nin kararı: "yalnız o sipariş").
 *
 * Neden: eski/stoğu eritilen bazı ürünler kataloğa hiç eklenmedi; siparişlerde çıktıkları için
 * kâr "eksik" kalıyordu. Kayıt kataloğa dokunmaz, başka siparişi etkilemez.
 *
 * Kâr çekirdeği (order-profit.ts) DEĞİŞMEDİ: kayıt, satır için bir `OrderProfitProduct`e
 * çevrilir ve hesap katalog ürünüyle AYNI yoldan geçer (adet başına ürün + paketleme, siparişe
 * bir kez kargo/sabit gider). Masaüstü sipariş listesi, ay yeniden hesabı ve telefon bu dosyadaki
 * fonksiyonları kullanır — üçü aynı sonucu verir.
 *
 * Bu dosya telefona da kopyalanır (`npm run sync-core`).
 */

export type SatirMaliyetModu = "hesap" | "tutar";

/** Veritabanındaki kayıt (OrderLineCost) — kâr hesabının ihtiyaç duyduğu alanlar. */
export interface SatirMaliyetKaydi {
  platform: string;
  externalOrderId: string;
  lineKey: string;
  lineName: string;
  costJson: string;
  desi: number | null;
}

/** Kayıtlı maliyet girdisi (OrderLineCost.costJson). Ürün sayfasındaki alanların aynısı. */
export interface SatirMaliyeti {
  /** "hesap" = filament/süre ile (ürün sayfasındaki gibi) · "tutar" = adet başı tek tutar. */
  mod: SatirMaliyetModu;
  filamentTypeId: string | null;
  /** Ana filament gramı. */
  filamentWeight: number | null;
  ekFilamentler: EkFilament[];
  printTimeHours: number | null;
  /** 0–1 */
  wasteRate: number | null;
  /** "tutar" modunda adet başı üretim maliyeti (paketleme hariç). */
  tutar: number | null;
  packagingOptionId: string | null;
  nylonLevel: string | null;
  tapeUsed: boolean | null;
}

/**
 * Sipariş kimliğinin TEK biçimi — finans kayıtlarıyla aynı (Shopify'da "sh-<no>").
 * Masaüstü, ay yeniden hesabı ve telefon kimliği farklı biçimlerde taşıyabiliyor.
 */
export function siparisKimligi(platform: string, externalOrderId: string): string {
  if (platform !== "shopify") return externalOrderId;
  if (externalOrderId.startsWith("sh-")) return externalOrderId;
  const gid = externalOrderId.match(/\/Order\/([^/]+)$/i);
  return `sh-${gid?.[1] ?? externalOrderId.replace(/^shopify-/, "")}`;
}

/**
 * Satırın sipariş içindeki kimliği. Katalog ürünüyle eşleştiyse ürün kimliği, eşleşmediyse
 * satır adı (normalize). Satır sırasına bağlı DEĞİL: platform satırları farklı sırada
 * döndürse de kayıt doğru satıra bulunur.
 */
export function satirAnahtari(satir: { productId?: string | null; name: string }): string {
  if (satir.productId) return `p:${satir.productId}`;
  return `n:${normalizeMatchKey(satir.name)}`;
}

/** (platform, sipariş, satır) → tek harita anahtarı. */
export function satirMaliyetiHaritaAnahtari(platform: string, externalOrderId: string, anahtar: string): string {
  return `${platform}|${siparisKimligi(platform, externalOrderId)}|${anahtar}`;
}

function sayiVeyaNull(x: unknown, enAz = 0): number | null {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x.replace(",", ".")) : NaN;
  return Number.isFinite(n) && n >= enAz ? n : null;
}

function metinVeyaNull(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

/** Girdiyi (istek gövdesi ya da kayıtlı metin) doğrulanmış biçime indir. Geçersizse null. */
export function satirMaliyetiOku(deger: unknown): SatirMaliyeti | null {
  let ham: unknown = deger;
  if (typeof deger === "string") {
    try {
      ham = JSON.parse(deger);
    } catch {
      return null;
    }
  }
  if (!ham || typeof ham !== "object") return null;
  const r = ham as Record<string, unknown>;
  const mod: SatirMaliyetModu = r.mod === "tutar" ? "tutar" : "hesap";
  const fire = sayiVeyaNull(r.wasteRate);
  const nylon = r.nylonLevel;
  return {
    mod,
    filamentTypeId: metinVeyaNull(r.filamentTypeId),
    filamentWeight: sayiVeyaNull(r.filamentWeight),
    ekFilamentler: ekFilamentleriOku(r.ekFilamentler),
    printTimeHours: sayiVeyaNull(r.printTimeHours),
    wasteRate: fire == null ? null : Math.min(1, fire),
    tutar: sayiVeyaNull(r.tutar),
    packagingOptionId: metinVeyaNull(r.packagingOptionId),
    nylonLevel:
      nylon === "none" || nylon === "low" || nylon === "medium" || nylon === "high" ? nylon : null,
    tapeUsed: typeof r.tapeUsed === "boolean" ? r.tapeUsed : null,
  };
}

/** Saklanacak metin. */
export function satirMaliyetiYaz(m: SatirMaliyeti): string {
  return JSON.stringify({ ...m, ekFilamentler: ekFilamentleriOku(m.ekFilamentler) });
}

/** Girdiyi ürün maliyetiyle AYNI motorla çöz (ürün sayfası = sipariş satırı). */
export function satirMaliyetiCozumle(
  m: SatirMaliyeti,
  settings: Record<string, string | undefined>,
  fiyatlar: FilamentFiyatlari
): ResolvedCost | null {
  if (m.mod === "tutar") {
    // Tek tutar: üretim payı girilen rakam; paketleme seçimleri ürün sayfasındaki gibi güncel
    // fiyatlardan. Malzeme payı bilinmediği için indirilecek KDV'ye girmez (elle maliyetle aynı).
    const tutar = m.tutar ?? 0;
    const paketleme = computePackagingCost(
      { packagingOptionId: m.packagingOptionId, nylonLevel: m.nylonLevel, tapeUsed: m.tapeUsed },
      parsePackagingSettings(settings)
    );
    return {
      productionCost: tutar,
      packagingCost: paketleme.total,
      totalCost: tutar + paketleme.total,
      filamentCost: 0,
      packagingBreakdown: paketleme,
      productionCostKnown: tutar > 0,
    };
  }
  return resolveProductCost(
    {
      costMode: "detailed",
      manualCost: null,
      totalCost: null,
      filamentWeight: m.filamentWeight,
      ekFilamentlerJson: ekFilamentleriYaz(m.ekFilamentler),
      printTimeHours: m.printTimeHours,
      wasteRate: m.wasteRate,
      packagingOptionId: m.packagingOptionId,
      nylonLevel: m.nylonLevel,
      tapeUsed: m.tapeUsed,
    },
    settings,
    (m.filamentTypeId ? fiyatlar.get(m.filamentTypeId) : undefined) ?? 0,
    fiyatlar
  );
}

/** Sipariş satırının eşleştiği katalog ürünü (maliyeti olmasa da kategori/desi/ilan ondan gelir). */
export type SatirKatalogBilgisi = Pick<
  OrderProfitProduct,
  "id" | "name" | "categoryName" | "desi" | "commissionRate" | "listing"
>;

/**
 * Kaydı kâr çekirdeğinin satır ürününe çevir. Katalogla eşleşmişse kategori, desi, komisyon ve
 * ilan ayarları üründen gelir; eşleşmemişse satır adı + kayıttaki desi kullanılır.
 * Kayıt okunamazsa null → satır eskisi gibi "maliyet eksik" kalır.
 */
export function satirMaliyetliUrun(
  kayit: { costJson: string; desi: number | null; lineName: string },
  katalog: SatirKatalogBilgisi | null,
  settings: Record<string, string | undefined>,
  fiyatlar: FilamentFiyatlari
): OrderProfitProduct | null {
  const m = satirMaliyetiOku(kayit.costJson);
  if (!m) return null;
  const r = satirMaliyetiCozumle(m, settings, fiyatlar);
  if (!r) return null;
  return {
    id: katalog?.id ?? `satir:${normalizeMatchKey(kayit.lineName)}`,
    name: katalog?.name ?? kayit.lineName,
    categoryName: katalog?.categoryName ?? "",
    desi: kayit.desi ?? katalog?.desi ?? null,
    commissionRate: katalog?.commissionRate ?? null,
    productionCost: r.productionCost,
    packagingCost: r.packagingCost,
    packagingComponents: r.packagingBreakdown?.components ?? null,
    filamentCost: r.filamentCost,
    productionCostKnown: r.productionCostKnown,
    listing: katalog?.listing ?? null,
  };
}
