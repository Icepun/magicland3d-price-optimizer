import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import path from "node:path";
import fs from "node:fs";

// Tipleri adapter'ın KENDİ createClient imzasından türet — @libsql/client'ı ayrıca
// import edersek adapter'ın paketlediği farklı @libsql/core sürümüyle tip çakışıyor.
type LibsqlConfig = Parameters<PrismaLibSQL["createClient"]>[0];
type LibsqlClient = ReturnType<PrismaLibSQL["createClient"]>;

/** Replica'nın yan dosyaları (-wal/-shm/-info/-client_wal_index/… + sync marker'ı).
 *  Dizin taranır → libsql ileride yeni uzantı eklerse o da yakalanır. */
function listSidecars(replicaPath: string): string[] {
  const dir = path.dirname(replicaPath);
  const base = path.basename(replicaPath);
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(base) && f !== base);
  } catch {
    return [];
  }
}

/** Replica'yı GÜVENLİ SIRAYLA sil: yan dosyalar önce, ana .db EN SON.
 *  Ana db önce silinip işlem yarıda kesilirse libsql'in onulmaz saydığı "metadata var ama
 *  db yok" durumu kalır ve her bağlantı patlar (v0.19.112). Bu sıra o tuzağı kapatır. */
function resetReplica(replicaPath: string): void {
  const dir = path.dirname(replicaPath);
  for (const f of listSidecars(replicaPath)) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* devam */ }
  }
  try { fs.rmSync(replicaPath, { force: true }); } catch { /* normal akış dener */ }
}

/**
 * Embedded replica için TEK client kullanan adapter.
 *
 * Sorun (0.9.14): electron startup'ta AYRI bir libsql client'la ön-senkron yapıp
 * kapatıyordu; sonra Prisma KENDİ client'ıyla aynı replica dosyasını açınca libsql
 * "Can not sync a database without a wal_index" hatası veriyordu (iki sync client
 * tek dosyada çakışıyor). Embedded replica TEK client ister.
 *
 * Çözüm: ön-senkron client'ı kaldırıldı. Yalnız replica dosyası hiç yoksa Prisma'nın
 * kendi client'ı connect() sırasında bir kez doldurur. Mevcut replica'da ve normal
 * uygulama oturumunda native sync() hiçbir zaman çağrılmaz.
 */
class EmbeddedReplicaPrismaLibSQL extends PrismaLibSQL {
  #replicaClient: LibsqlClient | null = null;
  /** Replica dosyası bu açılıştan ÖNCE var mıydı? (yoksa = ilk kurulum) */
  #replicaPreexisting = false;
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
          // (a) Yarım kalmış sync işareti → replica şüpheli, sıfırla.
          // (b) Ana db YOK ama yan dosya (metadata) kalmış → libsql'in ONULMAZ saydığı
          //     "metadata file exists but db file does not" durumu; temizlenmezse HER
          //     bağlantı patlar (v0.19.112: panel/API 500). Her iki halde de aynı çare.
          const orphaned = !fs.existsSync(filePath) && listSidecars(filePath).length > 0;
          if (fs.existsSync(this.#markerPath) || orphaned) {
            console.warn(
              orphaned
                ? "[prisma] Yetim replica metadata (db yok) — sıfırlanıyor (taze senkron)."
                : "[prisma] Önceki oturum sync ortasında kesilmiş — replica sıfırlanıyor (taze senkron)."
            );
            resetReplica(filePath);
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
    // İlk kurulumda (yerelde HİÇ veri yok) bir kez senkronla. Tamamlanmadan sorgu
    // başlatmayarak yarım ilk-sync ile UI sorgularının üst üste binmesini engelle.
    // MEVCUT kurulumda connect'te ve oturum boyunca SENKRON YOK.
    if (this.#replicaClient && !this.#replicaPreexisting) {
      try {
        if (await this.#cloudReachable()) {
          await this.#trackedSync(this.#replicaClient);
        }
      } catch {
        /* ilk sync başarısızsa API'ler anlaşılır DB hatası verir; sonraki açılış tekrar dener */
      }
    }
    return adapter;
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
const replicaPathFromEnv = process.env.TURSO_REPLICA_PATH?.trim();
const useEmbeddedReplica =
  Boolean(replicaPathFromEnv) &&
  process.env.TURSO_DISABLE_EMBEDDED_REPLICA?.trim() !== "1";
const remoteTursoUrl = tursoUrl
  ?.replace(/^libsql:\/\//i, "https://")
  .replace(/^wss?:\/\//i, "https://");

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

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  remotePrisma?: PrismaClient;
};

function createPrisma(): PrismaClient {
  const log = process.env.NODE_ENV === "development" ? ["error", "warn"] as const : ["error"] as const;

  if (tursoUrl) {
    // Paketli masaüstü yolu: embedded replica'dan YEREL ve anında okuma.
    //
    // 0.19.124'te tüm sorguları uzak HTTP'ye çevirmek kilidi kaldırdı fakat çok
    // sorgulu ürün/model ekranlarını 8-10 saniyeye çıkardı. Doğru ayrım:
    //   - UI ve masaüstü işleri: yerel replica (milisaniyeler)
    //   - telefon relay'i gibi uzaktan taze olması gereken işler: remotePrisma
    //
    // KRİTİK: bu client'ta otomatik/periyodik sync YOK. Native sync() aynı dosyadaki
    // SQL'i bloke ettiği için arka plandan asla çağrılmaz.
    if (!useEmbeddedReplica) {
      const adapter = new PrismaLibSQL({
        url: remoteTursoUrl!,
        authToken: tursoToken || undefined,
      });
      return new PrismaClient({ adapter, log: [...log] });
    }

    // Paketli uygulamanın varsayılan hızlı yolu: embedded replica.
    const replicaPath =
      replicaPathFromEnv ||
      path.join(process.cwd(), "prisma", "turso-replica.db").replace(/\\/g, "/");
    // Not: readYourWrites native libsql'de zaten varsayılan true (kendi yazdığını
    // anında okur); @libsql/client Config tipinde olmadığı için burada geçilmiyor.
    // TEK client (EmbeddedReplicaPrismaLibSQL) — ayrı ön-senkron client'ı YOK.
    const adapter = new EmbeddedReplicaPrismaLibSQL({
      url: `file:${replicaPath}`,
      syncUrl: tursoUrl,
      authToken: tursoToken || undefined,
      // syncInterval KALDIRILDI: native otomatik periyodik sync, ağ değişince/kopunca askıda kalıp
      // SQL sorgularını bloke ediyordu (libSQL bilinen kısıt #979) → uygulama donuyordu.
      // Telefon relay'i ayrı remotePrisma kullandığı için bu replica oturum içinde sync edilmez.
    });
    return new PrismaClient({ adapter, log: [...log] });
  }

  // Local SQLite — klasik motor (DATABASE_URL üzerinden), adapter YOK
  return new PrismaClient({ log: [...log] });
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

// Aynı bağlantı tüm isteklerde yeniden kullanılsın
globalForPrisma.prisma = prisma;

/**
 * Telefon/yazıcı relay'i ve mobilde düzenlenebilen küçük tablolar için doğrudan
 * Turso bağlantısı. Yerel replica dosyasını kullanmadığından UI sorgularını
 * kilitleyemez. Turso yoksa aynı yerel Prisma client'ına düşer.
 */
function createRemotePrisma(): PrismaClient {
  if (!tursoUrl || !remoteTursoUrl) return prisma;
  const log =
    process.env.NODE_ENV === "development"
      ? (["error", "warn"] as const)
      : (["error"] as const);
  const adapter = new PrismaLibSQL({
    url: remoteTursoUrl,
    authToken: tursoToken || undefined,
  });
  return new PrismaClient({ adapter, log: [...log] });
}

export const remotePrisma =
  globalForPrisma.remotePrisma ?? createRemotePrisma();
globalForPrisma.remotePrisma = remotePrisma;
