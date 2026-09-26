import {
  hbArray,
  hbSiparisleriTopla,
  hbStr,
  hbTalepSayfasi,
  hbTarihMs,
  type HbPaketDurumu,
  type HbTalepTuru,
} from "@core/hb-siparis";
import { anahtarListesi } from "@core/order-match";

import type { HbDetayKaydi } from "@/lib/api/hb-detay-bicim";
import type { OrderItem, UnifiedOrder } from "@/lib/api/orders";
import { fetchT } from "@/lib/api/http";

/**
 * Hepsiburada siparişleri (mobil) — masaüstü src/app/api/orders/route.ts HB bloğunun
 * RN-güvenli portu. Node API yok (Buffer/fs/net yok); fetch + globalThis.btoa kullanır.
 *
 * Auth (DOĞRULANDI, masaüstü hepsiburada-client.ts): HTTP Basic = base64(merchantId:secretKey)
 * + ZORUNLU `User-Agent: <developerUsername>` header. merchantId ayrıca path param.
 * Ortam: "live"→canlı host, aksi halde "test" (SIT).
 *
 * Siparişler TEK uçtan gelmez: /orders sadece "Open" (paketlenecek) FLAT kalem listesi verir;
 * kargoda/teslim siparişler /packages/.../{shipped|delivered|undelivered} ÖZETLERİNDE
 * (tutar/kalem YOK) → tutarlar getOrderDetail ile ayrı çekilir. İptal/iade ayrı listelerde.
 *
 * Listeleri çekme + birleştirme kuralları masaüstüyle ORTAK çekirdekte (`@core/hb-siparis`):
 * bu dosyanın kendi kopyası geride kalmıştı (iptal/iade hiç okunmuyordu, özet listede teslim
 * tarihi sipariş tarihi sayılıyordu, açık siparişler tek sayfaydı).
 */

const MERCHANT_ID = process.env.EXPO_PUBLIC_HEPSIBURADA_MERCHANT_ID;
const SECRET_KEY = process.env.EXPO_PUBLIC_HEPSIBURADA_SECRET_KEY;
const DEV_USERNAME = process.env.EXPO_PUBLIC_HEPSIBURADA_DEV_USERNAME;
// env: "live" → canlı; aksi (test/boş) → SIT test ortamı.
const ENV = (process.env.EXPO_PUBLIC_HEPSIBURADA_ENV || "live").toLowerCase();

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** ASCII string → base64 (RN'de Buffer yok; btoa varsa onu kullan). */
function base64(str: string): string {
  if (typeof globalThis.btoa === "function") return globalThis.btoa(str);
  let out = "";
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i);
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < str.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < str.length ? B64[c & 63] : "=";
  }
  return out;
}

/** Ortam bazlı OMS host (canlı vs SIT). Masaüstü hepsiburadaHosts() ile aynı. */
function omsHost(): string {
  return ENV === "live"
    ? "https://oms-external.hepsiburada.com"
    : "https://oms-external-sit.hepsiburada.com";
}

/* ── Defansif HB yardımcıları (masaüstü route.ts ile birebir) ───────────────── */

function hbNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "amount" in (v as Record<string, unknown>)) {
    return Number((v as { amount?: unknown }).amount) || 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** HB sipariş/detay kalemi → mobil OrderItem (tutar + eşleştirme anahtarları). */
function hbLineRaw(li: Record<string, unknown>): OrderItem {
  const qty = Math.max(1, Math.floor(hbNum(li.quantity ?? li.amount ?? 1)));
  const unit = hbNum(li.unitPrice ?? li.price) || hbNum(li.totalPrice) / qty;
  return {
    name: hbStr(li.productName, li.name, li.title, li.barcode, li.merchantSku) || "Ürün",
    quantity: qty,
    unitPrice: unit,
    // Masaüstü route.ts:151 ile birebir anahtar listesi (hbSku dahil).
    matchKeys: [li.merchantSku, li.hbSku, li.sku, li.barcode, li.stockCode, li.hepsiburadaSku].filter(
      (k): k is string => typeof k === "string" && !!k
    ),
    // Türüne göre (masaüstü hbLineRaw ile birebir) — eşleştirme güven sırası için.
    barcodes: anahtarListesi(li.barcode),
    externalIds: anahtarListesi(li.hbSku, li.hepsiburadaSku),
    skus: anahtarListesi(li.merchantSku, li.sku, li.stockCode),
  };
}

/** items'i en çok `limit` eşzamanlı worker ile işle (detay çağrılarını sınırla). */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    })
  );
}

/* ── HB istek (auth header + hata) ──────────────────────────────────────────── */

function headers(): Record<string, string> {
  const token = base64(`${MERCHANT_ID}:${SECRET_KEY}`);
  return {
    Authorization: `Basic ${token}`,
    Accept: "application/json",
    // HB User-Agent'ı ZORUNLU tutuyor → developer username. Eksikse 403.
    "User-Agent": DEV_USERNAME || "MagiclandHub",
  };
}

/** HB'nin reddettiği istek — HTTP durumu `status`ta (iptal/iade yol denemesi buna bakar). */
class HbApiHatasi extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HbApiHatasi";
    this.status = status;
  }
}

async function hbRequest(path: string): Promise<unknown> {
  const res = await fetchT(`${omsHost()}${path}`, { headers: headers() });
  const text = await res.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const detail =
      typeof body === "string"
        ? body.slice(0, 200)
        : ((body as Record<string, unknown>)?.message as string) || res.statusText;
    throw new HbApiHatasi(res.status, `Hepsiburada API ${res.status}: ${detail}`);
  }
  return body;
}

const MID = () => encodeURIComponent(MERCHANT_ID ?? "");

/** Ödemesi tamamlanmış ("Open"/paketlenecek) siparişler. Sayfalı. */
function listOrders(params: { offset?: number; limit?: number } = {}): Promise<unknown> {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;
  return hbRequest(`/orders/merchantid/${MID()}?offset=${offset}&limit=${limit}`);
}

/** Paket statü listesi (özet: OrderNumber + tarih; tutar/kalem YOK). */
function listPackages(
  status: HbPaketDurumu = "",
  params: { offset?: number; limit?: number } = {}
): Promise<unknown> {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;
  const path = status ? `/packages/merchantid/${MID()}/${status}` : `/packages/merchantid/${MID()}`;
  return hbRequest(`${path}?offset=${offset}&limit=${limit}`);
}

/** Sipariş detayı (kalem + tutarlar). Özet uçların döndürmediği fiyatlar buradan. */
function getOrderDetail(orderNumber: string): Promise<unknown> {
  return hbRequest(`/orders/merchantid/${MID()}/ordernumber/${encodeURIComponent(orderNumber)}`);
}

/* ── Birleştirme (listeler çekirdekte, detay + önbellek burada) ─────────────── */

/** Sipariş detayı önbelleği (modül seviyesi). Kalemler/tutar/müşteri/sipariş-tarihi
 *  sipariş verildikten sonra DEĞİŞMEZ → her ["orders"] yenilemesinde aynı ~50-80 detay çağrısını
 *  tekrarlamak boşunaydı (yenileme 3-8sn). İlk yenilemeden sonra yalnız YENİ siparişler çekilir. */
const detailCache = new Map<string, HbDetayKaydi>();
const DETAIL_CACHE_MAX = 600;

/**
 * Önbelleğin DİSKTEKİ deposu — uygulama açılışta kurar (`lib/api/hb-detay-onbellek`).
 *
 * Bellek önbelleği yalnız oturum boyuydu: her soğuk açılışta aynı ~40 detay yeniden çekiliyordu
 * (ölçüldü: açılıştaki 53 isteğin 41'i). Bu modül dosya sistemine DOĞRUDAN dokunmaz — sipariş
 * hattı Node'da da çalışsın (masaüstüyle rakam karşılaştırma düzeneği); depo verilmezse yalnız
 * bellek kullanılır, davranış aynıdır.
 */
export interface HbDetayDeposu {
  yukle: (hedef: Map<string, HbDetayKaydi>) => void;
  kaydet: (kaynak: Map<string, HbDetayKaydi>, enCok: number) => void;
}
let depo: HbDetayDeposu | null = null;
let depoOkundu = false;
export function hbDetayDeposunuKur(d: HbDetayDeposu): void {
  depo = d;
  depoOkundu = false;
}

export async function getHepsiburadaOrders(historyDays = 30): Promise<UnifiedOrder[]> {
  // Kimlik bilgisi eksikse sessizce boş (trendyol.ts/shopify.ts gibi).
  if (!MERCHANT_ID || !SECRET_KEY || !DEV_USERNAME) return [];

  if (depo && !depoOkundu) {
    depoOkundu = true;
    depo.yukle(detailCache);
  }

  const safeDays = Math.max(1, Math.min(60, Math.trunc(historyDays)));
  const cutoff = (Math.floor(Date.now() / 86_400_000) - safeDays) * 86_400_000;

  // a-b) Açık siparişler (sayfalı), paket listeleri ve iptal/iade listeleri → tek harita.
  //      Kurallar masaüstüyle ORTAK: özet listelerde tarih = siparişin VERİLİŞ anı (teslim/kargo
  //      damgası değil — finans geçmişinin ayı buna bağlı); iptal/iade yalnız kaydın KENDİ durumu
  //      iptal/iade diyorsa aktif siparişi ezer (güvenlik freni).
  // İptal/iade yol hafızası bu çekim boyunca (masaüstünde istemci örneği başına, aynı ömür).
  const talepYollari = new Map<HbTalepTuru, string | null>();
  const { siparisler: agg } = await hbSiparisleriTopla(
    {
      acikSiparisler: (offset, limit) => listOrders({ offset, limit }),
      paketler: (durum, offset, limit) => listPackages(durum, { offset, limit }),
      talepler: (tur, offset, limit) =>
        hbTalepSayfasi(tur, { offset, limit }, { merchantId: MERCHANT_ID, hafiza: talepYollari, iste: hbRequest }),
    },
    hbLineRaw
  );

  // 30 güne filtrele (tarihsizleri tut) — detay çekmeden ÖNCE (gereksiz çağrı olmasın).
  for (const [on, e] of [...agg]) if (e.date != null && e.date < cutoff) agg.delete(on);

  // c) Tutarı olmayan (özetten gelen) siparişlerin detayı: önce ÖNBELLEK, kalanlar PARALEL
  //    (concurrency 8, cap 250). Detay verisi değişmez → oturum boyunca bir kez çekilir.
  const needDetail: string[] = [];
  for (const [on, e] of agg) {
    if (e.lines !== null) continue;
    const cached = detailCache.get(on);
    if (cached) {
      e.lines = cached.lines;
      e.customer = e.customer ?? cached.customer;
      if (cached.date != null) e.date = cached.date;
    } else {
      needDetail.push(on);
    }
  }
  let yeniDetay = false;
  await mapLimit(needDetail.slice(0, 250), 8, async (on) => {
    try {
      const d = (await getOrderDetail(on)) as Record<string, unknown>;
      const e = agg.get(on);
      if (!e) return;
      e.lines = (hbArray(d, ["items", "lineItems", "details", "lines", "orderItems"]) as Record<string, unknown>[]).map(
        hbLineRaw
      );
      const customer =
        d.customer && typeof d.customer === "object"
          ? (d.customer as Record<string, unknown>)
          : null;
      e.customer = e.customer ?? (hbStr(customer?.name, d.customerName) || null);
      // Sipariş VERME tarihini tercih et (kargo/teslim değil) → liste + 30g penceresi sipariş tarihine
      // göre (masaüstü v0.19.58). Özet listeden gelen tarih (oluşturulma/paket hazır) bununla ezilir.
      const od = hbTarihMs(d.orderDate, d.createdDate);
      if (od != null) e.date = od;
      // Başarılı detayı önbelleğe koy (kalem varsa) — kapasite aşımında en eskiyi düş.
      if (e.lines.length > 0) {
        if (detailCache.size >= DETAIL_CACHE_MAX) {
          const first = detailCache.keys().next().value;
          if (first != null) detailCache.delete(first);
        }
        detailCache.set(on, { lines: e.lines, customer: e.customer, date: od ?? null });
        yeniDetay = true;
      }
    } catch {
      /* detay alınamadı → o sipariş kalemsiz (kârsız) görünür, listede kalır; önbelleğe girmez */
    }
  });

  if (yeniDetay && depo) depo.kaydet(detailCache, DETAIL_CACHE_MAX);

  // d) Birleşik UnifiedOrder'lar (mobil şekil: date = epoch ms, total = Σ unitPrice*qty).
  const orders: UnifiedOrder[] = [];
  for (const [on, e] of agg) {
    const lines = e.lines ?? [];
    orders.push({
      id: `hb-${on}`,
      platform: "hepsiburada",
      orderNumber: on,
      // Masaüstüyle birebir: tarih bilinmiyorsa null (bugünmüş gibi EN ÜSTE koymak trend/sıralamayı bozuyordu).
      date: e.date ?? null,
      status: e.status, // ham etiket: Open/Packaged/Shipped/Delivered/UnDelivered/Cancelled/Returned → statusInfo() çevirir
      customer: e.customer,
      total: lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
      items: lines,
      // Detayı alınamayan (ya da çekim sınırının dışında kalan) sipariş: tutarı bilinmiyor.
      // Gerçek bir siparişin sıfır kalemi olmaz — boş liste de aynı anlama gelir (masaüstüyle aynı).
      dataIncomplete: lines.length === 0,
    });
  }
  return orders;
}
