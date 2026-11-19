/**
 * PENCERE GÖRÜNÜR MÜ? — arayüzün "kimse bakmıyor" bilgisi için tek kaynak.
 *
 * İki sinyal birleşir:
 *   1. Tarayıcının kendi `document.hidden` değeri.
 *   2. Masaüstü uygulamasının ana süreçten gönderdiği açık sinyal: pencere tepside, küçültülmüş
 *      ya da ekran kilitli. Uygulama arka plan kısıtlamasını kapattığı için (bildirimler ve
 *      baskı akışı kesilmesin diye) birinci sinyal tek başına güvenilir değil.
 *
 * NEDEN (19 Kas 2026 denetimi): pencere gizliyken de yazıcı paneli 2 sn'de bir, zil 20 sn'de
 * bir sunucuyu yokluyor, saniyelik sayaç bütün sayfayı yeniden çiziyordu. Masaüstü bildirimleri
 * ana süreçten çıktığı için arayüzün gizliyken çalışmasına gerek yok; pencere geri gelince
 * veriler hemen tazelenir.
 *
 * Tarayıcıda (köprü yok) yalnız birinci sinyal kullanılır — davranış eskisiyle aynı.
 */
type Dinleyici = () => void;

let gorunur = true;
let bagli = false;
const dinleyiciler = new Set<Dinleyici>();

function ayarla(yeni: boolean): void {
  if (yeni === gorunur) return;
  gorunur = yeni;
  for (const d of [...dinleyiciler]) d();
}

function bagla(): void {
  if (bagli || typeof window === "undefined") return;
  bagli = true;
  const kopru = window.trendyolPriceOptimizer?.pencere;
  if (!kopru) return;
  try {
    kopru.onGorunur(ayarla);
    void kopru.gorunurMu().then(ayarla).catch(() => {
      /* köprü yanıt vermezse "görünür" kalır — yoklama kesilmez */
    });
  } catch {
    /* eski preload: sinyal yok, varsayılan davranış */
  }
}

/** Ana süreç pencereyi görünür sayıyor mu? (Köprü yoksa hep `true`.) */
export function pencereGorunurMu(): boolean {
  bagla();
  return gorunur;
}

/** Kimse bakmıyor mu? rAF döngüleri, sayaçlar ve yoklamalar buna göre durur. */
export function pencereGizliMi(): boolean {
  if (typeof document === "undefined") return false;
  return document.hidden || !pencereGorunurMu();
}

/** Gizlilik değişince haber ver (iki sinyalden herhangi biri). Dönen fonksiyon aboneliği bırakır. */
export function gizlilikAbone(onChange: Dinleyici): () => void {
  if (typeof document === "undefined") return () => {};
  bagla();
  dinleyiciler.add(onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    dinleyiciler.delete(onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

/** Masaüstü uygulamasında mıyız (açık sinyal var mı)? */
export function pencereSinyaliVar(): boolean {
  return typeof window !== "undefined" && Boolean(window.trendyolPriceOptimizer?.pencere);
}
