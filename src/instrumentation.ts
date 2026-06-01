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
}
