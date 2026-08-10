/**
 * Yazma sonrası önbellek düşürme — TEK kaynak.
 *
 * Sunucu tarafında iki ayrı önbellek katmanı var:
 *   1) route-cache (swr)  → products / dashboard / models / settings / finance-monthly
 *   2) orders-cache       → /api/orders gövdesi (3 pazaryeri canlı çekim + kâr, PAHALI)
 *
 * SORUN (denetimde bulundu): senkron rotaları ikisini de düşürmüyordu → "Yenile" bitiyor,
 * pazaryerinden yeni fiyatlar DB'ye yazılıyor, ama Ürünler listesi 2 dakika boyunca ESKİ
 * fiyatı göstermeye devam ediyordu. Kullanıcıya "Yenile çalışmıyor" gibi görünüyordu.
 *
 * ⚠️ Yeni bir swr() anahtarı eklersen BURAYA da ekle; yoksa o ekran sessizce bayat kalır.
 * Karşı tuzak da gerçek: aşırı-geniş bust pahalı önbelleği işlevsiz bırakır (bkz. pricing-inputs.ts
 * — kâr-etkileyen değişiklik ayrımı). Bu yüzden her yardımcı DAR ve amaca özel.
 */
import { bustCache } from "@/lib/route-cache";
import { invalidateOrdersCache } from "@/lib/orders-cache";

/**
 * Ürün verisi toplu değişti (pazaryeri senkronu, içe aktarma, toplu düzenleme).
 * Fiyat/stok/ad/listing değiştiği için ürün görünümleri + sipariş eşleşmesi/kârı tazelenmeli.
 */
export function bustProductCaches(): void {
  bustCache("products:");
  bustCache("dashboard:");
  bustCache("order-name-index:"); // yeni/silinen ürün veya değişen ad
  invalidateOrdersCache(); // fiyat + eşleşme değişimi kâr gövdesini etkiler
}

/**
 * KÂR GİRDİSİ değişti: komisyon / kargo / gider kuralı, KDV oranı, filament ₺/g, listing fiyatı
 * veya komisyon override'ı.
 *
 * SORUN (denetimde bulundu): bu rotalar yalnız invalidateOrdersCache() çağırıyordu. Oysa ürün
 * maliyeti ve kârı bu girdilerden HESAPLANIYOR → products:/dashboard: gövdeleri de eski kuralla
 * hesaplanmış kârı taşıyor. Üstelik bu gövdeler DİSKE yazıldığı için uygulamayı kapatıp açmak
 * bile düzeltmiyordu: kullanıcı komisyonu değiştiriyor, Ürün Detayı yeni rakamı gösteriyor ama
 * liste ve Panel eskisinde kalıyordu.
 *
 * order-name-index BİLEREK düşürülmüyor: ürün adları değişmedi, o indeks pahalı ve gereksiz yere
 * yeniden kurulmamalı (bkz. dosya başlığındaki "dar ve amaca özel" kuralı).
 */
export function bustProfitInputCaches(): void {
  bustCache("products:");
  bustCache("dashboard:");
  invalidateOrdersCache();
}

/** Yalnız ürün GÖRÜNÜMLERİ değişti (kâr/eşleşme etkilenmiyor) — ör. görsel, sıralama. */
export function bustProductViewCaches(): void {
  bustCache("products:");
  bustCache("dashboard:");
}

/** Finans geçmişi değişti (gerçek gider, manuel sipariş, komisyon senkronu). */
export function bustFinanceCaches(): void {
  bustCache("finance-monthly:");
}

/** Model dosyaları değişti (yükleme/silme). */
export function bustModelCaches(): void {
  bustCache("models:");
}
