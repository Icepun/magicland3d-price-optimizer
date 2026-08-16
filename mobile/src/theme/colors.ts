import type { TextStyle } from "react-native";

/** Magicland 3D Hub — koyu tema paleti (masaüstüyle uyumlu, #1B1E2A taban). */
export const ML = {
  bg: "#16181F",
  bgGradientTop: "#1B1E2A",
  card: "#222637",
  cardElevated: "#2A2F44",
  border: "#313752",
  borderSoft: "#272C3E",

  text: "#FFFFFF",
  /** ⚠️ İkisi de bir ton AÇILDI (atölye okunurluğu): eski #9AA0B4/#6B7185 koyu zeminde ve
   *  gün ışığında, hele 12-13 puntoda okunmuyordu. Hiyerarşi korunuyor, kontrast artıyor. */
  textDim: "#A8AEC2",
  textFaint: "#7C8399",

  accent: "#7C5CFF",
  accentSoft: "rgba(124,92,255,0.16)",

  green: "#4ADE80",
  greenSoft: "rgba(74,222,128,0.14)",
  red: "#F87171",
  redSoft: "rgba(248,113,113,0.14)",
  orange: "#FB923C",
  orangeSoft: "rgba(251,146,60,0.14)",

  shopify: "#4FBF67",
  trendyol: "#F27A1A",
  hepsiburada: "#FF6000",
  manual: "#A78BFA",

  /** İskelet (yükleniyor) blokları — kart zemininden bir ton açık, nabız bunun üstünde atar. */
  skeleton: "#282D40",
  skeletonHigh: "#333A52",
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
  /**
   * Ekran başlığı.
   *
   * ⚠️ 32 — 26 DEĞİL. Sekmelerin kendi başlıkları hep 32/-0.5 idi; ortak `AppHeader`'a
   * geçerken buradaki 26'ya bağlanınca Panel, Siparişler, Ürünler ve Daha'nın başlığı bir
   * anda küçüldü ve uygulama "bozulmuş" göründü. Ölçek, var olan tasarımı takip eder.
   */
  title: { fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  /** Kart/bölüm başlığı */
  heading: { fontSize: 18, fontWeight: "700" },
  /** Gövde */
  body: { fontSize: 15, fontWeight: "500" },
  /** İkincil bilgi */
  small: { fontSize: 13, fontWeight: "500" },
  /** Rozet/etiket */
  label: { fontSize: 12, fontWeight: "700" },
  /** Büyük rakam (özet kartları) */
  stat: { fontSize: 28, fontWeight: "800" },
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
