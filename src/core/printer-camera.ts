/**
 * TELEFONDAN KAMERA — telefon ile masaüstü arasındaki sözleşme (`PrinterCamera` tablosu).
 *
 * Telefon yazıcıya ulaşamaz (LAN). Akış:
 *   1) Telefon kamera ekranı açıkken `wantedUntilMs`'i ileri yazar ve düzenli tazeler.
 *   2) LAN'daki masaüstü (src/core/printers/camera-relay.ts) isteği görür, satırı SAHİPLENİR,
 *      kameradan gelen kareyi R2'ye koyup imzalı okuma adresini `frameUrl`'e yazar.
 *   3) Telefon satırı okuyup görseli o adresten çeker. Ekran kapanınca istek süresi dolar,
 *      masaüstü kamerayı bırakır (kamera ancak biri izlerken açık kalır).
 *
 * İki uç da bu dosyadaki SQL'i kullanır — `npm run sync-core` ile telefona kopyalanır ve testler
 * aynı dizeleri gerçek libSQL'de koşturur (dize içindeki SQL'i tsc/eslint göremez).
 *
 * Zamanlar EPOCH-MS SAYI: tarih metni/sayı karışıklığı (bkz. sqlite-date.ts) bu tabloda doğmasın.
 */

/** Telefon bir isteği bu kadar ileri yazar… */
export const KAMERA_ISTEK_MS = 45_000;
/** …ve ekran açık kaldıkça bu aralıkla tazeler (süre dolmadan en az iki kez). */
export const KAMERA_YENILEME_MS = 15_000;
/** Sahibinden bu kadar ses gelmezse (masaüstü kapandı/uyudu) başka masaüstü devralabilir. */
export const KAMERA_SAHIP_BAYAT_MS = 15_000;
/** Bu kadar eski kare artık "canlı" sayılmaz — telefon "görüntü donmuş" der. */
export const KAMERA_KARE_BAYAT_MS = 12_000;

export interface KameraSatiri {
  printerConfigId: string;
  wantedUntilMs: number;
  owner: string | null;
  ownerAtMs: number | null;
  frameUrl: string | null;
  frameAtMs: number | null;
  error: string | null;
}

// ── Telefon tarafı ────────────────────────────────────────────────────────────────────────────

/**
 * İsteği aç/tazele. Argümanlar: [printerConfigId, wantedUntilMs, yeniMi (1/0), simdi].
 *
 * `MAX`: iki telefon aynı yazıcıyı izliyorsa birinin tazelemesi diğerinin süresini kısaltmasın.
 * `yeniMi` = ekran YENİ açıldı → önceki oturumun hata metni ve (silinmiş olabilecek) kare
 * adresi temizlenir; tazelemede dokunulmaz.
 */
export function kameraIstegiSql(): string {
  return `INSERT INTO "PrinterCamera" ("printerConfigId", "wantedUntilMs", "updatedAtMs")
          VALUES (?1, ?2, ?4)
          ON CONFLICT("printerConfigId") DO UPDATE SET
            "wantedUntilMs" = MAX("PrinterCamera"."wantedUntilMs", excluded."wantedUntilMs"),
            "error" = CASE WHEN ?3 = 1 THEN NULL ELSE "PrinterCamera"."error" END,
            "frameUrl" = CASE WHEN ?3 = 1 AND "PrinterCamera"."owner" IS NULL THEN NULL ELSE "PrinterCamera"."frameUrl" END,
            "updatedAtMs" = excluded."updatedAtMs"`;
}

/** Ekran kapandı: isteği hemen bitir → masaüstü birkaç saniyede kamerayı bırakır.
 *  Argümanlar: [simdi, printerConfigId]. */
export function kameraBirakSql(): string {
  return `UPDATE "PrinterCamera" SET "wantedUntilMs" = ?1, "updatedAtMs" = ?1 WHERE "printerConfigId" = ?2`;
}

/** Telefonun okuduğu durum. Argüman: [printerConfigId]. */
export function kameraDurumuSql(): string {
  return `SELECT "printerConfigId", "wantedUntilMs", "owner", "ownerAtMs", "frameUrl", "frameAtMs", "error"
            FROM "PrinterCamera" WHERE "printerConfigId" = ?1`;
}

// ── Masaüstü tarafı ───────────────────────────────────────────────────────────────────────────

/**
 * Süren istekler. Argüman: [simdi].
 * `error` da okunur: telefon "Tekrar dene"ye basınca hatayı siler — masaüstü bunu görüp
 * bekleme süresini beklemeden hemen yeniden dener.
 */
export function kameraIstekleriSql(): string {
  return `SELECT "printerConfigId", "wantedUntilMs", "owner", "ownerAtMs", "error"
            FROM "PrinterCamera" WHERE "wantedUntilMs" > ?1`;
}

/**
 * ATOMİK SAHİPLENME — iki masaüstü (Mac + Windows) aynı anda açıkken tek gönderici.
 * Koşullu güncelleme: yalnız istek süruyorsa ve satır boşta / zaten bizde / sahibi sustuysa.
 * Etkilenen satır 1 değilse başka makine sunuyor demektir.
 * Argümanlar: [sahip, simdi, printerConfigId, bayatlikSiniri (simdi − KAMERA_SAHIP_BAYAT_MS)].
 */
export function kameraSahiplenSql(): string {
  return `UPDATE "PrinterCamera" SET "owner" = ?1, "ownerAtMs" = ?2, "error" = NULL, "updatedAtMs" = ?2
           WHERE "printerConfigId" = ?3 AND "wantedUntilMs" > ?2
             AND ("owner" IS NULL OR "owner" = ?1 OR "ownerAtMs" IS NULL OR "ownerAtMs" < ?4)`;
}

/** Yeni kare. YALNIZ sahip yazabilir (0 satır → sahiplik başkasına geçmiş, oturum biter).
 *  Argümanlar: [frameUrl, frameAtMs, simdi, printerConfigId, sahip]. */
export function kameraKareYazSql(): string {
  return `UPDATE "PrinterCamera" SET "frameUrl" = ?1, "frameAtMs" = ?2, "ownerAtMs" = ?3, "error" = NULL, "updatedAtMs" = ?3
           WHERE "printerConfigId" = ?4 AND "owner" = ?5`;
}

/**
 * Kamera açılamadı / koptu: nedeni yaz, sahipliği bırak. Başka makinenin sürdürdüğü oturumu
 * ezmesin diye yalnız sahipsiz ya da bizdeki satıra yazar.
 * Argümanlar: [hata, simdi, printerConfigId, sahip].
 */
export function kameraHataYazSql(): string {
  return `UPDATE "PrinterCamera" SET "error" = ?1, "owner" = NULL, "ownerAtMs" = NULL, "frameUrl" = NULL, "updatedAtMs" = ?2
           WHERE "printerConfigId" = ?3 AND ("owner" IS NULL OR "owner" = ?4)`;
}

/** Oturum olağan bitti (izleyen kalmadı): sahipliği ve artık silinen karenin adresini bırak.
 *  Argümanlar: [simdi, printerConfigId, sahip]. */
export function kameraSahiplikBirakSql(): string {
  return `UPDATE "PrinterCamera" SET "owner" = NULL, "ownerAtMs" = NULL, "frameUrl" = NULL, "updatedAtMs" = ?1
           WHERE "printerConfigId" = ?2 AND "owner" = ?3`;
}

/** Satırdaki kare hâlâ canlı mı (telefon "donmuş görüntü" uyarısı için). */
export function kareCanliMi(frameAtMs: number | null | undefined, simdi: number): boolean {
  return frameAtMs != null && simdi - frameAtMs < KAMERA_KARE_BAYAT_MS;
}
