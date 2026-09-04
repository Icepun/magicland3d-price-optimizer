import type { TextStyle } from "react-native";

/**
 * ESKİ PALET (ML) — UYUMLULUK KATMANI.
 *
 * Değerler artık `theme/tokens.ts`'ten (koyu cam + Magicland moru) türetiliyor: henüz yeniden
 * yazılmamış ekranlar da aynı zemin, aynı saydam kart ve aynı vurgu rengini alır; uygulama iki
 * dilli görünmez. Ekranlar kit'e taşındıkça bu dosyaya bağımlılık azalır ve sonunda silinir.
 * ⚠️ Yeni/dokunulan ekranda ML KULLANMA — `@/components/kit` + `@/theme/tokens`.
 */
import { color as T, font } from "@/theme/tokens";

export const ML = {
  bg: T.bg0,
  bgGradientTop: T.bg1,
  card: T.tintStrong,
  cardElevated: "rgba(255, 255, 255, 0.14)",
  border: T.lineStrong,
  borderSoft: T.line,

  text: T.text,
  textDim: T.textDim,
  textFaint: T.textFaint,

  accent: T.accent,
  accentSoft: T.accentSoft,

  green: T.good,
  greenSoft: T.goodSoft,
  red: T.bad,
  redSoft: T.badSoft,
  orange: T.warn,
  orangeSoft: T.warnSoft,

  shopify: T.shopify,
  trendyol: T.trendyol,
  hepsiburada: T.hepsiburada,
  manual: T.manual,

  skeleton: T.skeleton,
  skeletonHigh: T.skeletonHigh,
} as const;

export const radius = { sm: 10, md: 14, lg: 20, xl: 28 } as const;

/**
 * Hareket süreleri tek yerde: giriş animasyonu, sayı akışı ve bar dolumu aynı ritimde olsun.
 * (Ayrı ayrı seçilen 200/340/650 ms'ler ekranlar arası tutarsız bir his bırakıyordu.)
 */
export const motion = {
  /** Kart/satır girişi. */
  enter: 260,
  /** Liste öğeleri arası kademe gecikmesi — uzun listede son satır beklemesin diye kısa. */
  stagger: 32,
  /** Sayı akışı (count-up). */
  number: 620,
  /** Bar/çubuk dolumu. */
  bar: 620,
} as const;

/**
 * BOŞLUK ÖLÇEĞİ — 4'ün katları. Ekranlarda 5, 6, 7, 9, 11, 13 gibi elle uydurulmuş boşluklar
 * vardı; göz bunu "dağınık" olarak okuyor. Yeni/dokunulan her yer buradan beslenir.
 */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * PUNTO ÖLÇEĞİ — uygulamada 18 farklı punto elle yazılmıştı.
 *
 * ⚠️ Gövde puntosu bilinçli olarak bir kademe BÜYÜK (15): telefon atölyede, kol mesafesinde ve
 * bazen eldivenle kullanılıyor. `dim` metin de bir ton açıldı (bkz. ML.textDim) — koyu zeminde
 * 12 punto soluk gri, gün ışığında okunmuyordu.
 */
export const type = {
  /** Ekran başlığı (eski ekranlar; yeni ekranlar tokens.type kullanır). Ağırlık = aile, fontWeight YOK. */
  title: { fontFamily: font.extrabold, fontSize: 32, letterSpacing: -0.5 },
  heading: { fontFamily: font.bold, fontSize: 18 },
  body: { fontFamily: font.medium, fontSize: 15 },
  small: { fontFamily: font.medium, fontSize: 13 },
  label: { fontFamily: font.bold, fontSize: 12 },
  stat: { fontFamily: font.extrabold, fontSize: 28 },
} as const;

/**
 * RAKAMLAR SABİT GENİŞLİKTE. Sayı akarken (count-up) her hane farklı genişlikte olduğu için
 * kart genişliği titriyordu; `fontVariant: ["tabular-nums"]` bunu tamamen bitirir.
 * Para/adet/yüzde gösteren HER metin bunu almalı.
 */
export const tabular: TextStyle = { fontVariant: ["tabular-nums"] };

/**
 * YÜKSEKLİK KATMANLARI — gölge değerleri ekranlara dağılmıştı; üç katman yeter.
 * (iOS'ta gölge pahalı; liste HÜCRELERİNDE kullanılmaz, yalnız duran yüzeylerde.)
 */
export const elevation = {
  flat: {},
  card: {
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  sheet: {
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
} as const;
