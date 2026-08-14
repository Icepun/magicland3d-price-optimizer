/**
 * ETA'nın DONDURULMUŞ HIZI — yazıcı başına küçük bir hafıza.
 *
 * `resolveEta` saf bir fonksiyondur ve durum tutmaz; hızın iki ilerleme adımı arasında
 * dondurulabilmesi için son sonucun bir yerde saklanması gerekir. Burası orası.
 *
 * Hafıza DOSYAYA bağlıdır: yazıcı başka bir dosyaya geçtiğinde (ya da aynı dosya yeniden
 * başlatıldığında ilerleme geri düştüğünde) eski hız taşınmaz.
 */

interface Kayit {
  dosya: string;
  progress: number;
  totalSec: number;
}

const hafiza = new Map<string, Kayit>();

/** Bu yazıcı+dosya için saklanan hız. Eşleşme yoksa null (ilk hesap normal yoldan yapılır). */
export function etaHafizasiOku(
  printerId: string,
  dosya: string | null,
): { progress: number; totalSec: number } | null {
  if (!dosya) return null;
  const k = hafiza.get(printerId);
  if (!k || k.dosya !== dosya) return null;
  return { progress: k.progress, totalSec: k.totalSec };
}

/** Hesap sonucunu sakla. `totalSec` yoksa kayıt silinir (bilinmeyen hız taşınmamalı). */
export function etaHafizasiYaz(
  printerId: string,
  dosya: string | null,
  progress: number,
  totalSec: number | null,
): void {
  if (!dosya || totalSec == null || !Number.isFinite(totalSec) || totalSec <= 0) {
    hafiza.delete(printerId);
    return;
  }
  hafiza.set(printerId, { dosya, progress, totalSec });
}

/** Baskı bittiğinde/durduğunda çağrılır — sonraki baskı temiz başlasın. */
export function etaHafizasiUnut(printerId: string): void {
  hafiza.delete(printerId);
}
