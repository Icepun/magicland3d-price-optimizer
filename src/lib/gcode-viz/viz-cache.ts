"use client";
/**
 * Görselleştirme önbelleği (IndexedDB, cihaz-yerel): kompakt "viz-pack" + inşa kareleri.
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
const DB_VER = 6;
const GEOM = "geom";
const SPRITES = "sprites";
const MAX_GEOM = 16; // LRU üst sınırları (disk şişmesin)
const MAX_SPRITES = 60;

interface PackRow {
  key: string;
  pack: ArrayBuffer;
  savedAt: number;
}
export interface SpriteSet { key: string; frames: Blob[]; layerCount: number; savedAt: number }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Eski biçimdeki satırlar okunamaz → iki store da sıfırdan kurulur.
      if (db.objectStoreNames.contains(GEOM)) db.deleteObjectStore(GEOM);
      db.createObjectStore(GEOM, { keyPath: "key" });
      if (db.objectStoreNames.contains(SPRITES)) db.deleteObjectStore(SPRITES);
      db.createObjectStore(SPRITES, { keyPath: "key" });
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

export async function getSprites(key: string): Promise<SpriteSet | null> {
  try {
    const row = await tx<SpriteSet | undefined>(SPRITES, "readonly", (s) => s.get(key) as IDBRequest<SpriteSet | undefined>);
    return row ?? null;
  } catch {
    return null;
  }
}

export async function putSprites(set: SpriteSet): Promise<void> {
  try {
    await tx(SPRITES, "readwrite", (s) => s.put({ ...set, savedAt: Date.now() }));
    void pruneLru(SPRITES, MAX_SPRITES);
  } catch { /* kota — kritik değil */ }
}

/** Baskı dosya adındaki içerik-hash ekinden önbellek anahtarı çıkar ("parça-a1b2c3d4e5.gcode"). */
export function vizKeyFromFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const m = /-([0-9a-f]{10})(?:\.[^.]+)*$/i.exec(filename.trim());
  return m ? `md5:${m[1].toLowerCase()}` : null;
}

/**
 * KARE SÜRÜMÜ — çizim kodu (ışıklandırma/geometri) her değiştiğinde ARTIR.
 *
 * Kareler diskte içerik hash'iyle saklanıyor; dosya değişmediği sürece anahtar da değişmiyor.
 * Bu yüzden çizimi iyileştirdiğimizde kullanıcı ESKİ kareleri görmeye devam ediyordu — iki kez
 * yaşandı, tsc/eslint/test hiçbiri yakalamıyor. Sürümü artırmak yalnız KARELERİ tazeler;
 * pahalı tarama paketi (`getPack`) aynı anahtarda kalır, 155 MB'lık dosya yeniden taranmaz.
 *
 * v2 (16 Ağu 2026): tüp ışıklandırmasında yüzey normali düzeltildi.
 */
export const KARE_SURUMU = 2;

/** Karelerin saklandığı anahtar — paket anahtarından AYRI sürümlenir. */
export function kareAnahtari(vizKey: string): string {
  return `${vizKey}#k${KARE_SURUMU}`;
}

/** Model kaydından önbellek anahtarı (md5 varsa onun ilk 10 hex'i — dosya adı ekiyle aynı). */
export function vizKeyForModel(mf: { id: string; contentMd5?: string | null; sizeBytes?: number | null }): string {
  if (mf.contentMd5 && /^[0-9a-f]{32}$/i.test(mf.contentMd5)) return `md5:${mf.contentMd5.slice(0, 10).toLowerCase()}`;
  return `file:${mf.id}:${mf.sizeBytes ?? 0}`;
}
