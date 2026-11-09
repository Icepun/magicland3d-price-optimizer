/**
 * Görselleştirme önbellek ANAHTARLARI — saf fonksiyonlar (tarayıcı/sunucu ortak).
 *
 * `viz-cache.ts` tarayıcıya özel (IndexedDB, "use client") olduğu için sunucu uçları onu içe
 * aktaramıyordu; anahtar formülü burada TEK yerde durur, `viz-cache.ts` buradan yeniden dışa açar.
 * Anahtar: contentMd5'in ilk 10 hex'i ("md5:xxxxxxxxxx") — baskı dosya adına gömülen ekle AYNI,
 * böylece yazıcı kartındaki canlı iş doğrudan önbelleğe eşlenir. Md5 yoksa "file:<id>:<boyut>".
 */

/** Baskı dosya adındaki içerik-hash ekinden önbellek anahtarı çıkar ("parça-a1b2c3d4e5.gcode"). */
export function vizKeyFromFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const m = /-([0-9a-f]{10})(?:\.[^.]+)*$/i.exec(filename.trim());
  return m ? `md5:${m[1].toLowerCase()}` : null;
}

/** Model kaydından önbellek anahtarı (md5 varsa onun ilk 10 hex'i — dosya adı ekiyle aynı). */
export function vizKeyForModel(mf: { id: string; contentMd5?: string | null; sizeBytes?: number | null }): string {
  if (mf.contentMd5 && /^[0-9a-f]{32}$/i.test(mf.contentMd5)) return `md5:${mf.contentMd5.slice(0, 10).toLowerCase()}`;
  return `file:${mf.id}:${mf.sizeBytes ?? 0}`;
}
