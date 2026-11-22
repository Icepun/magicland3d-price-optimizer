import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { tlToKurus } from "@/lib/monthly-finance";
import { batchWrite } from "@/lib/libsql-batch";
import { toDbDate } from "@/lib/sqlite-date";
import { applyActualCommissionToProfit } from "@/core/platform-financials";
import { vatRateOf } from "@/core/vat";
import {
  TrendyolClient,
  type TrendyolSettlementItem,
} from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";

const DAY_MS = 86_400_000;
const MAX_WINDOW_MS = 14 * DAY_MS;
const PAGE_SIZE = 1000;

export interface TrendyolCommissionAggregate {
  externalOrderId: string;
  orderNumber: string;
  grossRevenue: number;
  commission: number;
  sellerRevenue: number;
  transactionCount: number;
  sourceUpdatedAt: Date | null;
}

export interface TrendyolCommissionSyncResult {
  fetchedTransactions: number;
  storedOrders: number;
  /** Gerçek kargo bedeli yazılan sipariş sayısı. */
  cargoOrders: number;
  /** Gerçek kargosu bu turda KAYITLI kâra işlenen sipariş sayısı. */
  appliedCargoOrders: number;
  /** Gerçek komisyonu bu turda KAYITLI kâra işlenen sipariş sayısı. */
  appliedOrders: number;
  skippedTransactions: number;
  days: number;
  syncedAt: string;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text : null;
}

function orderKeyOf(item: TrendyolSettlementItem): string | null {
  const orderNumber = cleanId(item.orderNumber);
  if (!orderNumber) return null;
  const shipmentPackageId = cleanId(item.shipmentPackageId);
  return shipmentPackageId ? `ty-${shipmentPackageId}` : `ty-order-${orderNumber}`;
}

/**
 * SATICI KUPONU ("Takip Et Kazan" vb.) — satış hareketinden AYRI bir hareket olarak gelir.
 *
 * ⚠️ ÖLÇÜLDÜ (4 Eki 2026): kuponlu siparişte "Sale" hareketi kuponsuz fiyatı (449,99) ve onun
 * komisyonunu (94,50) taşıyor; 20 TL'lik kupon ayrı bir "Coupon" hareketinde BORÇ olarak düşülüyor
 * ve kuponun komisyonu (4,20) geri veriliyor. Yalnız satış hareketi okununca ödeme siparişten
 * büyük görünüyor, gerçek komisyon da kâra İŞLENEMİYORDU (142 sipariş, "komisyon kaydı var ama
 * kâra işlenemiyor" uyarısı). Kupon netlenince ödeme sipariş tutarıyla birebir tutuyor
 * (429,99 / komisyon 90,30).
 *
 * İptal hareketi ("CouponCancel") kuponu geri alır — aynı alanlar ters yönde işlenir.
 */
export interface TrendyolSettlementAdjustments {
  coupons?: TrendyolSettlementItem[];
  couponCancels?: TrendyolSettlementItem[];
  /**
   * SATICI İNDİRİMİ ("İndirim") — kuponla AYNI biçimde ayrı hareket: satış kaydı indirimsiz fiyatı ve
   * onun komisyonunu taşır, indirim borç olarak düşülür ve indirimin komisyonu geri verilir.
   * Ölçüldü (22 Kas 2026): satış 649,99 / komisyon 136,50 + indirim 32,50 / komisyon iadesi 6,83.
   * Netlenmeyince ödeme siparişten büyük görünüyor ve gerçek komisyon kâra HİÇ işlenemiyordu
   * (son 14 günde 50 indirim kaydı).
   */
  discounts?: TrendyolSettlementItem[];
  discountCancels?: TrendyolSettlementItem[];
}

export function aggregateTrendyolSaleSettlements(
  items: TrendyolSettlementItem[],
  adjustments: TrendyolSettlementAdjustments = {}
): {
  aggregates: TrendyolCommissionAggregate[];
  skippedTransactions: number;
} {
  const sales = aggregateSales(items);
  const byOrder = new Map(sales.aggregates.map((row) => [row.externalOrderId, row]));
  let skippedTransactions = sales.skippedTransactions;

  for (const [list, direction] of [
    [adjustments.coupons ?? [], -1],
    [adjustments.couponCancels ?? [], 1],
    [adjustments.discounts ?? [], -1],
    [adjustments.discountCancels ?? [], 1],
  ] as const) {
    for (const item of list) {
      const key = orderKeyOf(item);
      const current = key ? byOrder.get(key) : undefined;
      const commission = finiteNumber(item.commissionAmount) ?? 0;
      const amount = (finiteNumber(item.debt) ?? 0) - (finiteNumber(item.credit) ?? 0);
      const sellerShare = finiteNumber(item.sellerRevenue) ?? amount - commission;
      // Satışı bu pencerede olmayan kupon hiçbir siparişe yazılmaz (yarım tutar üretmesin).
      if (!current) {
        skippedTransactions++;
        continue;
      }
      // Kupon: tutarı (borç) sipariş brütünden düşer, kuponun komisyonu iade edilir.
      // İptali: ikisi de geri gelir.
      current.grossRevenue += direction * Math.abs(amount);
      current.commission += direction * Math.abs(commission);
      current.sellerRevenue += direction * Math.abs(sellerShare);
      current.transactionCount++;
    }
  }

  // Netleşince eksiye düşen paket (eksik/tutarsız hareket) kâra işlenmesin.
  const aggregates: TrendyolCommissionAggregate[] = [];
  for (const row of byOrder.values()) {
    row.grossRevenue = Number(row.grossRevenue.toFixed(2));
    row.commission = Number(row.commission.toFixed(2));
    row.sellerRevenue = Number(row.sellerRevenue.toFixed(2));
    if (row.grossRevenue < 0 || row.commission < 0 || row.sellerRevenue < 0) {
      skippedTransactions += row.transactionCount;
      continue;
    }
    aggregates.push(row);
  }
  return { aggregates, skippedTransactions };
}

function aggregateSales(
  items: TrendyolSettlementItem[]
): {
  aggregates: TrendyolCommissionAggregate[];
  skippedTransactions: number;
} {
  const byOrder = new Map<string, TrendyolCommissionAggregate>();
  let skippedTransactions = 0;

  for (const item of items) {
    const orderNumber = cleanId(item.orderNumber);
    const shipmentPackageId = cleanId(item.shipmentPackageId);
    const commission = finiteNumber(item.commissionAmount);
    const sellerRevenueValue = finiteNumber(item.sellerRevenue);
    const credit = finiteNumber(item.credit);
    const grossRevenue =
      credit != null
        ? credit
        : sellerRevenueValue != null && commission != null
          ? sellerRevenueValue + commission
          : null;

    if (
      !orderNumber ||
      commission == null ||
      grossRevenue == null ||
      commission < 0 ||
      grossRevenue < 0
    ) {
      skippedTransactions++;
      continue;
    }

    const sellerRevenue =
      sellerRevenueValue != null ? sellerRevenueValue : grossRevenue - commission;
    if (!Number.isFinite(sellerRevenue) || sellerRevenue < 0) {
      skippedTransactions++;
      continue;
    }

    const externalOrderId = shipmentPackageId
      ? `ty-${shipmentPackageId}`
      : `ty-order-${orderNumber}`;
    const current = byOrder.get(externalOrderId) ?? {
      externalOrderId,
      orderNumber,
      grossRevenue: 0,
      commission: 0,
      sellerRevenue: 0,
      transactionCount: 0,
      sourceUpdatedAt: null,
    };
    current.grossRevenue += grossRevenue;
    current.commission += commission;
    current.sellerRevenue += sellerRevenue;
    current.transactionCount++;

    const transactionDate = finiteNumber(item.transactionDate);
    if (transactionDate != null) {
      const date = new Date(transactionDate);
      if (
        Number.isFinite(date.getTime()) &&
        (!current.sourceUpdatedAt || date > current.sourceUpdatedAt)
      ) {
        current.sourceUpdatedAt = date;
      }
    }
    byOrder.set(externalOrderId, current);
  }

  return { aggregates: [...byOrder.values()], skippedTransactions };
}

/** Pencere sınırında aynı finans hareketi iki kez dönerse bir kez sayılır. */
function uniqueSettlements(items: TrendyolSettlementItem[]): TrendyolSettlementItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = cleanId(item.id);
    const key =
      id ??
      JSON.stringify([
        item.orderNumber,
        item.shipmentPackageId,
        item.barcode,
        item.transactionDate,
        item.commissionAmount,
        item.credit,
        item.debt,
        item.sellerRevenue,
      ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchSettlements(
  client: TrendyolClient,
  startDate: number,
  endDate: number,
  transactionType: "Sale" | "Coupon" | "CouponCancel" | "Discount" | "DiscountCancel"
): Promise<TrendyolSettlementItem[]> {
  const items: TrendyolSettlementItem[] = [];

  for (
    let windowStart = startDate;
    windowStart <= endDate;
    windowStart += MAX_WINDOW_MS
  ) {
    const windowEnd = Math.min(endDate, windowStart + MAX_WINDOW_MS - 1);
    for (let pageNo = 0; pageNo < 100; pageNo++) {
      const page = await client.listSettlements({
        startDate: windowStart,
        endDate: windowEnd,
        page: pageNo,
        size: PAGE_SIZE,
        transactionType,
      });
      const content = page.content ?? [];
      items.push(...content);
      const totalPages = Number(page.totalPages);
      if (
        content.length < PAGE_SIZE ||
        (Number.isFinite(totalPages) && pageNo + 1 >= totalPages)
      ) {
        break;
      }
    }
  }

  return items;
}

export async function syncTrendyolActualCommissions(
  requestedDays = 60
): Promise<TrendyolCommissionSyncResult> {
  const days = Math.max(1, Math.min(180, Math.trunc(requestedDays)));
  await ensureRuntimeSchema();

  const client = new TrendyolClient(await getTrendyolCredentials());
  const endDate = Date.now();
  const startDate = endDate - days * DAY_MS;
  // Satış + satıcı kuponu (ve iptali): kupon ayrı hareket olarak düşülüyor — netlenmezse ödeme
  // siparişten büyük görünür ve gerçek komisyon kâra işlenemez (bkz. aggregateTrendyolSaleSettlements).
  const [sales, coupons, couponCancels, discounts, discountCancels] = await Promise.all([
    fetchSettlements(client, startDate, endDate, "Sale"),
    fetchSettlements(client, startDate, endDate, "Coupon"),
    fetchSettlements(client, startDate, endDate, "CouponCancel"),
    fetchSettlements(client, startDate, endDate, "Discount"),
    fetchSettlements(client, startDate, endDate, "DiscountCancel"),
  ]);
  const unique = uniqueSettlements(sales);
  const { aggregates, skippedTransactions } = aggregateTrendyolSaleSettlements(unique, {
    coupons: uniqueSettlements(coupons),
    couponCancels: uniqueSettlements(couponCancels),
    discounts: uniqueSettlements(discounts),
    discountCancels: uniqueSettlements(discountCancels),
  });
  const syncedAt = new Date();

  await komisyonKayitlariniYaz(aggregates, syncedAt);

  // GERÇEK KARGO — haftalık kargo faturalarının sipariş kalemleri. Bu adımın hatası komisyonu
  // geri almaz (kargo tahminde kalır).
  let cargoOrders = 0;
  let appliedCargoOrders = 0;
  try {
    const kargo = await kargoFaturaKalemleri(client, startDate, endDate);
    cargoOrders = await kargoKayitlariniYaz(aggregates, kargo);
  } catch (hata) {
    console.warn("[trendyol-finance] kargo faturaları alınamadı:", hata instanceof Error ? hata.message : hata);
  }

  const appliedOrders = await gercekKomisyonlariKayitlaraIsle();
  // Kargo faturası siparişten ~4 hafta sonra kesiliyor: çoğu sipariş artık listede değil, kayıtlı
  // kârına yalnız FARK işlenir. Hata komisyon işlemesini geri almaz.
  try {
    appliedCargoOrders = await gercekKargolariKayitlaraIsle();
  } catch (hata) {
    console.warn("[trendyol-finance] gerçek kargo kayıtlı kâra işlenemedi:", hata instanceof Error ? hata.message : hata);
  }
  // İlan terminleri (satış öncesi kargo tahmini için). Hatası diğer adımları geri almaz.
  try {
    await tyIlanTerminleriniGuncelle(client);
  } catch (hata) {
    console.warn("[trendyol-finance] ilan terminleri güncellenemedi:", hata instanceof Error ? hata.message : hata);
  }

  return {
    fetchedTransactions: unique.length,
    storedOrders: aggregates.length,
    cargoOrders,
    appliedCargoOrders,
    appliedOrders,
    skippedTransactions,
    days,
    syncedAt: syncedAt.toISOString(),
  };
}

/**
 * SAF: kargo faturası kalemlerinden sipariş no → GİDİŞ kargosu toplamı (TL).
 * Yalnız "Gönderi" türü alınır; iade kargosu iade edilen siparişin zararıdır, ayrıca ele alınacak.
 */
export function kargoKalemleriniTopla(kalemler: Array<Record<string, unknown>>): Map<string, number> {
  const toplam = new Map<string, number>();
  for (const k of kalemler) {
    const no = cleanId(k.orderNumber);
    const tutar = finiteNumber(k.amount);
    const tur = String(k.shipmentPackageType ?? "");
    if (!no || tutar == null || tutar <= 0 || !/Gönderi/i.test(tur)) continue;
    toplam.set(no, Math.round(((toplam.get(no) ?? 0) + tutar) * 100) / 100);
  }
  return toplam;
}

export interface TyIlanSatiri {
  id: string;
  externalId: string | null;
  barcode: string | null;
  dispatchDays: number | null;
}

/**
 * SAF: Trendyol ilanlarının termini (kargoya veriliş süresi, gün) için yalnız DEĞİŞEN satırların
 * güncellemeleri. Termin bilinmiyorsa kayıtlı değer korunur. `updatedAt`'e dokunulmaz.
 * Ürünler ekranındaki satış öncesi kargo bununla seçilir (termin 1 gün → hızlı teslimat fiyatı).
 */
export function tyIlanTerminIfadeleri(
  ilanlar: TyIlanSatiri[],
  terminler: { byId: ReadonlyMap<string, number>; byBarcode: ReadonlyMap<string, number> }
): Array<{ sql: string; args: unknown[] }> {
  const ifadeler: Array<{ sql: string; args: unknown[] }> = [];
  for (const ilan of ilanlar) {
    const termin =
      (ilan.externalId ? terminler.byId.get(ilan.externalId) : undefined) ??
      (ilan.barcode ? terminler.byBarcode.get(ilan.barcode) : undefined);
    if (termin == null || termin === ilan.dispatchDays) continue;
    ifadeler.push({ sql: `UPDATE "Listing" SET "dispatchDays" = ? WHERE "id" = ?`, args: [termin, ilan.id] });
  }
  return ifadeler;
}

/** Onaylı ürünlerin terminleri → Listing.dispatchDays (Trendyol). Yazılan satır sayısını döner. */
async function tyIlanTerminleriniGuncelle(client: TrendyolClient): Promise<number> {
  const byId = new Map<string, number>();
  const byBarcode = new Map<string, number>();
  for (let sayfa = 0; sayfa < 50; sayfa++) {
    const y = await client.listApprovedProducts({ page: sayfa, size: 100 });
    for (const u of y.content ?? []) {
      const gun = Number(u.deliveryDuration);
      if (u.deliveryDuration == null || !Number.isFinite(gun) || gun < 0) continue;
      if (u.id) byId.set(String(u.id), Math.round(gun));
      if (u.barcode) byBarcode.set(String(u.barcode).trim(), Math.round(gun));
    }
    if ((y.content ?? []).length === 0 || (y.totalPages != null && sayfa >= y.totalPages - 1)) break;
  }
  if (byId.size === 0 && byBarcode.size === 0) return 0;
  const satirlar = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id", "externalId", "barcode", "dispatchDays" FROM "Listing" WHERE "platform" = 'trendyol'`
  );
  const ifadeler = tyIlanTerminIfadeleri(
    satirlar.map((s) => ({
      id: String(s.id),
      externalId: s.externalId == null ? null : String(s.externalId),
      barcode: s.barcode == null ? null : String(s.barcode).trim(),
      dispatchDays: s.dispatchDays == null ? null : Number(s.dispatchDays),
    })),
    { byId, byBarcode }
  );
  if (ifadeler.length > 0 && !(await batchWrite(ifadeler))) {
    for (const ifade of ifadeler) await prisma.$executeRawUnsafe(ifade.sql, ...(ifade.args as never[]));
  }
  return ifadeler.length;
}

/**
 * SAF: kargo faturası kalemlerinden sipariş no → İADE (dönüş) kargosu toplamı (TL).
 * Ölçüldü: iade edilen siparişte "İade Kargo Bedeli" ayrı kalem olarak geliyor (desi listesinden).
 */
export function iadeKargoKalemleriniTopla(kalemler: Array<Record<string, unknown>>): Map<string, number> {
  const toplam = new Map<string, number>();
  for (const k of kalemler) {
    const no = cleanId(k.orderNumber);
    const tutar = finiteNumber(k.amount);
    const tur = String(k.shipmentPackageType ?? "");
    if (!no || tutar == null || tutar <= 0 || !/İade|Iade/i.test(tur)) continue;
    toplam.set(no, Math.round(((toplam.get(no) ?? 0) + tutar) * 100) / 100);
  }
  return toplam;
}

/** Pencere içindeki tüm kargo faturalarının kalemleri → sipariş no → gidiş kargosu (+ `iade` haritası). */
async function kargoFaturaKalemleri(
  client: TrendyolClient,
  startDate: number,
  endDate: number
): Promise<Map<string, number> & { iade: Map<string, number> }> {
  const faturalar: string[] = [];
  for (let bas = startDate; bas <= endDate; bas += MAX_WINDOW_MS) {
    const bit = Math.min(endDate, bas + MAX_WINDOW_MS - 1);
    const sayfa = await client.listOtherFinancials({ startDate: bas, endDate: bit, transactionType: "DeductionInvoices" });
    for (const k of sayfa.content ?? []) {
      const id = cleanId(k.id);
      if (id && /Kargo/i.test(String(k.transactionType ?? "")) && !faturalar.includes(id)) faturalar.push(id);
    }
  }
  const kalemler: Array<Record<string, unknown>> = [];
  for (const id of faturalar) {
    for (let p = 0; p < 20; p++) {
      const y = await client.listCargoInvoiceItems(id, { page: p, size: 500 });
      const c = y.content ?? [];
      kalemler.push(...c);
      if (c.length < 500) break;
    }
  }
  return Object.assign(kargoKalemleriniTopla(kalemler), { iade: iadeKargoKalemleriniTopla(kalemler) });
}

/**
 * Gerçek kargoyu ilgili siparişin kaydına yazar. Kargo faturası sipariş NUMARASIYLA geliyor;
 * aynı numaranın birden çok paketi varsa hangisine ait olduğu bilinmez → yazılmaz (tahmin kalır).
 */
export function kargoYazmaIfadeleri(
  aggregates: TrendyolCommissionAggregate[],
  kargo: ReadonlyMap<string, number>
): Array<{ sql: string; args: unknown[] }> {
  const paketSayisi = new Map<string, number>();
  for (const a of aggregates) paketSayisi.set(a.orderNumber, (paketSayisi.get(a.orderNumber) ?? 0) + 1);
  const ifadeler: Array<{ sql: string; args: unknown[] }> = [];
  for (const a of aggregates) {
    const tutar = kargo.get(a.orderNumber);
    if (tutar == null || paketSayisi.get(a.orderNumber) !== 1) continue;
    ifadeler.push({
      sql: `UPDATE "PlatformOrderFinancial" SET "cargoKurus" = ?
             WHERE "platform" = 'trendyol' AND "externalOrderId" = ? AND "cargoKurus" IS NOT ?`,
      args: [tlToKurus(tutar), a.externalOrderId, tlToKurus(tutar)],
    });
  }
  return ifadeler;
}

/**
 * İade kargosunu siparişin kaydına yazar. İade faturası satıştan haftalarca sonra geldiği için
 * bu turun satış penceresine bakılmaz: kayıt sipariş NUMARASIYLA bulunur — numaranın tek paketi
 * (tek kaydı) varsa. Değer aynıysa yazılmaz.
 */
export function iadeKargoYazmaIfadeleri(iade: ReadonlyMap<string, number>): Array<{ sql: string; args: unknown[] }> {
  return [...iade].map(([no, tutar]) => ({
    sql: `UPDATE "PlatformOrderFinancial" SET "returnCargoKurus" = ?
           WHERE "platform" = 'trendyol' AND "orderNumber" = ? AND "returnCargoKurus" IS NOT ?
             AND (SELECT COUNT(*) FROM "PlatformOrderFinancial" p
                   WHERE p."platform" = 'trendyol' AND p."orderNumber" = ?) = 1`,
    args: [tlToKurus(tutar), no, tlToKurus(tutar), no],
  }));
}

async function kargoKayitlariniYaz(
  aggregates: TrendyolCommissionAggregate[],
  kargo: ReadonlyMap<string, number> & { iade?: ReadonlyMap<string, number> }
): Promise<number> {
  const ifadeler = [...kargoYazmaIfadeleri(aggregates, kargo), ...iadeKargoYazmaIfadeleri(kargo.iade ?? new Map())];
  if (ifadeler.length > 0 && !(await batchWrite(ifadeler))) {
    for (const ifade of ifadeler) await prisma.$executeRawUnsafe(ifade.sql, ...(ifade.args as never[]));
  }
  return ifadeler.length;
}

/**
 * Settlement toplamlarını `PlatformOrderFinancial`'a yazar — TEK istekte.
 *
 * NEDEN (19 Kas 2026 denetimi): 300-500 satır 50'lik `$transaction` dilimlerinde TEK TEK upsert
 * ediliyordu. Her ifade ayrı gidiş-dönüş ve işlem boyunca kullanıcı şeridinin kilidi tutuluyordu
 * (en az 30-50 sn boyunca uygulamadaki her sorgu bekliyordu). Yazılan satırlar AYNI — eşitlik
 * testi: trendyol-finance-yazma.test.ts. Toplu yazma yoksa (yerel mod) eski yol çalışır.
 */
export async function komisyonKayitlariniYaz(aggregates: TrendyolCommissionAggregate[], syncedAt: Date): Promise<void> {
  if (aggregates.length === 0) return;
  if (await batchWrite(komisyonYazmaIfadeleri(aggregates, syncedAt))) return;
  await komisyonKayitlariniPrismaIleYaz(aggregates, syncedAt);
}

/** Saf: Prisma `upsert`'ün yazdığının AYNISINI yazan ifadeler (tarihler Prisma biçiminde). */
export function komisyonYazmaIfadeleri(
  aggregates: TrendyolCommissionAggregate[],
  syncedAt: Date
): Array<{ sql: string; args: unknown[] }> {
  const sync = toDbDate(syncedAt);
  return aggregates.map((row) => ({
    sql: `INSERT INTO "PlatformOrderFinancial"
            ("id", "platform", "externalOrderId", "orderNumber", "grossRevenueKurus", "commissionKurus",
             "sellerRevenueKurus", "transactionCount", "sourceUpdatedAt", "syncedAt")
          VALUES (?, 'trendyol', ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT ("platform", "externalOrderId") DO UPDATE SET
            "orderNumber" = excluded."orderNumber",
            "grossRevenueKurus" = excluded."grossRevenueKurus",
            "commissionKurus" = excluded."commissionKurus",
            "sellerRevenueKurus" = excluded."sellerRevenueKurus",
            "transactionCount" = excluded."transactionCount",
            "sourceUpdatedAt" = excluded."sourceUpdatedAt",
            "syncedAt" = excluded."syncedAt"`,
    args: [
      `pof:trendyol:${row.externalOrderId}`,
      row.externalOrderId,
      row.orderNumber,
      tlToKurus(row.grossRevenue),
      tlToKurus(row.commission),
      tlToKurus(row.sellerRevenue),
      row.transactionCount,
      row.sourceUpdatedAt ? toDbDate(row.sourceUpdatedAt) : null,
      sync,
    ],
  }));
}

/** Eski yol (toplu yazmanın olmadığı mod için) — davranışı değişmedi. */
export async function komisyonKayitlariniPrismaIleYaz(aggregates: TrendyolCommissionAggregate[], syncedAt: Date): Promise<void> {
  for (let offset = 0; offset < aggregates.length; offset += 50) {
    const chunk = aggregates.slice(offset, offset + 50);
    await prisma.$transaction(
      chunk.map((row) =>
        prisma.platformOrderFinancial.upsert({
          where: {
            platform_externalOrderId: {
              platform: "trendyol",
              externalOrderId: row.externalOrderId,
            },
          },
          create: {
            id: `pof:trendyol:${row.externalOrderId}`,
            platform: "trendyol",
            externalOrderId: row.externalOrderId,
            orderNumber: row.orderNumber,
            grossRevenueKurus: tlToKurus(row.grossRevenue),
            commissionKurus: tlToKurus(row.commission),
            sellerRevenueKurus: tlToKurus(row.sellerRevenue),
            transactionCount: row.transactionCount,
            sourceUpdatedAt: row.sourceUpdatedAt,
            syncedAt,
          },
          update: {
            orderNumber: row.orderNumber,
            grossRevenueKurus: tlToKurus(row.grossRevenue),
            commissionKurus: tlToKurus(row.commission),
            sellerRevenueKurus: tlToKurus(row.sellerRevenue),
            transactionCount: row.transactionCount,
            sourceUpdatedAt: row.sourceUpdatedAt,
            syncedAt,
          },
        })
      )
    );
  }
}

/** Kayıtlı kârı gerçek komisyonla yakalanmış, kâra giren kargosu bilinen kayıt + gerçek kargo. */
export interface KargoBekleyenKayit {
  id: string;
  profitKurus: number;
  /** Kayıtlı kâra giren kargo (brüt kuruş). */
  cargoKurus: number;
  inputVatCreditKurus: number | null;
  /** Gerçek kargo (brüt kuruş). */
  actualCargoKurus: number;
}

/**
 * SAF: gerçek kargonun kayıtlı kâra FARK olarak işlenmesi. Kargo faturası KDV'lidir: tahmini kargonun
 * içindeki KDV geri alınır, gerçeğinki indirilir — kâr (tahmin − gerçek) × (1 − KDV payı) kadar değişir.
 */
export function gercekKargoGuncellemeleri(
  kayitlar: KargoBekleyenKayit[],
  vatRate: number
): Array<{ id: string; profitKurus: number; inputVatCreditKurus: number | null; cargoKurus: number }> {
  const pay = vatRate > 0 ? vatRate / (100 + vatRate) : 0;
  return kayitlar
    .filter((k) => k.actualCargoKurus !== k.cargoKurus)
    .map((k) => {
      const fark = k.cargoKurus - k.actualCargoKurus;
      return {
        id: k.id,
        profitKurus: Math.round(k.profitKurus + fark * (1 - pay)),
        inputVatCreditKurus:
          k.inputVatCreditKurus == null ? null : Math.round(k.inputVatCreditKurus - fark * pay),
        cargoKurus: k.actualCargoKurus,
      };
    });
}

/**
 * Gerçek kargoyu, listeden düşmüş siparişlerin KAYITLI kârına işler (listedekiler sipariş ekranında
 * zaten gerçek kargoyla hesaplanıyor). Yalnız kârı gerçek komisyonla yakalanmış ve kâra giren kargosu
 * saklanmış kayıtlar — eski kayıtlarda kargo saklı değil; onlar "Bu ayı yeniden hesapla" ile düzelir.
 */
export async function gercekKargolariKayitlaraIsle(): Promise<number> {
  const [satirlar, ayarlar] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT s."id", s."profitKurus", s."cargoKurus", s."inputVatCreditKurus", f."cargoKurus" AS "gercekKargo"
         FROM "OrderFinanceSnapshot" s
         JOIN "PlatformOrderFinancial" f
           ON f."platform" = 'trendyol' AND f."externalOrderId" = s."externalOrderId"
        WHERE s."platform" = 'trendyol' AND s."profitSource" = 'platform'
          AND s."statusKind" <> 'cancelled' AND s."profitKurus" IS NOT NULL AND s."profitPartial" = 0
          AND s."cargoKurus" IS NOT NULL AND f."cargoKurus" IS NOT NULL
          AND (s."actualFeesKurus" IS NULL OR s."actualFeesKurus" <> f."cargoKurus")`
    ),
    prisma.appSetting.findMany(),
  ]);
  const sayi = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v));
  const guncellemeler = gercekKargoGuncellemeleri(
    satirlar.map((r) => ({
      id: String(r.id),
      profitKurus: sayi(r.profitKurus),
      cargoKurus: sayi(r.cargoKurus),
      inputVatCreditKurus: r.inputVatCreditKurus == null ? null : sayi(r.inputVatCreditKurus),
      actualCargoKurus: sayi(r.gercekKargo),
    })),
    vatRateOf(Object.fromEntries(ayarlar.map((row) => [row.key, row.value])))
  );
  // Kargosu zaten gerçeğe eşit olanlar: yalnız "işlendi" damgası (bir daha bakılmasın).
  const damga = satirlar
    .filter((r) => sayi(r.cargoKurus) === sayi(r.gercekKargo))
    .map((r) => ({
      sql: `UPDATE "OrderFinanceSnapshot" SET "actualFeesKurus" = ? WHERE "id" = ?`,
      args: [sayi(r.gercekKargo), String(r.id)] as unknown[],
    }));
  const ifadeler = [
    ...guncellemeler.map((g) => ({
      sql: `UPDATE "OrderFinanceSnapshot"
               SET "profitKurus" = ?, "inputVatCreditKurus" = ?, "cargoKurus" = ?, "actualFeesKurus" = ?
             WHERE "id" = ? AND "profitSource" = 'platform'`,
      args: [g.profitKurus, g.inputVatCreditKurus, g.cargoKurus, g.cargoKurus, g.id] as unknown[],
    })),
    ...damga,
  ];
  if (ifadeler.length === 0) return 0;
  if (!(await batchWrite(ifadeler))) {
    for (const ifade of ifadeler) await prisma.$executeRawUnsafe(ifade.sql, ...ifade.args);
  }
  return guncellemeler.length;
}

/** Gerçek komisyonu henüz işlenmemiş, kârı TAM hesaplanmış kayıt + o siparişin netleşmiş ödemesi. */
export interface KomisyonBekleyenKayit {
  id: string;
  revenueKurus: number;
  profitKurus: number;
  estimatedCommissionKurus: number;
  inputVatCreditKurus: number | null;
  grossRevenueKurus: number;
  commissionKurus: number;
}

export interface KomisyonGuncellemesi {
  id: string;
  profitKurus: number;
  inputVatCreditKurus: number | null;
  actualCommissionKurus: number;
}

/**
 * Kayıtlı kâra yalnız KOMİSYON FARKI işlenir (SAF).
 *
 * Neden tüm kâr yeniden hesaplanmıyor: tam yakalanmış kâr sonradan değişen maliyet/kural
 * düzenlemeleriyle oynamaz (bkz. `shouldReplaceCapturedProfit`). Gerçek komisyon gelince değişen
 * tek şey komisyondur; kural `applyActualCommissionToProfit` — sipariş ekranının kullandığının
 * ta kendisi (ödeme sipariş tutarıyla %1'den fazla sapıyorsa İŞLENMEZ).
 */
export function gercekKomisyonGuncellemeleri(
  kayitlar: KomisyonBekleyenKayit[],
  vatRate: number
): KomisyonGuncellemesi[] {
  const vatFactor = vatRate > 0 ? vatRate / (100 + vatRate) : 0;
  const sonuc: KomisyonGuncellemesi[] = [];
  for (const k of kayitlar) {
    const uygulanan = applyActualCommissionToProfit({
      profit: k.profitKurus / 100,
      profitPartial: false,
      orderRevenue: k.revenueKurus / 100,
      estimatedCommission: k.estimatedCommissionKurus / 100,
      actualCommission: k.commissionKurus / 100,
      settlementRevenue: k.grossRevenueKurus / 100,
      vatRate,
    });
    if (!uygulanan.applied || uygulanan.profit == null) continue;
    sonuc.push({
      id: k.id,
      profitKurus: Math.round(uygulanan.profit * 100),
      // Komisyonun içindeki indirilecek KDV de gerçek tutara göre değişir (sipariş ekranıyla aynı).
      inputVatCreditKurus:
        k.inputVatCreditKurus == null
          ? null
          : k.inputVatCreditKurus +
            Math.round((k.commissionKurus - k.estimatedCommissionKurus) * vatFactor),
      actualCommissionKurus: k.commissionKurus,
    });
  }
  return sonuc;
}

/**
 * Netleşmiş gerçek komisyonu KAYITLI kârlara işle.
 *
 * Sipariş ekranı bunu yalnız son 60 günün siparişleri için yapabiliyor; daha eski siparişin
 * komisyonu indirilse de kâra hiç işlenmiyor ve Raporlar "komisyon kaydı var ama kâra
 * işlenemiyor" demeye devam ediyordu. Döndürdüğü sayı güncellenen sipariş adedidir.
 */
export async function gercekKomisyonlariKayitlaraIsle(): Promise<number> {
  const [satirlar, ayarlar] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT s."id", s."revenueKurus", s."profitKurus", s."estimatedCommissionKurus",
              s."inputVatCreditKurus", f."grossRevenueKurus", f."commissionKurus"
         FROM "OrderFinanceSnapshot" s
         JOIN "PlatformOrderFinancial" f
           ON f."platform" = 'trendyol' AND f."externalOrderId" = s."externalOrderId"
        WHERE s."platform" = 'trendyol' AND s."actualCommissionKurus" IS NULL
          AND s."statusKind" <> 'cancelled' AND s."profitKurus" IS NOT NULL
          AND s."profitPartial" = 0 AND s."estimatedCommissionKurus" IS NOT NULL`
    ),
    prisma.appSetting.findMany(),
  ]);
  const sayi = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v));
  const guncellemeler = gercekKomisyonGuncellemeleri(
    satirlar.map((r) => ({
      id: String(r.id),
      revenueKurus: sayi(r.revenueKurus),
      profitKurus: sayi(r.profitKurus),
      estimatedCommissionKurus: sayi(r.estimatedCommissionKurus),
      inputVatCreditKurus: r.inputVatCreditKurus == null ? null : sayi(r.inputVatCreditKurus),
      grossRevenueKurus: sayi(r.grossRevenueKurus),
      commissionKurus: sayi(r.commissionKurus),
    })),
    vatRateOf(Object.fromEntries(ayarlar.map((row) => [row.key, row.value])))
  );
  if (guncellemeler.length === 0) return 0;

  // Koşul tekrar sorulur: arada sipariş ekranı aynı satırı yazdıysa ezilmez.
  const ifadeler = guncellemeler.map((g) => ({
    sql: `UPDATE "OrderFinanceSnapshot"
             SET "profitKurus" = ?, "inputVatCreditKurus" = ?, "actualCommissionKurus" = ?,
                 "profitSource" = 'platform'
           WHERE "id" = ? AND "actualCommissionKurus" IS NULL`,
    args: [g.profitKurus, g.inputVatCreditKurus, g.actualCommissionKurus, g.id],
  }));
  if (!(await batchWrite(ifadeler))) {
    for (const ifade of ifadeler) await prisma.$executeRawUnsafe(ifade.sql, ...ifade.args);
  }
  return guncellemeler.length;
}
