import { describe, expect, it } from "vitest";
import {
  n11KalemHesabi,
  n11KargoOdeyen,
  n11KayitliKalemEk,
  n11PaketiCoz,
  n11Pencereleri,
  n11SatisOncesiKesintiler,
} from "./n11-siparis";
import { kargoTahmini, iadeKargoTahmini, kargoTahminiEtiketi } from "./kargo-tarife";
import { computeOrderProfit, type OrderProfitInput, type OrderProfitProduct } from "./order-profit";
import { gecerliSiparisOrani, gecerliSiparisOraniSifirDahil, n11SiparisKomisyonKesri } from "./order-commission";
import { resolveListingCommissionOverride } from "./product-commission";
import { komisyonBilinmiyor } from "./komisyon-bilinmiyor";
import { durumKovasi } from "./siparis-listesi";

/** 26 Kas 2026'daki ilk n11 siparişinin kalemi (kişisel alanlar yok). */
const GERCEK_KALEM = {
  quantity: 1,
  productId: 817076614,
  productName: "Xbox Uyumlu 2'li Joystick Standı",
  stockCode: "M3D00XDD147BYZ",
  price: 349.99,
  dueAmount: 314.99,
  sellerCouponDiscount: 0,
  sellerDiscount: 0,
  mallDiscount: 35,
  sellerInvoiceAmount: 349.99,
  totalMallDiscountPrice: 35,
  orderItemLineItemStatusName: "Picking",
  totalSellerDiscountPrice: 0,
  vatRate: 20,
  commissionRate: 0,
  sellerCampaignCommissionRate: 0,
  taxDeductionRate: 1,
  netMarketingFeeRate: 1.2,
  netMarketplaceFeeRate: 0.8,
  barcode: null,
  deliveryFeeType: 3,
};
const GERCEK_PAKET = {
  orderNumber: "243278346425",
  id: "112411287672251",
  cargoTrackingNumber: "112411287672251",
  cargoProviderName: "DHL e-Commerce",
  lines: [GERCEK_KALEM],
  lastModifiedDate: 1795687729862,
  agreedDeliveryDate: 1796032992216,
  // Paket toplamları bu pakete ait değil (ölçüldü) — kullanılmamalı.
  totalAmount: 2430.9,
  totalDiscountAmount: 1918.99,
  packageHistories: [
    { createdDate: 1795687418454, status: "Created" },
    { createdDate: 1795687729862, status: "Picking" },
  ],
  shipmentPackageStatus: "Picking",
  isReturned: false,
};
const KASIM = new Date("2026-11-26T10:03:38Z");

describe("n11 kalemi", () => {
  it("gerçek kalem: gelir fatura tutarı, %0 komisyon, %2 hizmet bedeli, stopaj bilgi", () => {
    const k = n11KalemHesabi(GERCEK_KALEM);
    expect(k).toMatchObject({
      quantity: 1,
      unitPrice: 349.99,
      paidUnitPrice: 314.99,
      n11DiscountUnit: 35,
      commissionRate: 0,
      saleVatRate: 20,
      paymentFee: 7,
      stoppage: 2.92,
      kargoOdeyen: "sartli",
      stockCode: "M3D00XDD147BYZ",
    });
  });

  it("çok adetli satır: birim gelir = fatura ÷ adet; satıcı indirimi düşülmüş tutar", () => {
    const k = n11KalemHesabi({ ...GERCEK_KALEM, quantity: 2, price: 200, sellerInvoiceAmount: 380, totalSellerDiscountPrice: 20 });
    expect(k.unitPrice).toBe(190);
    expect(k.paymentFee).toBe(7.6);
    // Fatura tutarı yoksa doküman formülü: fiyat × adet − satıcı indirimi.
    expect(n11KalemHesabi({ quantity: 2, price: 200, totalSellerDiscountPrice: 20 }).unitPrice).toBe(190);
  });

  it("oran alanı yoksa sabit oranlar; komisyon alanı yoksa BİLİNMİYOR (0 değil)", () => {
    const k = n11KalemHesabi({ quantity: 1, sellerInvoiceAmount: 100, vatRate: 20 });
    expect(k.paymentFee).toBe(2);
    expect(k.commissionRate).toBeNull();
  });

  it("komisyon %X + KDV → KDV dahil kesir", () => {
    expect(n11SiparisKomisyonKesri(10)).toBe(0.12);
    expect(n11SiparisKomisyonKesri(0)).toBe(0);
    expect(n11SiparisKomisyonKesri(null)).toBeNull();
    expect(n11SiparisKomisyonKesri("abc")).toBeNull();
  });

  it("sıfır dahil oran yalnız yeni doğrulayıcıda — Trendyol/HB'nin eski kuralı aynen", () => {
    expect(gecerliSiparisOraniSifirDahil(0)).toBe(0);
    expect(gecerliSiparisOraniSifirDahil(-0.1)).toBeNull();
    expect(gecerliSiparisOraniSifirDahil(1)).toBeNull();
    expect(gecerliSiparisOrani(0)).toBeNull();
  });

  it("kargo şablonu: 1 alıcı, 2 mağaza, 3 şartlı, 4 n11", () => {
    expect([1, 2, 3, 4, 9, null].map(n11KargoOdeyen)).toEqual(["alici", "magaza", "sartli", "pazaryeri", null, null]);
  });

  it("yeniden hesap: kayıtlı kalemden sabit oranlarla", () => {
    expect(n11KayitliKalemEk({ unitPrice: 349.99, quantity: 1, vatRate: 20 })).toEqual({ paymentFee: 7, stoppage: 2.92 });
  });
});

describe("n11 paketi", () => {
  it("gerçek paket: tarih ilk Created kaydı, tutar kalemlerden (paket toplamı DEĞİL)", () => {
    const s = n11PaketiCoz(GERCEK_PAKET);
    expect(s).toMatchObject({
      id: "n11-112411287672251",
      orderNumber: "243278346425",
      tarihMs: 1795687418454,
      toplam: 349.99,
      kargoFirmasi: "DHL e-Commerce",
      kargoIadesi: false,
      eksik: false,
    });
    expect(s.durum).toMatchObject({ kind: "processing", label: "Hazırlanıyor", ham: "Picking" });
    expect(s.kargo).toEqual({ firma: "DHL e-Commerce", odeyen: "sartli", baremTutari: 349.99 });
  });

  it("iade edilen paket → İade (ciro dışı) + kargo zararı", () => {
    const s = n11PaketiCoz({ ...GERCEK_PAKET, shipmentPackageStatus: "Delivered", isReturned: true });
    expect(s.durum).toMatchObject({ kind: "cancelled", label: "İade", ham: "Returned" });
    expect(s.kargoIadesi).toBe(true);
    expect(durumKovasi("n11", "Returned")).toBe("cancelled");
    expect(durumKovasi("n11", "Delivered")).toBe("delivered");
  });

  it("tanınmayan durum toplamlara girmez; kalemsiz paket eksik sayılır", () => {
    expect(n11PaketiCoz({ ...GERCEK_PAKET, shipmentPackageStatus: "Yeni" }).durum.unknown).toBe(true);
    expect(n11PaketiCoz({ ...GERCEK_PAKET, lines: [] })).toMatchObject({ eksik: true, toplam: 0 });
  });

  it("tarih yedekleri: Created yoksa en eski kayıt, o da yoksa son güncelleme", () => {
    expect(n11PaketiCoz({ ...GERCEK_PAKET, packageHistories: [{ createdDate: 5, status: "Picking" }] }).tarihMs).toBe(5);
    expect(n11PaketiCoz({ ...GERCEK_PAKET, packageHistories: [] }).tarihMs).toBe(1795687729862);
  });

  it("kalemlerin kargo şablonu farklıysa ödeyen bilinmiyor", () => {
    const s = n11PaketiCoz({ ...GERCEK_PAKET, lines: [GERCEK_KALEM, { ...GERCEK_KALEM, deliveryFeeType: 2 }] });
    expect(s.kargo.odeyen).toBeNull();
  });
});

describe("n11 kargo tarifesi (DHL, posta hizmet bedeli %2,35 eklenir, KDV hariç)", () => {
  const n11 = (tutar: number, desi: number, odeyen: "sartli" | "magaza" | "alici" | "pazaryeri" | null = "sartli") =>
    kargoTahmini("n11", tutar, desi, KASIM, { firma: "DHL e-Commerce", odeyen });

  it("şartlı kargo, 300 TL altı ve ≤ 10 desi → sabit: 57,08 / 87,91 (+%2,35)", () => {
    expect(n11(99.99, 1)).toMatchObject({ fiyat: 58.42, tur: "barem", firma: "dhl" });
    expect(n11(149.99, 3)?.fiyat).toBe(58.42);
    expect(n11(249.99, 10)?.fiyat).toBe(89.98);
  });

  it("300 TL ve üstü ya da 10 desi üstü → desi listesi", () => {
    expect(n11(349.99, 1)).toMatchObject({ fiyat: 101.49, tur: "desi" });
    expect(n11(249.99, 11)).toMatchObject({ fiyat: 205.99, tur: "desi" });
    // 50 desi üstü her desi +35,16 → 60 desi 1.647,85 (+%2,35)
    expect(n11(999, 60)?.fiyat).toBe(1686.57);
  });

  it("mağaza öder ya da şablon bilinmiyor → 300 TL altı da desi listesi", () => {
    expect(n11(99.99, 1, "magaza")?.fiyat).toBe(101.49);
    expect(n11(99.99, 1, null)?.fiyat).toBe(101.49);
  });

  it("alıcı ya da n11 öder → satıcıya kargo yok", () => {
    expect(n11(99.99, 1, "alici")).toMatchObject({ fiyat: 0, tur: "alici" });
    expect(n11(499.99, 4, "pazaryeri")).toMatchObject({ fiyat: 0, tur: "pazaryeri" });
    expect(kargoTahminiEtiketi({ tur: "alici", firma: "dhl", desi: 1 })).toBe("Kargoyu alıcı ödüyor");
  });

  it("iade kargosu desi listesinden; tarife dönemi öncesi null (eski kurallar)", () => {
    expect(iadeKargoTahmini("n11", 99.99, 1, KASIM, { odeyen: "sartli" })?.fiyat).toBe(101.49);
    expect(kargoTahmini("n11", 99.99, 1, new Date("2026-10-15T10:00:00Z"), null)).toBeNull();
  });
});

describe("n11 sipariş kârı", () => {
  const urun = (over: Partial<OrderProfitProduct> = {}): OrderProfitProduct => ({
    id: "u", name: "u", categoryName: "Oyun", desi: 1, commissionRate: 0.21,
    productionCost: 80, packagingCost: 10, filamentCost: 0, productionCostKnown: true,
    listing: null,
    ...over,
  });
  const k = n11KalemHesabi(GERCEK_KALEM);
  const girdi = (over: Partial<OrderProfitInput> = {}): OrderProfitInput => ({
    platform: "n11",
    orderTotal: 349.99,
    lines: [{
      unitPrice: k.unitPrice, quantity: k.quantity, product: urun(),
      orderCommissionRate: k.commissionRate, saleVatRate: k.saleVatRate,
      paymentFee: k.paymentFee, stoppage: k.stoppage,
    }],
    commissionRules: [],
    cargoRules: [],
    expenseRules: [],
    settings: { vatRate: "20" },
    orderedAt: KASIM,
    kargo: n11PaketiCoz(GERCEK_PAKET).kargo,
    ...over,
  });

  it("%0 komisyon GERÇEK sıfır: ürünün Trendyol oranına (%21) düşmez, sipariş tam", () => {
    const r = computeOrderProfit(girdi());
    expect(r.estimatedCommission).toBe(0);
    expect(r.orderRateLines).toBe(1);
    expect(r.commissionUnknownLines).toBe(0);
    expect(r.partial).toBe(false);
    expect(r.paymentFee).toBe(7);
    expect(r.stoppage).toBe(2.92);
    // 349,99 ≥ 300 → DHL 1 desi 101,49 + KDV
    expect(r.cargoDetail).toMatchObject({ tur: "desi", fiyat: 101.49 });
    expect(r.cargoCost).toBeCloseTo(121.788, 3);
  });

  it("kâr: KDV hariç gelir − ürün − paketleme − hizmet bedeli − kargo (KDV'leri indirilir)", () => {
    const r = computeOrderProfit(girdi());
    const beklenen = 349.99 / 1.2 - 80 - 10 + 10 * (20 / 120) - 7 + 7 * (20 / 120) - 101.49;
    expect(r.profit).toBeCloseTo(beklenen, 6);
  });

  it("komisyon alanı gelmediyse satır kâra girmez (bilinmeyen ≠ sıfır)", () => {
    const r = computeOrderProfit(girdi({
      lines: [{ unitPrice: 349.99, quantity: 1, product: urun(), orderCommissionRate: null, paymentFee: 7 }],
    }));
    expect(r.commissionUnknownLines).toBe(1);
    expect(r.profit).toBeNull();
  });
});

describe("n11 ilanı (satış öncesi)", () => {
  it("hizmet bedeli brüt fiyatın %2'si → KDV hariç fiyata göre oran", () => {
    expect(n11SatisOncesiKesintiler({ vatRate: 20 }, 20)).toEqual({ paymentFeeRate: 0.024, fixedExpenseOverride: 0, saleVatRate: 20 });
    expect(n11SatisOncesiKesintiler({ vatRate: 10 }, 20)).toEqual({ paymentFeeRate: 0.022, fixedExpenseOverride: 0, saleVatRate: 10 });
    expect(n11SatisOncesiKesintiler({ vatRate: null }, 20)).toEqual({ paymentFeeRate: 0.024, fixedExpenseOverride: 0 });
  });

  it("ilan: %0 komisyon geçerli, şartlı kargo tarifesi, sabit bedel yok", () => {
    const o = resolveListingCommissionOverride({ platform: "n11", commissionRate: 0, commissionFixed: null, vatRate: 20 }, { vatRate: "20" });
    expect(o).toMatchObject({
      commissionRateOverride: 0,
      paymentFeeRate: 0.024,
      fixedExpenseOverride: 0,
      saleVatRate: 20,
      kargoTarifesi: { platform: "n11", odeyen: "sartli" },
    });
  });

  it("oranı olmayan n11 ilanında komisyon bilinmiyor", () => {
    expect(komisyonBilinmiyor({ platform: "n11", commissionRate: null }, {})).toBe(true);
    expect(komisyonBilinmiyor({ platform: "n11", commissionRate: 0 }, {})).toBe(false);
  });
});

describe("n11 sipariş pencereleri (en çok 1 ay)", () => {
  it("60 gün → 28 günlük dilimler, en yeni önce, aralığı tamamen kapsar", () => {
    const bitis = Date.UTC(2026, 10, 26);
    const bas = bitis - 60 * 86_400_000;
    const p = n11Pencereleri(bitis, bas);
    expect(p.length).toBe(3);
    expect(p[0].bitis).toBe(bitis);
    expect(p[p.length - 1].baslangic).toBe(bas);
    for (const d of p) expect(d.bitis - d.baslangic).toBeLessThanOrEqual(28 * 86_400_000);
    for (let i = 1; i < p.length; i++) expect(p[i].bitis).toBeGreaterThan(p[i - 1].baslangic);
  });
});
