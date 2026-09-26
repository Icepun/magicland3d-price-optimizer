/**
 * YENİ SİPARİŞ BİLDİRİMİ — her sipariş için, GELDİĞİ ANDA, TEK bildirim.
 *
 * Eski düzenin üç kusuru vardı (23 Eyl 2026 incelemesi, canlı veriyle ölçüldü):
 *   1. Stokta olan ürüne gelen siparişte HİÇ bildirim yoktu — yalnız "stok yok" ve
 *      "sipariş üzerine üretim" vardı. Kullanıcı "siparişte bildirim gelmiyor" diyordu.
 *   2. "Sipariş üzerine üretim" uyarı seviyesindeydi → ne telefona ne masaüstü bildirimine
 *      gidiyor, yalnız zilde kalıyordu.
 *   3. Stok HER turda yeniden değerlendiriliyordu: stok 0'a düştüğü an, 7 güne kadar hâlâ açık
 *      siparişler için "Stoğu biten ürüne sipariş!" yeniden doğuyordu. 17 Eylül siparişinin
 *      bildirimi 21 Eylül'de geldi — kullanıcı ürünleri gezerken "çok eski bir siparişin
 *      bildirimi" görüyordu.
 *
 * Yeni kural: sipariş ilk görüldüğünde stoğa BİR KEZ bakılır, sonuç metne yazılır ve sipariş
 * bir daha bildirilmez. Kimlik sipariş NUMARASIDIR (paket id'si değil): Trendyol paket id'sini
 * ilk saniyelerde 0 verip sonra değiştirebiliyor, bölünmüş sipariş de iki paket olabiliyor.
 *
 * İki yol aynı fonksiyonu çağırır: 90 sn'lik hızlı tarama (lib/order-watch) ve Siparişler
 * hesabı (api/orders). Hangisi önce görürse o yazar; veritabanı tekilliği çifti engeller ve
 * telefona yalnız satırı GERÇEKTEN ekleyen taraf gönderir.
 */
import { prisma } from "./prisma";
import { pushToAllDevices } from "./push-notify";
import { toDbDate } from "./sqlite-date";

export type NotifyPlatform = "shopify" | "trendyol" | "hepsiburada";

export interface NotifyLine {
  name: string;
  quantity: number;
  /** Eşleşen katalog ürünü; eşleşmediyse null. */
  product: { id: string; name: string; stock: number; madeToOrder: boolean } | null;
}

export interface NotifyOrder {
  platform: NotifyPlatform;
  orderNumber: string;
  /** Siparişin verildiği an (epoch ms); bilinmiyorsa null. */
  orderedAtMs: number | null;
  /** Hâlâ hazırlanıp gönderilecek mi? Kapanmış/iptal siparişe bildirim yok. */
  actionable: boolean;
  lines: NotifyLine[];
}

export interface OrderNotification {
  id: string;
  type: "order-new";
  severity: "critical" | "warning" | "success";
  title: string;
  body: string;
  href: string;
}

const PLATFORM_LABEL: Record<NotifyPlatform, string> = {
  shopify: "Shopify",
  trendyol: "Trendyol",
  hepsiburada: "Hepsiburada",
};

/**
 * Bu kadar eski (tarihi bilinen) sipariş "yeni" sayılmaz. Hızlı taramanın penceresiyle aynı:
 * bilgisayar gece kapalı kaldıysa sabah açılınca gecenin siparişleri yine bildirilir, ama
 * haftalık açık kalmış bir sipariş bir anda "yeni" diye telefona düşmez.
 */
export const NEW_ORDER_WINDOW_MS = 2 * 86_400_000;
/** Taban çizgisinden bu kadar önce verilmiş sipariş de yeni sayılır (saat farkı / API gecikmesi payı). */
const TABAN_PAYI_MS = 10 * 60_000;
/** Tek turda telefona ayrı ayrı gidecek en fazla bildirim; fazlası tek özet olur. */
const AYRI_PUSH_SINIRI = 4;
const TABAN_ANAHTARI = "orderNotifyBaseline";

/** "#1124" → "1124". Shopify numarası diyezle geliyor; metin "Shopify ##1124" olmasın. */
export function orderNumberLabel(orderNumber: string): string {
  return orderNumber.trim().replace(/^#+/, "");
}

export function newOrderNotificationId(o: Pick<NotifyOrder, "platform" | "orderNumber">): string {
  return `order-new:${o.platform}:${orderNumberLabel(o.orderNumber)}`;
}

/** Saf: siparişin GELDİĞİ ANDAKİ stok durumuna göre tek bildirim. */
export function buildNewOrderNotification(o: NotifyOrder): OrderNotification {
  // Aynı ürün siparişte iki satırda geçebiliyor → tek satırda toplanır ("Ejderha ×2").
  const birlesik = new Map<string, NotifyLine>();
  for (const l of o.lines) {
    if (!(l.quantity > 0)) continue;
    const k = l.product ? `p:${l.product.id}` : `n:${l.name}`;
    const var_ = birlesik.get(k);
    if (var_) var_.quantity += l.quantity;
    else birlesik.set(k, { ...l });
  }
  const lines = [...birlesik.values()];
  const ad = (l: NotifyLine) => `${l.product?.name ?? l.name}${l.quantity > 1 ? ` ×${l.quantity}` : ""}`;
  const urunler =
    lines.length === 0
      ? "Sipariş"
      : lines.length <= 2
        ? lines.map(ad).join(", ")
        : `${ad(lines[0])} +${lines.length - 1} ürün`;
  const kaynak = `${PLATFORM_LABEL[o.platform]} #${orderNumberLabel(o.orderNumber)}`;

  const stokYok = lines.filter((l) => l.product && !l.product.madeToOrder && l.product.stock < l.quantity);
  const uretilecek = lines.filter((l) => l.product?.madeToOrder);
  const eslesmeyen = lines.filter((l) => !l.product);

  let severity: OrderNotification["severity"];
  let title: string;
  let durum: string;
  if (stokYok.length > 0) {
    severity = "critical";
    title = "Yeni sipariş — stok yok";
    durum =
      stokYok.length === lines.length
        ? "stokta yok"
        : `${stokYok.slice(0, 2).map((l) => l.product!.name).join(", ")} stokta yok`;
  } else if (uretilecek.length > 0) {
    severity = "warning";
    title = "Yeni sipariş — üretilecek";
    durum = "sipariş üzerine üretim";
  } else if (lines.length > 0 && eslesmeyen.length === lines.length) {
    severity = "warning";
    title = "Yeni sipariş";
    durum = "ürün eşleşmedi";
  } else {
    severity = "success";
    title = "Yeni sipariş";
    const tek = lines.length === 1 ? lines[0].product : null;
    durum = tek ? `stokta ${tek.stock} adet` : "stokta var";
  }
  if (eslesmeyen.length > 0 && eslesmeyen.length < lines.length) {
    durum += ` · ${eslesmeyen.length} ürün eşleşmedi`;
  }

  const tekUrun = lines.length === 1 ? lines[0].product : null;
  return {
    id: newOrderNotificationId(o),
    type: "order-new",
    severity,
    title,
    body: `${urunler} — ${kaynak} · ${durum}`,
    href: tekUrun ? `/products/${tekUrun.id}` : "/orders",
  };
}

/**
 * Bu süreçte okunan taban çizgisi. SÜREÇ GENELİ (globalThis): hızlı tarama ile Siparişler rotası
 * ayrı paketlere derleniyor (bkz. process-singleton), modül değişkeni iki kopya olurdu.
 */
const tabanKutu = ((globalThis as unknown as { __mlhub_siparisTaban?: { ms: number | null } })
  .__mlhub_siparisTaban ??= { ms: null });

async function tabanOku(): Promise<number | null> {
  if (tabanKutu.ms != null) return tabanKutu.ms;
  const row = await prisma.appSetting.findUnique({ where: { key: TABAN_ANAHTARI } });
  const ms = row ? Number(row.value) : NaN;
  if (Number.isFinite(ms) && ms > 0) tabanKutu.ms = ms;
  return tabanKutu.ms;
}

async function tabanYaz(ms: number): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: TABAN_ANAHTARI },
    create: { key: TABAN_ANAHTARI, value: String(ms) },
    update: {},
  });
  tabanKutu.ms = (await tabanOku()) ?? ms;
}

/**
 * Bildirimi yaz; satır GERÇEKTEN eklendiyse true döner (başka süreç/yol önce yazdıysa false).
 * `sessiz`: okunmuş olarak yazılır — zilde görünmez, yalnız "bu sipariş görüldü" işaretidir.
 */
async function yaz(n: OrderNotification, sessiz: boolean): Promise<boolean> {
  const simdi = toDbDate(new Date());
  const eklenen = await prisma.$executeRawUnsafe(
    `INSERT OR IGNORE INTO "Notification" ("id","type","severity","title","body","href","createdAt","acknowledgedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    n.id, n.type, n.severity, n.title, n.body, n.href, simdi, sessiz ? simdi : null,
  );
  return Number(eklenen) > 0;
}

/**
 * Siparişlerden yenilerini bildirir. Hata FIRLATMAZ (çağıranlar arka planda ateşler).
 * Dönen değer: bildirilen (sessiz olmayan) sipariş sayısı.
 */
export async function notifyNewOrders(orders: NotifyOrder[]): Promise<number> {
  try {
    const simdi = Date.now();
    const adaylar = new Map<string, NotifyOrder>();
    for (const o of orders) {
      if (!o.actionable || o.lines.length === 0) continue;
      if (!orderNumberLabel(o.orderNumber) || o.orderNumber === "—") continue;
      if (o.orderedAtMs != null && simdi - o.orderedAtMs > NEW_ORDER_WINDOW_MS) continue;
      const id = newOrderNotificationId(o);
      if (!adaylar.has(id)) adaylar.set(id, o);
    }
    if (adaylar.size === 0) return 0;

    const var_ = await prisma.notification.findMany({
      where: { id: { in: [...adaylar.keys()] } },
      select: { id: true },
    });
    const bilinen = new Set(var_.map((r) => r.id));
    const taze = [...adaylar.values()].filter((o) => !bilinen.has(newOrderNotificationId(o)));
    if (taze.length === 0) return 0;

    // İLK ÇALIŞMA: taban çizgisi yoksa şu an görünen siparişler SESSİZCE "görüldü" yazılır.
    // Yoksa güncellemeden sonraki ilk turda son 3 günün bütün açık siparişleri birden
    // "yeni sipariş" diye telefona düşerdi.
    const taban = await tabanOku();
    if (taban == null) {
      for (const o of taze) await yaz(buildNewOrderNotification(o), true);
      await tabanYaz(simdi);
      return 0;
    }

    const bildirilecek: OrderNotification[] = [];
    for (const o of taze) {
      const n = buildNewOrderNotification(o);
      // Taban çizgisinden ÖNCE verilmiş (tarihi bilinen) sipariş eski sayılır → sessiz işaret.
      const eski = o.orderedAtMs != null && o.orderedAtMs < taban - TABAN_PAYI_MS;
      const eklendi = await yaz(n, eski);
      if (eklendi && !eski) bildirilecek.push(n);
    }
    if (bildirilecek.length === 0) return 0;

    // Telefona: siparişler gider (stok/filament gitmez); siparişi KAPATAN telefona gitmez.
    const ayri =
      bildirilecek.length <= AYRI_PUSH_SINIRI ? bildirilecek : bildirilecek.slice(0, AYRI_PUSH_SINIRI - 1);
    for (const n of ayri) await pushToAllDevices(n.title, n.body, { tur: "siparis" }).catch(() => {});
    if (ayri.length < bildirilecek.length) {
      await pushToAllDevices(
        "Yeni siparişler",
        `${bildirilecek.length - ayri.length} yeni sipariş daha — uygulamada gör`,
        { tur: "siparis" },
      ).catch(() => {});
    }
    return bildirilecek.length;
  } catch {
    // Bildirim bir kolaylık; hatası sipariş akışını ASLA bozmamalı. Sonraki tur yeniden dener.
    return 0;
  }
}

/** Testler için: süreç içi taban çizgisi önbelleğini sıfırla. */
export function resetNewOrderBaselineCache(): void {
  tabanKutu.ms = null;
}
