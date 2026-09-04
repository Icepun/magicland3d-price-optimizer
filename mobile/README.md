# Magicland 3D Hub — iOS

Masaüstü Magicland 3D Hub'ın telefon sürümü (Expo SDK 56, React Native, expo-router). Aynı Turso
veritabanı, aynı `src/core` iş mantığı (vendor kopya, `npm run sync-core`).

## Tasarım dili (Eylül 2026)

Koyu cam + Magicland moru. Kaynak şablon: "Ledgerix — Smart Logistics Analytics"
(dribbble.com/shots/27304602); turuncu yerine marka moru `#7C5CFF`.

- Jetonlar: `src/theme/tokens.ts` (renk, cam yüzeyler, punto ölçeği, hareket, blur).
- Kit: `src/components/kit/*` — yeni/dokunulan her ekran yalnız buradan beslenir.
  - Zemin: `Backdrop` (gradyan + SVG ışık lekeleri, kökte tek katman; ekranlar şeffaf).
  - Yüzeyler: `Glass` (blur'lu, hero/başlık/sheet) · `Tint` (blur'suz, liste satırları).
  - Metin/rakam: `Txt`, `Money` (büyük tam + küçük kuruş), `Count`, `useCountUp`.
  - Grafik: `Bars` (ince çubuk dalgası), `Ring` (halka), `Progress`; Raporlar'da özel SVG aylık grafik.
  - Kontroller: `Segmented`, `Chip`/`Pill`, `Button`, `IconButton`/`CornerArrow`, `Input`/`SearchInput`, `Sheet`.
  - Kabuk: `Header` (marka + zil + menü), `SubHeader`, `TabBar` (Liquid Glass/blur, kayan kapsül), `Screen`.
  - Durumlar: `Shimmer*`, `EmptyState`, `ErrorState`.
- Yazı tipi: Plus Jakarta Sans (ağırlıklar tek tek alt paketten; `fontWeight` VERİLMEZ, ağırlık = aile).
- `src/theme/colors.ts` (ML) eski ekranlar için uyumluluk katmanı; değerleri tokens'tan türetilir.

## Çalıştırma

```bash
npx expo start          # Metro
```

Simülatörde native derleme, OTA yayını ve tuzaklar için `AGENTS.md`.

## Yayın

- Native bağımlılık değişmediyse: `eas update --channel production --environment production`
  (önce `npx expo export --platform all` yeşil olmalı; çıktıdaki "Runtime version" telefonla eşleşmeli).
- Native değiştiyse: GitHub → Actions → "Mobile TestFlight" (elle tetiklenir).
