import type { QueryClient } from "@tanstack/react-query";

import { isCancelledOrder, type OrdersResult } from "@/lib/api/orders";
import { syncOrderFinanceSnapshots } from "@/lib/db/finance";
import { computeOrderProfit, getProductMap, type OrderProfit } from "@/lib/order-profit";
import type { Rules } from "@/lib/profit";
import type { ProductDetail } from "@/lib/db/product-detail";

/**
 * AYLIK FİNANS GEÇMİŞİNİN YAZILMASI — artık Raporlar EKRANINA bağlı değil.
 *
 * ⚠️ NEDEN TAŞINDI: geçmişi yazan TEK tetikleyici Raporlar ekranının açılmasıydı. Kullanıcı
 * Raporlar'a nadiren (masa başında) bakıyor ve o sekme sekme çubuğundan çıkarılacak; ekran
 * açılmayınca geçmiş HİÇ yazılmaz, Raporlar'daki aylık rakamlar sessizce eksik kalırdı.
 *
 * TASARIM: bu senkron KENDİ BAŞINA AĞ İSTEĞİ AÇMAZ. React Query önbelleğinde zaten duran veriyi
 * okur (Panel açıldığında hepsi yükleniyor); veri yoksa hiçbir şey yapmadan döner. Yani açılışı
 * yavaşlatmaz, yalnız eldeki veriyi kalıcı hale getirir.
 */

export type FinanceSnapshotInput = Parameters<typeof syncOrderFinanceSnapshots>[0];

/**
 * Siparişlerden kalıcı finans satırlarını üret (saf dönüşüm).
 * Manuel siparişler HARİÇ: onların kaydı kendi tablosunda tutuluyor.
 */
export function buildFinanceSnapshots(
  orders: OrdersResult["orders"],
  products: ProductDetail[],
  rules: Rules,
  settings: Record<string, string>
): FinanceSnapshotInput {
  const pm = getProductMap(products);
  const out: FinanceSnapshotInput = [];
  for (const o of orders) {
    if (o.date == null || o.platform === "manual") continue;
    const op: OrderProfit = computeOrderProfit(o, pm, rules, settings);
    out.push({
      platform: o.platform,
      externalOrderId: o.id,
      orderNumber: o.orderNumber,
      orderedAt: o.date,
      revenue: op.revenue,
      profit: op.profit,
      profitPartial: op.partial,
      statusKind: isCancelledOrder(o) ? "cancelled" : "active",
      currency: o.currency ?? "TRY",
      // Gerçek komisyon bilgisi de yazılır — masaüstünün "platform kaynaklı" kârı korunur.
      profitSource: op.profitSource,
      estimatedCommission: op.estimatedCommission,
      actualCommission: op.actualCommission,
      // KALEMLER: ürün bazlı satış geçmişi (`OrderItemSnapshot`). Telefonla çalışılan günlerde
      // masaüstü kapalıysa bu satırlar hiç yazılmıyordu; pazaryeri penceresi kayınca o gün bir
      // daha geri gelmiyor ve "satış hızı" ile ürün kırılımı eksik kalıyordu.
      items: o.items.map((it) => ({
        productId: it.productId ?? null,
        productName: it.name,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
      })),
    });
  }
  return out;
}

/** İki senkron arası en kısa süre — aynı veriyi dakikada bir yeniden yazmanın anlamı yok. */
const MIN_ARALIK_MS = 10 * 60_000;
let sonCalisma = 0;
let calisiyor = false;
/** En son yazılan kümenin parmak izi — veri değişmediyse ağa hiç gidilmez. */
let sonImza = "";

/**
 * Önbellekteki veriyle finans geçmişini yaz. Ağ isteği AÇMAZ, veri yoksa sessizce çıkar.
 * `zorla` yalnız Raporlar ekranı için: kullanıcı oradayken beklemesin.
 * `zorlaKarYaz` reklam bütçesi değiştiğinde: donmuş kârlar yeni reklam payıyla yeniden yazılır,
 * yoksa Raporlar eski (reklamsız, yüksek) kârı göstermeye devam eder.
 */
export async function syncFinanceFromCache(
  qc: QueryClient,
  { zorla = false, zorlaKarYaz = false }: { zorla?: boolean; zorlaKarYaz?: boolean } = {}
): Promise<void> {
  if (calisiyor) return;
  const simdi = Date.now();
  if (!zorla && !zorlaKarYaz && simdi - sonCalisma < MIN_ARALIK_MS) return;

  const orders = qc.getQueryData<OrdersResult>(["orders"]);
  const products = qc.getQueryData<ProductDetail[]>(["match-products"]);
  const rules = qc.getQueryData<Rules>(["rules"]);
  const settings = qc.getQueryData<Record<string, string>>(["settings"]);
  if (!orders || !products || !rules || !settings) return; // veri yok → ağ açma, bekle

  const snapshots = buildFinanceSnapshots(orders.orders, products, rules, settings);
  if (snapshots.length === 0) return;

  // Aynı sonuç tekrar yazılmasın: sipariş sayısı + kâr toplamı yeterli bir parmak izi.
  const imza = `${snapshots.length}:${snapshots.reduce((t, s) => t + (s.profit ?? 0), 0).toFixed(2)}`;
  if (!zorla && !zorlaKarYaz && imza === sonImza) {
    sonCalisma = simdi;
    return;
  }

  calisiyor = true;
  try {
    await syncOrderFinanceSnapshots(snapshots, { zorlaKarYaz });
    sonCalisma = Date.now();
    sonImza = imza;
    void qc.invalidateQueries({ queryKey: ["monthly-finance"] });
  } catch {
    /* ağ hatası — bir sonraki turda yeniden denenir; kullanıcıya gösterilecek bir şey yok */
  } finally {
    calisiyor = false;
  }
}
