import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { prisma } from "@/lib/prisma";
import { getUserDataDir } from "@/lib/storage";
import { resolveModelFileLocal } from "@/lib/model-files";
import { zipDizini } from "@/lib/slicer-preview";
import { GcodeScanner, ModelCokBuyukHatasi, encodeVizPack } from "./parse-gcode";
import { PACK_ANAHTAR_ETIKETI } from "./viz-pack";

/**
 * Sunucu tarafı "viz-pack" üreticisi.
 *
 * NEDEN SUNUCUDA: dosyalar R2'de duruyor. Eski akışta 178 MB'lık gcode olduğu gibi tarayıcıya
 * indiriliyordu (ölçüldü: 24 sn) ve worker 180 sn'lik zaman aşımına yaklaşıyordu. Artık dosya
 * BİR KEZ burada akışla taranıp ~15 MB'lık pakete dönüşür, paket diske yazılır; sonraki
 * açılışlar R2'ye hiç gitmez.
 *
 * ⚠️ Bu süreç veritabanı sorgularıyla ve TÜM uygulama sunucusuyla aynı olay döngüsünü paylaşır.
 * Bu yüzden: (1) dosya hiçbir zaman tümüyle belleğe açılmaz — .3mf içindeki plaka gcode'u da
 * akışla çözülür (sıkıştırma çözücü iş parçacığı havuzunda çalışır), (2) her parçadan sonra olay
 * döngüsüne nefes aldırılır, (3) önizleme için fazla büyük dosya bir kez işaretlenir ve bir daha
 * taranmaz. 29 Eyl 2026: 106 MB'lık bir .3mf (içinde 425 MB gcode, 50'li anahtarlık) eski
 * tarayıcıda saatlerce bitmedi ve uygulamayı tamamen dondurdu.
 */

const CACHE_DIR_NAME = "viz-packs";
const CHUNK = 4 * 1024 * 1024;
const MAX_CACHE_FILES = 40;
/** Bundan büyük paket ne kartta ne telefonda rahat çizilir → "çok büyük" sayılır. */
export const AZAMI_PAKET_BAYT = 40 * 1024 * 1024;

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
  return `${base}-${PACK_ANAHTAR_ETIKETI}`;
}

/** "Önizleme için çok büyük" işareti — dosya bir daha taranmasın (her deneme dakikalar sürerdi). */
function buyukIsaretYolu(dir: string, key: string): string {
  return path.join(dir, `${key}.buyuk`);
}

/** Bu dosya daha önce "önizleme için çok büyük" diye işaretlendi mi? (Ucuz: tek dosya varlığı.) */
export function vizPaketiCokBuyuk(mf: { id: string; contentMd5?: string | null; sizeBytes?: number | null }): boolean {
  try {
    return fs.existsSync(buyukIsaretYolu(cacheDir(), packCacheKey(mf)));
  } catch {
    return false;
  }
}

/** Olay döngüsüne nefes aldır — tarama sırasında veritabanı sorguları aç kalmasın. */
function breathe(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/**
 * .3mf (zip) içindeki EN BÜYÜK plaka gcode'unu akışla tara.
 *
 * Eskiden dosyanın tamamı okunup `unzipSync` ile plaka BELLEKTE açılıyordu: 425 MB'lık plaka
 * hem o kadar bellek hem de olay döngüsünü saniyelerce kilitleyen tek bir eşzamanlı çağrı
 * demekti. Artık yalnız zip dizini okunur, plaka verisi diskten parça parça çözülür.
 */
async function scan3mfToPack(file: string, fileSize: number): Promise<Uint8Array> {
  const fd = await fs.promises.open(file, "r");
  let plaka: { veriBas: number; sikisik: number; yontem: number; acik: number } | null = null;
  try {
    const oku = async (a: number, b: number): Promise<Buffer> => {
      const uz = Math.max(0, b - a + 1);
      const buf = Buffer.alloc(uz);
      const { bytesRead } = await fd.read(buf, 0, uz, a);
      return buf.subarray(0, bytesRead);
    };
    const girdiler = (await zipDizini(oku, fileSize)) ?? [];
    const plakalar = girdiler
      .filter((g) => /^Metadata\/plate_\d+\.gcode$/i.test(g.ad))
      .sort((a, b) => b.sikisikBoyut - a.sikisikBoyut);
    const g = plakalar[0];
    if (!g) throw new Error("3MF içinde plaka gcode'u yok (dilimlenmiş .3mf olmalı)");
    const yerelBas = await oku(g.yerelOfset, g.yerelOfset + 29);
    if (yerelBas.length < 30) throw new Error("3MF okunamadı");
    plaka = {
      veriBas: g.yerelOfset + 30 + yerelBas.readUInt16LE(26) + yerelBas.readUInt16LE(28),
      sikisik: g.sikisikBoyut,
      yontem: g.yontem,
      acik: g.acikBoyut,
    };
  } finally {
    await fd.close();
  }
  if (plaka.yontem !== 0 && plaka.yontem !== 8) throw new Error("3MF sıkıştırması tanınmadı");

  const kaynak = fs.createReadStream(file, {
    start: plaka.veriBas,
    end: plaka.veriBas + plaka.sikisik - 1,
    highWaterMark: 1024 * 1024,
  });
  const cozucu = plaka.yontem === 8 ? zlib.createInflateRaw({ chunkSize: 1024 * 1024 }) : null;
  const akis = cozucu ? kaynak.pipe(cozucu) : kaynak;
  const scanner = new GcodeScanner({ fileSize: plaka.acik });
  try {
    for await (const parca of akis) {
      scanner.push(parca as Buffer);
      await breathe();
    }
  } finally {
    kaynak.destroy();
    cozucu?.destroy();
  }
  return new Uint8Array(encodeVizPack(scanner.finish()));
}

/**
 * Yerel dosyayı akışla tara → paket baytları.
 * gcode ASLA tamamen belleğe alınmaz (178 MB dosya var).
 */
async function scanFileToPack(file: string, declaredSize: number): Promise<Uint8Array> {
  const fd = await fs.promises.open(file, "r");
  let isZip = false;
  try {
    // ZIP imzası (PK) → .3mf. Yalnız 4 bayt okunur; gcode belleğe alınmaz.
    const head = Buffer.alloc(4);
    const { bytesRead: headLen } = await fd.read(head, 0, 4, 0);
    isZip = headLen >= 2 && head[0] === 0x50 && head[1] === 0x4b;
    if (!isZip) {
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
    }
  } finally {
    await fd.close();
  }
  const boyut = declaredSize > 0 ? declaredSize : (await fs.promises.stat(file)).size;
  return scan3mfToPack(file, boyut);
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
    // Önce "çok büyük" işareti: dosya indirilmez, taranmaz. (Aynı ada konmuş yer tutucu paket
    // de temizlenir — işaret varken paket asla doğru değildir.)
    if (fs.existsSync(buyukIsaretYolu(dir, key))) {
      fs.promises.unlink(out).catch(() => {});
      throw new ModelCokBuyukHatasi(0);
    }
    if (fs.existsSync(out)) {
      const bytes = new Uint8Array(await fs.promises.readFile(out));
      fs.promises.utimes(out, new Date(), new Date()).catch(() => {}); // LRU damgası
      return { bytes, fromCache: true, cacheKey: key };
    }

    const local = await resolveModelFileLocal(mf);
    try {
      let bytes: Uint8Array;
      try {
        bytes = await scanFileToPack(local.path, mf.sizeBytes || 0);
        if (bytes.byteLength > AZAMI_PAKET_BAYT) throw new ModelCokBuyukHatasi(0);
      } catch (e) {
        if (e instanceof ModelCokBuyukHatasi) {
          // Bir daha taranmasın: işaret diske yazılır (dosya içeriği değişmedikçe sonuç aynı).
          await fs.promises
            .writeFile(buyukIsaretYolu(dir, key), `${e.yolSayisi || "?"} yol`)
            .catch(() => {});
        }
        throw e;
      }
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
