import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { prisma } from "@/lib/prisma";
import { getUserDataDir } from "@/lib/storage";
import { resolveModelFileLocal } from "@/lib/model-files";
import { GcodeScanner, encodeVizPack, PACK_VERSION } from "./parse-gcode";

/**
 * Sunucu tarafı "viz-pack" üreticisi.
 *
 * NEDEN SUNUCUDA: dosyalar R2'de duruyor. Eski akışta 178 MB'lık gcode olduğu gibi tarayıcıya
 * indiriliyordu (ölçüldü: 24 sn) ve worker 180 sn'lik zaman aşımına yaklaşıyordu. Artık dosya
 * BİR KEZ burada akışla taranıp ~15 MB'lık pakete dönüşür, paket diske yazılır; sonraki
 * açılışlar R2'ye hiç gitmez.
 *
 * ⚠️ Bu süreç veritabanı sorgularıyla aynı olay döngüsünü paylaşır (uzak-HTTP libSQL sıralı
 * çalışır). Bu yüzden tarama her parçadan sonra olay döngüsüne nefes aldırır.
 */

const CACHE_DIR_NAME = "viz-packs";
const CHUNK = 4 * 1024 * 1024;
const MAX_CACHE_FILES = 40;

export interface PackResult {
  bytes: Uint8Array;
  /** Diskteki paketten mi geldi (yeniden taranmadı)? */
  fromCache: boolean;
  cacheKey: string;
}

function cacheDir(): string {
  const dir = path.join(getUserDataDir(), CACHE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Paket anahtarı — istemcideki IndexedDB anahtarıyla AYNI kural (md5 ilk 10 hex).
 * Sonunda paket biçim sürümü var: biçim değişince eski diskteki paketler ARTIK OKUNMAZ,
 * yeniden üretilir. (Sürüm 1 paketleri hizalama hatası yüzünden çözülemiyordu ve `fs.existsSync`
 * onları sonsuza dek geri veriyordu → dosya bir daha asla açılamıyordu.)
 */
export function packCacheKey(mf: { id: string; contentMd5?: string | null; sizeBytes?: number | null }): string {
  const base = mf.contentMd5 && /^[0-9a-f]{32}$/i.test(mf.contentMd5)
    ? `md5-${mf.contentMd5.slice(0, 10).toLowerCase()}`
    : `file-${mf.id}-${mf.sizeBytes ?? 0}`;
  return `${base}-v${PACK_VERSION}`;
}

/** Olay döngüsüne nefes aldır — tarama sırasında veritabanı sorguları aç kalmasın. */
function breathe(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/**
 * Yerel dosyayı akışla tara → paket baytları.
 * gcode ASLA tamamen belleğe alınmaz (178 MB dosya var). Yalnız .3mf (ZIP) açılmak zorunda
 * olduğu için belleğe okunur — dilimlenmiş 3mf'ler sıkıştırılmış ve çok daha küçüktür.
 */
async function scanFileToPack(file: string, declaredSize: number): Promise<Uint8Array> {
  const fd = await fs.promises.open(file, "r");
  try {
    // ZIP imzası (PK) → .3mf. Yalnız 4 bayt okunur; gcode belleğe alınmaz.
    const head = Buffer.alloc(4);
    const { bytesRead: headLen } = await fd.read(head, 0, 4, 0);
    const isZip = headLen >= 2 && head[0] === 0x50 && head[1] === 0x4b;

    if (isZip) {
      const zip = new Uint8Array(await fs.promises.readFile(file));
      const entries = unzipSync(zip, { filter: (f) => /^Metadata\/plate_\d+\.gcode$/i.test(f.name) });
      const names = Object.keys(entries);
      if (!names.length) throw new Error("3MF içinde plaka gcode'u yok (dilimlenmiş .3mf olmalı)");
      names.sort((a, b) => entries[b].length - entries[a].length);
      const plate = entries[names[0]];
      const scanner = new GcodeScanner({ fileSize: plate.length });
      for (let off = 0; off < plate.length; off += CHUNK) {
        scanner.push(plate.subarray(off, Math.min(plate.length, off + CHUNK)));
        await breathe();
      }
      return new Uint8Array(encodeVizPack(scanner.finish()));
    }

    const scanner = new GcodeScanner({ fileSize: declaredSize });
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fd.read(buf, 0, CHUNK, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      scanner.push(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
      await breathe();
    }
    return new Uint8Array(encodeVizPack(scanner.finish()));
  } finally {
    await fd.close();
  }
}

/** En eski paketleri sil (disk şişmesin). */
function pruneCache(dir: string): void {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mlvz"));
    if (files.length <= MAX_CACHE_FILES) return;
    const rows = files
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const r of rows.slice(0, rows.length - MAX_CACHE_FILES)) {
      try { fs.unlinkSync(path.join(dir, r.f)); } catch { /* önemsiz */ }
    }
  } catch { /* budama kritik değil */ }
}

// Aynı dosya için eşzamanlı istekler tek taramada birleşir (aynı anda iki 178 MB taraması olmasın).
const inflight = new Map<string, Promise<PackResult>>();

/** Model dosyasının görselleştirme paketini getir (diskte varsa oradan, yoksa üretip yazar). */
export function getVizPack(modelFileId: string): Promise<PackResult> {
  const existing = inflight.get(modelFileId);
  if (existing) return existing;
  const job = (async (): Promise<PackResult> => {
    const mf = await prisma.productModelFile.findUnique({ where: { id: modelFileId } });
    if (!mf) throw new Error("Model dosyası bulunamadı");

    const key = packCacheKey(mf);
    const dir = cacheDir();
    const out = path.join(dir, `${key}.mlvz`);
    if (fs.existsSync(out)) {
      const bytes = new Uint8Array(await fs.promises.readFile(out));
      fs.promises.utimes(out, new Date(), new Date()).catch(() => {}); // LRU damgası
      return { bytes, fromCache: true, cacheKey: key };
    }

    const local = await resolveModelFileLocal(mf);
    try {
      const bytes = await scanFileToPack(local.path, mf.sizeBytes || 0);
      await fs.promises.writeFile(out, bytes).catch(() => {}); // önbellek yazılamazsa da devam
      pruneCache(dir);
      return { bytes, fromCache: false, cacheKey: key };
    } finally {
      local.cleanup();
    }
  })().finally(() => inflight.delete(modelFileId));
  inflight.set(modelFileId, job);
  return job;
}
