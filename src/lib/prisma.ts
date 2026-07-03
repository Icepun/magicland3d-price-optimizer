import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import path from "node:path";
import fs from "node:fs";

// Tipleri adapter'ın KENDİ createClient imzasından türet — @libsql/client'ı ayrıca
// import edersek adapter'ın paketlediği farklı @libsql/core sürümüyle tip çakışıyor.
type LibsqlConfig = Parameters<PrismaLibSQL["createClient"]>[0];
type LibsqlClient = ReturnType<PrismaLibSQL["createClient"]>;

/**
 * Embedded replica için TEK client kullanan adapter.
 *
 * Sorun (0.9.14): electron startup'ta AYRI bir libsql client'la ön-senkron yapıp
 * kapatıyordu; sonra Prisma KENDİ client'ıyla aynı replica dosyasını açınca libsql
 * "Can not sync a database without a wal_index" hatası veriyordu (iki sync client
 * tek dosyada çakışıyor). Embedded replica TEK client ister.
 *
 * Çözüm: ön-senkron client'ı kaldırıldı. İlk veri çekimini Prisma'nın kendi client'ı
 * yapıyor — connect()'te bir kez `sync()`. Sonrası syncInterval ile periyodik.
 */
class EmbeddedReplicaPrismaLibSQL extends PrismaLibSQL {
  #replicaClient: LibsqlClient | null = null;
  /** Replica dosyası bu açılıştan ÖNCE var mıydı? (yoksa = ilk kurulum) */
  #replicaPreexisting = false;
  /** Aynı anda iki native sync olmasın (üst üste = veri bozulma riski + sorgu blokajı uzar). */
  #syncing = false;
  /** Bulut erişim kontrolü için syncUrl'in HTTPS karşılığı. */
  #syncHttpUrl: string | null = null;
  /** "Sync sürüyor" işaret dosyası — kendi kendini iyileştirme için (aşağıya bak). */
  #markerPath: string | null = null;

  createClient(config: LibsqlConfig): LibsqlClient {
    const syncUrl = (config as { syncUrl?: string }).syncUrl;
    if (syncUrl) {
      const url = String((config as { url?: string }).url || "");
      const filePath = url.startsWith("file:") ? url.slice("file:".length) : url;
      // KENDİ KENDİNİ İYİLEŞTİRME (Mac aylık donma döngüsünün kalıcı fix'i):
      // Native sync başlamadan işaret dosyası yazılır, sync SAĞLIKLA dönünce silinir.
      // Açılışta işaret hâlâ duruyorsa = önceki oturum sync ORTASINDA donup zorla
      // kapatılmış → replica dosyası büyük olasılıkla bozuk durumda; bozuk replica'da
      // native sync SONSUZA DEK takılıp (kanıt: sample → index.node → __psynch_cvwait)
      // tüm SQL'i ve Electron ana thread'ini donduruyordu. Çare: replica'yı SİL →
      // taze tam senkron (~15-20sn, bir kereye mahsus) → döngü kırılır.
      if (filePath) {
        this.#markerPath = `${filePath}.sync-in-progress`;
        try {
          if (fs.existsSync(this.#markerPath)) {
            console.warn("[prisma] Önceki oturum sync ortasında kesilmiş — replica sıfırlanıyor (taze senkron).");
            for (const suffix of ["", "-wal", "-shm", "-info"]) {
              try { fs.rmSync(`${filePath}${suffix}`, { force: true }); } catch { /* yoksa geç */ }
            }
            try { fs.rmSync(this.#markerPath, { force: true }); } catch { /* yoksa geç */ }
          }
        } catch { /* iyileştirme başarısızsa normal akış dener */ }
      }
      // super.createClient'tan ÖNCE bak: replica dosyası zaten var mıydı?
      // Varsa = önceki oturumun verisi yerelde mevcut → açılışta beklemeden göster.
      try {
        this.#replicaPreexisting = filePath ? fs.existsSync(filePath) : false;
      } catch {
        this.#replicaPreexisting = false;
      }
      this.#syncHttpUrl = syncUrl.replace(/^libsql:\/\//i, "https://").replace(/^wss?:\/\//i, "https://");
    }
    const client = super.createClient(config);
    // Sadece gerçek replica (syncUrl'li file) client'ını yakala; :memory: shadow değil.
    if (syncUrl) this.#replicaClient = client;
    return client;
  }

  /** Native sync'i işaret dosyasıyla sar: başlarken yaz, SAĞLIKLA bitince sil.
   *  Süreç sync ortasında ölür/donarsa işaret kalır → bir sonraki açılış replica'yı tazeler. */
  #trackedSync(client: LibsqlClient): Promise<unknown> {
    try { if (this.#markerPath) fs.writeFileSync(this.#markerPath, String(Date.now())); } catch { /* izleme yazılamadıysa sync yine denenir */ }
    return client.sync().finally(() => {
      try { if (this.#markerPath) fs.rmSync(this.#markerPath, { force: true }); } catch { /* silinemezse sonraki açılış tazeler (zararsız) */ }
    });
  }

  /**
   * Bulut 2sn içinde erişilebilir mi? KRİTİK: libSQL embedded replica `sync()`'i SQL sorgularını
   * BLOKE eder (bilinen kısıt, libsql#979). Ağ yokken bloke eden native sync'i HİÇ çağırmamak için
   * önce hızlı bir erişim kontrolü yaparız → ağ kopunca uygulama DONMAZ.
   */
  async #cloudReachable(): Promise<boolean> {
    if (!this.#syncHttpUrl) return true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    try {
      await fetch(this.#syncHttpUrl, { method: "GET", signal: ctrl.signal, cache: "no-store" });
      return true; // herhangi bir HTTP yanıtı (401/404 dahil) = erişilebilir
    } catch {
      return false; // ağ hatası / timeout = erişilemez → sync ATLA
    } finally {
      clearTimeout(t);
    }
  }

  async connect() {
    const adapter = await super.connect();
    // İlk kurulumda (yerelde HİÇ veri yok) bir kez senkronla — ama açılışı kilitleme:
    // erişim varsa + en fazla 6sn. MEVCUT kurulumda connect'te SENKRON YOK; çünkü sync()
    // sorguları bloke ediyor → ilk sorgu/açılış donardı. Tazeleme relay'in periyodik
    // (erişim-kontrollü) syncNow'ı ile arka planda gelir.
    if (this.#replicaClient && !this.#replicaPreexisting) {
      try {
        if (await this.#cloudReachable()) {
          await Promise.race([
            this.#trackedSync(this.#replicaClient),
            new Promise((r) => setTimeout(r, 6000)),
          ]);
        }
      } catch {
        /* ilk sync başarısızsa boş yerelle aç; relay sonra doldurur */
      }
    }
    return adapter;
  }

  /**
   * Relay: yerel replica'yı buluttan tazele. Re-entrancy guard + erişim kontrolü + sınırlı bekleme.
   * Native sync bitene dek guard AÇIK kalır (timeout'ta sıfırlanmaz) → üst üste native sync olmaz.
   */
  async syncNow(): Promise<void> {
    if (!this.#replicaClient || this.#syncing) return;
    if (!(await this.#cloudReachable())) return; // ağ yok → bloke eden native sync'i çağırma
    this.#syncing = true;
    const client = this.#replicaClient;
    const done = this.#trackedSync(client)
      .catch((e) => console.error("[prisma] sync:", e instanceof Error ? e.message : e))
      .finally(() => { this.#syncing = false; });
    // Çağıran en fazla 9sn bekler; native sync arka planda devam edebilir (guard onu korur).
    await Promise.race([done, new Promise((r) => setTimeout(r, 9000))]);
  }
}

/**
 * Veritabanı bağlantısı:
 *  - TURSO_DATABASE_URL set ise → Turso bulut DB (libSQL adapter, çok cihaz senkron)
 *  - değilse                    → local SQLite (klasik motor + DATABASE_URL, ESKİ kanıtlı yol)
 *
 * Adapter SADECE Turso modunda devreye girer; local kullananlar için davranış
 * hiç değişmez (regresyon riski yok). Turso bilgileri electron/main.js tarafından
 * userData/turso-settings.json'dan okunup env'e konur.
 */
const tursoUrl = process.env.TURSO_DATABASE_URL?.trim();
const tursoToken = process.env.TURSO_AUTH_TOKEN?.trim();

// Local mod: relative DATABASE_URL'i mutlak yola çevir (eski mantık)
if (!tursoUrl) {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (
    databaseUrl === "file:./dev.db" ||
    databaseUrl === "file:dev.db" ||
    databaseUrl.startsWith("file:./dev.db") ||
    databaseUrl.startsWith("file:dev.db")
  ) {
    const dbPath = path.join(process.cwd(), "prisma", "dev.db").replace(/\\/g, "/");
    process.env.DATABASE_URL = `file:${dbPath}`;
  }
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Turso modunda relay'in zorla-senkron için kullanacağı adapter referansı. */
let _tursoAdapter: EmbeddedReplicaPrismaLibSQL | null = null;

function createPrisma(): PrismaClient {
  const log = process.env.NODE_ENV === "development" ? ["error", "warn"] as const : ["error"] as const;

  if (tursoUrl) {
    // Bulut DB — libSQL adapter, EMBEDDED REPLICA modu.
    // Yerel kopya dosyası birincil: okumalar yerelden (anında), yazmalar buluta
    // yazılır, syncInterval ile diğer cihazın değişiklikleri arka planda çekilir.
    // (Eski "url: tursoUrl" uzak-only mod her sorguyu eu-west-1'e gönderiyordu → 3-4sn.)
    const replicaPath =
      process.env.TURSO_REPLICA_PATH?.trim() ||
      path.join(process.cwd(), "prisma", "turso-replica.db").replace(/\\/g, "/");
    // Not: readYourWrites native libsql'de zaten varsayılan true (kendi yazdığını
    // anında okur); @libsql/client Config tipinde olmadığı için burada geçilmiyor.
    // TEK client (EmbeddedReplicaPrismaLibSQL) — ayrı ön-senkron client'ı YOK.
    const adapter = new EmbeddedReplicaPrismaLibSQL({
      url: `file:${replicaPath}`,
      syncUrl: tursoUrl,
      authToken: tursoToken || undefined,
      // syncInterval KALDIRILDI: native otomatik periyodik sync, ağ değişince/kopunca askıda kalıp
      // SQL sorgularını bloke ediyordu (libSQL bilinen kısıt #979) → uygulama donuyordu. Tazeleme
      // artık SADECE relay'in erişim-kontrollü + guard'lı syncNow'ı ile (donma riski yok).
    });
    _tursoAdapter = adapter; // relay zorla-senkron için
    return new PrismaClient({ adapter, log: [...log] });
  }

  // Local SQLite — klasik motor (DATABASE_URL üzerinden), adapter YOK
  return new PrismaClient({ log: [...log] });
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

// Aynı bağlantı tüm isteklerde yeniden kullanılsın
globalForPrisma.prisma = prisma;

/** Relay: yerel Turso replica'yı zorla senkronla (Turso modu değilse no-op). */
export async function syncTursoReplica(): Promise<void> {
  if (_tursoAdapter) await _tursoAdapter.syncNow();
}
