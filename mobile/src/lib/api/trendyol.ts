import type { UnifiedOrder } from "@/lib/api/orders";
import { fetchT } from "@/lib/api/http";
import { trendyolDateToUtc } from "@core/trendyol-date";
import { buildTrendyolWindows } from "@core/trendyol-windows";
import { trendyolOrderId } from "@core/trendyol-order-id";
import { anahtarListesi } from "@core/order-match";

const SELLER = process.env.EXPO_PUBLIC_TRENDYOL_SELLER_ID;
const KEY = process.env.EXPO_PUBLIC_TRENDYOL_API_KEY;
const SECRET = process.env.EXPO_PUBLIC_TRENDYOL_API_SECRET;
const INTEGRATOR = process.env.EXPO_PUBLIC_TRENDYOL_INTEGRATOR || "SelfIntegration";

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

interface TyOrder {
  /** Paket (shipmentPackage) id'si — aynı orderNumber bölününce her paket ayrı id alır. */
  id?: number | string;
  orderNumber?: string;
  orderDate?: number;
  status: string;
  customerFirstName?: string;
  customerLastName?: string;
  totalPrice?: number;
  grossAmount?: number;
  lines?: {
    productName?: string;
    quantity?: number;
    barcode?: string;
    sku?: string;
    merchantSku?: string;
    price?: number;
  }[];
}

/**
 * Son 30 GÜNÜN siparişleri (masaüstü route.ts ile birebir): /orders statü filtresi YOK →
 * TÜM statüler gelir. Ama tek sayfa size:100 son-100'le sınırlı → 30 günde 100+ sipariş varsa
 * eksik çekerdi (kâr yanlış). Çözüm: 14 GÜNLÜK pencerelerle (Trendyol startDate/endDate aralık
 * limiti ≤2 hafta) tara + her pencerede sayfala; id'ye göre tekilleştir.
 */
export async function getTrendyolOrders(historyDays = 30): Promise<UnifiedOrder[]> {
  if (!SELLER || !KEY || !SECRET) return [];
  const token = base64(`${KEY}:${SECRET}`);
  const ua = `${SELLER} - ${INTEGRATOR.replace(/[^a-zA-Z0-9]/g, "").slice(0, 30) || "SelfIntegration"}`;

  const safeDays = Math.max(1, Math.min(60, Math.trunc(historyDays)));
  const cutoff = (Math.floor(Date.now() / 86_400_000) - safeDays) * 86_400_000;
  const seen = new Set<string>();
  const orders: UnifiedOrder[] = [];

  /**
   * ⚠️ PENCERELER ORTAK ÇEKİRDEKTEN — masaüstüyle BİREBİR (`@core/trendyol-windows`).
   *
   * Burada tam 14 günlük dilim vardı; üstüne saat dilimi payı iki uçtan 3'er saat eklenince
   * açıklık 14 gün 6 saate çıkıyor, Trendyol da 2 haftayı aşan aralığı SESSİZCE kırpıp EN YENİ
   * saatleri atıyordu. Sonuç: son birkaç saatin Trendyol siparişleri telefonda HİÇ görünmüyordu —
   * listede, Panel cirosunda, hazırlık listesinde. (23 Eyl 2026 canlı ölçüm: 22:46 ve 22:57
   * siparişleri eksikti; masaüstü aynı hatayı 13 Ağu'da düzeltmişti ama düzeltme masaüstüne özel
   * bir dosyada kaldığı için telefona hiç ulaşmamıştı.)
   *
   * Pencereler PARALEL çekilir; sayfalama pencere içinde ardışık kalır. Tekilleştirme, sonuçlar
   * sıralı birleştirilirken `seen` ile yapılır.
   */
  const pencereler = buildTrendyolWindows(Date.now(), cutoff);
  const perChunk = await Promise.all(
    pencereler.map(async ({ startDate, endDate }) => {
      const rows: { key: string; o: TyOrder }[] = [];
      for (let pageNo = 0; pageNo < 50; pageNo++) {
        const res = await fetchT(
          // Sınırlar `buildTrendyolWindows` içinde iki uçtan 3'er saat genişletilmiş hâlde gelir
          // (Trendyol duvar saati düzlemi) ve açıklık 14 günü AŞMAZ.
          `https://apigw.trendyol.com/integration/order/sellers/${SELLER}/orders?page=${pageNo}&size=100&startDate=${startDate}&endDate=${endDate}&orderByField=PackageLastModifiedDate&orderByDirection=DESC`,
          { headers: { Authorization: `Basic ${token}`, Accept: "application/json", "User-Agent": ua } }
        );
        if (!res.ok) throw new Error(`Trendyol siparişler: HTTP ${res.status}`);
        const json = (await res.json()) as { content?: TyOrder[] };
        const content = json.content ?? [];
        for (const [i, o] of content.entries()) {
          // Masaüstüyle AYNI kimlik: paket id'si 0 gelen yeni sipariş "ty-0"da birleşip
          // diğerini silmesin, finans geçmişine hayalet çift kayıt yazmasın.
          rows.push({ key: trendyolOrderId(o, `${endDate}-${pageNo}-${i}`), o });
        }
        if (content.length < 100) break; // son sayfa
      }
      return rows;
    })
  );

  for (const rows of perChunk) {
    // Masaüstü route.ts:318 ile birebir: PAKET id'siyle tekilleştir (orderNumber DEĞİL).
    // Bölünmüş siparişte (UnPacked/kısmi iptal) aynı orderNumber'ın iki paketi iki kayıttır;
    // orderNumber-bazlı tekilleştirme ikinci paketi DÜŞÜRÜYORDU → ciro/kâr masaüstünden sapıyordu.
    for (const { key, o } of rows) {
      if (seen.has(key)) continue; // pencere sınırı çakışması olursa çift sayma
      seen.add(key);
      orders.push({
        id: key,
        platform: "trendyol" as const,
        orderNumber: String(o.orderNumber ?? o.id ?? "—"),
        // Masaüstüyle AYNI çeviri: Trendyol'un damgası Türkiye duvar saatini taşıyor,
        // gerçek UTC'ye çevrilmezse sipariş 3 saat ileri görünür.
        date: trendyolDateToUtc(o.orderDate)?.getTime() ?? null,
        status: o.status,
        customer: [o.customerFirstName, o.customerLastName].filter(Boolean).join(" ") || null,
        // Masaüstüyle birebir savunmalı alanlar (totalPrice gelmezse NaN ciroya bulaşmasın).
        total: Number(o.totalPrice ?? o.grossAmount ?? 0),
        items: (o.lines ?? []).map((l) => ({
          name: l.productName ?? l.barcode ?? "Ürün",
          quantity: Number(l.quantity ?? 1),
          unitPrice: Number(l.price ?? 0),
          // Trendyol order satırı barcode verir ("merchantSku" literal'i çöp → ele) — masaüstü route.ts:338.
          matchKeys: [l.barcode, l.sku, l.merchantSku].filter(
            (k): k is string => !!k && k !== "merchantSku"
          ),
          // Türüne göre (masaüstü route.ts ile birebir) — eşleştirme güven sırası için.
          barcodes: anahtarListesi(l.barcode),
          externalIds: [],
          skus: anahtarListesi(l.sku, l.merchantSku).filter((k) => k !== "merchantSku"),
        })),
      });
    }
  }
  return orders;
}
