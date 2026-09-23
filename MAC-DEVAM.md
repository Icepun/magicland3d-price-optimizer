# Mac'te devam — 23 Eylül 2026 devir notu

Windows'taki Claude oturumundan Mac'teki Claude'a. **Geçici dosya:** işler bitince sil ve commit'le.

Windows'taki Claude'un hafızası Mac'e taşınmaz. Gereken her şey bu notta. Sondaki "Kalıcı kurallar"
bölümünü kendi hafızana kaydet (varsa güncelle).

## 0. Başlarken

1. `git status` — Mac'te yerel iş varsa kaybetme (commit ya da stash).
2. `git pull --ff-only origin main` — ileri sarılamazsa merge et. Rebase, reset ya da force-push YOK.
3. Beklenen son commit'ler: `446401e chore: v0.19.227` ve bu notun commit'i.

## 1. Telefon — yapılacaklar

### 1a. OTA güncellemesi: bugünkü mobil değişiklikler telefona henüz GİTMEDİ

- Değişiklik `7b30274` (v0.19.226) içinde: 17 mobil dosya, **yalnız JS/TS**, native değişiklik yok.
  Telefonda görülecekler:
  - Stok ya da maliyet değişince liste hemen güncelleniyor; aşağı çekip yenileme gerçekten yeniliyor
    (eskiden 30 sn eski veri geliyordu).
  - Trendyol'da paket numarası henüz gelmemiş sipariş çift kayıt açmıyor (Raporlar'da çift sayım yok).
  - Silinmiş yazıcının eski hata uyarısı bildirimlerde kalmıyor.
  - Yazıcı ailesi: iki U1 birbirinin dosyalarını görüyor.
  - Birlikte yapılan kayıtlar ya hep ya hiç (`writeBatch`); tarihler `toDbDate` ile yazılıyor.
- Son native değişiklik `60ee96d` (4 Eyl); son TestFlight derlemesi de o commit'ten (#47, başarılı).
  Yani **OTA yeter, yeni derleme gerekmez** — yine de aşağıdaki çalışma sürümü kontrolünü yap.
- Windows'ta ön kontrol yapıldı (23 Eyl): `check-core` OK, `tsc` temiz, lint 0 hata,
  `npx expo export --platform all` başarılı.

```bash
cd mobile
npm ci
npm run check-core
npx tsc --noEmit
npx expo export --platform all --output-dir /tmp/mlhub-bundle-check --clear
eas build:list --platform ios --limit 1   # telefondaki derlemenin runtimeVersion'ı
eas update --channel production --environment production --message "v0.19.226 mobil düzeltmeleri"
```

`expo export` çıktısındaki "Runtime version" son derlemeninkiyle aynı olmalı; değilse OTA telefona
ULAŞMAZ (o zaman 1c). Yayından sonra telefonda uygulamayı kapatıp aç, güncelleme gelir.

### 1b. iOS bildirimleri: AÇIK SORUN

- Telefon kayıtlı ama Expo her gönderimi **InvalidCredentials** ile reddediyor: EAS'te iOS için APNs
  push anahtarı yok ya da geçersiz.
- Çözüm Apple girişi ister ve etkileşimlidir; komutu **Berke terminalde kendisi çalıştırır**:
  `cd mobile && eas credentials -p ios` → production → Push Notifications → yeni anahtar kur.
- Anahtar sunucu tarafında; yeni derleme gerekmez.
- Deneme: masaüstü uygulaması → Ayarlar → Telefon bildirimleri → "Test bildirimi gönder".
- Uygulamanın bu hatada gösterdiği "uygulamayı yeniden kur" yönlendirmesi yanlış; ayrıca düzeltilmeli.

### 1c. TestFlight: yalnız native değişirse

GitHub → Actions → "Mobile TestFlight" → Run workflow (elle). Expo ücretsiz planında ayda 15 iOS
derlemesi var; gereksiz tetikleme.

## 2. Mac'teki masaüstü uygulaması

Henüz güncellenmedi (v0.19.227 yayında, Mac dosyaları hazır). Uygulama içinden güncelle, sonra
yazıcılar sayfasında 3B kartlara bak: akıcı dönüyor mu, Mac ısınıyor mu? Performans yalnız Windows'ta
ölçüldü. Güncelleme sorun çıkarırsa kayıt:
`~/Library/Application Support/trendyol-price-optimizer/updater.log`.

## 3. Bugün yayınlananlar (bağlam)

- **v0.19.226** (`7b30274`): yazıcı ailesi, Bambu parça atlama ve depolama, kameralar, anlık sipariş
  bildirimi, stok tazeleme, mobil düzeltmeler (1a).
- **v0.19.227** (`e6275ed`, `d7f7c5d`): yazıcı kartında ve 3B izleyicide canlı 3B baskı, canlı nozul
  konumu; Modeller sayfası yazıcı ailesini sayıyor. Mobil değişiklik yok.

## 4. Kalıcı kurallar (Windows hafızasından)

- `mobile/` altına test dosyası koyma. Testler kökte (CI'da iOS derlemesini kırıyor).
- `mobile/src/core` elle düzenlenmez: masaüstü `src/core` değişir → `npm run sync-core`.
  Her OTA/derleme öncesi `npm run check-core`.
- `mobile/package.json`'a betik ekleme: parmak izini değiştirir, OTA telefona sessizce ulaşmaz.
- Mobilde birlikte yapılması gereken yazmalar `writeBatch()` ile (atomik); `batch()` yalnız okuma.
- Sürüm: `package.json`'da yalnız `"version"` satırı değişir, dosyayı yeniden yazma. `v*` etiketi
  push edilmezse Release çalışmaz; derlemenin gerçekten geçtiğini doğrula. İş paketi bitince
  sürümü sormadan çıkar.
- Şema: `schema.prisma` + `runtime-schema.ts` + `CURRENT_SCHEMA_VERSION` (şu an **47**). İki
  makinede aynı numara kullanılırsa çakışır: birleştirmede ilk buna bak. `prisma migrate` çalıştırma.
- Maliyet/kâr RAKAMINI değiştirecek her değişiklikten önce Berke'ye sor.
- Pazaryerlerine yazma yok, yalnız okuma.
- Sırları commit'leme: `git add .` kullanma, dosyaları tek tek ekle.
- Masaüstü uygulaması açıkken ikinci bir sunucuda yazıcılar sayfasını açma: Bambu MQTT'de son
  bağlanan kazanır, uygulamanın bağlantısı düşer.
- Arayüz metni son kullanıcıya dönük ve kısa. Her durum değişikliği animasyonlu, her bekleme
  ilerleme göstergeli.
