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

  createClient(config: LibsqlConfig): LibsqlClient {
    const syncUrl = (config as { syncUrl?: string }).syncUrl;
    if (syncUrl) {
      // super.createClient'tan ÖNCE bak: replica dosyası zaten var mıydı?
      // Varsa = önceki oturumun verisi yerelde mevcut → açılışta beklemeden göster.
      const url = String((config as { url?: string }).url || "");
      const filePath = url.startsWith("file:") ? url.slice("file:".length) : url;
      try {
        this.#replicaPreexisting = filePath ? fs.existsSync(filePath) : false;
      } catch {
        this.#replicaPreexisting = false;
      }
    }
    const client = super.createClient(config);
    // Sadece gerçek replica (syncUrl'li file) client'ını yakala; :memory: shadow değil.
    if (syncUrl) this.#replicaClient = client;
    return client;
  }

  async connect() {
    const adapter = await super.connect();
    if (this.#replicaClient) {
      // Buluttan çekmeyi ARKA PLANDA başlat — ilk sorgu YEREL replica'dan anında
      // döner (önceki oturumun verisi). Diğer cihazın değişiklikleri bu sync + 60sn'lik
      // syncInterval ile kısa sürede gelir.
      const syncing = this.#replicaClient.sync().catch((e) => {
        console.error(
          "[prisma] Turso embedded replica sync başarısız:",
          e instanceof Error ? e.message : e
        );
      });
      // SADECE ilk kurulumda (replica dosyası henüz yokken) bekle — yerelde hiç veri
      // olmadığı için ilk sorgunun veri görmesi şart. Sonraki açılışlarda BEKLEMEYİZ
      // → 10-15 sn'lik boş ekran ortadan kalkar.
      if (!this.#replicaPreexisting) {
        await syncing;
      }
    }
    return adapter;
  }

  /** Relay için: yerel replica'yı buluttan ANINDA tazele (telefon komutlarını çabuk görmek için). */
  async syncNow(): Promise<void> {
    if (this.#replicaClient) {
      try {
        await this.#replicaClient.sync();
      } catch (e) {
        console.error("[prisma] relay sync hatası:", e instanceof Error ? e.message : e);
      }
    }
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
      syncInterval: 60, // saniye — periyodik pull (yazmalar zaten anında buluta gider)
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
