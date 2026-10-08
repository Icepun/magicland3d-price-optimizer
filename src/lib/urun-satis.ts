import { monthKey } from "./monthly-finance";
import { DAY_MS, MIN_HISTORY_DAYS, SALES_WINDOW_DAYS } from "./planner-insights";

/**
 * ÜRÜN DETAYI "SATIŞ GEÇMİŞİ" — saf hesap (9 Eki 2026 denetimi: detayda fiyat geçmişi vardı,
 * satış geçmişi yoktu).
 *
 * Yalnız ADET ve TARİH sayılır (kâr yok). Kurallar Üretim Planı'nın satış hızıyla AYNI: iptal
 * hariç, pencere 90 gün, geçmiş 21 günden kısaysa hız ve "kaç gün yeter" UYDURULMAZ (null).
 */
export interface UrunSatisSatiri {
  platform: string;
  orderedAt: number;
  quantity: number;
}

export interface UrunSatisOzeti {
  /** Son 6 ay (eskiden yeniye), platform başına adet. */
  aylar: { ay: string; etiket: string; adet: Record<string, number>; toplam: number }[];
  son90Adet: number;
  /** Hızın dayandığı gerçek gün sayısı (geçmiş kısaysa 90'dan az). */
  olculenGun: number;
  /** Yeterli geçmiş var mı (hız ve "kaç gün yeter" gösterilebilir mi)? */
  hazir: boolean;
  /** Ortalama kaç günde bir adet satıyor; satış yoksa null. */
  kacGundeBir: number | null;
  /** Mevcut stok bu hızla kaç gün yeter; satış yok / stok tutulmuyor / geçmiş kısa → null. */
  stokGunu: number | null;
}

const AYLAR = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

/** Mevcut stok bu hızla kaç gün yeter — hız ya da stok bilinmiyorsa null. */
export function stokKacGunYeter(stok: number | null | undefined, kacGundeBir: number | null): number | null {
  return kacGundeBir != null && stok != null && stok >= 0 ? stok * kacGundeBir : null;
}

export function urunSatisOzeti(
  satirlar: readonly UrunSatisSatiri[],
  kapsamBaslangicMs: number | null,
  nowMs: number,
  stok: number | null
): UrunSatisOzeti {
  // Son 6 ayın anahtarları (İstanbul takvimi).
  const simdi = monthKey(new Date(nowMs));
  const [y, m] = simdi.split("-").map(Number);
  const anahtarlar = Array.from({ length: 6 }, (_, i) => {
    const z = y * 12 + (m - 1) - (5 - i);
    return `${Math.floor(z / 12)}-${String((z % 12) + 1).padStart(2, "0")}`;
  });
  const aylar = new Map(anahtarlar.map((a) => [a, { ay: a, etiket: AYLAR[Number(a.slice(5)) - 1], adet: {} as Record<string, number>, toplam: 0 }]));

  const pencereBasi = nowMs - SALES_WINDOW_DAYS * DAY_MS;
  let son90Adet = 0;
  for (const s of satirlar) {
    if (!Number.isFinite(s.orderedAt) || s.quantity <= 0) continue;
    const kova = aylar.get(monthKey(new Date(s.orderedAt)));
    if (kova) {
      kova.adet[s.platform] = (kova.adet[s.platform] ?? 0) + s.quantity;
      kova.toplam += s.quantity;
    }
    if (s.orderedAt >= pencereBasi) son90Adet += s.quantity;
  }

  const gecmisGun = kapsamBaslangicMs == null ? 0 : Math.max(0, Math.floor((nowMs - kapsamBaslangicMs) / DAY_MS));
  const olculenGun = Math.max(1, Math.min(gecmisGun, SALES_WINDOW_DAYS));
  const hazir = gecmisGun >= MIN_HISTORY_DAYS;
  const kacGundeBir = hazir && son90Adet > 0 ? olculenGun / son90Adet : null;
  const stokGunu = stokKacGunYeter(stok, kacGundeBir);

  return { aylar: [...aylar.values()], son90Adet, olculenGun, hazir, kacGundeBir, stokGunu };
}
