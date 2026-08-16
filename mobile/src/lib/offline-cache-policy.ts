/**
 * ÇEVRİMDIŞI ÖNBELLEK KURALLARI — saf karar mantığı (dosya/ağ dokunuşu YOK).
 *
 * Ayrı dosya çünkü `offline-cache.ts` `expo-file-system`'i içe aktarıyor ve kökteki testlerde
 * çözülemiyor; kurallar burada durunca gerçek kod test edilebiliyor
 * (bkz. src/lib/mobile-offline-cache.test.ts).
 */

/**
 * Dosya biçimi değişirse eski dosya okunmaz — çöp veriyle açılmaktansa boş açılmak iyidir.
 *
 * v3: cihazlarda ZEHİRLİ dosya var. v2 `["rules"]` sorgusunu da yazıyordu; içindeki iki `Map`
 * JSON'da `{}` oluyor, geri yüklenince `rules.financialByExternalId.get(...)` "get is not a
 * function" ile PATLIYOR ve uygulama açılışta kapanıyordu. Sürüm artışı o dosyaları siler.
 */
export const ONBELLEK_BICIMI = 3;

/** Bu yaştan eski önbellek atılır: "geçen haftaki siparişler" diye açılmasın. */
export const ONBELLEK_MAKSIMUM_YAS_MS = 3 * 24 * 60 * 60_000;

/**
 * Diske yazılan sorgular. LİSTE BİLİNÇLİ OLARAK DAR ve her satırı JSON'A GÜVENLİ olmalı.
 *
 * İki ayrı gerekçeyle eleme yapılıyor:
 *  1. ANLIK durumlar (yazıcı anlık görüntüsü) YOK — kapanışta %62'de olan baskıyı ertesi gün
 *     "%62 sürüyor" diye göstermek yanlış bilgi olurdu; o veri her açılışta canlı çekilir.
 *  2. `Map`/`Set` İÇEREN SORGULAR YOK. ⚠️ `["rules"]` bir tur bu listedeydi ve UYGULAMAYI
 *     AÇILIŞTA ÇÖKERTTİ: `getRules()` içinde `financialByExternalId`/`financialByOrderNumber`
 *     birer `Map`; `JSON.stringify(new Map())` → `{}`. Geri yüklenen düz nesnede `.get()`
 *     olmadığı için ilk render'da "get is not a function" fırlıyordu. Kurallar zaten tek
 *     batch sorgu — her açılışta yeniden çekmenin maliyeti düşük.
 */
export const KALICI_SORGULAR: readonly string[] = [
  "orders",
  "match-products",
  "products",
  "settings",
  "dashboard-data",
  "spools",
  "notifications",
  "prep-done",
  "monthly-finance",
];

/** Sorgu anahtarının kökü diske yazılmalı mı? */
export function kaliciSorguMu(queryKey: readonly unknown[]): boolean {
  const kok = queryKey[0];
  return typeof kok === "string" && KALICI_SORGULAR.includes(kok);
}

/**
 * JSON'a güvenli mi? Liste yanlışlıkla genişletilirse ikinci savunma hattı.
 *
 * `Map`/`Set` sessizce `{}` olarak yazılır; hata ancak GERİ YÜKLEDİKTEN sonra, kullanıcının
 * telefonunda, açılış çökmesi olarak görünür. Bu yüzden yazmadan ÖNCE bakılır — zehirli veri
 * hiç diske inmez. Tarama sığ değil ama derinlik sınırlı: veri gövdeleri düz JSON, iç içe
 * onlarca kat değiller.
 */
export function jsonGuvenliMi(deger: unknown, derinlik = 0): boolean {
  if (derinlik > 6) return true; // makul derinlikten sonra güven — sonsuz döngüye girme
  if (deger == null) return true;
  if (deger instanceof Map || deger instanceof Set || deger instanceof Date) return false;
  if (Array.isArray(deger)) return deger.every((x) => jsonGuvenliMi(x, derinlik + 1));
  if (typeof deger === "object") {
    if (Object.getPrototypeOf(deger) !== Object.prototype) return false; // sınıf örneği
    return Object.values(deger as Record<string, unknown>).every((x) =>
      jsonGuvenliMi(x, derinlik + 1)
    );
  }
  return typeof deger !== "function" && typeof deger !== "symbol";
}

/** Diskten okunan dosya kullanılabilir mi? (biçim doğru + fazla eski değil) */
export function onbellekGecerliMi(
  dosya: { bicim?: unknown; yazilma?: unknown } | null | undefined,
  simdi: number
): boolean {
  if (!dosya || dosya.bicim !== ONBELLEK_BICIMI) return false;
  const yazilma = typeof dosya.yazilma === "number" ? dosya.yazilma : 0;
  if (yazilma <= 0) return false;
  // Gelecek tarihli damga (cihaz saati geri alınmış) → güvenme.
  if (yazilma > simdi + 60_000) return false;
  return simdi - yazilma <= ONBELLEK_MAKSIMUM_YAS_MS;
}
