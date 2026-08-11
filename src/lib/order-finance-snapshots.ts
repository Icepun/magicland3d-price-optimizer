import { prisma } from "@/lib/prisma";
import { batchWrite } from "./libsql-batch";
import {
  FINANCE_CALCULATION_VERSION,
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
  statusKind: string;
  currency: string;
  calculationVersion: number;
  syncedAt: Date;
};

/** Snapshot satırında yazmayı gerektiren bir alan değişmiş mi? (syncedAt HARİÇ — o yalnız
 *  "en son ne zaman bakıldı" damgası; tek başına değişmesi yeniden yazmayı haklı çıkarmaz.) */
function snapshotDiffers(
  existing: {
    orderNumber: string;
    orderedAt: Date;
    revenueKurus: number;
    profitKurus: number | null;
    profitPartial: boolean;
    profitSource: string;
    estimatedCommissionKurus: number | null;
    actualCommissionKurus: number | null;
    statusKind: string;
    currency: string;
    calculationVersion: number;
  },
  next: {
    orderNumber: string;
    orderedAt: Date;
    revenueKurus: number;
    profitKurus: number | null;
    profitPartial: boolean;
    profitSource: string;
    estimatedCommissionKurus: number | null;
    actualCommissionKurus: number | null;
    statusKind: string;
    currency: string;
    calculationVersion: number;
  }
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

// SQLite'ta tarihler Prisma ile AYNI biçimde (epoch milisaniye tamsayısı) yazılır; aksi halde
// Prisma bu satırları okurken tarihleri çözemez.
function snapshotStatement(
  platform: string,
  externalOrderId: string,
  data: SnapshotWriteData
): WriteStatement {
  return {
    sql: `INSERT INTO "OrderFinanceSnapshot" (
            "id","platform","externalOrderId","orderNumber","orderedAt","revenueKurus","profitKurus",
            "profitPartial","profitSource","estimatedCommissionKurus","actualCommissionKurus",
            "statusKind","currency","calculationVersion","syncedAt"
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT("platform","externalOrderId") DO UPDATE SET
            "orderNumber" = excluded."orderNumber",
            "orderedAt" = excluded."orderedAt",
            "revenueKurus" = excluded."revenueKurus",
            "profitKurus" = excluded."profitKurus",
            "profitPartial" = excluded."profitPartial",
            "profitSource" = excluded."profitSource",
            "estimatedCommissionKurus" = excluded."estimatedCommissionKurus",
            "actualCommissionKurus" = excluded."actualCommissionKurus",
            "statusKind" = excluded."statusKind",
            "currency" = excluded."currency",
            "calculationVersion" = excluded."calculationVersion",
            "syncedAt" = excluded."syncedAt"`,
    args: [
      `finance:${platform}:${externalOrderId}`,
      platform,
      externalOrderId,
      data.orderNumber,
      data.orderedAt.getTime(),
      data.revenueKurus,
      data.profitKurus,
      data.profitPartial ? 1 : 0,
      data.profitSource,
      data.estimatedCommissionKurus,
      data.actualCommissionKurus,
      data.statusKind,
      data.currency,
      data.calculationVersion,
      data.syncedAt.getTime(),
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
      data.orderedAt.getTime(),
      data.productId,
      data.productName,
      data.quantity,
      data.unitPriceKurus,
      data.lineRevenueKurus,
      data.statusKind,
      data.currency,
      syncedAt.getTime(),
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
        orderedAt: new Date(toInt(row.orderedAt)),
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

export async function persistOrderFinanceSnapshots(
  orders: FinanceSnapshotOrder[],
  /** Sipariş kimliği → kalemler. Verilmeyen siparişin kalem geçmişine DOKUNULMAZ. */
  itemsByOrderId?: ReadonlyMap<string, FinanceSnapshotItem[]>
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
    };
    const replaceProfit = shouldReplaceCapturedProfit(existing, incoming);
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
