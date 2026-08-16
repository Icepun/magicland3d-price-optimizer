/**
 * Tarih biçimi mantığı ORTAK ÇEKİRDEĞE taşındı: `src/core/sqlite-date.ts`.
 *
 * Sebep: telefon da aynı kolonları ham SQL ile okuyor ve biçim bilgisi iki yerde yaşayınca
 * ayrıştı (mobil reklam payı sorgusu sayı/metin uyuşmazlığı yüzünden hep 0 döndürüyordu).
 * Çekirdek `npm run sync-core` ile telefona kopyalanır, `npm run check-core` farkı durdurur.
 *
 * Bu dosya yalnızca YÖNLENDİRİCİdir — 27 masaüstü çağrı yeri değişmeden çalışsın diye duruyor.
 * Yeni kod doğrudan `@/core/sqlite-date`'ten içe aktarmalı; buraya YENİ MANTIK EKLEME.
 */
export {
  type DbDateStorage,
  setDbDateStorage,
  dbDateStorage,
  toDbDate,
  nowDbDateSql,
  parseDbDate,
  dbEpochMs,
  canonicalDateSql,
  repairDateColumnSql,
} from "@/core/sqlite-date";
