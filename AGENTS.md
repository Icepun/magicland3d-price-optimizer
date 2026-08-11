<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Veritabanı şemasının TEK kaynağı: `src/lib/runtime-schema.ts`

`prisma/migrations/` **kullanım dışıdır ve şemadan çok geridedir.** Doğrulanan durum:

- `prisma/schema.prisma`: 26 model.
- `prisma/migrations/`: bu modellerin yalnız **13**'ünü yaratır; ayrıca artık şemada olmayan
  `Recommendation` tablosunu yaratmaya devam eder. Son migration `20260724…`, oysa
  `runtime-schema.ts` sürümü **v37**.
- Migration'larda **olmayan 13 tablo**: `FilamentSpool`, `FilamentUsage`, `Listing`,
  `Notification`, `OrderItemSnapshot`, `PrintCommand`, `PrintFileProduct`, `PrinterConfig`,
  `PrinterSnapshot`, `ProductModelFile`, `PushToken`, `UnmatchedListing`, `VariantGroup`.
- Migration'ların yarattığı 13 tablo bile eksik kolonlu (örn. `Product.madeToOrder`,
  `Product.alias` hiçbir migration'da geçmez).

Uygulamadaki her veritabanı, açılışta `ensureRuntimeSchema()` çağrılarak kurulur/yükseltilir —
kimse `prisma migrate` çalıştırmaz (`package.json` build adımı sadece `prisma generate`).

## Yeni tablo veya kolon eklerken

1. `prisma/schema.prisma`'ya ekle (Prisma Client tipleri oradan üretilir).
2. `src/lib/runtime-schema.ts`'e `CREATE TABLE IF NOT EXISTS` / `ensureColumn` satırını ekle —
   **tabloyu gerçekten yaratan yer burasıdır.**
3. `CURRENT_SCHEMA_VERSION`'ı artır ve üstündeki yorum listesine bir satır yaz. Artırmazsan
   hızlı-yol migration'ı atlar, kolon eklenmez ve Prisma "no such column" ile tüm sorguları
   patlatır.
4. `npx prisma generate`.

## `prisma migrate` NEDEN çalıştırılmamalı

- `migrate dev` / `migrate deploy`: migration klasörü şemanın yarısını tanımadığı için
  **eksik tablolu bir veritabanı** doğar; `runtime-schema` sonradan tamamlasa da
  `_prisma_migrations` durumu kalıcı olarak tutarsız kalır.
- `migrate dev` ayrıca drift gördüğü an **veritabanını sıfırlamayı teklif eder** — üretimdeki
  Turso verisi için kabul edilemez.
- `migrate reset` / `db push`: mevcut (runtime-schema ile kurulmuş) tabloları şemaya "hizalamak"
  için düşürebilir → veri kaybı.

Migration dosyalarına dokunma; şema değişikliği yalnız `schema.prisma` + `runtime-schema.ts`
ikilisiyle yapılır.
