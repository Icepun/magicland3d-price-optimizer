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

    // Telefondan kargo etiketi: telefonun isteğini etiket yazıcısı bağlı bu bilgisayar basar.
    try {
      const { startEtiketIstekleri } = await import("./lib/etiket/telefon-istekleri");
      startEtiketIstekleri();
    } catch (e) {
      console.error("[instrumentation] etiket istekleri başlatılamadı:", e);
    }

    // Ağır sayfaların (Raporlar, Panel, Ürünler) sunucu önbelleği boşsa açılıştan kısa süre sonra
    // sırayla doldurulur — güncellemeden sonraki ilk ziyaret 4 sn beklemesin.
    try {
      const { startRouteWarmup } = await import("./lib/route-warmup");
      startRouteWarmup();
    } catch (e) {
      console.error("[instrumentation] önbellek ısıtma başlatılamadı:", e);
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
    // Önizleme görseli tabloda son kolon mu? (bkz. lib/buyuk-kolon-sonda.ts) Açılış telaşı
    // geçtikten sonra, kimseyi bekletmeden. Normalde tek hafif sorgu; hata yutulur.
    setTimeout(() => {
      // Önce görseller kendi tablosuna (v63, bkz. lib/model-gorseli.ts) — eski kolonda bir şey
      // yoksa tek hafif sayım. Sonra kolon sırası bakımı.
      void import("./lib/model-gorseli-bakimi")
        .then((m) => m.modelGorseliBakimi())
        .catch(() => {})
        .then(() => import("./lib/buyuk-kolon-bakimi"))
        .then((m) => m.buyukKolonBakimi())
        .catch(() => {});
      // 3 dk: açılış telaşı (şema, sipariş taraması t+90 sn, ısıtma) bittikten sonra.
    }, 180_000);
  })();
}
