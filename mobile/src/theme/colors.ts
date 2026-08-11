/** Magicland 3D Hub — koyu tema paleti (masaüstüyle uyumlu, #1B1E2A taban). */
export const ML = {
  bg: "#16181F",
  bgGradientTop: "#1B1E2A",
  card: "#222637",
  cardElevated: "#2A2F44",
  border: "#313752",
  borderSoft: "#272C3E",

  text: "#FFFFFF",
  textDim: "#9AA0B4",
  textFaint: "#6B7185",

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
