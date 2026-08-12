/**
 * Tarih kolonlarının TEK kanonik depolama biçimi.
 *
 * ⚠️ ÖLÇÜLDÜ (regresyon testi: `src/lib/mixed-date-storage.test.ts`):
 * Prisma DateTime alanlarını hangi biçimde yazdığı **çalıştığı motora** bağlıdır:
 *
 *   • libSQL driver adapter (Turso — paketli uygulamanın ve telefonun yolu)
 *       → ISO-8601 METİN:  "2026-07-15T10:00:00.000+00:00"
 *       → filtreler de METİN bağlanır
 *   • klasik yerel SQLite motoru (`DATABASE_URL=file:…`, adapter yok)
 *       → epoch-ms TAMSAYI: 1784109600000
 *       → filtreler de TAMSAYI bağlanır
 *
 * SQLite dinamik tiplidir: aynı kolona ikisi de yazılabilir ve SQLite'ta **TAMSAYI her
 * zaman METİN'den küçüktür**. Karışık depolamada:
 *   • `WHERE "orderedAt" >= <tarih>` → uyumsuz tipteki satırların TAMAMI sessizce düşer,
 *   • `ORDER BY "orderedAt"`         → önce tüm tamsayılar, sonra tüm metinler gelir,
 *     yani "en eski kayıt" yanlış çıkar.
 * Hata verilmez; rapor yalnızca eksilir. Sahada tam olarak bu oldu: masaüstünün ham SQL
 * yazımı tamsayı, telefon ve Prisma metin yazıyordu → Raporlar 359 siparişin ~280'ini
 * hiç okumadı.
 *
 * KURAL
 *   • Ham SQL ile tarih YAZAN her yol  → `toDbDate()`
 *   • Ham SQL ile tarih OKUYAN her yol → `parseDbDate()`
 *   • Ham SQL'de karşılaştırma/sıralama/MIN/MAX → kolonu `dbEpochMs()` ile normalize et
 */

/** Aktif Prisma motorunun tarih yazma biçimi. */
export type DbDateStorage = "iso-text" | "epoch-ms";

/**
 * Bu süreçte Prisma hangi biçimi yazıyor?
 *
 * Karar `src/lib/prisma.ts` ile AYNI koşuldur (TURSO_DATABASE_URL varsa libSQL adapter,
 * yoksa klasik motor). İkisi birlikte değişmelidir.
 */
export function dbDateStorage(): DbDateStorage {
  return process.env.TURSO_DATABASE_URL?.trim() ? "iso-text" : "epoch-ms";
}

/**
 * Ham SQL'e bağlanacak tarih değeri — Prisma'nın aynı kolona yazacağı değerle BİREBİR aynı.
 * ISO biçiminde sondaki `Z` değil `+00:00` kullanılır; Prisma'nın ürettiği metin budur ve
 * birebir aynı biçim, milisaniyesi eşit iki damgada bile sıralamayı tutarlı tutar.
 */
export function toDbDate(value: Date, storage: DbDateStorage = dbDateStorage()): string | number {
  return storage === "iso-text"
    ? value.toISOString().replace(/Z$/, "+00:00")
    : value.getTime();
}

/**
 * Ham sorgudan gelen tarihi çöz. Depolama tipi ne olursa olsun (ISO metin, epoch-ms
 * tamsayı, epoch-saniye, sayısal metin, sürücünün döndürdüğü `Date`) doğru anı verir;
 * çözülemezse null.
 */
export function parseDbDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;

  let numeric: number | null = null;
  if (typeof value === "bigint") numeric = Number(value);
  else if (typeof value === "number") numeric = value;
  else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    numeric = Number(value.trim());
  }

  if (numeric != null) {
    if (!Number.isFinite(numeric)) return null;
    // Saniye mi milisaniye mi? 1e11 ms = 1973; bu uygulamadaki her damga saniye cinsinden
    // bu eşiğin altında, milisaniye cinsinden üstünde kalır.
    const ms = Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  // "YYYY-MM-DD HH:MM:SS" (SQLite CURRENT_TIMESTAMP biçimi) UTC'dir; JS onu yerel saat
  // sanmasın diye açıkça işaretlenir.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Bir tarih kolonunu depolama tipinden BAĞIMSIZ olarak epoch-ms'e çeviren SQL ifadesi.
 * Karşılaştırma (`>= ?`), sıralama ve MIN/MAX için kullanılır — karışık tipli bir tabloda
 * bile hiçbir satır düşmez.
 *
 * `column` daima kod içinde yazılmış sabit bir kolon adıdır (kullanıcı girdisi DEĞİL).
 */
export function dbEpochMs(column: string): string {
  const quoted = `"${column.replace(/"/g, "")}"`;
  return (
    `(CASE WHEN typeof(${quoted}) IN ('integer','real') ` +
    `THEN CAST(${quoted} AS INTEGER) ` +
    `ELSE CAST(ROUND((julianday(${quoted}) - 2440587.5) * 86400000.0) AS INTEGER) END)`
  );
}

/**
 * Onarım SQL'i: kolondaki YABANCI biçimli damgaları aktif motorun kanonik biçimine çevirir.
 *
 * Idempotent — ikinci çalıştırmada eşleşen satır kalmaz. Çözülemeyen metinlere DOKUNMAZ
 * (aksi hâlde NULL yazıp NOT NULL kolonu bozar ya da veriyi kaybederdik).
 */
export function repairDateColumnSql(
  table: string,
  column: string,
  storage: DbDateStorage = dbDateStorage()
): string {
  const t = `"${table.replace(/"/g, "")}"`;
  const c = `"${column.replace(/"/g, "")}"`;
  if (storage === "iso-text") {
    return (
      `UPDATE ${t} SET ${c} = strftime('%Y-%m-%dT%H:%M:%f', ${c} / 1000.0, 'unixepoch') || '+00:00' ` +
      `WHERE typeof(${c}) IN ('integer','real') ` +
      `AND strftime('%Y-%m-%dT%H:%M:%f', ${c} / 1000.0, 'unixepoch') IS NOT NULL`
    );
  }
  return (
    `UPDATE ${t} SET ${c} = CAST(ROUND((julianday(${c}) - 2440587.5) * 86400000.0) AS INTEGER) ` +
    `WHERE typeof(${c}) = 'text' AND julianday(${c}) IS NOT NULL`
  );
}
