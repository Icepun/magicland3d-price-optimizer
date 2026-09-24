"use client";
/**
 * Görselleştirme boru hattı (istemci): geometri (worker parse + IDB önbellek), yalnız paket
 * (yazıcı kartı) ve gerekiyorsa sunucuya küçük resim. Aynı dosya için eşzamanlı istekler
 * tekilleştirilir.
 */
import type { ParsedGcode } from "./parse-gcode";
import { decodeVizPack, type VizPack } from "./viz-pack";
import { getPack, putPack } from "./viz-cache";
import { renderThumbnail } from "./three-scene";
// Yükleme sayacı three İÇERMEYEN ayrı modülde (tek kaynak) — bkz. viz-uploads.ts.
import { waitUploadsIdle } from "./viz-uploads";

const inflight = new Map<string, Promise<ParsedGcode>>();

/** İlerleme aşamaları — arayüzdeki BELİRLİ çubuğu besler (ölü bekleme yok). */
export type VizStage = "fetch" | "decode" | "scan";

export interface VizProgress {
  stage: VizStage;
  /** 0-1 arası, aşama içindeki ilerleme. */
  fraction: number;
}

type WorkerResult =
  | { ok: false; error?: string }
  | { ok: true; type: "progress"; stage: VizStage; fraction: number }
  | {
      ok: true;
      type: "done";
      positions: ArrayBufferLike;
      features: ArrayBufferLike;
      tools: ArrayBufferLike;
      layerRanges: ParsedGcode["layerRanges"];
      bounds: ParsedGcode["bounds"];
      totalSegments: number;
      scannedSegments: number;
      toolCount: number;
      filamentColors: string[];
      fileSize: number;
      thinLevel: number;
      yollar?: ParsedGcode["yollar"] | null;
      objects?: ArrayBufferLike | null;
      objectKeys?: string[] | null;
      pack: ArrayBuffer | null;
    };

/**
 * Geometriyi getir: IDB'deki kompakt paket → yoksa Web Worker (sunucu paketi ya da ham dosya).
 * `onProgress` verilirse yüzde bildirilir; aynı dosya için eşzamanlı çağrılar tekilleştirilir
 * (bu durumda ilerleme yalnız ilk çağrana gider).
 */
export function loadGeometry(
  cacheKey: string,
  fileId: string,
  onProgress?: (p: VizProgress) => void,
): Promise<ParsedGcode> {
  const existing = inflight.get(cacheKey);
  if (existing) return existing;
  const p = (async () => {
    const cachedPack = await getPack(cacheKey).catch(() => null);
    const { geom, pack } = await parseInWorker(fileId, cachedPack, onProgress);
    if (pack && geom.totalSegments > 0) void putPack(cacheKey, pack);
    return geom;
  })().finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, p);
  return p;
}

const paketBekleyen = new Map<string, Promise<VizPack>>();

/**
 * YALNIZ KOMPAKT PAKET (yazıcı kartı için): önce IndexedDB, yoksa ya da eski sürümse sunucu.
 * Açılmış geometri ÜRETİLMEZ — 2 milyon segmentlik dosyada ~50 MB bellek ederdi; kart paketten
 * kendi hafif sahnesini kurar (kart-sahne.ts). İzleyiciyle aynı anahtar: biri indirdiyse öteki de
 * önbellekten alır.
 */
export function loadVizPack(cacheKey: string, fileId: string): Promise<VizPack> {
  const suren = paketBekleyen.get(cacheKey);
  if (suren) return suren;
  const is = (async () => {
    const onbellek = await getPack(cacheKey).catch(() => null);
    if (onbellek) {
      try {
        return decodeVizPack(onbellek);
      } catch {
        /* eski biçim → sunucudan taze paket */
      }
    }
    const res = await fetch(`/api/models/${fileId}/viz-pack`, { cache: "no-store" });
    if (!res.ok) throw new Error("Model yüklenemedi");
    const tampon = await res.arrayBuffer();
    const paket = decodeVizPack(tampon);
    void putPack(cacheKey, tampon);
    return paket;
  })().finally(() => paketBekleyen.delete(cacheKey));
  paketBekleyen.set(cacheKey, is);
  return is;
}

function parseInWorker(
  fileId: string,
  cachedPack: ArrayBuffer | null,
  onProgress?: (p: VizProgress) => void,
): Promise<{ geom: ParsedGcode; pack: ArrayBuffer | null }> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./gcode.worker.ts", import.meta.url));
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    // Zaman aşımı ilerleme geldikçe TAZELENİR: iş ilerliyorsa kesilmez, gerçekten takılırsa kesilir.
    // İlk süre daha uzun: paket ilk kez üretilirken dosya buluttan indirilip taranır ve bu sırada
    // henüz hiç ilerleme mesajı gelmez.
    let to: ReturnType<typeof setTimeout>;
    const arm = (ms: number) => {
      clearTimeout(to);
      to = setTimeout(() => { worker.terminate(); reject(new Error("Görselleştirme yanıt vermedi")); }, ms);
    };
    arm(240_000);
    worker.onmessage = (ev: MessageEvent<WorkerResult>) => {
      const d = ev.data;
      if (!d?.ok) { clearTimeout(to); worker.terminate(); reject(new Error(d?.error || "Dosya işlenemedi")); return; }
      if (d.type === "progress") {
        arm(60_000);
        onProgress?.({ stage: d.stage, fraction: d.fraction });
        return;
      }
      clearTimeout(to);
      worker.terminate();
      resolve({
        geom: {
          positions: new Float32Array(d.positions),
          features: new Uint8Array(d.features),
          tools: new Uint8Array(d.tools),
          layerRanges: d.layerRanges,
          bounds: d.bounds,
          totalSegments: d.totalSegments,
          scannedSegments: d.scannedSegments,
          toolCount: d.toolCount,
          filamentColors: d.filamentColors ?? [],
          fileSize: d.fileSize,
          thinLevel: d.thinLevel,
          yollar: d.yollar ?? undefined,
          ...(d.objects && d.objectKeys?.length ? { objects: new Uint16Array(d.objects), objectKeys: d.objectKeys } : {}),
        },
        pack: d.pack ?? null,
      });
    };
    worker.onerror = (e) => { clearTimeout(to); worker.terminate(); reject(new Error(e.message || "Worker hatası")); };
    if (cachedPack) worker.postMessage({ fileId, pack: cachedPack }, [cachedPack]);
    else worker.postMessage({ fileId });
  });
}

const assetsOk = new Set<string>();      // başarıyla üretildi → bir daha üretme
const assetsRunning = new Set<string>(); // şu an üretiliyor → eşzamanlı ÇİFT üretimi engelle

// ── Arka plan üretimi KİBAR olmalı: yükleme/gezinme akıcı kalsın ─────────────
// Aksi halde (v0.19.99) yükleme biter bitmez 27MB parse + 36 WebGL render renderer'ı kilitliyordu.
// Yükleme sayacı (setUploadsActive/waitUploadsIdle) three İÇERMEYEN viz-uploads modülünde tutulur
// ki sayacı kullanan sayfalar three grafiğini initial bundle'a çekmesin.

/** Tarayıcı boşta kalınca çöz — ağır işi kullanıcı etkileşiminin arasına sıkıştırmaz. */
function idle(timeout = 800): Promise<void> {
  return new Promise((res) => {
    const ric = (globalThis as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(() => res(), { timeout });
    else setTimeout(res, 60);
  });
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
 * Arka plan varlık üretimi (SERİ + boşta + yükleme-bekleyen): dosyanın küçük resmi yoksa üret +
 * sunucuya kaydet (kütüphane, ürün sayfası). Görselleştirme ASLA çekirdek akışı (yükleme/baskı/
 * gezinme) etkilemez. Kart artık canlı 3B çiziyor (kart-sahne.ts): hazır inşa kareleri üretilmez.
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
  if (!thumbnailMissing) return true;
  await waitUploadsIdle();
  await idle();
  const g = await loadGeometry(cacheKey, fileId); // parse Web Worker'da (ana thread donmaz)
  if (!g.totalSegments) return false;
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
  return true;
}
