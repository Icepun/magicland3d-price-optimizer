import { processSingleton } from "./process-singleton";

/**
 * BİTİŞ ÇAPASI — yazıcının kalan süresi DAKİKA hassasiyetindeyse (Bambu `mc_remaining_time`) bitiş
 * anını yalnız o değer DEĞİŞİNCE yeniden kur.
 *
 * NEDEN (denetim, 23 Kas 2026): bitiş her yoklamada "şimdi + kalan" diye yeniden kuruluyordu. Kalan
 * süre bir dakika boyunca aynı kaldığı için ekrandaki sayaç 2 saniyede bir "34dk 58sn → 35dk 00sn"
 * diye GERİ zıplıyordu; telefon da her kalp atışında +30 sn atlıyordu (bitiş = yazma anı + kalan).
 * Çapayla bitiş anı sabit kalır, sayaç düzgün akar; telefona yazılan kalan süre de yazma anına göre
 * doğru olur.
 *
 * Panel (rota) ve relay AYRI pakette derlenir → kutu `processSingleton` (ikisi aynı çapayı görsün).
 */
const capalar = processSingleton("bitis_capalari", () => new Map<string, { kaynak: number; bitisMs: number }>());

/**
 * @param anahtar  yazıcı + dosya (başka bir baskıya geçince çapa sıfırlanır)
 * @param kaynakSn yazıcının bildirdiği kalan süre (çapanın değişim işareti)
 * @param hesapSn  ekranda kullanılacak kalan süre (çoğu zaman kaynakla aynı)
 * @returns sabitlenmiş bitiş anı (ms); kalan süre bilinmiyorsa null
 */
export function bitisCapasi(anahtar: string, kaynakSn: number | null, hesapSn: number | null, simdi: number): number | null {
  if (kaynakSn == null || hesapSn == null || !Number.isFinite(hesapSn)) {
    capalar.delete(anahtar);
    return null;
  }
  const onceki = capalar.get(anahtar);
  if (onceki && onceki.kaynak === kaynakSn && onceki.bitisMs >= simdi) return onceki.bitisMs;
  const bitisMs = simdi + Math.max(0, hesapSn) * 1000;
  capalar.set(anahtar, { kaynak: kaynakSn, bitisMs });
  // Sınırsız büyümesin (yazıcı × dosya; günde birkaç düzine).
  if (capalar.size > 200) {
    const ilk = capalar.keys().next().value;
    if (ilk != null) capalar.delete(ilk);
  }
  return bitisMs;
}
