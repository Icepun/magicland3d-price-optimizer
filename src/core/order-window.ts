/**
 * SİPARİŞ LİSTESİ PENCERESİ — masaüstü ve telefonun ORTAK kuralı (sync-core ile kopyalanır).
 *
 * Liste son 30 günde VERİLEN siparişleri gösterir. İSTİSNA: işi BİTMEMİŞ (bekleyen /
 * hazırlanan) ELLE EKLENEN sipariş tarihine bakılmadan listede ve hazırlıkta kalır.
 *
 * NEDEN (4 Eki 2026): 3 Eylül'de girilen ₺3.000'lik özel sipariş henüz gönderilmemişken 30 günü
 * geçti; listeden ve hazırlıktan düştü, kullanıcı "silindi" sandı. Özel üretim siparişleri 30
 * günden uzun sürebiliyor ve onları takip eden başka bir sistem yok.
 *
 * Pazaryeri siparişleri BİLEREK kapsam dışı: Shopify'da gönderildi diye işaretlenmemiş eski
 * siparişler hep "bekliyor" görünür ve hazırlık listesini kirletirdi; pazaryerinin kendi paneli
 * zaten takip ediyor.
 *
 * ⚠️ Ciro/kâr ÖZETLERİ bu kurala UYMAZ — onlar yalnız pencere içinde verilen siparişleri sayar.
 */
import type { OrderStatusKind } from "./order-status-kind";

/** Tarihine bakılmadan listede kalan (işi bitmemiş) durum kovaları. */
export const ACIK_SIPARIS_TURLERI: ReadonlySet<OrderStatusKind> = new Set<OrderStatusKind>([
  "pending",
  "processing",
]);

export interface ListeSiparisi {
  platform: string;
  /** Ortak durum kovası (bilinmiyorsa null). */
  statusKind: OrderStatusKind | null | undefined;
  /** Sipariş verme anı (epoch ms); bilinmiyorsa null. */
  tarihMs: number | null | undefined;
}

/** Sipariş listede (ve hazırlıkta) görünmeli mi? `kesimMs` = pencerenin ilk anı. */
export function siparisListedeKalir(siparis: ListeSiparisi, kesimMs: number): boolean {
  const { tarihMs } = siparis;
  // Tarihi bilinmeyen sipariş her zaman dahil (eskiden de böyleydi).
  if (tarihMs == null || !Number.isFinite(tarihMs)) return true;
  if (tarihMs >= kesimMs) return true;
  return (
    siparis.platform === "manual" &&
    siparis.statusKind != null &&
    ACIK_SIPARIS_TURLERI.has(siparis.statusKind)
  );
}
