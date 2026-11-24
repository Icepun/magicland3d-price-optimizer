/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import {
  HEPSIBURADA_STATUS_KINDS,
  MANUAL_STATUS_KINDS,
  TRENDYOL_STATUS_KINDS,
  type OrderStatusKind,
} from "@/core/order-status-kind";
import { hbArray, hbSiparisleriTopla, hbStr, hbTarihMs } from "@/core/hb-siparis";
import { trendyolMikroIhracat, type MikroIhracat } from "@/core/mikro-ihracat";
import { prisma, remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  ayniPencereGunuMu,
  computeOrdersShared,
  hamCekimAl,
  hamCekimYaz,
  HAM_YENIDEN_KULLANIM_MS,
  getOrdersCache,
  isOrdersRefreshing,
  setOrdersRefreshing,
} from "@/lib/orders-cache";
import { jsonError } from "@/lib/api-error";
import {
  ShopifyClient,
  ShopifyAdminTokenMissingError,
} from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { TrendyolClient, type TrendyolOrder } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { HepsiburadaClient } from "@/services/hepsiburada-client";
import { getHepsiburadaCredentials } from "@/services/hepsiburada-settings";
import { resolveProductCost } from "@/core/product-cost";
import { filamentFiyatlariOku } from "@/lib/filament-fiyatlari";
import {
  satirAnahtari,
  satirMaliyetiBul,
  satirMaliyetliUrun,
  siparisKimligi,
  type SatirKatalogBilgisi,
} from "@/core/order-line-cost";
import { bagliUrunKimligi } from "@/core/order-line-link";
import { satirMaliyetleriniOku } from "@/lib/order-line-costs";
import { satirBaglariniOku } from "@/lib/order-line-links";
import { isPersistableOrderId } from "@/core/trendyol-order-id";
import { trendyolDateToIso } from "@/core/trendyol-date";
import { trendyolOrderId } from "@/core/trendyol-order-id";
import { buildTrendyolWindows } from "@/lib/trendyol-windows";
import { trendyolIadeDurumu } from "@/core/trendyol-iade";
import { ACIK_SIPARIS_TURLERI, siparisListedeKalir } from "@/core/order-window";
import { trendyolIadeleriniGecmiseIsle, trendyolTalepSonuclariniOku } from "@/lib/trendyol-iadeleri";
import {
  kusurluIadeleriFaturalarlaEsle,
  tyCezaToplami,
  type TyKusurluIade,
  type TyKusurluSonucu,
} from "@/core/trendyol-kusurlu";
import {
  computeReturnLoss,
  gercekKesintiToplami,
  kargoSatiriEtiketi,
  resolveOrderProfit,
  type OrderProfitInput,
  type OrderProfitLine,
} from "@/core/order-profit";
import type { KargoBaglami } from "@/core/kargo-tarife";
import { hepsiburadaKargoBaglami, kargoluIadeMi, trendyolKargoBaglami } from "@/core/siparis-kargo";
import { fazlaDesiBul } from "@/core/kargo-denetim";
import {
  gecikmeleriFaturalarlaEsle,
  trendyolGecikmesi,
  tyGecikmeFaturalariOku,
  type TyGecikme,
  type TyGecikmeDurumu,
} from "@/core/trendyol-gecikme";
import { siparisKomisyonKesri } from "@/core/order-commission";
import { hbHizmetBedeli, hbKalemHesabi } from "@/core/hb-kesinti";
import { tyKalemHesabi } from "@/core/ty-kesinti";
import { adRateSnapshot, adRateFor } from "@/lib/ad-rate";
import type { CommissionRuleInput, CargoRuleInput, ExpenseRuleInput } from "@/core/types";
import type { PackagingBreakdown } from "@/core/packaging";
import { notifyNewOrders, type NotifyLine, type NotifyOrder } from "@/lib/order-notify";
import {
  lastOrderFinanceSnapshotWrite,
  orderFinanceSnapshotWriteInFlight,
  scheduleOrderFinanceSnapshots,
  type FinanceSnapshotItem,
} from "@/lib/order-finance-snapshots";
import { bustFinanceCachesAfterOrderSnapshots } from "@/lib/cache-busting";
import { satiriEsle, urunIndeksiKur, type UrunIndeksi } from "@/core/order-match";
// Eşleştirme anahtarı sadeleştirmesi TEK yerde: hızlı bildirim taraması da aynısını kullanır,
// iki taraf ayrı kural yazarsa aynı sipariş burada eşleşip orada eşleşmez.
import { normalizeMatchKey } from "@/lib/order-watch";
import { swr } from "@/lib/route-cache";
import {
  parseManualOrderBreakdown,
  parseManualOrderItems,
} from "@/lib/manual-orders";
import { FINANCE_TIME_ZONE, kurusToTl, monthlyFinanceWindowStart } from "@/lib/monthly-finance";
import { dbEpochMs } from "@/lib/sqlite-date";

const WINDOW_DAYS = 30;
// Aylık geçmişte geç gelen iptal/iade durumlarını yakalamak için görünür listenin
// arkasında daha geniş bir pencereyi yeniden hesaplarız. Shopify'ın standart
// read_orders erişimi son 60 günle sınırlı olduğundan güvenli ortak sınır 60 gündür.
const HISTORY_SYNC_DAYS = 60;

export type { OrderStatusKind };

export interface UnifiedOrderItem {
  name: string;
  quantity: number;
  image: string | null;
  /** Eşleşen ürünün id'si (varsa) — siparişler sayfasından ürün detayına gitmek için. */
  productId?: string | null;
  /** Bu ürün "sipariş üzerine üretilir" mi (bildirim/etiket için). */
  madeToOrder?: boolean;
  /**
   * Bu satır kâra GİRMEDİ: ürün hiç eşleşmedi VEYA eşleşti ama maliyeti girilmemiş.
   * Koşul çekirdekle BİREBİR (order-profit.ts: !p || productionCost + packagingCost <= 0) —
   * "N siparişte maliyet eksik" uyarısının satır bazındaki karşılığı. productId varsa
   * kullanıcı doğrudan o ürünün maliyet ekranına gidebilir.
   */
  costMissing?: boolean;
  /** Satırın sipariş içindeki kimliği — "siparişe özel maliyet" kaydının anahtarı. */
  satirAnahtari?: string;
  /** Bu satır için elle girilmiş maliyet kullanıldı (yalnız bu sipariş ya da bu adla tüm siparişler). */
  ozelMaliyet?: boolean;
  /** Kullanılan maliyet "bu adla gelen tüm siparişler" kaydıydı (ör. hediye paketi). */
  ozelMaliyetTum?: boolean;
  /** Satır kendi anahtarıyla eşleşmedi; kullanıcı ADINI bir ürüne bağladı ("Ürüne bağla"). */
  elleBagli?: boolean;
}

export interface UnifiedOrder {
  platform: "shopify" | "trendyol" | "hepsiburada" | "manual";
  id: string;
  orderNumber: string;
  date: string | null;
  statusKind: OrderStatusKind;
  statusLabel: string;
  total: number;
  currency: string;
  customer: string | null;
  itemCount: number;
  items: UnifiedOrderItem[];
  image: string | null;
  profit: number | null;
  profitPartial: boolean;
  profitSource: "calculated" | "platform" | "manual";
  estimatedCommission: number;
  actualCommission: number | null;
  /** Komisyon tamamen SİPARİŞTE KESİLEN orandan hesaplandı (pazaryeri satırda bildirdi). */
  commissionFromOrder?: boolean;
  /** Siparişin satırlarında kesilen oranlar — KESİR, tekrarsız (dökümde gösterilir). */
  orderCommissionRates?: number[];
  /** Siparişe bir kez düşülen sabit bedel (hizmet bedeli) — brüt TL. */
  fixedExpense?: number;
  /** Düşülen tahsilat bedeli — brüt TL. */
  paymentFee?: number;
  /** Düşülen uluslararası hizmet bedeli — brüt TL (Trendyol mikro ihracat). */
  internationalFee?: number;
  /** Stopaj — yalnız bilgi; kâra girmedi. */
  stoppage?: number;
  /** Komisyon dışındaki gerçek kesintilerin toplamı (TL) — kayıtlı kârın yenilenmesi için. */
  actualFees?: number | null;
  /** Bu kalemler pazaryerinin GERÇEK kaydından mı geldi? (dökümde "gerçek" etiketi) */
  actualOrderFee?: boolean;
  actualPaymentFee?: boolean;
  actualCargo?: boolean;
  /** Maliyeti bilinmediği için kâra girmeyen satır sayısı (0 = tam hesap). */
  unmatchedCount?: number;
  /** Komisyonu bilinmediği için kâra girmeyen satır sayısı (oran ne siparişte ne ilanda ne kuralda). */
  commissionUnknownCount?: number;
  /** Desisi olmadığı için kargosu 1 desi varsayılan satır sayısı. */
  missingDesiCount?: number;
  desiEstimated?: boolean;
  /** true = bu siparişin desi/tutarına uyan kargo kuralı yok; kargo 0 sayıldı, kâr yüksek görünüyor. */
  cargoRuleMissing?: boolean;
  /** Kargo pazaryeri tarifesinden tahmin edildiyse kısa açıklaması ("Trendyol Express · sabit fiyat"). */
  cargoLabel?: string | null;
  /** Kargo tarifesinin fiyatı seçtiği bilgiler — finans geçmişine yazılır (yeniden hesap aynı fiyatı seçsin). */
  cargoContext?: KargoBaglami | null;
  /**
   * İADE (kargolanıp geri gelen) siparişin zararı — ciroya girmez ama kâr toplamından DÜŞÜLÜR.
   * Tutarlar brüt; `loss` indirilecek KDV düşülmüş net etki.
   */
  returnLoss?: {
    loss: number;
    outboundCargo: number;
    returnCargo: number;
    serviceFee: number;
    inputVatCredit: number;
    outboundActual: boolean;
    returnActual: boolean;
    serviceFeeActual: boolean;
    penalty: number;
    /** Gidiş kargosuna uyan kural/tarife yok → kargo 0 sayıldı, zarar eksik. */
    cargoRuleMissing?: boolean;
  } | null;
  /** Kârdan düşülen ceza (Trendyol termin gecikme + kusurlu ürün bedeli, TL). */
  penalty?: number;
  /** Trendyol termin gecikmesi — finans geçmişine yazılır, Kargo → Denetim listesi buradan. */
  delayInfo?: {
    sonGun: string;
    tolerans: string;
    kargolanma: number | null;
    gecikti: boolean;
    kargolanmadi: boolean;
    ceza: number;
    durum: TyGecikmeDurumu;
  } | null;
  /** Trendyol kusurlu ürün bedeli (satıcı kusurlu iade) — kâra giren tutar `ceza`. */
  defectInfo?: { sebep: string; adet: number; ceza: number; durum: TyKusurluSonucu["durum"] } | null;
  /** Pazaryeri ürünün desisinden büyük desiyle kesti ve kargo pahalandı (itiraz edilebilir). */
  excessDesi?: { bizimDesi: number; kesilenDesi: number; fazla: number } | null;
  /** Bu siparişe düşen reklam payı (TL). 0 = reklam bütçesi yok. */
  adCost?: number;
  /** Siparişe düşen kargo bedeli (TL). */
  cargoCost?: number;
  /** Ürün + paketleme maliyeti (TL). */
  productAndPackagingCost?: number;
  orderRevenueAdjustment?: number;
  /** Satıştan doğan (hesaplanan) KDV — kalıcı finans geçmişine taşınır. */
  outputVat?: number | null;
  /** Girdilerden indirilecek KDV — aynı motor çıktısı. */
  inputVatCredit?: number | null;
  trackingNumber: string | null;
  cargoProvider: string | null;
  /** Hepsiburada paket numarası (paketlendiyse) — kargo etiketi bununla istenir. */
  packageNumber?: string | null;
  /**
   * Mikro ihracat (Trendyol `micro`): müşterinin ülkesi. null = yurt içi; Trendyol dışı
   * platformlarda alan yok (undefined → finans özetindeki kayıtlı değer korunur).
   */
  microExport?: MikroIhracat | null;
  /**
   * Siparişin kalem/tutar bilgisi platformdan alınamadı. Listede görünür ama ciro/kâr
   * toplamlarına ve finans geçmişine GİRMEZ — yoksa ₺0'lık sahte bir sipariş gibi sayılır.
   */
  dataIncomplete?: boolean;
  /**
   * Pazaryeri tanımadığımız bir durum adı gönderdi. Satış mı iade mi bilmiyoruz → ciro/kâr
   * toplamlarına ve kalıcı finans geçmişine GİRMEZ; listede kalır ve sayısı kullanıcıya
   * gösterilir (BİLİNMEYEN ≠ SIFIR, ama bilinmeyen ≠ satış da değil).
   */
  statusUnknown?: boolean;
  /** Bu siparişte iade/iptal edilmiş kalem sayısı (tutar platformdan geldiği gibi kalır). */
  returnedLineCount?: number;
  isManual?: boolean;
  manualOrderId?: string;
  editHref?: string;
  /**
   * 30 günlük pencereden ÖNCE verilmiş ama işi bitmediği için listede duran elle sipariş
   * (core/order-window). Özetlere ve "bugün" toplamlarına GİRMEZ — kendi ayında sayıldı.
   */
  outsideWindow?: boolean;
  /**
   * Bu aydan ÖNCE verilmiş (liste son 30 günü gösterir, özet BU AYI sayar). Özete girmez;
   * "bugün/dün" toplamlarına girer. Raporlar'la aynı dönem — ekranlar aynı rakamı göstersin.
   */
  previousMonth?: boolean;
}

interface PlatformStatus {
  ok: boolean;
  count: number;
  needsAdminToken?: boolean;
  /**
   * Bu pazaryeri hiç kurulmamış (kimlik bilgisi yok) — HATA DEĞİL, ayrı durum.
   * ⚠️ Bu bilgi kimlik bilgisi okuma adımından gelir; hata METNİNE bakılarak türetilmez.
   * (Eskiden mesajda "bulunamadı" geçen GERÇEK hatalar da "kurulu değil" sanılıyor ve
   * ekranda tek bir uyarı bile kalmıyordu.)
   */
  notConfigured?: boolean;
  error?: string;
  /**
   * Trendyol iade talepleri bu turda okunamadı: iade edilmiş paket "teslim" görünebilir. Bu tur
   * Trendyol siparişleri geçmişe YAZILMAZ ve ekran kısa bir uyarı gösterir.
   */
  iadeBilinmiyor?: boolean;
  /**
   * Bu kaynaktan gelen ama bilgisi eksik kalan sipariş sayısı (detayı alınamadı, tek seferde
   * çekilebilecek sınırı aştı ya da manuel kaydı okunamadı). 0/undefined = veri tam.
   */
  incompleteCount?: number;
}

interface SummaryBucket {
  revenue: number;
  profit: number;
  orderCount: number;
  /** Kârı eksik hesaplanan sipariş sayısı (maliyet girilmemiş ürün içeren). */
  incompleteOrders: number;
}

interface SummaryQuality {
  /** Döviz kuru dönüşümü olmadığı için TRY ciro/kâr toplamlarına katılmayan siparişler. */
  unsupportedCurrencyOrders: number;
  unsupportedCurrencies: Array<{ currency: string; orderCount: number }>;
  /** Kalem/tutar bilgisi alınamadığı için ciro/kâr toplamlarına katılmayan siparişler. */
  incompleteDataOrders: number;
  /** Durumu tanınmadığı için toplamların dışında tutulan siparişler. */
  unknownStatusOrders: number;
  /** Hangi durum adı kaç siparişte geldi (kullanıcı bunu bize iletebilsin diye ham adıyla). */
  unknownStatuses: Array<{ status: string; orderCount: number }>;
  /** İçinde iade edilmiş kalem bulunan sipariş sayısı (ciro platformdan geldiği gibi). */
  partialReturnOrders: number;
  /** Kargolanıp geri gelen (zararı kârdan düşülen) sipariş sayısı ve toplam zarar (TL, net). */
  returnLossOrders: number;
  returnLossTotal: number;
  /**
   * Verisi ALINAMAYAN kaynakların adları. Boş değilse toplamlar EKSİK bir veriyle
   * hesaplanmıştır — arayüz bunu rakamın yanında açıkça söyler.
   */
  missingSources: string[];
}

function normalizedCurrency(currency: string | null | undefined): string {
  return currency?.trim().toUpperCase() || "TRY";
}

/** Durum tablosu ORTAK ÇEKİRDEKTE — telefon da aynı kovaları kullanır (core/order-status-kind.ts). */
const TRENDYOL_STATUS = TRENDYOL_STATUS_KINDS;

/**
 * Tanımadığımız durum "Diğer" olur ve `unknown` işaretini taşır.
 *
 * 🔴 Eskiden yalnız "Diğer" etiketi verilip sipariş ciroya TAM ekleniyordu: pazaryeri iade
 * anlamına gelen yeni bir durum adı gönderdiğinde iade, ciroda satış gibi duruyordu. Artık
 * bilinmeyen durum toplamlara girmez ve sayısı ekranda görünür.
 */
/**
 * Kimlik bilgisi hatası "kurulu değil" mi, yoksa GERÇEK bir arıza mı?
 *
 * Ayarlar katmanı iki farklı şey için de fırlatıyor: bilgiler hiç girilmemişse ("… eksik")
 * ve girilmiş ama ÇÖZÜLEMİYORSA ("… okunamadi", şifreleme anahtarı değişmiş/bozulmuş).
 * İkincisi sessizce "bağlı değil" sayılırsa hiçbir uyarı çıkmaz ve eksik ciro tam sanılır —
 * bu turda kapatılan hatanın ta kendisi. Yalnız "eksik" kurulmamış sayılır.
 */
function isMissingCredentialError(error: unknown): boolean {
  return /eksik/i.test(error instanceof Error ? error.message : String(error ?? ""));
}

/** Kullanıcıya taşınacak hata metni. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Bilinmeyen hata");
}

function trendyolStatus(s?: string): {
  kind: OrderStatusKind;
  label: string;
  unknown?: boolean;
} {
  if (s && TRENDYOL_STATUS[s]) return TRENDYOL_STATUS[s];
  return { kind: "other", label: s || "Bilinmiyor", unknown: true };
}

/**
 * Satır bazlı iade mi? (Çok kalemli siparişte tek kalemin iadesi.)
 *
 * PAKET durum tablosu KULLANILMAZ: orada "Paket Bölündü" ve "Tedarik Edilemedi" gibi iade
 * OLMAYAN durumlar da var; onlarla yorumlayınca hiç iade olmayan normal siparişlerde
 * "N ürün iade edilmiş" uyarısı çıkıyordu. Yalnız gerçekten iadeyi anlatan satır durumları.
 */
const TRENDYOL_RETURNED_LINE_STATUS = new Set(["Returned", "UnDeliveredAndReturned"]);
function isReturnedLineStatus(status?: string): boolean {
  return Boolean(status && TRENDYOL_RETURNED_LINE_STATUS.has(status));
}


// ── Hepsiburada yardımcıları (yanıt şekli Test'le doğrulanana dek defansif) ──
const HB_STATUS = HEPSIBURADA_STATUS_KINDS;
function hbStatus(s: string): {
  kind: OrderStatusKind;
  label: string;
  unknown?: boolean;
} {
  // Trendyol ile aynı kural: tanımadığımız durum ciroya sessizce giremez.
  return HB_STATUS[s] ?? { kind: "other", label: s || "Bilinmiyor", unknown: true };
}

// Manuel sipariş durumları. Tanımadığımız bir durum daha önce "İptal" etiketiyle görünüyor ama
// ciroya dahil ediliyordu → ekrandaki iki rakam birbirini tutmuyordu. Artık "Diğer" olarak
// gösterilir ve ciroya dahil edilmeye devam eder (yalnız gerçek iptaller dışarıda kalır).
// NOT: Pazaryerlerinin AKSİNE burada bilinmeyen durum toplamdan çıkarılmaz — bu kaydı kullanıcı
// kendi eliyle girdi; onu "belki iadedir" diye ciro dışına almak kendi satışını gizlerdi.
// ⚠️ Etiketler manuel sipariş penceresindeki durum listesiyle AYNI olmak zorunda
// (components/orders/ManualOrderDialog.tsx): kullanıcı orada seçtiği adı burada aynen görmeli.
const MANUAL_STATUS = MANUAL_STATUS_KINDS;
function manualStatus(s: string): { kind: OrderStatusKind; label: string } {
  return MANUAL_STATUS[s] ?? { kind: "other", label: "Diğer" };
}
function hbNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "amount" in (v as Record<string, unknown>)) {
    return Number((v as { amount?: unknown }).amount) || 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
/**
 * ⚠️ SİPARİŞİN VERİLİŞ ANI — teslim/kargo/iade tarihi DEĞİL.
 *
 * Bu alan hem ekranda "sipariş saati" olarak yazılıyor hem de listenin sıralama ölçütü.
 * Bir yol yanlışlıkla `DeliveredDate`i öne alıyordu: teslim edilmiş Hepsiburada siparişleri
 * "teslim edildiği saatte verilmiş" gibi görünüyor ve kronolojik sırada yanlış yere düşüyordu.
 * Kullanıcı bunu "veriliş saati bazen yanlış geliyor" diye bildirdi ("bazen", çünkü yalnız
 * durum filtreli listeden gelen siparişler etkileniyordu). Liste tarihlerinin kuralı artık
 * telefonla ortak çekirdekte (core/hb-siparis.ts); burada yalnız detay yanıtı okunur.
 *
 * Kural: ÖNCE sipariş/oluşturulma tarihi; teslim-kargo-iade damgaları ASLA öne alınmaz.
 */
function hbDate(...vals: unknown[]): string | null {
  const ms = hbTarihMs(...vals);
  return ms == null ? null : new Date(ms).toISOString();
}
/**
 * Sipariş satırı + ürünlerimizle eşleştirme anahtarları.
 * Anahtarlar TÜRÜNE göre ayrı tutulur: aynı metin bir üründe barkod, başka bir üründe stok kodu
 * olabiliyor. Tür bilgisi olmadan "ilk gelen kazanıyor" ve satır yanlış ürüne bağlanıyordu.
 */
type RawLine = {
  name: string;
  quantity: number;
  unitPrice: number;
  image: string | null;
  barcodes: string[];
  /** Platform ürün/varyant kimliği (Listing.externalId ile eşleşir). */
  externalIds: string[];
  skus: string[];
  /**
   * Siparişte kesilen komisyon oranı — KESİR. Pazaryeri bildirmediyse (Shopify, eski önbellek
   * kaydı) boş kalır ve kâr hesabı ilanın/ürünün varsayılan oranına düşer.
   */
  commissionRate?: number | null;
  /** Satırın kendi satış KDV oranı (%) — pazaryeri bildirdiyse. */
  saleVatRate?: number | null;
  /** Satırın tahsilat bedeli (brüt TL) — Hepsiburada. */
  paymentFee?: number | null;
  /** Satırın stopajı (TL) — yalnız bilgi, kâra girmez. */
  stoppage?: number | null;
  /** Uluslararası hizmet bedeli (brüt TL) — Trendyol mikro ihracat. */
  internationalFee?: number | null;
  /** Kargoya verme süresi (gün) — Hepsiburada hizmet bedeli buna göre kesiliyor. */
  dispatchDays?: number | null;
  /** Müşterinin ödediği birim fiyat (Hepsiburada: indirim öncesi değil) — kargo bareminin tutarı. */
  paidUnitPrice?: number | null;
};

const matchKeyList = (...values: unknown[]): string[] =>
  values.filter((v): v is string => typeof v === "string" && v.trim().length > 0);

/** HB sipariş/detay kalemi → RawLine şekli (tutar + eşleştirme anahtarları). */
function hbLineRaw(li: Record<string, any>): RawLine {
  const qty = Math.max(1, Math.floor(hbNum(li.quantity ?? li.amount ?? 1)));
  const unit = hbNum(li.unitPrice ?? li.price) || (hbNum(li.totalPrice) / qty);
  // Kesinti kuralları (komisyon KDV'si, HB indirimi, tahsilat, stopaj, hizmet bedeli) çekirdekte —
  // telefon da aynı fonksiyonu çağırır. `unit` müşterinin ödediği; satıcının geliri `h.unitPrice`.
  const h = hbKalemHesabi(li, qty, unit);
  return {
    name: hbStr(li.productName, li.name, li.title, li.barcode, li.merchantSku) || "Ürün",
    quantity: qty,
    unitPrice: h.unitPrice,
    image: null,
    barcodes: matchKeyList(li.barcode),
    externalIds: matchKeyList(li.hbSku, li.hepsiburadaSku),
    skus: matchKeyList(li.merchantSku, li.sku, li.stockCode),
    commissionRate: h.commissionRate,
    saleVatRate: h.saleVatRate,
    paymentFee: h.paymentFee,
    stoppage: h.stoppage,
    dispatchDays: h.dispatchDays,
    paidUnitPrice: h.paidUnitPrice,
  };
}
/** items'i en çok `limit` eşzamanlı çalışan worker ile işle (orders route'u kilitlemeden detay çek). */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; await fn(items[idx]); }
    })
  );
}

function shopifyStatus(
  fulfillment: string | null,
  financial: string | null,
  cancelled: boolean,
  /** Gönderim teslim edildi mi (`shopifyTeslimEdildi`) — sipariş alanı bunu taşımaz. */
  delivered = false
): { kind: OrderStatusKind; label: string } {
  if (cancelled) return { kind: "cancelled", label: "İptal" };
  // Tam iade fulfillment'tan önce değerlendirilir ve ciro/kâra girmez. Kısmi iade ise
  // currentTotalPriceSet ile kalan geliri kullanır; satır/restock ayrıntısı eksik olduğundan
  // aşağıda kârı "kısmi" işaretlenir.
  const fin = (financial || "").toUpperCase();
  if (fin === "REFUNDED") return { kind: "cancelled", label: "İade" };
  const f = (fulfillment || "").toUpperCase();
  if (f === "FULFILLED") {
    return delivered ? { kind: "delivered", label: "Teslim Edildi" } : { kind: "shipped", label: "Gönderildi" };
  }
  if (f === "PARTIALLY_FULFILLED") return { kind: "processing", label: "Kısmi Gönderim" };
  if (f === "IN_PROGRESS" || f === "SCHEDULED") return { kind: "processing", label: "Hazırlanıyor" };
  if (fin === "PENDING" || fin === "AUTHORIZED") return { kind: "pending", label: "Ödeme Bekliyor" };
  // "Hazırlanmadı" aynı durumun ikinci adıydı; her yerde "Bekleyen" kullanılıyor.
  return { kind: "pending", label: "Bekleyen" };
}

interface Matched {
  id: string;
  name: string;
  imageUrl: string | null;
  productionCost: number;
  packagingCost: number;
  packagingComponents: PackagingBreakdown["components"] | null;
  filamentCost: number; // KDV iadesine giren malzeme payı
  /** Üretim maliyeti gerçekten girilmiş mi — paketleme tutarı bunu maskeleyemez. */
  productionCostKnown: boolean;
  categoryName: string;
  desi: number | null;
  commissionRate: number | null;
  madeToOrder: boolean;
  stock: number;
  /** Platform bazlı listing override'ları (komisyon + ELLE girilen kargo) — Ürünler/Panel ile AYNI kaynak. */
  listingByPlatform: Record<string, { platform: string; commissionRate: number | null; commissionFixed: number | null; cargoCost: number | null }>;
}

type CommissionRules = CommissionRuleInput[];
type CargoRules = CargoRuleInput[];
type ExpenseRules = ExpenseRuleInput[];

// ── Sunucu önbelleği (stale-while-revalidate) ──────────────────────────────────────────────
// Siparişler 3 pazaryerinden CANLI çekiliyor (1-3sn). İlk yüklemeden SONRA her açış önbellekten
// ANINDA döner; 60sn'den eskiyse arka planda tazelenir (eski veri anında gösterilir → sayfa beklemez).
// "Yenile" (?fresh=1) senkron canlı çeker. Önbellek PAYLAŞILAN modülde (lib/orders-cache) — kargo/
// komisyon/gider değişince bustProfitInputCaches() ile düşürülür (lib/cache-busting). O yardımcı
// products:/dashboard: gövdelerini de düşürür; yalnız burayı düşürmek YETMEZ, çünkü Ürünler ve
// Panel kârı kendi SWR gövdelerinden okur ve o gövdeler diske de yazılır.
const ORDERS_SOFT_MS = 60_000;
/**
 * Ekranın dakikalık OTOMATİK yenilemesi (?pasif=1) gövdeyi bu kadar eskimeden tazeletmez: sayfa
 * açık durdukça her dakika üç pazaryeri + finans yazımı koşmasın. Yeni sipariş gelince order-watch
 * gövdeyi zaten tazeliyor; durum değişiklikleri en geç bu süre içinde görünür.
 */
const ORDERS_PASIF_SOFT_MS = 5 * 60_000;

// ── Çekim ilerlemesi ────────────────────────────────────────────────────────────────────────
// Üç pazaryeri CANLI çekildiği için bekleme 10-20 saniyeyi bulabiliyor ve ekranda yalnız akan
// bir çizgi vardı: ne kadar kaldığı belli değildi. Burada her kaynak bittikçe durumu işaretlenir;
// arayüz `GET /api/orders?stage=1` ile "3/4 kaynak alındı" diyebiliyor. Bu uç veritabanına ve
// pazaryerlerine HİÇ dokunmaz (yalnız bellekteki durumu okur) → beklerken sorulması bedava.
type OrdersSourceKey = "shopify" | "trendyol" | "hepsiburada" | "manual";
type OrdersSourceState = "pending" | "done" | "error" | "skipped";
const ORDERS_SOURCE_KEYS: OrdersSourceKey[] = [
  "shopify",
  "trendyol",
  "hepsiburada",
  "manual",
];
interface OrdersFetchStage {
  runId: number;
  startedAt: number;
  finishedAt: number | null;
  sources: Record<OrdersSourceKey, { state: OrdersSourceState; count: number }>;
}

function emptyStageSources(): OrdersFetchStage["sources"] {
  return {
    shopify: { state: "pending", count: 0 },
    trendyol: { state: "pending", count: 0 },
    hepsiburada: { state: "pending", count: 0 },
    manual: { state: "pending", count: 0 },
  };
}

let ordersFetchStage: OrdersFetchStage = {
  runId: 0,
  startedAt: 0,
  finishedAt: 0,
  sources: emptyStageSources(),
};

function beginOrdersFetchStage(): number {
  const runId = ordersFetchStage.runId + 1;
  ordersFetchStage = {
    runId,
    startedAt: Date.now(),
    finishedAt: null,
    sources: emptyStageSources(),
  };
  return runId;
}

/** Geç kalan eski bir turun işareti güncel turu bozmasın diye runId karşılaştırılır. */
function markOrdersSource(
  runId: number,
  key: OrdersSourceKey,
  state: OrdersSourceState,
  count = 0
): void {
  if (ordersFetchStage.runId !== runId) return;
  ordersFetchStage.sources[key] = { state, count };
}

function finishOrdersFetchStage(runId: number): void {
  if (ordersFetchStage.runId !== runId) return;
  ordersFetchStage.finishedAt = Date.now();
}

function ordersFetchStageSnapshot() {
  const sources = ORDERS_SOURCE_KEYS.map((key) => ({
    key,
    ...ordersFetchStage.sources[key],
  }));
  return {
    runId: ordersFetchStage.runId,
    active: ordersFetchStage.startedAt > 0 && ordersFetchStage.finishedAt == null,
    startedAt: ordersFetchStage.startedAt || null,
    total: sources.length,
    completed: sources.filter((s) => s.state !== "pending").length,
    sources,
  };
}

// EŞZAMANLI HESAP TEKİLLEŞTİRME + NESİL KORUMASI: Panel, Siparişler, Raporlar ve order-watch
// aynı anda tetikleyebiliyor; hepsi lib/orders-cache içindeki computeOrdersShared'ı paylaşır.
// Burada AYRI bir kopya vardı ve o kopya nesli gözetmiyordu: kullanıcı hesap sürerken kargo/
// komisyon/gider kuralını değiştirip "Yenile"ye bastığında DEVAM EDEN eski hesap dönüyor ve
// önbelleğe de yazılıyordu (doğru rakam için iki kez yenilemek gerekiyordu). Yayınlama kararı
// artık tek yerde: sonuç eskimişse yayınlanmaz, hesap yeni kurallarla baştan koşar.
export async function GET(req: NextRequest) {
  try {
    const params = new URL(req.url).searchParams;
    // Sadece "nerede kaldı" sorusu: bellekteki ilerleme durumu. Veritabanına ve pazaryerlerine
    // dokunmadığı için çekim sürerken saniyede bir sorulabilir.
    if (params.get("stage") === "1") {
      return NextResponse.json(ordersFetchStageSnapshot(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const fresh = params.get("fresh") === "1";
    const pasif = params.get("pasif") === "1";
    const cached = getOrdersCache();
    // Önbellek YALNIZ aynı UTC gününde hesaplanmışsa anında verilir: gün değişince 30 günlük
    // pencere kayar ve dünkü hesap yanlış pencereyi anlatır (bkz. ayniPencereGunuMu).
    if (!fresh && cached && ayniPencereGunuMu(cached.at)) {
      if (Date.now() - cached.at > (pasif ? ORDERS_PASIF_SOFT_MS : ORDERS_SOFT_MS)) arkadaCanliTazele();
      return NextResponse.json(cached.body);
    }
    try {
      // "Yenile" (fresh) her zaman canlı çeker. Değilse — kâr girdisi az önce değiştiği için
      // önbellek düştüyse — birkaç dakikalık ham çekim yeniden kullanılır: yalnız kâr hesaplanır.
      const hamYasSiniriMs = fresh ? 0 : HAM_YENIDEN_KULLANIM_MS;
      return NextResponse.json(await computeOrdersShared(() => computeOrdersBody({ hamYasSiniriMs })));
    } catch (error) {
      // Taze hesap düşerse (ör. ağ yok) dünkü pencere de olsa eldeki sonuç boş ekrandan iyidir;
      // gövde kendi `computedAt` damgasını taşıdığı için ekran ne zaman hesaplandığını yazar.
      if (!fresh && cached) return NextResponse.json(cached.body);
      throw error;
    }
  } catch (error) {
    return jsonError(error);
  }
}

/** Bayat gövdeyi arka planda CANLI çekimle tazele (ham çekim yeniden kullanılmaz). */
function arkadaCanliTazele(): void {
  if (isOrdersRefreshing()) return;
  setOrdersRefreshing(true);
  void computeOrdersShared(() => computeOrdersBody({ hamYasSiniriMs: 0 }))
    .catch(() => {})
    .finally(() => { setOrdersRefreshing(false); });
}

async function computeOrdersBody(secenek: { hamYasSiniriMs: number }): Promise<Record<string, unknown>> {
  const runId = beginOrdersFetchStage();
  try {
    return await computeOrdersBodyInner(runId, secenek.hamYasSiniriMs);
  } finally {
    finishOrdersFetchStage(runId);
  }
}

async function computeOrdersBodyInner(
  runId: number,
  hamYasSiniriMs: number
): Promise<Record<string, unknown>> {
  await ensureRuntimeSchema();

  // Gün başına sabitlenmiş cutoff — mobil (mobile/src/lib/api/window.ts orderWindowCutoff) ile
  // BİREBİR aynı formül. İki uygulama da aynı UTC günü boyunca aynı değeri üretir → sipariş
  // sayısı/ciro/kâr ne zaman yenilenirse yenilensin eşleşir (kayan saniye sınırı yok).
  const cutoff = (Math.floor(Date.now() / 86_400_000) - WINDOW_DAYS) * 86_400_000;
  const historyCutoff =
    (Math.floor(Date.now() / 86_400_000) - HISTORY_SYNC_DAYS) * 86_400_000;
  const orders: UnifiedOrder[] = [];
  // Hata BURADA yakalanır: sonuç ancak pazaryeri çekimi bittikten sonra bekleniyor ve o aralıkta
  // sahipsiz kalan bir reddetme tüm hesabı düşürüyordu.
  type ManualOrderRow = Awaited<
    ReturnType<typeof remotePrisma.manualOrder.findMany>
  >[number];
  const manualOrdersPromise: Promise<{
    rows: ManualOrderRow[];
    error: string | null;
  }> = remotePrisma.manualOrder
    .findMany({
      // İşi bitmemiş elle sipariş tarihine bakılmadan okunur — listede ve hazırlıkta kalır
      // (bkz. core/order-window). Özetler yine yalnız pencere içini sayar.
      where: {
        OR: [
          { orderedAt: { gte: new Date(historyCutoff) } },
          { statusKind: { in: [...ACIK_SIPARIS_TURLERI] } },
        ],
      },
      orderBy: { orderedAt: "desc" },
    })
    .then((rows) => {
      markOrdersSource(runId, "manual", "done", rows.length);
      return { rows, error: null };
    })
    .catch((error: unknown) => {
      markOrdersSource(runId, "manual", "error");
      return {
        rows: [] as ManualOrderRow[],
        error:
          error instanceof Error ? error.message : "Manuel siparişler okunamadı",
      };
    });
  let shopify: PlatformStatus = { ok: false, count: 0 };
  let trendyol: PlatformStatus = { ok: false, count: 0 };
  let hepsiburada: PlatformStatus = { ok: false, count: 0 };
  // Manuel siparişler de kendi durumunu taşır: okunamayan TEK kayıt yüzünden üç pazaryerinden
  // yeni çekilmiş bütün veriyi çöpe atmıyoruz (aşağıya bkz.).
  let manualSource: PlatformStatus = { ok: true, count: 0 };

  // Ham siparişleri çek (her platform bağımsız) ──────────────────────────────
  type Raw = {
    platform: "shopify" | "trendyol" | "hepsiburada";
    id: string;
    orderNumber: string;
    date: string | null;
    statusKind: OrderStatusKind;
    statusLabel: string;
    total: number;
    currency: string;
    customer: string | null;
    lines: RawLine[];
    trackingNumber: string | null;
    cargoProvider: string | null;
    packageNumber?: string | null;
    /** Trendyol mikro ihracat — satış KDV'den istisna (bkz. core/mikro-ihracat). */
    microExport?: MikroIhracat | null;
    /** Kısmi iade veya API satır sınırı nedeniyle hesaplanan kâr kesin değildir. */
    forceProfitPartial?: boolean;
    /** Kalem/tutar bilgisi hiç alınamadı → ciro/kâr toplamlarına ve finans geçmişine girmez. */
    dataIncomplete?: boolean;
    /** Durum adı tanınmadı → toplamlara ve finans geçmişine girmez, sayısı gösterilir. */
    statusUnknown?: boolean;
    /** İade/iptal işaretli kalem sayısı (paket tutarına dokunulmaz). */
    returnedLineCount?: number;
    /** Kargo tarifesinin fiyatı seçtiği bilgiler (firma, hızlı teslimat, kargoya verme süresi). */
    kargo?: KargoBaglami | null;
    /** Kargoya verildikten sonra geri geldi → iki yön kargo zararı (core/order-profit computeReturnLoss). */
    kargoIadesi?: boolean;
    /** Trendyol: termin gecikmesi (core/trendyol-gecikme) — bedel haftalık faturayla eşleştirilir. */
    gecikme?: TyGecikme | null;
    /** Trendyol: satıcı kusurlu iade (core/trendyol-kusurlu) — bedel haftalık faturayla eşleştirilir. */
    kusurlu?: TyKusurluIade | null;
  };
  const raws: Raw[] = [];
  /** Yerel tamponu ana listeye aktar (spread yerine döngü: binlerce satırda argüman sınırı yok). */
  const commitRaws = (rows: Raw[]) => {
    for (const row of rows) raws.push(row);
  };

  // AŞAMA 1'i ATLA: kâr girdisi az önce değiştiyse ve birkaç dakikalık TAM bir ham çekim varsa
  // pazaryerlerine yeniden gidilmez (bkz. lib/orders-cache "AŞAMA 1"). Ham veri derin kopyadır.
  type HamCekimVerisi = { raws: Raw[]; shopify: PlatformStatus; trendyol: PlatformStatus; hepsiburada: PlatformStatus };
  const hazirHam = hamCekimAl<HamCekimVerisi>(hamYasSiniriMs);
  if (hazirHam) {
    commitRaws(hazirHam.veri.raws);
    ({ shopify, trendyol, hepsiburada } = hazirHam.veri);
    markOrdersSource(runId, "shopify", "done", shopify.count);
    markOrdersSource(runId, "trendyol", "done", trendyol.count);
    markOrdersSource(runId, "hepsiburada", "done", hepsiburada.count);
    // Ham veri bir dakikadan eskiyse kâr gövdesi yayınlandıktan hemen sonra canlı tazelensin.
    if (Date.now() - hazirHam.at > ORDERS_SOFT_MS) setTimeout(arkadaCanliTazele, 0);
  }

  // Üç platformu PARALEL çek — toplam gecikme = en yavaş tek platform (sıralı toplam DEĞİL).
  // Bloklar bağımsız: her biri kendi durum değişkenini atar (yarış yok).
  //
  // 🔴 YARIM ÇEKİM = SESSİZ YANLIŞ VERİ: satırlar eskiden döngünün İÇİNDE ortak listeye
  // ekleniyordu. Ortada bir hata olursa platform kartı "alınamadı" derken özette o platformun
  // EKSİK cirosu duruyor, kullanıcı da onu tam sanıyordu. Artık her platform önce kendi yerel
  // tamponunu doldurur; yalnızca çekim SORUNSUZ bittiğinde tampon ortak listeye aktarılır.
  if (!hazirHam) await Promise.all([
   (async () => {
   const buffer: Raw[] = [];
   // Kimlik bilgisi adımı AYRI. Burada "eksik" hatası = kurulu değil; başka her hata (ör.
   // kayıtlı anahtar çözülemiyor) GERÇEK arızadır ve kullanıcıya gösterilir.
   let credentials: Awaited<ReturnType<typeof getShopifyCredentials>>;
   try {
     credentials = await getShopifyCredentials();
   } catch (error) {
     if (isMissingCredentialError(error)) {
       shopify = { ok: false, count: 0, notConfigured: true };
       markOrdersSource(runId, "shopify", "skipped");
     } else {
       shopify = { ok: false, count: 0, error: errorMessage(error) };
       markOrdersSource(runId, "shopify", "error");
     }
     return;
   }
   try {
    const client = new ShopifyClient(credentials);
    // +1 gün: gün-başı historyCutoff'tan biraz daha geniş çek (superset); aşağıdaki
    // historyRows filtresi tam kırpar. Shopify created_at = orderDate.
    const list = await client.listOrders({ sinceDays: HISTORY_SYNC_DAYS + 1, limit: 100 });
    for (const o of list) {
      const st = shopifyStatus(o.fulfillmentStatus, o.financialStatus, Boolean(o.cancelledAt), o.delivered);
      buffer.push({
        platform: "shopify",
        id: o.id || `shopify-${o.name}`,
        orderNumber: o.name,
        date: o.createdAt ?? null,
        statusKind: st.kind,
        statusLabel: st.label,
        total: o.totalAmount,
        currency: o.currency,
        customer: o.customerName,
        lines: o.lines.map((l) => ({
          name: l.title,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          image: l.image,
          // Çok-anahtarlı eşleştirme: variant barcode/sku, satır sku, variant id (Listing.externalId)
          barcodes: matchKeyList(l.barcode),
          externalIds: matchKeyList(
            l.variantId,
            l.variantId ? `shopify-variant-${l.variantId}` : null
          ),
          skus: matchKeyList(l.variantSku, l.sku),
        })),
        trackingNumber: o.trackingNumber,
        cargoProvider: o.cargoProvider,
        forceProfitPartial:
          o.linesTruncated ||
          (o.financialStatus || "").toUpperCase() === "PARTIALLY_REFUNDED",
      });
    }
    commitRaws(buffer);
    shopify = { ok: true, count: buffer.length };
    markOrdersSource(runId, "shopify", "done", buffer.length);
  } catch (e) {
    if (e instanceof ShopifyAdminTokenMissingError) {
      shopify = { ok: false, count: 0, needsAdminToken: true };
      markOrdersSource(runId, "shopify", "skipped");
    } else {
      shopify = {
        ok: false,
        count: 0,
        error: e instanceof Error ? e.message : "Shopify siparişleri alınamadı",
      };
      markOrdersSource(runId, "shopify", "error");
    }
  }
   })(),
   (async () => {
   const buffer: Raw[] = [];
   let credentials: Awaited<ReturnType<typeof getTrendyolCredentials>>;
   try {
     credentials = await getTrendyolCredentials();
   } catch (error) {
     // "Kurulu değil" ile "kurulu ama OKUNAMIYOR" ayrı şeyler. Kayıtlı anahtar çözülemezse
     // (şifreleme anahtarı değişmiş / dosya bozulmuş) bu GERÇEK bir hatadır: sessizce
     // "bağlı değil" sayılırsa uyarı hiç çıkmaz ve eksik ciro tam sanılır.
     if (isMissingCredentialError(error)) {
       trendyol = { ok: false, count: 0, notConfigured: true };
       markOrdersSource(runId, "trendyol", "skipped");
     } else {
       trendyol = { ok: false, count: 0, error: errorMessage(error) };
       markOrdersSource(runId, "trendyol", "error");
     }
     return;
   }
   try {
    const client = new TrendyolClient(credentials);
    // Trendyol /orders (shipmentPackages): statü filtresi YOK → TÜM statüler (oluşturuldu/kargoda/
    // teslim/iptal) gelir. Ama tek sayfa size:100 son-100'le sınırlıydı → 30 günde 100+ sipariş varsa
    // eksik çekiyordu (kâr yanlış). Çözüm: pencereyi 14 GÜNLÜK dilimlere (Trendyol startDate/endDate
    // aralık limiti ≤2 hafta — AŞILAMAZ) böl + her dilimde sayfala. (Route ayrıca orderDate'e göre
    // görünür pencereye kırpar.)
    //
    // ⏱️ Dilimler BİRBİRİNDEN BAĞIMSIZ: eskiden 60 gün = 5 dilim SIRAYLA çekiliyordu, yani beş ayrı
    // bekleme. Artık aynı anda (sınırlı sayıda) çekiliyorlar; toplam bekleme en yavaş dilime iner.
    // Eşzamanlılık sınırı Trendyol servis limitine takılmamak için bilinçli olarak düşük.
    const TY_WINDOW_CONCURRENCY = 3;
    // Dilim boyu `trendyol-windows.ts`'te hesaplanıyor: saat dilimi payı iki uçtan eklendiği
    // için dilim 14 GÜN OLAMAZ — açıklık sınırı aşar ve Trendyol pencerenin en yeni ucunu
    // sessizce kırpar (bkz. o dosyadaki olay kaydı).
    const tyWindows = buildTrendyolWindows(Date.now(), historyCutoff);
    // İade talepleri siparişlerle AYNI ANDA istenir — bekleme eklemez, hata fırlatmaz.
    const iadelerSozu = trendyolTalepSonuclariniOku(client);
    // Sonuçlar dilim sırasında toplanır (yeni → eski): eşzamanlı çekim listenin sırasını bozmasın.
    const tyByWindow: TrendyolOrder[][] = tyWindows.map(() => []);
    await mapLimit(
      tyWindows.map((_, index) => index),
      TY_WINDOW_CONCURRENCY,
      async (index) => {
        const { startDate, endDate } = tyWindows[index];
        for (let pageNo = 0; pageNo < 50; pageNo++) {
          const page = await client.listOrders({ page: pageNo, size: 100, startDate, endDate });
          const content = page.content ?? [];
          for (const order of content) tyByWindow[index].push(order);
          if (content.length < 100) break; // son sayfa
        }
      }
    );
    const { iadeler, kusurlular, basarisiz: iadeBilinmiyor } = await iadelerSozu;
    const seenTy = new Set<string>();
    for (const [rowIndex, o] of tyByWindow.flat().entries()) {
      // Paket id'si 0 olan yeni siparişler (Trendyol ilk saniyelerde böyle veriyor) artık "0"
      // anahtarında birleşip birbirini listeden SİLMİYOR — bkz. core/trendyol-order-id.
      const id = trendyolOrderId(o, rowIndex);
      if (seenTy.has(id)) continue; // pencere sınırı çakışması olursa çift sayma
      seenTy.add(id);
      let st = trendyolStatus(o.status);
      // Çok kalemli siparişte TEK kalemin iadesi paket durumuna yansımıyor: satır
      // durumundan sayılır. Paket tutarının bu durumda ne olduğu doğrulanmadığı için
      // ciroya DOKUNMUYORUZ — yalnız kullanıcıya "bu siparişte iade var" diyoruz.
      let returnedLineCount = (o.lines ?? []).filter((l) =>
        isReturnedLineStatus(l.orderLineItemStatusName)
      ).length;
      // Kabul edilmiş iade talebi: paket "Delivered" görünse de para geri verildi. Bütün adetler
      // iade edildiyse sipariş İADE olur (ciro/kâr dışı); bir kısmıysa yalnız işaretlenir.
      const iade = iadeler.get(id);
      const paketAdet = (o.lines ?? []).reduce((t, l) => t + Number(l.quantity ?? 1), 0);
      const iadeDurumu = trendyolIadeDurumu(paketAdet, iade);
      if (iadeDurumu === "tam" && st.kind !== "cancelled") {
        st = { ...TRENDYOL_STATUS.Returned, unknown: false };
      } else if (iadeDurumu === "kismi" && iade) {
        returnedLineCount = Math.max(returnedLineCount, iade.satirSayisi);
      }
      const mikroIhracat = trendyolMikroIhracat(o);
      buffer.push({
        platform: "trendyol",
        // Paket id'si henüz yoksa GEÇİCİ kimlik: listede görünür, kalıcı kayda yazılmaz.
        id,
        orderNumber: String(o.orderNumber ?? o.id ?? "—"),
        // Trendyol'un damgası Türkiye duvar saatini taşıyor; gerçek UTC'ye çeviriyoruz.
        // Ham hâliyle arayüz üstüne +3 daha ekleyip siparişleri 3 saat ileri gösteriyordu.
        date: trendyolDateToIso(o.orderDate),
        statusKind: st.kind,
        statusLabel: st.label,
        statusUnknown: st.unknown,
        returnedLineCount: st.kind === "cancelled" ? 0 : returnedLineCount,
        total: Number(o.totalPrice ?? o.grossAmount ?? 0),
        currency: "TRY",
        customer: [o.customerFirstName, o.customerLastName].filter(Boolean).join(" ") || null,
        lines: (o.lines ?? []).map((l) => ({
          name: l.productName ?? l.barcode ?? "Ürün",
          quantity: Number(l.quantity ?? 1),
          unitPrice: Number(l.price ?? 0),
          image: null,
          // Trendyol order satırı barcode verir ("merchantSku" literal'i çöp → ele)
          barcodes: matchKeyList(l.barcode),
          externalIds: [],
          skus: matchKeyList(l.sku, l.merchantSku).filter((k) => k !== "merchantSku"),
          // Trendyol satırda o satışın oranını YÜZDE verir (21; kampanyada 13.2 gibi kesirli).
          commissionRate: siparisKomisyonKesri(l.commission),
          // Satış KDV'si, stopaj ve (mikro ihracatta) uluslararası hizmet bedeli — core/ty-kesinti.
          ...tyKalemHesabi(l, Number(l.price ?? 0) * Number(l.quantity ?? 1), { mikroIhracat: mikroIhracat != null }),
        })),
        trackingNumber: o.cargoTrackingNumber ? String(o.cargoTrackingNumber) : null,
        cargoProvider: o.cargoProviderName ?? null,
        // Mikro ihracat (yurt dışı müşteri) — ölçüldü 15 Kas 2026: alan her pakette geliyor.
        microExport: mikroIhracat,
        // Kargo tarifesi: hızlı teslimat + zamanında → avantajlı tablo (core/kargo-tarife).
        kargo: trendyolKargoBaglami(o),
        kargoIadesi: kargoluIadeMi("trendyol", o.status, iadeDurumu === "tam"),
        gecikme: trendyolGecikmesi(o, Date.now()),
        kusurlu: kusurlular.get(id) ?? null,
      });
    }
    // Tüm pencereler ve sayfalar sorunsuz bittiyse ancak o zaman ortak listeye aktar.
    commitRaws(buffer);
    // Pencere dışına düşmüş (ya da telefonun eski sürümünün geri çevirdiği) kayıtlar — arka planda.
    if (iadeler.size > 0) void trendyolIadeleriniGecmiseIsle(iadeler);
    trendyol = { ok: true, count: buffer.length, ...(iadeBilinmiyor ? { iadeBilinmiyor: true } : {}) };
    markOrdersSource(runId, "trendyol", "done", buffer.length);
  } catch (e) {
    trendyol = {
      ok: false,
      count: 0,
      error: e instanceof Error ? e.message : "Trendyol siparişleri alınamadı",
    };
    markOrdersSource(runId, "trendyol", "error");
  }
   })(),
   (async () => {
   const buffer: Raw[] = [];
   let credentials: Awaited<ReturnType<typeof getHepsiburadaCredentials>>;
   try {
     credentials = await getHepsiburadaCredentials();
   } catch (error) {
     if (isMissingCredentialError(error)) {
       hepsiburada = { ok: false, count: 0, notConfigured: true };
       markOrdersSource(runId, "hepsiburada", "skipped");
     } else {
       hepsiburada = { ok: false, count: 0, error: errorMessage(error) };
       markOrdersSource(runId, "hepsiburada", "error");
     }
     return;
   }
   try {
    const client = new HepsiburadaClient(credentials);
    // a-b) Listeleri çekip birleştirme telefonla ORTAK çekirdekte (core/hb-siparis.ts): açık
    //      siparişler sayfalanır, paket özetlerinde tarih = VERİLİŞ anı, iptal/iade listeleri
    //      güvenlik freniyle uygulanır. Kurallar tek yerde — telefon kopyası bir daha geride kalmasın.
    const { siparisler: hbSiparisler, paketCiftleri: hbPackageKeyPairs } = await hbSiparisleriTopla(
      {
        acikSiparisler: (offset, limit) => client.listOrders({ offset, limit }),
        paketler: (durum, offset, limit) => client.listPackages(durum, { offset, limit }),
        talepler: (tur, offset, limit) => client.listClaimPackages(tur, { offset, limit }),
      },
      hbLineRaw
    );
    type HbAgg = {
      status: string;
      date: string | null;
      customer: string | null;
      lines: RawLine[] | null;
      paketNo: string | null;
      teslimatNo: string | null;
      kargoFirmasi: string | null;
      /** HB listelerinde yok, kayıtta AÇIK görünüyordu → durum ve kalem detaydan okunur. */
      kayittan?: boolean;
    };
    const agg = new Map<string, HbAgg>();
    for (const [on, s] of hbSiparisler) {
      agg.set(on, {
        status: s.status,
        date: s.date == null ? null : new Date(s.date).toISOString(),
        customer: s.customer,
        lines: s.lines,
        paketNo: s.paketNo ?? null,
        teslimatNo: s.teslimatNo ?? null,
        kargoFirmasi: s.kargoFirmasi ?? null,
      });
    }

    // KAYITTA AÇIK ama HB listelerinin DÖNDÜRMEDİĞİ siparişler. Ölçüldü 23 Kas 2026: 4468809025
    // detayda "Packaged", ama paket listesi boş → Panel siparişi hiç görmüyor, Raporlar (kayıt)
    // sayıyordu. Durum ve kalem detaydan okunur; iptal olmuşsa kayıt da iptale döner.
    try {
      // ⚠️ Üst sınır BİLİNENLER ELENDİKTEN SONRA uygulanır: eskiden SQL'deki LIMIT 50 listede zaten
      // görünen açık siparişleri de sayıyordu → 50'den fazla açık siparişte yedek hiç çalışmıyordu.
      const acik = await prisma.$queryRawUnsafe<Array<{ orderNumber: unknown }>>(
        `SELECT "orderNumber" FROM "OrderFinanceSnapshot"
          WHERE "platform" = 'hepsiburada' AND "statusKind" IN ('pending','processing','shipped')
            AND ${dbEpochMs("orderedAt")} >= ?
          LIMIT 1000`,
        historyCutoff
      );
      let eklenen = 0;
      for (const r of acik) {
        const on = String(r.orderNumber ?? "").trim();
        if (!on || agg.has(on)) continue;
        if (++eklenen > 50) break; // detay çağrısı başına sınır — fazlası sonraki turda
        agg.set(on, { status: "", date: null, customer: null, lines: null, paketNo: null, teslimatNo: null, kargoFirmasi: null, kayittan: true });
      }
    } catch {
      /* kayıt okunamazsa yalnız bu yedek atlanır */
    }

    // 30 güne filtrele (tarihsizleri tut) — detay çekmeden ÖNCE (gereksiz detay çağrısı olmasın).
    for (const [on, e] of [...agg]) {
      if (e.date && new Date(e.date).getTime() < historyCutoff) agg.delete(on);
    }

    // c) Tutarı olmayan (özetten gelen) siparişlerin kalem/tutar detayını PARALEL çek (concurrency 8).
    //    Üst sınır 250'ydi ve fazlası SESSİZCE kalemsiz kalıyordu → ₺0 ciroyla özete giriyordu.
    //    Sınır yükseltildi; yine de dışarıda kalan ya da detayı alınamayan sipariş aşağıda
    //    "bilgisi eksik" işaretlenir, özete girmez ve sayısı platform durumuna taşınır.
    //    ⏱️ Teslim edilmiş / iptal / iade siparişlerin detayı BİR DAHA DEĞİŞMEZ. Eskiden her
    //    yenilemede hepsi yeniden indiriliyordu (40 sipariş = 40 istek, her turda). Artık bu
    //    siparişlerin detayı istemcide hatırlanıyor; ikinci yenilemede yalnız yeni/hareketli
    //    siparişler indiriliyor.
    const HB_DETAIL_CAP = 1000;
    const missingDetail = [...agg.entries()].filter(([, e]) => e.lines === null).map(([on]) => on);
    await mapLimit(missingDetail.slice(0, HB_DETAIL_CAP), 8, async (on) => {
      try {
        const kind = hbStatus(agg.get(on)?.status ?? "").kind;
        const settled = kind === "delivered" || kind === "cancelled";
        const d = (await client.getOrderDetail(on, {
          reuseCached: settled,
        })) as Record<string, any>;
        const e = agg.get(on);
        if (!e) return;
        e.lines = (hbArray(d, ["items", "lineItems", "details", "lines", "orderItems"]) as Record<string, any>[]).map(hbLineRaw);
        e.customer = e.customer ?? (hbStr((d.customer ?? {}).name, d.customerName) || null);
        // Sipariş VERME tarihini tercih et (kargo/teslim tarihi değil) → liste + 30g penceresi hep
        // sipariş tarihine göre. Paketten gelen tarih (ShippedDate/DeliveredDate) bununla ezilir.
        const od = hbDate(d.orderDate, d.createdDate);
        if (od) e.date = od;
        // Listelerde olmayan sipariş: durum kalemden (ör. "Packaged"; iptalse "Cancelled").
        if (e.kayittan) {
          const kalemler = hbArray(d, ["items", "lineItems", "details", "lines", "orderItems"]) as Record<string, any>[];
          e.status = hbStr(...kalemler.map((k) => k.status ?? k.Status), d.status) || "";
        }
      } catch { /* detay alınamadı → aşağıda "bilgisi eksik" işaretlenir */ }
    });
    // Detayı alınamayan ya da durumu okunamayan yedek sipariş listeye eklenmez (kayıt olduğu gibi kalır).
    for (const [on, e] of [...agg]) {
      if (e.kayittan && (e.lines === null || !e.status)) agg.delete(on);
    }

    // d) Birleşik satırlar (henüz ortak listeye değil — çekim sorunsuz bitmeden aktarmıyoruz).
    let hbIncomplete = 0;
    for (const [on, e] of agg) {
      const st = hbStatus(e.status);
      const lines = e.lines ?? [];
      // Kalemi hiç gelmediyse tutar da yok: bu sipariş ₺0 gibi görünür ve ciroyu düşük,
      // sipariş sayısını yüksek gösterir. İşaretlenir (listede kalır, özete/finans geçmişine girmez).
      // Boş kalem listesi de aynı sonucu doğurur — gerçek bir siparişin sıfır kalemi olmaz.
      const dataIncomplete = lines.length === 0;
      if (dataIncomplete) hbIncomplete++;
      buffer.push({
        platform: "hepsiburada",
        id: `hb-${on}`,
        orderNumber: on,
        date: e.date,
        statusKind: st.kind,
        statusLabel: st.label,
        statusUnknown: st.unknown,
        total: lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
        currency: "TRY",
        customer: e.customer,
        lines,
        trackingNumber: e.teslimatNo,
        cargoProvider: e.kargoFirmasi,
        packageNumber: e.paketNo,
        dataIncomplete,
        // Kargo baremi: en uzun kargoya verme süresi + müşterinin ödediği tutar (core/kargo-tarife).
        kargo: hepsiburadaKargoBaglami(lines, e.kargoFirmasi),
        kargoIadesi: kargoluIadeMi("hepsiburada", e.status),
      });
    }
    // e) Anahtar değişiminden kalan kalıntı satırları temizle. Eskiden aynı sipariş paketlenirken
    //    paket numarasıyla, kargoya verilince sipariş numarasıyla kaydediliyordu → finans geçmişinde
    //    İKİ satır. Paket↔sipariş eşleşmesini SADECE gerçek veriden bildiğimiz için silme kesin:
    //    tahmin yok, yalnız bu turda ikisini birden gördüğümüz siparişler temizlenir.
    //    (Görünür pencerenin dışında kalan daha eski çiftler bu yolla eşleştirilemez.)
    const adayIds = [...new Set(hbPackageKeyPairs.map((p) => `hb-${p.packageNo}`))];
    // Önce VAR MI diye tek okuma: eskiden paketli sipariş oldukça her hesapta iki silme (yazma)
    // sorgusu koşuyordu — çoğu zaman silinecek tek satır yokken (denetim, 23 Kas 2026).
    const staleIds: string[] = [];
    for (let i = 0; i < adayIds.length; i += 200) {
      const dilim = adayIds.slice(i, i + 200);
      const yer = dilim.map(() => "?").join(",");
      try {
        const bulunan = await prisma.$queryRawUnsafe<Array<{ externalOrderId: unknown }>>(
          `SELECT "externalOrderId" FROM "OrderFinanceSnapshot"
            WHERE "platform" = 'hepsiburada' AND "externalOrderId" IN (${yer})
           UNION
           SELECT "externalOrderId" FROM "OrderItemSnapshot"
            WHERE "platform" = 'hepsiburada' AND "externalOrderId" IN (${yer})`,
          ...dilim,
          ...dilim
        );
        for (const r of bulunan) staleIds.push(String(r.externalOrderId));
      } catch {
        staleIds.push(...dilim); // okunamadıysa eski yol: doğrudan sil
      }
    }
    if (staleIds.length) {
      for (let i = 0; i < staleIds.length; i += 200) {
        const dilim = staleIds.slice(i, i + 200);
        await prisma.orderFinanceSnapshot
          .deleteMany({ where: { platform: "hepsiburada", externalOrderId: { in: dilim } } })
          .catch(() => {
            /* temizlik siparişleri getirmeyi ASLA bozmamalı */
          });
        // Ürün bazlı satış geçmişi de aynı siparişi iki kez saymasın.
        await prisma.orderItemSnapshot
          .deleteMany({ where: { platform: "hepsiburada", externalOrderId: { in: dilim } } })
          .catch(() => {});
      }
    }
    // f) Çekim sorunsuz bitti → ancak şimdi ortak listeye aktar ve durumu yaz.
    commitRaws(buffer);
    hepsiburada = { ok: true, count: buffer.length, incompleteCount: hbIncomplete };
    markOrdersSource(runId, "hepsiburada", "done", buffer.length);
  } catch (e) {
    hepsiburada = {
      ok: false,
      count: 0,
      error: e instanceof Error ? e.message : "Hepsiburada siparişleri alınamadı",
    };
    markOrdersSource(runId, "hepsiburada", "error");
  }
   })(),
  ]);

  // TAM bir canlı çekimi sakla (bir pazaryeri alınamadıysa saklanmaz: sonraki hesap yeniden dener).
  if (!hazirHam && [shopify, trendyol, hepsiburada].every((p) => p.ok || p.notConfigured)) {
    hamCekimYaz({ raws, shopify, trendyol, hepsiburada } satisfies HamCekimVerisi);
  }

  // Finans geçmişi için son 60 günü yeniden değerlendir (tarihsiz olanları da tut).
  // Kullanıcıya dönen liste/özet aşağıda yine son 30 güne kırpılır.
  const historyRows = raws.filter(
    (r) => !r.date || new Date(r.date).getTime() >= historyCutoff
  );

  // Sipariş satırlarını ÜRÜNLERİMİZLE eşleştir → görsel + maliyet + kâr ──────────
  const allKeys = new Set<string>();
  const shopifyNames = new Set<string>(); // Shopify barkod tutmaz → ada göre eşleştirme
  for (const r of historyRows) {
    for (const l of r.lines) {
      for (const k of [...l.barcodes, ...l.externalIds, ...l.skus]) allKeys.add(k);
      if (r.platform === "shopify" && l.name) shopifyNames.add(l.name);
    }
  }

  // Anahtar indeksleri TÜR BAZINDA ayrı: aynı metin bir üründe barkod, başkasında stok kodu
  // olabiliyor. Tek harita kullanıldığında "ilk gelen kazanıyor" ve sipariş satırı yanlış ürüne —
  // dolayısıyla yanlış maliyete — bağlanıyordu. Aynı anahtar birden çok ürüne düşerse o anahtar
  // BELİRSİZ sayılır ve hiç kullanılmaz. Kural `@/core/order-match`te: telefon da AYNI kuralla eşler.
  let urunIndeksi: UrunIndeksi<Matched> | null = null;
  let adSnap: Awaited<ReturnType<typeof adRateSnapshot>> = { at: 0, butceler: [], bugun: new Map() };
  let commissionRules: CommissionRules = [];
  let cargoRules: CargoRules = [];
  let expenseRules: ExpenseRules = [];
  type PlatformFinancial = {
    externalOrderId: string;
    orderNumber: string;
    grossRevenueKurus: number;
    commissionKurus: number;
    platform: string;
    /** Komisyon dışındaki gerçek kesintiler (Hepsiburada) — kuruş; null = kayıt yok. */
    serviceFeeKurus: number | null;
    paymentFeeKurus: number | null;
    cargoKurus: number | null;
    /** İade edilen siparişin dönüş kargosu (gerçek kayıt) — kuruş; null = kayıt yok. */
    returnCargoKurus: number | null;
    /** Pazaryerinin kestiği desi; null = bilinmiyor. */
    chargedDesi: number | null;
  };
  const financialByExternalId = new Map<string, PlatformFinancial>();
  const financialByOrderNumber = new Map<string, PlatformFinancial[]>();
  const trendyolOrderNumberCounts = new Map<string, number>();
  for (const row of historyRows) {
    if (row.platform !== "trendyol") continue;
    trendyolOrderNumberCounts.set(
      row.orderNumber,
      (trendyolOrderNumberCounts.get(row.orderNumber) ?? 0) + 1
    );
  }
  // Shopify global komisyon oranı resolveListingCommissionOverride içinde buradan okunur → dış kapsam.
  let settingsMap: Record<string, string | undefined> = {};
  // Filament gram fiyatları (çoklu filamentli ürünler + siparişe özel maliyet) — dış kapsam.
  let filamentFiyatlari: Map<string, number> = new Map();

  // ELLE ÜRÜN BAĞLARI (Siparişler → "Ürüne bağla"): kendi anahtarıyla eşleşmeyen satırın ADI → ürün.
  // Ürün yenilenince eski siparişler eski adla kalıyor; bağ onları seçilen ürüne eşler. Bağlı
  // ürünler ön süzgeçte ada/anahtara takılmayabilir → kimlikleri ayrıca çekilir.
  const satirBaglari = await satirBaglariniOku();
  const bagliUrunIdleri = new Set<string>();
  for (const r of historyRows) {
    for (const l of r.lines) {
      const id = bagliUrunKimligi(satirBaglari, r.platform, l.name);
      if (id) bagliUrunIdleri.add(id);
    }
  }
  /** Ürün kimliği → eşleştirme değeri (elle bağlı satırlar buradan bulunur). */
  const urunlerById = new Map<string, Matched>();

  if (allKeys.size > 0 || shopifyNames.size > 0 || bagliUrunIdleri.size > 0) {
    const keyList = [...allKeys];
    const normalizedShopifyNames = new Set(
      [...shopifyNames].map(normalizeMatchKey).filter(Boolean)
    );
    const wantedKeys = new Set([...allKeys].map(normalizeMatchKey).filter(Boolean));
    // SQLite/Prisma `... IN (...)` ham büyük-küçük harf ve boşluk farklarını kaçırıyordu: ürün hiç
    // ÇEKİLMEDİĞİ için sonradan sadeleştirmek de kurtarmıyordu. Önce küçük bir ad/anahtar dizini
    // tarayıp eşleşen ürün kimliklerini çıkarıyoruz. Bu tarama her sipariş hesabında (arka plan
    // tazelemeleri dahil) tekrarlanıyordu; ürün anahtarları nadir değişir → kısa ömürlü SWR +
    // ürün PATCH'inde bust (bkz. products/[id] route).
    const catalog = await swr("order-name-index:v2", 5 * 60_000, () =>
      prisma.product.findMany({
        select: {
          id: true,
          name: true,
          barcode: true,
          sku: true,
          listings: { select: { externalId: true, externalSku: true, barcode: true } },
        },
      })
    );
    const preselectedIds = new Set<string>();
    for (const product of catalog) {
      const normalizedName = normalizeMatchKey(product.name);
      if (normalizedName && normalizedShopifyNames.has(normalizedName)) {
        preselectedIds.add(product.id);
        continue;
      }
      const productKeys = [
        product.barcode,
        product.sku,
        ...(product.listings ?? []).flatMap((listing) => [
          listing.externalId,
          listing.externalSku,
          listing.barcode,
        ]),
      ];
      if (
        productKeys.some((key) => {
          const normalized = normalizeMatchKey(key);
          return normalized !== "" && wantedKeys.has(normalized);
        })
      ) {
        preselectedIds.add(product.id);
      }
    }
    const nameMatchedIds = [...preselectedIds];
    const trendyolRows = historyRows.filter((row) => row.platform === "trendyol");
    const [products, cRules, kRules, eRules, settings, platformFinancials] =
      await Promise.all([
      prisma.product.findMany({
        where: {
          OR: [
            { barcode: { in: keyList } },
            { sku: { in: keyList } },
            { listings: { some: { externalId: { in: keyList } } } },
            { listings: { some: { externalSku: { in: keyList } } } },
            { listings: { some: { barcode: { in: keyList } } } },
            { id: { in: [...nameMatchedIds, ...bagliUrunIdleri] } },
          ],
        },
        include: { cost: { include: { filamentType: { select: { costPerGram: true } } } }, listings: true },
      }),
      prisma.commissionRule.findMany({ where: { isActive: true } }),
      prisma.cargoRule.findMany({ where: { isActive: true } }),
      prisma.expenseRule.findMany({ where: { isActive: true } }),
      prisma.appSetting.findMany(),
      prisma.platformOrderFinancial.findMany({
        // TEK sorgu, iki pazaryeri: Trendyol gerçek komisyonu + Hepsiburada gerçek kesintileri.
        where: {
          OR: [
            {
              platform: "trendyol",
              OR: [
                { externalOrderId: { in: trendyolRows.map((row) => row.id) } },
                { orderNumber: { in: trendyolRows.map((row) => row.orderNumber) } },
              ],
            },
            {
              platform: "hepsiburada",
              externalOrderId: {
                in: historyRows.filter((row) => row.platform === "hepsiburada").map((row) => row.id),
              },
            },
          ],
        },
        select: {
          platform: true,
          externalOrderId: true,
          orderNumber: true,
          grossRevenueKurus: true,
          commissionKurus: true,
          serviceFeeKurus: true,
          paymentFeeKurus: true,
          cargoKurus: true,
          returnCargoKurus: true,
          chargedDesi: true,
        },
      }),
    ]);

    settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    filamentFiyatlari = await filamentFiyatlariOku();
    commissionRules = cRules as CommissionRules;
    cargoRules = kRules as CargoRules;
    expenseRules = eRules as ExpenseRules;
    // Reklam oranı: BİR KEZ (5dk önbellekli). Sipariş başına çağrılsaydı her sipariş için
    // ayrı sorgu açılırdı — uzak Turso'da sorgular sıralı, 235 sipariş ~22 saniye ederdi.
    adSnap = await adRateSnapshot();
    for (const financial of platformFinancials) {
      financialByExternalId.set(financial.externalOrderId, financial);
      // Sipariş numarasıyla yedek eşleşme yalnız Trendyol içindir (paket kimliği eksik gelebiliyor).
      if (financial.platform !== "trendyol") continue;
      const rows = financialByOrderNumber.get(financial.orderNumber) ?? [];
      rows.push(financial);
      financialByOrderNumber.set(financial.orderNumber, rows);
    }

    // Ürün → eşleştirme değeri (maliyet + ilan kuralları); kovalar ve belirsizlik kuralı çekirdekte.
    urunIndeksi = urunIndeksiKur(products, (p) => {
      const resolved = resolveProductCost(
        p.cost,
        settingsMap,
        p.cost?.filamentType?.costPerGram ?? 0,
        filamentFiyatlari
      );
      // Listing komisyon override'ı platform bazlı taşınır (Ürünler/Panel ile AYNI kaynak).
      const listingByPlatform: Matched["listingByPlatform"] = {};
      for (const l of p.listings) {
        listingByPlatform[l.platform] = {
          platform: l.platform,
          commissionRate: l.commissionRate,
          commissionFixed: l.commissionFixed,
          cargoCost: l.cargoCost, // elle girilen kargo — Ürünler bunu kullanıyordu, Siparişler yok sayıyordu
        };
      }
      const m: Matched = {
        id: p.id,
        name: p.name,
        imageUrl: p.imageUrl,
        productionCost: resolved?.productionCost ?? 0,
        packagingCost: resolved?.packagingCost ?? 0,
        packagingComponents: resolved?.packagingBreakdown?.components ?? null,
        filamentCost: resolved?.filamentCost ?? 0,
        productionCostKnown: resolved?.productionCostKnown ?? false,
        categoryName: p.categoryName,
        desi: p.desi,
        commissionRate: p.commissionRate,
        madeToOrder: p.madeToOrder,
        stock: p.stock,
        listingByPlatform,
      };
      urunlerById.set(p.id, m);
      return m;
    });
  }

  /**
   * Sipariş satırını ürünle eşleştir. Sıra = GÜVEN sırası: ürün barkodu > ilan barkodu >
   * platform kimliği > stok kodu. En son çare, anahtarın türü platformda karışmış olabileceği
   * için tür ayrımı olmayan indekstir. Belirsiz (birden çok ürüne düşen) anahtar hiç kullanılmaz.
   */
  const matchLine = (line: RawLine, platform: string): { urun: Matched | null; elleBagli: boolean } => {
    const m = urunIndeksi ? satiriEsle(urunIndeksi, line, platform) : null;
    if (m) return { urun: m, elleBagli: false };
    // Yalnız YEDEK: satır kendi anahtarıyla eşleşmediyse elle bağa bakılır (bağ doğru eşleşmeyi ezmez).
    const bagliId = bagliUrunKimligi(satirBaglari, platform, line.name);
    const bagli = bagliId ? urunlerById.get(bagliId) ?? null : null;
    return { urun: bagli, elleBagli: Boolean(bagli) };
  };

  // NOT: Sipariş kârının TAMAMI @/core/order-profit → computeOrderProfit içinde (masaüstü + mobil
  // AYNI fonksiyon). Adet başına: ürün/paketleme/komisyon/yüzdesel gider. Siparişe BİR KEZ: kargo +
  // SABİT gider (Platform Hizmet Bedeli — kullanıcı teyidi: sipariş başına kesiliyor).

  // "Yeni sipariş" bildirimi adayları — AKSİYON bekleyen (pending/processing) siparişler.
  // Karar ve metin `lib/order-notify`'da (hızlı taramayla AYNI fonksiyon): her sipariş geldiği
  // ANDAKİ stokla tek kez bildirilir; sonradan stok değişince eski siparişe alarm doğmaz.
  const notifyOrders: NotifyOrder[] = [];

  // Sipariş kimliği → kalemleri (kalıcı ürün bazlı satış geçmişine yazılacak).
  const snapshotItemsByOrderId = new Map<string, FinanceSnapshotItem[]>();

  // SİPARİŞE ÖZEL MALİYET: kataloğa eklenmemiş / maliyeti girilmemiş ürünün yalnız o siparişteki
  // maliyeti (Siparişler → "Maliyet gir"). Hesap katalog ürünüyle AYNI çekirdekten geçer.
  const satirMaliyetleri = await satirMaliyetleriniOku(historyRows);

  // TRENDYOL GECİKME BEDELİ — geciken paketler haftalık "Termin Gecikme Bedeli" faturasıyla eşleştirilir
  // (fatura siparişe bağlı gelmiyor). Fatura geldiyse gerçek; beklenen sürede gelmediyse kesilmedi.
  const gecikmeSonuclari = gecikmeleriFaturalarlaEsle(
    historyRows.flatMap((r) => (r.platform === "trendyol" && r.gecikme ? [{ id: r.id, g: r.gecikme }] : [])),
    tyGecikmeFaturalariOku(settingsMap.tyGecikmeFaturalari),
    Date.now()
  );
  // TRENDYOL KUSURLU ÜRÜN BEDELİ — satıcı kusurlu iade, haftalık "Kusurlu Ürün Faturası"yla aynı düzende.
  const kusurluSonuclari: Map<string, TyKusurluSonucu> = kusurluIadeleriFaturalarlaEsle(
    new Map(historyRows.flatMap((r) => (r.platform === "trendyol" && r.kusurlu ? [[r.id, r.kusurlu] as const] : []))),
    tyGecikmeFaturalariOku(settingsMap.tyKusurluFaturalari),
    Date.now()
  );

  // Zenginleştirilmiş birleşik siparişler ───────────────────────────────────
  for (const r of historyRows) {
    const actionable = r.statusKind === "pending" || r.statusKind === "processing";
    const notifyLines: NotifyLine[] = [];
    let thumb: string | null = null;
    const profitLines: OrderProfitLine[] = [];
    // Ürün bazlı satış geçmişi için kalemler (kalıcı kaydedilir — pazaryeri penceresi dolsa da kalır).
    const snapshotItems: FinanceSnapshotItem[] = [];
    const items: UnifiedOrderItem[] = r.lines.map((l) => {
      const { urun: m, elleBagli } = matchLine(l, r.platform);
      const image = l.image || m?.imageUrl || null;
      if (image && !thumb) thumb = image;

      snapshotItems.push({
        productId: m?.id ?? null,
        // Elle bağlı satırda HAM ad kalır: bağ kaldırılınca geçmişteki aynı satırlar geri bulunabilsin.
        productName: elleBagli ? l.name : m?.name || l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        commissionRate: l.commissionRate ?? null,
        vatRate: l.saleVatRate ?? null,
        dispatchDays: l.dispatchDays ?? null,
      });

      // Kâr hesabı için satırı topla — hesabın tamamı aşağıda computeOrderProfit'te (tek çağrı).
      const katalog: SatirKatalogBilgisi | null = m
        ? {
            id: m.id, name: m.name, categoryName: m.categoryName,
            desi: m.desi, commissionRate: m.commissionRate,
            listing: m.listingByPlatform[r.platform] ?? null,
          }
        : null;
      // Kayıt satır eşleşmeden ÖNCE ("n:<ad>") girilmiş olabilir → ad anahtarı da denenir.
      const ozelBulunan = satirMaliyetiBul(satirMaliyetleri, r.platform, r.id, {
        productId: m?.id ?? null,
        name: l.name,
      });
      const anahtar = ozelBulunan?.anahtar ?? satirAnahtari({ productId: m?.id ?? null, name: l.name });
      const ozelKayit = ozelBulunan?.kayit;
      // Siparişe özel maliyet VARSA o kullanılır (Berke'nin kararı: yalnız o sipariş için girilen
      // rakam o siparişte geçerlidir, katalog maliyeti sonradan girilse de onu ezmez).
      const ozelUrun = ozelKayit
        ? satirMaliyetliUrun(ozelKayit, katalog, settingsMap, filamentFiyatlari)
        : null;
      profitLines.push({
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        // Siparişte kesilen oran varsa komisyon ondan hesaplanır (çekirdek önceliği uygular).
        orderCommissionRate: l.commissionRate ?? null,
        saleVatRate: l.saleVatRate ?? null,
        paymentFee: l.paymentFee ?? null,
        internationalFee: l.internationalFee ?? null,
        stoppage: l.stoppage ?? null,
        product:
          ozelUrun ??
          (m && katalog
            ? {
                ...katalog,
                productionCost: m.productionCost, packagingCost: m.packagingCost,
                packagingComponents: m.packagingComponents,
                filamentCost: m.filamentCost,
                productionCostKnown: m.productionCostKnown,
              }
            : null),
      });

      if (actionable) {
        notifyLines.push({
          name: l.name,
          quantity: l.quantity,
          product: m ? { id: m.id, name: m.name, stock: m.stock, madeToOrder: m.madeToOrder } : null,
        });
      }
      return {
        name: l.name,
        quantity: l.quantity,
        image,
        productId: m?.id ?? null,
        madeToOrder: m?.madeToOrder ?? false,
        // Çekirdekteki "kâra girmez" koşulunun aynısı (order-profit.ts).
        costMissing: ozelUrun ? !ozelUrun.productionCostKnown : !m || !m.productionCostKnown,
        // Geçici kimlikli siparişte (paket numarası henüz yok) kayıt açılmaz — kimlik değişince boşta kalırdı.
        satirAnahtari: isPersistableOrderId(r.platform, r.id) ? anahtar : undefined,
        ozelMaliyet: Boolean(ozelUrun),
        ozelMaliyetTum: Boolean(ozelUrun && ozelBulunan?.tumSiparisler),
        elleBagli,
      };
    });

    if (actionable && notifyLines.length > 0) {
      const t = r.date ? Date.parse(r.date) : NaN;
      notifyOrders.push({
        platform: r.platform,
        orderNumber: r.orderNumber,
        orderedAtMs: Number.isFinite(t) ? t : null,
        actionable: true,
        lines: notifyLines,
      });
    }

    // Kâr hesabının TAMAMI çekirdekte (masaüstü + mobil aynı fonksiyon): adet başına ürün/
    // komisyon/yüzdesel gider; siparişe BİR KEZ kargo + SABİT gider (Platform Hizmet Bedeli).
    let platformFinancial =
      r.platform === "trendyol" || r.platform === "hepsiburada"
        ? financialByExternalId.get(r.id) ?? null
        : null;
    // Kimlikler pazaryerine özgü önek taşır ama yine de başka pazaryerinin kaydı kullanılmasın.
    if (platformFinancial && platformFinancial.platform !== r.platform) platformFinancial = null;
    // Eski/eksik settlement kayıtlarında shipmentPackageId gelmeyebilir. Aynı sipariş
    // numarası hem sipariş listesinde hem finans tablosunda TEKİLSE güvenli fallback yap.
    if (
      !platformFinancial &&
      r.platform === "trendyol" &&
      trendyolOrderNumberCounts.get(r.orderNumber) === 1
    ) {
      const candidates = financialByOrderNumber.get(r.orderNumber) ?? [];
      if (candidates.length === 1) platformFinancial = candidates[0];
    }
    // Kâr hesabının TAMAMI çekirdekte (masaüstü + mobil AYNI fonksiyon) — kural-tabanlı kâr
    // + Trendyol gerçek komisyonu düzeltmesi tek yerde.
    const profitInput: OrderProfitInput = {
      platform: r.platform,
      orderTotal: r.total,
      lines: profitLines,
      commissionRules,
      cargoRules,
      expenseRules,
      settings: settingsMap,
      // Kargo kuralı siparişin KENDİ tarihine göre seçilsin: tarife değişince geçmiş
      // siparişlerin kârı yeni fiyata kaymasın.
      orderedAt: r.date ? new Date(r.date) : null,
      // Reklam payı: platformun bütçesi, siparişin KENDİ tarihindeki dönemden.
      adRate: adRateFor(adSnap, r.platform, r.date ? new Date(r.date) : null),
      // Mikro ihracat satışı KDV'den istisna → cirodan KDV ayrılmaz (Berke'nin onayı, 15 Kas 2026).
      saleVatExempt: r.microExport != null,
      // Hepsiburada hizmet bedelini her siparişe kesmiyor → kural yerine siparişin kendi durumu.
      orderFee: r.platform === "hepsiburada" ? hbHizmetBedeli(r.lines, settingsMap) : undefined,
      // Pazaryeri kargo tarifesinin fiyatı seçtiği bilgiler (firma, hızlı teslimat, süre, barem tutarı).
      kargo: r.kargo ?? null,
      // Trendyol termin gecikme + kusurlu ürün bedeli (tahmini ya da haftalık faturayla doğrulanmış).
      penalty: tyCezaToplami(gecikmeSonuclari.get(r.id)?.ceza, kusurluSonuclari.get(r.id)?.ceza),
    };
    // İADE (kargolanıp geri gelen) sipariş: ciro ve komisyon geri verildi, iki yön kargo + hizmet
    // bedeli kesildi → siparişin kârı bu zarardır. Gerçek kayıt varsa tahminin yerine geçer.
    const returnLoss = r.kargoIadesi
      ? computeReturnLoss(profitInput, {
          outboundCargo: platformFinancial?.cargoKurus == null ? null : kurusToTl(platformFinancial.cargoKurus),
          returnCargo:
            platformFinancial?.returnCargoKurus == null ? null : kurusToTl(platformFinancial.returnCargoKurus),
          // Hepsiburada hizmet bedeli muhasebe kaydından (iade edilmez); Trendyol'unki kuraldan.
          serviceFee:
            r.platform === "hepsiburada" && platformFinancial?.serviceFeeKurus != null
              ? kurusToTl(platformFinancial.serviceFeeKurus)
              : null,
        })
      : null;
    const gecikmeSonucu = gecikmeSonuclari.get(r.id) ?? null;
    const kusurluSonucu = kusurluSonuclari.get(r.id) ?? null;
    const pr = resolveOrderProfit(
      profitInput,
      {
        forceProfitPartial: Boolean(r.forceProfitPartial),
        statusKind: r.statusKind,
        financial: platformFinancial
          ? {
              actualCommission: kurusToTl(platformFinancial.commissionKurus),
              settlementRevenue: kurusToTl(platformFinancial.grossRevenueKurus),
              // Hepsiburada: hizmet bedeli, tahsilat ve kargo da gerçek kayıttan (boşsa tahmin kalır).
              actualOrderFee:
                platformFinancial.serviceFeeKurus == null ? null : kurusToTl(platformFinancial.serviceFeeKurus),
              actualPaymentFee:
                platformFinancial.paymentFeeKurus == null ? null : kurusToTl(platformFinancial.paymentFeeKurus),
              actualCargo:
                platformFinancial.cargoKurus == null ? null : kurusToTl(platformFinancial.cargoKurus),
            }
          : null,
      }
    );
    const profitPartial = pr.profitPartial;

    snapshotItemsByOrderId.set(r.id, snapshotItems);
    orders.push({
      platform: r.platform,
      id: r.id,
      orderNumber: r.orderNumber,
      date: r.date,
      statusKind: r.statusKind,
      statusLabel: r.statusLabel,
      total: r.total,
      currency: r.currency,
      customer: r.customer,
      itemCount: items.reduce((s, it) => s + it.quantity, 0),
      items,
      image: thumb,
      profit: pr.profit,
      profitPartial,
      profitSource: pr.profitSource,
      estimatedCommission: pr.estimatedCommission,
      actualCommission: pr.actualCommission,
      commissionFromOrder: pr.matchedLines > 0 && pr.orderRateLines === pr.matchedLines,
      orderCommissionRates: [
        ...new Set(
          r.lines
            .map((l) => l.commissionRate)
            .filter((oran): oran is number => typeof oran === "number" && Number.isFinite(oran))
        ),
      ],
      fixedExpense: pr.fixedExpense,
      paymentFee: pr.paymentFee,
      internationalFee: pr.internationalFee,
      stoppage: pr.stoppage,
      actualOrderFee: pr.actualOrderFee != null,
      actualPaymentFee: pr.actualPaymentFee != null,
      actualCargo: pr.actualCargo != null,
      unmatchedCount: pr.unmatchedLines,
      commissionUnknownCount: pr.commissionUnknownLines,
      missingDesiCount: pr.missingDesiLines,
      desiEstimated: pr.desiEstimated,
      cargoRuleMissing: pr.cargoRuleMissing,
      // Kargo pazaryeri tarifesinden geldiyse hangi fiyat (gerçek kargo biliniyorsa gösterilmez).
      // Kargonun kaç desiden ve nereden hesaplandığı (gerçek fatura → pazaryerinin kestiği desi).
      cargoLabel: kargoSatiriEtiketi(pr, { kesilenDesi: platformFinancial?.chargedDesi ?? null }),
      ...(r.platform === "trendyol" || r.platform === "hepsiburada" ? { cargoContext: r.kargo ?? null } : {}),
      returnLoss: returnLoss
        ? {
            loss: returnLoss.loss,
            outboundCargo: returnLoss.outboundCargo,
            returnCargo: returnLoss.returnCargo,
            serviceFee: returnLoss.serviceFee,
            inputVatCredit: returnLoss.inputVatCredit,
            outboundActual: returnLoss.outboundActual,
            returnActual: returnLoss.returnActual,
            serviceFeeActual: returnLoss.serviceFeeActual,
            penalty: returnLoss.penalty,
            cargoRuleMissing: returnLoss.cargoRuleMissing,
          }
        : null,
      penalty: pr.penalty,
      ...(r.platform === "trendyol"
        ? {
            delayInfo:
              r.gecikme && gecikmeSonucu
                ? {
                    sonGun: r.gecikme.sonGun,
                    tolerans: r.gecikme.tolerans,
                    kargolanma: r.gecikme.kargolanma,
                    gecikti: r.gecikme.gecikti,
                    kargolanmadi: r.gecikme.kargolanmadi,
                    ceza: gecikmeSonucu.ceza,
                    durum: gecikmeSonucu.durum,
                  }
                : null,
            // Kusurlu ürün bedeli — yalnız ekranda (kayıtlı ceza toplamın içinde).
            defectInfo:
              r.kusurlu && kusurluSonucu
                ? { sebep: r.kusurlu.sebep, adet: r.kusurlu.adet, ceza: kusurluSonucu.ceza, durum: kusurluSonucu.durum }
                : null,
          }
        : {}),
      // FAZLA DESİ — pazaryeri ürünün desisinden büyük desiyle kesti ve bu fiyatı artırdı → itiraz edilebilir.
      excessDesi: fazlaDesiBul({
        kesilenDesi: platformFinancial?.chargedDesi ?? null,
        bizimDesi: pr.cargoDetail?.desi ?? null,
        gercekKargo: pr.actualCargo,
        tahminiKargo: pr.estimatedCargoCost,
      }),
      adCost: pr.adCost,
      cargoCost: pr.cargoCost,
      productAndPackagingCost: pr.productAndPackagingCost,
      orderRevenueAdjustment: pr.orderRevenueAdjustment,
      // KDV motorun çıktısından aynen taşınır — snapshot'a yazılıp aylık özete girer.
      outputVat: pr.outputVat,
      inputVatCredit: pr.inputVatCredit,
      // Kargo faturası gibi komisyondan sonra gelen gerçek kesinti → kayıtlı kâr yenilensin.
      actualFees: gercekKesintiToplami(pr),
      trackingNumber: r.trackingNumber,
      cargoProvider: r.cargoProvider,
      packageNumber: r.packageNumber ?? null,
      // Trendyol'da null ya da ülke; diğer platformlarda undefined (özet kaydı korunur).
      ...(r.platform === "trendyol" ? { microExport: r.microExport ?? null } : {}),
      dataIncomplete: r.dataIncomplete,
      statusUnknown: r.statusUnknown,
      returnedLineCount: r.returnedLineCount,
    });
  }

  // Manuel siparişler kendi kalıcı finans snapshot'larını aynı ManualOrder satırında taşır.
  // Platform siparişlerinin canlı hesap hattına veya OrderFinanceSnapshot'a sokulmazlar.
  //
  // 🔴 TEK BOZUK KAYIT HER ŞEYİ ÇÖPE ATIYORDU: bu okuma hata verdiğinde (bağlantı düştü ya da
  // tek bir kaydın JSON'u bozuk) tüm hesap patlıyor, üç pazaryerinden 1-3 saniyede yeni çekilmiş
  // BÜTÜN veri kayboluyordu. Artık manuel kaynak atlanır, siparişler listelenmeye devam eder ve
  // kullanıcıya kısa bir uyarı taşınır.
  const manualRead = await manualOrdersPromise;
  const manualOrders = manualRead.rows;
  if (manualRead.error) {
    console.error("[manual-order] liste okunamadı:", manualRead.error);
    manualSource = { ok: false, count: 0, error: manualRead.error };
  }
  /** Kaydı bozuk olduğu için listeye alınamayan manuel sipariş sayısı. */
  let manualSkipped = 0;
  for (const manual of manualOrders) {
    try {
      const storedItems = parseManualOrderItems(manual.itemsJson).items;
      const storedBreakdown = parseManualOrderBreakdown(
        manual.breakdownJson
      ).breakdown;
      const items: UnifiedOrderItem[] = storedItems.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        image: item.imageUrl,
        productId: item.productId,
        madeToOrder: false,
      }));
      const image =
        storedItems.length === 1 ? storedItems[0]?.imageUrl ?? null : null;
      orders.push({
        platform: "manual",
        id: manual.id,
        orderNumber: manual.orderNumber,
        date: manual.orderedAt.toISOString(),
        statusKind: manualStatus(manual.statusKind).kind,
        statusLabel: manualStatus(manual.statusKind).label,
        total: kurusToTl(manual.revenueKurus),
        currency: manual.currency,
        customer: manual.customerName,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        items,
        image,
        profit:
          manual.profitKurus == null
            ? null
            : kurusToTl(manual.profitKurus),
        profitPartial: manual.profitPartial,
        profitSource: "manual",
        estimatedCommission: storedBreakdown.commissionCost,
        actualCommission: null,
        unmatchedCount: storedBreakdown.missingCostItems,
        missingDesiCount: 0,
        desiEstimated: false,
        cargoRuleMissing: false,
        adCost: 0,
        cargoCost: 0,
        productAndPackagingCost: 0,
        orderRevenueAdjustment: 0,
        trackingNumber: null,
        cargoProvider: null,
        isManual: true,
        manualOrderId: manual.id,
        editHref: `/api/manual-orders/${manual.id}`,
      });
    } catch (error) {
      manualSkipped += 1;
      console.error(
        `[manual-order] ${manual.id} okunamadı:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  if (manualSource.ok) {
    manualSource = {
      ok: true,
      count: manualOrders.length - manualSkipped,
      incompleteCount: manualSkipped,
    };
  }

  // Yeni siparişleri bildir — fire-and-forget (siparişler yanıtını YAVAŞLATMAZ / BOZMAZ).
  // Hızlı tarama çoğunlukla önce görür; bu yol onun kaçırdıklarının (ör. bilgisayar kapalıyken
  // gelenler) yedeğidir. Aynı sipariş iki yoldan iki kez bildirilmez (bkz. lib/order-notify).
  if (notifyOrders.length > 0) void notifyNewOrders(notifyOrders);

  // En yeni üstte. Tarihi olmayan/okunamayan sipariş EN ALTA düşer (0), yukarı sızmaz.
  // Geçersiz tarih NaN üretip karşılaştırmayı bozuyordu; eşit zaman damgalarında ikincil
  // ölçüt olmadığı için de sıra her yenilemede oynayabiliyordu — ikisi de kapatıldı.
  const zaman = (d: string | null): number => {
    if (!d) return 0;
    const t = new Date(d).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  orders.sort((a, b) => {
    const fark = zaman(b.date) - zaman(a.date);
    if (fark !== 0) return fark;
    // Aynı saniyeye düşen siparişlerde sabit sıra: numara (yoksa kimlik).
    return (b.orderNumber || b.id).localeCompare(a.orderNumber || a.id, "tr-TR");
  });

  // Canlı 30 günlük pencereyi kalıcı finans geçmişine işle. Bu kayıtlar sonraki aylarda
  // platform API'sinin penceresinden çıksa da raporların geçmişini korur. Finans geçmişi
  // yazılamazsa sipariş ekranını bozmayız; sonraki senkron yeniden dener.
  let financeHistory: {
    ok: boolean;
    syncedOrders: number;
    syncDays: number;
    /** Yazım şu an arka planda sürüyor mu (sonuç bir sonraki yenilemede kesinleşir). */
    pending?: boolean;
    error?: string;
  };
  // Bilgisi eksik gelen sipariş finans geçmişine YAZILMAZ: ₺0 ciro/kâr olarak kaydedilirse
  // sonraki aylarda düzeltilemeyen sahte bir satır kalır. Bir önceki turda doğru yazılmış
  // kayıt varsa olduğu gibi korunur; bilgi tamamlandığında normal akışta güncellenir.
  //
  // İKİ İSTİSNA:
  //  • İPTAL/İADE: tutarı okunamasa bile "bu sipariş iptal/iade" bilgisi yazılır — yoksa
  //    kalıcı kayıt "satıldı"da kalır ve iade sonsuza kadar ciro sayılır (raporlar iptalleri
  //    tutarına bakmadan eler, o yüzden eksik tutar zarar vermez).
  //  • DURUMU TANINMAYAN sipariş hiç yazılmaz: satış mı iade mi bilmiyoruz.
  const persistableOrders = orders.filter(
    (order) =>
      !order.statusUnknown &&
      (!order.dataIncomplete || order.statusKind === "cancelled") &&
      // İade bilgisi okunamadıysa Trendyol bu tur YAZILMAZ: iade edilmiş paket "teslim" diye
      // geçmişe girip Raporlar'da ciro salınıyordu (sonraki başarılı turda geri dönüyordu).
      !(order.platform === "trendyol" && trendyol.iadeBilinmiyor)
  );
  try {
    // Finans geçmişi yazımı YANIT YOLUNDA DEĞİL: ilk dolumda veya toplu statü değişiminde
    // yüzlerce satır yazılıyor ve uzak-HTTP tek mutex'inde uygulama yarım dakika kilitleniyordu.
    // "Ateşle ve unut" — çağıran beklemez, hata fırlatmaz, aynı anda tek tur çalışır.
    scheduleOrderFinanceSnapshots(persistableOrders, snapshotItemsByOrderId);
    // Yazım bitince finans önbelleğini düşür → yeni sipariş "Ciro (bu ay)" ve "Net kâr (bu ay)"
    // kartlarına AYNI görüntülemede yansısın (eskiden sayfadan çıkıp girmek gerekiyordu).
    // Beklemiyoruz: yanıt anında gider, düşürme yazım tamamlanınca arkada olur. Hiçbir şey
    // yazılmadıysa (turların çoğu) önbellek KORUNUR — ayrıntı: lib/cache-busting.ts.
    void bustFinanceCachesAfterOrderSnapshots();
    // 🔴 UYARI HİÇ ÇIKAMIYORDU: yazım arka plana alındığından bu blok her zaman "başarılı"
    // diyordu ve "Finans geçmişi kaydedilemedi" uyarısı hiçbir koşulda görünmüyordu. Artık
    // SON TAMAMLANAN turun gerçek sonucu taşınır (yazım sürüyorsa "pending").
    const lastWrite = lastOrderFinanceSnapshotWrite();
    financeHistory = {
      ok: lastWrite?.ok ?? true,
      syncedOrders: persistableOrders.filter(
        (order) => order.platform !== "manual" && Boolean(order.date)
      ).length,
      syncDays: HISTORY_SYNC_DAYS,
      pending: orderFinanceSnapshotWriteInFlight(),
      ...(lastWrite && !lastWrite.ok
        ? { error: lastWrite.error ?? "Sipariş finans geçmişi kaydedilemedi." }
        : {}),
    };
  } catch (error) {
    console.error("[finance-snapshot] Sipariş finans geçmişi yazılamadı:", error);
    financeHistory = {
      ok: false,
      syncedOrders: 0,
      syncDays: HISTORY_SYNC_DAYS,
      error:
        error instanceof Error
          ? error.message
          : "Sipariş finans geçmişi kaydedilemedi.",
    };
  }

  const tarihMs = (order: { date: string | null }) =>
    order.date ? new Date(order.date).getTime() : null;
  // Son 30 gün + işi bitmemiş elle eklenen siparişler (tarihine bakılmadan — core/order-window).
  const pencereDisi = (order: { date: string | null }) => {
    const ms = tarihMs(order);
    return ms != null && !(ms >= cutoff);
  };
  // ÖZET DÖNEMİ = BU AY (Türkiye saatiyle ayın 1'i 00:00'dan bugüne) — Raporlar ve Panel'le aynı
  // dönem (Berke'nin kararı, 23 Kas 2026: ekranlar farklı dönem gösterince net kâr her yerde başka
  // görünüyordu). Liste yine son 30 günü gösterir.
  const ozetBas = monthlyFinanceWindowStart(1, new Date(), FINANCE_TIME_ZONE).getTime();
  const oncekiAy = (order: { date: string | null }) => {
    const ms = tarihMs(order);
    return ms != null && ms < ozetBas;
  };
  const visibleOrders = orders
    .filter((order) =>
      siparisListedeKalir(
        { platform: order.platform, statusKind: order.statusKind, tarihMs: tarihMs(order) },
        cutoff
      )
    )
    .map((order) => (pencereDisi(order) ? { ...order, outsideWindow: true } : order))
    .map((order) => (oncekiAy(order) ? { ...order, previousMonth: true } : order));
  // Özet listeden DEĞİL çekilen tüm siparişlerden sayılır: 31 çeken ayın son gününde ayın 1'i
  // 30 günlük liste penceresinin birkaç saat dışına düşebiliyor.
  const ozetSiparisleri = orders.filter((order) => !oncekiAy(order));

  /**
   * KAYITLI KÂR — Panel ve Raporlar'ın kullandığı değer (finans geçmişi, siparişin kârı ilk tam
   * hesapta sabitlenir). Özet bunu kullanır: canlı hesap güncel maliyetle yapıldığı için ay içinde
   * maliyet değişince üç ekran farklı kâr gösteriyordu (Berke onayı, 23 Kas 2026). Kaydı olmayan ya
   * da kârı bilinmeyen sipariş canlı hesaptan sayılır. Satırlar canlı kalır (dökümle tutarlı).
   */
  const kayitliOzet = new Map<string, { profit: number | null; partial: boolean; status: string }>();
  try {
    const satirlar = await remotePrisma.$queryRawUnsafe<
      Array<{ platform: string; externalOrderId: string; profitKurus: number | bigint | null; profitPartial: unknown; statusKind: string }>
    >(
      `SELECT "platform","externalOrderId","profitKurus","profitPartial","statusKind"
         FROM "OrderFinanceSnapshot"
        WHERE "platform" <> 'manual' AND ${dbEpochMs("orderedAt")} >= ?`,
      ozetBas
    );
    for (const r of satirlar) {
      kayitliOzet.set(JSON.stringify([String(r.platform), String(r.externalOrderId)]), {
        profit: r.profitKurus == null ? null : Number(r.profitKurus) / 100,
        partial: Boolean(Number(r.profitPartial ?? 0)),
        status: String(r.statusKind),
      });
    }
  } catch {
    /* okunamazsa özet canlı hesaba düşer — eski davranış */
  }
  const kayitliOf = (o: { platform: string; id: string }) =>
    o.platform === "manual"
      ? undefined
      : kayitliOzet.get(JSON.stringify([o.platform, siparisKimligi(o.platform, o.id)]));

  // Dashboard özeti (iptal/iade hariç) ──────────────────────────────────────
  const empty = (): SummaryBucket => ({ revenue: 0, profit: 0, orderCount: 0, incompleteOrders: 0 });
  const sShopify = empty();
  const sTrendyol = empty();
  const sHepsiburada = empty();
  const sManual = empty();
  const unsupportedCurrencies = new Map<string, number>();
  const unknownStatuses = new Map<string, number>();
  let incompleteDataOrders = 0;
  let partialReturnOrders = 0;
  let returnLossOrders = 0;
  let returnLossTotal = 0;
  const bucketOf = (platform: string): SummaryBucket =>
    platform === "shopify"
      ? sShopify
      : platform === "trendyol"
        ? sTrendyol
        : platform === "hepsiburada"
          ? sHepsiburada
          : sManual;
  for (const o of ozetSiparisleri) {
    // Özet YALNIZ bu ay verilen siparişleri sayar; listede kalan eski açık elle sipariş kendi
    // ayının cirosunda zaten sayıldı.
    if (oncekiAy(o)) continue;
    const kayit = kayitliOf(o);
    // İade bilgisi okunamayan turda geçmişte İPTAL/İADE olarak kayıtlı Trendyol siparişi satış sayılmaz.
    if (o.platform === "trendyol" && trendyol.iadeBilinmiyor && kayit?.status === "cancelled" && o.statusKind !== "cancelled") {
      continue;
    }
    if (o.statusKind === "cancelled") {
      // İADE edilen siparişin kargo zararı: ciroya ve sipariş sayısına girmez, kârdan DÜŞER.
      if (o.returnLoss && !o.dataIncomplete && normalizedCurrency(o.currency) === "TRY") {
        bucketOf(o.platform).profit -= o.returnLoss.loss;
        returnLossOrders += 1;
        returnLossTotal += o.returnLoss.loss;
      }
      continue;
    }
    // Kalem/tutar bilgisi alınamamış sipariş toplamlara ₺0 ekler ve ciroyu olduğundan düşük,
    // sipariş sayısını olduğundan yüksek gösterir. Listede kalır, özet dışında tutulur.
    if (o.dataIncomplete) {
      incompleteDataOrders += 1;
      continue;
    }
    // Durumu tanımadığımız sipariş satış da olabilir iade de. Toplama eklemek "iade sayıldı"
    // riskini sessizce taşıyordu; artık ayrı sayılır ve ekranda ham durum adıyla görünür.
    if (o.statusUnknown) {
      unknownStatuses.set(o.statusLabel, (unknownStatuses.get(o.statusLabel) ?? 0) + 1);
      continue;
    }
    if ((o.returnedLineCount ?? 0) > 0) partialReturnOrders += 1;
    const currency = normalizedCurrency(o.currency);
    // Farklı para birimlerini kur dönüşümü olmadan TL toplamına eklemek yanlış sonuç üretir.
    // Sipariş listede kendi para birimiyle kalır; yalnızca 30 günlük TL özeti dışında tutulur.
    if (currency !== "TRY") {
      unsupportedCurrencies.set(currency, (unsupportedCurrencies.get(currency) ?? 0) + 1);
      continue;
    }
    const bucket = bucketOf(o.platform);
    bucket.revenue += o.total;
    // Kayıtlı kâr varsa O (Panel/Raporlar ile aynı); yoksa canlı hesap.
    const ozetKar = kayit && kayit.profit != null ? kayit.profit : o.profit;
    const ozetKismi = kayit && kayit.profit != null ? kayit.partial : o.profitPartial;
    bucket.profit += ozetKar ?? 0;
    bucket.orderCount += 1;
    // Maliyeti girilmemiş ürün içeren sipariş → toplam kâr EKSİK; UI uyarı gösterir.
    if (ozetKar == null || ozetKismi) bucket.incompleteOrders += 1;
  }
  const total: SummaryBucket = {
    revenue:
      sShopify.revenue +
      sTrendyol.revenue +
      sHepsiburada.revenue +
      sManual.revenue,
    profit:
      sShopify.profit +
      sTrendyol.profit +
      sHepsiburada.profit +
      sManual.profit,
    orderCount:
      sShopify.orderCount +
      sTrendyol.orderCount +
      sHepsiburada.orderCount +
      sManual.orderCount,
    incompleteOrders:
      sShopify.incompleteOrders +
      sTrendyol.incompleteOrders +
      sHepsiburada.incompleteOrders +
      sManual.incompleteOrders,
  };
  // Verisi ALINAMAYAN kaynaklar. "Kurulu değil" bu listeye girmez — o bir eksiklik değil,
  // kullanıcının tercihi. Toplamların yanındaki "eksik veri" işareti bundan üretilir.
  const missingSources = (
    [
      [shopify, "Shopify"],
      [trendyol, "Trendyol"],
      [hepsiburada, "Hepsiburada"],
      [manualSource, "Manuel siparişler"],
    ] as Array<[PlatformStatus, string]>
  )
    .filter(([status]) => !status.ok && !status.notConfigured)
    .map(([, label]) => label);

  const quality: SummaryQuality = {
    unsupportedCurrencyOrders: [...unsupportedCurrencies.values()].reduce(
      (sum, count) => sum + count,
      0
    ),
    unsupportedCurrencies: [...unsupportedCurrencies.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, orderCount]) => ({ currency, orderCount })),
    incompleteDataOrders,
    unknownStatusOrders: [...unknownStatuses.values()].reduce((sum, count) => sum + count, 0),
    unknownStatuses: [...unknownStatuses.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, orderCount]) => ({ status, orderCount })),
    partialReturnOrders,
    returnLossOrders,
    returnLossTotal,
    missingSources,
  };

  return {
    // 🔴 EKSİK SONUÇ DAMGALANIR: bu gövde önbelleğe VE diske yazılıyor. Damga olmadan bir
    // pazaryeri alınamamışken hesaplanan yarım ciro, sonraki açılışta "tam" sanılıyordu.
    dataComplete: missingSources.length === 0,
    // Bu verinin hesaplandığı an — arayüz "X dakika önce güncellendi" bilgisini bundan üretir
    // (önbellekten dönen yanıt da kendi hesap zamanını taşır).
    // Ham çekim yeniden kullanıldıysa verinin GERÇEK yaşı o çekimin zamanıdır.
    computedAt: new Date(hazirHam?.at ?? Date.now()).toISOString(),
    orders: visibleOrders,
    summary: {
      days: WINDOW_DAYS,
      // ÖZET DÖNEMİNİN İLK anı (bu ayın 1'i) — Panel'in net kârı giderleri AYNI andan itibaren düşer.
      from: new Date(ozetBas).toISOString(),
      // Özet dönemi: "month" = bu ay (eski gövdede yok → istemci 30 günlük başlığı gösterir).
      period: "month" as const,
      shopify: sShopify,
      trendyol: sTrendyol,
      hepsiburada: sHepsiburada,
      manual: sManual,
      total,
      quality,
    },
    shopify,
    trendyol,
    hepsiburada,
    manual: manualSource,
    financeHistory,
  };
}
