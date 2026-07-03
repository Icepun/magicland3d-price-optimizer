/**
 * Replica sağlık yoklaması — FEDA EDİLEBİLİR alt süreç (main.js utilityProcess.fork ile çağırır).
 *
 * Neden ayrı süreç: bozuk turso-replica.db'de libsql'in native sync/yazma çağrısı SONSUZA DEK
 * takılır (kanıt: sample → index.node → __psynch_cvwait) ve JS timeout'ları işlemez (event loop
 * bloke). Takılmayı ancak DIŞARIDAN süreç öldürerek tespit edebiliriz: main.js 20 sn'de yanıt
 * gelmezse bizi öldürür ve replica'yı sıfırlar (bir kerelik taze tam senkron). Aylardır süren
 * "Mac'te açılıştan 3 sn sonra sonsuz donma" döngüsünün kalıcı fix'i.
 *
 * Yoklama replica'nın KOPYASI üzerinde yapılır (main.js kopyalar): gerçek dosyaya ikinci bir
 * sync client dokundurmak, Prisma'nın client'ıyla "wal_index" çakışması yaratabiliyor (0.9.14
 * regresyonunun dersi). Bozuk durum kopyada da aynen takılıyor (test matrisiyle doğrulandı).
 *
 * Çıkış kodları: 0 = sağlıklı · 42 = libsql hatası (replica sorunlu → sıfırla) ·
 * diğer/zaman aşımı = main.js yorumlar (zaman aşımı → sıfırla; modül arızası → fail-open).
 */
const [, , dbPath] = process.argv;

(async () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require("@libsql/client");
    const c = createClient({
      url: `file:${dbPath}`,
      syncUrl: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    });
    // Takılan operasyonlar sırasıyla denenir (SELECT çalışsa bile sync/yazma takılabiliyor —
    // bozuk-db teşhisinde okumalar geçip yazma/sync'in asıldığı birebir gözlendi).
    await c.execute("SELECT 1");
    await c.sync();
    await c.execute("CREATE TABLE IF NOT EXISTS _replica_probe (x INTEGER)");
    process.exit(0);
  } catch (e) {
    console.error("[replica-probe]", e && e.message ? e.message : e);
    process.exit(42);
  }
})();
