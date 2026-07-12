"use client";
/**
 * Görselleştirme boru hattı (istemci): geometri (worker parse + IDB önbellek) → gerekiyorsa
 * sunucuya thumbnail + IDB'ye inşa kareleri. Aynı dosya için eşzamanlı istekler tekilleştirilir.
 */
import type { ParsedGcode } from "./parse-gcode";
import { getGeom, putGeom, getSprites, putSprites } from "./viz-cache";
import { renderThumbnail, renderBuildFrames } from "./three-scene";

const inflight = new Map<string, Promise<ParsedGcode>>();

/** Geometriyi getir: IDB önbelleği → yoksa Web Worker'da parse (arayüz donmaz) → önbelleğe. */
export function loadGeometry(cacheKey: string, fileId: string): Promise<ParsedGcode> {
  const existing = inflight.get(cacheKey);
  if (existing) return existing;
  const p = (async () => {
    const cached = await getGeom(cacheKey);
    if (cached && cached.totalSegments > 0) return cached;
    const g = await parseInWorker(fileId);
    if (g.totalSegments > 0) void putGeom(cacheKey, g);
    return g;
  })().finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, p);
  return p;
}

function parseInWorker(fileId: string): Promise<ParsedGcode> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./gcode.worker.ts", import.meta.url));
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const to = setTimeout(() => { worker.terminate(); reject(new Error("Görselleştirme zaman aşımı")); }, 180_000);
    worker.onmessage = (ev: MessageEvent<any>) => {
      clearTimeout(to);
      worker.terminate();
      const d = ev.data;
      if (!d?.ok) { reject(new Error(d?.error || "Dosya işlenemedi")); return; }
      resolve({
        positions: new Float32Array(d.positions),
        features: new Uint8Array(d.features),
        layerRanges: d.layerRanges,
        bounds: d.bounds,
        totalSegments: d.totalSegments,
      });
    };
    worker.onerror = (e) => { clearTimeout(to); worker.terminate(); reject(new Error(e.message || "Worker hatası")); };
    worker.postMessage({ fileId });
  });
}

const assetsDone = new Set<string>(); // oturum içinde aynı iş bir kez

/**
 * Arka plan varlık üretimi: (a) sunucuda thumbnail yoksa üret + kaydet → tüm listeler görsel
 * kazanır; (b) inşa karelerini üret + IDB'ye koy → yazıcı kartında canlı dolan model.
 * Tamamen arka planda; hata sessiz (görselleştirme çekirdek akışı asla bozamaz).
 */
/** Baskı başlatıldıktan sonra çağrılır: taze model kaydını çekip (contentMd5 artık dolu)
 *  varlıkları MD5 anahtarıyla üretir — kartın canlı dolumu bu anahtarla eşleşir. */
export function ensureVizAssetsAfterPrint(fileId: string): void {
  void (async () => {
    try {
      const res = await fetch(`/api/models/${fileId}`, { cache: "no-store" });
      if (!res.ok) return;
      const row = (await res.json()) as { id: string; contentMd5?: string | null; sizeBytes?: number; thumbnail?: string | null };
      if (!row?.id) return;
      const { vizKeyForModel } = await import("./viz-cache");
      ensureVizAssets({ fileId: row.id, cacheKey: vizKeyForModel(row), thumbnailMissing: !row.thumbnail });
    } catch { /* opsiyonel */ }
  })();
}

export function ensureVizAssets(opts: { fileId: string; cacheKey: string; thumbnailMissing: boolean }): void {
  const { fileId, cacheKey, thumbnailMissing } = opts;
  const jobKey = `${cacheKey}|${thumbnailMissing ? 1 : 0}`;
  if (assetsDone.has(jobKey)) return;
  assetsDone.add(jobKey);
  void (async () => {
    try {
      const haveSprites = await getSprites(cacheKey);
      if (haveSprites && !thumbnailMissing) return;
      const g = await loadGeometry(cacheKey, fileId);
      if (!g.totalSegments) return;
      if (thumbnailMissing) {
        const dataUrl = renderThumbnail(g, 512);
        if (dataUrl && dataUrl.length < 900_000) {
          await fetch(`/api/models/${fileId}/preview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ thumbnail: dataUrl }),
          }).catch(() => {});
        }
      }
      if (!haveSprites) {
        const frames = await renderBuildFrames(g, 36, 240);
        if (frames.length) await putSprites({ key: cacheKey, frames, layerCount: g.layerRanges.length, savedAt: Date.now() });
      }
    } catch {
      /* arka plan üretimi — sessiz */
    }
  })();
}
