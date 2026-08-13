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
import { bustCache, bustCaches } from "@/lib/route-cache";
import { invalidateOrdersCache } from "@/lib/orders-cache";

/**
 * Ürün verisi toplu değişti (pazaryeri senkronu, içe aktarma, toplu düzenleme).
 * Fiyat/stok/ad/listing değiştiği için ürün görünümleri + sipariş eşleşmesi/kârı tazelenmeli.
 */
export function bustProductCaches(): void {
  // Tek tarama: dört ön ek ayrı ayrı verilseydi önbellek klasörü dört kez baştan gezilirdi.
  bustCaches([
    "products:",
    "dashboard:",
    "order-name-index:", // yeni/silinen ürün veya değişen ad
    "notifications-inventory:",
  ]);
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
  bustCaches(["products:", "dashboard:"]);
  invalidateOrdersCache();
}

/** Yalnız ürün GÖRÜNÜMLERİ değişti (kâr/eşleşme etkilenmiyor) — ör. görsel, sıralama. */
export function bustProductViewCaches(): void {
  // stok değiştiyse zildeki "stok kritik" uyarısı da tazelensin — hepsi tek taramada.
  bustCaches(["products:", "dashboard:", "notifications-inventory:"]);
}

/**
 * Stok / filament UYARI taraması değişti (bildirim zilinin beslediği tarama).
 *
 * Bu tarama 90 saniyelik kısa ömürlü bir önbellekten geliyor — zil 20 saniyede bir yokladığı
 * için her yoklamada üç tabloyu taramak gereksizdi. Ama kullanıcı stoğu ELLE değiştirdiğinde
 * uyarının 90 saniye eski kalması yanlış: düzelttiği bir uyarıyı hâlâ görür.
 */
export function bustInventoryAlertCaches(): void {
  bustCache("notifications-inventory:");
}

/** Finans geçmişi değişti (gerçek gider, manuel sipariş, komisyon senkronu). */
export function bustFinanceCaches(): void {
  bustCache("finance-monthly:");
}

/**
 * Trendyol'un GERÇEK (fatura edilmiş) komisyonları indi.
 *
 * Tahmini komisyon yerine gerçeği geçtiği için hem sipariş kârı hem aylık finans gövdesi
 * eskir. Ürün görünümleri BİLEREK dışarıda: komisyon oranı kuralı değişmedi, yalnız geçmiş
 * siparişlerin gerçek kesintisi doldu — `products:`/`dashboard:` gövdelerini de düşürmek
 * pahalı hesabı boşuna baştan koşturur.
 */
export function bustActualCommissionCaches(): void {
  invalidateOrdersCache();
  bustFinanceCaches();
}

/**
 * Sipariş senkronunun ARKA PLAN finans yazımı bitince önbelleği düşür.
 *
 * SORUN (ölçüldü): sipariş özetleri (`OrderFinanceSnapshot`) yanıt yolundan çıkarılıp arka
 * plana alındı, ama yazım bitince kimse finans önbelleğini düşürmüyordu. Yeni sipariş
 * listede görünüyor, "Ciro (bu ay)" ve "Net kâr (bu ay)" kartları ESKİ rakamda kalıyordu;
 * sayfadan çıkıp geri gelince düzeliyordu. Düşürme yalnız gider/manuel sipariş/yeniden hesap
 * yollarından çağrılıyordu — sipariş senkronundan HİÇ.
 *
 * ⚠️ KOŞULSUZ DÜŞÜRMEK YANLIŞ OLURDU: Siparişler ekranı 60 saniyede bir arka planda tazeleniyor
 * ve turların çoğunda HİÇBİR ŞEY değişmiyor (yazım tarafı satırları diff'liyor). Her turda
 * düşürmek aylık finans gövdesini sürekli baştan hesaplatır — uzak-HTTP tek mutex'inde bu,
 * önbelleğin varlık sebebini yok eder. Bu yüzden yalnız GERÇEKTEN satır yazıldıysa düşürülür.
 *
 * Beklemez, hata fırlatmaz: çağıran `void` ile ateşleyip yoluna devam eder.
 */
export async function bustFinanceCachesAfterOrderSnapshots(
  options: { pollMs?: number; timeoutMs?: number } = {}
): Promise<boolean> {
  const pollMs = options.pollMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 120_000;
  try {
    // Dinamik import: bu modül ~20 rotadan çekiliyor, finans yazım modülünü (prisma + kâr
    // çekirdeği) hepsinin paketine sokmanın anlamı yok.
    //
    // ⚠️ Çağıran, yazımı ZATEN başlatmış olmalı (aynı modülü statik import eden rota). O
    // durumda bu import modül önbelleğinden mikro-görevde döner; yazım turu ise setTimeout(0)
    // ile makro-görevde başlar → başlangıç sayacı hep yazımdan ÖNCE okunur.
    const mod = await import("@/lib/order-finance-snapshots");

    // ⚠️ NEDEN SADECE "bitince son duruma bak" DEĞİL: yazım kuyruğunda birden çok tur olabilir
    // ve her turun sonucu bir öncekini EZER. "A turu 10 satır yazdı, B turu 0 yazdı" durumunda
    // sona bakmak 0 görür ve düşürmeyi KAÇIRIRDI.
    //
    // ⚠️ ÖRNEKLEME DE YETMEZ: bekleme boyunca her 200 ms'de bir son duruma bakan bir tur, aynı
    // aralıkta biten iki turdan yalnız SONUNCUSUNU görür (paketlenmiş uygulamada sorgular
    // gömülü replikadan gelir, alt-milisaniye sürer). Aradaki turun yazdığı satırlar hiç fark
    // edilmez ve "Ciro (bu ay)" kartı yine 60 saniye eski kalırdı. Bu yüzden SÜREÇ ÖMRÜ BOYUNCA
    // ARTAN sayaçlar okunur: başlangıç ile bitiş farkı hiçbir turu kaçırmaz.
    const baslangic = mod.orderFinanceSnapshotWriteTotals();

    const sonAn = Date.now() + timeoutMs;
    while (mod.orderFinanceSnapshotWriteInFlight() && Date.now() < sonAn) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const bitis = mod.orderFinanceSnapshotWriteTotals();
    const yazildi =
      bitis.orders > baslangic.orders || bitis.items > baslangic.items;

    if (!yazildi) return false;
    bustFinanceCaches();
    return true;
  } catch {
    // Önbellek tazeliği bir kolaylık; başarısızlığı sipariş akışını ASLA bozmamalı.
    return false;
  }
}

/** Model dosyaları değişti (yükleme/silme). */
export function bustModelCaches(): void {
  bustCache("models:");
}
