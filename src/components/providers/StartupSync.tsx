"use client";

/**
 * Açılış görevleri.
 *
 * ŞU AN BOŞ — ve bu bilinçli. Geçmişte burada iki iş vardı, ikisi de kaldırıldı:
 *
 * 1) TEX KARGO SEED — KALDIRILDI (16 Ağu 2026). Her açılışta, `localStorage` işareti yoksa
 *    `POST /api/seed/tex-cargo-rules` çağrılıyordu. O rota TÜM TEX kargo kurallarını (eski
 *    dönemler dahil) SİLİP yerine tarihsiz Temmuz fiyatlarını yazıyordu. Tek koruma sunucudaki
 *    `texCargoSeed.v1` bayrağıydı; temiz veritabanı, seçmeli geri yükleme veya `?force=true`
 *    bunu aşınca Ağustos tarifesi tamamen kaybolur ve Temmuz fiyatı tüm geçmiş+geleceğe
 *    uygulanırdı. Kargo kurallarını kuran tek yer artık `runtime-schema-tex.ts` (tarih
 *    pencereli, geçmişi koruyan göç).
 *
 * 2) Otomatik fiyat tazeleme — kaldırılmıştı (cache-first felsefe): fiyatlar açılışta
 *    otomatik ÇEKİLMEZ, kullanıcı Ürünler sayfasındaki "Fiyatları Güncelle" ile çeker.
 *
 * Bileşen yerinde bırakıldı: açılışta bir iş gerekirse yeri burası ve ağaçta zaten bağlı.
 */
export function StartupSync() {
  return null;
}
