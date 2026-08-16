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
 *   • Ham SQL ile tarih YAZAN her yol  → `toDbDate()` (hazır SQL metninde `nowDbDateSql()`)
 *   • Ham SQL ile tarih OKUYAN her yol → `parseDbDate()`
 *   • Ham SQL'de karşılaştırma/sıralama/MIN/MAX → kolonu `dbEpochMs()` ile normalize et
 *   • "Kanonik mi?" ve "nasıl onarılır?" → `canonicalDateSql()` / `repairDateColumnSql()`
 *
 * ⚠️ BİÇİM BİLGİSİ YALNIZ BURADA DURUR. Onarım ifadesinin bir kopyası bir süre
 * `runtime-schema.ts`'te yaşadı ve iki taraf ayrışınca kolonlar her göçte "bozuk" bulunup
 * hiçbir satıra dokunulmadan "onarıldı" raporlandı. Yeni bir biçim dalı eklerken bu dosya
 * dışına çıkma.
 */

/** Aktif Prisma motorunun tarih yazma biçimi. */
export type DbDateStorage = "iso-text" | "epoch-ms";

/**
 * ⚠️ BU DOSYA ARTIK PAYLAŞILIYOR (src/core → `npm run sync-core` → mobile/src/core).
 *
 * Sebep: telefon da aynı kolonları ham SQL ile okuyor. Biçim bilgisi iki yerde yaşarsa
 * kaçınılmaz olarak ayrışır — nitekim ayrıştı: mobil reklam payı sorgusu `orderedAt`'i SAYI
 * ile karşılaştırıyordu, kolon METİN olduğu için (SQLite'ta tamsayı < metin) koşul hiçbir
 * satırı tutmadı, ciro 0 çıktı ve telefon reklam payını HER ZAMAN 0 hesapladı → her ürün ve
 * her sipariş masaüstünden daha kârlı göründü.
 *
 * MOBİLDE KULLANIM: motor tespiti `process.env` okur; React Native'de o değişken YOKTUR ve
 * varsayılan yanlış tarafa ("epoch-ms") düşer. Bu yüzden telefon açılışta bir kez
 * `setDbDateStorage("iso-text")` çağırır (mobile/src/lib/turso.ts). Karşılaştırma/sıralama
 * yapan sorgular zaten `dbEpochMs()` ile biçimden bağımsızdır — yeni sorgularda ONU kullan.
 */
let storageOverride: DbDateStorage | null = null;

/** Motor tespitini elle sabitle (mobil: "iso-text"). null → otomatik tespite dön. */
export function setDbDateStorage(storage: DbDateStorage | null): void {
  storageOverride = storage;
}

/** SQL kimlik alıntısı — kolon/tablo adları daima kod içinde sabittir (kullanıcı girdisi DEĞİL). */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "")}"`;
}

/**
 * Bu süreçte Prisma hangi biçimi yazıyor?
 *
 * Karar `src/lib/prisma.ts` ile AYNI koşuldur (TURSO_DATABASE_URL varsa libSQL adapter,
 * yoksa klasik motor). İkisi birlikte değişmelidir.
 */
export function dbDateStorage(): DbDateStorage {
  if (storageOverride) return storageOverride; // mobil bunu açılışta sabitler
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
 * "Şimdi" için KANONİK biçimde değer üreten SQL ifadesi — `CURRENT_TIMESTAMP` yerine.
 *
 * ⚠️ NEDEN: SQLite'ın `CURRENT_TIMESTAMP` değeri `2026-08-13 07:00:00` biçimindedir (boşluklu,
 * milisaniyesiz). Prisma ise aynı kolona `2026-08-13T07:00:00.000+00:00` yazar. Metin
 * sıralamasında boşluk (0x20) 'T'den (0x54) küçük olduğu için karışık kolonda `ORDER BY` ve
 * `>= '…T…'` filtreleri sessizce yanlış sonuç verir — zil bildirimleri en dibe düşmüştü.
 * Açılış göçü bu kolonları tek biçime çekiyor; ONU BOZMAMAK için yazan her yol bunu kullanır.
 *
 * Parametre bağlamanın mümkün olduğu yerde `toDbDate(new Date())` tercih edilir; bu ifade
 * çok satırlı/hazır SQL metinlerinde (senkron INSERT/UPDATE'leri) argüman sırasını
 * bozmadan aynı sonucu verir.
 */
export function nowDbDateSql(storage: DbDateStorage = dbDateStorage()): string {
  return storage === "iso-text"
    ? `(strftime('%Y-%m-%dT%H:%M:%f','now') || '+00:00')`
    : `(CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER))`;
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
  const quoted = quoteIdentifier(column);
  return (
    `(CASE WHEN typeof(${quoted}) IN ('integer','real') ` +
    `THEN CAST(${quoted} AS INTEGER) ` +
    `ELSE CAST(ROUND((julianday(${quoted}) - 2440587.5) * 86400000.0) AS INTEGER) END)`
  );
}

/**
 * "Bu damga KANONİK mi?" SQL koşulu — aktif motorun yazdığı biçim.
 *
 * iso-text : `2026-08-13T07:00:00.000+00:00`
 * epoch-ms : tamsayı (klasik yerel motorun yazdığı biçim)
 *
 * ⚠️ "Tamsayı mı metin mi" sorusu YETMEZ: metin içinde de iki ayrı biçim dolaşıyor
 * (SQLite `CURRENT_TIMESTAMP` → `2026-08-13 07:00:00`, Prisma → `…T07:00:00.000+00:00`).
 * Metin sıralamasında boşluk (0x20) 'T'den (0x54) küçüktür, yani karışık kolonda
 * `>= '2026-08-01T…'` filtresi boşluklu satırların HEPSİNİ sessizce eler.
 * ÖLÇÜLDÜ (canlı Turso): 8 kolonda 2.922 satır tam bu durumdaydı.
 *
 * ⚠️ MİLİSANİYE ŞART: `2026-08-01T00:00:00+00:00` (milisaniyesiz) de 'T' içerir ve '+00:00'
 * ile biter, yani eski koşula göre KANONİK sayılıp onarımdan muaf kalıyordu. Oysa metin
 * sıralamasında '+' (0x2B) < '.' (0x2E): `>= '2026-08-01T00:00:00.000+00:00'` filtresi ay
 * sınırına tam denk gelen böyle bir satırı SESSİZCE eler. Bu yüzden koşul kesirli saniyeyi
 * (üç hane) arar — `LIKE '%.___+00:00'` içindeki `_` tek karakter demektir.
 */
export function canonicalDateSql(
  column: string,
  storage: DbDateStorage = dbDateStorage()
): string {
  const c = quoteIdentifier(column);
  return storage === "iso-text"
    ? `typeof(${c}) = 'text' AND instr(${c}, 'T') > 0 AND ${c} LIKE '%.___+00:00'`
    : `typeof(${c}) IN ('integer','real')`;
}

/**
 * Kolonun ŞU ANKİ değerini kanonik biçime çeviren SQL ifadesi. Çözülemeyen değerde NULL verir
 * — onarım bu NULL'a bakarak satıra hiç dokunmaz.
 *
 * iso-text dalı İKİ kaynağı birden kapsar:
 *   • TAMSAYI/REAL epoch-ms  → `2026-08-13T07:00:00.000+00:00`
 *   • YABANCI BİÇİMLİ METİN  → aynı hedefe iner:
 *       `2026-08-13 07:00:00`           (SQLite CURRENT_TIMESTAMP)
 *       `2026-08-13T07:00:00.251Z`      (mobil)
 *       `2026-08-13T07:00:00Z`          (milisaniyesiz)
 *       `2026-08-13T10:00:00.000+03:00` (ofsetli → UTC'ye çevrilir, AN korunur)
 *       `2026-08-13T07:00:00.000`       (ofsetsiz = UTC)
 *
 * Sondaki 'Z' kırpılır. ⚠️ Sebep AYRIŞTIRMA DEĞİL — gerçek libSQL'de ölçüldü (SQLite 3.45):
 * `julianday('…T07:00:00.000Z')` ile `…+00:00` ve boşluklu biçim BİREBİR aynı sonucu verir,
 * yani 'Z' ekli damgalar okuma tarafındaki filtrelerden düşmüyor. Kırpma yalnız ÇIKTIYI
 * tekleştirmek içindir: her dal '+00:00' ile bitsin, kolonda tek bir metin biçimi kalsın.
 * '+03:00' gibi bir ofset olduğu gibi verilir, SQLite değeri UTC'ye çevirir.
 *
 * Salt sayıdan oluşan METİN bilerek dışarıda ('-' şartı): SQLite onu Julian GÜN SAYISI sanıp
 * anlamsız bir tarih üretir — yanlış tarih yazmaktansa satır olduğu gibi bırakılır.
 *
 * Her dal `%f` üretir: milisaniyesiz bir çıktı (`…T00:00:00+00:00`) kanonik SAYILIR ama metin
 * sıralamasında '+' (0x2B) < '.' (0x2E) olduğu için ay sınırı filtresinden DÜŞERDİ — onarım
 * kapatmaya çalıştığı hatayı kendi çıktısında üretirdi.
 */
function canonicalDateValueSql(column: string, storage: DbDateStorage): string {
  const c = quoteIdentifier(column);
  if (storage !== "iso-text") {
    return `CAST(ROUND((julianday(${c}) - 2440587.5) * 86400000.0) AS INTEGER)`;
  }
  const zsiz = `CASE WHEN ${c} LIKE '%Z' THEN substr(${c}, 1, length(${c}) - 1) ELSE ${c} END`;
  return (
    `CASE WHEN typeof(${c}) IN ('integer','real') ` +
    `THEN strftime('%Y-%m-%dT%H:%M:%f', ${c} / 1000.0, 'unixepoch') || '+00:00' ` +
    `WHEN typeof(${c}) = 'text' AND instr(${c}, '-') > 0 ` +
    `THEN strftime('%Y-%m-%dT%H:%M:%f', ${zsiz}) || '+00:00' END`
  );
}

/**
 * Onarım SQL'i: kolondaki YABANCI biçimli damgaları aktif motorun kanonik biçimine çevirir.
 *
 * iso-text modunda TEK ifade hem TAMSAYI→ISO hem METİN→METİN durumunu kapsar; biçim bilgisi
 * bu dosyada tek yerde durur (`canonicalDateSql` + `canonicalDateValueSql`).
 *
 * Idempotent — çıktı 'T' içerir ve '+00:00' ile biter, yani ikinci turda kanonik sayılıp
 * eşleşmez. Çözülemeyen değerlere DOKUNMAZ (aksi hâlde NULL yazıp NOT NULL kolonu bozar ya da
 * veriyi kaybederdik).
 */
export function repairDateColumnSql(
  table: string,
  column: string,
  storage: DbDateStorage = dbDateStorage()
): string {
  const t = quoteIdentifier(table);
  const c = quoteIdentifier(column);
  const kanonik = canonicalDateValueSql(column, storage);
  if (storage === "iso-text") {
    return (
      `UPDATE ${t} SET ${c} = ${kanonik} ` +
      `WHERE ${c} IS NOT NULL ` +
      `AND NOT (${canonicalDateSql(column, storage)}) ` +
      `AND (${kanonik}) IS NOT NULL`
    );
  }
  // ⚠️ `instr('-')` koruması iso-text dalındakiyle AYNI sebeple burada da şart: SQLite salt
  // sayıdan oluşan bir metni ("1784109600000") Julian GÜN SAYISI sanıp ayrıştırır, julianday
  // NULL dönmez ve satır anlamsız bir damgaya çevrilerek KALICI olarak bozulurdu.
  return (
    `UPDATE ${t} SET ${c} = ${kanonik} ` +
    `WHERE typeof(${c}) = 'text' AND instr(${c}, '-') > 0 AND julianday(${c}) IS NOT NULL`
  );
}
