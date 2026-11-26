import { Prisma } from "@/generated/prisma/client";
import { prisma, remotePrisma } from "./prisma";
import { ensureRuntimeSchema } from "./runtime-schema";
import { parseDbDate } from "./sqlite-date";
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

// ── Yedeğin kapsamı: TEK KAYNAK Prisma şeması ───────────────────────────────
//
// NEDEN (23 Kas 2026 denetimi, madde 19): yedek, şemaya sonradan eklenen tabloları (gider
// kategorileri, sabit giderler, reklam bütçesi) ve onlarca kolonu (KDV, gerçek kesintiler, kargo,
// iade zararı, mesh…) hiç taşımıyordu; geri yükleme de tanımadığı alanları atıyordu. Artık:
//  - Her Prisma modeli ya `BACKUP_TABLES`'ta ya da gerekçesiyle `BACKUP_EXCLUDED_MODELS`'tadır.
//    Yeni model eklenip ikisine de yazılmazsa `yedek-gidis-donus.test.ts` KIRILIR.
//  - Kolon listesi Prisma'nın ürettiği alan listesinden okunur (`backupColumns`); şemaya eklenen
//    yeni kolon hem dışa hem içe aktarmaya KENDİLİĞİNDEN girer. Bilinçli dışlanan kolonlar
//    `BACKUP_EXCLUDED_FIELDS`'ta gerekçesiyle durur.

/**
 * Yedek gövdesinin biçim sürümü.
 *  3: eski biçim (gider tabloları ve sonradan eklenen kolonlar yok).
 *  4 (23 Kas 2026): şemanın tamamı + `schemaVersion` alanı.
 * Geri yükleme bundan BÜYÜK sürümü reddeder, küçüğünü uyarıyla alır.
 */
export const BACKUP_FORMAT_VERSION = 4;

/** Yedeğe giren modeller → yedek gövdesindeki anahtarları (anahtarlar eski yedeklerle uyumlu kalır). */
export const BACKUP_TABLES = {
  VariantGroup: "variantGroups",
  Product: "products",
  ProductCost: "productCosts",
  Listing: "listings",
  FilamentType: "filamentTypes",
  FilamentSpool: "filamentSpools",
  FilamentUsage: "filamentUsages",
  AppSetting: "appSettings",
  CommissionRule: "commissionRules",
  CargoRule: "cargoRules",
  AdBudget: "adBudgets",
  ExpenseRule: "expenseRules",
  ActualExpense: "actualExpenses",
  RecurringExpense: "recurringExpenses",
  RecurringExpenseSkip: "recurringExpenseSkips",
  ExpenseCategory: "expenseCategories",
  OrderFinanceSnapshot: "orderFinanceSnapshots",
  PlatformOrderFinancial: "platformOrderFinancials",
  ManualOrder: "manualOrders",
  PriceHistory: "priceHistory",
  PrinterConfig: "printerConfigs",
  PrintFileProduct: "printFileProducts",
  ProductModelFile: "productModelFiles",
  OrderItemSnapshot: "orderItemSnapshots",
  OrderLineCost: "orderLineCosts",
  OrderLineLink: "orderLineLinks",
  OrderCargoDesi: "orderCargoDesis",
  CargoShipment: "cargoShipments",
} as const satisfies Partial<Record<Prisma.ModelName, string>>;

export type BackupModel = keyof typeof BACKUP_TABLES;

/** BİLİNÇLİ olarak yedeğe girmeyen modeller ve gerekçeleri. */
export const BACKUP_EXCLUDED_MODELS = {
  UnmatchedListing: "Pazaryerinden her senkronda yeniden çekilir; eşleştirilenler zaten Listing'e taşınır.",
  ProductModelFileThumb: "Önizleme görseli productModelFiles[].thumbnail içinde taşınır.",
  PrinterSnapshot: "Yazıcının anlık canlı durumu; masaüstü sürekli yeniden yazar.",
  LabelPrintRequest: "Kargo etiketi baskı kuyruğu (geçici iş kaydı).",
  IntegrationSecret: "Pazaryeri ve kargo giriş bilgileri: yedek dosyasına şifre düşmesin; her bilgisayardaki yerel kopyadan yeniden oluşur.",
  PrinterStatusSample: "Yazıcı doluluk örnekleri; 30 günden eskileri zaten silinir.",
  PrinterCamera: "Telefonun anlık kamera isteği.",
  PrintCommand: "Telefondan gelen anlık baskı komutu kuyruğu.",
  Notification: "Anlık bildirim kaydı.",
  PushToken: "Cihaza özel bildirim kimliği; başka kurulumda anlamsız ve gizli tutulmalı.",
  PrepDone: "Günlük paketleme 'hazırlandı' işaretleri (geçici).",
} as const satisfies Partial<Record<Prisma.ModelName, string>>;

/** BİLİNÇLİ olarak gidiş-dönüşte korunmayan kolonlar ve gerekçeleri. */
export const BACKUP_EXCLUDED_FIELDS: Partial<Record<BackupModel, Readonly<Record<string, string>>>> = {
  ProductModelFile: {
    storedPath:
      "Bu bilgisayardaki mutlak dosya yolu: başka cihazda geçersiz ve kullanıcı klasörünü ifşa eder. Yedekte boş yazılır, geri yüklemede yeni kayda boş girer.",
  },
};

/**
 * Ham SQL ile okunan tabloların tarih kolonları. Ham sonuçta tarih, depolama biçimine göre
 * sayı ya da metin gelir; gövdeye her zaman ISO metin olarak yazılsın diye burada çevrilir.
 * (Gidiş-dönüş testi bu listeyi şemadaki DateTime alanlarıyla karşılaştırır.)
 */
export const RAW_DATE_COLUMNS = {
  OrderItemSnapshot: ["orderedAt", "syncedAt"],
} as const satisfies Partial<Record<BackupModel, readonly string[]>>;

/** Modelin Prisma skaler alanları (üretilmiş istemciden — şema değişince kendiliğinden güncellenir). */
export function modelColumns(model: Prisma.ModelName): string[] {
  const fields = (Prisma as unknown as Record<string, Record<string, string> | undefined>)[
    `${model}ScalarFieldEnum`
  ];
  if (!fields) throw new Error(`Prisma alan listesi bulunamadı: ${model}`);
  return Object.values(fields);
}

const kolonOnbellegi = new Map<BackupModel, readonly string[]>();

/** Yedeğin taşıdığı ve geri yüklemenin yazdığı kolonlar (bilinçli dışlananlar hariç). */
export function backupColumns(model: BackupModel): readonly string[] {
  let kolonlar = kolonOnbellegi.get(model);
  if (!kolonlar) {
    const excluded = BACKUP_EXCLUDED_FIELDS[model] ?? {};
    kolonlar = modelColumns(model).filter((column) => !(column in excluded));
    kolonOnbellegi.set(model, kolonlar);
  }
  return kolonlar;
}

// ── Sürüm denetimi ───────────────────────────────────────────────────────────

export const YEDEK_DAHA_YENI_HATASI = "Bu yedek daha yeni bir sürümden. Önce uygulamayı güncelle.";
export const YEDEK_ESKI_UYARISI =
  "Bu yedek eski bir sürümden; yedekte olmayan bilgiler olduğu gibi bırakıldı.";

/** Ayar satırlarındaki şema damgası (`schemaVersion`) → sayı; yoksa/bozuksa null. */
export function settingsSchemaVersion(
  settings: ReadonlyArray<{ key: string; value: string }> | undefined
): number | null {
  const raw = settings?.find((setting) => setting.key === "schemaVersion")?.value;
  const value = Number(raw);
  return raw != null && Number.isInteger(value) && value > 0 ? value : null;
}

export interface BackupVersionInfo {
  version?: number | null;
  schemaVersion?: number | null;
  appSettings?: ReadonlyArray<{ key: string; value: string }>;
}

/**
 * Ham (henüz doğrulanmamış) yedek gövdesinden sürüm bilgisini okur. Biçim doğrulamasından ÖNCE
 * çağrılır: daha yeni bir sürümün yedeği "biçim geçersiz" yerine anlaşılır bir mesajla reddedilsin.
 */
export function backupVersionInfo(raw: unknown): BackupVersionInfo {
  if (!raw || typeof raw !== "object") return {};
  const body = raw as Record<string, unknown>;
  const sayi = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const appSettings = Array.isArray(body.appSettings)
    ? body.appSettings.filter(
        (setting): setting is { key: string; value: string } =>
          !!setting &&
          typeof setting === "object" &&
          typeof (setting as { key?: unknown }).key === "string" &&
          typeof (setting as { value?: unknown }).value === "string"
      )
    : undefined;
  return { version: sayi(body.version), schemaVersion: sayi(body.schemaVersion), appSettings };
}

/**
 * Yedek bu uygulamaya göre "yeni" (reddedilir), "eski" (uyarıyla alınır) ya da "uyumlu" mu?
 *  - Biçim sürümü bizimkinden büyükse ya da şema damgası bu veritabanınınkinden büyükse → yeni.
 *    Böyle bir yedekte bu sürümün tanımadığı alanlar olur; sessizce düşmesinler.
 *  - Biçim sürümü yoksa ya da küçükse → eski: yedekte bulunmayan alanlara dokunulmaz.
 * `appSchemaVersion` bilinmiyorsa (damga okunamadı) şema karşılaştırması atlanır.
 */
export function backupVersionVerdict(
  backup: BackupVersionInfo,
  appSchemaVersion: number | null
): "yeni" | "eski" | "uyumlu" {
  const format = backup.version ?? null;
  const schema = backup.schemaVersion ?? settingsSchemaVersion(backup.appSettings);
  if (format != null && format > BACKUP_FORMAT_VERSION) return "yeni";
  if (schema != null && appSchemaVersion != null && schema > appSchemaVersion) return "yeni";
  if (format == null || format < BACKUP_FORMAT_VERSION) return "eski";
  return "uyumlu";
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
    adBudgets,
    expenseRules,
    actualExpenses,
    recurringExpenses,
    recurringExpenseSkips,
    expenseCategories,
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
    orderCargoDesis,
    cargoShipments,
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
    q(() => prisma.adBudget.findMany()),
    q(() => prisma.expenseRule.findMany()),
    q(() => remotePrisma.actualExpense.findMany()),
    // Gider tabloları telefondan da yazılıyor → ActualExpense gibi uzak istemciden okunur.
    q(() => remotePrisma.recurringExpense.findMany()),
    q(() => remotePrisma.recurringExpenseSkip.findMany()),
    q(() => remotePrisma.expenseCategory.findMany()),
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
    // Kolonlar elle yazılmaz, Prisma alan listesinden gelir: elle yazılmış liste komisyon oranı /
    // KDV / kargoya verme süresini dışarıda bırakıyordu.
    q(() => satisGecmisiniOku()),
    // Siparişe özel maliyetler (kullanıcının elle girdiği) — yedeğe girmezse geri yükleme onları siler.
    q(() => prisma.orderLineCost.findMany()),
    // Elle ürün bağları ("Ürüne bağla") — yedeğe girmezse geri yükleme eski siparişleri yeniden koparır.
    q(() => prisma.orderLineLink.findMany()),
    // Elle girilen Shopify kargo desileri — yedeğe girmezse geri yüklemede kargo yeniden ürün desilerinden hesaplanır.
    q(() => prisma.orderCargoDesi.findMany()),
    // Uygulamadan açılan kargo gönderileri — yedeğe girmezse geri yüklemede sipariş ↔ barkod bağı kaybolur.
    q(() => prisma.cargoShipment.findMany()),
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
    version: BACKUP_FORMAT_VERSION,
    // Yedeği üreten veritabanının şema sürümü: geri yükleme daha yeni şemalı yedeği reddeder.
    schemaVersion: settingsSchemaVersion(rawAppSettings),
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
    adBudgets,
    expenseRules,
    actualExpenses,
    recurringExpenses,
    recurringExpenseSkips,
    expenseCategories,
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
    orderCargoDesis,
    cargoShipments,
  };
}

/**
 * Satış geçmişi ham SQL ile okunur (diğer tüm okuyucuları da ham SQL; tarih kolonları karışık
 * biçimde yazılmış olabilir). Kolon listesi Prisma alanlarından gelir; tarihler depolama
 * biçiminden bağımsız olarak ISO metne çevrilir ki gövde her tabloda aynı biçimi taşısın.
 */
async function satisGecmisiniOku(): Promise<Array<Record<string, unknown>>> {
  const kolonlar = backupColumns("OrderItemSnapshot");
  const satirlar = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${kolonlar.map((k) => `"${k}"`).join(", ")}
       FROM "OrderItemSnapshot"
      WHERE "platform" <> 'manual'`
  );
  return (satirlar ?? []).map((satir) => {
    const kopya: Record<string, unknown> = { ...satir };
    for (const kolon of RAW_DATE_COLUMNS.OrderItemSnapshot) {
      if (kopya[kolon] != null) kopya[kolon] = parseDbDate(kopya[kolon]) ?? kopya[kolon];
    }
    return kopya;
  });
}

export type BackupPayload = Awaited<ReturnType<typeof buildBackupPayload>>;
