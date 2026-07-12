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

const assetsOk = new Set<string>();      // başarıyla üretildi → bir daha üretme
const assetsRunning = new Set<string>(); // şu an üretiliyor → eşzamanlı ÇİFT üretimi engelle

// ── Arka plan üretimi KİBAR olmalı: yükleme/gezinme akıcı kalsın ─────────────
// Aksi halde (v0.19.99) yükleme biter bitmez 27MB parse + 36 WebGL render renderer'ı kilitliyordu.
let uploadsActive = 0;
/** Yükleme başlarken +1, biterken -1 — arka plan varlık üretimi bu sırada BEKLER (ana süreçten
 *  27MB okuma + WebGL render yüklemeyle/dosya diyaloğuyla yarışmasın). */
export function setUploadsActive(delta: number): void {
  uploadsActive = Math.max(0, uploadsActive + delta);
}

/** Tarayıcı boşta kalınca çöz — ağır işi kullanıcı etkileşiminin arasına sıkıştırmaz. */
function idle(timeout = 800): Promise<void> {
  return new Promise((res) => {
    const ric = (globalThis as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(() => res(), { timeout });
    else setTimeout(res, 60);
  });
}

async function waitUploadsIdle(): Promise<void> {
  while (uploadsActive > 0) await new Promise((r) => setTimeout(r, 400));
}

// Tek sıra: aynı anda EN FAZLA bir üretim işi (birden çok dosya art arda gelirse kuyruklanır,
// paralel WebGL/parse yığılmaz). Zincir hataları yutar.
let chain: Promise<void> = Promise.resolve();

/** Baskı başlatıldıktan sonra çağrılır: taze model kaydını çekip (contentMd5 artık dolu)
 *  varlıkları MD5 anahtarıyla üretir — kartın canlı dolumu bu anahtarla eşleşir. Arka planda,
 *  kibar (yükleme bitince + boşta). */
export function ensureVizAssetsAfterPrint(fileId: string): void {
  void (async () => {
    try {
      await waitUploadsIdle();
      const res = await fetch(`/api/models/${fileId}`, { cache: "no-store" });
      if (!res.ok) return;
      const row = (await res.json()) as { id: string; contentMd5?: string | null; sizeBytes?: number; thumbnail?: string | null };
      if (!row?.id) return;
      const { vizKeyForModel } = await import("./viz-cache");
      ensureVizAssets({ fileId: row.id, cacheKey: vizKeyForModel(row), thumbnailMissing: !row.thumbnail });
    } catch { /* opsiyonel */ }
  })();
}

/**
 * Arka plan varlık üretimi (SERİ + boşta + yükleme-bekleyen): (a) thumbnail yoksa üret + kaydet;
 * (b) inşa karelerini üret + IDB'ye koy (kartta canlı dolan model). Görselleştirme ASLA çekirdek
 * akışı (yükleme/baskı/gezinme) etkilemez. Not: yükleme veya izleyici-açılışında ÇAĞRILMAZ —
 * yalnız baskı başlangıcında (ensureVizAssetsAfterPrint). İzleyici geometriyi kendi yükler.
 */
export function ensureVizAssets(opts: { fileId: string; cacheKey: string; thumbnailMissing: boolean }): void {
  const { fileId, cacheKey, thumbnailMissing } = opts;
  const jobKey = `${cacheKey}|${thumbnailMissing ? 1 : 0}`;
  if (assetsOk.has(jobKey) || assetsRunning.has(jobKey)) return; // bitti ya da sürüyor → tekrar başlatma
  assetsRunning.add(jobKey);
  chain = chain
    .then(() => runAssetJob(fileId, cacheKey, thumbnailMissing))
    .then((ok) => { assetsRunning.delete(jobKey); if (ok) assetsOk.add(jobKey); })
    .catch(() => { assetsRunning.delete(jobKey); /* hata → tekrar denenebilir */ });
}

async function runAssetJob(fileId: string, cacheKey: string, thumbnailMissing: boolean): Promise<boolean> {
  const haveSprites = await getSprites(cacheKey);
  if (haveSprites && !thumbnailMissing) return true;
  await waitUploadsIdle();
  await idle();
  const g = await loadGeometry(cacheKey, fileId); // parse Web Worker'da (ana thread donmaz)
  if (!g.totalSegments) return false;
  if (thumbnailMissing) {
    await waitUploadsIdle();
    await idle();
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
    await waitUploadsIdle();
    await idle();
    const frames = await renderBuildFrames(g, 24, 240, idle); // her kareden sonra boşta bekle
    if (!frames.length) return false;
    await putSprites({ key: cacheKey, frames, layerCount: g.layerRanges.length, savedAt: Date.now() });
  }
  return true;
}
