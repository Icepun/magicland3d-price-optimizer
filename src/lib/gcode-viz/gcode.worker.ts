/// <reference lib="webworker" />
/**
 * Görselleştirme Web Worker'ı. AĞIR İŞ TAMAMEN BURADA: arayüz hiç donmaz.
 *
 * Ana yol: sunucudan kompakt "viz-pack" indir (birkaç MB) → çöz → segment geometrisi.
 * Yedek yol: paket ucu çalışmazsa ham dosyayı AKIŞLA oku ve burada tara. İki durumda da
 * ilerleme (yüzde) ana thread'e bildirilir — açılışta belirsiz bekleme kalmasın.
 */
import { unzipSync } from "fflate";
import { GcodeScanner } from "./parse-gcode";
import { decodeVizPack, encodeVizPack, expandPack, type ParsedGcode, type VizPack } from "./viz-pack";

type Stage = "fetch" | "decode" | "scan";

/** `pack` verilirse (IndexedDB önbelleği) ağa hiç çıkılmaz, yalnız açılır. */
interface Req { fileId: string; pack?: ArrayBuffer }

const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? []);

function progress(stage: Stage, fraction: number): void {
  post({ ok: true, type: "progress", stage, fraction: Math.max(0, Math.min(1, fraction)) });
}

/** Yanıtı parça parça oku; Content-Length varsa gerçek yüzde bildir. */
async function readAll(res: Response, stage: Stage, onChunk?: (c: Uint8Array) => void): Promise<Uint8Array[]> {
  const total = Number(res.headers.get("Content-Length") || 0);
  const reader = res.body?.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (onChunk) onChunk(buf); else parts.push(buf);
    progress(stage, 1);
    return parts;
  }
  let lastTick = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    loaded += value.byteLength;
    if (onChunk) onChunk(value); else parts.push(value);
    const now = Date.now();
    if (now - lastTick > 120) {
      lastTick = now;
      // Boyut bilinmiyorsa asimptotik tahmin: yüzde asla geriye gitmez, 0.95'te durur.
      progress(stage, total > 0 ? loaded / total : 1 - 1 / (1 + loaded / (24 * 1024 * 1024)));
    }
  }
  progress(stage, 1);
  return parts;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** Ana yol — sunucunun ürettiği paketi indir ve çöz. */
async function viaPack(fileId: string): Promise<{ g: ParsedGcode; packBytes: ArrayBuffer }> {
  const res = await fetch(`/api/models/${fileId}/viz-pack`, { cache: "no-store" });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error((j as { error?: string } | null)?.error || `Paket alınamadı (HTTP ${res.status})`);
  }
  const bytes = concat(await readAll(res, "fetch"));
  progress("decode", 0.2);
  const packBytes = toArrayBuffer(bytes);
  const pack = decodeVizPack(packBytes);
  progress("decode", 0.6);
  const g = expandPack(pack);
  progress("decode", 1);
  return { g, packBytes };
}

function packAndExpand(pack: VizPack): { g: ParsedGcode; packBytes: ArrayBuffer } {
  const packBytes = encodeVizPack(pack);
  return { g: expandPack(pack), packBytes };
}

/** Yedek yol — ham dosyayı akışla oku, burada tara (paket ucu yoksa/patlarsa). */
async function viaRawFile(fileId: string): Promise<{ g: ParsedGcode; packBytes: ArrayBuffer }> {
  const res = await fetch(`/api/models/${fileId}/file`, { cache: "no-store" });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error((j as { error?: string } | null)?.error || `Dosya alınamadı (HTTP ${res.status})`);
  }
  const total = Number(res.headers.get("Content-Length") || 0);

  // .3mf ZIP olduğu için akışla taranamaz → tamamını al, plaka gcode'unu çıkar.
  const name = decodeURIComponent(res.headers.get("X-File-Name") || "");
  const looks3mf = /\.3mf$/i.test(name);
  if (looks3mf) {
    const bytes = concat(await readAll(res, "fetch"));
    const entries = unzipSync(bytes, { filter: (f) => /^Metadata\/plate_\d+\.gcode$/i.test(f.name) });
    const names = Object.keys(entries);
    if (!names.length) throw new Error("3MF içinde plaka gcode'u yok (dilimlenmiş .3mf olmalı)");
    names.sort((a, b) => entries[b].length - entries[a].length);
    const plate = entries[names[0]];
    const sc = new GcodeScanner({ fileSize: plate.length });
    sc.push(plate);
    progress("scan", 1);
    return packAndExpand(sc.finish());
  }

  const sc = new GcodeScanner({ fileSize: total });
  let lastTick = 0;
  await readAll(res, "fetch", (chunk) => {
    sc.push(chunk);
    const now = Date.now();
    if (now - lastTick > 200) { lastTick = now; progress("scan", total > 0 ? sc.bytesScanned / total : 0.5); }
  });
  progress("scan", 1);
  return packAndExpand(sc.finish());
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { fileId, pack } = ev.data;
  try {
    let out: { g: ParsedGcode; packBytes: ArrayBuffer | null } | null = null;
    if (pack) {
      // Önbellekten geldi — ağa hiç çıkma, yalnız aç.
      // ⚠️ Önbellekteki paket ESKİ BİÇİMDE ya da bozuk olabilir (biçim sürümü değişti, yazma
      // yarıda kaldı). Eskiden burada yedek yol YOKTU: çözme patlayınca hata olduğu gibi ekrana
      // basılıyordu ve önbellek kalıcı olduğu için o model bir daha AÇILMIYORDU. Artık düşersek
      // normal yola geçeriz; taze paket önbelleğin üstüne yazılır.
      progress("decode", 0.3);
      try {
        out = { g: expandPack(decodeVizPack(pack)), packBytes: null };
        progress("decode", 1);
      } catch {
        out = null;
      }
    }
    if (!out) {
      try {
        out = await viaPack(fileId);
      } catch (packErr) {
        // Paket üretilemedi (disk hatası, eski sunucu…) → ham dosyadan devam et.
        if (packErr instanceof Error && /bulunamadı|cihazda yok|Bulut depolama/i.test(packErr.message)) throw packErr;
        out = await viaRawFile(fileId);
      }
    }
    const { g, packBytes } = out;
    const transfer: Transferable[] = [g.positions.buffer, g.features.buffer, g.tools.buffer];
    if (packBytes) transfer.push(packBytes);
    post(
      {
        ok: true,
        type: "done",
        positions: g.positions.buffer,
        features: g.features.buffer,
        tools: g.tools.buffer,
        layerRanges: g.layerRanges,
        bounds: g.bounds,
        totalSegments: g.totalSegments,
        scannedSegments: g.scannedSegments,
        toolCount: g.toolCount,
        filamentColors: g.filamentColors,
        fileSize: g.fileSize,
        thinLevel: g.thinLevel,
        pack: packBytes,
      },
      transfer,
    );
  } catch (e) {
    post({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
