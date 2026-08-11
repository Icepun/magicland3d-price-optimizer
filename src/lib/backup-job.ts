import fs from "node:fs";
import path from "node:path";
import { buildBackupPayload } from "./backup-payload";
import { prisma } from "./prisma";

/**
 * Günlük otomatik yedek.
 *
 * NEDEN: masaüstü tarafındaki eski yedekleme sürüm başına BİR KEZ çalışıyordu ve yalnız
 * yerel SQLite dosyasını kopyalıyordu. Kullanıcı bulut (Turso) modunda olduğu için o dosya
 * gerçek veriyi içermiyor → pratikte hiçbir otomatik yedek yoktu. Bu iş, gerçek veriden
 * taşınabilir JSON üretip günde bir kez diske yazar ve son 30 dosyayı saklar.
 *
 * Tasarım kararları:
 * - Zamanlama ölçüsü YEREL yedek dosyalarının tarihi. Bulutta tutulan tek bir damga
 *   kullanılsaydı, Mac yedek aldığında Windows kendini "yedeklenmiş" sayıp o makinede
 *   hiç dosya oluşmazdı. Yine de son yedek zamanı ayrıca ayarlara yazılır.
 * - Açılışta hemen çalışmaz (ağır okuma) ve uyku/askı korumasında atlanır.
 * - Hiçbir hata uygulamayı etkilemez; bir sonraki kontrol tekrar dener.
 */

const KEEP_FILES = 30;
/**
 * Yedek klasörünün toplam boyut tavanı. Yalnız DOSYA SAYISI sınırlamak yetmiyordu: veri
 * büyüdükçe 30 tam kopya kullanıcı klasöründe sessizce yüzlerce megabayta çıkabiliyor.
 * Tavan aşılırsa en eskiden başlayarak budanır (en az bir yedek her zaman kalır).
 */
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

/** Tavan (test valfi: MLHUB_BACKUP_MAX_BYTES). */
function maxTotalBytes(): number {
  const raw = Number(process.env.MLHUB_BACKUP_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_TOTAL_BYTES;
}
const DAY_MS = 24 * 60 * 60_000;
/** Aynı güne denk gelen ufak sapmalar yüzünden bir günün atlanmaması için küçük pay. */
const DUE_SLACK_MS = 10 * 60_000;
const FIRST_RUN_MS = 6 * 60_000; // açılış telaşı (şema, ilk ekranlar, pazaryeri çekimi) bitsin
const CHECK_MS = 60 * 60_000; // saatte bir "sırası geldi mi" bakar
const FILE_PREFIX = "yedek-";
const LAST_BACKUP_SETTING_KEY = "lastBackupAt";

let started = false;
let running = false;

export interface BackupFileInfo {
  /** Dosya adı (ör. yedek-2026-08-10-0312.json) */
  name: string;
  /** Oluşturulma zamanı (ISO) */
  at: string;
  /** Dosya boyutu (bayt) */
  size: number;
}

/**
 * Yedeklerin yazılacağı klasör. Masaüstü uygulaması kullanıcı verisi klasörünü zaten
 * birkaç env değişkeniyle bildiriyor; onlardan türetilir. Hiçbiri yoksa (geliştirme)
 * yedekleme sessizce kapalıdır — geliştirme makinesinde çöp dosya üretmez.
 */
export function backupDir(): string | null {
  const explicit = process.env.MLHUB_BACKUP_DIR?.trim();
  if (explicit) return explicit;

  const routeCacheDir = process.env.MLHUB_ROUTE_CACHE_DIR?.trim();
  if (routeCacheDir) return path.join(path.dirname(routeCacheDir), "backups");

  const ordersCacheFile = process.env.MLHUB_ORDERS_CACHE_FILE?.trim();
  if (ordersCacheFile) return path.join(path.dirname(ordersCacheFile), "backups");

  return null;
}

/** Otomatik yedekleme bu kurulumda çalışabiliyor mu? */
export function isBackupEnabled(): boolean {
  return backupDir() !== null;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** yedek-YYYY-AA-GG-SSdd.json (yerel saat — kullanıcı dosyayı kendi saatiyle arar). */
export function backupFileName(date: Date): string {
  return (
    `${FILE_PREFIX}${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
    `-${two(date.getHours())}${two(date.getMinutes())}.json`
  );
}

/** Klasördeki yedekler — en yeniden eskiye. */
export function listBackups(): BackupFileInfo[] {
  const dir = backupDir();
  if (!dir) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // klasör henüz yok
  }
  const files: BackupFileInfo[] = [];
  for (const name of names) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith(".json")) continue;
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile()) continue;
      files.push({ name, at: new Date(stat.mtimeMs).toISOString(), size: stat.size });
    } catch {
      /* okunamayan dosya listelenmez */
    }
  }
  // Ad şeması tarih sıralı olduğu için ada göre tersten sıralamak yeterli.
  files.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return files;
}

/** En eski dosyaları silerek son KEEP_FILES kaydı VE toplam boyut tavanını korur. */
function pruneOldBackups(dir: string): void {
  const files = listBackups(); // en yeniden eskiye sıralı
  const sil = (name: string) => {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* silinemeyen dosya bir sonraki turda tekrar denenir */
    }
  };

  // 1) Sayı sınırı.
  for (const file of files.slice(KEEP_FILES)) sil(file.name);

  // 2) Boyut tavanı: en yeniden başlayarak topla, tavanı aşan eskileri düş.
  //    En az BİR yedek her zaman kalır — tek yedek tavandan büyük olsa bile onu silmek,
  //    kullanıcıyı hiç yedeksiz bırakmak demektir.
  const tavan = maxTotalBytes();
  let toplam = 0;
  files.slice(0, KEEP_FILES).forEach((file, index) => {
    toplam += file.size;
    if (index > 0 && toplam > tavan) sil(file.name);
  });
}

/** Yedek klasörünün toplam boyutu (arayüz gösterir). */
export function backupsTotalBytes(): number {
  return listBackups().reduce((sum, f) => sum + f.size, 0);
}

/** Son yedek zamanı: önce yerel dosyalar, yoksa ayarlardaki damga. */
export async function getLastBackupAt(): Promise<string | null> {
  const files = listBackups();
  if (files.length > 0) return files[0].at;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: LAST_BACKUP_SETTING_KEY } });
    return row?.value?.trim() || null;
  } catch {
    return null;
  }
}

async function stampLastBackup(date: Date): Promise<void> {
  const value = date.toISOString();
  try {
    await prisma.appSetting.upsert({
      where: { key: LAST_BACKUP_SETTING_KEY },
      create: { key: LAST_BACKUP_SETTING_KEY, value },
      update: { value },
    });
  } catch {
    /* damga yazılamazsa yedek yine de alınmıştır; zamanlama yerel dosyalara bakar */
  }
}

/** Son yedeğin üzerinden 24 saat geçti mi? */
function isDue(): boolean {
  const files = listBackups();
  if (files.length === 0) return true;
  const newest = Date.parse(files[0].at);
  if (!Number.isFinite(newest)) return true;
  return Date.now() - newest >= DAY_MS - DUE_SLACK_MS;
}

/**
 * Yedeği şimdi al. Hata durumunda kullanıcıya gösterilebilir sade bir mesaj fırlatır.
 * @param sequential Arka plan işi için true — tabloları tek tek okur, uygulamayı yavaşlatmaz.
 */
export async function runBackupNow(sequential = false): Promise<BackupFileInfo> {
  const dir = backupDir();
  if (!dir) throw new Error("Yedek klasörü bulunamadı.");

  let payload: unknown;
  try {
    fs.mkdirSync(dir, { recursive: true });
    payload = await buildBackupPayload({ sequential });
  } catch (e) {
    console.error("[backup] veri okunamadı:", e);
    throw new Error("Yedek alınamadı, birazdan tekrar deneyin.");
  }

  const now = new Date();
  const name = backupFileName(now);
  const target = path.join(dir, name);
  const temp = path.join(dir, `.${name}.tmp`);
  try {
    // Önce geçici dosyaya yazılır: yazım yarıda kalırsa bozuk bir "yedek" görünmez.
    await fs.promises.writeFile(temp, JSON.stringify(payload), "utf8");
    fs.renameSync(temp, target);
  } catch (e) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* geçici dosya zaten yok */
    }
    console.error("[backup] dosya yazılamadı:", e);
    throw new Error("Yedek dosyası kaydedilemedi.");
  }

  let size = 0;
  try {
    size = fs.statSync(target).size;
  } catch {
    /* boyut okunamadıysa 0 gösterilir */
  }

  pruneOldBackups(dir);
  await stampLastBackup(now);

  return { name, at: now.toISOString(), size };
}

async function tick(): Promise<void> {
  if (running) return;
  // Uyku/askı korumasındayken veritabanına dokunma (relay ile aynı kural).
  if ((globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__) return;
  if (!isBackupEnabled()) return;
  if (!isDue()) return;
  running = true;
  try {
    await runBackupNow(true);
  } catch {
    /* sonraki kontrol tekrar dener — kullanıcıyı etkilemez */
  } finally {
    running = false;
  }
}

/** Günlük yedek işini başlat (sunucu açılışında bir kez). */
export function startBackupJob(): void {
  if (started) return;
  started = true;
  if (!isBackupEnabled()) return; // geliştirme ortamı: sessizce kapalı
  setTimeout(() => {
    void tick();
  }, FIRST_RUN_MS);
  setInterval(() => {
    void tick();
  }, CHECK_MS);
}
