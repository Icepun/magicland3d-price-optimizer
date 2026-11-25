import type { TextStyle } from "react-native";

/**
 * MAGICLAND 3D HUB — TASARIM DİLİ (Kasım 2026): MASAÜSTÜYLE AYNI.
 *
 * Kaynak: masaüstünün "Raporlar görünümü" (globals.css + components/reports/rapor-ortak.tsx).
 * Berke 25 Kas 2026'da telefonun 25 ekranlık önizlemesini onayladı ("hepsini onaylıyorum").
 * Lacivert-siyah zemin + hafif periwinkle ışık, düz koyu kartlar (#131720, ince açık kenarlık),
 * logodaki mor→mavi geçiş (#9B5CFF → #4F8CFF), iyi = zümrüt, kötü = gül, sakin uyarı = lavanta.
 * "Müdahale bekliyor" durumu (yazıcı duraklatıldı) SARI kalır — palete feda edilmez.
 * Turuncu yalnız Trendyol'un marka rengi.
 *
 * `theme/colors.ts` (ML) ESKİ dil — yeni/dokunulan hiçbir ekran ML'den beslenmez.
 */

/** Font aileleri — @expo-google-fonts/plus-jakarta-sans (statik dosyalar, çalışma zamanında yüklenir). */
export const font = {
  medium: "PlusJakartaSans_500Medium",
  semibold: "PlusJakartaSans_600SemiBold",
  bold: "PlusJakartaSans_700Bold",
  extrabold: "PlusJakartaSans_800ExtraBold",
} as const;

export const color = {
  /** Zemin: masaüstünün lacivert-siyahı (`--background`). Backdrop çizer. */
  bg0: "#080C14",
  bg1: "#0B101B",
  /** Backdrop ışığı — masaüstü gövdesindeki gibi: sağ üstte periwinkle, sağ altta mor. */
  glowAccent: "#7A7EFF",
  glowCool: "#9B5CFF",

  /**
   * YÜZEYLER. `card` = masaüstü kartı (`--card`): bölümler, liste satırları, kutular.
   * `tint*` kartın İÇİNDEKİ küçük yüzeyler (rozet zemini, iç kutu, iz) — yarı saydam beyaz.
   * `glass*` adları eski çağıranlar için duruyor; artık bulanık cam değil, düz kart rengi.
   */
  card: "#131720",
  glass: "#131720",
  glassStrong: "rgba(19, 23, 32, 0.97)",
  tint: "rgba(255, 255, 255, 0.04)",
  tintStrong: "rgba(255, 255, 255, 0.07)",
  line: "rgba(255, 255, 255, 0.07)",
  lineStrong: "rgba(255, 255, 255, 0.12)",
  /** Kartın üst kenarındaki ince ışık (masaüstündeki inset gölge). */
  edge: "rgba(255, 255, 255, 0.05)",

  text: "#F2F3F7",
  /** Atölye/gün ışığı kuralı: soluk metin bile 13 puntoda okunmalı — koyulaştırma. */
  textDim: "#AEB4C1",
  textFaint: "#7E8494",

  /** Ana renk periwinkle (`--primary`) + logodaki mor→mavi geçiş. */
  accent: "#7A7EFF",
  accentBright: "#A9AEFF",
  accentSoft: "rgba(122, 126, 255, 0.16)",
  gradStart: "#9B5CFF",
  gradEnd: "#4F8CFF",
  /** Açık lavanta — ikon kutularının ikonu, sakin vurgu. */
  lavender: "#C9D2F2",
  onAccent: "#FFFFFF",

  good: "#34D399",
  goodSoft: "rgba(52, 211, 153, 0.14)",
  bad: "#FB7185",
  badSoft: "rgba(251, 113, 133, 0.14)",
  /** MÜDAHALE BEKLİYOR (yazıcı duraklatıldı, gecikmiş veri) — sarı kalır. */
  warn: "#FBBF24",
  warnSoft: "rgba(251, 191, 36, 0.14)",
  /** Sakin uyarı (stoksuz, ince marj, maliyet eksik) — masaüstündeki lavanta. */
  caution: "#C9D2F2",
  cautionSoft: "rgba(169, 174, 255, 0.14)",
  /** Bilgi + "yazdırıyor" — Magicland mavisi. */
  info: "#4F8CFF",
  infoSoft: "rgba(79, 140, 255, 0.14)",

  /** Platform renkleri masaüstüyle AYNI (`PLATFORM_RENGI`). */
  shopify: "#34D399",
  trendyol: "#F27A1A",
  hepsiburada: "#4F8CFF",
  manual: "#C9D2F2",

  /** Çubuk grafiğin vurgusuz çubuğu ve ilerleme izi. */
  barDim: "rgba(201, 210, 242, 0.18)",
  track: "rgba(255, 255, 255, 0.06)",

  skeleton: "rgba(255, 255, 255, 0.05)",
  skeletonHigh: "rgba(255, 255, 255, 0.1)",
} as const;

/** Mor→mavi geçiş (logo) — birincil düğme, başlık ikon kutusu, vurgulu çubuklar. */
export const gradient = {
  brand: [color.gradStart, color.gradEnd] as const,
  /** İkon kutusunun soluk hâli (masaüstü: from-[#9B5CFF]/25 to-[#4F8CFF]/20). */
  soft: ["rgba(155, 92, 255, 0.25)", "rgba(79, 140, 255, 0.2)"] as const,
  /** Seçili sekme kapsülü. */
  pill: ["rgba(155, 92, 255, 0.35)", "rgba(79, 140, 255, 0.3)"] as const,
};

/** Masaüstündeki 16 px (rounded-2xl) kart köşesi; düğme/girdi 12–14 px. */
export const radius = { xs: 8, sm: 12, md: 16, lg: 16, xl: 22, pill: 999 } as const;

/** Boşluk ölçeği — 4'ün katları. Elle uydurulmuş 5/7/9/11 yasak. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * PUNTO ÖLÇEĞİ.
 * ⚠️ `fontWeight` VERİLMEZ: statik font dosyalarında her ağırlık ayrı bir aile adıdır; iOS,
 * aile + fontWeight kombinasyonunu bulamayınca SESSİZCE sistem fontuna düşer. Ağırlık = aile.
 * Gövde 15 punto (atölye, kol mesafesi, bazen eldiven); daha küçüğü yalnız etiket/rozet.
 */
export const type = {
  hero: { fontFamily: font.bold, fontSize: 36, lineHeight: 40, letterSpacing: -1 },
  title: { fontFamily: font.semibold, fontSize: 26, lineHeight: 30, letterSpacing: -0.5 },
  heading: { fontFamily: font.semibold, fontSize: 18, lineHeight: 22, letterSpacing: -0.2 },
  body: { fontFamily: font.medium, fontSize: 15, lineHeight: 20 },
  bodyStrong: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20 },
  small: { fontFamily: font.medium, fontSize: 13, lineHeight: 17 },
  smallStrong: { fontFamily: font.semibold, fontSize: 13, lineHeight: 17 },
  label: { fontFamily: font.semibold, fontSize: 12, lineHeight: 14, letterSpacing: 0.5 },
  /** Büyük rakam (özet kartları) — birimi `statUnit` ile küçük yazılır: ₺136.415 ,81 */
  stat: { fontFamily: font.bold, fontSize: 26, lineHeight: 30, letterSpacing: -0.6 },
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

export const T = { color, gradient, radius, space, font, type, tabular, motion, blur } as const;
