import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { swr } from "@/lib/route-cache";

/**
 * Son N günde fiyatı değişen ürünlerin özeti (Panel'deki "Fiyat Hareketleri" kartı).
 *
 * Default: son 30 gün, en son hareket eden 10 ürün.
 */

/** Kuruş altı kayan nokta gürültüsü "farklı fiyat" sayılmasın. */
const PRICE_EPSILON = 0.005;

/**
 * Önbellek ömrü. Fiyat geçmişi yalnızca senkron/elle düzenleme ile değişir ve o rotalar
 * `dashboard:` ön ekini zaten düşürüyor (cache-busting.ts) → uzun TTL güvenli, kart anında açılır.
 */
const TTL_MS = 5 * 60_000;

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const days = Number(url.searchParams.get("days") ?? 30);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return NextResponse.json({ error: "days 1-3650 arasında tam sayı olmalı" }, { status: 400 });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return NextResponse.json({ error: "limit 1-100 arasında tam sayı olmalı" }, { status: 400 });
    }

    const data = await swr(`dashboard:price-changes:v2:${days}:${limit}`, TTL_MS, () =>
      computePriceChanges(days, limit)
    );
    return NextResponse.json(data);
  } catch (error) {
    // Sarmalanmamış rota GÖVDESİZ 500 döndürüyordu: kullanıcı boş kart görüyor, sebep hiçbir
    // yere yazılmıyordu.
    console.error("[dashboard/price-changes] hesaplanamadı", error);
    return jsonError(error);
  }
}

/**
 * Pencere başlangıcı GÜN BAŞINA yaslanır: bugünün 00:00'ından geriye (days-1) gün.
 * Saat bazlı kayan pencerede aynı kart sabah ve akşam farklı rakam gösteriyordu.
 */
function windowStart(days: number, now: Date = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start;
}

async function computePriceChanges(days: number, limit: number) {
  await ensureRuntimeSchema();

  const since = windowStart(days);

  // TEK sorgu (ek sorgu YOK): pasif/gizli ürünler ilişki filtresiyle daha veritabanında elenir —
  // Panel'in geri kalanı da yalnız aktif + gizlenmemiş ürünleri sayıyor, kart onunla aynı kapsamda olmalı.
  const history = await prisma.priceHistory.findMany({
    where: {
      changedAt: { gte: since },
      product: { isActive: true, hidden: false },
    },
    select: {
      id: true,
      productId: true,
      oldPrice: true,
      newPrice: true,
      changeSource: true,
      changedAt: true,
      product: { select: { name: true, currentSalePrice: true } },
    },
    orderBy: { changedAt: "asc" },
  });

  type Row = (typeof history)[number];

  // Toplu yazımlarda (createMany) onlarca kaydın changedAt değeri BİREBİR aynı oluyor. İkinci bir
  // sıra ölçütü vermezsek "en eski kayıt" her istekte değişir ve kart aynı ürün için farklı rakam gösterir.
  const rows = [...history].sort(
    (a, b) =>
      a.changedAt.getTime() - b.changedAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  /** Tek bir kaynağın (Shopify / Trendyol / HB / manuel) kendi içinde tutarlı fiyat çizgisi. */
  type Lineage = { source: string; oldest: Row; newest: Row; count: number };
  type Bucket = {
    productName: string;
    currentPrice: number;
    changeCount: number;
    lastChangedAt: Date;
    lineages: Map<string, Lineage>;
  };

  const byProduct = new Map<string, Bucket>();

  for (const row of rows) {
    if (!row.product) continue;
    let bucket = byProduct.get(row.productId);
    if (!bucket) {
      bucket = {
        productName: row.product.name,
        currentPrice: row.product.currentSalePrice,
        changeCount: 0,
        lastChangedAt: row.changedAt,
        lineages: new Map(),
      };
      byProduct.set(row.productId, bucket);
    }
    bucket.changeCount++;
    bucket.lastChangedAt = row.changedAt; // artan sırada gezildiği için son görülen en yenisidir
    const lineage = bucket.lineages.get(row.changeSource);
    if (lineage) {
      lineage.newest = row;
      lineage.count++;
    } else {
      bucket.lineages.set(row.changeSource, { source: row.changeSource, oldest: row, newest: row, count: 1 });
    }
  }

  const items = Array.from(byProduct, ([productId, bucket]) => {
    const lineage = pickLineage([...bucket.lineages.values()], bucket.currentPrice);
    const firstPrice = lineage.oldest.oldPrice;
    // Son fiyat SEÇİLEN ÇİZGİNİN kendi son fiyatı — `Product.currentSalePrice` DEĞİL.
    // Neden: ürünün o alanını yalnız Shopify senkronu ve elle düzenleme günceller; Trendyol ve
    // Hepsiburada senkronları sadece ilan fiyatını yazıp geçmiş kaydı bırakır. O alana
    // dayansaydık, yalnız pazaryerinde satılan bir üründe başlangıç ve bitiş iki farklı fiyat
    // evreninden gelir ve kart yine uydurma bir yüzde gösterirdi (kaldırmaya çalıştığımız hata).
    const lastPrice = lineage.newest.newPrice;
    const comparable = Number.isFinite(firstPrice) && firstPrice > 0 && Number.isFinite(lastPrice);
    return {
      productId,
      productName: bucket.productName,
      firstPrice,
      lastPrice,
      // Hesaplanamıyorsa null: eski fiyatı olmayan ürün eskiden yeşil "%+0,0" görünüyordu.
      changePercent: comparable ? ((lastPrice - firstPrice) / firstPrice) * 100 : null,
      // Gösterilen aralık TEK çizgiye ait; sayı da o çizginin olmalı. Ürünün tüm kaynaklardaki
      // toplamı yazılsaydı "3×" derken iki hareketlik bir aralık gösterilirdi.
      changeCount: lineage.count,
      lastChangedAt: bucket.lastChangedAt,
      source: lineage.source,
    };
  });

  items.sort(
    (a, b) =>
      b.lastChangedAt.getTime() - a.lastChangedAt.getTime() ||
      a.productName.localeCompare(b.productName, "tr-TR")
  );

  return {
    days,
    since: since.toISOString(),
    totalChanges: rows.length,
    productsAffected: items.length,
    recent: items.slice(0, limit),
  };
}

/**
 * Ürünün hangi fiyat çizgisi referans alınacak?
 *
 * Her kaynak AYRI bir çizgidir: Trendyol ilan fiyatı ile Shopify ilan fiyatını aynı ürünün
 * ardışık geçmişi saymak "%+60 zam" gibi uydurma rakamlar üretiyordu. Ürünün güncel satış
 * fiyatını hangi çizgi sürüyorsa referans odur; hiçbiri güncel fiyatla bitmiyorsa en son
 * hareket eden çizgi alınır (eşitlikte kaynak adına göre — rastgelelik kalmasın).
 */
function pickLineage<T extends { source: string; newest: { newPrice: number; changedAt: Date } }>(
  lineages: T[],
  currentPrice: number
): T {
  const onCurrentTrack = lineages.filter(
    (l) => Math.abs(l.newest.newPrice - currentPrice) <= PRICE_EPSILON
  );
  const pool = onCurrentTrack.length > 0 ? onCurrentTrack : lineages;
  return pool.reduce((best, l) => {
    const diff = l.newest.changedAt.getTime() - best.newest.changedAt.getTime();
    if (diff !== 0) return diff > 0 ? l : best;
    return l.source < best.source ? l : best;
  });
}
