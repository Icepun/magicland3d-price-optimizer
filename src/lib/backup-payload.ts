import { prisma, remotePrisma } from "./prisma";
import { ensureRuntimeSchema } from "./runtime-schema";
import packageJson from "../../package.json";

/**
 * Taşınabilir yedek gövdesini üreten TEK kaynak.
 *
 * NEDEN ayrı dosya: aynı gövdeyi hem "Dışa aktar" indirmesi (/api/data/export) hem de
 * günlük otomatik yedek işi (backup-job) üretiyor. İkisi kopyalanırsa biri diğerinden
 * sapar ve yedeğin içeriği hangi yoldan alındığına göre değişir.
 *
 * NEDEN gizli anahtar filtresi: gövde AppSetting satırlarını olduğu gibi taşıyordu, yani
 * bulut depolama kimlik bilgileri düz metin olarak yedeğe giriyordu. Yedek dosyası
 * (e-posta/USB/paylaşılan klasör) dışarı çıktığında bulut depo ele geçiyordu. Bu anahtarlar
 * artık gövdeye HİÇ konmuyor. Geri yükleme tarafı yalnız gelen anahtarları upsert ettiği
 * için eksik olmaları hiçbir şeyi bozmaz — mevcut kurulumdaki değerler yerinde kalır.
 */

/** Yedeğe asla girmeyecek ayar anahtarları (bulut depo kimliği — r2.ts KEYS'in gizli olanları). */
export const SECRET_SETTING_KEYS = ["r2AccessKeyId", "r2SecretKey"] as const;

/**
 * İleride eklenecek anahtarların da otomatik elenmesi için ad kalıbı.
 * Kasıtlı olarak dar tutuldu: sadece "key" geçen her ayarı elemek (ör. r2Bucket/r2AccountId
 * gibi zararsız yapılandırma) yedeği gereksiz yere eksiltirdi.
 */
const SECRET_KEY_PATTERN =
  /(secret|token|password|credential|apikey|api_key|accesskeyid|privatekey|passphrase)/i;

/** Bu ayar anahtarı gizli mi? (yedeğe yazılmaz) */
export function isSecretSettingKey(key: string): boolean {
  if ((SECRET_SETTING_KEYS as readonly string[]).includes(key)) return true;
  return SECRET_KEY_PATTERN.test(key);
}

export interface BuildBackupOptions {
  /**
   * true ise tablolar TEK TEK okunur. Uzak-HTTP modunda tüm sorgular süreç genelinde tek
   * kilitten geçtiği için, hepsini aynı anda kuyruğa atmak arada gelen kullanıcı isteğini
   * ~20 sorgu boyu bekletir. Arka plan yedeği bunu yapmamalı; kullanıcının başlattığı
   * indirme ise mümkün olan en kısa sürede bitmeli (varsayılan davranış korunur).
   */
  sequential?: boolean;
}

/** Sıralı modda okumaları uç uca zincirler; normal modda hepsini birlikte başlatır. */
function makeRunner(sequential: boolean) {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    if (!sequential) return fn();
    const next = chain.then(fn);
    // Zincir bir hatada kopmasın; hata çağırana aynen iletilir.
    chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };
}

/** Önizleme görselleri bu kadarlık parçalarla okunur (~20 × 38 KB ≈ 0,8 MB / istek). */
const GORSEL_PARCA = 20;

/**
 * Model dosyası kayıtları — İÇERİK AYNI, okuma PARÇALI.
 *
 * NEDEN (19 Kas 2026 denetimi): tablo tek sorguda okunuyordu; içinde 647 önizleme görseli var
 * (24 MB). Tek istek yavaş ağda saniyelerce sürüyor ve o sırada aynı şeritteki her sorgu
 * bekliyordu. Şimdi önce görselsiz kolonlar (küçük), sonra görseller 20'şerlik parçalarla, arka
 * plan şeridinden okunur; parçalar arasında başka sorgular araya girebilir.
 */
export async function modelDosyalariniOku() {
  const satirlar = await remotePrisma.productModelFile.findMany();
  const gorseller = new Map<string, string>();
  // Görseller kendi tablosunda (v63, bkz. lib/model-gorseli.ts). Kimlikler PK dizininden gelir.
  const yeni = (
    await remotePrisma.$queryRawUnsafe<Array<{ fileId: string }>>(`SELECT "fileId" FROM "ProductModelFileThumb"`)
  ).map((r) => String(r.fileId));
  for (let i = 0; i < yeni.length; i += GORSEL_PARCA) {
    const dilim = yeni.slice(i, i + GORSEL_PARCA);
    const parca = await remotePrisma.$queryRawUnsafe<Array<{ fileId: string; thumbnail: string }>>(
      `SELECT "fileId", "thumbnail" FROM "ProductModelFileThumb" WHERE "fileId" IN (${dilim.map(() => "?").join(",")})`,
      ...dilim
    );
    for (const g of parca) gorseller.set(String(g.fileId), g.thumbnail);
  }
  // Taşıma henüz koşmadıysa görsel eski kolonda kalmış olabilir. `typeof()` içeriği OKUMAZ.
  const eski = (
    await remotePrisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "ProductModelFile" WHERE typeof("thumbnail") = 'text'`
    )
  )
    .map((r) => String(r.id))
    .filter((id) => !gorseller.has(id));
  for (let i = 0; i < eski.length; i += GORSEL_PARCA) {
    const dilim = eski.slice(i, i + GORSEL_PARCA);
    const parca = await remotePrisma.$queryRawUnsafe<Array<{ id: string; thumbnail: string | null }>>(
      `SELECT "id", "thumbnail" FROM "ProductModelFile" WHERE "id" IN (${dilim.map(() => "?").join(",")})`,
      ...dilim
    );
    for (const g of parca) if (g.thumbnail) gorseller.set(String(g.id), g.thumbnail);
  }
  return satirlar.map((satir) => ({ ...satir, thumbnail: gorseller.get(satir.id) ?? null }));
}

/**
 * Uygulamanın taşınabilir verisini tek bir JSON gövdesi olarak üretir.
 * Fiziksel yerel model dosyaları gövdeye gömülmez; R2 kayıtlarında yalnız uzaktaki
 * nesne anahtarı, yerel kayıtlarda ise dosya içermeyen metadata dışa aktarılır.
 */
export async function buildBackupPayload(options: BuildBackupOptions = {}) {
  await ensureRuntimeSchema();
  const q = makeRunner(options.sequential === true);

  const [
    variantGroups,
    products,
    productCosts,
    listings,
    filamentTypes,
    filamentSpools,
    filamentUsages,
    rawAppSettings,
    commissionRules,
    cargoRules,
    expenseRules,
    actualExpenses,
    orderFinanceSnapshots,
    platformOrderFinancials,
    manualOrders,
    priceHistory,
    printerConfigs,
    printFileProducts,
    rawProductModelFiles,
    orderItemSnapshots,
    orderLineCosts,
    orderLineLinks,
  ] = await Promise.all([
    q(() => prisma.variantGroup.findMany()),
    q(() => prisma.product.findMany()),
    q(() => prisma.productCost.findMany()),
    q(() => prisma.listing.findMany()),
    q(() => prisma.filamentType.findMany()),
    q(() => prisma.filamentSpool.findMany()),
    q(() => prisma.filamentUsage.findMany()),
    q(() => prisma.appSetting.findMany()),
    q(() => prisma.commissionRule.findMany()),
    q(() => prisma.cargoRule.findMany()),
    q(() => prisma.expenseRule.findMany()),
    q(() => remotePrisma.actualExpense.findMany()),
    // Manual orders are their own captured finance source. Exporting a second
    // "manual" platform snapshot would make older backups easy to double-count.
    q(() =>
      prisma.orderFinanceSnapshot.findMany({
        where: { platform: { not: "manual" } },
      })
    ),
    q(() => prisma.platformOrderFinancial.findMany()),
    q(() => remotePrisma.manualOrder.findMany()),
    q(() => prisma.priceHistory.findMany()),
    q(() => prisma.printerConfig.findMany()),
    q(() => prisma.printFileProduct.findMany()),
    q(() => modelDosyalariniOku()),
    // Ürün bazlı satış geçmişi. Yedeğe girmezse geri yükleme onu KALICI olarak siler ve
    // Üretim Planı'ndaki satış hızı / ölü stok boşalır (geri getirilemez).
    q(() =>
      prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT "id","platform","externalOrderId","lineIndex","orderedAt","productId",
                "productName","quantity","unitPriceKurus","lineRevenueKurus","statusKind","currency"
           FROM "OrderItemSnapshot"
          WHERE "platform" <> 'manual'`
      )
    ),
    // Siparişe özel maliyetler (kullanıcının elle girdiği) — yedeğe girmezse geri yükleme onları siler.
    q(() => prisma.orderLineCost.findMany()),
    // Elle ürün bağları ("Ürüne bağla") — yedeğe girmezse geri yükleme eski siparişleri yeniden koparır.
    q(() => prisma.orderLineLink.findMany()),
  ]);

  const excludedSettingKeys = rawAppSettings
    .filter((setting: { key: string }) => isSecretSettingKey(setting.key))
    .map((setting: { key: string }) => setting.key);
  const appSettings = rawAppSettings.filter(
    (setting: { key: string }) => !isSecretSettingKey(setting.key)
  );

  const localModelFileCount = rawProductModelFiles.filter((file) => !file.r2Key).length;
  const productModelFiles = rawProductModelFiles.map((file) => ({
    ...file,
    // Mutlak yerel yollar başka cihaza taşınabilir değildir ve kullanıcı dizinini ifşa eder.
    storedPath: "",
    storageKind: file.r2Key ? "r2-reference" : "local-metadata-only",
    fileBytesIncluded: false,
  }));
  const warnings: string[] = [];
  if (localModelFileCount > 0) {
    warnings.push(
      `${localModelFileCount} yerel model kaydı yalnız metadata içerir; dosya baytları olmadan başka cihazda geri yüklenemez.`
    );
  }
  if (excludedSettingKeys.length > 0) {
    warnings.push("Bulut depolama şifreleri güvenlik için yedeğe konmadı; gerekirse Ayarlar'dan yeniden girin.");
  }

  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    appVersion: packageJson.version,
    metadata: {
      format: "magicland-portable-backup",
      localModelFileBytesIncluded: false,
      localModelFilePathsIncluded: false,
      localModelFileMetadataCount: localModelFileCount,
      r2ModelReferenceCount: rawProductModelFiles.length - localModelFileCount,
      secretSettingsExcluded: true,
      excludedSettingKeys,
      notes: ["Model dosyalarının fiziksel baytları taşınabilir JSON yedeğine dahil değildir."],
      warnings,
    },
    variantGroups,
    products,
    productCosts,
    listings,
    filamentTypes,
    filamentSpools,
    filamentUsages,
    appSettings,
    commissionRules,
    cargoRules,
    expenseRules,
    actualExpenses,
    orderFinanceSnapshots,
    platformOrderFinancials,
    manualOrders,
    priceHistory,
    printerConfigs,
    printFileProducts,
    productModelFiles,
    orderItemSnapshots,
    orderLineCosts,
    orderLineLinks,
  };
}

export type BackupPayload = Awaited<ReturnType<typeof buildBackupPayload>>;
