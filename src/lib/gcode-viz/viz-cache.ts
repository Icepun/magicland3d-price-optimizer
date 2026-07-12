"use client";
/**
 * Görselleştirme önbelleği (IndexedDB, cihaz-yerel): parse edilmiş geometri + inşa kareleri.
 * Anahtar: contentMd5'in ilk 10 hex'i ("md5:xxxxxxxxxx") — baskı dosya adına gömülen ekle AYNI,
 * böylece yazıcı kartındaki canlı iş doğrudan önbelleğe eşlenir. Md5 yoksa "file:<id>:<boyut>".
 */
import type { ParsedGcode } from "./parse-gcode";

const DB_NAME = "mlhub-gcode-viz";
// v2: robust çerçeveleme (model ortalama + purge çizgisi dışlama) → eski KARELER eski framing'le
// üretildi; upgrade'de sprites store'u temizlenir → yeni framing'le yeniden oluşur. Geometri korunur.
const DB_VER = 2;
const GEOM = "geom";
const SPRITES = "sprites";
const MAX_GEOM = 24; // LRU üst sınırları (disk şişmesin)
const MAX_SPRITES = 60;

interface GeomRow {
  key: string;
  positions: ArrayBuffer;
  features: ArrayBuffer;
  layerRanges: ParsedGcode["layerRanges"];
  bounds: ParsedGcode["bounds"];
  totalSegments: number;
  savedAt: number;
}
export interface SpriteSet { key: string; frames: Blob[]; layerCount: number; savedAt: number }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(GEOM)) db.createObjectStore(GEOM, { keyPath: "key" });
      // Sprites: render kodu (çerçeveleme) değiştiğinde eski kareler bayat → sıfırla + yeniden kur.
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

export async function getGeom(key: string): Promise<ParsedGcode | null> {
  try {
    const row = await tx<GeomRow | undefined>(GEOM, "readonly", (s) => s.get(key) as IDBRequest<GeomRow | undefined>);
    if (!row) return null;
    return {
      positions: new Float32Array(row.positions),
      features: new Uint8Array(row.features),
      layerRanges: row.layerRanges,
      bounds: row.bounds,
      totalSegments: row.totalSegments,
    };
  } catch {
    return null;
  }
}

export async function putGeom(key: string, g: ParsedGcode): Promise<void> {
  try {
    const row: GeomRow = {
      key,
      positions: g.positions.buffer as ArrayBuffer,
      features: g.features.buffer as ArrayBuffer,
      layerRanges: g.layerRanges,
      bounds: g.bounds,
      totalSegments: g.totalSegments,
      savedAt: Date.now(),
    };
    await tx(GEOM, "readwrite", (s) => s.put(row));
    void pruneLru(GEOM, MAX_GEOM);
  } catch { /* kota/da hata — önbelleksiz devam */ }
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

/** Model kaydından önbellek anahtarı (md5 varsa onun ilk 10 hex'i — dosya adı ekiyle aynı). */
export function vizKeyForModel(mf: { id: string; contentMd5?: string | null; sizeBytes?: number | null }): string {
  if (mf.contentMd5 && /^[0-9a-f]{32}$/i.test(mf.contentMd5)) return `md5:${mf.contentMd5.slice(0, 10).toLowerCase()}`;
  return `file:${mf.id}:${mf.sizeBytes ?? 0}`;
}
