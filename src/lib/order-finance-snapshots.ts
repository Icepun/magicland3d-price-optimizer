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

function snapshotDiffers(
  existing: SnapshotComparable,
  next: SnapshotComparable
): boolean {
  return (
    existing.orderNumber !== next.orderNumber ||
    existing.orderedAt.getTime() !== next.orderedAt.getTime() ||
    existing.revenueKurus !== next.revenueKurus ||
    existing.profitKurus !== next.profitKurus ||
    existing.profitPartial !== next.profitPartial ||
    existing.profitSource !== next.profitSource ||
    existing.estimatedCommissionKurus !== next.estimatedCommissionKurus ||
    existing.actualCommissionKurus !== next.actualCommissionKurus ||
    existing.outputVatKurus !== next.outputVatKurus ||
    existing.inputVatCreditKurus !== next.inputVatCreditKurus ||
    existing.statusKind !== next.statusKind ||
    existing.currency !== next.currency ||
    existing.calculationVersion !== next.calculationVersion
  );
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

/** Kalem satırında yazmayı gerektiren bir alan değişmiş mi? */
function itemDiffers(existing: ExistingItemRow, next: ItemWriteData): boolean {
  return (
    existing.orderedAt.getTime() !== next.orderedAt.getTime() ||
    existing.productId !== next.productId ||
    existing.productName !== next.productName ||
    existing.quantity !== next.quantity ||
    existing.unitPriceKurus !== next.unitPriceKurus ||
    existing.lineRevenueKurus !== next.lineRevenueKurus ||
    existing.statusKind !== next.statusKind ||
    existing.currency !== next.currency
  );
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

/** Bir yazma turunun sonucu — arka planda çalışırken de ölçülebilsin diye döner. */
export interface FinanceSnapshotWriteResult {
  /** Kaydedilmeye uygun (manuel olmayan, tarihi olan) sipariş sayısı. */
  eligibleOrders: number;
  /** Gerçekten yazılan sipariş özeti sayısı — değişmeyenler yazılmaz. */
  writtenOrders: number;
  /** Gerçekten yazılan/silinen kalem ifadesi sayısı. */
  writtenItems: number;
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

  if (valid.length === 0) {
    return { eligibleOrders: 0, writtenOrders: 0, writtenItems: 0 };
  }

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

  for (const { order, orderedAt, externalOrderId } of valid) {
    const existing = existingByKey.get(snapshotKey(order.platform, externalOrderId)) ?? null;
    const incoming = {
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
    const replaceProfit =
      options.replaceCapturedProfit === true ||
      shouldReplaceCapturedProfit(existing, incoming);
    const data = {
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

    // Satır zaten birebir aynıysa yazma (syncedAt damgası tek başına yazmayı haklı çıkarmaz).
    if (existing && !snapshotDiffers(existing, data)) continue;

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
        if (existing && !itemDiffers(existing, row)) return;
        itemStatements.push(
          itemStatement(plan.platform, plan.externalOrderId, lineIndex, row, syncedAt)
        );
      });
      const maxStoredIndex = stored.reduce((max, row) => Math.max(max, row.lineIndex), -1);
      // Kalem sayısı azaldıysa fazlalığı sil. Ama TÜM kalemleri silmeyiz: satırların geçici olarak
      // hiç gelmemesi (pazaryeri yanıtı eksik döndü) kalıcı geçmişi yok etmemeli.
      if (plan.rows.length > 0 && maxStoredIndex >= plan.rows.length) {
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

  return {
    eligibleOrders: valid.length,
    writtenOrders: pending.length,
    writtenItems: itemStatements.length,
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

async function drainQueue(): Promise<void> {
  while (queue.length > 0) {
    const job = queue.shift()!;
    const startedAt = new Date();
    try {
      const result = await persistOrderFinanceSnapshots(job.orders, job.itemsByOrderId);
      const finishedAt = new Date();
      lastStatus = {
        ok: true,
        ...result,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      };
    } catch (error) {
      const finishedAt = new Date();
      // Hata YUTULMAZ: hem günlüğe düşer hem de son durum olarak saklanır.
      console.error("[finance-snapshot] Arka plan yazımı başarısız:", error);
      lastStatus = {
        ok: false,
        eligibleOrders: job.orders.length,
        writtenOrders: 0,
        writtenItems: 0,
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
  /** "YYYY-MM". */
  month: string;
  /** Ayda bulunan (manuel olmayan) sipariş sayısı. */
  totalOrders: number;
  /** Yeniden hesaplanabilen sipariş sayısı. */
  recalculatedOrders: number;
  /** Kalem geçmişi olmadığı (veya maliyeti artık okunamadığı) için DOKUNULMAYAN sipariş sayısı. */
  skippedOrders: number;
  /** Rakamı gerçekten değiştiği için yazılan sipariş sayısı. */
  changedOrders: number;
  /** Ayın toplam kâr farkı — kuruş. */
  profitDeltaKurus: number;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Ay penceresini KABA olarak daraltır (okunan satır sayısı sabit kalsın diye).
 * Kesin ayıklama monthKey ile yapılır — ay sınırı saat dilimine bağlı ve o bilgi TEK yerde.
 */

type RecalcSnapshotRow = {
  platform: string;
  externalOrderId: string;
  orderNumber: string;
  orderedAt: Date;
  revenueKurus: number;
  profitKurus: number | null;
  profitPartial: boolean;
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

export async function recalculateFinanceMonth(
  month: string,
  onProgress?: RecalcProgress
): Promise<FinanceMonthRecalcResult> {
  if (!MONTH_PATTERN.test(month)) throw new Error("Geçersiz ay.");
  const report: RecalcProgress = (phase, processed, total) =>
    onProgress?.(phase, processed, total);

  report("reading", 0, 0);
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
        statusKind: true,
        currency: true,
      },
    })
  ).filter((row) => monthKey(row.orderedAt) === month);

  const empty: FinanceMonthRecalcResult = {
    month,
    totalOrders: 0,
    recalculatedOrders: 0,
    skippedOrders: 0,
    changedOrders: 0,
    profitDeltaKurus: 0,
  };
  if (rows.length === 0) {
    report("done", 0, 0);
    return empty;
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
  let recalculatedOrders = 0;
  let skippedOrders = 0;
  let profitDeltaKurus = 0;
  let processed = 0;

  for (let offset = 0; offset < rows.length; offset += RECALC_CHUNK) {
    for (const row of rows.slice(offset, offset + RECALC_CHUNK)) {
      const key = snapshotKey(row.platform, row.externalOrderId);
      const lines = (itemsByOrder.get(key) ?? [])
        .slice()
        .sort((a, b) => a.lineIndex - b.lineIndex);
      // Kalem geçmişi yoksa siparişin neyden oluştuğunu bilmiyoruz → kayıtlı rakama DOKUNMA.
      if (lines.length === 0) {
        skippedOrders++;
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
        },
        {
          statusKind: row.statusKind,
          financial: financialByOrder.get(key) ?? null,
        }
      );

      // Ürün katalogdan silinmişse yeni hesap "maliyet bilinmiyor" der. Daha önce yakalanmış
      // gerçek bir kârı bu yüzden SİLMEYİZ — yeniden hesap bilgi kaybettirmemeli.
      if (resolved.profit == null && row.profitKurus != null) {
        skippedOrders++;
        continue;
      }

      recalculatedOrders++;
      profitDeltaKurus +=
        (resolved.profit == null ? 0 : tlToKurus(resolved.profit)) - (row.profitKurus ?? 0);
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
  const write = await persistOrderFinanceSnapshots(updates, undefined, {
    replaceCapturedProfit: true,
  });
  report("done", rows.length, rows.length);

  return {
    month,
    totalOrders: rows.length,
    recalculatedOrders,
    skippedOrders,
    changedOrders: write.writtenOrders,
    profitDeltaKurus,
  };
}

/** Arayüzün yokladığı ilerleme durumu (JSON'a olduğu gibi konur). */
export interface FinanceRecalcState {
  month: string;
  phase: FinanceRecalcPhase;
  processed: number;
  total: number;
  startedAt: string;
  finishedAt: string | null;
  result: FinanceMonthRecalcResult | null;
  error: string | null;
}

let recalcState: FinanceRecalcState | null = null;
let recalcRunning: Promise<void> | null = null;

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
  if (recalcRunning && recalcState) return recalcState;
  const startedAt = new Date().toISOString();
  recalcState = {
    month,
    phase: "reading",
    processed: 0,
    total: 0,
    startedAt,
    finishedAt: null,
    result: null,
    error: null,
  };
  recalcRunning = (async () => {
    try {
      const result = await recalculateFinanceMonth(month, (phase, processed, total) => {
        if (!recalcState) return;
        recalcState = { ...recalcState, phase, processed, total };
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
