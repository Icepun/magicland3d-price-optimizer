"use client";
/**
 * Görselleştirme önbelleği (IndexedDB, cihaz-yerel): kompakt "viz-pack".
 * Anahtar: contentMd5'in ilk 10 hex'i ("md5:xxxxxxxxxx") — baskı dosya adına gömülen ekle AYNI,
 * böylece yazıcı kartındaki canlı iş doğrudan önbelleğe eşlenir. Md5 yoksa "file:<id>:<boyut>".
 *
 * v3'te AÇILMIŞ geometri yerine PAKET saklanır: 178 MB'lık gerçek dosyada açılmış geometri
 * 41 MB yer kaplıyordu, paket ~15 MB. Açma (paket → segment) worker'da milisaniyeler sürer.
 */

const DB_NAME = "mlhub-gcode-viz";
// v3: geometri store'u paket store'una dönüştü (eski satırlar okunamaz) + kareler yeni renk/gövde
// kuralıyla üretiliyor → iki store da sıfırlanır ve yeniden dolar.
// v4: renk kuralı değişti — mutlak parlaklık tabanı yerine zemine karşı KONTRAST kapısı geldi
// (kırmızı artık pembeye kaymıyor). Kayıtlı kareler ve küçük resimler PİŞMİŞ PİKSEL olduğu için
// eski renkleri taşırlar; sürüm artmazsa kullanıcı düzelmeyi kartlarda GÖREMEZ.
// v5: gövde artık IŞIKLANDIRILMIŞ tüp olarak çiziliyor (tube-shading) ve kart küçük resimleri
// de kalın gövdeyi kullanıyor. Kayıtlı kareler/küçük resimler pişmiş piksel — sürüm artmazsa
// kullanıcı yeni görünümü kartlarda GÖREMEZ.
// v6: izleyicide DOLGU da katı gövde olarak çiziliyor (model artık içi boş kabuk değil).
// v7 (23 Eyl 2026): paket biçimi v3 (canlı konum için yol başına bayt + süre). Kart artık canlı
// 3B çiziyor; hazır inşa kareleri (sprites) kaldırıldı, o depo silinir.
// v8 (24 Eyl 2026): paketler parça bilgisi taşıyor — eski (parçasız) paketler silinip yeniden alınır.
const DB_VER = 8;
const GEOM = "geom";
const ESKI_KARELER = "sprites";
const MAX_GEOM = 16; // LRU üst sınırı (disk şişmesin)

interface PackRow {
  key: string;
  pack: ArrayBuffer;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Eski biçimdeki satırlar okunamaz → paket deposu sıfırdan kurulur, kare deposu kalkar.
      if (db.objectStoreNames.contains(GEOM)) db.deleteObjectStore(GEOM);
      db.createObjectStore(GEOM, { keyPath: "key" });
      if (db.objectStoreNames.contains(ESKI_KARELER)) db.deleteObjectStore(ESKI_KARELER);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      })
  );
}

async function pruneLru(store: string, max: number): Promise<void> {
  try {
    const all = await tx<{ key: string; savedAt: number }[]>(store, "readonly", (s) => s.getAll() as IDBRequest<{ key: string; savedAt: number }[]>);
    if (all.length <= max) return;
    const victims = all.sort((a, b) => a.savedAt - b.savedAt).slice(0, all.length - max);
    const db = await openDb();
    const t = db.transaction(store, "readwrite");
    for (const v of victims) t.objectStore(store).delete(v.key);
  } catch { /* önbellek budaması kritik değil */ }
}

/** Önbellekteki kompakt paketi getir (yoksa null). */
export async function getPack(key: string): Promise<ArrayBuffer | null> {
  try {
    const row = await tx<PackRow | undefined>(GEOM, "readonly", (s) => s.get(key) as IDBRequest<PackRow | undefined>);
    return row?.pack ?? null;
  } catch {
    return null;
  }
}

/** Paketi önbelleğe yaz. Kota dolarsa sessizce vazgeçilir (görselleştirme yine çalışır). */
export async function putPack(key: string, pack: ArrayBuffer): Promise<void> {
  try {
    await tx(GEOM, "readwrite", (s) => s.put({ key, pack, savedAt: Date.now() } satisfies PackRow));
    void pruneLru(GEOM, MAX_GEOM);
  } catch { /* kota/db hatası — önbelleksiz devam */ }
}

// Anahtar formülleri saf modülde (sunucu uçları da kullanıyor) — buradan yeniden dışa açılır.
export { vizKeyFromFilename, vizKeyForModel } from "./viz-anahtar";
