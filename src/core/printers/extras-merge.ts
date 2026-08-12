/**
 * Tek bir kaçan yan-bilgi sorgusu, BİLİNEN değerleri silmesin.
 *
 * Ölçülen davranış: `/printer/objects/query` 2500 ms'de yanıt vermezse `fetchMoonrakerExtras`
 * BOŞ tablo döndürüyor, 15 saniyelik önbellek de o boş tabloyu servis ediyordu. Ekrandaki
 * karşılığı: kurulu "600. katmanda duracak" rozeti kayboluyor, dört renkli filament çipi tek
 * yedek çipe düşüyor, "Işık açık" yerine "Işığı değiştir" yazıyor ve kontrol düğmeleri
 * (hız / ışık / katmanda duraklat / filament) bir anda yok olup 15 saniye sonra geri geliyor.
 *
 * Kural: okunamayan alan SON BİLİNEN değerinde kalır; yetenek keşfi de ayrı ele alınır
 * (`discovered=false` = "bilinmiyor", "desteklemiyor" değil).
 */
import type { MoonrakerExtras } from "./moonraker";

export function mergeMoonrakerExtras(
  prev: MoonrakerExtras | undefined,
  next: MoonrakerExtras,
): MoonrakerExtras {
  // Yetenekler AYRI önbellekte ve ayrı düşebiliyor: keşif başarısızsa son bilinen tabloyu koru.
  const caps = next.caps.discovered || !prev ? next.caps : prev.caps;
  if (next.read || !prev || !prev.read) return { ...next, caps };
  // Sorgu düştü ama elde gerçek bir okuma var → değerleri koru, yalnız yetenekleri tazele.
  return { ...prev, caps };
}
