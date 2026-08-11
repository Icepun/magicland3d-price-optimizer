/**
 * Süreçler arası kalıcı stale-while-revalidate (SWR) önbelleği.
 *
 * NEDEN: Turso'ya uzak-HTTP modunda her ağır okuma (panel ~2sn) bir ağ gidiş-dönüşü. Kullanıcı
 * her açılışta/gezinmede bunu bekliyordu ("veri çekmek çok yavaş"). Bu önbellek:
 *   - TAZE (< ttl): anında döner (ağ yok).
 *   - BAYAT: bayatı ANINDA döner + arka planda sessizce tazeler → kullanıcı ASLA beklemez.
 *   - HİÇ YOK: hesaplar; aynı anahtara gelen eşzamanlı istekler TEK hesabı paylaşır (dedup).
 * Son başarılı yanıt diske de yazılır. Böylece uygulama/güncelleme sonrasında eski ama geçerli
 * veri ANINDA görünür; uzak Turso hesabı arka planda sessizce tazeler.
 *
 * Sadece OKUMA (GET) sonuçları için. Bayatlık üst sınırı ttl kadar; kullanıcı bir şey değiştirince
 * bustCache() ile ilgili anahtarlar temizlenebilir (anında tazelik gerekiyorsa).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type Entry = { at: number; data: unknown };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const diskChecked = new Set<string>();
const DISK_FORMAT = 1;
const MAX_DISK_AGE_MS = 30 * 24 * 60 * 60_000;
/** Anahtarı okumak için dosyanın başından okunan bayt — anahtar ilk ~100 baytta, gövde MB'larca olabilir. */
const HEAD_BYTES = 4096;

function cacheDir(): string | null {
  return process.env.MLHUB_ROUTE_CACHE_DIR?.trim() || null;
}

function cacheFile(key: string): string | null {
  const dir = cacheDir();
  if (!dir) return null;
  const hash = createHash("sha256").update(key).digest("hex");
  return path.join(dir, `${hash}.json`);
}

function loadDiskOnce(key: string): void {
  if (diskChecked.has(key)) return;
  diskChecked.add(key);
  const file = cacheFile(key);
  if (!file) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      format?: number;
      key?: string;
      at?: number;
      data?: unknown;
    };
    if (
      parsed.format === DISK_FORMAT &&
      parsed.key === key &&
      typeof parsed.at === "number" &&
      Date.now() - parsed.at <= MAX_DISK_AGE_MS &&
      parsed.data !== undefined
    ) {
      store.set(key, { at: parsed.at, data: parsed.data });
    }
  } catch {
    // Dosya yok/yarım/eski format → ilk başarılı hesap diski yeniden doldurur.
  }
}

function persistDisk(key: string, entry: Entry): void {
  const file = cacheFile(key);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        format: DISK_FORMAT,
        key,
        at: entry.at,
        data: entry.data,
      }),
      "utf8"
    );
  } catch {
    // Disk cache yalnız hızlandırmadır; yazılamaması veri akışını bozmamalı.
  }
}

function runAndStore<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const p = compute()
    .then((d) => {
      const entry = { at: Date.now(), data: d };
      store.set(key, entry);
      persistDisk(key, entry);
      return d;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p as Promise<unknown>);
  return p;
}

export async function swr<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  loadDiskOnce(key);
  const now = Date.now();
  const hit = store.get(key);

  if (hit) {
    if (now - hit.at < ttlMs) return hit.data as T; // taze
    // Bayat → bayatı hemen dön; arka planda tazele (hata olursa bayat kalsın).
    if (!inflight.has(key)) {
      runAndStore(key, compute).catch(() => {
        /* tazeleme başarısız → mevcut bayat veri korunur */
      });
    }
    return hit.data as T;
  }

  // Hiç yok → hesapla (eşzamanlı istekler tek hesabı paylaşır).
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  return runAndStore(key, compute);
}

/**
 * Diskteki önbellek dosyalarından ön eke uyanların yollarını döndürür.
 *
 * NEDEN GEREKLİ: dosya adı anahtarın sha256'sı olduğu için ön ekten dosya adı türetilemez;
 * anahtarı dosyanın İÇİNDEN okumak şart. Ön ekli temizlik yalnız bellekteki anahtarları
 * gezseydi, o oturumda hiç açılmamış bir ekranın (ör. Gizli / Zarar Eden sekmeleri) disk
 * kopyası hayatta kalır ve bir sonraki açılışta ESKİ kuralla hesaplanmış kâr geri dönerdi.
 * Tam gövdeyi ayrıştırmıyoruz — anahtar dosyanın ilk baytlarında, gövde ise çok büyük olabilir.
 */
function diskFilesWithPrefix(prefixes: string[]): string[] {
  const dir = cacheDir();
  if (!dir) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let head: string;
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(HEAD_BYTES);
      const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      head = buf.toString("utf8", 0, read);
    } catch {
      continue;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* zaten kapalı */
        }
      }
    }
    const found = /"key"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
    if (!found) continue;
    let key: string;
    try {
      key = JSON.parse(`"${found[1]}"`) as string;
    } catch {
      continue;
    }
    if (prefixes.some((prefix) => key.startsWith(prefix))) matches.push(file);
  }
  return matches;
}

/** Verilen ön ekle başlayan tüm anahtarları temizle (argümansız: hepsi). Yazma sonrası tazelik için. */
export function bustCache(prefix?: string): void {
  if (!prefix) {
    const dir = cacheDir();
    if (dir) {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name.endsWith(".json")) {
            fs.rmSync(path.join(dir, name), { force: true });
          }
        }
      } catch { /* cache dizini yok/yazılamıyor → bellek yine temizlenir */ }
    }
    store.clear();
    diskChecked.clear();
    return;
  }
  bustCaches([prefix]);
}

/**
 * Birden çok ön eki TEK disk taramasıyla temizler.
 *
 * NEDEN: `bustCache` her çağrısında önbellek klasörünün tamamını gezip her dosyanın başını
 * okuyor. Tek bir ürün düzenlemesi dört ayrı ön ek temizlediği için klasör dört kez baştan
 * taranıyordu; yüzlerce dosyada bu, her kayıtta gereksiz disk yükü demek. Aynı temizlik turunun
 * ön eklerini burada topluca ver → tarama bir kez yapılır.
 */
export function bustCaches(prefixes: string[]): void {
  const list = prefixes.filter((p) => p.length > 0);
  if (list.length === 0) return;
  for (const k of [...store.keys()]) {
    if (!list.some((prefix) => k.startsWith(prefix))) continue;
    store.delete(k);
    diskChecked.delete(k);
    const file = cacheFile(k);
    if (file) {
      try { fs.rmSync(file, { force: true }); } catch { /* sonraki GET canlı hesaplar */ }
    }
  }
  // Bellekte olmayan (bu oturumda hiç okunmamış) disk kopyaları da gitmeli — yoksa uygulama
  // yeniden başlayınca eski gövde geri yüklenir ve değişiklik "uygulanmamış" görünür.
  for (const file of diskFilesWithPrefix(list)) {
    try { fs.rmSync(file, { force: true }); } catch { /* sonraki GET canlı hesaplar */ }
  }
}
