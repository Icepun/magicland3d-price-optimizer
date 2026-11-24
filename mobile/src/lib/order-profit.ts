import { reklamOraniIcin } from "@core/ad-cost";
import { resolveProductCost } from "@core/product-cost";
import { satiriEsle, urunIndeksiKur, type UrunIndeksi } from "@core/order-match";
import {
  computeReturnLoss,
  kargoSatiriEtiketi,
  resolveOrderProfit,
  type OrderProfitInput,
  type OrderProfitLine,
  type ReturnLoss,
} from "@core/order-profit";
import { fazlaDesiBul, type FazlaDesi } from "@core/kargo-denetim";
import { kargoluIadeMi } from "@core/siparis-kargo";
import { hbHizmetBedeli } from "@core/hb-kesinti";
import { tyCezaToplami } from "@core/trendyol-kusurlu";
import { satirMaliyetiBul, satirMaliyetliUrun, type SatirMaliyetKaydi } from "@core/order-line-cost";
import { bagliUrunKimligi, type SatirBaglari } from "@core/order-line-link";

import type { ProductDetail } from "@/lib/db/product-detail";
import { kuralFilamentFiyatlari, type Rules, type TelefonFinansKaydi } from "@/lib/profit";
import { isCancelledOrder, type UnifiedOrder } from "@/lib/api/orders";

export interface MatchedProduct {
  imageUrl: string | null;
  name: string;
  detail: ProductDetail;
}

export interface ProductMap {
  byId: Map<string, ProductDetail>;
  /**
   * Eşleştirme indeksi — masaüstü Siparişler ucuyla AYNI kural (`@core/order-match`): anahtar
   * türüne göre güven sırası, belirsiz (birden çok ürüne düşen) anahtar hiç kullanılmaz, anahtar
   * biçimi tek (boşluk/büyük-küçük/Türkçe I). Eski mobil kopya tek haritada "ilk gelen kazanır"
   * diyordu; belirsiz bir barkod yanlış ürünün maliyetiyle kâr hesaplatabilirdi.
   */
  indeks: UrunIndeksi<ProductDetail>;
}

/** Ürün dizisi kimliğine göre harita önbelleği: aynı react-query dizi referansı için harita BİR KEZ
 *  kurulur (Panel + Siparişler + Raporlar + detay aynı ["match-products"] dizisini paylaşır —
 *  eskiden her ekran 424 ürün × ~5 Map insert'i ayrı ayrı tekrarlıyordu). */
const pmCache = new WeakMap<ProductDetail[], ProductMap>();
export function getProductMap(products: ProductDetail[]): ProductMap {
  let pm = pmCache.get(products);
  if (!pm) {
    pm = buildProductMap(products);
    pmCache.set(products, pm);
  }
  return pm;
}

/** Çok-anahtarlı ürün indeksi: Product.barcode/sku + Listing.barcode/externalId/externalSku + ad. */
export function buildProductMap(products: ProductDetail[]): ProductMap {
  const byId = new Map<string, ProductDetail>();
  for (const p of products) byId.set(p.id, p);
  return { byId, indeks: urunIndeksiKur(products, (p) => p) };
}

/** Kurallardaki elle ürün bağları (eski önbellek kaydında olmayabilir → güvenli okuma). */
export function kuralSatirBaglari(rules: Rules | null | undefined): SatirBaglari | null {
  return rules?.satirBaglari instanceof Map ? rules.satirBaglari : null;
}

/** Satır eşleştirme — computeOrderProfit ile AYNI mantık. Sipariş detay ekranı da bunu kullansın
 *  ki "kâr hesaplandı ama satır eşleşmedi" çelişkisi olmasın. `baglar`: elle ürün bağları —
 *  yalnız satır kendi anahtarıyla eşleşmezse bakılır (masaüstüyle aynı kural). */
export function matchOrderLine(
  line: {
    productId?: string | null;
    name: string;
    matchKeys?: string[];
    barcodes?: string[];
    externalIds?: string[];
    skus?: string[];
  },
  platform: UnifiedOrder["platform"],
  pm: ProductMap,
  baglar?: SatirBaglari | null
): ProductDetail | undefined {
  const p = line.productId ? pm.byId.get(line.productId) : undefined;
  if (p) return p;
  // Türlü anahtar yoksa (eski önbellek kaydı) birleşik liste son çare türsüz aramaya girer.
  const turlu = !!(line.barcodes || line.externalIds || line.skus);
  const eslesen = satiriEsle(
    pm.indeks,
    {
      name: line.name,
      barcodes: line.barcodes ?? [],
      externalIds: line.externalIds ?? [],
      skus: turlu ? (line.skus ?? []) : (line.matchKeys ?? []),
    },
    platform
  );
  if (eslesen) return eslesen;
  const bagliId = bagliUrunKimligi(baglar, platform, line.name);
  return bagliId ? pm.byId.get(bagliId) : undefined;
}

/**
 * Bu satıra masaüstünden "siparişe özel maliyet" girilmiş mi? (Masaüstü Siparişler → "Maliyet gir")
 * Satır anahtarı masaüstüyle AYNI: eşleşen üründe ürün kimliği, eşleşmeyende satır adı (kayıt satır
 * eşleşmeden önce girildiyse ad anahtarı da denenir — `satirMaliyetiBul`).
 */
export function ozelMaliyetKaydi(
  order: Pick<UnifiedOrder, "platform" | "id">,
  line: { name: string },
  eslesen: ProductDetail | undefined,
  rules: Rules
): SatirMaliyetKaydi | null {
  const harita = rules.satirMaliyetleri instanceof Map ? rules.satirMaliyetleri : null;
  if (!harita || harita.size === 0 || order.platform === "manual") return null;
  return satirMaliyetiBul(harita, order.platform, order.id, { productId: eslesen?.id ?? null, name: line.name })?.kayit ?? null;
}

export interface OrderProfit {
  revenue: number;
  profit: number | null; // null = hiç eşleşme/maliyet yok
  partial: boolean; // bazı satırlar eşleşmedi
  /** "platform" = Trendyol GERÇEK komisyonuyla düzeltildi (masaüstüyle aynı kaynak). */
  profitSource: "calculated" | "platform";
  /** Uygulanan gerçek komisyon; uygulanmadıysa null. */
  actualCommission: number | null;
  /** Kuraldan hesaplanan brüt komisyon (snapshot yazımı için). */
  estimatedCommission: number;
  /** kapak görseli: tek farklı ürün varsa onun fotosu */
  image: string | null;
  distinctCount: number; // farklı ürün sayısı
  totalQty: number; // toplam adet
  /** Maliyeti bilinmeyen satırların cirosu — kâra girmedi (uyarı için). */
  unmatchedRevenue: number;
  /** Komisyonu bilinmediği için kâra girmeyen satır sayısı (masaüstüyle aynı çekirdek kuralı). */
  commissionUnknownCount: number;
  missingDesiCount: number;
  desiEstimated: boolean;
  orderRevenueAdjustment: number;
  /**
   * İade edilen (kargolanıp geri gelen) siparişin zararı — net TL, pozitif. Ciroya girmez ama kâr
   * toplamından DÜŞÜLÜR (masaüstü Siparişler/Raporlar ile aynı kural). Değilse null.
   */
  returnLoss: number | null;
  /** Kalem kalem kesintiler — masaüstü Siparişler'deki "Kargo & Kâr" dökümüyle AYNI kalemler. */
  dokum: SiparisDokumu | null;
}

/**
 * SİPARİŞ DÖKÜMÜ — masaüstü Siparişler satırının "Kargo & Kâr" kutusundaki kalemlerin aynısı
 * (brüt TL). Rakamlar AYNI çekirdek hesabından (resolveOrderProfit) gelir; burada yeni formül yok.
 */
export interface SiparisDokumu {
  /** Gerçek komisyon varsa o, yoksa tahmini. */
  komisyon: number;
  komisyonKaynagi: "gercek" | "siparis" | "tahmini";
  /** Siparişte kesilen oranlar (kesir). */
  komisyonOranlari: number[];
  /** Tahmini komisyon yalnız maliyeti bilinen ürünler için (kısmi sipariş). */
  komisyonEksik: boolean;
  /** Gerçek komisyon geldiyse tahminle farkı göstermek için. */
  komisyonTahmini: number;
  urunVePaketleme: number;
  kargo: number;
  kargoGercek: boolean;
  /** Tarifeden tahmin edildiyse hangi fiyat ("Trendyol Express · sabit fiyat"). */
  kargoEtiketi: string | null;
  kargoKuralYok: boolean;
  fazlaDesi: FazlaDesi | null;
  gecikmeBedeli: number;
  gecikmeGercek: boolean;
  /** Geç kargolandı ama bedel kesilmedi. */
  gecikmeKesilmedi: boolean;
  kusurluBedeli: number;
  kusurluGercek: boolean;
  hizmetBedeli: number;
  hizmetGercek: boolean;
  tahsilatBedeli: number;
  tahsilatGercek: boolean;
  uluslararasiBedel: number;
  /** Bilgi — kâra girmez. */
  stopaj: number;
  reklamPayi: number;
  /** Kargo geliri (+) / sipariş indirimi (−). */
  kargoGeliri: number;
  /** Kargolanıp geri gelen siparişin zarar kalemleri; değilse null. */
  iade: ReturnLoss | null;
}

export function computeOrderProfit(
  order: UnifiedOrder,
  pm: ProductMap,
  rules: Rules,
  settings: Record<string, string>
): OrderProfit {
  if (order.isManual) {
    const totalQty = order.items.reduce((sum, line) => sum + line.quantity, 0);
    const onlyLine = order.items.length === 1 ? order.items[0] : null;
    const matched = onlyLine ? matchOrderLine(onlyLine, order.platform, pm) : undefined;
    return {
      revenue: order.total,
      profit: order.profit ?? null,
      partial: Boolean(order.profitPartial),
      // Manuel siparişin kârı ManualOrder satırında saklıdır; pazaryeri komisyonu yok.
      profitSource: "calculated",
      actualCommission: null,
      estimatedCommission: 0,
      image: onlyLine?.image ?? matched?.imageUrl ?? null,
      distinctCount: order.items.length,
      totalQty,
      unmatchedRevenue: order.profit == null ? order.total : 0,
      commissionUnknownCount: 0,
      missingDesiCount: 0,
      desiEstimated: false,
      orderRevenueAdjustment: 0,
      returnLoss: null,
      dokum: null,
    };
  }

  // Kâr hesabının TAMAMI @core/order-profit'te — masaüstü /api/orders ile AYNI fonksiyon.
  // (Eski mobil kopya: listing komisyonunu uygulamıyordu + sabit gideri adet başına tekrar
  //  kesiyordu → telefondaki kârlar masaüstünden şişik çıkıyordu.)
  let image: string | null = null;
  const fiyatlar = kuralFilamentFiyatlari(rules);
  const baglar = kuralSatirBaglari(rules);
  const lines: OrderProfitLine[] = order.items.map((line) => {
    const p = matchOrderLine(line, order.platform, pm, baglar);
    if (p && !image) image = p.imageUrl;
    // Siparişe özel maliyet varsa o kullanılır (masaüstüyle aynı kural ve aynı motor).
    const ozel = ozelMaliyetKaydi(order, line, p, rules);
    const ozelUrun = ozel
      ? satirMaliyetliUrun(
          ozel,
          p
            ? {
                id: p.id,
                name: p.name,
                categoryName: p.categoryName,
                desi: p.desi,
                commissionRate: p.commissionRate,
                listing: p.listings.find((l) => l.platform === order.platform) ?? null,
              }
            : null,
          settings,
          fiyatlar
        )
      : null;
    // Siparişte kesilen oran varsa komisyon ondan hesaplanır (öncelik çekirdekte — masaüstüyle aynı).
    const satirEk = {
      orderCommissionRate: line.commissionRate ?? null,
      saleVatRate: line.saleVatRate ?? null,
      paymentFee: line.paymentFee ?? null,
      internationalFee: line.internationalFee ?? null,
      stoppage: line.stoppage ?? null,
    };
    if (ozelUrun) {
      return { unitPrice: line.unitPrice, quantity: line.quantity, product: ozelUrun, ...satirEk };
    }
    const resolved = p
      ? resolveProductCost(
          p.cost ? { ...p.cost, tapeUsed: !!p.cost.tapeUsed } : null,
          settings,
          p.cost?.costPerGram ?? 0,
          fiyatlar
        )
      : null;
    return {
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      ...satirEk,
      product:
        p && resolved
          ? {
              id: p.id,
              name: p.name,
              categoryName: p.categoryName,
              desi: p.desi,
              commissionRate: p.commissionRate,
              productionCost: resolved.productionCost,
              packagingCost: resolved.packagingCost,
              packagingComponents: resolved.packagingBreakdown?.components ?? null,
              filamentCost: resolved.filamentCost,
              productionCostKnown: resolved.productionCostKnown,
              listing: p.listings.find((l) => l.platform === order.platform) ?? null,
            }
          : null,
    };
  });

  // Trendyol GERÇEK komisyonu (settlement) — masaüstüyle AYNI iki anahtar: önce dış sipariş
  // kimliği, olmazsa sipariş numarası TEKİLSE fallback. Yoksa kural-tabanlı kâr aynen kalır.
  //
  // ⚠️ `?.` YETMİYOR, `instanceof Map` ŞART. Bu iki alan birer `Map`; kurallar bir tur
  // çevrimdışı önbelleğe yazıldı ve `JSON.stringify(new Map())` → `{}` olduğu için geri
  // yüklendiğinde DÜZ NESNE oldu. `{}` truthy olduğundan `?.` devreye girmedi ve
  // ".get is not a function" fırladı — Panel ilk render'da patlıyor, UYGULAMA HİÇ AÇILMIYORDU.
  // Kurallar artık diske yazılmıyor; bu kontrol ikinci savunma: en kötü ihtimalle Trendyol'un
  // gerçek komisyonu o tur kullanılamaz, uygulama çalışmaya devam eder.
  const disKimlikHaritasi =
    rules.financialByExternalId instanceof Map ? rules.financialByExternalId : null;
  const siparisNoHaritasi =
    rules.financialByOrderNumber instanceof Map ? rules.financialByOrderNumber : null;

  // Hepsiburada kaydı sipariş kimliğiyle (`hb-<no>`) birebir eşleşir; önekler pazaryerine özgü
  // olduğu için başka pazaryerinin kaydına düşmez.
  let financial =
    order.platform === "trendyol" || order.platform === "hepsiburada"
      ? disKimlikHaritasi?.get(order.id) ?? null
      : null;
  if (!financial && order.platform === "trendyol") {
    const candidates = siparisNoHaritasi?.get(order.orderNumber) ?? [];
    if (candidates.length === 1) financial = candidates[0];
  }

  const profitInput: OrderProfitInput = {
      platform: order.platform,
      orderTotal: order.total,
      lines,
      commissionRules: rules.commission,
      cargoRules: rules.cargo,
      expenseRules: rules.expense,
      settings,
      // Kargo kuralı siparişin KENDİ tarihine göre — masaüstüyle aynı. Geçilmezse tarife
      // değiştiği anda telefon geçmiş siparişleri yeni fiyatla gösterirdi.
      orderedAt: order.date != null ? new Date(order.date) : null,
      // Reklam payı — masaüstüyle AYNI çekirdek fonksiyonundan.
      adRate: reklamOraniIcin(
        rules.adBudgets ?? [],
        order.platform,
        order.date != null ? new Date(order.date).getTime() : Date.now()
      ),
      // Mikro ihracat satışı KDV'den istisna — masaüstüyle aynı kural.
      saleVatExempt: order.microExport != null,
      // Hepsiburada hizmet bedelini her siparişe kesmiyor — masaüstüyle AYNI çekirdek kuralı.
      orderFee: order.platform === "hepsiburada" ? hbHizmetBedeli(order.items, settings) : undefined,
      // Pazaryeri kargo tarifesinin fiyat seçtiği bilgiler — masaüstüyle aynı çekirdek.
      kargo: order.kargo ?? null,
      // Trendyol termin gecikme + kusurlu ürün bedeli (haftalık faturayla eşleşmiş) — masaüstüyle aynı.
      penalty: tyCezaToplami(order.gecikmeSonucu?.ceza, order.kusurluSonucu?.ceza),
  };
  const r = resolveOrderProfit(
    profitInput,
    {
      forceProfitPartial: !!order.financialPartial,
      // İptal siparişe gerçek komisyon uygulanmaz (masaüstü statusKind==='cancelled' ile aynı).
      statusKind: isCancelledOrder(order) ? "cancelled" : undefined,
      financial,
    }
  );

  // İade edilen (kargolanıp geri gelen) sipariş: iki yön kargo + hizmet bedeli (gerçek kayıt varsa o).
  const iade =
    isCancelledOrder(order) && !order.dataIncomplete && kargoluIadeMi(order.platform, order.status)
      ? computeReturnLoss(profitInput, {
          outboundCargo: financial?.actualCargo ?? null,
          returnCargo: financial?.actualReturnCargo ?? null,
          serviceFee: order.platform === "hepsiburada" ? financial?.actualOrderFee ?? null : null,
        })
      : null;
  const kusurluCeza = order.kusurluSonucu?.ceza ?? 0;
  const dokum: SiparisDokumu = {
    komisyon: r.actualCommission ?? r.estimatedCommission,
    komisyonKaynagi:
      r.actualCommission != null ? "gercek" : r.matchedLines > 0 && r.orderRateLines === r.matchedLines ? "siparis" : "tahmini",
    komisyonOranlari: [
      ...new Set(
        order.items
          .map((l) => l.commissionRate)
          .filter((oran): oran is number => typeof oran === "number" && Number.isFinite(oran) && oran > 0)
      ),
    ],
    komisyonEksik: r.actualCommission == null && r.profitPartial,
    komisyonTahmini: r.estimatedCommission,
    urunVePaketleme: r.productAndPackagingCost,
    kargo: r.cargoCost,
    kargoGercek: r.actualCargo != null,
    // Kaç desiden ve nereden hesaplandığı — masaüstüyle AYNI çekirdek metni.
    kargoEtiketi: kargoSatiriEtiketi(r, { kesilenDesi: (financial as TelefonFinansKaydi | null)?.kesilenDesi ?? null }),
    kargoKuralYok: r.cargoRuleMissing,
    // Masaüstüyle aynı kural (core/kargo-denetim): pazaryeri ürün desisinden büyük kesti ve fiyatı artırdı.
    fazlaDesi: fazlaDesiBul({
      kesilenDesi: (financial as TelefonFinansKaydi | null)?.kesilenDesi ?? null,
      bizimDesi: r.cargoDetail?.desi ?? null,
      gercekKargo: r.actualCargo,
      tahminiKargo: r.estimatedCargoCost,
    }),
    gecikmeBedeli: Math.max(0, r.penalty - kusurluCeza),
    gecikmeGercek: order.gecikmeSonucu?.durum === "gercek",
    gecikmeKesilmedi: !!order.gecikme?.gecikti && order.gecikmeSonucu?.durum === "kesilmedi",
    kusurluBedeli: kusurluCeza,
    kusurluGercek: order.kusurluSonucu?.durum === "gercek",
    hizmetBedeli: r.fixedExpense,
    hizmetGercek: r.actualOrderFee != null,
    tahsilatBedeli: r.paymentFee,
    tahsilatGercek: r.actualPaymentFee != null,
    uluslararasiBedel: r.internationalFee,
    stopaj: r.stoppage,
    reklamPayi: r.adCost,
    kargoGeliri: r.orderRevenueAdjustment,
    iade,
  };

  const distinctCount = order.items.length;
  return {
    revenue: order.total,
    profit: r.profit,
    partial: r.profitPartial,
    profitSource: r.profitSource,
    actualCommission: r.actualCommission,
    estimatedCommission: r.estimatedCommission,
    image: distinctCount === 1 ? image : null,
    distinctCount,
    totalQty: r.totalQty,
    unmatchedRevenue: r.unmatchedRevenue,
    commissionUnknownCount: r.commissionUnknownLines,
    missingDesiCount: r.missingDesiLines,
    desiEstimated: r.desiEstimated,
    orderRevenueAdjustment: r.orderRevenueAdjustment,
    // Kargolanıp geri gelen sipariş: iki yön kargo + hizmet bedeli (gerçek kayıt varsa o).
    returnLoss: iade ? iade.loss : null,
    dokum,
  };
}
