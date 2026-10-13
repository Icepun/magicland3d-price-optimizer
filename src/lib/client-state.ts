"use client";

import { useSyncExternalStore } from "react";

const subscribeClient = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/** Hydration ile uyumlu biçimde yalnız istemciye geçildikten sonra true döner. */
export function useIsClient(): boolean {
  return useSyncExternalStore(subscribeClient, getClientSnapshot, getServerSnapshot);
}

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Sistem hareket tercihini React'in harici-store sözleşmesiyle izler. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getServerSnapshot,
  );
}

function subscribePageHidden(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function getPageHiddenSnapshot(): boolean {
  return document.hidden;
}

/**
 * Pencere şu an gizli mi (arka planda / küçültülmüş)?
 *
 * ⚠️ NEDEN GEREKLİ — ÖLÇÜLDÜ: gizli pencerede tarayıcı `requestAnimationFrame` karesi HİÇ
 * vermez. rAF ile sürülen her animasyon başlangıç değerinde donar: sayaçlar 0'da kalmıştı
 * (bkz. `AnimatedNumber`), grafik çubukları da sıfır yükseklikte çizilir. Böyle yerlerde
 * animasyon KAPATILIR ve sonuç doğrudan çizilir; pencere öne gelince zaten doğru durur.
 */
export function usePageHidden(): boolean {
  return useSyncExternalStore(
    subscribePageHidden,
    getPageHiddenSnapshot,
    getServerSnapshot,
  );
}

// ── Dakika saati ──────────────────────────────────────────────────────────────────────
// "Şimdi başlarsa 17:42'de biter" gibi saat hesapları render sırasında `Date.now()` çağıramaz
// (her çizimde farklı sonuç). Saat harici depodan okunur ve dakikada bir yenilenir.
let dakikaDamgasi = 0;
const buDakika = () => Math.floor(Date.now() / 60_000) * 60_000;

function subscribeDakika(onChange: () => void): () => void {
  const id = setInterval(onChange, 20_000);
  return () => clearInterval(id);
}

function getDakikaSnapshot(): number {
  // Aynı dakika içinde AYNI değer döner (depo sözleşmesi); dakika değişince yenisi.
  const simdi = buDakika();
  if (simdi !== dakikaDamgasi) dakikaDamgasi = simdi;
  return dakikaDamgasi;
}

/** İçinde bulunulan dakikanın başlangıcı (ms). Sunucuda 0 — saat gösteren yer onu gizlemeli. */
export function useDakika(): number {
  return useSyncExternalStore(subscribeDakika, getDakikaSnapshot, () => 0);
}
