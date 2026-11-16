import {
  etiketAnahtari,
  etiketBasilabilir,
  type EtiketSiparisi,
} from "@core/etiket-uygunluk";
import { HEPSIBURADA_STATUS_KINDS, TRENDYOL_STATUS_KINDS } from "@core/order-status-kind";

import type { UnifiedOrder } from "@/lib/api/orders";

/**
 * Telefon siparişini masaüstünün etiket kuralına (`@core/etiket-uygunluk`) çevirir: hangi
 * siparişte "Etiketi yazdır" çıkar ve "basıldı" işareti hangi anahtarla okunur — masaüstüyle aynı.
 */
export function etiketSiparisi(o: UnifiedOrder): EtiketSiparisi | null {
  if (o.platform !== "trendyol" && o.platform !== "hepsiburada") return null;
  const kinds = o.platform === "trendyol" ? TRENDYOL_STATUS_KINDS : HEPSIBURADA_STATUS_KINDS;
  return {
    platform: o.platform,
    id: o.id,
    orderNumber: o.orderNumber,
    trackingNumber: o.trackingNumber ?? null,
    packageNumber: o.packageNumber ?? null,
    statusKind: kinds[o.status]?.kind ?? "unknown",
  };
}

/** Etiket basılabilir siparişin anahtarı; basılamıyorsa null. */
export function basilabilirEtiketAnahtari(o: UnifiedOrder): string | null {
  const s = etiketSiparisi(o);
  return s && etiketBasilabilir(s) ? etiketAnahtari(s) : null;
}
