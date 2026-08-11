# `prisma/` — şema, migration klasörünün durumu ve kararı

Bu dosya geliştiriciye hitap eder. Özet kural AGENTS.md'de; buradaki metin **neden** öyle
olduğunu ve `prisma/migrations/` klasörünün akıbetini anlatır.

## Roller

| Dosya | Rolü | Veritabanını değiştirir mi? |
| --- | --- | --- |
| `prisma/schema.prisma` | Prisma Client **tiplerinin** kaynağı (`prisma generate`) | Hayır |
| `src/lib/runtime-schema.ts` | Tabloların/kolonların **gerçek** kaynağı, açılışta çalışır | **Evet** |
| `prisma/migrations/` | Yalnızca tarihsel kayıt; kimse çalıştırmıyor | Hayır (çalıştırılırsa evet — çalıştırma) |

Uygulama her açılışta `ensureRuntimeSchema()` çağırır; bu fonksiyon `CREATE TABLE IF NOT EXISTS`
ve `ensureColumn()` ile şemayı kurar/yükseltir, sürümü `AppSetting.schemaVersion` ile damgalar.
`package.json`'daki build adımı yalnız `prisma generate` çalıştırır — `migrate` hiçbir script'te,
hiçbir CI adımında yoktur.

## Ölçülen sapma (bu belgenin yazıldığı an)

- `schema.prisma`: **26 model**.
- `prisma/migrations/`: bunların yalnız **13**'ünü yaratıyor
  (`ActualExpense`, `AppSetting`, `CargoRule`, `CommissionRule`, `CostTemplate`, `ExpenseRule`,
  `FilamentType`, `ManualOrder`, `OrderFinanceSnapshot`, `PlatformOrderFinancial`, `PriceHistory`,
  `Product`, `ProductCost`).
- Migration'larda **hiç geçmeyen 13 tablo**: `FilamentSpool`, `FilamentUsage`, `Listing`,
  `Notification`, `OrderItemSnapshot`, `PrintCommand`, `PrintFileProduct`, `PrinterConfig`,
  `PrinterSnapshot`, `ProductModelFile`, `PushToken`, `UnmatchedListing`, `VariantGroup`.
- Migration'ların yarattığı 13 tablo da **eksik kolonlu**. Örnek: `Product` modelinin
  `alias`, `imageManual`, `hidden`, `madeToOrder`, `productMainId`, `variantGroupId`,
  `variantLabel` kolonları hiçbir migration dosyasında geçmez.
- Migration'lar şemada **artık olmayan** `Recommendation` tablosunu yaratmaya devam ediyor.
- Son migration damgası `20260724…`; `runtime-schema.ts` ise **v37**. Aradaki fark yaklaşık
  bir düzine şema sürümü.

Yani migration klasörü şemanın yarısını bile tanımıyor.

## KARAR: klasör **DONDURULACAK** (silinmeyecek, yeniden üretilmeyecek)

`prisma/migrations/` olduğu gibi, salt-okunur tarihsel kayıt olarak repoda kalır. Kimse
dosyalarını düzenlemez, yenisini eklemez, `prisma migrate` çalıştırmaz.

### Neden silmiyoruz

Silmek tehlikeyi azaltmaz, **artırır**. Klasör boşken `prisma migrate dev` mevcut veritabanını
"tamamen sapmış" görür ve doğrudan **sıfırlama** teklifiyle gelir; bugün en azından bir kısmi
geçmiş var. Ayrıca `prisma.config.ts` bu yolu işaret ediyor (`migrations.path`), Turso'daki
canlı veriyle çalışan bir uygulamada dosya-yolu tabanlı bir kancayı sessizce boşa düşürmenin
kazancı yok. Klasörün asıl değeri de tarihsel: bugün canlı veritabanlarında duran en eski
tabloların kolon tanımları orada.

### Neden yeniden üretmiyoruz (baseline almıyoruz)

`prisma migrate diff` ile şemadan temiz bir baseline üretmek kâğıt üzerinde düzgün görünür,
pratikte iki sorun doğurur:

1. **İki kaynak olur.** Bugünkü hata sınıfı tam olarak budur: tablo yaratan iki yer olunca biri
   geride kalır. Baseline aldıktan sonra her şema değişikliğinde hem `runtime-schema.ts`'i hem
   migration dosyasını güncellemek gerekir; iki kişilik bir üründe bu maliyeti geri ödemez.
2. **SQL baseline veri migration'larını taşıyamaz.** `runtime-schema.ts` yalnız DDL çalıştırmıyor;
   `migrateTrendyolProductsToListings()`, `migrateParentVariantsToGroups()`,
   `cleanupPdfCommissionRules()` gibi veri dönüştürmeleri de yapıyor ve bunlar sürüm sırasına
   bağlı. Bir `CREATE TABLE` baseline'ı bu adımları hiçbir şekilde temsil etmez; yarı doğru bir
   migration geçmişi, hiç olmamasından daha yanıltıcıdır.

Bu kararı tersine çevirmek ancak şu olursa mantıklı: `runtime-schema.ts` emekliye ayrılıp tüm
şema yönetimi Prisma'ya devredilecekse. O zaman da yol "baseline + runtime-schema'yı silme"
olur, ikisini yan yana yaşatmak değil.

### Dondurulmuş klasörün kuralları

- Migration dosyalarını **düzenleme**, yenisini **ekleme**, klasörü **silme**.
- `prisma migrate dev` / `migrate deploy` / `migrate reset` / `db push` **çalıştırma**.
  `migrate dev` sapma gördüğü an veritabanını sıfırlamayı teklif eder; `db push` de şemaya
  "hizalamak" için mevcut tabloları düşürebilir. Canlı Turso verisi için ikisi de kabul edilemez.
- Bir migration dosyasını okuyup "bu kolon burada yok" diye sonuç çıkarma — geçerli tanım
  `schema.prisma` + `runtime-schema.ts` ikilisindedir.

## Şema değiştirirken akış

1. `prisma/schema.prisma` — modeli/alanı ekle (tipler buradan üretilir).
2. `src/lib/runtime-schema.ts` — `CREATE TABLE IF NOT EXISTS` bloğunu veya `ensureColumn()`
   satırını ekle. **Tabloyu gerçekten yaratan yer burası.**
3. `CURRENT_SCHEMA_VERSION`'ı artır, üstündeki yorum listesine bir satır yaz. Artırmazsan yerel
   işaretçi fast-path'i migration'ı atlar, kolon eklenmez ve Prisma "no such column" ile tüm
   sorguları patlatır.
4. `npx prisma generate` — yalnız `schema.prisma` değiştiyse gerekli (Client tiplerini yeniler).
   Build zaten çalıştırıyor; ama tsc/eslint/vitest'i yeni alan üzerinde koşturacaksan önce elle
   çalıştır.
5. `mobile/src/core` masaüstü `src/core` kopyasıdır — çekirdek tip değiştiyse kopyayı da güncelle.

`prisma/migrations/` bu akışın hiçbir adımında yer almaz.
