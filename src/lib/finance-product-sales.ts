/**
 * ÜRÜN BAZLI SATIŞ ÖZETİ — Raporlar'ın "En çok satanlar" ve "En çok para getirenler" verisi.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * NEDEN VAR (ölçülmüş hata):
 * Raporlar "en çok satanlar" listesini pazaryeri İLAN BAŞLIĞINA göre gruplandırıyordu. Aynı
 * ürün üç pazaryerinde üç farklı başlıkla satıldığı için tek ürün listede üçe bölünüyor;
 * buna karşılık FARKLI ürünler benzer başlık taşıdığında tek satırda toplanıyordu. Canlı
 * ölçüm (30 gün): 271 kalem satırı, 99 farklı başlık, ama gerçek ürün sayısı 97 — ve ekranın
 * ilk satırı olan "Xbox Joystick Standı" aslında BEŞ ayrı üründü.
 *
 * Bu yüzden gruplama ürünün KİMLİĞİNE (`OrderItemSnapshot.productId`) göre yapılır;
 * `OrderItemSnapshot` ürün bazlı satış geçmişinin TEK kaynağıdır (pazaryeri penceresi
 * dolduğunda bile kalır).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * KÂR NEREDEN GELİR — burada HİÇBİR kâr hesaplanmaz.
 *
 * Sipariş kârının tek kaynağı `resolveOrderProfit`'tir ve sonucu `OrderFinanceSnapshot`
 * satırına yazılmıştır. Burada o KAYITLI rakam yalnızca kalemlere PAYLAŞTIRILIR: her satır
 * siparişin kalem cirosundan aldığı pay kadar kâr alır. Yeni bir komisyon/kargo/maliyet
 * formülü kurulmaz — kurulsaydı Raporlar ile Siparişler farklı kâr gösterirdi.
 *
 * Paylaştırmanın bilinçli sınırları:
 *  • Ürünü eşleşmeyen satır paydaya girer ama hiç pay ALMAZ. Böylece dağıtılan kâr toplamı
 *    siparişin kârını asla aşmaz (eksik kalabilir — dürüst taraf budur).
 *  • Siparişin kârı hiç bilinmiyorsa (`profitKurus == null`) o satırlara SIFIR yazılmaz;
 *    "bilinmiyor" sayılır. Ürünün tüm satışı böyleyse kâr `null` döner ("—" gösterilir).
 *  • Siparişin kârı kısmiyse ürün `profitPartial` işaretiyle döner.
 */
import { dbEpochMs, parseDbDate } from "./sqlite-date";

/** `OrderItemSnapshot` satırı — ham sorgudan çözülmüş hâli. */
export interface ProductSalesItem {
  platform: string;
  externalOrderId: string;
  orderedAt: Date;
  productId: string | null;
  productName: string;
  quantity: number;
  lineRevenueKurus: number;
  statusKind: string;
}

/** `OrderFinanceSnapshot` satırının kâr tarafı — kalemlere paylaştırılacak kayıtlı rakam. */
export interface ProductSalesOrder {
  platform: string;
  externalOrderId: string;
  orderedAt: Date;
  revenueKurus: number;
  profitKurus: number | null;
  profitPartial: boolean;
  statusKind: string;
  currency: string;
}

/** Ürün kimliğinden okunabilir bilgiye — ürün silinmişse kalemdeki ad kullanılır. */
export interface ProductSalesInfo {
  id: string;
  name: string;
  imageUrl: string | null;
}

export interface ProductSalesRow {
  productId: string;
  name: string;
  imageUrl: string | null;
  /** Satılan adet. */
  quantity: number;
  /** Bu üründen gelen ciro (TL). */
  revenue: number;
  /** Gerçekleşen kâr (TL) — hiçbir siparişin kârı bilinmiyorsa null. */
  profit: number | null;
  /** Kârı eksik hesaplanmış (maliyeti kısmi) sipariş bu ürüne değdi mi? */
  profitPartial: boolean;
  /** Kârı hiç bilinmeyen siparişten gelen satır sayısı — "kâr eksik" uyarısı için. */
  profitUnknownLines: number;
  /** Bu ürünün geçtiği sipariş sayısı. */
  orderCount: number;
}

export interface UnmatchedSales {
  /** Ürünle eşleşmemiş kalem satırı sayısı. */
  lines: number;
  quantity: number;
  revenue: number;
  /** En çok satılan eşleşmemiş başlıklar (en fazla 10) — kullanıcı hangi ilanı bağlayacağını görsün. */
  titles: Array<{ name: string; quantity: number; revenue: number }>;
}

/**
 * Ürün dökümünün KAPSAMI.
 *
 * ⚠️ Her siparişin ürün dökümü YOK. Canlı ölçüm (12 ay): 350 siparişin 68'i, ₺24.731,75 ciro
 * kalem geçmişi taşımıyor — üstelik yalnız eskiler değil, son 30 günde de 28 sipariş
 * (₺9.419,69) dökümsüz. Bu sayı bildirilmezse ürün listeleri "satışın tamamı bu" sanılır.
 *
 * ⚠️ EN OLASI SEBEP (kodda doğrulandı, canlı veriyle henüz ÖLÇÜLMEDİ): mobil uygulama
 * `OrderFinanceSnapshot`'a yazıyor ama `OrderItemSnapshot`'a HİÇ yazmıyor (mobil kaynağında
 * o tablonun adı bir kez bile geçmiyor). Telefondan senkronlanan bir sipariş böylece özetli
 * ama dökümsüz kalır; masaüstü onu ancak pazaryeri penceresinde hâlâ duruyorsa tamamlar.
 * İkinci olasılık: pazaryeri o sipariş için satır döndürmediğinde kalem listesi boş geçer.
 *
 * Bu sayı bildirilmeden liste dürüst olmaz: `ordersWithoutItems > 0` iken sıralama KISMİDİR —
 * dökümü kaydedilmemiş satışlar hiçbir ürünün adedine girmez, tepedeki ürün yanlış olabilir.
 */
/**
 * Siparişi kayıtlı özetlerde BULUNAMAYAN kalem satırları.
 *
 * ⚠️ NEDEN AYRI BİR KOVA: bu satırlar üründen bağımsız olarak hiçbir toplama giremez (kâr
 * paylaştırmasının kaynağı sipariş özetidir). Eskiden sessizce düşüyorlardı; `unmatched`
 * yalnız "ürünü eşleşmemiş" satırları, `coverage` yalnız sipariş tarafını sayıyordu — yani
 * üçüncü bir kayıp kanalı yanıtta hiç görünmüyordu. Aynı siparişin `orderedAt` damgası iki
 * tabloya ayrı ayrı yazıldığı için (özet + kalem) bir tarafın pencereye girip diğerinin
 * girmemesi mümkündür; o zaman ürünün adedi ve cirosu HİÇBİR listede çıkmaz.
 */
export interface OrphanSalesItems {
  /** Siparişi bulunamayan kalem satırı sayısı. */
  lines: number;
  quantity: number;
  revenue: number;
}

export interface ProductSalesCoverage {
  /** Ürün dökümü olan sipariş sayısı. */
  ordersWithItems: number;
  /** Ürün dökümü olmayan (eski) sipariş sayısı. */
  ordersWithoutItems: number;
  /** O siparişlerin cirosu — "ne kadarı listede yok" sorusunun dürüst yanıtı. */
  revenueWithoutItems: number;
}

export interface ProductSalesSummary {
  /** "En çok satanlar" penceresi (gün). */
  recentDays: number;
  recentFrom: string;
  rangeFrom: string;
  /** Son `recentDays` gün, adet sırasına göre. */
  topSellers: ProductSalesRow[];
  /** Tüm pencere, GERÇEKLEŞEN kâr sırasına göre. */
  profitLeaders: ProductSalesRow[];
  /** Tüm pencerede ürün başına satılan adet — teorik kârlılık listesindeki rozet için. */
  soldUnits: Record<string, number>;
  /** Ürünle eşleşmemiş satışlar — sessizce düşmesinler. */
  unmatched: UnmatchedSales;
  /** Son `recentDays` gündeki eşleşmemiş satışlar. */
  recentUnmatched: UnmatchedSales;
  /** Siparişi kayıtlı özetlerde bulunamayan kalemler — bunlar da sessizce düşmesin. */
  orphanItems: OrphanSalesItems;
  /** Tüm pencerede ürün dökümünün kapsamı. */
  coverage: ProductSalesCoverage;
  /** Son `recentDays` gündeki kapsam. */
  recentCoverage: ProductSalesCoverage;
}

const KURUS = (value: number) => Number((Math.round(value) / 100).toFixed(2));

type Bucket = {
  quantity: number;
  revenueKurus: number;
  profitKurus: number;
  profitKnownLines: number;
  profitUnknownLines: number;
  profitPartial: boolean;
  orders: Set<string>;
};

function emptyBucket(): Bucket {
  return {
    quantity: 0,
    revenueKurus: 0,
    profitKurus: 0,
    profitKnownLines: 0,
    profitUnknownLines: 0,
    profitPartial: false,
    orders: new Set(),
  };
}

function orderKey(platform: string, externalOrderId: string): string {
  return `${platform}\u0000${externalOrderId}`;
}

function toRow(
  productId: string,
  bucket: Bucket,
  info: ProductSalesInfo | undefined,
  fallbackName: string
): ProductSalesRow {
  return {
    productId,
    name: info?.name || fallbackName,
    imageUrl: info?.imageUrl ?? null,
    quantity: bucket.quantity,
    revenue: KURUS(bucket.revenueKurus),
    // BİLİNMEYEN ≠ SIFIR: tek bir satırın bile kârı hesaplanabildiyse toplam anlamlıdır;
    // hiçbiri hesaplanamadıysa "0 kâr" demek yanlış olur → null ("—").
    profit: bucket.profitKnownLines > 0 ? KURUS(bucket.profitKurus) : null,
    profitPartial: bucket.profitPartial,
    profitUnknownLines: bucket.profitUnknownLines,
    orderCount: bucket.orders.size,
  };
}

/** Eşleşmeyen satışların birikeni — ciro KURUŞ tutulur, yuvarlama tek noktada yapılır. */
type UnmatchedBucket = {
  lines: number;
  quantity: number;
  revenueKurus: number;
  titles: Map<string, { quantity: number; revenueKurus: number }>;
};

function emptyUnmatchedBucket(): UnmatchedBucket {
  return { lines: 0, quantity: 0, revenueKurus: 0, titles: new Map() };
}

/**
 * Kalem satırlarını ürün kimliğine göre topla.
 *
 * `orders` yalnızca kârın kaynağıdır; kalemin siparişi listede yoksa (pencere dışı kalmış ya
 * da özeti hiç yazılmamış sipariş) satır hiçbir ürün toplamına giremez — aksi hâlde aylık
 * toplamlarla tutarsız bir ciro çıkardı. Ama sessizce DÜŞMEZ: `orphanItems` kovasında
 * bildirilir.
 */
export function aggregateProductSales({
  items,
  orders,
  productInfo = [],
  rangeFrom,
  recentDays = 30,
  now = new Date(),
  limit = 12,
}: {
  items: ProductSalesItem[];
  orders: ProductSalesOrder[];
  productInfo?: ProductSalesInfo[];
  rangeFrom: Date;
  recentDays?: number;
  now?: Date;
  limit?: number;
}): ProductSalesSummary {
  const recentFrom = new Date(now.getTime() - recentDays * 86_400_000);
  const orderByKey = new Map(
    orders.map((order) => [orderKey(order.platform, order.externalOrderId), order])
  );
  const infoById = new Map(productInfo.map((info) => [info.id, info]));

  // Siparişin TÜM kalem cirosu — paylaştırmanın paydası. Eşleşmeyen satır da paydaya girer:
  // onun payı kimseye yazılmaz, böylece dağıtılan kâr siparişin kârını aşamaz.
  //
  // ⚠️ İPTAL EDİLEN SATIR PAYDAYA GİRMEZ: aşağıdaki toplama döngüsü o satırı eliyor. Payda
  // onu içermeye devam ederse siparişin kârının bir kısmı HİÇBİR ürüne yazılmaz ve sağlam
  // ürünün "gerçekleşen kâr"ı sistematik olarak düşük çıkar ("En çok para getirenler"
  // sıralaması yanlış yere düşer). Bugün kalem durumu sipariş durumundan kopyalandığı için
  // tetiklenmiyor; satır bazlı iade/iptal desteklendiği gün sessizce saptırırdı.
  const orderLineTotal = new Map<string, number>();
  for (const item of items) {
    if (item.statusKind === "cancelled") continue;
    const key = orderKey(item.platform, item.externalOrderId);
    orderLineTotal.set(key, (orderLineTotal.get(key) ?? 0) + item.lineRevenueKurus);
  }

  const rangeBuckets = new Map<string, Bucket>();
  const recentBuckets = new Map<string, Bucket>();
  const fallbackNames = new Map<string, string>();
  const unmatched = emptyUnmatchedBucket();
  const recentUnmatched = emptyUnmatchedBucket();
  const orphan = { lines: 0, quantity: 0, revenueKurus: 0 };

  for (const item of items) {
    if (item.orderedAt < rangeFrom) continue;
    if (item.statusKind === "cancelled") continue;
    const key = orderKey(item.platform, item.externalOrderId);
    const order = orderByKey.get(key);
    if (!order) {
      // Siparişin özeti pencerede yok → kârın kaynağı da yok. Toplamlara giremez ama
      // BİLDİRİLİR: sessizce düşerse kullanıcı eksikliği hiçbir yerde göremez.
      orphan.lines++;
      orphan.quantity += item.quantity;
      orphan.revenueKurus += item.lineRevenueKurus;
      continue;
    }
    // Aylık toplamlarla AYNI eleme: iptal ve TL dışı siparişler hiçbir rakama girmez.
    if (order.statusKind === "cancelled") continue;
    if ((order.currency || "TRY").trim().toUpperCase() !== "TRY") continue;
    const isRecent = item.orderedAt >= recentFrom;

    if (!item.productId) {
      const title = item.productName || "Adı okunamayan ürün";
      for (const [target, active] of [
        [unmatched, true] as const,
        [recentUnmatched, isRecent] as const,
      ]) {
        if (!active) continue;
        target.lines++;
        target.quantity += item.quantity;
        target.revenueKurus += item.lineRevenueKurus;
        const current = target.titles.get(title) ?? { quantity: 0, revenueKurus: 0 };
        current.quantity += item.quantity;
        current.revenueKurus += item.lineRevenueKurus;
        target.titles.set(title, current);
      }
      continue;
    }

    if (!fallbackNames.has(item.productId)) {
      fallbackNames.set(item.productId, item.productName);
    }
    const denominator = orderLineTotal.get(key) ?? 0;
    const share = denominator > 0 ? item.lineRevenueKurus / denominator : 0;

    for (const [buckets, active] of [
      [rangeBuckets, true] as const,
      [recentBuckets, isRecent] as const,
    ]) {
      if (!active) continue;
      const bucket = buckets.get(item.productId) ?? emptyBucket();
      bucket.quantity += item.quantity;
      bucket.revenueKurus += item.lineRevenueKurus;
      bucket.orders.add(key);
      if (order.profitKurus == null) {
        bucket.profitUnknownLines++;
      } else {
        bucket.profitKurus += order.profitKurus * share;
        bucket.profitKnownLines++;
        if (order.profitPartial) bucket.profitPartial = true;
      }
      buckets.set(item.productId, bucket);
    }
  }

  const finishUnmatched = (bucket: UnmatchedBucket): UnmatchedSales => ({
    lines: bucket.lines,
    quantity: bucket.quantity,
    revenue: KURUS(bucket.revenueKurus),
    titles: [...bucket.titles.entries()]
      .map(([name, value]) => ({
        name,
        quantity: value.quantity,
        revenue: KURUS(value.revenueKurus),
      }))
      .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue)
      .slice(0, 10),
  });

  const rows = (buckets: Map<string, Bucket>) =>
    [...buckets.entries()].map(([productId, bucket]) =>
      toRow(productId, bucket, infoById.get(productId), fallbackNames.get(productId) ?? productId)
    );

  const recentRows = rows(recentBuckets);
  const rangeRows = rows(rangeBuckets);

  // Kalem geçmişi olmayan siparişler: ürün listeleri onları HİÇ göremez, sayısı bildirilmeli.
  const withItems = new Set<string>();
  for (const item of items) {
    if (item.orderedAt < rangeFrom || item.statusKind === "cancelled") continue;
    withItems.add(orderKey(item.platform, item.externalOrderId));
  }
  const coverage: ProductSalesCoverage = {
    ordersWithItems: 0,
    ordersWithoutItems: 0,
    revenueWithoutItems: 0,
  };
  const recentCoverage: ProductSalesCoverage = {
    ordersWithItems: 0,
    ordersWithoutItems: 0,
    revenueWithoutItems: 0,
  };
  let missingKurus = 0;
  let recentMissingKurus = 0;
  for (const order of orders) {
    if (order.orderedAt < rangeFrom) continue;
    if (order.statusKind === "cancelled") continue;
    if ((order.currency || "TRY").trim().toUpperCase() !== "TRY") continue;
    const covered = withItems.has(orderKey(order.platform, order.externalOrderId));
    const recent = order.orderedAt >= recentFrom;
    if (covered) {
      coverage.ordersWithItems++;
      if (recent) recentCoverage.ordersWithItems++;
    } else {
      coverage.ordersWithoutItems++;
      missingKurus += order.revenueKurus;
      if (recent) {
        recentCoverage.ordersWithoutItems++;
        recentMissingKurus += order.revenueKurus;
      }
    }
  }
  coverage.revenueWithoutItems = KURUS(missingKurus);
  recentCoverage.revenueWithoutItems = KURUS(recentMissingKurus);

  return {
    recentDays,
    recentFrom: recentFrom.toISOString(),
    rangeFrom: rangeFrom.toISOString(),
    topSellers: recentRows
      .slice()
      .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue)
      .slice(0, limit),
    // Kârı hiç bilinmeyen ürün "en çok para getiren" listesinde 0 gibi sıralanmasın diye elenir;
    // sayısı `profitUnknownLines` üzerinden zaten görünür.
    profitLeaders: rangeRows
      .filter((row) => row.profit != null)
      .sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0))
      .slice(0, limit),
    soldUnits: Object.fromEntries(rangeRows.map((row) => [row.productId, row.quantity])),
    unmatched: finishUnmatched(unmatched),
    recentUnmatched: finishUnmatched(recentUnmatched),
    orphanItems: {
      lines: orphan.lines,
      quantity: orphan.quantity,
      revenue: KURUS(orphan.revenueKurus),
    },
    coverage,
    recentCoverage,
  };
}

/**
 * Kalem geçmişi okuma SQL'i — TEK parametre: pencere başlangıcı (epoch-ms).
 *
 * ⚠️ Tarih karşılaştırması `dbEpochMs()` ile normalize edilir. Prisma'nın `gte` filtresi
 * karışık depolama tipinde (bir taraf ISO metin, diğeri epoch-ms tamsayı) satırları SESSİZCE
 * eler; Raporlar'ın 359 siparişin 280'ini kaybetmesinin sebebi buydu.
 */
export function productSalesItemsSql(): string {
  return `SELECT "platform","externalOrderId","orderedAt","productId","productName",
                 "quantity","lineRevenueKurus","statusKind"
            FROM "OrderItemSnapshot"
           WHERE ${dbEpochMs("orderedAt")} >= ?`;
}

/** Ham satırı çöz — tarihi okunamayan satır hiçbir pencereye düşemez, atlanır. */
export function parseProductSalesItems(
  rows: Array<Record<string, unknown>>
): ProductSalesItem[] {
  const toInt = (value: unknown) =>
    typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  const items: ProductSalesItem[] = [];
  for (const row of rows) {
    const orderedAt = parseDbDate(row.orderedAt);
    if (!orderedAt) continue;
    items.push({
      platform: String(row.platform ?? ""),
      externalOrderId: String(row.externalOrderId ?? ""),
      orderedAt,
      productId: row.productId == null ? null : String(row.productId),
      productName: String(row.productName ?? ""),
      quantity: toInt(row.quantity),
      lineRevenueKurus: toInt(row.lineRevenueKurus),
      statusKind: String(row.statusKind ?? ""),
    });
  }
  return items;
}
