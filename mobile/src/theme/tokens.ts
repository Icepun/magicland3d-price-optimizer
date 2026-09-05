import type { TextStyle } from "react-native";

/**
 * MAGICLAND 3D HUB — YENİ TASARIM DİLİ (Eylül 2026): koyu cam + Magicland moru.
 *
 * Kaynak şablon: "Ledgerix — Smart Logistics Analytics" (dribbble.com/shots/27304602).
 * Şablondan alınanlar: koyu füme-mavi zemin, yarı saydam cam yüzeyler, ince açık kenarlık,
 * 24–28 px köşe, ince dikey çubuk grafikleri, büyük rakam + küçük birim + değişim yüzdesi,
 * köşede ok düğmeli kartlar, kapsül çipler. Şablonun turuncusu yerine MARKA MORU kullanılır.
 *
 * `theme/colors.ts` (ML) ESKİ dil — ekranlar yeniden yazıldıkça buraya taşınır; yeni/dokunulan
 * hiçbir ekran ML'den beslenmez.
 */

/** Font aileleri — @expo-google-fonts/plus-jakarta-sans (statik dosyalar, çalışma zamanında yüklenir). */
export const font = {
  medium: "PlusJakartaSans_500Medium",
  semibold: "PlusJakartaSans_600SemiBold",
  bold: "PlusJakartaSans_700Bold",
  extrabold: "PlusJakartaSans_800ExtraBold",
} as const;

export const color = {
  /** Zemin gradyanı: üstte füme-mavi (bg1), altta gece (bg0). Backdrop çizer. */
  bg0: "#0A0D13",
  bg1: "#161C27",
  /** Backdrop ışık lekeleri — cam yüzeylerin "cam" okunmasını sağlayan arka ışık. */
  glowAccent: "#7C5CFF",
  glowCool: "#2F6BFF",

  /**
   * YÜZEYLER. `glass*` blur'lu kartlar içindir (hero, başlık, sekme çubuğu, alt sayfa);
   * `tint*` blur'SUZ yarı saydam yüzeydir — LİSTE SATIRLARINDA yalnız bu kullanılır
   * (BlurView hücre başına pahalı; FlashList geri dönüşümüyle de takılır).
   */
  glass: "rgba(20, 26, 36, 0.62)",
  glassStrong: "rgba(24, 31, 44, 0.86)",
  tint: "rgba(255, 255, 255, 0.05)",
  tintStrong: "rgba(255, 255, 255, 0.09)",
  line: "rgba(255, 255, 255, 0.08)",
  lineStrong: "rgba(255, 255, 255, 0.16)",

  text: "#F5F7FB",
  /** Atölye/gün ışığı kuralı: soluk metin bile 13 puntoda okunmalı — koyulaştırma. */
  textDim: "#AEB7C7",
  textFaint: "#7B8598",

  accent: "#7C5CFF",
  accentBright: "#A08CFF",
  accentSoft: "rgba(124, 92, 255, 0.18)",
  onAccent: "#FFFFFF",

  good: "#4ADE80",
  goodSoft: "rgba(74, 222, 128, 0.16)",
  bad: "#F87171",
  badSoft: "rgba(248, 113, 113, 0.16)",
  warn: "#FBBF24",
  warnSoft: "rgba(251, 191, 36, 0.16)",
  info: "#60A5FA",
  infoSoft: "rgba(96, 165, 250, 0.16)",

  shopify: "#4FBF67",
  trendyol: "#F27A1A",
  hepsiburada: "#FF6000",
  manual: "#A78BFA",

  skeleton: "rgba(255, 255, 255, 0.06)",
  skeletonHigh: "rgba(255, 255, 255, 0.12)",
} as const;

export const radius = { xs: 8, sm: 12, md: 18, lg: 24, xl: 28, pill: 999 } as const;

/** Boşluk ölçeği — 4'ün katları. Elle uydurulmuş 5/7/9/11 yasak. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * PUNTO ÖLÇEĞİ.
 * ⚠️ `fontWeight` VERİLMEZ: statik font dosyalarında her ağırlık ayrı bir aile adıdır; iOS,
 * aile + fontWeight kombinasyonunu bulamayınca SESSİZCE sistem fontuna düşer. Ağırlık = aile.
 * Gövde 15 punto (atölye, kol mesafesi, bazen eldiven); daha küçüğü yalnız etiket/rozet.
 */
export const type = {
  hero: { fontFamily: font.extrabold, fontSize: 40, lineHeight: 44, letterSpacing: -1 },
  title: { fontFamily: font.bold, fontSize: 28, lineHeight: 32, letterSpacing: -0.6 },
  heading: { fontFamily: font.semibold, fontSize: 18, lineHeight: 22, letterSpacing: -0.2 },
  body: { fontFamily: font.medium, fontSize: 15, lineHeight: 20 },
  bodyStrong: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20 },
  small: { fontFamily: font.medium, fontSize: 13, lineHeight: 17 },
  smallStrong: { fontFamily: font.semibold, fontSize: 13, lineHeight: 17 },
  label: { fontFamily: font.semibold, fontSize: 12, lineHeight: 14, letterSpacing: 0.5 },
  /** Büyük rakam (özet kartları) — birimi `statUnit` ile küçük yazılır: ₺136.415 ,81 */
  stat: { fontFamily: font.extrabold, fontSize: 30, lineHeight: 34, letterSpacing: -0.8 },
  statUnit: { fontFamily: font.semibold, fontSize: 14, lineHeight: 18 },
} as const satisfies Record<string, TextStyle>;

/** Rakamlar sabit genişlikte — sayı akarken kart titremesin. Para/adet/yüzde HER metin alır. */
export const tabular: TextStyle = { fontVariant: ["tabular-nums"] };

/**
 * HAREKET — tek ritim. Yay ayarları basış, sheet ve sekme göstergesi için ortak.
 * Süreler ms. Reanimated `withSpring` ve `withTiming` bunları alır.
 */
export const motion = {
  enter: 280,
  stagger: 36,
  number: 700,
  bar: 700,
  /** Basış / gösterge — hızlı ve tok. */
  spring: { damping: 16, stiffness: 240, mass: 0.6 },
  /** Alt sayfa / büyük yüzey — yumuşak. */
  springSoft: { damping: 20, stiffness: 160, mass: 0.8 },
} as const;

/** BlurView yoğunluğu — iOS'ta 40 cam gibi; 60+ süt gibi oluyor. */
export const blur = { card: 36, bar: 48, sheet: 56 } as const;

export const T = { color, radius, space, font, type, tabular, motion, blur } as const;
