/**
 * PANEL "BUGÜN" ŞERİDİ — günün yapılacakları tek satırda (9 Eki 2026 denetimi).
 * Gönderilecek siparişler, boşta bekleyen yazıcılar ve biten filament renkleri üç ayrı sayfada
 * duruyordu; Panel'e girince ilk bakışta görünsünler.
 *
 * Yazıcı durumu relay'in yazdığı PrinterSnapshot'tan okunur (yazıcıya BAĞLANILMAZ). Satır
 * bayatsa (relay kapalı / masaüstü uykuda) o yazıcı hakkında hüküm verilmez: "boşta" demek
 * yanlış bir "bas" çağrısı olurdu.
 */
export const YAZICI_BAYAT_MS = 2 * 60_000;

export interface YaziciSatiri {
  name: string;
  status: string;
  online: boolean;
  updatedAtMs: number | null;
}

export interface BugunYazici {
  bosta: string[];
  sorunlu: string[];
  basiyor: number;
  /** Durumu bayat olduğu için sayılmayan yazıcı sayısı. */
  bilinmiyor: number;
}

export function yaziciOzeti(satirlar: readonly YaziciSatiri[], nowMs: number): BugunYazici {
  const out: BugunYazici = { bosta: [], sorunlu: [], basiyor: 0, bilinmiyor: 0 };
  for (const y of satirlar) {
    if (y.updatedAtMs == null || nowMs - y.updatedAtMs > YAZICI_BAYAT_MS) {
      out.bilinmiyor++;
      continue;
    }
    if (!y.online) continue; // çevrimdışı yazıcı "boşta" değil
    if (y.status === "printing") out.basiyor++;
    else if (y.status === "error" || y.status === "paused") out.sorunlu.push(y.name);
    else out.bosta.push(y.name); // idle / finished / bilinmeyen-ama-çevrimiçi
  }
  return out;
}

/** Siparişler sayfasının "Gönderilecek" sayısıyla AYNI kural. */
export function gonderilecekSayisi(siparisler: readonly { statusKind?: string | null }[]): number {
  return siparisler.filter((o) => o.statusKind === "pending" || o.statusKind === "processing").length;
}
