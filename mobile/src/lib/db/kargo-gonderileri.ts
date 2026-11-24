import {
  KARGO_DURUM_ETIKETI,
  kargoOlaylariOku,
  type KargoDurumu,
  type KargoGonderiOzeti,
} from "@core/kargo-gonderisi";
import { query } from "@/lib/turso";

/**
 * Uygulamadan açılan HepsiJet gönderileri (`CargoShipment`, masaüstü yazar — telefon yalnız okur).
 * Kanonik sipariş kimliği ("sh-<no>") → güncel gönderi; masaüstü `lib/kargo/kargo-gonderileri`
 * ile aynı seçim: iptal edilmemiş olan önce, ikisi de aynıysa en yenisi. Tablo yoksa boş.
 */
interface Satir {
  externalOrderId: string;
  environment: string;
  barcode: string;
  status: string;
  statusText: string | null;
  lastEventAtMs: number | null;
  shopifyShippedAtMs: number | null;
  shopifyDeliveredAtMs: number | null;
  shopifyError: string | null;
  createdAtMs: number;
  eventsJson: string | null;
}

const sayi = (v: unknown): number | null => {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? null : n;
};

export async function kargoGonderileriOku(simdi = Date.now()): Promise<Record<string, KargoGonderiOzeti>> {
  let satirlar: Satir[];
  try {
    satirlar = await query<Satir>(
      `SELECT externalOrderId, environment, barcode, status, statusText, lastEventAtMs, shopifyShippedAtMs,
              shopifyDeliveredAtMs, shopifyError, createdAtMs, eventsJson
         FROM CargoShipment
        WHERE platform = 'shopify' AND createdAtMs > ?
        ORDER BY createdAtMs ASC`,
      [simdi - 90 * 24 * 60 * 60_000]
    );
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return {};
    throw e;
  }
  const secilen = new Map<string, Satir>();
  for (const s of satirlar) {
    const onceki = secilen.get(s.externalOrderId);
    if (!onceki || onceki.status === "iptal" || s.status !== "iptal") secilen.set(s.externalOrderId, s);
  }
  const sonuc: Record<string, KargoGonderiOzeti> = {};
  for (const [kimlik, s] of secilen) {
    const durum = (s.status in KARGO_DURUM_ETIKETI ? s.status : "olusturuldu") as KargoDurumu;
    sonuc[kimlik] = {
      barkod: s.barcode,
      firma: "hepsijet",
      ortam: s.environment === "prod" ? "prod" : "test",
      durum,
      metin: s.statusText?.trim() || KARGO_DURUM_ETIKETI[durum],
      olusturmaAni: sayi(s.createdAtMs) ?? 0,
      sonOlayAni: sayi(s.lastEventAtMs),
      olaylar: kargoOlaylariOku(s.eventsJson),
      shopifyGonderildi: sayi(s.shopifyShippedAtMs),
      shopifyTeslim: sayi(s.shopifyDeliveredAtMs),
      shopifyHata: s.shopifyError ?? null,
    };
  }
  return sonuc;
}
