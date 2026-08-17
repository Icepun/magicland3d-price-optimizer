/**
 * Dosya-adı eşleştirme anahtarı (yazıcı ↔ kayıtlı ürün eşleşmesi için NORMALİZE).
 *
 * Yazıcılar dosya adını farklı biçimlerde raporlar (klasör öneki, .gco↔.gcode↔.3mf uzantısı,
 * büyük/küçük harf). Print rotası eşleştirmeyi UZANTISIZ kaydeder. Tarafların tutması için
 * TÜM yazma/okuma noktaları (panel API + relay + print rotası) BU anahtarı kullanmalı —
 * relay eskiden ham adla eşliyordu → masaüstünden başlatılan baskı telefonda ürün adı/görseli
 * yerine dosya adı gösteriyordu.
 */
export function fileMatchKey(fn: string): string {
  const base = fn.includes("/") ? fn.slice(fn.lastIndexOf("/") + 1) : fn;
  const noBackslash = base.includes("\\") ? base.slice(base.lastIndexOf("\\") + 1) : base;
  return noBackslash.replace(/\.(gcode|gco|g|3mf)$/i, "").trim().toLocaleLowerCase("tr-TR");
}

/**
 * ÇİFT UZANTIYI da soyan anahtar — Bambu dosyaları `Parça.gcode.3mf` adlanıyor ve yazıcı bazen
 * `Parça.gcode`, bazen `Parça.gcode.3mf` bildiriyor. `fileMatchKey` tek uzantı soyduğu için bu
 * iki biçim birbirini tutmuyor.
 *
 * `fileMatchKey`'in DAVRANIŞI DEĞİŞTİRİLMEDİ bilerek: ürün eşleştirmeleri o anahtarla kayıtlı,
 * soyma derinleşirse mevcut eşleşmeler bozulurdu. Bu ek anahtar yalnız görsel seçiminde,
 * fileMatchKey tutmadığında ikinci deneme olarak kullanılır.
 */
export function deepFileMatchKey(fn: string): string {
  let s = fileMatchKey(fn);
  for (let i = 0; i < 4; i++) {
    const k = s.replace(/\.(gcode|gco|g|3mf)$/i, "");
    if (k === s) break;
    s = k;
  }
  return s;
}
