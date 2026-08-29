/**
 * TIMELAPSE DOSYA ADINI OKUNUR BİLGİYE ÇEVİR.
 *
 * Galeride ham dosya adı gösteriliyordu ve hiçbir şey anlatmıyordu:
 *
 *   Thousand Sunny P9 1s41dk-1f89ccc266_20260828175043.mp4
 *   └── baskı adı ──┘ └süre┘ └─hash─┘ └── zaman damgası ──┘
 *
 * Oysa adın içinde üç işe yarar bilgi var. Bunları ayırıp karta koyuyoruz; kullanıcı
 * hangi baskının videosu olduğunu dosya adını çözmeye çalışmadan görsün.
 *
 * ⚠️ Biçim GARANTİ DEĞİL. Bambu'nun .avi adları farklı, dilimleyici/firmware sürümü de
 * değiştirebilir. Bu yüzden ayrıştırma "eşleşirse süsle, eşleşmezse ham adı göster"
 * mantığında: tanımadığımız bir ad yüzünden kart boş kalmaz.
 */

export interface TimelapseAdi {
  /** Okunur baskı adı — çözülemezse ham dosya adı (uzantısız). */
  ad: string;
  /** "1 sa 41 dk" gibi; adda süre yoksa null. */
  sure: string | null;
}

/** `1s41dk`, `41dk`, `3s` → "1 sa 41 dk". Tanınmazsa null. */
function sureCevir(ham: string): string | null {
  const m = /^(?:(\d+)s)?(?:(\d+)dk)?$/i.exec(ham);
  if (!m || (!m[1] && !m[2])) return null;
  const saat = m[1] ? Number(m[1]) : 0;
  const dk = m[2] ? Number(m[2]) : 0;
  if (saat && dk) return `${saat} sa ${dk} dk`;
  if (saat) return `${saat} sa`;
  return `${dk} dk`;
}

export function timelapseAdiCozumle(dosyaAdi: string): TimelapseAdi {
  // Uzantıyı at.
  let s = dosyaAdi.replace(/\.[a-z0-9]{2,4}$/i, "");
  // Sondaki zaman damgası (_YYYYMMDDHHMMSS) — tarih zaten ayrıca gösteriliyor.
  s = s.replace(/_\d{14}$/, "");
  // Sondaki içerik hash'i (-<8+ onaltılık>).
  s = s.replace(/-[0-9a-f]{6,}$/i, "");

  // Kalanın sonunda süre olabilir: "… P9 1s41dk"
  const parcalar = s.trim().split(/\s+/);
  let sure: string | null = null;
  if (parcalar.length > 1) {
    const olasi = sureCevir(parcalar[parcalar.length - 1]);
    if (olasi) {
      sure = olasi;
      parcalar.pop();
    }
  }
  const ad = parcalar.join(" ").trim();
  // Ad tamamen eriyip gittiyse ham adı göster — boş başlıklı bir kart işe yaramaz.
  return { ad: ad || dosyaAdi.replace(/\.[a-z0-9]{2,4}$/i, ""), sure };
}

/**
 * Bir video için hangi kapak dosyası kullanılmalı?
 *
 * ⚠️ SNAPMAKER U1 HER VİDEO İÇİN İKİ JPG YAZIYOR (ölçüldü 29 Ağu 2026, gerçek cihaz):
 *   <ad>.jpg        → 120x90,  3 KB  — küçük önizleme, 4:3
 *   <ad>_cover.jpg  → 880x495, 35 KB — tam kapak, TAM 16:9
 *
 * Küçük olan kullanılınca galeri kartı hem bulanıklaşıyor hem de 16:9 kutuda üstten alttan
 * kırpılıyordu ("snapmakerda böyle garip"). Büyük kapak galerinin oranıyla birebir uyuyor.
 *
 * `mevcut` = klasördeki görsellerin uzantısız adları.
 */
export function timelapseKapakSec(stem: string, mevcut: ReadonlySet<string>): string | null {
  if (mevcut.has(`${stem}_cover`)) return `${stem}_cover.jpg`;
  if (mevcut.has(stem)) return `${stem}.jpg`;
  return null;
}
