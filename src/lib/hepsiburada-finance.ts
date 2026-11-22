/**
 * HEPSİBURADA GERÇEK KESİNTİLERİ — muhasebe servisinden sipariş bazında.
 *
 * Sipariş teslim edilince Hepsiburada her kalem için kesintileri ayrı kayıt olarak yazar
 * (komisyon, hizmet bedeli, kargo, tahsilat bedeli, stopaj, karşıladığı indirim). Bu modül o
 * kayıtları sipariş başına toplar ve `PlatformOrderFinancial`'a yazar; kâr hesabı teslimden sonra
 * tahmin yerine bu rakamları kullanır (`resolveOrderProfit`). Trendyol'un gerçek komisyonu için
 * var olan düzenin Hepsiburada karşılığı — burada komisyon dışındaki kalemler de geliyor.
 *
 * Ölçüldü (22 Kas 2026): servis mevcut kimlik bilgileriyle çalışıyor, panelin "Sipariş kayıtları"
 * ekranıyla kuruşu kuruşuna tutuyor; tarih aralığı en çok ~7 gün (35 gün 400 döndü).
 */
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { HepsiburadaClient } from "@/services/hepsiburada-client";
import { getHepsiburadaCredentials } from "@/services/hepsiburada-settings";
import { HB_HIZMET_BEDELI } from "@/core/hb-kesinti";
import { batchWrite } from "./libsql-batch";
import { toDbDate } from "./sqlite-date";
import { tlToKurus } from "./monthly-finance";

const DAY_MS = 86_400_000;
/** Servisin kabul ettiği en geniş sipariş tarihi aralığı (gün). */
const PENCERE_GUN = 7;
const SAYFA = 100;
/** Tek pencerede en çok bu kadar sayfa — sonsuz döngü sigortası (100 × 60 = 6.000 kayıt). */
const EN_COK_SAYFA = 60;

export interface HbMuhasebeKaydi {
  id?: string;
  transactionType?: string;
  orderNumber?: string | number;
  amount?: { value?: number } | number | null;
  taxAmount?: { value?: number } | number | null;
  /** Hepsiburada ürün numarası (ilanın `externalId`'si). */
  sku?: string | null;
  invoiceDate?: string | null;
  orderDate?: string | null;
  [key: string]: unknown;
}

/** Bir siparişin Hepsiburada'da GERÇEKTEN kesilen/ödenen tutarları — TL, giderler POZİTİF. */
export interface HbSiparisGercegi {
  orderNumber: string;
  /** Satıcının brüt geliri = müşterinin ödediği + Hepsiburada'nın karşıladığı indirim. */
  grossRevenue: number;
  commission: number;
  /** Hizmet bedeli; kesilmediyse 0. */
  serviceFee: number;
  paymentFee: number;
  /** Kargo kesintisi; kaydı henüz yoksa null (tahmin geçerli kalır). */
  cargo: number | null;
  stoppage: number;
  platformDiscount: number;
  /** Net tutar — kayıtların toplamı (panelin "Net tutar" kolonu). */
  sellerRevenue: number;
  transactionCount: number;
  sourceUpdatedAt: Date | null;
}

function tutar(kayit: HbMuhasebeKaydi): number {
  const a = kayit.amount;
  const n = typeof a === "number" ? a : Number(a?.value);
  return Number.isFinite(n) ? n : 0;
}

function vergi(kayit: HbMuhasebeKaydi): number {
  const a = kayit.taxAmount;
  const n = typeof a === "number" ? a : Number(a?.value);
  return Number.isFinite(n) ? n : Number.NaN;
}

const KOMISYON = new Set(["Commission", "CommissionRefund", "CommissionInvoiceRefund", "CommissionCorrection"]);
const HIZMET = new Set(["ProcessingFeeExpense", "ProcessingFeeExpenseRefund"]);
const TAHSILAT = new Set(["PaymentServiceCostReflection", "PaymentServiceCostReflectionRefund"]);
const KARGO = new Set(["ShipmentCostSharingExpense", "ShipmentCostSharingIncome", "CargoCostRefund"]);
const STOPAJ = new Set(["Stoppage", "StoppageRefund"]);
const INDIRIM = new Set(["CampaignDiscount", "CampaignDiscountRefund"]);
/** İade izi taşıyan kayıtlar — o siparişin kesintileri netleşmemiştir, tahmin/iptal kuralı geçerli kalır. */
const IADE = new Set(["Return", "BnplRefund"]);

/**
 * SAF: muhasebe kayıtlarını sipariş başına toplar.
 *
 * Yazılmayanlar (`skippedOrders`): ödeme kaydı olmayan ya da iade görmüş siparişler. İade gören
 * siparişte ciro ve kesintiler kısmen geri alınmıştır; yanlış bir "gerçek kâr" üretmektense
 * siparişin durumuna göre çalışan mevcut kurallara bırakılır.
 */
export function hbKayitlariniTopla(kayitlar: HbMuhasebeKaydi[]): {
  aggregates: HbSiparisGercegi[];
  skippedOrders: number;
} {
  type Ara = HbSiparisGercegi & { odeme: number; iade: boolean; kargoVar: boolean; kimlikler: Set<string> };
  const siparisler = new Map<string, Ara>();
  for (const kayit of kayitlar) {
    const no = kayit.orderNumber == null ? "" : String(kayit.orderNumber).trim();
    const tip = String(kayit.transactionType ?? "");
    if (!no || !tip) continue;
    const s =
      siparisler.get(no) ??
      ({
        orderNumber: no, grossRevenue: 0, commission: 0, serviceFee: 0, paymentFee: 0, cargo: null,
        stoppage: 0, platformDiscount: 0, sellerRevenue: 0, transactionCount: 0, sourceUpdatedAt: null,
        odeme: 0, iade: false, kargoVar: false, kimlikler: new Set<string>(),
      } satisfies Ara);
    siparisler.set(no, s);
    // Pencere sınırında aynı kayıt iki kez gelebilir → kimliğe göre tek sayılır.
    const kimlik = kayit.id ? String(kayit.id) : "";
    if (kimlik) {
      if (s.kimlikler.has(kimlik)) continue;
      s.kimlikler.add(kimlik);
    }
    const a = tutar(kayit);
    s.sellerRevenue += a;
    s.transactionCount++;
    if (tip === "Payment") s.odeme += a;
    else if (INDIRIM.has(tip)) s.platformDiscount += a;
    else if (KOMISYON.has(tip)) s.commission -= a;
    else if (HIZMET.has(tip)) s.serviceFee -= a;
    else if (TAHSILAT.has(tip)) s.paymentFee -= a;
    else if (KARGO.has(tip)) { s.cargo = (s.cargo ?? 0) - a; s.kargoVar = true; }
    else if (STOPAJ.has(tip)) s.stoppage -= a;
    else if (IADE.has(tip)) s.iade = true;
    const tarih = kayit.invoiceDate ? new Date(String(kayit.invoiceDate)) : null;
    if (tarih && Number.isFinite(tarih.getTime()) && (!s.sourceUpdatedAt || tarih > s.sourceUpdatedAt)) {
      s.sourceUpdatedAt = tarih;
    }
  }
  const yuvarla = (n: number) => Math.round(n * 100) / 100;
  const aggregates: HbSiparisGercegi[] = [];
  let skippedOrders = 0;
  for (const s of siparisler.values()) {
    if (s.iade || s.odeme <= 0 || s.commission <= 0) {
      skippedOrders++;
      continue;
    }
    aggregates.push({
      orderNumber: s.orderNumber,
      grossRevenue: yuvarla(s.odeme + s.platformDiscount),
      commission: yuvarla(s.commission),
      serviceFee: yuvarla(Math.max(0, s.serviceFee)),
      paymentFee: yuvarla(Math.max(0, s.paymentFee)),
      cargo: s.kargoVar ? yuvarla(Math.max(0, s.cargo ?? 0)) : null,
      stoppage: yuvarla(Math.max(0, s.stoppage)),
      platformDiscount: yuvarla(Math.max(0, s.platformDiscount)),
      sellerRevenue: yuvarla(s.sellerRevenue),
      transactionCount: s.transactionCount,
      sourceUpdatedAt: s.sourceUpdatedAt,
    });
  }
  return { aggregates, skippedOrders };
}

/** Kayıtlarda görülen EN SON hizmet bedeli tutarı (TL, pozitif); hiç yoksa null. */
export function sonHizmetBedeli(kayitlar: HbMuhasebeKaydi[]): number | null {
  let son: { t: number; a: number } | null = null;
  for (const k of kayitlar) {
    if (k.transactionType !== "ProcessingFeeExpense") continue;
    const a = Math.abs(tutar(k));
    const t = k.invoiceDate ? Date.parse(String(k.invoiceDate)) : NaN;
    if (!(a > 0) || !Number.isFinite(t)) continue;
    if (!son || t > son.t) son = { t, a };
  }
  return son ? Math.round(son.a * 100) / 100 : null;
}

/**
 * SAF: muhasebe kayıtlarından ürün (Hepsiburada ürün no) → satış KDV oranı (%).
 * Ödeme kaydındaki KDV / KDV hariç tutar; aynı ürün için EN SON kayıt kazanır.
 */
export function hbUrunKdvOranlari(kayitlar: HbMuhasebeKaydi[]): Map<string, number> {
  const son = new Map<string, { t: number; oran: number }>();
  for (const k of kayitlar) {
    if (k.transactionType !== "Payment") continue;
    const sku = typeof k.sku === "string" ? k.sku.trim() : "";
    const brut = tutar(k);
    const kdv = vergi(k);
    if (!sku || !(brut > 0) || !(kdv >= 0) || brut <= kdv) continue;
    const oran = Math.round((kdv / (brut - kdv)) * 100);
    if (!(oran >= 0 && oran < 100)) continue;
    const t = Date.parse(String(k.invoiceDate ?? k.orderDate ?? "")) || 0;
    const onceki = son.get(sku);
    if (!onceki || t >= onceki.t) son.set(sku, { t, oran });
  }
  return new Map([...son].map(([sku, e]) => [sku, e.oran]));
}

export interface HbIlanSatiri {
  id: string;
  externalId: string | null;
  externalSku: string | null;
  dispatchDays: number | null;
  vatRate: number | null;
}

/**
 * SAF: ilanların kargoya verme süresi ve KDV oranı için yalnız DEĞİŞEN satırların güncellemeleri.
 * Yeni bilgi yoksa kayıtlı değer korunur (bilinmeyen, bilineni silmez). `updatedAt`'e dokunulmaz —
 * bu bir kullanıcı düzenlemesi değil, sıralamaları oynatmasın.
 */
export function hbIlanGuncellemeIfadeleri(
  ilanlar: HbIlanSatiri[],
  sureler: { bySku: ReadonlyMap<string, number>; byMerchantSku: ReadonlyMap<string, number> },
  kdvler: ReadonlyMap<string, number>
): Array<{ sql: string; args: unknown[] }> {
  const ifadeler: Array<{ sql: string; args: unknown[] }> = [];
  for (const ilan of ilanlar) {
    const sure =
      (ilan.externalId ? sureler.bySku.get(ilan.externalId) : undefined) ??
      (ilan.externalSku ? sureler.byMerchantSku.get(ilan.externalSku) : undefined) ??
      ilan.dispatchDays;
    const kdv = (ilan.externalId ? kdvler.get(ilan.externalId) : undefined) ?? ilan.vatRate;
    if ((sure ?? null) === (ilan.dispatchDays ?? null) && (kdv ?? null) === (ilan.vatRate ?? null)) continue;
    ifadeler.push({
      sql: `UPDATE "Listing" SET "dispatchDays" = ?, "vatRate" = ? WHERE "id" = ?`,
      args: [sure ?? null, kdv ?? null, ilan.id],
    });
  }
  return ifadeler;
}

/** Hepsiburada ilanlarının kargoya verme süreleri (gün) — ürün no ve satıcı stok koduna göre. */
async function ilanSureleriniCek(client: HepsiburadaClient) {
  const bySku = new Map<string, number>();
  const byMerchantSku = new Map<string, number>();
  for (let offset = 0; offset < 10_000; offset += SAYFA) {
    const yanit = (await client.listListings({ offset, limit: SAYFA })) as {
      listings?: Array<Record<string, unknown>>;
    } | null;
    const ilanlar = Array.isArray(yanit?.listings) ? yanit.listings : [];
    for (const ilan of ilanlar) {
      const gun = Number(ilan.dispatchTime);
      if (!Number.isFinite(gun) || gun < 0) continue;
      if (typeof ilan.hepsiburadaSku === "string" && ilan.hepsiburadaSku) bySku.set(ilan.hepsiburadaSku, Math.round(gun));
      if (typeof ilan.merchantSku === "string" && ilan.merchantSku) byMerchantSku.set(ilan.merchantSku, Math.round(gun));
    }
    if (ilanlar.length < SAYFA) break;
  }
  return { bySku, byMerchantSku };
}

/**
 * İlanların kargoya verme süresini (ilan servisinden) ve KDV oranını (muhasebe kayıtlarından)
 * `Listing`'e işler — Ürünler ekranındaki satış öncesi kâr bunları kullanır. Yazılan satır sayısını döner.
 */
async function ilanBilgileriniGuncelle(client: HepsiburadaClient, kayitlar: HbMuhasebeKaydi[]): Promise<number> {
  const sureler = await ilanSureleriniCek(client);
  const satirlar = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id", "externalId", "externalSku", "dispatchDays", "vatRate" FROM "Listing" WHERE "platform" = 'hepsiburada'`
  );
  const ilanlar: HbIlanSatiri[] = satirlar.map((s) => ({
    id: String(s.id),
    externalId: s.externalId == null ? null : String(s.externalId),
    externalSku: s.externalSku == null ? null : String(s.externalSku),
    dispatchDays: s.dispatchDays == null ? null : Number(s.dispatchDays),
    vatRate: s.vatRate == null ? null : Number(s.vatRate),
  }));
  const ifadeler = hbIlanGuncellemeIfadeleri(ilanlar, sureler, hbUrunKdvOranlari(kayitlar));
  if (ifadeler.length > 0 && !(await batchWrite(ifadeler))) {
    for (const ifade of ifadeler) await prisma.$executeRawUnsafe(ifade.sql, ...(ifade.args as never[]));
  }
  return ifadeler.length;
}

/** Uygulamanın sipariş kimliği (Siparişler ucu `hb-<sipariş no>` kullanıyor). */
export const hbFinansKimligi = (orderNumber: string) => `hb-${orderNumber}`;

type KayitliSatir = {
  externalOrderId: string;
  grossRevenueKurus: number;
  commissionKurus: number;
  sellerRevenueKurus: number;
  transactionCount: number;
  serviceFeeKurus: number | null;
  paymentFeeKurus: number | null;
  cargoKurus: number | null;
  stoppageKurus: number | null;
  platformDiscountKurus: number | null;
};

function kurusSatiri(row: HbSiparisGercegi): KayitliSatir {
  return {
    externalOrderId: hbFinansKimligi(row.orderNumber),
    grossRevenueKurus: tlToKurus(row.grossRevenue),
    commissionKurus: tlToKurus(row.commission),
    sellerRevenueKurus: tlToKurus(row.sellerRevenue),
    transactionCount: row.transactionCount,
    serviceFeeKurus: tlToKurus(row.serviceFee),
    paymentFeeKurus: tlToKurus(row.paymentFee),
    cargoKurus: row.cargo == null ? null : tlToKurus(row.cargo),
    stoppageKurus: tlToKurus(row.stoppage),
    platformDiscountKurus: tlToKurus(row.platformDiscount),
  };
}

const ALANLAR = [
  "grossRevenueKurus", "commissionKurus", "sellerRevenueKurus", "transactionCount",
  "serviceFeeKurus", "paymentFeeKurus", "cargoKurus", "stoppageKurus", "platformDiscountKurus",
] as const;

/** SAF: yalnız DEĞİŞEN/yeni satırlar için yazma ifadeleri (uzak veritabanında her yazma sıralıdır). */
export function hbGercekYazmaIfadeleri(
  aggregates: HbSiparisGercegi[],
  kayitli: ReadonlyMap<string, KayitliSatir>,
  syncedAt: Date
): Array<{ sql: string; args: unknown[] }> {
  const sync = toDbDate(syncedAt);
  const ifadeler: Array<{ sql: string; args: unknown[] }> = [];
  for (const row of aggregates) {
    const yeni = kurusSatiri(row);
    const eski = kayitli.get(yeni.externalOrderId);
    if (eski && ALANLAR.every((a) => (eski[a] ?? null) === (yeni[a] ?? null))) continue;
    ifadeler.push({
      sql: `INSERT INTO "PlatformOrderFinancial"
              ("id", "platform", "externalOrderId", "orderNumber", "grossRevenueKurus", "commissionKurus",
               "sellerRevenueKurus", "transactionCount", "sourceUpdatedAt", "syncedAt",
               "serviceFeeKurus", "paymentFeeKurus", "cargoKurus", "stoppageKurus", "platformDiscountKurus")
            VALUES (?, 'hepsiburada', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT ("platform", "externalOrderId") DO UPDATE SET
              "orderNumber" = excluded."orderNumber",
              "grossRevenueKurus" = excluded."grossRevenueKurus",
              "commissionKurus" = excluded."commissionKurus",
              "sellerRevenueKurus" = excluded."sellerRevenueKurus",
              "transactionCount" = excluded."transactionCount",
              "sourceUpdatedAt" = excluded."sourceUpdatedAt",
              "syncedAt" = excluded."syncedAt",
              "serviceFeeKurus" = excluded."serviceFeeKurus",
              "paymentFeeKurus" = excluded."paymentFeeKurus",
              "cargoKurus" = excluded."cargoKurus",
              "stoppageKurus" = excluded."stoppageKurus",
              "platformDiscountKurus" = excluded."platformDiscountKurus"`,
      args: [
        `pof:hepsiburada:${yeni.externalOrderId}`,
        yeni.externalOrderId,
        row.orderNumber,
        yeni.grossRevenueKurus,
        yeni.commissionKurus,
        yeni.sellerRevenueKurus,
        yeni.transactionCount,
        row.sourceUpdatedAt ? toDbDate(row.sourceUpdatedAt) : null,
        sync,
        yeni.serviceFeeKurus,
        yeni.paymentFeeKurus,
        yeni.cargoKurus,
        yeni.stoppageKurus,
        yeni.platformDiscountKurus,
      ],
    });
  }
  return ifadeler;
}

const gun = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Son `days` günün (sipariş tarihine göre) tüm muhasebe kayıtları — 7 günlük pencerelerle. */
async function kayitlariCek(client: HepsiburadaClient, days: number): Promise<HbMuhasebeKaydi[]> {
  // Pencere hesabı için — veritabanına yazılmaz (yazılan damga `syncedAt`, toDbDate ile).
  const an = Date.now();
  const hepsi = new Map<string, HbMuhasebeKaydi>();
  let kimliksiz = 0;
  for (let geri = days; geri > 0; geri -= PENCERE_GUN) {
    const bas = gun(an - geri * DAY_MS);
    // Son pencere yarını da kapsar: saat dilimi farkı bugünün siparişlerini dışarıda bırakmasın.
    const bit = gun(an - Math.max(-1, geri - PENCERE_GUN) * DAY_MS);
    for (let sayfa = 0; sayfa < EN_COK_SAYFA; sayfa++) {
      const yanit = (await client.listTransactions({
        offset: sayfa * SAYFA,
        limit: SAYFA,
        orderDateStart: bas,
        orderDateEnd: bit,
      })) as { items?: HbMuhasebeKaydi[] } | null;
      const items = Array.isArray(yanit?.items) ? yanit.items : [];
      for (const k of items) hepsi.set(k.id ? String(k.id) : `kimliksiz-${kimliksiz++}`, k);
      if (items.length < SAYFA) break;
    }
  }
  return [...hepsi.values()];
}

export interface HbFinansSyncSonucu {
  fetchedTransactions: number;
  /** Gerçek kaydı toplanan sipariş. */
  totalOrders: number;
  /** Bu turda yazılan (yeni ya da değişen) sipariş. */
  storedOrders: number;
  skippedOrders: number;
  /** Kargoya verme süresi / KDV oranı güncellenen ilan sayısı. */
  updatedListings: number;
  days: number;
  syncedAt: string;
}

/**
 * Hepsiburada gerçek kesintilerini çeker ve `PlatformOrderFinancial`'a yazar.
 * Görülen son hizmet bedeli tutarı `hbServiceFee` ayarına işlenir (tahmin onu kullanır).
 */
export async function syncHepsiburadaFinancials(requestedDays = 35): Promise<HbFinansSyncSonucu> {
  const days = Math.max(1, Math.min(120, Math.trunc(requestedDays)));
  await ensureRuntimeSchema();
  const client = new HepsiburadaClient(await getHepsiburadaCredentials());
  const kayitlar = await kayitlariCek(client, days);
  const { aggregates, skippedOrders } = hbKayitlariniTopla(kayitlar);
  const syncedAt = new Date();

  // Önce karşılaştır: çoğu turda hiçbir şey değişmez; değişmeyen satıra yazma YOK.
  const kayitli = new Map<string, KayitliSatir>();
  const kimlikler = aggregates.map((a) => hbFinansKimligi(a.orderNumber));
  for (let i = 0; i < kimlikler.length; i += 400) {
    const dilim = kimlikler.slice(i, i + 400);
    const satirlar = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "externalOrderId", ${ALANLAR.map((a) => `"${a}"`).join(", ")}
         FROM "PlatformOrderFinancial"
        WHERE "platform" = 'hepsiburada' AND "externalOrderId" IN (${dilim.map(() => "?").join(",")})`,
      ...dilim
    );
    for (const s of satirlar) {
      const sayi = (v: unknown) => (v == null ? null : Number(v));
      kayitli.set(String(s.externalOrderId), {
        externalOrderId: String(s.externalOrderId),
        grossRevenueKurus: Number(s.grossRevenueKurus),
        commissionKurus: Number(s.commissionKurus),
        sellerRevenueKurus: Number(s.sellerRevenueKurus),
        transactionCount: Number(s.transactionCount),
        serviceFeeKurus: sayi(s.serviceFeeKurus),
        paymentFeeKurus: sayi(s.paymentFeeKurus),
        cargoKurus: sayi(s.cargoKurus),
        stoppageKurus: sayi(s.stoppageKurus),
        platformDiscountKurus: sayi(s.platformDiscountKurus),
      });
    }
  }
  const ifadeler = hbGercekYazmaIfadeleri(aggregates, kayitli, syncedAt);
  if (ifadeler.length > 0 && !(await batchWrite(ifadeler))) {
    for (const ifade of ifadeler) await prisma.$executeRawUnsafe(ifade.sql, ...(ifade.args as never[]));
  }

  // Hizmet bedeli tutarı değiştiyse tahmin de yeni tutarı kullansın.
  const gorulen = sonHizmetBedeli(kayitlar);
  if (gorulen != null) {
    const ayar = await prisma.appSetting.findUnique({ where: { key: "hbServiceFee" } });
    const gecerli = Number(ayar?.value);
    const simdiki = Number.isFinite(gecerli) && gecerli > 0 ? gecerli : HB_HIZMET_BEDELI;
    if (Math.abs(simdiki - gorulen) >= 0.005) {
      await prisma.appSetting.upsert({
        where: { key: "hbServiceFee" },
        update: { value: String(gorulen) },
        create: { key: "hbServiceFee", value: String(gorulen) },
      });
    }
  }

  // İlan bilgileri (satış öncesi kâr için). Bu adımın hatası gerçek kesintilerin yazımını geri almaz.
  let updatedListings = 0;
  try {
    updatedListings = await ilanBilgileriniGuncelle(client, kayitlar);
  } catch (hata) {
    console.warn("[hepsiburada-finance] ilan bilgileri güncellenemedi:", hata instanceof Error ? hata.message : hata);
  }

  return {
    fetchedTransactions: kayitlar.length,
    totalOrders: aggregates.length,
    storedOrders: ifadeler.length,
    skippedOrders,
    updatedListings,
    days,
    syncedAt: syncedAt.toISOString(),
  };
}
