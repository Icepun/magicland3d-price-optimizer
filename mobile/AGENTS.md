# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

# src/core is a VENDORED COPY — never edit by hand

`src/core/` is copied from the desktop app's `../src/core` via `npm run sync-core`
(which deletes `printers/` and `*.test.ts`). Any manual edit here WILL be silently
destroyed by the next sync. Change the desktop copy instead, then run `npm run sync-core`.
Before every OTA/build, run `npm run check-core` — it fails loudly if the two copies
have drifted (i.e. desktop core changed but mobile wasn't re-synced).

# `mobile/` altına TEST DOSYASI koyma

Testleri kökteki vitest çalıştırır; `vitest` mobil bağımlılıklarda YOKTUR. Yerelde çalışıyor
görünür (TypeScript `vitest`'i kök `node_modules`'tan çözer) ama CI `npm ci`'yi yalnız `mobile/`
içinde koşturur → orada kök `node_modules` yoktur → `npx tsc --noEmit` "Cannot find module
'vitest'" ile düşer ve **iOS TestFlight derlemesi kırılır**.

Mobil kodu test edeceksen testi KÖKTE aç ve göreli yolla içe aktar —
örnek: `src/lib/mobile-format.test.ts`.

# iOS derlemesi: sağlama profili PUSH yetkisini içermeli

`expo-notifications` eklentisi iOS hedefine `aps-environment` yetkisini (entitlement) ekler.
Apple tarafındaki sağlama profili (provisioning profile) bu yetkiyi içermiyorsa Xcode adımı
şu hatayla düşer:

    Provisioning profile "…" doesn't include the Push Notifications capability.
    Provisioning profile "…" doesn't include the aps-environment entitlement.

Profil EAS sunucusunda önbelleklenir ve CI `--non-interactive` koştuğu için **kendini
onaramaz** — Apple'a giriş gerekir. Düzeltme YEREL ve ETKİLEŞİMLİ yapılır:

    cd mobile
    eas credentials --platform ios     # production → tüm kimlikleri yeniden kur

EAS Apple'a bağlanıp App ID'de Push Notifications yetkisini açar ve profili yeniden üretir.
Sonrasında CI işi yeniden çalıştırılır.

⚠️ Tarihsel tuzak: 28 Tem 2026'da push açıldı ama profil 31 May 2026 tarihliydi. O sırada
iş akışı `--no-wait` ile kuyruğa atıp çıktığı için **EAS derlemesi düşse bile CI yeşildi**;
hata ancak `--no-wait` kaldırılınca (10 Ağu 2026) görünür oldu. CI'nin yeşil olması, iOS
derlemesinin gerçekten başarılı olduğu anlamına GELMİYORDU.

# Yayın öncesi TÜM platformları derle

`eas update` çıktıyı **platform=all** ile üretir; buna web de dahildir ve expo-router web
çıktısını Node içinde çalıştırır (statik render). `expo export --platform ios` yeşil olsa
bile web adımı düşerse **yayın tamamen düşer**.

⚠️ Yaşandı: `offline-cache.ts` modül düzeyinde `new File(Paths.cache, …)` kuruyordu.
iOS derlemesi sorunsuzdu; `eas update` ise `TypeError: this.validatePath is not a function`
ile düştü, çünkü `expo-file-system`'in web karşılığı yapıcıda patlıyor.

Kural: cihaz API'lerini modül yüklenirken DEĞİL, ilk kullanımda kur; web'de kısa devre yap
(`Platform.OS === "web"`). Yayından önce:

    cd mobile && npx expo export --platform all --output-dir /tmp/mlhub-bundle-check --clear

⚠️ Bunu `package.json` betiği YAPMA: `packageJson:scripts` çalışma parmak izine giriyor.
Yeni bir betik eklemek parmak izini değiştirir → yayın YENİ bir çalışma sürümüne gider ve
telefondaki uygulama güncellemeyi HİÇ görmez (28 Tem 2026 tuzağının aynısı, bu kez sessiz).
Ölçüldü: betik eklendiğinde iOS parmak izi 05bc725f… → 66cbc9ec… oldu.
