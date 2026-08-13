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
    q(() => prisma.productModelFile.findMany()),
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
  };
}

export type BackupPayload = Awaited<ReturnType<typeof buildBackupPayload>>;
