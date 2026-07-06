/**
 * Next sunucu açılışında BİR KEZ çalışır (Node runtime). Telefon relay'ini başlatır:
 * masaüstü LAN'da yazıcı durumlarını Turso'ya yazar + telefondan gelen komutları uygular.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
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

  // DB warmup: ilk kullanıcı isteğinin SOĞUK gecikmesini (~2-3sn: Prisma engine init +
  // embedded replica bağlantısı/ilk sync) açılışta absorbe et ki ilk navigasyon ANINDA
  // gelsin. Non-blocking — hata önemsiz.
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
