// Göreli yol: kökteki testler bu modülü doğrudan içe aktarıyor ("@/" orada kök src demek).
import { color } from "../theme/tokens";

/**
 * YAZICI DURUMU — Atölye ve Yazıcılar ekranı TEK tablodan okur.
 *
 * Bir tur iki ayrı tablo vardı ve birbirini tutmuyordu: Atölye'de basan yazıcı yeşil
 * "Yazdırıyor", biten mor "Bitti"; Yazıcılar ekranında basan mor, biten yeşil "Tamamlandı".
 * Aynı yazıcı iki ekranda farklı renkte görünüyordu. Anlam: yeşil = iş başarıyla bitti,
 * mor (marka) = şu an basıyor.
 */
export const YAZICI_DURUM: Record<string, { label: string; color: string }> = {
  printing: { label: "Yazdırıyor", color: color.accentBright },
  paused: { label: "Duraklatıldı", color: color.warn },
  finished: { label: "Tamamlandı", color: color.good },
  idle: { label: "Hazır", color: color.textDim },
  error: { label: "Hata", color: color.bad },
  offline: { label: "Çevrimdışı", color: color.textFaint },
};

export function durumBilgisi(status: string, online = true): { label: string; color: string } {
  if (!online) return YAZICI_DURUM.offline;
  return YAZICI_DURUM[status] ?? YAZICI_DURUM.idle;
}

/** Listede sıra: en acil üstte — hata, duraklama, basan, biten, boştaki, bağlantısız. */
const SIRA: Record<string, number> = { error: 0, paused: 1, printing: 2, finished: 3, idle: 4, offline: 5 };

export function yazicilariSirala<T extends { status: string; online: boolean | number }>(liste: readonly T[]): T[] {
  const puan = (s: T) => (s.online ? (SIRA[s.status] ?? 4) : SIRA.offline);
  // Kararlı sıralama: aynı durumdakiler masaüstündeki (sortOrder) sırasını korur.
  return liste.map((s, i) => ({ s, i })).sort((a, b) => puan(a.s) - puan(b.s) || a.i - b.i).map((x) => x.s);
}

/** Kalan süre: "2 sa 15 dk", "12 dk", "40 sn"; bilinmiyorsa null. */
export function kalanSure(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const sa = Math.floor(sec / 3600);
  const dk = Math.floor((sec % 3600) / 60);
  if (sa > 0) return `${sa} sa ${dk} dk`;
  if (dk > 0) return `${dk} dk`;
  return `${Math.max(1, Math.floor(sec))} sn`;
}
