/**
 * SİPARİŞ KALEMİ → ÜRÜN EŞLEŞTİRMESİ — masaüstü Siparişler ucu ve telefon AYNI kural.
 *
 * NEDEN ÇEKİRDEKTE: iki ayrı kopya vardı ve ayrışmıştı. Masaüstü anahtarı türüne göre ayrı
 * kovalarda tutup GÜVEN sırasıyla deniyor, birden çok ürüne düşen (belirsiz) anahtarı hiç
 * kullanmıyor ve anahtarları tek biçime indiriyordu; telefon ise tüm anahtarları tek haritaya
 * "ilk gelen kazanır" diye koyuyordu. Bugünkü veride sonuç aynıydı (24 Eyl 2026 ölçümü), ama
 * belirsiz bir barkod telefonda YANLIŞ ürünün maliyetiyle kâr hesaplatabilirdi.
 *
 * ⚠️ PAYLAŞILIYOR: `npm run sync-core` ile telefona kopyalanır — yalnız saf TS.
 */

/**
 * Eşleştirme anahtarını (barkod/stok kodu/ürün adı) tek biçime indirger.
 *
 * NEDEN: karşılaştırma ham metin üzerindeydi; sondaki tek bir boşluk ya da harf düzeni farkı
 * eşleşmeyi sessizce bozuyor, sipariş "maliyeti bilinmeyen" sayılıyordu. Türkçe I harfi ise ters
 * yönden ısırıyordu: "ISIK" ile "Işık" iki farklı küçük harfe düşüyordu. Dört I biçimi (I/İ/ı/i)
 * burada tek harfe indirgenir; bu yüzden yalnız I farkıyla ayrışan iki ürün "belirsiz" sayılır ve
 * kör eşleşme yerine hiç eşleşmez.
 */
export function normalizeMatchKey(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[İıi]/g, "I")
    .toUpperCase();
}

/**
 * Anahtar → kayıt indeksi. Birden çok kayda düşen anahtarlar (belirsiz) indeksten ÇIKARILIR.
 *
 * Trendyol'da stok kodu boşsa `productMainId`'ye düşülüyor ve o değer TÜM varyantlarda aynı —
 * kör eşleştirme yanlış varyantın fiyatını/maliyetini yazardı.
 */
export function uniqueIndex<T>(
  items: Iterable<T>,
  key: (item: T) => string | null | undefined,
): Map<string, T> {
  const index = new Map<string, T>();
  const ambiguous = new Set<string>();
  for (const item of items) {
    const raw = key(item);
    const k = typeof raw === "string" ? raw.trim() : "";
    if (!k) continue;
    if (index.has(k)) ambiguous.add(k);
    else index.set(k, item);
  }
  for (const k of ambiguous) index.delete(k);
  return index;
}

/**
 * Adayları verilen SIRAYLA dener, ilk tutan kaydı döndürür.
 * `[anahtar, indeks]` çiftleri; anahtar boş/null ise o aday atlanır.
 */
export function matchByPriority<T>(
  candidates: readonly (readonly [string | null | undefined, Map<string, T>])[],
): T | null {
  for (const [raw, index] of candidates) {
    const k = typeof raw === "string" ? raw.trim() : "";
    if (!k) continue;
    const hit = index.get(k);
    if (hit) return hit;
  }
  return null;
}

/** Eşleştirmeye giren ürün alanları (Prisma satırı da telefonun ürün kaydı da uyar). */
export interface EslesenUrun {
  id: string;
  name: string;
  barcode?: string | null;
  sku?: string | null;
  listings: readonly {
    barcode?: string | null;
    externalId?: string | null;
    externalSku?: string | null;
  }[];
}

/** Sipariş kaleminin eşleştirme anahtarları — TÜRÜNE göre ayrı (güven sırası türe bağlı). */
export interface EslesenSatir {
  name: string;
  barcodes: readonly string[];
  /** Platform ürün/varyant kimliği (Listing.externalId ile eşleşir). */
  externalIds: readonly string[];
  skus: readonly string[];
}

interface Giris<T> {
  key: string;
  product: T;
}

export interface UrunIndeksi<T> {
  productBarcode: Map<string, Giris<T>>;
  listingBarcode: Map<string, Giris<T>>;
  listingExternalId: Map<string, Giris<T>>;
  listingSku: Map<string, Giris<T>>;
  productSku: Map<string, Giris<T>>;
  any: Map<string, Giris<T>>;
  name: Map<string, Giris<T>>;
}

/**
 * Ürünlerden eşleştirme indeksi. `deger`: indekse konacak değer (masaüstü kendi `Matched`
 * nesnesini, telefon ürün kaydını koyar).
 *
 * Her anahtar türü kendi kovasına düşer; aynı ürün aynı anahtarı iki kez verirse (ör. ürün
 * barkodu = ilan barkodu) tekrar sayılmaz, yoksa kendi kendine "belirsiz" görünürdü.
 */
export function urunIndeksiKur<P extends EslesenUrun, T>(
  urunler: Iterable<P>,
  deger: (p: P) => T,
): UrunIndeksi<T> {
  const kova = () => ({ entries: [] as Giris<T>[], seen: new Set<string>() });
  const kovalar = {
    productBarcode: kova(),
    listingBarcode: kova(),
    listingExternalId: kova(),
    listingSku: kova(),
    productSku: kova(),
    any: kova(),
    name: kova(),
  };
  const ekle = (
    hedef: ReturnType<typeof kova>,
    raw: string | null | undefined,
    urunId: string,
    product: T,
    herhangiye = true,
  ) => {
    const key = normalizeMatchKey(raw);
    if (!key) return;
    const tekil = `${key}\u0000${urunId}`;
    if (!hedef.seen.has(tekil)) {
      hedef.seen.add(tekil);
      hedef.entries.push({ key, product });
    }
    if (herhangiye && !kovalar.any.seen.has(tekil)) {
      kovalar.any.seen.add(tekil);
      kovalar.any.entries.push({ key, product });
    }
  };

  for (const p of urunler) {
    const m = deger(p);
    ekle(kovalar.productBarcode, p.barcode, p.id, m);
    ekle(kovalar.productSku, p.sku, p.id, m);
    for (const l of p.listings) {
      ekle(kovalar.listingBarcode, l.barcode, p.id, m); // platform-bazlı barkod
      ekle(kovalar.listingExternalId, l.externalId, p.id, m);
      ekle(kovalar.listingSku, l.externalSku, p.id, m);
    }
    // Shopify ad-eşleştirme: aynı ad birden çok üründeyse belirsiz → hiç eşleştirilmez.
    ekle(kovalar.name, p.name, p.id, m, false);
  }

  const indeks = (k: ReturnType<typeof kova>) => uniqueIndex(k.entries, (e) => e.key);
  return {
    productBarcode: indeks(kovalar.productBarcode),
    listingBarcode: indeks(kovalar.listingBarcode),
    listingExternalId: indeks(kovalar.listingExternalId),
    listingSku: indeks(kovalar.listingSku),
    productSku: indeks(kovalar.productSku),
    any: indeks(kovalar.any),
    name: indeks(kovalar.name),
  };
}

/**
 * Sipariş satırını ürünle eşleştir. Sıra = GÜVEN sırası: ürün barkodu > ilan barkodu >
 * platform kimliği > stok kodu. En son çare, anahtarın türü platformda karışmış olabileceği
 * için tür ayrımı olmayan indekstir. Belirsiz (birden çok ürüne düşen) anahtar hiç kullanılmaz.
 * Shopify barkod taşımadığı için orada son çare ürün adıdır.
 */
export function satiriEsle<T>(ix: UrunIndeksi<T>, satir: EslesenSatir, platform: string): T | null {
  const adaylar: (readonly [string, Map<string, Giris<T>>])[] = [];
  const ekle = (degerler: readonly string[], index: Map<string, Giris<T>>) => {
    for (const d of degerler) adaylar.push([normalizeMatchKey(d), index]);
  };
  ekle(satir.barcodes, ix.productBarcode);
  ekle(satir.barcodes, ix.listingBarcode);
  ekle(satir.externalIds, ix.listingExternalId);
  ekle(satir.skus, ix.listingSku);
  ekle(satir.skus, ix.productSku);
  ekle([...satir.barcodes, ...satir.externalIds, ...satir.skus], ix.any);
  if (platform === "shopify") adaylar.push([normalizeMatchKey(satir.name), ix.name]);
  return matchByPriority(adaylar)?.product ?? null;
}

/** Yalnız dolu metinleri anahtar listesine al (platform alanları boş/sayı gelebiliyor). */
export function anahtarListesi(...degerler: unknown[]): string[] {
  return degerler.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}
