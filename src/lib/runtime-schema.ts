import { prisma } from "@/lib/prisma";
import fs from "node:fs";
import path from "node:path";

let schemaReady: Promise<void> | null = null;

/**
 * Şema sürümü. Şema değiştiğinde ARTIR → tüm CREATE/ALTER bir kez daha çalışıp
 * damgayı günceller; aksi halde fast-path ile atlanır.
 */
// v19: Product.alias + Listing.barcode (0.19.15/0.19.16). v20: Product.madeToOrder (0.19.21).
// v21: Notification tablosu (0.19.30) — olay-anı bildirimleri (stoğu biten/sipariş-üzerine ürüne sipariş).
// v22: Product.imageManual (0.19.31) — elle seçilen/yüklenen görseli sync (Yenile) ezmesin.
// v25: ProductModelFile.r2Key — model dosyaları Cloudflare R2'de (çok-cihaz baskı, yerel disk boşaltma).
// v26: PushToken tablosu — baskı-bitti mobil push (Expo) bildirimleri.
// v27: Ayrılmış sürüm. Eski otomatik yerel-model temizliği kaldırıldı; yerel fallback kayıtları korunur.
// v28: ProductModelFile.colorsJson/sliced/plateJson — dosya meta bir kez parse edilip saklanır
//      (SlotStep'te R2 indirme + baskıda 3× senkron unzip donması biter).
// v29: ProductModelFile.thumbnail — dilimleyici önizleme görseli (Özel Baskılar arşivinde küçük görsel).
// v30: ProductModelFile.contentMd5 — içerik kimliği; yazıcıda "zaten var" tespiti (indirme/yükleme atlama).
// v31: CargoRule.vatIncluded — KDV hariç kargo tarifelerinde çift KDV düşümünü önler.
// v32: ActualExpense + OrderFinanceSnapshot — gerçek giderler ve kalıcı aylık finans geçmişi.
// v33: ManualOrder — ürünlü/serbest manuel sipariş ve versioned hesap snapshot'ı.
// v34: PlatformOrderFinancial + snapshot komisyon kaynağı — Trendyol gerçek komisyonu.
// v35: Ayrılmış sürüm; gerçek kargo faturası entegrasyonu geri alındı.
// v36: Geri alma damgası — v35 veritabanlarını standart CargoRule hesabıyla güvenle ileri taşır.
// v37: ⚠️ ÇAKIŞAN SÜRÜM — iki dal aynı numarayı FARKLI DDL için kullandı, ikisi de bu dosyada:
//      (a) OrderItemSnapshot — sipariş kalemlerinin kalıcı geçmişi (ürün bazlı satış tarihçesi);
//      (b) FilamentSpool.colorKey + openedAt — filament sekmesi "kapalı makara envanteri"ne geçti
//      (gruplama tür ailesi + renk tonu; uyarı gram değil KAPALI MAKARA SAYISI eşiğine bakıyor).
//      colorKey/openedAt NULLABLE olmalı: telefonun INSERT'ü kolonları elle sayıyor, NOT NULL
//      eklersek telefondan makara ekleme anında kırılır.
// v38: OrderFinanceSnapshot.outputVatKurus/inputVatCreditKurus — pazaryeri siparişlerinin KDV'si
//      artık kayıtlı; aylık KDV özeti yalnız manuel siparişleri kapsamaktan çıkar.
// v39: Birleştirme damgası — v37/v38 çakışmasını temizler. Fast-path damgayı TAM EŞİTLİKLE
//      karşılaştırdığı için sahada "37" ya da "38" damgalı bir veritabanı iki dalın DDL'ini
//      birden görmemiş olabilir; 39 her iki numaradan da büyük olduğundan tam tarama bir kez
//      daha koşar. CREATE IF NOT EXISTS + ensureColumn idempotent, tekrar zararsız.
// ⚠️ ensureColumn/CREATE değiştirince BURAYI ARTIR — yoksa fast-path migration'ı atlar,
//     yeni kolon eklenmez ve Prisma "no such column" ile TÜM sorguları patlatır.
const CURRENT_SCHEMA_VERSION = "39";

/** Açılış/perf ölçümünü userData/perf.log'a yaz (packaged app'te görünür). */
function logPerf(msg: string) {
  try {
    const settingsFile =
      process.env.TURSO_SETTINGS_FILE || process.env.SHOPIFY_SETTINGS_FILE;
    const dir = settingsFile ? path.dirname(settingsFile) : process.cwd();
    fs.appendFileSync(
      path.join(dir, "perf.log"),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  } catch {
    /* ignore */
  }
}

/** İşaretçi YALNIZ paketli uygulamada güvenilir: orada userData ayar dosyası vardır ve DB
 *  kalıcıdır. Test/dev'de ayar dosyası YOKSA işaretçi devre dışı → her zaman uzak kontrol +
 *  migrate. (Test DB'si koşular arası sıfırlanır; kalıcı bir işaretçi migration'ı yanlışlıkla
 *  atlatıp "tablo yok" hatalarına yol açardı.) */
function markerEnabled(): boolean {
  return Boolean(process.env.TURSO_SETTINGS_FILE || process.env.SHOPIFY_SETTINGS_FILE);
}

/** Ayar dizinindeki yerel şema işaretçisi. Bu cihazın kurulu sürümü hangi şemayı kurduğunu tutar. */
function schemaMarkerPath(): string {
  const settingsFile =
    process.env.TURSO_SETTINGS_FILE || process.env.SHOPIFY_SETTINGS_FILE;
  const dir = settingsFile ? path.dirname(settingsFile) : process.cwd();
  return path.join(dir, ".schema-version");
}

/** DB kimliği parmak izi — kullanıcı başka bir (boş) Turso'ya geçerse işaretçi EŞLEŞMESİN
 *  ve yeni DB migrate edilsin (aksi halde "aynı sürüm" sanılıp migration atlanırdı). */
function dbFingerprint(): string {
  const u =
    process.env.TURSO_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "local";
  let h = 0;
  for (let i = 0; i < u.length; i++) h = (Math.imul(h, 31) + u.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** İşaretçinin beklenen içeriği: şema sürümü + DB parmak izi. */
function expectedSchemaMarker(): string {
  return `${CURRENT_SCHEMA_VERSION}:${dbFingerprint()}`;
}

/** Yerel işaretçiyi oku (ağ YOK). Devre dışıysa (test/dev) veya yoksa null. */
function readLocalSchemaMarker(): string | null {
  if (!markerEnabled()) return null;
  try {
    return fs.readFileSync(schemaMarkerPath(), "utf8").trim();
  } catch {
    return null;
  }
}

function writeLocalSchemaMarker(): void {
  if (!markerEnabled()) return;
  try {
    fs.writeFileSync(schemaMarkerPath(), expectedSchemaMarker(), "utf8");
  } catch {
    /* ignore */
  }
}

/** Uzak schemaVersion damgasını oku. Tablo yoksa (yeni DB) null → tam kuruluma geç. */
async function readRemoteSchemaVersion(): Promise<string | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ value: string }>>(
      `SELECT value FROM AppSetting WHERE key = 'schemaVersion' LIMIT 1`
    );
    return rows?.[0]?.value ?? null;
  } catch {
    return null;
  }
}

// ── Migration kilidi ─────────────────────────────────────────────────────
// Next her rota bundle'ında modül örneği tekrar yüklenebildiğinden modül-içi
// `schemaReady` guard'ı bundle'lar (ve cihazlar) arası eşzamanlı kurulumu
// engellemez. AppSetting'te bir kilit satırı ile tam kurulumu SERİLEŞTİR:
// aynı anda yalnızca bir kurulum çalışır, diğerleri bekleyip fast-path'e düşer.
const SCHEMA_LOCK_KEY = "schemaMigrationLock";
const SCHEMA_LOCK_STALE_MS = 180_000; // 3 dk — en yavaş gözlenen kurulum (~68sn) üstünde güvenli pay
const SCHEMA_LOCK_HOLDER = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

/** Kilidi al. Yoksa/bayatsa alır ve true döner; başkası taze tutuyorsa false. */
async function acquireSchemaLock(): Promise<boolean> {
  try {
    const staleCutoff = new Date(Date.now() - SCHEMA_LOCK_STALE_MS).toISOString();
    const value = JSON.stringify({
      holder: SCHEMA_LOCK_HOLDER,
      at: new Date().toISOString(),
    });
    // Kilit yoksa ekle; varsa yalnızca BAYATSA devral (json_extract ISO string karşılaştırması).
    await prisma.$executeRawUnsafe(
      `INSERT INTO AppSetting (key, value) VALUES ('${SCHEMA_LOCK_KEY}', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE json_extract(AppSetting.value, '$.at') < ?`,
      value,
      staleCutoff
    );
    const rows = await prisma.$queryRawUnsafe<Array<{ value: string }>>(
      `SELECT value FROM AppSetting WHERE key = '${SCHEMA_LOCK_KEY}' LIMIT 1`
    );
    let held: string | null = null;
    try {
      held = rows?.[0]?.value ? JSON.parse(rows[0].value)?.holder : null;
    } catch {
      held = null;
    }
    return held === SCHEMA_LOCK_HOLDER;
  } catch {
    // AppSetting yok (yepyeni DB) → eşzamanlı kilitli kurulum olamaz; devam et.
    return true;
  }
}

/** Kilidi yalnızca biz tutuyorsak bırak. */
async function releaseSchemaLock(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM AppSetting WHERE key = '${SCHEMA_LOCK_KEY}'
       AND json_extract(value, '$.holder') = ?`,
      SCHEMA_LOCK_HOLDER
    );
  } catch {
    /* ignore */
  }
}

/** Başka kurulumun damgayı yazmasını bekle. Süre dolarsa false → çağıran devralır. */
async function waitForSchemaVersion(
  target: string,
  timeoutMs = 200_000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await readRemoteSchemaVersion()) === target) return true;
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

// ── DDL batch + şema snapshot ────────────────────────────────────────────
// Uzak-HTTP modunda her CREATE/ALTER/PRAGMA ayrı round-trip'ti (~100 CREATE +
// ~40 ensureColumn okuması → 30-68sn). Çözüm: (1) baştaki TEK introspection ile
// tüm tablo/kolonları snapshot'la (okuma round-trip'lerini keser), (2) CREATE/ALTER
// ifadelerini tamponla, bağımlılık checkpoint'lerinde TEK atomik libSQL batch ile
// gönder (yazma round-trip'lerini keser). Herhangi bir aşama başarısızsa buffer modu
// KAPANIR ve orijinal sıralı yol (prisma, canlı okuma) güvenle kullanılır.
let _bufferMode = false;
let _ddlBuf: string[] = [];
const _schemaTables = new Set<string>(); // var olan + bu turda oluşturulan tablolar (küçük harf)
const _schemaColumns = new Map<string, Set<string>>(); // tablo → kolonlar (küçük harf; CREATE + introspection)

type MiniBatchClient = {
  batch: (
    stmts: unknown[],
    mode?: string
  ) => Promise<Array<{ rows: Array<Record<string, unknown>> }>>;
};
let _batchClient: MiniBatchClient | null = null;
let _batchClientTried = false;

/** Uzak primary'ye doğrudan libSQL client (atomik batch). Yalnız uzak-HTTP modunda
 *  güvenli: embedded replica modunda ayrı client'ın yazdığını Prisma'nın yerel
 *  replica'sı görmez → o modda null → sequential fallback. */
async function getBatchClient(): Promise<MiniBatchClient | null> {
  if (_batchClientTried) return _batchClient;
  _batchClientTried = true;
  // Operasyonel güvenlik valfi: batch alanda beklenmedik davranırsa env ile kapatılır
  // → tampon sequential (prisma) gönderilir (yavaş ama kanıtlı).
  if (process.env.MLHUB_SCHEMA_NO_BATCH === "1") {
    _batchClient = null;
    return null;
  }
  try {
    const usingReplica =
      Boolean(process.env.TURSO_REPLICA_PATH?.trim()) &&
      process.env.TURSO_DISABLE_EMBEDDED_REPLICA?.trim() !== "1";
    const url = process.env.TURSO_DATABASE_URL?.trim();
    if (usingReplica || !url) {
      _batchClient = null;
      return null;
    }
    const remoteUrl = url
      .replace(/^libsql:\/\//i, "https://")
      .replace(/^wss?:\/\//i, "https://");
    const mod = await import("@libsql/client");
    _batchClient = mod.createClient({
      url: remoteUrl,
      authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined,
    }) as unknown as MiniBatchClient;
  } catch {
    _batchClient = null;
  }
  return _batchClient;
}

/** Baştaki tek introspection: tüm tablo + kolonları snapshot'la. Başarısızsa false
 *  (→ buffer modu açılmaz, orijinal canlı yol çalışır). */
async function loadSchemaSnapshot(): Promise<boolean> {
  _schemaTables.clear();
  _schemaColumns.clear();
  _ddlBuf = [];
  try {
    const tbls = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    );
    const client = await getBatchClient();
    if (client && tbls.length > 0) {
      const res = await client.batch(
        tbls.map((t) => `PRAGMA table_info("${t.name}")`),
        "read"
      );
      tbls.forEach((t, i) => {
        const lc = t.name.toLowerCase();
        _schemaTables.add(lc);
        const cols = new Set<string>();
        for (const row of res[i]?.rows ?? []) cols.add(String(row.name).toLowerCase());
        _schemaColumns.set(lc, cols);
      });
    } else {
      // Batch client yok → PRAGMA'ları sırayla oku (yine snapshot'la, yazmaları batch'le).
      for (const t of tbls) {
        const lc = t.name.toLowerCase();
        _schemaTables.add(lc);
        const cols = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
          `PRAGMA table_info("${t.name}")`
        );
        _schemaColumns.set(lc, new Set(cols.map((c) => c.name.toLowerCase())));
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Tamponu TEK atomik batch ile gönder; başarısızsa sequential (prisma) fallback. */
async function flushSchemaBuffer(): Promise<void> {
  if (_ddlBuf.length === 0) return;
  const stmts = _ddlBuf;
  _ddlBuf = [];
  const client = await getBatchClient();
  if (client) {
    try {
      await client.batch(stmts, "write"); // atomik: hata → rollback → fallback temiz
      return;
    } catch (e) {
      logPerf(`schema batch fallback (${String(e).slice(0, 100)})`);
    }
  }
  for (const st of stmts) {
    try {
      await prisma.$executeRawUnsafe(st);
    } catch (e) {
      // IF NOT EXISTS CREATE'ler idempotent; zaten eklenmiş kolon ALTER'ı "duplicate
      // column" verebilir — yalnız onu tolere et, gerçek hatayı yükselt.
      if (!/duplicate column|already exists/i.test(String(e))) throw e;
    }
  }
}

/** CREATE/ALTER tamponla (buffer modu). Buffer kapalıysa anında çalıştır (orijinal). */
async function bufDDL(sql: string): Promise<void> {
  if (!_bufferMode) {
    await prisma.$executeRawUnsafe(sql);
    return;
  }
  const s = sql.trim();
  _ddlBuf.push(s);
  const m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)/i.exec(s);
  if (m) {
    const lc = m[1].toLowerCase();
    // GERÇEKTEN yeni tablo (introspection'da yok). CREATE'in TANIMLADIĞI kolonları snapshot'a
    // ekle → ensureColumn bunları ATLAR (zaten var), ama CREATE'de OLMAYAN sonraki-sürüm
    // kolonlarını (madeToOrder/variantGroupId gibi) EKLER. Aksi halde fresh DB'de o kolonlar
    // hiç oluşmaz ve onlara index/sorgu patlar. Var olan tabloda CREATE ... IF NOT EXISTS
    // no-op'tur → snapshot introspection'dan gelen gerçek kolonlarda kalmalı (dokunma).
    if (!_schemaTables.has(lc)) {
      _schemaTables.add(lc);
      const cols = new Set<string>();
      const colRe = /"(\w+)"\s+(?:TEXT|INTEGER|REAL|BOOLEAN|DATETIME|BLOB|NUMERIC)/gi;
      let cm: RegExpExecArray | null;
      while ((cm = colRe.exec(s)) !== null) cols.add(cm[1].toLowerCase());
      _schemaColumns.set(lc, cols);
    }
  }
}

async function tableExists(tableName: string) {
  if (_bufferMode) return _schemaTables.has(tableName.toLowerCase());
  const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tableName
  );
  return tables.length > 0;
}

async function ensureColumn(tableName: string, columnName: string, definition: string) {
  if (_bufferMode) {
    const t = tableName.toLowerCase();
    const c = columnName.toLowerCase();
    if (!_schemaTables.has(t)) return; // tablo yok (orijinal: tableExists false → return)
    const cols = _schemaColumns.get(t);
    // Kolon zaten varsa (CREATE'de tanımlı VEYA introspection'da mevcut) ATLA; yoksa ALTER'la
    // ekle. Bu, hem var olan tabloya eksik kolon ekler hem fresh tabloda CREATE'de olmayan
    // sonraki-sürüm kolonlarını ekler.
    if (cols && cols.has(c)) return;
    _ddlBuf.push(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`);
    cols?.add(c); // snapshot'ı güncelle (sonraki ensureColumn/index kontrolleri için)
    return;
  }
  if (!(await tableExists(tableName))) return;

  const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `PRAGMA table_info("${tableName}")`
  );
  if (!columns.some((column) => column.name === columnName)) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`
    );
  }
}

/**
 * v0.5.1 migration: mevcut Trendyol source ürünler için otomatik Trendyol Listing oluştur.
 * Bir kez çalışır (AppSetting flag).
 */
async function migrateTrendyolProductsToListings() {
  if (!(await tableExists("Listing"))) return;
  if (!(await tableExists("Product"))) return;

  const migrationKey = "trendyolListingsMigratedAt";
  const existing = await prisma.appSetting.findUnique({ where: { key: migrationKey } });
  if (existing) return;

  // Trendyol source ürünleri al — listing'i olmayanlar için listing oluştur
  const products = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      source: string;
      currentSalePrice: number;
      listPrice: number | null;
      stock: number;
      trendyolId: string | null;
      sku: string;
      commissionRate: number | null;
    }>
  >(
    `SELECT p.id, p.source, p.currentSalePrice, p.listPrice, p.stock, p.trendyolId, p.sku, p.commissionRate
     FROM Product p
     WHERE p.source = 'trendyol'
       AND NOT EXISTS (SELECT 1 FROM Listing l WHERE l.productId = p.id AND l.platform = 'trendyol')`
  );

  for (const p of products) {
    const id = `listing_${p.id}_trendyol`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO Listing (id, productId, platform, externalId, externalSku, salePrice, listPrice, stock, commissionRate, isActive, createdAt, updatedAt)
       VALUES (?, ?, 'trendyol', ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      id,
      p.id,
      p.trendyolId,
      p.sku,
      p.currentSalePrice,
      p.listPrice,
      p.stock,
      p.commissionRate
    );
  }

  await prisma.appSetting.upsert({
    where: { key: migrationKey },
    create: { key: migrationKey, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
}

async function cleanupPdfCommissionRules() {
  if (!(await tableExists("CommissionRule"))) return;

  const cleanupKey = "cleanupPdfCommissionRulesAt";
  const existing = await prisma.appSetting.findUnique({ where: { key: cleanupKey } });
  if (existing) return;

  await prisma.commissionRule.deleteMany({
    where: {
      name: {
        startsWith: "Trendyol PDF - ",
      },
    },
  });

  await prisma.appSetting.upsert({
    where: { key: cleanupKey },
    create: { key: cleanupKey, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
}

/**
 * v0.14 migration: v0.13'teki parentProductId tabanlı varyant bağlarını VariantGroup'a taşı.
 * Her ana ürün (çocuğu olan) için bir grup oluşturulur; ana ürün + tüm çocukları o gruba bağlanır.
 * Hiçbir üye artık "ana" değil — hepsi eşit. Bir kez çalışır (AppSetting flag).
 */
async function migrateParentVariantsToGroups() {
  if (!(await tableExists("Product"))) return;
  if (!(await tableExists("VariantGroup"))) return;

  const flag = "variantGroupsMigratedAt";
  const existing = await prisma.appSetting.findUnique({ where: { key: flag } });
  if (existing) return;

  // Çocuğu olan (parent olarak referans verilen) ürünler
  const parents = await prisma.$queryRawUnsafe<Array<{ parentProductId: string }>>(
    `SELECT DISTINCT "parentProductId" FROM "Product" WHERE "parentProductId" IS NOT NULL`
  );

  for (const { parentProductId } of parents) {
    if (!parentProductId) continue;
    const prow = await prisma.$queryRawUnsafe<Array<{ name: string; variantGroupId: string | null }>>(
      `SELECT "name", "variantGroupId" FROM "Product" WHERE "id" = ? LIMIT 1`,
      parentProductId
    );
    if (!prow?.[0]) continue;
    if (prow[0].variantGroupId) continue; // zaten gruplu
    const groupId = `vg_${parentProductId}`;
    const groupName = prow[0].name || "Varyant Grubu";
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "VariantGroup" (id, name, createdAt, updatedAt)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      groupId,
      groupName
    );
    // Ana ürünü + tüm çocuklarını gruba bağla (hepsi eşit üye)
    await prisma.$executeRawUnsafe(
      `UPDATE "Product" SET "variantGroupId" = ? WHERE "id" = ? OR "parentProductId" = ?`,
      groupId,
      parentProductId,
      parentProductId
    );
  }

  await prisma.appSetting.upsert({
    where: { key: flag },
    create: { key: flag, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
}

export function ensureRuntimeSchema(): Promise<void> {
  if (schemaReady) return schemaReady;

  const attempt = (async () => {
    const __t0 = Date.now();
    // FAST-PATH #1 — YEREL İŞARETÇİ (ağ YOK): replica kapalı olduğundan her şema
    // kontrolü uzak HTTP round-trip'iydi (32 rota → açılışta birikmiş gecikme). Bu
    // cihaz zaten CURRENT sürüme migrate ettiyse yerel dosyadan anında dön.
    if (readLocalSchemaMarker() === expectedSchemaMarker()) {
      logPerf(`ensureRuntimeSchema FAST-PATH local (${Date.now() - __t0}ms)`);
      return;
    }
    // FAST-PATH #2 — UZAK DAMGA: işaretçi yok/eski (yeni kurulum veya güncelleme
    // sonrası) ama DB'yi başka bir cihaz/bundle zaten migrate etmiş olabilir. Bir
    // okumayla doğrula; güncelse işaretçiyi yaz (sonraki kontroller ağa gitmez).
    if ((await readRemoteSchemaVersion()) === CURRENT_SCHEMA_VERSION) {
      writeLocalSchemaMarker();
      logPerf(`ensureRuntimeSchema FAST-PATH remote (${Date.now() - __t0}ms)`);
      return;
    }

    // Gerçek migration gerekiyor → KİLİT al (bundle'lar/cihazlar arası serileştir).
    const gotLock = await acquireSchemaLock();
    if (!gotLock) {
      logPerf("ensureRuntimeSchema WAIT (başka kurulum sürüyor)");
      if (await waitForSchemaVersion(CURRENT_SCHEMA_VERSION)) {
        writeLocalSchemaMarker();
        logPerf(`ensureRuntimeSchema FAST-PATH after-wait (${Date.now() - __t0}ms)`);
        return;
      }
      // Süre doldu → kilit bu noktada bayat sayılır, devralıp kendimiz kuralım.
      // (Migration IF NOT EXISTS ile idempotent; en kötü ihtimalle bir kez daha çalışır.)
      await acquireSchemaLock();
    }

    // Buffer modu: baştaki tek introspection başarılıysa CREATE/ALTER tamponlanır ve
    // atomik batch'lerle gönderilir (30-68sn → ~2sn). Başarısızsa kapalı kalır →
    // aşağıdaki tüm ifadeler orijinal sıralı yolla (prisma) çalışır. Env valfi ile
    // tamamen kapatılabilir (orijinal ifade-ifade yol).
    _bufferMode =
      process.env.MLHUB_SCHEMA_NO_BUFFER === "1" ? false : await loadSchemaSnapshot();

    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "Product" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "barcode" TEXT NOT NULL,
        "sku" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "categoryName" TEXT NOT NULL,
        "currentSalePrice" REAL NOT NULL,
        "listPrice" REAL,
        "stock" INTEGER NOT NULL DEFAULT 0,
        "desi" REAL,
        "weight" REAL,
        "imageUrl" TEXT,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "source" TEXT NOT NULL DEFAULT 'manual',
        "trendyolId" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `);
    await bufDDL(`
      CREATE UNIQUE INDEX IF NOT EXISTS "Product_barcode_key" ON "Product"("barcode")
    `);
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "ProductCost" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "productId" TEXT NOT NULL,
        "costMode" TEXT NOT NULL DEFAULT 'manual',
        "templateId" TEXT,
        "filamentTypeId" TEXT,
        "filamentWeight" REAL,
        "printTimeHours" REAL,
        "wasteRate" REAL,
        "packagingPoset" REAL,
        "packagingNaylon" REAL,
        "packagingBant" REAL,
        "packagingKart" REAL,
        "manualCost" REAL,
        "materialWeight" REAL,
        "materialCost" REAL,
        "electricityCost" REAL,
        "machineWearCost" REAL,
        "laborCost" REAL,
        "packagingCost" REAL,
        "otherCost" REAL,
        "totalCost" REAL,
        "updatedAt" DATETIME NOT NULL
      )
    `);
    await bufDDL(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ProductCost_productId_key" ON "ProductCost"("productId")
    `);

    // FilamentType table
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "FilamentType" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "costPerGram" REAL NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true
      )
    `);

    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "AppSetting" (
        "key" TEXT NOT NULL PRIMARY KEY,
        "value" TEXT NOT NULL
      )
    `);

    // Kural / şablon / fiyat geçmişi tabloları — eskiden sadece bundled dev.db'de
    // vardı; boş Turso (bulut) DB'de de kurulabilmeleri için burada da yaratılır.
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "CommissionRule" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "categoryName" TEXT,
        "minPrice" REAL NOT NULL DEFAULT 0,
        "maxPrice" REAL NOT NULL DEFAULT 999999,
        "commissionRate" REAL NOT NULL,
        "fixedCommission" REAL NOT NULL DEFAULT 0,
        "validFrom" DATETIME,
        "validTo" DATETIME,
        "priority" INTEGER NOT NULL DEFAULT 10,
        "isActive" BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "CargoRule" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "platform" TEXT,
        "cargoProvider" TEXT,
        "categoryName" TEXT,
        "minPrice" REAL NOT NULL DEFAULT 0,
        "maxPrice" REAL NOT NULL DEFAULT 999999,
        "minDesi" REAL NOT NULL DEFAULT 0,
        "maxDesi" REAL NOT NULL DEFAULT 999,
        "cargoCost" REAL NOT NULL,
        "vatIncluded" BOOLEAN NOT NULL DEFAULT true,
        "validFrom" DATETIME,
        "validTo" DATETIME,
        "priority" INTEGER NOT NULL DEFAULT 10,
        "isActive" BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "ExpenseRule" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "platform" TEXT,
        "type" TEXT NOT NULL,
        "value" REAL NOT NULL,
        "categoryName" TEXT,
        "minPrice" REAL NOT NULL DEFAULT 0,
        "maxPrice" REAL NOT NULL DEFAULT 999999,
        "priority" INTEGER NOT NULL DEFAULT 10,
        "isActive" BOOLEAN NOT NULL DEFAULT true
      )
    `);
    // v32: Sipariş kurallarından bağımsız gerçek gider ödemeleri ve kalıcı sipariş finans geçmişi.
    // Para alanları kayan nokta hatalarını önlemek için INTEGER kuruş olarak saklanır.
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "ActualExpense" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "category" TEXT,
        "amountKurus" INTEGER NOT NULL,
        "paidAt" DATETIME NOT NULL,
        "note" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "ActualExpense_paidAt_idx" ON "ActualExpense"("paidAt")`
    );
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "OrderFinanceSnapshot" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "platform" TEXT NOT NULL,
        "externalOrderId" TEXT NOT NULL,
        "orderNumber" TEXT NOT NULL,
        "orderedAt" DATETIME NOT NULL,
        "revenueKurus" INTEGER NOT NULL,
        "profitKurus" INTEGER,
        "profitPartial" BOOLEAN NOT NULL DEFAULT false,
        "statusKind" TEXT NOT NULL,
        "currency" TEXT NOT NULL DEFAULT 'TRY',
        "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "calculationVersion" INTEGER NOT NULL DEFAULT 1,
        "profitSource" TEXT NOT NULL DEFAULT 'calculated',
        "estimatedCommissionKurus" INTEGER,
        "actualCommissionKurus" INTEGER,
        "outputVatKurus" INTEGER,
        "inputVatCreditKurus" INTEGER
      )
    `);
    await bufDDL(
      `CREATE UNIQUE INDEX IF NOT EXISTS "OrderFinanceSnapshot_platform_externalOrderId_key"
       ON "OrderFinanceSnapshot"("platform", "externalOrderId")`
    );
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "OrderFinanceSnapshot_orderedAt_idx"
       ON "OrderFinanceSnapshot"("orderedAt")`
    );
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "OrderFinanceSnapshot_statusKind_orderedAt_idx"
       ON "OrderFinanceSnapshot"("statusKind", "orderedAt")`
    );
    await ensureColumn(
      "OrderFinanceSnapshot",
      "profitSource",
      "TEXT NOT NULL DEFAULT 'calculated'"
    );
    await ensureColumn("OrderFinanceSnapshot", "estimatedCommissionKurus", "INTEGER");
    await ensureColumn("OrderFinanceSnapshot", "actualCommissionKurus", "INTEGER");
    // v38: KDV. Nullable ve VARSAYILANSIZ — eski satırlarda değer YOKTUR ve uydurulmaz.
    await ensureColumn("OrderFinanceSnapshot", "outputVatKurus", "INTEGER");
    await ensureColumn("OrderFinanceSnapshot", "inputVatCreditKurus", "INTEGER");
    // v37: Sipariş KALEMLERİ. Sipariş düzeyi özet "hangi üründen kaç adet sattık" sorusunu
    // yanıtlamıyordu ve platform penceresi (30-60 gün) dolunca o bilgi kalıcı olarak kayboluyordu.
    // Tekilleştirme (platform, externalOrderId, lineIndex) → aynı sipariş tekrar işlenince çoğalmaz.
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "OrderItemSnapshot" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "platform" TEXT NOT NULL,
        "externalOrderId" TEXT NOT NULL,
        "lineIndex" INTEGER NOT NULL,
        "orderedAt" DATETIME NOT NULL,
        "productId" TEXT,
        "productName" TEXT NOT NULL,
        "quantity" INTEGER NOT NULL,
        "unitPriceKurus" INTEGER NOT NULL,
        "lineRevenueKurus" INTEGER NOT NULL,
        "statusKind" TEXT NOT NULL,
        "currency" TEXT NOT NULL DEFAULT 'TRY',
        "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await bufDDL(
      `CREATE UNIQUE INDEX IF NOT EXISTS "OrderItemSnapshot_platform_externalOrderId_lineIndex_key"
       ON "OrderItemSnapshot"("platform", "externalOrderId", "lineIndex")`
    );
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "OrderItemSnapshot_orderedAt_idx"
       ON "OrderItemSnapshot"("orderedAt")`
    );
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "OrderItemSnapshot_productId_orderedAt_idx"
       ON "OrderItemSnapshot"("productId", "orderedAt")`
    );
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "OrderItemSnapshot_statusKind_orderedAt_idx"
       ON "OrderItemSnapshot"("statusKind", "orderedAt")`
    );
    // v34: Pazaryeri finans hareketi ana sipariş hattından ayrı senkronlanır. Böylece
    // Siparişler ekranı hiçbir zaman settlement API'sini beklemez.
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "PlatformOrderFinancial" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "platform" TEXT NOT NULL,
        "externalOrderId" TEXT NOT NULL,
        "orderNumber" TEXT NOT NULL,
        "grossRevenueKurus" INTEGER NOT NULL,
        "commissionKurus" INTEGER NOT NULL,
        "sellerRevenueKurus" INTEGER NOT NULL,
        "transactionCount" INTEGER NOT NULL DEFAULT 0,
        "sourceUpdatedAt" DATETIME,
        "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await bufDDL(
      `CREATE UNIQUE INDEX IF NOT EXISTS "PlatformOrderFinancial_platform_externalOrderId_key"
       ON "PlatformOrderFinancial"("platform", "externalOrderId")`
    );
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "PlatformOrderFinancial_platform_orderNumber_idx"
       ON "PlatformOrderFinancial"("platform", "orderNumber")`
    );
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "PlatformOrderFinancial_platform_syncedAt_idx"
       ON "PlatformOrderFinancial"("platform", "syncedAt")`
    );
    // v33: Manuel sipariş, kalem + hesap snapshot'ıyla tek atomik satırdır.
    // OrderFinanceSnapshot'a kopyalanmaz; aylık finans iki kaynağı çift saymadan birleştirir.
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "ManualOrder" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "orderNumber" TEXT NOT NULL,
        "mode" TEXT NOT NULL,
        "orderedAt" DATETIME NOT NULL,
        "statusKind" TEXT NOT NULL DEFAULT 'processing',
        "customerName" TEXT,
        "currency" TEXT NOT NULL DEFAULT 'TRY',
        "revenueKurus" INTEGER NOT NULL,
        "netRevenueKurus" INTEGER NOT NULL,
        "totalCostKurus" INTEGER NOT NULL,
        "inputVatCreditKurus" INTEGER NOT NULL,
        "profitKurus" INTEGER,
        "profitPartial" BOOLEAN NOT NULL DEFAULT false,
        "itemsJson" TEXT NOT NULL,
        "breakdownJson" TEXT NOT NULL,
        "calculationVersion" INTEGER NOT NULL DEFAULT 1,
        "note" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await bufDDL(
      `CREATE UNIQUE INDEX IF NOT EXISTS "ManualOrder_orderNumber_key"
       ON "ManualOrder"("orderNumber")`
    );
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "ManualOrder_orderedAt_idx"
       ON "ManualOrder"("orderedAt")`
    );
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "ManualOrder_statusKind_orderedAt_idx"
       ON "ManualOrder"("statusKind", "orderedAt")`
    );
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "CostTemplate" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "materialCostPerGram" REAL NOT NULL DEFAULT 0,
        "electricityCostPerHour" REAL NOT NULL DEFAULT 0,
        "machineWearCostPerHour" REAL NOT NULL DEFAULT 0,
        "defaultPackagingCost" REAL NOT NULL DEFAULT 0,
        "defaultLaborCost" REAL NOT NULL DEFAULT 0,
        "defaultOtherCost" REAL NOT NULL DEFAULT 0,
        "defaultWasteRate" REAL NOT NULL DEFAULT 0,
        "isActive" BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "PriceHistory" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "productId" TEXT NOT NULL,
        "oldPrice" REAL NOT NULL,
        "newPrice" REAL NOT NULL,
        "changeSource" TEXT NOT NULL,
        "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "note" TEXT
      )
    `);

    // Filament makara envanteri + kullanım kaydı (v0.12)
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "FilamentSpool" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "material" TEXT NOT NULL DEFAULT 'PLA',
        "colorName" TEXT,
        "colorHex" TEXT NOT NULL DEFAULT '#9ca3af',
        "brand" TEXT,
        "totalGrams" REAL NOT NULL DEFAULT 1000,
        "remainingGrams" REAL NOT NULL DEFAULT 1000,
        "spoolCost" REAL,
        "reorderGrams" REAL NOT NULL DEFAULT 200,
        "vendorUrl" TEXT,
        "colorKey" TEXT,
        "openedAt" DATETIME,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // v37: MEVCUT veritabanları için (CREATE TABLE IF NOT EXISTS onlara dokunmaz).
    // İkisi de NULLABLE — NOT NULL olsaydı varsayılan zorunlu olur ve telefonun elle yazılmış
    // INSERT kolon listesi yüzünden telefondan makara ekleme kırılırdı.
    await ensureColumn("FilamentSpool", "colorKey", "TEXT");
    await ensureColumn("FilamentSpool", "openedAt", "DATETIME");
    await bufDDL(`
      CREATE INDEX IF NOT EXISTS "FilamentSpool_material_colorKey_idx"
        ON "FilamentSpool"("material", "colorKey")
    `);
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "FilamentUsage" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "spoolId" TEXT NOT NULL,
        "productId" TEXT,
        "productName" TEXT,
        "grams" REAL NOT NULL,
        "note" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await bufDDL(`
      CREATE INDEX IF NOT EXISTS "FilamentUsage_spoolId_idx" ON "FilamentUsage"("spoolId")
    `);

    // Varyant grubu — aynı ürünün renk/boy seçeneklerini tek genel başlık altında toplar (v0.14)
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "VariantGroup" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Ensure new columns on existing tables
    await ensureColumn("Product", "trendyolId", "TEXT");
    await ensureColumn("Product", "source", "TEXT NOT NULL DEFAULT 'manual'");
    await ensureColumn("Product", "createdAt", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await ensureColumn("Product", "updatedAt", "DATETIME");
    await ensureColumn("Product", "desi", "REAL");
    await ensureColumn("Product", "weight", "REAL");
    await ensureColumn("Product", "listPrice", "REAL");
    await ensureColumn("Product", "isActive", "BOOLEAN NOT NULL DEFAULT true");
    await ensureColumn("Product", "imageUrl", "TEXT");
    await ensureColumn("Product", "commissionRate", "REAL");
    await ensureColumn("Product", "commissionSource", "TEXT");
    await ensureColumn("Product", "commissionUpdatedAt", "DATETIME");
    await ensureColumn("Product", "productMainId", "TEXT");
    await ensureColumn("Product", "hidden", "BOOLEAN NOT NULL DEFAULT false");
    await ensureColumn("Product", "parentProductId", "TEXT"); // legacy (v13) — migration kaynağı, artık kullanılmıyor
    await ensureColumn("Product", "variantLabel", "TEXT");
    await ensureColumn("Product", "alias", "TEXT");
    await ensureColumn("Product", "madeToOrder", "BOOLEAN NOT NULL DEFAULT false");
    await ensureColumn("Product", "imageManual", "BOOLEAN NOT NULL DEFAULT false");
    await ensureColumn("Product", "variantGroupId", "TEXT");
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "Product_variantGroupId_idx" ON "Product"("variantGroupId")`
    );
    // Varyant grubu model paylaşımı (v0.19.62): açıksa yüklenen dosya tüm varyantlara fan-out edilir.
    await ensureColumn("VariantGroup", "shareModels", "BOOLEAN NOT NULL DEFAULT false");

    // CargoRule platform alanı (Trendyol/Shopify ayrı baremi)
    await ensureColumn("CargoRule", "platform", "TEXT");
    await ensureColumn("CargoRule", "vatIncluded", "BOOLEAN NOT NULL DEFAULT true");
    // Eski kurallar (platform yok) Trendyol baremiydi — Shopify'a bulaşmasın diye
    // platform'u 'trendyol' olarak işaretle. platform dolu olanlar etkilenmez.
    // CHECKPOINT: canlı UPDATE, tamponlanan CargoRule.platform/vatIncluded ALTER'larına
    // bağımlı → önce tamponu boşalt (kolonlar primary'de var olsun).
    await flushSchemaBuffer();
    if (await tableExists("CargoRule")) {
      await prisma.$executeRawUnsafe(
        `UPDATE "CargoRule" SET "platform" = 'trendyol' WHERE "platform" IS NULL`
      );
      await prisma.$executeRawUnsafe(
        `UPDATE "CargoRule"
            SET "vatIncluded" = false
          WHERE ("cargoProvider" LIKE '%TEX%' OR "name" LIKE '%TEX%')`
      );
    }

    // ExpenseRule platform alanı. NOT: backfill YOK — null = tüm platformlar
    // (KDV gibi giderler her platforma uygulanır). Kullanıcı platform-spesifik
    // giderleri (Platform Hizmet Bedeli) manuel olarak Trendyol'a atar.
    await ensureColumn("ExpenseRule", "platform", "TEXT");

    // New ProductCost columns
    await ensureColumn("ProductCost", "filamentTypeId", "TEXT");
    await ensureColumn("ProductCost", "filamentWeight", "REAL");
    await ensureColumn("ProductCost", "printTimeHours", "REAL");
    await ensureColumn("ProductCost", "wasteRate", "REAL");
    await ensureColumn("ProductCost", "packagingPoset", "REAL");
    await ensureColumn("ProductCost", "packagingNaylon", "REAL");
    await ensureColumn("ProductCost", "packagingBant", "REAL");
    await ensureColumn("ProductCost", "packagingKart", "REAL");
    // Seçim bazlı paketleme (fiyat Maliyet Ayarları'ndan dinamik çekilir)
    await ensureColumn("ProductCost", "packagingOptionId", "TEXT");
    await ensureColumn("ProductCost", "nylonLevel", "TEXT");
    await ensureColumn("ProductCost", "tapeUsed", "BOOLEAN");

    // Listing tablosu — 3 platform için ayrı satış kaydı
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "Listing" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "productId" TEXT NOT NULL,
        "platform" TEXT NOT NULL,
        "externalId" TEXT,
        "externalSku" TEXT,
        "barcode" TEXT,
        "salePrice" REAL NOT NULL DEFAULT 0,
        "listPrice" REAL,
        "stock" INTEGER NOT NULL DEFAULT 0,
        "commissionRate" REAL,
        "commissionFixed" REAL,
        "cargoCost" REAL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "lastSyncedAt" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE
      )
    `);
    await bufDDL(`
      CREATE UNIQUE INDEX IF NOT EXISTS "Listing_productId_platform_key" ON "Listing"("productId", "platform")
    `);
    await bufDDL(`
      CREATE INDEX IF NOT EXISTS "Listing_platform_isActive_idx" ON "Listing"("platform", "isActive")
    `);
    await bufDDL(`
      CREATE INDEX IF NOT EXISTS "Listing_externalId_idx" ON "Listing"("externalId")
    `);
    await ensureColumn("Listing", "barcode", "TEXT");

    // UnmatchedListing — Shopify ana ürününe bağlanmamış Trendyol/HB ürünleri
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "UnmatchedListing" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "platform" TEXT NOT NULL,
        "externalId" TEXT,
        "externalSku" TEXT,
        "barcode" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "categoryName" TEXT,
        "price" REAL NOT NULL DEFAULT 0,
        "stock" INTEGER NOT NULL DEFAULT 0,
        "imageUrl" TEXT,
        "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await bufDDL(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UnmatchedListing_platform_externalId_key" ON "UnmatchedListing"("platform", "externalId")
    `);
    await bufDDL(`
      CREATE INDEX IF NOT EXISTS "UnmatchedListing_platform_barcode_idx" ON "UnmatchedListing"("platform", "barcode")
    `);

    // 3D yazıcı bağlantıları (v0.15) — Moonraker (Elegoo/Snapmaker) + Bambu
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "PrinterConfig" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "brand" TEXT NOT NULL,
        "model" TEXT,
        "type" TEXT NOT NULL DEFAULT 'moonraker',
        "host" TEXT NOT NULL,
        "port" INTEGER NOT NULL DEFAULT 7125,
        "accent" TEXT,
        "accessCode" TEXT,
        "serial" TEXT,
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "sortOrder" INTEGER NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "PrintFileProduct" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "printerConfigId" TEXT NOT NULL,
        "filename" TEXT NOT NULL,
        "productId" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await bufDDL(
      `CREATE UNIQUE INDEX IF NOT EXISTS "PrintFileProduct_printerConfigId_filename_key" ON "PrintFileProduct"("printerConfigId", "filename")`
    );
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "PrintFileProduct_productId_idx" ON "PrintFileProduct"("productId")`
    );

    // Ürün baskı modelleri (v0.16) — ürün+yazıcı başına dilimlenmiş dosyalar (v0.17: çoklu parça)
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "ProductModelFile" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "productId" TEXT NOT NULL,
        "printerConfigId" TEXT NOT NULL,
        "label" TEXT,
        "originalName" TEXT NOT NULL,
        "storedPath" TEXT NOT NULL,
        "fileType" TEXT NOT NULL,
        "sizeBytes" INTEGER NOT NULL DEFAULT 0,
        "gramaj" REAL,
        "estPrintMin" INTEGER,
        "sortOrder" INTEGER NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // v0.17: çoklu parça → eski (product+printer) TEKİL index'ini kaldır + yeni kolonlar
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "ProductModelFile_productId_printerConfigId_key"`);
    await ensureColumn("ProductModelFile", "label", "TEXT");
    await ensureColumn("ProductModelFile", "sortOrder", "INTEGER NOT NULL DEFAULT 0");
    await ensureColumn("ProductModelFile", "r2Key", "TEXT"); // v25: Cloudflare R2 nesne anahtarı
    // v28: dosya metası bir kez parse edilip saklanır (SlotStep R2 indirmesi + baskıda senkron unzip biter)
    await ensureColumn("ProductModelFile", "colorsJson", "TEXT");
    await ensureColumn("ProductModelFile", "sliced", "BOOLEAN");
    await ensureColumn("ProductModelFile", "plateJson", "TEXT");
    // v29: dilimleyici önizleme görseli (Özel Baskılar arşivi)
    await ensureColumn("ProductModelFile", "thumbnail", "TEXT");
    await ensureColumn("ProductModelFile", "contentMd5", "TEXT"); // v30: içerik kimliği (reuse)
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "ProductModelFile_productId_printerConfigId_idx" ON "ProductModelFile"("productId", "printerConfigId")`
    );
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "ProductModelFile_printerConfigId_idx" ON "ProductModelFile"("printerConfigId")`
    );

    // Telefon relay'i (v0.17) — yazıcı durum snapshot'ı + uzaktan komut kuyruğu
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "PrinterSnapshot" (
        "printerConfigId" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "brand" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "online" BOOLEAN NOT NULL DEFAULT false,
        "productName" TEXT,
        "productImage" TEXT,
        "progress" REAL NOT NULL DEFAULT 0,
        "nozzle" INTEGER NOT NULL DEFAULT 0,
        "bed" INTEGER NOT NULL DEFAULT 0,
        "currentFilename" TEXT,
        "etaSec" INTEGER,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // v23: baskı bitti/hata bildirimi için hata-nedeni kolonu (mevcut kurulumlara)
    await ensureColumn("PrinterSnapshot", "statusMessage", "TEXT");
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "PrintCommand" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "printerConfigId" TEXT NOT NULL,
        "action" TEXT NOT NULL,
        "modelFileId" TEXT,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "error" TEXT,
        "source" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "processedAt" DATETIME
      )
    `);
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "PrintCommand_status_idx" ON "PrintCommand"("status")`
    );

    // Kalıcı bildirimler (v21) — olay-anı uyarıları (stoğu biten/sipariş-üzerine ürüne sipariş).
    // id = tekilleştirme anahtarı (createMany skipDuplicates ile tekrar yazılmaz).
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "Notification" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "type" TEXT NOT NULL,
        "severity" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "body" TEXT NOT NULL,
        "href" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "acknowledgedAt" DATETIME
      )
    `);
    await bufDDL(
      `CREATE INDEX IF NOT EXISTS "Notification_acknowledgedAt_idx" ON "Notification"("acknowledgedAt")`
    );

    // v26: Expo push token'ları (mobil yazar, masaüstü relay'i baskı bitince push gönderir)
    await bufDDL(`
      CREATE TABLE IF NOT EXISTS "PushToken" (
        "token" TEXT NOT NULL PRIMARY KEY,
        "platform" TEXT NOT NULL DEFAULT '',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // CHECKPOINT: kalan tampon (CargoRule sonrası CREATE/ALTER'lar) primary'ye yazılsın,
    // sonra buffer modunu KAPAT → guarded migration'lar + sürüm damgası canlı prisma ile.
    await flushSchemaBuffer();
    _bufferMode = false;

    await cleanupPdfCommissionRules();
    await migrateTrendyolProductsToListings();
    await migrateParentVariantsToGroups();

    // Şema sürümünü damgala → sonraki açılışlar fast-path'ten anında döner.
    // MONOTONİK: depodaki damga sayısal olarak DAHA BÜYÜKSE üzerine yazma. Kullanıcının Windows'u
    // ve Mac'i AYNI bulut veritabanını kullanıyor; biri v37'ye geçip diğeri v36'da kalırsa damga
    // sürekli ileri-geri yazılır ve İKİ makine de her açılışta tam şema taraması + kilit beklemesi
    // yapar (veri bozulmaz, ama açılış yavaşlar). Bu koşulla yalnız geride kalan makine yeniden
    // göç koşar; güncel makine fast-path'te kalır.
    await prisma.$executeRawUnsafe(
      `INSERT INTO AppSetting (key, value) VALUES ('schemaVersion', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE CAST(excluded.value AS INTEGER) >= CAST(AppSetting.value AS INTEGER)`,
      CURRENT_SCHEMA_VERSION
    );
    // Yerel işaretçiyi yaz → bu cihazda sonraki kontroller ağa hiç gitmez.
    writeLocalSchemaMarker();
    // Kilidi bırak (biz tuttuysak). Hata olursa kilit bayatlayıp devralınır.
    await releaseSchemaLock();
    logPerf(`ensureRuntimeSchema FULL setup (${Date.now() - __t0}ms)`);
  })();

  schemaReady = attempt;
  // İlk deneme geçici ağ/DB hatasıyla reddedilirse aynı rejected Promise'i süreç boyunca
  // zehirli halde tutma. Eşitlik kontrolü, daha yeni concurrent denemeyi yanlışlıkla silmez.
  void attempt.catch(() => {
    if (schemaReady === attempt) schemaReady = null;
    // Kurulum yarıda hata verdiyse kilidi bırak (yalnızca bizim tuttuğumuz silinir).
    void releaseSchemaLock();
  });
  return attempt;
}
