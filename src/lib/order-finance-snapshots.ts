import { prisma } from "@/lib/prisma";
import {
  FINANCE_CALCULATION_VERSION,
  tlToKurus,
} from "./monthly-finance";

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

export async function persistOrderFinanceSnapshots(
  orders: FinanceSnapshotOrder[]
): Promise<void> {
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

  if (valid.length === 0) return;

  const syncedAt = new Date();

  // TEK OKUMA: eskiden 50'lik OR blokları hâlinde ayrı ayrı sorgulanıyordu (180 sipariş = 4 sorgu).
  // externalOrderId listesiyle tek sorgu yeter; platform ayrımı anahtar eşleşmesinde yapılır.
  const externalIds = [...new Set(valid.map((v) => v.externalOrderId))];
  // IN(...) parametre sayısı SQLite'ın değişken sınırına (999) dayanmasın: sipariş hacmi
  // büyüdükçe 60 günlük pencere binlerce satıra çıkabilir.
  const READ_CHUNK = 500;
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

  if (pending.length === 0) return;

  for (let offset = 0; offset < pending.length; offset += 50) {
    const chunk = pending.slice(offset, offset + 50);
    await prisma.$transaction(
      chunk.map(({ platform, externalOrderId, data }) =>
        prisma.orderFinanceSnapshot.upsert({
          where: { platform_externalOrderId: { platform, externalOrderId } },
          create: {
            id: `finance:${platform}:${externalOrderId}`,
            platform,
            externalOrderId,
            ...data,
          },
          update: data,
        })
      )
    );
  }
}
