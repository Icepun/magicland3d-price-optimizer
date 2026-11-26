/**
 * n11 SİPARİŞ PAKETİ → uygulamanın sipariş biçimi. Masaüstü (`/api/orders`, hızlı tarama) ve
 * telefon AYNI fonksiyonları çağırır (`npm run sync-core` ile kopyalanır).
 *
 * Kaynak: REST `GET /rest/delivery/v1/shipmentPackages` — 26 Kas 2026'da ilk siparişle ÖLÇÜLDÜ:
 *   • Paket: `id` (paket), `orderNumber`, `shipmentPackageStatus`, `isReturned`, `cargoProviderName`,
 *     `cargoTrackingNumber`, `packageHistories[{createdDate, status}]`, `lastModifiedDate`,
 *     `agreedDeliveryDate`. Sipariş tarihi alanı YOK → ilk "Created" kaydının anı.
 *     Damgalar gerçek UTC anı (epoch-ms): sipariş 10:03'te oluştu, 10:08'de onaylandı, Berke 10:09'da yazdı.
 *   • Paketteki `totalAmount` / `totalDiscountAmount` bu pakete AİT DEĞİL (2.430,90 — 349,99'luk
 *     tek kalemde) → tutarlar kalemlerden toplanır.
 *   • Kalem: `quantity`, `price`, `sellerInvoiceAmount` (satıcının fatura tutarı = satır geliri),
 *     `dueAmount` (müşterinin ödediği), `mallDiscount` (n11'in karşıladığı indirim — satıcının gelirini
 *     DÜŞÜRMEZ: 349,99 fatura, müşteri 314,99), `totalSellerDiscountPrice`, `vatRate` (%),
 *     `commissionRate` (%, bugün 0), `netMarketingFeeRate` 1,2 + `netMarketplaceFeeRate` 0,8 (% KDV dahil),
 *     `taxDeductionRate` (stopaj %), `deliveryFeeType` (1 alıcı, 2 mağaza, 3 şartlı, 4 n11 öder),
 *     `stockCode` (Trendyol barkodlarıyla aynı biçim → ürün eşleştirme anahtarı), `barcode` (boş).
 *
 * Kâr kuralları Berke'nin onayıyla (26 Kas 2026): gelir = satıcı fatura tutarı; komisyon, pazarlama ve
 * pazaryeri hizmet bedeli siparişin KENDİ oranlarıyla; stopaj kâra girmez; kargo DHL tarifesinden
 * (`core/kargo-tarife.ts`, şartlı kargo + posta hizmet bedeli + KDV).
 */
import { n11SiparisKomisyonKesri } from "./order-commission";
import { N11_STATUS_KINDS, type OrderStatusKind } from "./order-status-kind";
import type { KargoBaglami, KargoOdeyen } from "./kargo-tarife";

/** Pazarlama hizmet bedeli (% KDV dahil) — kalem bildirmezse. n11: %1 + KDV. */
export const N11_PAZARLAMA_BEDELI = 1.2;
/** Pazaryeri hizmet bedeli (% KDV dahil) — kalem bildirmezse. n11: %0,67 + KDV. */
export const N11_PAZARYERI_BEDELI = 0.8;
/** Stopaj (%) — kalem bildirmezse. Yalnız bilgi, kâra girmez. */
export const N11_STOPAJ = 1;
/** Satış KDV'si bilinmiyorsa stopaj tabanı için varsayılan (%). */
const VARSAYILAN_KDV = 20;

/** Sayı, sayı metni → sayı; boş/geçersiz → NaN. */
function sayi(v: unknown): number {
  if (typeof v === "number") return v;
  if (v == null || v === "") return Number.NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

const kurus = (tl: number) => Math.round(tl * 100) / 100;

const metin = (...vals: unknown[]): string => {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
};

/** `deliveryFeeType` → kargoyu kim öder; tanınmayan değer null (tedbirli: desi listesi). */
export function n11KargoOdeyen(deliveryFeeType: unknown): KargoOdeyen | null {
  switch (sayi(deliveryFeeType)) {
    case 1: return "alici";
    case 2: return "magaza";
    case 3: return "sartli";
    case 4: return "pazaryeri";
    default: return null;
  }
}

export interface N11Kalem {
  name: string;
  quantity: number;
  /** Satıcının birim geliri = satır fatura tutarı ÷ adet (n11'in karşıladığı indirim dahil). */
  unitPrice: number;
  /** Müşterinin ödediği birim tutar (bilgi). */
  paidUnitPrice: number | null;
  /** n11'in karşıladığı birim indirim (bilgi). */
  n11DiscountUnit: number;
  /** Siparişte kesilen komisyon — KDV DAHİL kesir; 0 geçerli (kampanya). Alan yoksa null. */
  commissionRate: number | null;
  /** Satış KDV oranı (%); bildirilmediyse null. */
  saleVatRate: number | null;
  /** Pazarlama + pazaryeri hizmet bedeli (brüt TL, satırın tamamı). */
  paymentFee: number;
  /** Stopaj (TL, satırın tamamı) — yalnız bilgi. */
  stoppage: number;
  /** Kargoyu kim öder (kalemin kargo şablonu). */
  kargoOdeyen: KargoOdeyen | null;
  /** Ürün eşleştirme anahtarları. */
  stockCode: string;
  barcode: string;
  /** n11 ürün kimliği. */
  productId: string;
}

/**
 * n11 kalemi → kâr hesabının satır girdileri. Oran alanı boşsa (n11 göndermediyse) sabit oranlar
 * kullanılır; açıkça 0 geldiyse 0 kalır.
 */
export function n11KalemHesabi(kalem: Record<string, unknown>): N11Kalem {
  const adetHam = Math.floor(sayi(kalem.quantity));
  const adet = Number.isFinite(adetHam) && adetHam > 0 ? adetHam : 1;
  const fiyat = sayi(kalem.price);
  const saticiIndirimi = sayi(kalem.totalSellerDiscountPrice);
  const fatura = sayi(kalem.sellerInvoiceAmount);
  // Satır geliri: satıcının fatura tutarı; yoksa (fiyat × adet) − satıcı indirimi (doküman formülü).
  const satirGeliri =
    Number.isFinite(fatura) && fatura >= 0
      ? fatura
      : Math.max(0, (Number.isFinite(fiyat) ? fiyat : 0) * adet - (Number.isFinite(saticiIndirimi) ? saticiIndirimi : 0));
  const odenen = sayi(kalem.dueAmount);
  const n11Indirim = sayi(kalem.totalMallDiscountPrice ?? kalem.mallDiscount);

  const kdv = sayi(kalem.vatRate);
  const saleVatRate = Number.isFinite(kdv) && kdv >= 0 && kdv < 100 ? kdv : null;

  const oran = (v: unknown, varsayilan: number) => {
    const n = sayi(v);
    return Number.isFinite(n) && n >= 0 && n < 100 ? n : varsayilan;
  };
  const bedelOrani = oran(kalem.netMarketingFeeRate, N11_PAZARLAMA_BEDELI) + oran(kalem.netMarketplaceFeeRate, N11_PAZARYERI_BEDELI);
  const stopajOrani = oran(kalem.taxDeductionRate, N11_STOPAJ);
  const satirNet = satirGeliri / (1 + (saleVatRate ?? VARSAYILAN_KDV) / 100);

  return {
    name: metin(kalem.productName, kalem.stockCode, kalem.barcode) || "Ürün",
    quantity: adet,
    unitPrice: kurus(satirGeliri / adet),
    paidUnitPrice: Number.isFinite(odenen) && odenen >= 0 ? kurus(odenen / adet) : null,
    n11DiscountUnit: Number.isFinite(n11Indirim) && n11Indirim > 0 ? kurus(n11Indirim / adet) : 0,
    commissionRate: n11SiparisKomisyonKesri(kalem.commissionRate),
    saleVatRate,
    paymentFee: kurus(satirGeliri * (bedelOrani / 100)),
    stoppage: kurus(satirNet * (stopajOrani / 100)),
    kargoOdeyen: n11KargoOdeyen(kalem.deliveryFeeType),
    stockCode: metin(kalem.stockCode),
    barcode: metin(kalem.barcode),
    productId: metin(kalem.productId),
  };
}

/**
 * YENİDEN HESAP (Raporlar): kalem geçmişinde yalnız birim gelir, adet, komisyon ve KDV saklı →
 * hizmet bedeli ve stopaj sabit oranlarla türetilir (Hepsiburada'nın tahsilatı gibi).
 */
export function n11KayitliKalemEk(kalem: { unitPrice: number; quantity: number; vatRate: number | null }): {
  paymentFee: number;
  stoppage: number;
} {
  const satirGeliri = Math.max(0, kalem.unitPrice) * Math.max(0, kalem.quantity);
  const kdv = typeof kalem.vatRate === "number" && Number.isFinite(kalem.vatRate) ? kalem.vatRate : VARSAYILAN_KDV;
  return {
    paymentFee: kurus(satirGeliri * ((N11_PAZARLAMA_BEDELI + N11_PAZARYERI_BEDELI) / 100)),
    stoppage: kurus((satirGeliri / (1 + kdv / 100)) * (N11_STOPAJ / 100)),
  };
}

/** Paket durumu → ortak kova. İade edilen paket (`isReturned`) "İade" olur. */
export function n11PaketDurumu(paket: Record<string, unknown>): {
  kind: OrderStatusKind;
  label: string;
  /** Pazaryerinin ham durum adı (iade edilen pakette "Returned"). */
  ham: string;
  /** Tanınmayan durum → toplamlara girmez. */
  unknown?: boolean;
} {
  if (paket.isReturned === true) return { ...N11_STATUS_KINDS.Returned, ham: "Returned" };
  const ham = metin(paket.shipmentPackageStatus, paket.status);
  const bilinen = N11_STATUS_KINDS[ham];
  return bilinen ? { ...bilinen, ham } : { kind: "other", label: ham || "Bilinmiyor", ham, unknown: true };
}

/** Siparişin VERİLİŞ anı: ilk "Created" kaydı; yoksa en eski kayıt; o da yoksa son güncelleme. */
export function n11SiparisTarihiMs(paket: Record<string, unknown>): number | null {
  const gecmis = Array.isArray(paket.packageHistories) ? paket.packageHistories : [];
  let olusturma: number | null = null;
  let enEski: number | null = null;
  for (const g of gecmis) {
    if (!g || typeof g !== "object") continue;
    const k = g as Record<string, unknown>;
    const t = sayi(k.createdDate);
    if (!Number.isFinite(t) || t <= 0) continue;
    if (enEski == null || t < enEski) enEski = t;
    if (/^created$/i.test(String(k.status ?? "")) && (olusturma == null || t < olusturma)) olusturma = t;
  }
  if (olusturma != null) return olusturma;
  if (enEski != null) return enEski;
  const son = sayi(paket.lastModifiedDate);
  return Number.isFinite(son) && son > 0 ? son : null;
}

/**
 * Kargo bağlamı: firma, kargoyu kim öder (kalemlerin şablonu; uyuşmazsa bilinmiyor) ve şartlı kargo
 * sınırına bakılacak SEPET tutarı (kalemlerin fatura toplamı).
 */
export function n11KargoBaglami(paket: Record<string, unknown>, kalemler: readonly N11Kalem[]): KargoBaglami {
  const odeyenler = new Set(kalemler.map((k) => k.kargoOdeyen));
  const odeyen = odeyenler.size === 1 ? [...odeyenler][0] : null;
  const sepet = kalemler.reduce((t, k) => t + k.unitPrice * k.quantity, 0);
  return {
    firma: metin(paket.cargoProviderName) || null,
    odeyen,
    baremTutari: kalemler.length > 0 ? kurus(sepet) : null,
  };
}

export interface N11Siparis {
  /** Uygulama içi kimlik: `n11-<paket id>` (paket id yoksa sipariş numarasıyla). */
  id: string;
  paketId: string;
  orderNumber: string;
  tarihMs: number | null;
  /** Müşterinin adı soyadı — yalnız listede gösterilir (diğer pazaryerleri gibi). */
  musteri: string | null;
  durum: ReturnType<typeof n11PaketDurumu>;
  kalemler: N11Kalem[];
  /** Satıcının toplam geliri (kalemlerin fatura tutarı). */
  toplam: number;
  kargoFirmasi: string | null;
  takipNo: string | null;
  kargo: KargoBaglami;
  /** Kargoya verilip geri geldi → iki yön kargo zararı. */
  kargoIadesi: boolean;
  /** Kalem gelmedi → listede kalır, toplamlara ve finans geçmişine girmez. */
  eksik: boolean;
}

/** n11 paketi → sipariş. Kişisel alanlardan yalnız ad-soyad okunur; adres, telefon, vergi no OKUNMAZ. */
export function n11PaketiCoz(paket: Record<string, unknown>): N11Siparis {
  const kalemlerHam = Array.isArray(paket.lines) ? paket.lines : [];
  const kalemler = kalemlerHam
    .filter((k): k is Record<string, unknown> => Boolean(k) && typeof k === "object")
    .map(n11KalemHesabi);
  const paketId = metin(paket.id);
  const orderNumber = metin(paket.orderNumber) || paketId || "—";
  return {
    id: `n11-${paketId || `s${orderNumber}`}`,
    paketId,
    orderNumber,
    tarihMs: n11SiparisTarihiMs(paket),
    musteri: metin(paket.customerfullName) || null,
    durum: n11PaketDurumu(paket),
    kalemler,
    toplam: kurus(kalemler.reduce((t, k) => t + k.unitPrice * k.quantity, 0)),
    kargoFirmasi: metin(paket.cargoProviderName) || null,
    takipNo: metin(paket.cargoTrackingNumber) || null,
    kargo: n11KargoBaglami(paket, kalemler),
    kargoIadesi: paket.isReturned === true,
    eksik: kalemler.length === 0,
  };
}

/**
 * SATIŞ ÖNCESİ (Ürünler, Panel, fiyat hesabı, telefon): bir n11 ilanının fiyat motoruna taşıdığı
 * kesintiler — sipariş kârıyla AYNI kurallar, oranlar sabitlerden.
 *   • pazarlama + pazaryeri hizmet bedeli: brüt fiyatın %2'si → motor KDV hariç fiyat üzerinden
 *     istediği için (1 + KDV) ile çarpılır
 *   • sabit hizmet bedeli yok (gider kuralındaki sabit bedelin yerine 0)
 *   • satış KDV'si: ilanın kendi oranı biliniyorsa o
 */
export function n11SatisOncesiKesintiler(
  ilan: { vatRate?: number | null },
  genelKdv: number
): { paymentFeeRate: number; fixedExpenseOverride: number; saleVatRate?: number } {
  const ilanKdv = ilan.vatRate;
  const gecerli = typeof ilanKdv === "number" && Number.isFinite(ilanKdv) && ilanKdv >= 0 && ilanKdv < 100;
  const kdv = gecerli ? ilanKdv : genelKdv;
  return {
    paymentFeeRate:
      Math.round(((N11_PAZARLAMA_BEDELI + N11_PAZARYERI_BEDELI) / 100) * (1 + kdv / 100) * 1_000_000) / 1_000_000,
    fixedExpenseOverride: 0,
    ...(gecerli ? { saleVatRate: ilanKdv } : {}),
  };
}

/**
 * n11 en çok 1 aylık pencere verir (aralık büyükse son ayı döndürür) → [başlangıç, bitiş] aralığı
 * 28 günlük dilimlere bölünür; en yeni dilim önce. Dilimler 1 saat örtüşür, çağıran paket kimliğiyle
 * tekilleştirir.
 */
export function n11Pencereleri(bitisMs: number, baslangicMs: number): Array<{ baslangic: number; bitis: number }> {
  const DILIM = 28 * 86_400_000;
  const ORTUSME = 3_600_000;
  const out: Array<{ baslangic: number; bitis: number }> = [];
  let bitis = bitisMs;
  for (let i = 0; i < 12 && bitis > baslangicMs; i++) {
    const bas = Math.max(baslangicMs, bitis - DILIM);
    out.push({ baslangic: bas, bitis });
    bitis = bas + ORTUSME;
    if (bas <= baslangicMs) break;
  }
  return out;
}
