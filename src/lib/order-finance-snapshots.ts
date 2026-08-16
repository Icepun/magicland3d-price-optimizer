import { adRateSnapshot, adRateFor } from "@/lib/ad-rate";
import { prisma } from "@/lib/prisma";
import { resolveProductCost } from "@/core/product-cost";
import {
  resolveOrderProfit,
  type OrderProfitLine,
  type OrderProfitProduct,
} from "@/core/order-profit";
import type {
  CargoRuleInput,
  CommissionRuleInput,
  ExpenseRuleInput,
} from "@/core/types";
import { batchWrite } from "./libsql-batch";
import { parseDbDate, toDbDate } from "./sqlite-date";
import {
  FINANCE_CALCULATION_VERSION,
  kurusToTl,
  monthKey,
  tlToKurus,
} from "./monthly-finance";

/**
 * Siparişin TEK BİR kaleminin kalıcı geçmişe yazılan hâli.
 * Sipariş düzeyi özet "hangi üründen kaç adet sattık" sorusunu yanıtlamıyordu ve pazaryeri
 * penceresi (30-60 gün) dolunca bu bilgi geri getirilemez biçimde kayboluyordu.
 */
export interface FinanceSnapshotItem {
  /** Eşleşen ürün (eşleşmediyse null — satır yine de kaydedilir, adıyla). */
  productId: string | null;
  productName: string;
  quantity: number;
  /** Adet fiyatı (TL). */
  unitPrice: number;
}

export interface FinanceSnapshotOrder {
  platform: string;
  id: string;
  orderNumber: string;
  date: string | null;
  total: number;
  profit: number | null;
  profitPartial: boolean;
  profitSource?: "calculated" | "platform" | "manual";
  estimatedCommission?: number;
  actualCommission?: number | null;
  statusKind: string;
  currency: string;
  /**
   * Satıştan doğan (hesaplanan) KDV — TL. Kâr motorunun (resolveOrderProfit) KENDİ çıktısı;
   * burada yeniden hesaplanmaz. Verilmezse "bilinmiyor" olarak kaydedilir ve KDV özetine girmez.
   */
  outputVat?: number | null;
  /** Girdilerden indirilecek KDV — TL. Aynı motor çıktısı. */
  inputVatCredit?: number | null;
}

export function canonicalFinanceOrderId(platform: string, externalOrderId: string): string {
  if (platform !== "shopify") return externalOrderId;
  if (externalOrderId.startsWith("sh-")) return externalOrderId;
  const gidMatch = externalOrderId.match(/\/Order\/([^/]+)$/i);
  return `sh-${gidMatch?.[1] ?? externalOrderId.replace(/^shopify-/, "")}`;
}

export function shouldReplaceCapturedProfit(
  existing: {
    revenueKurus: number;
    profitKurus: number | null;
    profitPartial: boolean;
    profitSource?: string;
    actualCommissionKurus?: number | null;
  } | null,
  incoming: {
    revenueKurus: number;
    profitKurus: number | null;
    profitPartial: boolean;
    profitSource?: string;
    actualCommissionKurus?: number | null;
  }
): boolean {
  // Tam hesap ilk kez yakalandıktan sonra maliyet/rule düzenlemeleri geçmiş ayı
  // geriye dönük oynatmasın. Gelir değişirse (iade/order edit) veya eksik hesap
  // daha sonra tamamlanırsa yeni değeri kabul ederiz.
  if (!existing || existing.revenueKurus !== incoming.revenueKurus) return true;
  if (existing.profitKurus == null && incoming.profitKurus != null) return true;
  // Platformun gerçek komisyonu sonradan oluşur (genelde teslimden sonra). Bu bilgi
  // hesaplanan değerden daha güçlüdür ve tutar değişirse geçmiş snapshot da yenilenmelidir.
  if (
    incoming.profitSource === "platform" &&
    (existing.profitSource !== "platform" ||
      existing.actualCommissionKurus !== incoming.actualCommissionKurus)
  ) {
    return true;
  }
  return (
    existing.profitPartial &&
    !incoming.profitPartial &&
    incoming.profitKurus != null
  );
}

function snapshotKey(platform: string, externalOrderId: string): string {
  return JSON.stringify([platform, externalOrderId]);
}

/** Snapshot satırına yazılan alanlar (syncedAt dahil). */
type SnapshotWriteData = {
  orderNumber: string;
  orderedAt: Date;
  revenueKurus: number;
  profitKurus: number | null;
  profitPartial: boolean;
  profitSource: string;
  estimatedCommissionKurus: number | null;
  actualCommissionKurus: number | null;
  outputVatKurus: number | null;
  inputVatCreditKurus: number | null;
  statusKind: string;
  currency: string;
  calculationVersion: number;
  syncedAt: Date;
};

/** Snapshot satırında yazmayı gerektiren bir alan değişmiş mi? (syncedAt HARİÇ — o yalnız
 *  "en son ne zaman bakıldı" damgası; tek başına değişmesi yeniden yazmayı haklı çıkarmaz.) */
type SnapshotComparable = Omit<SnapshotWriteData, "syncedAt">;

/**
 * DEĞİŞEN alanların adları (boş dizi = yazmaya gerek yok).
 *
 * NEDEN alan ADI dönüyoruz: "değişen-only" kuralı çalışırken bile bir tur 414 satır
 * yazabiliyor ve tur sonucu yalnız SAYIYI söylediği için hangi alanın oynadığı hiçbir yerden
 * okunamıyordu — sebebi bulmak elle veritabanı arkeolojisi gerektirdi. Artık her tur
 * "hangi alan yüzünden kaç satır yazıldı" bilgisini taşır; aynı sorun bir daha çıkarsa
 * TEK yenilemede görünür.
 */
export function snapshotChangedFields(
  existing: SnapshotComparable,
  next: SnapshotComparable
): string[] {
  const changed: string[] = [];
  if (existing.orderNumber !== next.orderNumber) changed.push("orderNumber");
  if (existing.orderedAt.getTime() !== next.orderedAt.getTime()) changed.push("orderedAt");
  if (existing.revenueKurus !== next.revenueKurus) changed.push("revenueKurus");
  if (existing.profitKurus !== next.profitKurus) changed.push("profitKurus");
  if (existing.profitPartial !== next.profitPartial) changed.push("profitPartial");
  if (existing.profitSource !== next.profitSource) changed.push("profitSource");
  if (existing.estimatedCommissionKurus !== next.estimatedCommissionKurus) {
    changed.push("estimatedCommissionKurus");
  }
  if (existing.actualCommissionKurus !== next.actualCommissionKurus) {
    changed.push("actualCommissionKurus");
  }
  if (existing.outputVatKurus !== next.outputVatKurus) changed.push("outputVatKurus");
  if (existing.inputVatCreditKurus !== next.inputVatCreditKurus) {
    changed.push("inputVatCreditKurus");
  }
  if (existing.statusKind !== next.statusKind) changed.push("statusKind");
  if (existing.currency !== next.currency) changed.push("currency");
  if (existing.calculationVersion !== next.calculationVersion) {
    changed.push("calculationVersion");
  }
  return changed;
}

/** Kalem satırına yazılan alanlar (syncedAt hariç — o yalnız damga). */
type ItemWriteData = {
  orderedAt: Date;
  productId: string | null;
  productName: string;
  quantity: number;
  unitPriceKurus: number;
  lineRevenueKurus: number;
  statusKind: string;
  currency: string;
};

type ExistingItemRow = ItemWriteData & { lineIndex: number };

type WriteStatement = { sql: string; args: unknown[] };

/** Kalem satırında DEĞİŞEN alanların adları (boş dizi = yazmaya gerek yok). */
function itemChangedFields(existing: ExistingItemRow, next: ItemWriteData): string[] {
  const changed: string[] = [];
  if (existing.orderedAt.getTime() !== next.orderedAt.getTime()) changed.push("orderedAt");
  if (existing.productId !== next.productId) changed.push("productId");
  if (existing.productName !== next.productName) changed.push("productName");
  if (existing.quantity !== next.quantity) changed.push("quantity");
  if (existing.unitPriceKurus !== next.unitPriceKurus) changed.push("unitPriceKurus");
  if (existing.lineRevenueKurus !== next.lineRevenueKurus) changed.push("lineRevenueKurus");
  if (existing.statusKind !== next.statusKind) changed.push("statusKind");
  if (existing.currency !== next.currency) changed.push("currency");
  return changed;
}

// ⚠️ TARİHLER `toDbDate()` İLE YAZILIR — bu süreçteki Prisma motorunun kolona yazacağı değerin
// AYNISI (Turso/libSQL adapter → ISO metin, klasik yerel motor → epoch-ms tamsayı). Eski kod
// koşulsuz `getTime()` yazıyordu; telefon ve Prisma ise Turso'da ISO metin yazıyordu. SQLite'ta
// tamsayı her zaman metinden küçük sayıldığı için Raporlar'ın `orderedAt >= …` filtresi
// satırların çoğunu SESSİZCE eliyordu. Gerekçe ve ölçüm: src/lib/sqlite-date.ts.
function snapshotStatement(
  platform: string,
  externalOrderId: string,
  data: SnapshotWriteData
): WriteStatement {
  return {
    sql: `INSERT INTO "OrderFinanceSnapshot" (
            "id","platform","externalOrderId","orderNumber","orderedAt","revenueKurus","profitKurus",
            "profitPartial","profitSource","estimatedCommissionKurus","actualCommissionKurus",
            "outputVatKurus","inputVatCreditKurus",
            "statusKind","currency","calculationVersion","syncedAt"
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT("platform","externalOrderId") DO UPDATE SET
            "orderNumber" = excluded."orderNumber",
            "orderedAt" = excluded."orderedAt",
            "revenueKurus" = excluded."revenueKurus",
            "profitKurus" = excluded."profitKurus",
            "profitPartial" = excluded."profitPartial",
            "profitSource" = excluded."profitSource",
            "estimatedCommissionKurus" = excluded."estimatedCommissionKurus",
            "actualCommissionKurus" = excluded."actualCommissionKurus",
            "outputVatKurus" = excluded."outputVatKurus",
            "inputVatCreditKurus" = excluded."inputVatCreditKurus",
            "statusKind" = excluded."statusKind",
            "currency" = excluded."currency",
            "calculationVersion" = excluded."calculationVersion",
            "syncedAt" = excluded."syncedAt"`,
    args: [
      `finance:${platform}:${externalOrderId}`,
      platform,
      externalOrderId,
      data.orderNumber,
      toDbDate(data.orderedAt),
      data.revenueKurus,
      data.profitKurus,
      data.profitPartial ? 1 : 0,
      data.profitSource,
      data.estimatedCommissionKurus,
      data.actualCommissionKurus,
      data.outputVatKurus,
      data.inputVatCreditKurus,
      data.statusKind,
      data.currency,
      data.calculationVersion,
      toDbDate(data.syncedAt),
    ],
  };
}

function itemStatement(
  platform: string,
  externalOrderId: string,
  lineIndex: number,
  data: ItemWriteData,
  syncedAt: Date
): WriteStatement {
  return {
    sql: `INSERT INTO "OrderItemSnapshot" (
            "id","platform","externalOrderId","lineIndex","orderedAt","productId","productName",
            "quantity","unitPriceKurus","lineRevenueKurus","statusKind","currency","syncedAt"
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT("platform","externalOrderId","lineIndex") DO UPDATE SET
            "orderedAt" = excluded."orderedAt",
            "productId" = excluded."productId",
            "productName" = excluded."productName",
            "quantity" = excluded."quantity",
            "unitPriceKurus" = excluded."unitPriceKurus",
            "lineRevenueKurus" = excluded."lineRevenueKurus",
            "statusKind" = excluded."statusKind",
            "currency" = excluded."currency",
            "syncedAt" = excluded."syncedAt"`,
    args: [
      `item:${platform}:${externalOrderId}:${lineIndex}`,
      platform,
      externalOrderId,
      lineIndex,
      toDbDate(data.orderedAt),
      data.productId,
      data.productName,
      data.quantity,
      data.unitPriceKurus,
      data.lineRevenueKurus,
      data.statusKind,
      data.currency,
      toDbDate(syncedAt),
    ],
  };
}

/** Sipariş küçüldüyse (iade/iptal ile kalem düştü) artık olmayan satırları temizle. */
function itemTrimStatement(
  platform: string,
  externalOrderId: string,
  lineCount: number
): WriteStatement {
  return {
    sql: `DELETE FROM "OrderItemSnapshot"
           WHERE "platform" = ? AND "externalOrderId" = ? AND "lineIndex" >= ?`,
    args: [platform, externalOrderId, lineCount],
  };
}

/** Yazımı TEK turda gönder. Uzak-HTTP'de tek istek; yerel/replica modunda aynı ifadeler sırayla. */
async function flushWrites(statements: WriteStatement[]): Promise<void> {
  if (statements.length === 0) return;
  if (await batchWrite(statements)) return;
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement.sql, ...statement.args);
  }
}

/**
 * Bir yazma turunun sonucu — arka planda çalışırken de ölçülebilsin diye döner.
 *
 * `writeReasons` / `itemWriteReasons`: hangi alan yüzünden kaç satır yazıldı.
 * "new" = satır ilk kez oluştu, "trim" = küçülen siparişin fazla kalemleri silindi.
 * Sağlıklı bir yenilemede ikisi de boştur; dolu çıkıyorsa hangi alanın oynadığı
 * doğrudan görünür (eskiden bu bilgi hiçbir yerde yoktu).
 */
export interface FinanceSnapshotWriteResult {
  /** Kaydedilmeye uygun (manuel olmayan, tarihi olan) sipariş sayısı. */
  eligibleOrders: number;
  /** Gerçekten yazılan sipariş özeti sayısı — değişmeyenler yazılmaz. */
  writtenOrders: number;
  /** Gerçekten yazılan/silinen kalem ifadesi sayısı. */
  writtenItems: number;
  /** Alan adı → o alan değiştiği için yazılan sipariş özeti sayısı. */
  writeReasons: Record<string, number>;
  /** Alan adı → o alan değiştiği için yazılan kalem satırı sayısı. */
  itemWriteReasons: Record<string, number>;
}

/** Boş bir yazma sonucu (hata/erken çıkış yollarında tek kaynak). */
function emptyWriteResult(eligibleOrders = 0): FinanceSnapshotWriteResult {
  return {
    eligibleOrders,
    writtenOrders: 0,
    writtenItems: 0,
    writeReasons: {},
    itemWriteReasons: {},
  };
}

function countReason(into: Record<string, number>, keys: string[]): void {
  for (const key of keys) into[key] = (into[key] ?? 0) + 1;
}

/** Ham sorgu sonucu tamsayıları sürücüye göre BigInt gelebilir — karşılaştırmadan önce sadeleştir. */
function toInt(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

/** Bu siparişler için kayıtlı kalem satırlarını oku (tek okuma turu, 500'lük dilimler). */
async function readExistingItems(
  externalIds: string[]
): Promise<Map<string, ExistingItemRow[]>> {
  const byOrder = new Map<string, ExistingItemRow[]>();
  for (let offset = 0; offset < externalIds.length; offset += READ_CHUNK) {
    const slice = externalIds.slice(offset, offset + READ_CHUNK);
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "platform","externalOrderId","lineIndex","orderedAt","productId","productName",
              "quantity","unitPriceKurus","lineRevenueKurus","statusKind","currency"
         FROM "OrderItemSnapshot"
        WHERE "externalOrderId" IN (${slice.map(() => "?").join(",")})`,
      ...slice
    );
    for (const row of rows) {
      const key = snapshotKey(String(row.platform), String(row.externalOrderId));
      const list = byOrder.get(key) ?? [];
      list.push({
        lineIndex: toInt(row.lineIndex),
        // Depolama tipi ne olursa olsun (eski epoch-ms tamsayı / kanonik ISO metin) çözülür.
        orderedAt: parseDbDate(row.orderedAt) ?? new Date(0),
        productId: row.productId == null ? null : String(row.productId),
        productName: String(row.productName ?? ""),
        quantity: toInt(row.quantity),
        unitPriceKurus: toInt(row.unitPriceKurus),
        lineRevenueKurus: toInt(row.lineRevenueKurus),
        statusKind: String(row.statusKind ?? ""),
        currency: String(row.currency ?? "TRY"),
      });
      byOrder.set(key, list);
    }
  }
  return byOrder;
}

// IN(...) parametre sayısı SQLite'ın değişken sınırına (999) dayanmasın: sipariş hacmi
// büyüdükçe 60 günlük pencere binlerce satıra çıkabilir.
const READ_CHUNK = 500;

export interface PersistOrderFinanceSnapshotsOptions {
  /**
   * Yakalanmış kârı KOŞULSUZ yenile.
   *
   * Normal yenilemede tam hesaplanmış bir sipariş bir daha oynatılmaz (geçmiş ay kendiliğinden
   * kaymasın diye). Ama kullanıcı maliyeti düzeltip "yeniden hesapla" dediğinde eski rakamda
   * donmak yanlış: Siparişler ekranı düzelirken Raporlar eski kalıyordu. Bu bayrak SADECE o
   * kullanıcı eyleminde açılır; "yalnız değişeni yaz" kuralı yine geçerlidir.
   */
  replaceCapturedProfit?: boolean;
}

/** Kayıtlı satırın karşılaştırmaya giren hâli (yalnız gerekli alanlar). */
export type ExistingSnapshotRow = SnapshotComparable;

/** Siparişin kuruşa çevrilmiş hâli — TL→kuruş dönüşümü TEK yerde kalsın diye ayrı. */
function toIncomingSnapshot(order: FinanceSnapshotOrder) {
  return {
    revenueKurus: tlToKurus(order.total),
    profitKurus: order.profit == null ? null : tlToKurus(order.profit),
    profitPartial: order.profitPartial,
    profitSource: order.profitSource ?? "calculated",
    estimatedCommissionKurus:
      order.estimatedCommission == null ? null : tlToKurus(order.estimatedCommission),
    actualCommissionKurus:
      order.actualCommission == null ? null : tlToKurus(order.actualCommission),
    // KDV motorun çıktısından AYNEN taşınır; verilmediyse "bilinmiyor" (null) kalır.
    outputVatKurus: order.outputVat == null ? null : tlToKurus(order.outputVat),
    inputVatCreditKurus:
      order.inputVatCredit == null ? null : tlToKurus(order.inputVatCredit),
  };
}

/**
 * Kayıtlı satır + gelen sipariş → satıra YAZILACAK son hâl.
 *
 * TEK KAYNAK: hem gerçek yazım hem de "yazsaydık ne değişirdi" provası (kuru tur) bunu
 * çağırır. İki yerde ayrı ayrı kurulursa prova ile gerçek tur sessizce ayrışır ve
 * kullanıcıya yanlış bir "şu kadar sipariş değişecek" sayısı gösterilir.
 */
export function resolveSnapshotWriteData(
  existing: ExistingSnapshotRow | null,
  order: FinanceSnapshotOrder,
  orderedAt: Date,
  options: PersistOrderFinanceSnapshotsOptions = {}
): SnapshotComparable {
  const incoming = toIncomingSnapshot(order);
  const replaceProfit =
    options.replaceCapturedProfit === true ||
    shouldReplaceCapturedProfit(existing, incoming);
  return {
    orderNumber: order.orderNumber,
    orderedAt,
    revenueKurus: incoming.revenueKurus,
    profitKurus: replaceProfit ? incoming.profitKurus : existing?.profitKurus ?? null,
    profitPartial: replaceProfit
      ? incoming.profitPartial
      : existing?.profitPartial ?? incoming.profitPartial,
    profitSource: replaceProfit
      ? incoming.profitSource
      : existing?.profitSource ?? incoming.profitSource,
    estimatedCommissionKurus: replaceProfit
      ? incoming.estimatedCommissionKurus
      : existing?.estimatedCommissionKurus ?? incoming.estimatedCommissionKurus,
    actualCommissionKurus: replaceProfit
      ? incoming.actualCommissionKurus
      : existing?.actualCommissionKurus ?? incoming.actualCommissionKurus,
    // Bilinen bir KDV değerini "bilinmiyor" ile EZME: değeri taşımayan bir çağrı yeri
    // kayıtlı geçmişi silmemeli. Yeni değer varsa (yenileme/yeniden hesap) o kazanır.
    outputVatKurus: replaceProfit
      ? incoming.outputVatKurus ?? existing?.outputVatKurus ?? null
      : existing?.outputVatKurus ?? incoming.outputVatKurus,
    inputVatCreditKurus: replaceProfit
      ? incoming.inputVatCreditKurus ?? existing?.inputVatCreditKurus ?? null
      : existing?.inputVatCreditKurus ?? incoming.inputVatCreditKurus,
    statusKind: order.statusKind,
    currency: order.currency || "TRY",
    calculationVersion: replaceProfit
      ? FINANCE_CALCULATION_VERSION
      : existing?.calculationVersion ?? FINANCE_CALCULATION_VERSION,
  };
}

export async function persistOrderFinanceSnapshots(
  orders: FinanceSnapshotOrder[],
  /** Sipariş kimliği → kalemler. Verilmeyen siparişin kalem geçmişine DOKUNULMAZ. */
  itemsByOrderId?: ReadonlyMap<string, FinanceSnapshotItem[]>,
  options: PersistOrderFinanceSnapshotsOptions = {}
): Promise<FinanceSnapshotWriteResult> {
  const valid = orders.flatMap((order) => {
    // Manuel siparişin captured finansı ManualOrder satırındadır. Buraya da yazılırsa
    // aylık finans aynı satışı iki kez sayar ve mobilde atomik olmayan çift yazım doğar.
    if (order.platform === "manual") return [];
    if (!order.date) return [];
    const orderedAt = new Date(order.date);
    if (!Number.isFinite(orderedAt.getTime())) return [];
    const externalOrderId = canonicalFinanceOrderId(order.platform, order.id);
    return [{ order, orderedAt, externalOrderId }];
  });

  if (valid.length === 0) return emptyWriteResult();

  const syncedAt = new Date();

  // TEK OKUMA: eskiden 50'lik OR blokları hâlinde ayrı ayrı sorgulanıyordu (180 sipariş = 4 sorgu).
  // externalOrderId listesiyle tek sorgu yeter; platform ayrımı anahtar eşleşmesinde yapılır.
  const externalIds = [...new Set(valid.map((v) => v.externalOrderId))];
  const existingRows: Array<{
    platform: string;
    externalOrderId: string;
    orderNumber: string;
    orderedAt: Date;
    revenueKurus: number;
    profitKurus: number | null;
    profitPartial: boolean;
    calculationVersion: number;
    profitSource: string;
    actualCommissionKurus: number | null;
    estimatedCommissionKurus: number | null;
    outputVatKurus: number | null;
    inputVatCreditKurus: number | null;
    statusKind: string;
    currency: string;
  }> = [];
  for (let offset = 0; offset < externalIds.length; offset += READ_CHUNK) {
    const rows = await prisma.orderFinanceSnapshot.findMany({
      where: { externalOrderId: { in: externalIds.slice(offset, offset + READ_CHUNK) } },
      select: {
        platform: true,
        externalOrderId: true,
        orderNumber: true,
        orderedAt: true,
        revenueKurus: true,
        profitKurus: true,
        profitPartial: true,
        calculationVersion: true,
        profitSource: true,
        actualCommissionKurus: true,
        estimatedCommissionKurus: true,
        outputVatKurus: true,
        inputVatCreditKurus: true,
        statusKind: true,
        currency: true,
      },
    });
    existingRows.push(...rows);
  }
  const existingByKey = new Map(
    existingRows.map((row) => [snapshotKey(row.platform, row.externalOrderId), row])
  );

  // DEĞİŞEN-ONLY: tipik yenilemede 180 satırın tamamı zaten aynıdır. Hepsini yeniden yazmak
  // uzak-HTTP'de ~180 ardışık round-trip (~18sn) demekti ve libSQL adapter'ın süreç genelindeki
  // tek kilidini o süre boyunca tutarak TÜM uygulamayı bekletiyordu. Artık yalnız gerçekten
  // değişen satırlar yazılır (tipik: 0-3).
  const pending: Array<{
    platform: string;
    externalOrderId: string;
    data: SnapshotWriteData;
  }> = [];
  const writeReasons: Record<string, number> = {};

  for (const { order, orderedAt, externalOrderId } of valid) {
    const existing = existingByKey.get(snapshotKey(order.platform, externalOrderId)) ?? null;
    const data = resolveSnapshotWriteData(existing, order, orderedAt, options);

    // Satır zaten birebir aynıysa yazma (syncedAt damgası tek başına yazmayı haklı çıkarmaz).
    const changed = existing ? snapshotChangedFields(existing, data) : ["new"];
    if (changed.length === 0) continue;
    countReason(writeReasons, changed);

    pending.push({
      platform: order.platform,
      externalOrderId,
      data: { ...data, syncedAt },
    });
  }

  // ── Kalem geçmişi ────────────────────────────────────────────────────────────────────
  // Sipariş düzeyi özet "hangi üründen kaç adet sattık" sorusunu yanıtlamıyor; pazaryeri
  // penceresi dolunca o bilgi kalıcı olarak kayboluyordu. İptal edilen siparişlerin kalemleri
  // de yazılır — raporlar statusKind ile ayıklar.
  const itemPlans: Array<{
    platform: string;
    externalOrderId: string;
    rows: ItemWriteData[];
  }> = [];
  if (itemsByOrderId) {
    for (const { order, orderedAt, externalOrderId } of valid) {
      const lines = itemsByOrderId.get(order.id);
      // Kalem verilmediyse dokunma: "kalem yok" ile "bilgi gelmedi" aynı şey değil.
      if (!lines) continue;
      const rows: ItemWriteData[] = [];
      for (const line of lines) {
        const quantity = Math.round(line.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) continue;
        if (!Number.isFinite(line.unitPrice)) continue;
        const unitPriceKurus = tlToKurus(line.unitPrice);
        rows.push({
          orderedAt,
          productId: line.productId ?? null,
          productName: (line.productName || "Ürün").slice(0, 300),
          quantity,
          unitPriceKurus,
          // Satır cirosu adet fiyatının tam katıdır → kuruş toplamları her zaman tutar.
          lineRevenueKurus: unitPriceKurus * quantity,
          statusKind: order.statusKind,
          currency: order.currency || "TRY",
        });
      }
      itemPlans.push({ platform: order.platform, externalOrderId, rows });
    }
  }

  const itemStatements: WriteStatement[] = [];
  const itemWriteReasons: Record<string, number> = {};
  if (itemPlans.length > 0) {
    const existingItems = await readExistingItems([
      ...new Set(itemPlans.map((plan) => plan.externalOrderId)),
    ]);
    for (const plan of itemPlans) {
      const stored = existingItems.get(snapshotKey(plan.platform, plan.externalOrderId)) ?? [];
      const storedByIndex = new Map(stored.map((row) => [row.lineIndex, row]));
      plan.rows.forEach((row, lineIndex) => {
        const existing = storedByIndex.get(lineIndex);
        // Değişmeyen satıra HİÇ yazma (yenilemelerin çoğunda hiçbir şey değişmez).
        const changed = existing ? itemChangedFields(existing, row) : ["new"];
        if (changed.length === 0) return;
        countReason(itemWriteReasons, changed);
        itemStatements.push(
          itemStatement(plan.platform, plan.externalOrderId, lineIndex, row, syncedAt)
        );
      });
      const maxStoredIndex = stored.reduce((max, row) => Math.max(max, row.lineIndex), -1);
      // Kalem sayısı azaldıysa fazlalığı sil. Ama TÜM kalemleri silmeyiz: satırların geçici olarak
      // hiç gelmemesi (pazaryeri yanıtı eksik döndü) kalıcı geçmişi yok etmemeli.
      if (plan.rows.length > 0 && maxStoredIndex >= plan.rows.length) {
        countReason(itemWriteReasons, ["trim"]);
        itemStatements.push(
          itemTrimStatement(plan.platform, plan.externalOrderId, plan.rows.length)
        );
      }
    }
  }

  // Özet ve kalemler AYNI turda gider: uzak-HTTP'de tek istek, ek gidiş-dönüş yok.
  await flushWrites([
    ...pending.map(({ platform, externalOrderId, data }) =>
      snapshotStatement(platform, externalOrderId, data)
    ),
    ...itemStatements,
  ]);

  // Sağlıklı bir yenilemede burası hiç çalışmaz. Çalışıyorsa sebebi TEK satırda görünsün:
  // "hangi alan yüzünden kaç satır" bilgisi olmadan bu sorunun kaynağını bulmak elle
  // veritabanı arkeolojisi gerektiriyordu.
  if (pending.length > 0 || itemStatements.length > 0) {
    console.info(
      `[finance-snapshot] ${valid.length} siparişten ${pending.length} özet + ` +
        `${itemStatements.length} kalem yazıldı. Sipariş sebepleri: ` +
        `${JSON.stringify(writeReasons)} · Kalem sebepleri: ${JSON.stringify(itemWriteReasons)}`
    );
  }

  return {
    eligibleOrders: valid.length,
    writtenOrders: pending.length,
    writtenItems: itemStatements.length,
    writeReasons,
    itemWriteReasons,
  };
}

// ── Arka plan yazımı ────────────────────────────────────────────────────────────────────
// NEDEN: yazım sipariş listesi YANITININ içindeydi. İlk dolumda veya toplu statü değişen
// günlerde yüzlerce satır yazılıyor, libSQL'in süreç genelindeki tek kilidi o süre boyunca
// tutuluyor ve uygulama yarım-bir dakika donuyordu. Artık yanıt ANINDA gider, yazım arkada
// sürer. Hata YUTULMAZ: günlüğe yazılır ve son tur durumu okunabilir kalır (arayüz bir
// sonraki yenilemede kullanıcıyı uyarabilsin).

export interface FinanceSnapshotWriteStatus extends FinanceSnapshotWriteResult {
  ok: boolean;
  /** Hata varsa ham mesaj (arayüzde "Ayrıntı" altında gösterilir). */
  error?: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
}

type SnapshotJob = {
  orders: FinanceSnapshotOrder[];
  itemsByOrderId?: ReadonlyMap<string, FinanceSnapshotItem[]>;
};

/** Bekleyen iş üst sınırı. Aşılırsa EN ESKİ iş düşer: aynı pencereyi tazeleyen daha yeni
 *  bir tur zaten kuyrukta demektir, eskisini yazmak boşuna kilit tutar. */
const MAX_QUEUED_JOBS = 2;

const queue: SnapshotJob[] = [];
let running: Promise<void> | null = null;
let lastStatus: FinanceSnapshotWriteStatus | null = null;
let droppedJobs = 0;

/**
 * Süreç ömrü boyunca ARTAN yazım sayaçları.
 *
 * ⚠️ NEDEN SAYAÇ, NEDEN "son tur durumu" DEĞİL: her tur `lastStatus`'ü EZER. Önbellek
 * düşürücü son duruma bakıp karar verdiğinde, aynı örnekleme aralığında biten iki turdan
 * yalnız sonuncusu görülüyordu — "A turu 12 satır yazdı, B turu 0 yazdı" durumunda düşürme
 * sessizce kaçıyordu (kullanıcı yeni siparişi listede görüyor, "Ciro (bu ay)" kartı eski
 * rakamda kalıyordu). Sayaç monotonik olduğu için hiçbir tur kaçmaz: çağıran başta okur,
 * sonda karşılaştırır.
 */
let writeTotals = { orders: 0, items: 0, rounds: 0 };

async function drainQueue(): Promise<void> {
  while (queue.length > 0) {
    const job = queue.shift()!;
    const startedAt = new Date();
    try {
      const result = await persistOrderFinanceSnapshots(job.orders, job.itemsByOrderId);
      const finishedAt = new Date();
      writeTotals = {
        orders: writeTotals.orders + result.writtenOrders,
        items: writeTotals.items + result.writtenItems,
        rounds: writeTotals.rounds + 1,
      };
      lastStatus = {
        ok: true,
        ...result,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      };
    } catch (error) {
      const finishedAt = new Date();
      // Tur bitti sayılır ama HİÇBİR yazım sayılmaz: yarım kalmış bir turu "yazdı" saymak
      // önbelleği yarım veriyle tazelerdi.
      writeTotals = { ...writeTotals, rounds: writeTotals.rounds + 1 };
      // Hata YUTULMAZ: hem günlüğe düşer hem de son durum olarak saklanır.
      console.error("[finance-snapshot] Arka plan yazımı başarısız:", error);
      lastStatus = {
        ok: false,
        ...emptyWriteResult(job.orders.length),
        error:
          error instanceof Error
            ? error.message
            : "Sipariş finans geçmişi kaydedilemedi.",
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      };
    }
  }
}

function startRunner(): void {
  if (running) return;
  running = new Promise<void>((resolve) => {
    // Yanıt akışı serbest kalsın diye bir sonraki tur'a bırakılır.
    setTimeout(() => {
      void drainQueue().finally(() => {
        running = null;
        resolve();
        // Boşaltma biterken araya iş girmiş olabilir → sahipsiz kalmasın.
        if (queue.length > 0) startRunner();
      });
    }, 0);
  });
}

/**
 * Finans geçmişini ARKA PLANDA yazar — "ateşle ve unut".
 *
 * Çağıran beklemez, hiçbir koşulda hata fırlatmaz (reddedilen bir söz de üretmez).
 * Aynı anda tek tur çalışır; üst üste gelen istekler sıraya girer.
 */
export function scheduleOrderFinanceSnapshots(
  orders: FinanceSnapshotOrder[],
  itemsByOrderId?: ReadonlyMap<string, FinanceSnapshotItem[]>
): void {
  if (orders.length === 0) return;
  // Çağıranın dizisi/haritası biz yazarken değişebilir → anlık kopya alınır (sığ kopya yeter,
  // satır nesneleri bu noktadan sonra değişmiyor).
  queue.push({
    orders: orders.slice(),
    itemsByOrderId: itemsByOrderId ? new Map(itemsByOrderId) : undefined,
  });
  while (queue.length > MAX_QUEUED_JOBS) {
    queue.shift();
    droppedJobs++;
  }
  startRunner();
}

/** Son TAMAMLANAN arka plan turunun durumu (henüz tur bitmediyse null). */
export function lastOrderFinanceSnapshotWrite(): FinanceSnapshotWriteStatus | null {
  return lastStatus;
}

/**
 * Süreç açıldığından beri yazılan TOPLAM özet/kalem sayısı ve biten tur sayısı.
 *
 * Önbellek düşürücü bunu kullanır: başta okur, yazım bitince yeniden okur. Aradaki fark
 * "bu bekleyiş boyunca gerçekten satır yazıldı mı" sorusunu KAÇIRMADAN yanıtlar — turların
 * arasına sıkışmış bir yazımı örnekleme yöntemi görmüyordu.
 */
export function orderFinanceSnapshotWriteTotals(): {
  orders: number;
  items: number;
  rounds: number;
} {
  return writeTotals;
}

/** Arka planda yazım sürüyor mu? */
export function orderFinanceSnapshotWriteInFlight(): boolean {
  return running !== null;
}

/** Kuyruk boşalana kadar bekler. Yalnız testler ve kapanış akışı için. */
export async function flushOrderFinanceSnapshots(): Promise<void> {
  while (running) await running;
}

/** Yer darlığından düşürülen tur sayısı (tanılama). */
export function droppedOrderFinanceSnapshotJobs(): number {
  return droppedJobs;
}

// ── Bir ayı yeniden hesaplama ───────────────────────────────────────────────────────────
// NEDEN: bir sipariş bir kez TAM hesaplandıktan sonra kârı bilerek donduruluyor (geçmiş ay
// kendiliğinden kaymasın). Ama kullanıcı maliyeti/komisyonu/kargoyu DÜZELTTİĞİNDE Siparişler
// ekranı yeni rakamı gösterirken Raporlar eskisinde kalıyordu ve bunu düzeltmenin hiçbir yolu
// yoktu. Burası o düzeltmeyi kullanıcının isteğiyle geçmişe taşır.
//
// Girdi pazaryerinden DEĞİL, kalıcı kalem geçmişinden (OrderItemSnapshot) okunur: pazaryeri
// penceresi 30-60 günle sınırlı, oysa düzeltilmek istenen ay çoğunlukla daha eski. Ciro, sipariş
// numarası, tarih ve durum kayıtlı özetten AYNEN korunur — yeniden hesap yalnız maliyet/komisyon/
// kargo/gider tarafını günceller.

/** Yeniden hesap turunun sonucu. */
export interface FinanceMonthRecalcResult {
  /** "YYYY-MM". Çok aylı turda TÜM kapsam için "YYYY-MM…YYYY-MM" biçiminde olabilir. */
  month: string;
  /** Ayda bulunan (manuel olmayan) sipariş sayısı. */
  totalOrders: number;
  /** Yeniden hesaplanabilen sipariş sayısı. */
  recalculatedOrders: number;
  /**
   * DOKUNULMAYAN sipariş sayısı = `blockedOrders + protectedOrders`.
   * (Eski alan adı korunuyor; ayrıntı aşağıdaki iki alanda.)
   */
  skippedOrders: number;
  /**
   * ÜRÜN GEÇMİŞİ KAYITLI OLMADIĞI için ASLA yeniden hesaplanamayacak sipariş sayısı.
   * Bu siparişler pazaryeri penceresi kapandıktan sonra kalem geçmişi olmadan kalmış;
   * "yeniden hesapla" onlar için hiçbir zaman bir şey değiştiremez. Arayüz uyarıyı ve
   * düğmeyi buna göre kurmalı — yoksa düğme basılıyor ve HİÇBİR ŞEY olmuyor.
   */
  blockedOrders: number;
  /**
   * Yeniden hesap "maliyet bilinmiyor" dediği için KORUNAN (eski rakamı silinmeyen) sipariş
   * sayısı. Genelde ürün katalogdan silinmiştir; ürün geri gelirse düzelebilir.
   */
  protectedOrders: number;
  /** Rakamı gerçekten değiştiği için yazılan sipariş sayısı (kuru turda: değişecek sayısı). */
  changedOrders: number;
  /** Ayın toplam kâr farkı — kuruş. */
  profitDeltaKurus: number;
  /** Bu tur veritabanına hiç yazmadı mı? (prova turu) */
  dryRun: boolean;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Ay penceresini KABA olarak daraltır (okunan satır sayısı sabit kalsın diye).
 * Kesin ayıklama monthKey ile yapılır — ay sınırı saat dilimine bağlı ve o bilgi TEK yerde.
 */

// Kayıtlı satırın TAMAMI okunur: kuru tur (prova) "yazsaydık ne değişirdi" sorusunu ancak
// gerçek yazımla AYNI alanları karşılaştırarak dürüstçe yanıtlayabilir.
type RecalcSnapshotRow = {
  platform: string;
  externalOrderId: string;
  orderNumber: string;
  orderedAt: Date;
  revenueKurus: number;
  profitKurus: number | null;
  profitPartial: boolean;
  profitSource: string;
  estimatedCommissionKurus: number | null;
  actualCommissionKurus: number | null;
  outputVatKurus: number | null;
  inputVatCreditKurus: number | null;
  calculationVersion: number;
  statusKind: string;
  currency: string;
};

/** Sipariş kârı için gereken ürün alanları — güncel maliyetle çözülmüş hâli. */
type RecalcProduct = OrderProfitProduct & {
  listingByPlatform: Record<string, OrderProfitProduct["listing"]>;
};

async function readRecalcProducts(
  productIds: string[],
  settings: Record<string, string | undefined>
): Promise<Map<string, RecalcProduct>> {
  const byId = new Map<string, RecalcProduct>();
  for (let offset = 0; offset < productIds.length; offset += READ_CHUNK) {
    const products = await prisma.product.findMany({
      where: { id: { in: productIds.slice(offset, offset + READ_CHUNK) } },
      include: {
        cost: { include: { filamentType: { select: { costPerGram: true } } } },
        listings: true,
      },
    });
    for (const product of products) {
      const resolved = resolveProductCost(
        product.cost,
        settings,
        product.cost?.filamentType?.costPerGram ?? 0
      );
      const listingByPlatform: RecalcProduct["listingByPlatform"] = {};
      for (const listing of product.listings) {
        listingByPlatform[listing.platform] = {
          platform: listing.platform,
          commissionRate: listing.commissionRate,
          commissionFixed: listing.commissionFixed,
          cargoCost: listing.cargoCost,
        };
      }
      byId.set(product.id, {
        id: product.id,
        name: product.name,
        categoryName: product.categoryName,
        desi: product.desi,
        commissionRate: product.commissionRate,
        productionCost: resolved?.productionCost ?? 0,
        packagingCost: resolved?.packagingCost ?? 0,
        packagingComponents: resolved?.packagingBreakdown?.components ?? null,
        filamentCost: resolved?.filamentCost ?? 0,
        productionCostKnown: resolved?.productionCostKnown ?? false,
        listing: null,
        listingByPlatform,
      });
    }
  }
  return byId;
}

/** Trendyol'un bildirdiği GERÇEK komisyon — sipariş kimliğiyle, yoksa tekil sipariş numarasıyla. */
async function readRecalcFinancials(rows: RecalcSnapshotRow[]): Promise<
  Map<string, { actualCommission: number; settlementRevenue: number }>
> {
  const trendyol = rows.filter((row) => row.platform === "trendyol");
  const result = new Map<string, { actualCommission: number; settlementRevenue: number }>();
  if (trendyol.length === 0) return result;

  const orderNumberCounts = new Map<string, number>();
  for (const row of trendyol) {
    orderNumberCounts.set(row.orderNumber, (orderNumberCounts.get(row.orderNumber) ?? 0) + 1);
  }

  const financials: Array<{
    externalOrderId: string;
    orderNumber: string;
    grossRevenueKurus: number;
    commissionKurus: number;
  }> = [];
  for (let offset = 0; offset < trendyol.length; offset += READ_CHUNK) {
    const slice = trendyol.slice(offset, offset + READ_CHUNK);
    financials.push(
      ...(await prisma.platformOrderFinancial.findMany({
        where: {
          platform: "trendyol",
          OR: [
            { externalOrderId: { in: slice.map((row) => row.externalOrderId) } },
            { orderNumber: { in: slice.map((row) => row.orderNumber) } },
          ],
        },
        select: {
          externalOrderId: true,
          orderNumber: true,
          grossRevenueKurus: true,
          commissionKurus: true,
        },
      }))
    );
  }

  const byExternalId = new Map(financials.map((row) => [row.externalOrderId, row]));
  const byOrderNumber = new Map<string, typeof financials>();
  for (const row of financials) {
    const list = byOrderNumber.get(row.orderNumber) ?? [];
    list.push(row);
    byOrderNumber.set(row.orderNumber, list);
  }

  for (const row of trendyol) {
    // Sipariş listesi hattıyla AYNI kural: kimlik eşleşmesi öncelikli, yoksa sipariş numarası
    // iki tarafta da TEKİLSE güvenli yedek eşleşme.
    let financial = byExternalId.get(row.externalOrderId) ?? null;
    if (!financial && orderNumberCounts.get(row.orderNumber) === 1) {
      const candidates = byOrderNumber.get(row.orderNumber) ?? [];
      if (candidates.length === 1) financial = candidates[0];
    }
    if (!financial) continue;
    result.set(snapshotKey(row.platform, row.externalOrderId), {
      actualCommission: kurusToTl(financial.commissionKurus),
      settlementRevenue: kurusToTl(financial.grossRevenueKurus),
    });
  }
  return result;
}

/** Yeniden hesap ilerlemesi — arayüz X/Y gösterebilsin diye adım adım bildirilir. */
export type FinanceRecalcPhase =
  | "reading"
  | "calculating"
  | "writing"
  | "done"
  | "error";

type RecalcProgress = (phase: FinanceRecalcPhase, processed: number, total: number) => void;

/** Hesap turu arada nefes alsın: durum sorgusu bekleyen istemci donmuş görünmemeli. */
const RECALC_CHUNK = 25;

export interface FinanceRecalcOptions {
  /** İlerleme bildirimi (arayüz X/Y gösterebilsin diye). */
  onProgress?: RecalcProgress;
  /**
   * PROVA turu: hesap yapılır, sonuç raporlanır ama VERİTABANINA HİÇ YAZILMAZ.
   * Toplu (çok aylı) düzeltmeden önce "kaç sipariş değişecek, net kâr ne kadar oynayacak"
   * sorusunu yazmadan yanıtlamak için. Kullanıcı rakamı görmeden geçmişi değiştirmemeli.
   */
  dryRun?: boolean;
}

function emptyRecalcResult(month: string, dryRun: boolean): FinanceMonthRecalcResult {
  return {
    month,
    totalOrders: 0,
    recalculatedOrders: 0,
    skippedOrders: 0,
    blockedOrders: 0,
    protectedOrders: 0,
    changedOrders: 0,
    profitDeltaKurus: 0,
    dryRun,
  };
}

/** TEK ay — mevcut çağrı yerlerinin (Raporlar'daki "Bu ayı yeniden hesapla") imzası. */
export async function recalculateFinanceMonth(
  month: string,
  onProgress?: RecalcProgress
): Promise<FinanceMonthRecalcResult> {
  return recalculateFinanceMonths([month], { onProgress });
}

/**
 * BİR VEYA DAHA ÇOK ayı yeniden hesapla.
 *
 * NEDEN çok aylı tek tur: her ay için ayrı tur açmak kuralları, ayarları, ürünleri ve
 * komisyon kayıtlarını ay sayısı kadar yeniden okur. Uzak-HTTP'de her sorgu ~96ms ve HEPSİ
 * süreç genelinde SIRALI — 4 aylık bir düzeltme yalnız okuma yüzünden onlarca saniye
 * uygulamayı kilitlerdi. Burada ortak veriler BİR KEZ okunur, yazım tek `batchWrite()`
 * turunda gider.
 *
 * İdempotent: ikinci kez çalıştırmak hiçbir şey yazmaz (değişen-only kuralı).
 */
export async function recalculateFinanceMonths(
  months: string[],
  options: FinanceRecalcOptions = {}
): Promise<FinanceMonthRecalcResult> {
  const wanted = [...new Set(months)].sort();
  if (wanted.length === 0) throw new Error("Yeniden hesaplanacak ay verilmedi.");
  for (const month of wanted) {
    if (!MONTH_PATTERN.test(month)) throw new Error("Geçersiz ay.");
  }
  const dryRun = options.dryRun === true;
  const scope =
    wanted.length === 1 ? wanted[0] : `${wanted[0]}…${wanted[wanted.length - 1]}`;
  const report: RecalcProgress = (phase, processed, total) =>
    options.onProgress?.(phase, processed, total);

  report("reading", 0, 0);
  const wantedSet = new Set(wanted);
  const rows: RecalcSnapshotRow[] = (
    await prisma.orderFinanceSnapshot.findMany({
      // Manuel siparişin finansı ManualOrder satırında DONDURULMUŞTUR (kendi KDV oranı ve kalem
      // maliyetiyle) — yeniden hesap ona asla dokunmaz.
      // ⚠️ TARİH FİLTRESİ YOK — bilerek. Prisma'nın `gte/lt` filtresi karışık depolama
      // tipinde satırları SESSİZCE eler (bkz. src/lib/sqlite-date.ts). Bu, "Bu ayı yeniden
      // hesapla" düğmesinin 0 kayıt güncelleyip "tamamlandı" demesine ve uyarının sonsuza
      // kadar takılı kalmasına yol açıyordu. Ay süzmesi aşağıda `monthKey` ile yapılır.
      where: { platform: { not: "manual" } },
      select: {
        platform: true,
        externalOrderId: true,
        orderNumber: true,
        orderedAt: true,
        revenueKurus: true,
        profitKurus: true,
        profitPartial: true,
        profitSource: true,
        estimatedCommissionKurus: true,
        actualCommissionKurus: true,
        outputVatKurus: true,
        inputVatCreditKurus: true,
        calculationVersion: true,
        statusKind: true,
        currency: true,
      },
    })
  ).filter((row) => wantedSet.has(monthKey(row.orderedAt)));

  if (rows.length === 0) {
    report("done", 0, 0);
    return emptyRecalcResult(scope, dryRun);
  }
  report("reading", 0, rows.length);

  const itemsByOrder = await readExistingItems([
    ...new Set(rows.map((row) => row.externalOrderId)),
  ]);
  const productIds = new Set<string>();
  for (const lines of itemsByOrder.values()) {
    for (const line of lines) if (line.productId) productIds.add(line.productId);
  }

  // Kurallar ve ayarlar sipariş listesi hattıyla AYNI kaynaktan okunur (aktif olanlar).
  // Sorgular sırayla gider: uzak bağlantıda hepsi zaten süreç genelinde sıralanıyor.
  // Reklam oranı BİR KEZ okunur (5dk önbellekli) — sipariş başına çağrılsaydı yeniden
  // hesap turu yüzlerce ek sorgu açardı.
  const adSnap = await adRateSnapshot();
  const commissionRules = await prisma.commissionRule.findMany({ where: { isActive: true } });
  const cargoRules = await prisma.cargoRule.findMany({ where: { isActive: true } });
  const expenseRules = await prisma.expenseRule.findMany({ where: { isActive: true } });
  const settingRows = await prisma.appSetting.findMany();
  const settings: Record<string, string | undefined> = Object.fromEntries(
    settingRows.map((row) => [row.key, row.value])
  );
  const productById = await readRecalcProducts([...productIds], settings);
  const financialByOrder = await readRecalcFinancials(rows);

  const updates: FinanceSnapshotOrder[] = [];
  /** Kuru turda "yazsaydık değişirdi" sayımı için: güncelleme ↔ kayıtlı satır eşlemesi. */
  const existingByUpdateKey = new Map<string, RecalcSnapshotRow>();
  let recalculatedOrders = 0;
  let blockedOrders = 0;
  let protectedOrders = 0;
  let profitDeltaKurus = 0;
  let processed = 0;

  for (let offset = 0; offset < rows.length; offset += RECALC_CHUNK) {
    for (const row of rows.slice(offset, offset + RECALC_CHUNK)) {
      const key = snapshotKey(row.platform, row.externalOrderId);
      const lines = (itemsByOrder.get(key) ?? [])
        .slice()
        .sort((a, b) => a.lineIndex - b.lineIndex);
      // Kalem geçmişi yoksa siparişin neyden oluştuğunu bilmiyoruz → kayıtlı rakama DOKUNMA.
      // Bu siparişler ASLA yeniden hesaplanamaz: pazaryeri penceresi kapandı, ürün geçmişi
      // hiç kaydedilmemiş. Ayrı sayılır ki arayüz "düğmeye bas, hiçbir şey olmaz" tuzağına
      // düşmesin (uyarı 18 sipariş diyordu, düğme hiçbirini düzeltemiyordu).
      if (lines.length === 0) {
        blockedOrders++;
        continue;
      }
      const profitLines: OrderProfitLine[] = lines.map((line) => {
        const match = line.productId ? productById.get(line.productId) ?? null : null;
        if (!match) {
          return { unitPrice: kurusToTl(line.unitPriceKurus), quantity: line.quantity, product: null };
        }
        const { listingByPlatform, ...product } = match;
        return {
          unitPrice: kurusToTl(line.unitPriceKurus),
          quantity: line.quantity,
          // Komisyon/kargo override'ı siparişin platformundaki ilandan gelir (Ürünler ile aynı kaynak).
          product: { ...product, listing: listingByPlatform[row.platform] ?? null },
        };
      });

      const resolved = resolveOrderProfit(
        {
          platform: row.platform,
          // Ciro kayıtlı özetten gelir; yeniden hesap ciroyu DEĞİŞTİRMEZ.
          orderTotal: kurusToTl(row.revenueKurus),
          lines: profitLines,
          commissionRules: commissionRules as CommissionRuleInput[],
          cargoRules: cargoRules as CargoRuleInput[],
          expenseRules: expenseRules as ExpenseRuleInput[],
          settings,
          // Yeniden hesapta da siparişin kendi tarihi: geçmiş özetler güncel tarifeye kaymasın.
          orderedAt: row.orderedAt ?? null,
          // Reklam payı — Siparişler ekranıyla AYNI kaynak; yoksa Raporlar farklı kâr gösterirdi.
          adRate: adRateFor(adSnap, row.platform, row.orderedAt ?? null),
        },
        {
          statusKind: row.statusKind,
          financial: financialByOrder.get(key) ?? null,
        }
      );

      // Ürün katalogdan silinmişse yeni hesap "maliyet bilinmiyor" der. Daha önce yakalanmış
      // gerçek bir kârı bu yüzden SİLMEYİZ — yeniden hesap bilgi kaybettirmemeli.
      if (resolved.profit == null && row.profitKurus != null) {
        protectedOrders++;
        continue;
      }

      recalculatedOrders++;
      profitDeltaKurus +=
        (resolved.profit == null ? 0 : tlToKurus(resolved.profit)) - (row.profitKurus ?? 0);
      existingByUpdateKey.set(key, row);
      updates.push({
        platform: row.platform,
        id: row.externalOrderId,
        orderNumber: row.orderNumber,
        date: row.orderedAt.toISOString(),
        total: kurusToTl(row.revenueKurus),
        profit: resolved.profit,
        // Shopify'da "kısmi" işareti satır kırpılması / kısmi iadeden de gelebilir; bu bilgi
        // kalem geçmişinde YOK. Yanlışlıkla "hesap tam" demektense kayıtlı işareti koruruz.
        profitPartial:
          row.platform === "shopify"
            ? resolved.profitPartial || row.profitPartial
            : resolved.profitPartial,
        profitSource: resolved.profitSource,
        estimatedCommission: resolved.estimatedCommission,
        actualCommission: resolved.actualCommission,
        // KDV: motorun bu turdaki çıktısı. Geçmiş ayların KDV'si kapsama böyle girer.
        outputVat: resolved.outputVat,
        inputVatCredit: resolved.inputVatCredit,
        statusKind: row.statusKind,
        currency: row.currency,
      });
    }
    processed = Math.min(rows.length, offset + RECALC_CHUNK);
    report("calculating", processed, rows.length);
    // Olay döngüsüne dönmeden ilerleme sorgusu yanıtlanamaz.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  report("writing", rows.length, rows.length);
  // PROVA turu hiçbir şey yazmaz; "kaç satır değişirdi" sorusunu gerçek yazımla AYNI
  // karşılaştırmayı (resolveSnapshotWriteData + snapshotChangedFields) kullanarak yanıtlar.
  const changedOrders = dryRun
    ? countDryRunChanges(updates, existingByUpdateKey)
    : (
        await persistOrderFinanceSnapshots(updates, undefined, {
          replaceCapturedProfit: true,
        })
      ).writtenOrders;
  report("done", rows.length, rows.length);

  return {
    month: scope,
    totalOrders: rows.length,
    recalculatedOrders,
    skippedOrders: blockedOrders + protectedOrders,
    blockedOrders,
    protectedOrders,
    changedOrders,
    profitDeltaKurus,
    dryRun,
  };
}

/** Kuru tur: hiçbir şey yazmadan "kaç sipariş özeti değişirdi" sayısını üretir. */
function countDryRunChanges(
  updates: FinanceSnapshotOrder[],
  existingByKey: ReadonlyMap<string, RecalcSnapshotRow>
): number {
  let changed = 0;
  for (const order of updates) {
    const externalOrderId = canonicalFinanceOrderId(order.platform, order.id);
    const existing = existingByKey.get(snapshotKey(order.platform, externalOrderId));
    if (!existing) {
      changed++;
      continue;
    }
    const next = resolveSnapshotWriteData(existing, order, existing.orderedAt, {
      replaceCapturedProfit: true,
    });
    if (snapshotChangedFields(existing, next).length > 0) changed++;
  }
  return changed;
}

/** Arayüzün yokladığı ilerleme durumu (JSON'a olduğu gibi konur). */
export interface FinanceRecalcState {
  /** Tur kapsamı, tek satırlık gösterim için ("2026-08" ya da "2026-05…2026-08"). */
  month: string;
  /** Kapsamdaki ayların tamamı — arayüz "4 ay" diyebilsin diye. */
  months: string[];
  phase: FinanceRecalcPhase;
  processed: number;
  total: number;
  startedAt: string;
  finishedAt: string | null;
  result: FinanceMonthRecalcResult | null;
  /** Bu tur PROVA mı? (hiçbir şey yazılmaz) */
  dryRun: boolean;
  error: string | null;
}

let recalcState: FinanceRecalcState | null = null;
let recalcRunning: Promise<void> | null = null;

/**
 * "Şu an başka bir tur sürüyor" hatası.
 *
 * ⚠️ NEDEN AYRI BİR HATA: eskiden süren tur varsa İSTENEN turun bayrağına bakılmadan mevcut
 * durum dönüyordu. Kullanıcı Prova'ya basıp beklemeden "Uygula"ya bastığında gerçek tur hiç
 * açılmıyor, PROVA durumu geri dönüyordu: arayüz `phase:"done"` + `changedOrders:245` görüp
 * "245 sipariş düzeltildi" diyordu — oysa veritabanına tek satır yazılmamıştı.
 */
export class FinanceRecalcBusyError extends Error {
  constructor(readonly running: FinanceRecalcState) {
    super(
      running.dryRun
        ? "Prova hesabı sürüyor; bitmesini bekleyin."
        : "Yeniden hesaplama sürüyor; bitmesini bekleyin."
    );
    this.name = "FinanceRecalcBusyError";
  }
}

/** Son (veya süren) yeniden hesap turunun durumu. */
export function financeRecalcState(): FinanceRecalcState | null {
  return recalcState;
}

/** Şu anda bir ay yeniden hesaplanıyor mu? */
export function financeRecalcInFlight(): boolean {
  return recalcRunning !== null;
}

/**
 * Yeniden hesabı BAŞLAT ve anında durumu döndür (istemci ilerlemeyi yoklar).
 * Aynı anda tek tur çalışır: sürüyorsa mevcut durum döner, yeni tur açılmaz.
 */
export function startFinanceMonthRecalc(
  month: string,
  options: { onDone?: () => void } = {}
): FinanceRecalcState {
  return startFinanceRecalc([month], options);
}

/**
 * Çok aylı (ya da tek aylı) yeniden hesabı başlat.
 *
 * `dryRun: true` ile PROVA turu açılır: rakamlar hesaplanır, sonuç durumdan okunur ve
 * veritabanına HİÇBİR ŞEY yazılmaz. Toplu düzeltmede kullanıcıya "şu kadar sipariş
 * değişecek, net kâr şu kadar oynayacak" demeden geçmişi değiştirmeyiz.
 */
export function startFinanceRecalc(
  months: string[],
  options: { onDone?: () => void; dryRun?: boolean } = {}
): FinanceRecalcState {
  const scope = [...new Set(months)].sort();
  if (scope.length === 0) throw new Error("Yeniden hesaplanacak ay verilmedi.");
  const dryRun = options.dryRun === true;
  if (recalcRunning && recalcState) {
    // AYNI istek yeniden geldiyse (arayüz yeniden yoklamış olabilir) mevcut durum döner.
    // FARKLI bir istek — özellikle prova sürerken gelen GERÇEK tur — sessizce başkasının
    // durumunu almamalı; yoksa hiç yazılmamış bir tur "bitti" sanılır.
    const ayniKapsam =
      recalcState.months.length === scope.length &&
      recalcState.months.every((month, index) => month === scope[index]);
    if (ayniKapsam && recalcState.dryRun === dryRun) return recalcState;
    throw new FinanceRecalcBusyError(recalcState);
  }
  const startedAt = new Date().toISOString();
  recalcState = {
    month: scope.length === 1 ? scope[0] : `${scope[0]}…${scope[scope.length - 1]}`,
    months: scope,
    phase: "reading",
    processed: 0,
    total: 0,
    startedAt,
    finishedAt: null,
    result: null,
    dryRun,
    error: null,
  };
  recalcRunning = (async () => {
    try {
      const result = await recalculateFinanceMonths(scope, {
        dryRun,
        onProgress: (phase, processed, total) => {
          if (!recalcState) return;
          recalcState = { ...recalcState, phase, processed, total };
        },
      });
      recalcState = {
        ...recalcState!,
        phase: "done",
        processed: result.totalOrders,
        total: result.totalOrders,
        finishedAt: new Date().toISOString(),
        result,
      };
    } catch (error) {
      console.error("[finance-recalc] Ay yeniden hesaplanamadı:", error);
      recalcState = {
        ...recalcState!,
        phase: "error",
        finishedAt: new Date().toISOString(),
        error:
          error instanceof Error ? error.message : "Ay yeniden hesaplanamadı.",
      };
    } finally {
      recalcRunning = null;
      options.onDone?.();
    }
  })();
  return recalcState;
}

/** Tur bitene kadar bekler. Yalnız testler için. */
export async function flushFinanceMonthRecalc(): Promise<void> {
  while (recalcRunning) await recalcRunning;
}
