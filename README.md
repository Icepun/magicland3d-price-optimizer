# Magicland 3D Hub

Magicland 3D'nin fiyat, maliyet ve üretim yönetimi. Shopify (ana ürün kaynağı), Trendyol ve
Hepsiburada'daki satışları tek yerde toplar; her ürünün gerçek net kârını hesaplar ve dört 3D
yazıcıyı canlı izler. Berke ve Simay kullanır — herkese açık bir ürün değildir.

Windows ve Mac masaüstü uygulaması (Electron) + Expo mobil uygulaması. İkisi aynı Turso
veritabanını paylaşır.

## Çalıştırma

```bash
npm install
npm run dev
```

Masaüstü kabuğuyla birlikte:

```bash
npm run electron:dev
```

Testler, tip kontrolü ve lint:

```bash
npm test && npx tsc --noEmit && npx eslint .
```

Mobil (ayrı klasör):

```bash
cd mobile && npm install && npx expo start
```

## Nasıl kurgulanmış

```
src/core/     Saf hesap motoru — maliyet, komisyon, kargo, KDV, sipariş kârı.
              Yan etkisi yok, ağ/DB bilmez. mobile/src/core buranın VENDOR KOPYASI.
src/lib/      Sunucu altyapısı — veritabanı, önbellek, yedek, biçimlendirme, bildirim.
src/app/      Next.js sayfaları ve API rotaları.
src/services/ Pazaryeri istemcileri (Shopify / Trendyol / Hepsiburada).
electron/     Masaüstü kabuğu, otomatik güncelleme, tepsi.
mobile/       Expo uygulaması; Turso'yu DOĞRUDAN okur, kendi API'si yoktur.
```

### Bilmen gereken beş kural

**1. Kâr hesabı tek kaynaktan gelir.** Ürün kârı `simulatePrice`, sipariş kârı
`resolveOrderProfit`. Yeni bir kâr yüzeyi yazacaksan bunları çağır; formülü kopyalama. Masaüstü
ve mobil aynı fonksiyonları kullanır.

**2. `src/core` mobile'a kopyalanır, elle düzenlenmez.** Değişikliği masaüstü kopyasında yap,
sonra `npm --prefix mobile run sync-core`. `npm --prefix mobile run check-core` iki kopya
ayrışmışsa sesli hata verir.

**3. Uzak veritabanında her sorgu sıralıdır.** Turso'ya uzak-HTTP modunda her sorgu ~96 ms ve
tüm sorgular süreç genelinde tek sıra hâlinde bekler — `Promise.all` gerçek paralellik vermez,
`$transaction` uygulamanın tamamını kilitler. Ondan fazla satır yazacaksan
`src/lib/libsql-batch.ts` içindeki `batchWrite()` kullan ve yazmadan önce mevcut değerle
karşılaştır; değişmeyen satırı yazma.

**4. Önbellek üç katmanlı, düşürmesi tek kaynaktan yapılır.** İstemci (TanStack Query), sipariş
gövdesi ve sayfa gövdeleri ayrı ayrı önbelleklenir; sonuncusu diske de yazılır. Bir yazma sonrası
`src/lib/cache-busting.ts` içindeki uygun yardımcıyı çağır — `bustProfitInputCaches` (kural/oran
değişti), `bustProductCaches` (ürün eklendi/silindi/adı değişti), `bustProductViewCaches` (yalnız
görünüm), `bustFinanceCaches` (finans geçmişi). Yeni bir `swr()` anahtarı eklersen o dosyaya da
ekle, yoksa ekran sessizce bayat kalır.

**5. Biçimlendirme tek kaynaktan.** Para, yüzde, tarih ve bağıl zaman için `src/lib/format.ts`.
Yeni `Intl` örneği kurma — yüzdeler Türkçe virgülle, tutarlar `₺` önde yazılır.

### Maliyet alanı

Maliyet ve kâr rakamlarını değiştiren bir düzenleme yapmadan önce **Berke'ye sor**. İş
kurallarının bir kısmı kodda görünmez (hizmet bedelinin sipariş başına kesilmesi, custom
siparişlerin Shopify kargo baremiyle gönderilmesi gibi) ve iyi niyetli bir "düzeltme" gerçek
fiyatlandırmayı bozabilir.

Maliyetin bilinip bilinmediği `totalCost`'a bakarak anlaşılmaz — paketleme her ürüne otomatik
eklendiği için toplam hiçbir zaman sıfır olmaz. Tek doğru ölçüt
`ResolvedCost.productionCostKnown`.

## Sürüm çıkarma

```bash
npm run electron:publish
```

Windows ve Mac paketlerini üretip GitHub Releases'a taslak olarak yükler; uygulama oradan
otomatik güncellenir. Mobil TestFlight dağıtımı `.github/workflows/mobile-testflight.yml`
üzerinden yürür.

## Veri güvenliği

Bulut verisinin günlük yedeği otomatik alınır ve Ayarlar ekranında son yedeğin ne zaman
alındığı yazar; oradan elle de yedekleyebilirsin. Yedek dosyası bağlantı şifrelerini
**içermez**. Geri yükleme aynı ekrandaki "JSON İçe Aktar" ile yapılır.
