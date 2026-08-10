/**
 * Next sunucu açılışında BİR KEZ çalışır (Node runtime). Arka plan işlerini başlatır:
 * telefon relay'i (yazıcı durumları + telefondan gelen komutlar), sipariş izleyici ve
 * günlük otomatik yedek.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.MLHUB_DISABLE_BACKGROUND_TASKS !== "1") {
    try {
      const { startPrinterRelay } = await import("./core/printers/relay");
      startPrinterRelay();
    } catch (e) {
      console.error("[instrumentation] yazıcı relay başlatılamadı:", e);
    }

    // Sipariş izleyici: bildirimler sayfa ziyareti beklemeden periyodik doğar (t+90sn, sonra 5dk'da bir)
    // + Siparişler önbelleği hep sıcak kalır + bildirim tablosu budanır.
    try {
      const { startOrderWatch } = await import("./lib/order-watch");
      startOrderWatch();
    } catch (e) {
      console.error("[instrumentation] sipariş izleyici başlatılamadı:", e);
    }

    // Günlük otomatik yedek: bulut verisinden taşınabilir JSON üretip kullanıcı klasörüne yazar.
    // Açılışta hemen çalışmaz; gecikmeli başlar ve günde bir kez yeter.
    try {
      const { startBackupJob } = await import("./lib/backup-job");
      startBackupJob();
    } catch (e) {
      console.error("[instrumentation] günlük yedek başlatılamadı:", e);
    }
  }

  // DB warmup: ilk uzak HTTP bağlantısını açılışta başlat. Kalıcı SWR cache varsa ekran
  // verisi hemen döner ve tazeleme arka planda sürer. Non-blocking.
  void (async () => {
    try {
      const { ensureRuntimeSchema } = await import("./lib/runtime-schema");
      const { prisma } = await import("./lib/prisma");
      await ensureRuntimeSchema();
      await prisma.$queryRawUnsafe("SELECT 1");
    } catch {
      /* warmup hatası kullanıcıyı etkilemez */
    }
  })();
}
