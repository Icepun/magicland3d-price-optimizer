/**
 * Baskı kuyruğu türetmesi — SAF mantık.
 *
 * NEDEN AYRI DOSYA: Next 16 rota dosyaları YALNIZ istek işleyicilerini dışa açabilir;
 * buradan dışa açılan bir sabit/tip/fonksiyon `next build` tip denetiminde patlar ve bunu
 * `tsc --noEmit` YAKALAMAZ (yalnız üretim derlemesi görür).
 */

import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { dbEpochMs } from "@/lib/sqlite-date";
import {
  DAY_MS,
  EXCLUDED_STATUS,
  SALES_WINDOW_DAYS,
  coverageStart,
  toInt,
} from "@/lib/planner-insights";
import {
  VARSAYILAN_KAPSAM_GUN,
  basilacakAdet,
  gunlukSatis,
  hedefStok,
  type HedefAyari,
  type HedefModu,
} from "@/core/planner-target";
/**
 * ÜRETİM PLANI → BASKI KUYRUĞU.
 *
 * Üretim Planı "hangi ürünün stoğu az" sorusunu cevaplıyordu; bu uç bir adım ötesini kurar:
 * eksik stoğu kapatacak baskılar HANGİ YAZICIDA basılabilir, o yazıcıda ne kadar sürer ve
 * yazıcı şu an meşgulse iş ne zaman biter.
 *
 * ⚠️ BURADA MALİYET/KÂR HESABI YOKTUR. `ProductCost.printTimeHours` ve `filamentWeight`
 * yalnızca OKUNUR; hiçbir tutar üretilmez, hiçbir değer yazılmaz. Filament de otomatik
 * DÜŞÜLMEZ — makaralarda kalan gram sadece "yeter mi?" sorusu için okunur.
 *
 * UYDURMA YOK: baskı süresi girilmemiş ürün için süre TAHMİN EDİLMEZ; iş kuyrukta kalır ama
 * "süre girilmemiş" olarak işaretlenir ve toplam süreye/bitiş saatine katılmaz.
 *
 * Uç UCUZ olmak zorunda (tüm sorgular süreç genelinde sıraya giriyor): sabit sayıda sorgu,
 * döngü içinde sorgu yok, sonuç kısa ömürlü önbellekte.
 */


/** Ürüne bağlı olmayan (özel) baskı dosyalarının sahte ürün kimliği — kuyruğa girmez. */
const CUSTOM_PRODUCT_ID = "__custom__";

/** Yazıcı durumu bu kadar eskiyse "bilinmiyor" sayılır — eski kalan süreyle bitiş saati uydurmayalım. */
export const SNAPSHOT_STALE_MS = 15 * 60_000;

/** Hedef stok ayarı okunamazsa kullanılan değer (Üretim Planı ekranıyla aynı). */
export const DEFAULT_TARGET_STOCK = 5;

const HOUR_MS = 3_600_000;

// ── Giriş satırları (hepsi DB'den okunan ham veri) ────────────────────────────────────────

export interface QueueProductRow {
  id: string;
  name: string;
  imageUrl: string | null;
  stock: number;
  /** Adet başına baskı süresi (saat) — ProductCost.printTimeHours. */
  printTimeHours: number | null;
  /** Adet başına filament (gram) — ProductCost.filamentWeight. */
  filamentWeight: number | null;
  /**
   * Bu ürün için hedef stok. Sabit modda hepsi aynı; talep modunda satış hızına göre
   * ürün ürün değişir ve satmayan üründe 0 olur (bkz. `@/core/planner-target`).
   */
  target: number;
}

export interface QueueModelFileRow {
  productId: string;
  printerConfigId: string;
}

export interface QueuePrinterRow {
  id: string;
  name: string;
  brand: string;
  accent: string | null;
}

export interface QueueSnapshotRow {
  printerConfigId: string;
  status: string;
  online: boolean;
  etaSec: number | null;
  productName: string | null;
  updatedAtMs: number;
}

// ── Çıkış ────────────────────────────────────────────────────────────────────────────────

export interface QueueJob {
  productId: string;
  name: string;
  imageUrl: string | null;
  stock: number;
  /** Hedefi doldurmak için gereken baskı adedi. */
  quantity: number;
  /** Adet başına süre (saat) — girilmemişse null. */
  hoursPerUnit: number | null;
  /** Adet başına filament (gram) — girilmemişse null. */
  gramsPerUnit: number | null;
  /** Tüm adetlerin toplam süresi — süre girilmemişse null. */
  totalHours: number | null;
  /** Tüm adetlerin toplam gramajı — gramaj girilmemişse null. */
  totalGrams: number | null;
  /** Bu ürünün baskı dosyası olan yazıcılar (yazıcı sırasına göre). */
  printerIds: string[];
}

export interface QueuePrinter {
  id: string;
  name: string;
  brand: string;
  accent: string | null;
  /** printing | paused | idle | finished | error | offline | unknown */
  status: string;
  online: boolean;
  /** Şu an baskı yapıyor ya da duraklatılmış. */
  busy: boolean;
  /** Süren baskının kalan saniyesi (durum eskiyse/duraklatılmışsa null). */
  currentEtaSec: number | null;
  currentProductName: string | null;
  jobs: QueueJob[];
  /** Kuyruktaki bilinen sürelerin toplamı (saat). */
  queueHours: number;
  /** Kuyruktaki bilinen gramajların toplamı. */
  queueGrams: number;
  /** Süresi girilmemiş iş sayısı. */
  unknownTimeJobs: number;
  /** Tahmini bitiş (ISO) — süren baskının kalanı + kuyruk. Hesaplanamıyorsa null. */
  finishAt: string | null;
  /** Bitiş saati eksik bilgiyle hesaplandı mı (süresi girilmemiş iş var). */
  finishIsPartial: boolean;
}

export interface QueuePayload {
  targetStock: number;
  generatedAt: string;
  printers: QueuePrinter[];
  /** Hiçbir yazıcıda baskı dosyası olmayan işler — sessizce gizlenmez. */
  unassigned: QueueJob[];
  totals: {
    products: number;
    prints: number;
    hours: number;
    grams: number;
    unknownTimeJobs: number;
    unknownGramJobs: number;
  };
  filament: {
    neededGrams: number;
    remainingGrams: number;
    enough: boolean;
    spoolCount: number;
    /** Gramajı girilmemiş iş sayısı — "yeter" cevabı bu kadar eksik bilgiyle verildi. */
    unknownGramJobs: number;
  };
}

export interface QueueInput {
  products: QueueProductRow[];
  modelFiles: QueueModelFileRow[];
  printers: QueuePrinterRow[];
  snapshots: QueueSnapshotRow[];
  spoolRemainingGrams: number;
  spoolCount: number;
  targetStock: number;
  nowMs: number;
}

/** Sıfır ve geçersiz değerler "girilmemiş" sayılır — 0 saatlik baskı diye bir şey yok. */
function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * İşleri yazıcılara dağıtır ve her yazıcının kuyruğunu kurar.
 *
 * Dağıtım kuralı: uzun iş önce, o an EN AZ yüklü yazıcıya. Yazıcının başlangıç yükü, süren
 * baskının kalan süresidir → meşgul yazıcı boştakinin önüne geçmez. Süresi girilmemiş işler
 * yükü değiştirmez (bilinmeyen süreyle denge kurulamaz), en sona bırakılır.
 */
export function buildPrintQueue(input: QueueInput): QueuePayload {
  const { targetStock, nowMs } = input;

  // 1) Ürün → basabilen yazıcılar. Kapalı/silinmiş yazıcının dosyası sayılmaz.
  const printerOrder = input.printers.map((p) => p.id);
  const printerIdSet = new Set(printerOrder);
  const printersOfProduct = new Map<string, Set<string>>();
  for (const file of input.modelFiles) {
    if (file.productId === CUSTOM_PRODUCT_ID) continue;
    if (!printerIdSet.has(file.printerConfigId)) continue;
    let set = printersOfProduct.get(file.productId);
    if (!set) {
      set = new Set<string>();
      printersOfProduct.set(file.productId, set);
    }
    set.add(file.printerConfigId);
  }

  // 2) İşler — hedefin altındaki her ürün için "kaç adet basılmalı".
  // Hedef ÜRÜN BAŞINA gelir: talep modunda satış hızına göre değişir, satmayan üründe 0'dır.
  const jobs: QueueJob[] = [];
  for (const product of input.products) {
    const quantity = basilacakAdet(product.target, product.stock);
    if (quantity <= 0) continue;
    const hoursPerUnit = positive(product.printTimeHours);
    const gramsPerUnit = positive(product.filamentWeight);
    const owned = printersOfProduct.get(product.id);
    jobs.push({
      productId: product.id,
      name: product.name,
      imageUrl: product.imageUrl ?? null,
      stock: product.stock,
      quantity,
      hoursPerUnit,
      gramsPerUnit,
      totalHours: hoursPerUnit == null ? null : hoursPerUnit * quantity,
      totalGrams: gramsPerUnit == null ? null : gramsPerUnit * quantity,
      printerIds: owned ? printerOrder.filter((id) => owned.has(id)) : [],
    });
  }

  // 3) Yazıcı durumları — eskimiş durum "bilinmiyor"dur.
  const snapshotById = new Map(input.snapshots.map((s) => [s.printerConfigId, s]));
  const liveById = new Map<
    string,
    { status: string; online: boolean; busy: boolean; etaSec: number | null; productName: string | null }
  >();
  for (const printer of input.printers) {
    const snap = snapshotById.get(printer.id);
    const stale = snap == null || nowMs - snap.updatedAtMs > SNAPSHOT_STALE_MS;
    const status = stale ? "unknown" : snap.status;
    const online = !stale && snap.online;
    // Duraklatılmış baskının kalan süresi işlemiyor → o rakamla bitiş saati hesaplanamaz.
    const etaSec =
      !stale && online && snap.status === "printing" && snap.etaSec != null && snap.etaSec > 0
        ? Math.max(0, Math.round(snap.etaSec - (nowMs - snap.updatedAtMs) / 1000))
        : null;
    liveById.set(printer.id, {
      status,
      online,
      busy: online && (snap?.status === "printing" || snap?.status === "paused"),
      etaSec,
      productName: stale ? null : (snap?.productName ?? null),
    });
  }

  // 4) Dağıtım — uzun iş önce; süresi bilinmeyenler en sona (yük hesabına giremezler).
  const ordered = [...jobs].sort((a, b) => {
    const ah = a.totalHours;
    const bh = b.totalHours;
    if (ah != null && bh != null && ah !== bh) return bh - ah;
    if (ah != null && bh == null) return -1;
    if (ah == null && bh != null) return 1;
    if (a.quantity !== b.quantity) return b.quantity - a.quantity;
    return a.productId.localeCompare(b.productId);
  });

  const load = new Map<string, number>();
  for (const printer of input.printers) {
    load.set(printer.id, (liveById.get(printer.id)?.etaSec ?? 0) / 3600);
  }
  const assigned = new Map<string, QueueJob[]>();
  const unassigned: QueueJob[] = [];
  for (const job of ordered) {
    if (job.printerIds.length === 0) {
      unassigned.push(job);
      continue;
    }
    let best = job.printerIds[0];
    for (const id of job.printerIds) {
      if ((load.get(id) ?? 0) < (load.get(best) ?? 0)) best = id;
    }
    const list = assigned.get(best);
    if (list) list.push(job);
    else assigned.set(best, [job]);
    load.set(best, (load.get(best) ?? 0) + (job.totalHours ?? 0));
  }

  // 5) Yazıcı kartları.
  const printers: QueuePrinter[] = input.printers.map((printer) => {
    const list = assigned.get(printer.id) ?? [];
    const live = liveById.get(printer.id);
    let queueHours = 0;
    let queueGrams = 0;
    let unknownTimeJobs = 0;
    for (const job of list) {
      if (job.totalHours == null) unknownTimeJobs += 1;
      else queueHours += job.totalHours;
      if (job.totalGrams != null) queueGrams += job.totalGrams;
    }
    const finishable = list.length > 0 && queueHours > 0;
    return {
      id: printer.id,
      name: printer.name,
      brand: printer.brand,
      accent: printer.accent,
      status: live?.status ?? "unknown",
      online: live?.online ?? false,
      busy: live?.busy ?? false,
      currentEtaSec: live?.etaSec ?? null,
      currentProductName: live?.productName ?? null,
      jobs: list,
      queueHours,
      queueGrams,
      unknownTimeJobs,
      finishAt: finishable
        ? new Date(nowMs + (live?.etaSec ?? 0) * 1000 + queueHours * HOUR_MS).toISOString()
        : null,
      finishIsPartial: finishable && unknownTimeJobs > 0,
    };
  });

  // 6) Toplamlar + filament yeterliliği (otomatik düşüm YOK, yalnız karşılaştırma).
  let prints = 0;
  let hours = 0;
  let grams = 0;
  let unknownTimeJobs = 0;
  let unknownGramJobs = 0;
  for (const job of jobs) {
    prints += job.quantity;
    if (job.totalHours == null) unknownTimeJobs += 1;
    else hours += job.totalHours;
    if (job.totalGrams == null) unknownGramJobs += 1;
    else grams += job.totalGrams;
  }

  return {
    targetStock,
    generatedAt: new Date(nowMs).toISOString(),
    printers,
    unassigned,
    totals: { products: jobs.length, prints, hours, grams, unknownTimeJobs, unknownGramJobs },
    filament: {
      neededGrams: grams,
      remainingGrams: input.spoolRemainingGrams,
      enough: input.spoolRemainingGrams >= grams,
      spoolCount: input.spoolCount,
      unknownGramJobs,
    },
  };
}

/** İstenen hedef stok — geçersizse ayardan, o da yoksa varsayılandan. */
export function parseTarget(raw: string | null): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return null;
  return Math.min(999, Math.floor(value));
}

async function readTargetSetting(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: "plannerTargetStock" } });
  const parsed = parseTarget(row?.value ?? null);
  return parsed ?? DEFAULT_TARGET_STOCK;
}

/**
 * Ürün başına GÜNLÜK satış adedi — talep modunun girdisi.
 *
 * Sayım Üretim Planı'nın satış hızı ucuyla AYNI kuralları izler, yoksa kuyruk ile liste farklı
 * hedefler hesaplar ve ekranda iki ayrı gerçek belirir:
 *   • iptal satırları sayılmaz,
 *   • tarih karşılaştırması `dbEpochMs()` ile normalize edilir (kolonda hem epoch-ms tamsayı
 *     hem ISO metin bulunabiliyor; düz `>= ?` bir grubu SESSİZCE elerdi — bkz. sqlite-date.ts),
 *   • bölen ÖLÇÜLEN gün: pencereye bölmek 21 günlük veriyi 90'a yayıp herkesi "satmıyor" yapardı.
 */
async function readGunlukSatis(): Promise<Map<string, number>> {
  const now = Date.now();
  const since = now - SALES_WINDOW_DAYS * DAY_MS;
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT 0 AS "kind","productId", SUM("quantity") AS "adet", NULL AS "bas"
       FROM "OrderItemSnapshot"
      WHERE "productId" IS NOT NULL
        AND "statusKind" <> ?
        AND ${dbEpochMs("orderedAt")} >= ?
      GROUP BY "productId"
     UNION ALL
     SELECT 1 AS "kind", NULL AS "productId", NULL AS "adet",
            MIN(${dbEpochMs("orderedAt")}) AS "bas"
       FROM "OrderItemSnapshot"
      GROUP BY "platform"`,
    EXCLUDED_STATUS,
    since
  );

  const kapsamBasi = coverageStart(
    rows.filter((r) => Number(r.kind) === 1).map((r) => toInt(r.bas))
  );
  const gecmisGun = kapsamBasi == null ? 0 : Math.floor((now - kapsamBasi) / DAY_MS);
  const olculenGun = Math.max(1, Math.min(gecmisGun, SALES_WINDOW_DAYS));

  const out = new Map<string, number>();
  for (const row of rows) {
    if (Number(row.kind) !== 0) continue;
    const id = row.productId == null ? "" : String(row.productId);
    if (!id) continue;
    out.set(id, gunlukSatis(toInt(row.adet), olculenGun));
  }
  return out;
}

export async function computeQueue(
  target: number | null,
  hedefAyari?: { mod: HedefModu; kapsamGun: number }
): Promise<QueuePayload> {
  await ensureRuntimeSchema();
  const targetStock = target ?? (await readTargetSetting());
  const ayar: HedefAyari = {
    mod: hedefAyari?.mod ?? "sabit",
    tavan: targetStock,
    kapsamGun: hedefAyari?.kapsamGun ?? VARSAYILAN_KAPSAM_GUN,
  };

  // Talep modunda ürün başına hedef satış hızından çıkar → hız verisi gerekli.
  // Sabit modda okumaya GEREK YOK: uzak veritabanında her sorgu sıraya girdiği için
  // gereksiz bir tur, sayfanın açılışına doğrudan gecikme olarak yansırdı.
  const gunlukSatisById =
    ayar.mod === "talep" ? await readGunlukSatis() : new Map<string, number>();

  const [products, modelFiles, printers, snapshots, spools] = await Promise.all([
    prisma.product.findMany({
      // "Sipariş üzerine üretilir" ürünler stok tutmaz → plana girmez (Üretim Planı ile aynı kural).
      // Süzgeç TAVANA göre: talep modunda ürün başına hedef daha düşük olabilir, fazlası
      // aşağıda `basilacakAdet` ile elenir. Tavanın üstündeki stok her hâlükârda yeterlidir.
      where: { isActive: true, hidden: false, madeToOrder: false, stock: { lt: targetStock } },
      select: {
        id: true,
        name: true,
        imageUrl: true,
        stock: true,
        cost: { select: { printTimeHours: true, filamentWeight: true } },
      },
    }),
    prisma.productModelFile.findMany({
      select: { productId: true, printerConfigId: true },
    }),
    prisma.printerConfig.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, brand: true, accent: true },
    }),
    prisma.printerSnapshot.findMany({
      select: {
        printerConfigId: true,
        status: true,
        online: true,
        etaSec: true,
        productName: true,
        updatedAt: true,
      },
    }),
    prisma.filamentSpool.findMany({
      where: { isActive: true },
      select: { remainingGrams: true },
    }),
  ]);

  return buildPrintQueue({
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      imageUrl: p.imageUrl,
      stock: p.stock,
      printTimeHours: p.cost?.printTimeHours ?? null,
      filamentWeight: p.cost?.filamentWeight ?? null,
      target: hedefStok(ayar, gunlukSatisById.get(p.id) ?? 0),
    })),
    modelFiles,
    printers,
    snapshots: snapshots.map((s) => ({
      printerConfigId: s.printerConfigId,
      status: s.status,
      online: s.online,
      etaSec: s.etaSec,
      productName: s.productName,
      updatedAtMs: s.updatedAt.getTime(),
    })),
    spoolRemainingGrams: spools.reduce((sum, s) => sum + (s.remainingGrams || 0), 0),
    spoolCount: spools.length,
    targetStock,
    nowMs: Date.now(),
  });
}
